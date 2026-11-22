import asyncio
import json
from io import BytesIO
from pathlib import Path
from threading import Event
from time import monotonic, perf_counter, sleep

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.camera_link import CLOCK, FRAME, CameraFault, CameraLink, Reply, open_http_exchange
from backend.app.config import Config
from backend.app.device_startup import load_device_startup
from backend.app.main import create_app
from backend.app.simulation import load_simulation
from backend.tests.device_documents import write_camera_documents
from backend.tests.test_realtime import API, acquire_body, auth, heartbeat, status, validate, wait_for
from backend.tests.test_records import BASE, ORIGIN

BUILD = "a" * 32
BOOT = "b" * 32
STREAM = "c" * 32
TOKEN = "1" * 64


def jpeg_sample() -> bytes:
    with Image.new("RGB", (320, 240), "darkblue") as image, BytesIO() as out:
        image.save(out, format="JPEG")
        return out.getvalue()


def clock_headers(headers, boot=BOOT, stream=STREAM, rx=1_000_100, tx=1_000_200):
    return {"x-laf-clock": f"1 {headers['X-LAF-Request']} {headers['X-LAF-Epoch']} {BUILD} {boot} {stream} {rx} {tx}",
            "content-length": "0"}


def frame_headers(size, sequence=1, ts=1_000_500, boot=BOOT, stream=STREAM, width=320, height=240):
    return {"x-laf-frame": f"1 {BUILD} {boot} {stream} {sequence} {ts} {width} {height}",
            "content-length": str(size), "content-type": "image/jpeg"}


class Peer:
    def __init__(self):
        self.now = 10.0
        self.jpeg = jpeg_sample()
        self.frame = frame_headers(len(self.jpeg))
        self.clock = clock_headers
        self.duration = 0.001
        self.bodies = 0

    async def exchange(self, path, headers, read_body, timeout):
        self.now += self.duration
        size = read_body(200, self.clock(headers) if path == CLOCK else self.frame, 256)
        self.bodies += bool(size)
        return Reply(self.jpeg if size else b"", self.now)

    def link(self):
        simulation = load_simulation("fixture-v1", None)
        assert simulation is not None
        return CameraLink(simulation.profile, BUILD, self.exchange, lambda: self.now)


def test_real_adapter_keeps_original_identity_for_a_static_scene() -> None:
    async def exercise():
        peer = Peer()
        link = peer.link()
        assert await link.synchronize() is False
        first = await link.capture()
        assert (first.clock_epoch, first.stream_epoch, first.sequence, first.source_us) == (BOOT, STREAM, 1, 1_000_500)
        assert first.age_ms == 2

        for seq, timestamp in ((1, 1_000_500), (2, 1_000_400), (1, 1_002_000)):
            peer.frame = frame_headers(len(peer.jpeg), seq, timestamp)
            with pytest.raises(CameraFault, match="advance"):
                await link.capture()
        peer.frame = frame_headers(len(peer.jpeg), 2, 1_005_000)
        second = await link.capture()
        assert (second.sequence, second.source_us, second.jpeg) == (2, 1_005_000, first.jpeg)
        assert peer.bodies == 2

    asyncio.run(exercise())


@pytest.mark.parametrize("fault, message", [
    ("request", "does not match"), ("epoch", "does not match"), ("reverse", "round trip"),
    ("impossible", "round trip"), ("rtt", "round trip"), ("uncertainty", "uncertainty"),
])
def test_camera_rejects_invalid_clock_exchange(fault: str, message: str) -> None:
    async def exercise():
        peer = Peer()
        link = peer.link()
        if fault in ("request", "epoch"):
            field = "X-LAF-Request" if fault == "request" else "X-LAF-Epoch"
            peer.clock = lambda headers: clock_headers({**headers, field: "f" * 32})
        elif fault in ("reverse", "impossible"):
            peer.clock = lambda headers: clock_headers(headers, tx=1_000_050 if fault == "reverse" else 1_900_000)
        else:
            peer.duration = 0.010 if fault == "rtt" else 0.004
        with pytest.raises(CameraFault, match=message):
            await link.synchronize()
        with pytest.raises(CameraFault, match="not synchronized"):
            await link.capture()

    asyncio.run(exercise())


@pytest.mark.parametrize("fault, message, bodies", [
    ("oversize", "integer", 0), ("pixels", "bounds", 0), ("dimensions", "Invalid camera JPEG", 1),
    ("malformed", "Invalid camera JPEG", 1), ("future", "cannot be bounded", 1),
    ("old", "too old", 1), ("expired_sync", "synchronization expired", 1),
])
def test_camera_rejects_ineligible_jpeg(fault: str, message: str, bodies: int) -> None:
    async def exercise():
        peer = Peer()
        link = peer.link()
        await link.synchronize()
        if fault == "oversize":
            peer.frame = frame_headers(1_000_000)
        elif fault in ("pixels", "dimensions"):
            peer.frame = frame_headers(len(peer.jpeg), width=1000 if fault == "pixels" else 319)
        elif fault == "malformed":
            peer.jpeg = b"not a JPEG"
        elif fault == "future":
            peer.frame = frame_headers(len(peer.jpeg), ts=1_100_000)
        elif fault == "old":
            peer.now += 0.8
        else:
            peer.now += 1.0
        with pytest.raises(CameraFault, match=message):
            await link.capture()
        assert peer.bodies == bodies

    asyncio.run(exercise())


def test_epoch_change_requires_clock_exchange_and_retires_old_frames() -> None:
    async def exercise():
        peer = Peer()
        link = peer.link()
        await link.synchronize()
        await link.capture()
        new_boot, new_stream = "d" * 32, "e" * 32
        peer.frame = frame_headers(len(peer.jpeg), boot=new_boot, stream=new_stream)
        with pytest.raises(CameraFault, match="epoch changed"):
            await link.capture()
        assert link.sync_due()
        peer.clock = lambda headers: clock_headers(headers, new_boot, new_stream)
        assert await link.synchronize() is True
        assert (await link.capture()).stream_epoch == new_stream
        peer.frame = frame_headers(len(peer.jpeg), sequence=2)
        with pytest.raises(CameraFault, match="retired epoch"):
            await link.capture()
        peer.clock = clock_headers
        with pytest.raises(CameraFault, match="retired"):
            await link.synchronize()

    asyncio.run(exercise())


def test_http_transport_checks_header_and_length_before_reading_jpeg() -> None:
    async def exercise():
        received = []

        async def serve(reader, writer):
            received.append(await reader.readuntil(b"\r\n\r\n"))
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\nContent-Length: 12\r\n\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        async with server:
            exchange = open_http_exchange("127.0.0.1", server.sockets[0].getsockname()[1], TOKEN, 512, monotonic)
            with pytest.raises(CameraFault, match="Invalid camera response header"):
                await exchange(FRAME, {}, lambda *args: pytest.fail("Unchecked length"), 1.0)
        assert received[0].startswith(b"GET /laf/camera/v1/frame HTTP/1.1\r\n")
        assert f"\r\nAuthorization: Bearer {TOKEN}\r\n".encode() in received[0]

    asyncio.run(exercise())


def test_http_transport_reads_fragmented_body_at_the_real_socket_boundary() -> None:
    async def exercise():
        jpeg = jpeg_sample()

        async def serve(reader, writer):
            await reader.readuntil(b"\r\n\r\n")
            writer.write(f"HTTP/1.1 200 OK\r\nContent-Length: {len(jpeg)}\r\n\r\n".encode("ascii") + jpeg[:9])
            await writer.drain()
            await asyncio.sleep(0.02)
            writer.write(jpeg[9:])
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        async with server:
            exchange = open_http_exchange("127.0.0.1", server.sockets[0].getsockname()[1], TOKEN, 512, perf_counter)
            started = perf_counter()
            reply = await exchange(FRAME, {}, lambda status, headers, _: int(headers["content-length"]), 1.0)
            assert reply.body == jpeg and reply.received - started >= 0.02

    asyncio.run(exercise())


def test_selected_camera_feeds_protected_preview_but_cannot_renew_a_stalled_display(tmp_path: Path) -> None:
    write_camera_documents(tmp_path, BUILD, TOKEN)
    assert load_device_startup(tmp_path, {}).camera is not None
    jpeg = jpeg_sample()
    sequence = 0
    disconnected = Event()

    async def peer(path, headers, read_body, timeout):
        nonlocal sequence
        if disconnected.is_set():
            raise CameraFault("Dropped link")
        if path == CLOCK:
            now = int(perf_counter() * 1_000_000)
            response = clock_headers(headers, rx=now, tx=now)
        else:
            await asyncio.sleep(0.02)
            sequence += 1
            response = frame_headers(len(jpeg), sequence, int(perf_counter() * 1_000_000))
        size = read_body(200, response, 256)
        return Reply(jpeg if size else b"", perf_counter())

    app = create_app(Config(tmp_path, backend_mode="device"), camera_exchange=peer)
    with TestClient(app, base_url=BASE) as client:
        boot = client.get(API + "/bootstrap", headers=ORIGIN).json()
        headers = auth(boot)
        assert client.get(API + "/health").status_code == 403
        ready = wait_for(client, "/health", headers, lambda s: status(s, "RobotVideo") == "Ready")
        assert status(ready, "DisplayedRobotVideo") == status(ready, "Command") == "Unavailable"

        def ticket(channel):
            response = client.post(API + "/websocket-tickets", headers=headers,
                                   json={"client_id": boot["client_id"], "channel": channel})
            assert response.status_code == 200
            return ["laf.v1", "laf.ticket." + response.json()["ticket"]]

        websocket = BASE.replace("http://", "ws://") + API
        with (client.websocket_connect(websocket + "/events", headers=ORIGIN.copy(),
                                       subprotocols=ticket("events")) as events,
              client.websocket_connect(websocket + "/video/robot", headers=ORIGIN.copy(),
                                       subprotocols=ticket("robot-video")) as video):
            events.receive_json()
            lease = client.post(API + "/control-lease", headers=headers, json=acquire_body(boot)).json()
            assert "client_lease_id" in lease
            raw = video.receive_bytes()
            length = int.from_bytes(raw[:4], "big")
            metadata = json.loads(raw[4:4 + length])
            validate("FrameMetadata", metadata)
            assert raw[4 + length:] == jpeg
            assert metadata["stream_epoch"] == STREAM and metadata["source_clock_epoch"] == BOOT
            events.send_json(heartbeat(boot, lease, 1, metadata))
            wait_for(client, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
            for seq in range(2, 7):
                sleep(0.025)
                events.send_json(heartbeat(boot, lease, seq, metadata))
            lost = wait_for(client, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
            assert status(lost, "RobotVideo") == "Ready" and status(lost, "DisplayedRobotVideo") == "Unavailable"
            assert lost["runtime"]["motion_permission"] == "Disarmed"
            disconnected.set()
            wait_for(client, "/snapshot", headers, lambda s: status(s, "RobotVideo") == "Unavailable")
            disconnected.clear()
            restored = wait_for(client, "/snapshot", headers, lambda s: status(s, "RobotVideo") == "Ready")
            assert restored["lease"]["state"] == "Unowned"
