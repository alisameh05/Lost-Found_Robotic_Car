"""Exercise the same Uno parser/watchdog source over the backend command wire."""

import asyncio
import json
import os
import select
import shutil
import socket
import subprocess
from collections import deque
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from functools import partial
from hashlib import sha256
from io import BytesIO
from multiprocessing import get_context
from pathlib import Path
from threading import Event, Lock, Thread
from time import monotonic, perf_counter, sleep
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import main as app_entry
from backend.app import realtime
from backend.app.camera_link import CLOCK, Reply
from backend.app.config import Config
from backend.app.controller import Controller
from backend.app.main import create_app
from backend.app.motion import DIRECTIONS
from backend.app.serial_link import SerialCommandLink
from backend.app.simulation import load_simulation
from backend.app.storage import utc_ms
from backend.app.uno_wire import (
    ARM,
    DISCARD_PARTIAL,
    DRIVE,
    HELLO,
    MAX_FRAME,
    REPLY,
    STATUS,
    STOP,
    Packet,
    decode,
    encode,
)
from backend.tests.device_documents import device_documents, write_camera_documents, write_device_documents
from backend.tests.test_camera_link import BUILD as CAMERA_BUILD
from backend.tests.test_camera_link import TOKEN as CAMERA_TOKEN
from backend.tests.test_camera_link import clock_headers, frame_headers, jpeg_sample
from backend.tests.test_candidate_review import review
from backend.tests.test_controller import SERIAL, device, fresh_reports
from backend.tests.test_device_startup import component
from backend.tests.test_local_matching import await_file
from backend.tests.test_realtime import (
    API,
    Clock,
    Loopback,
    Observations,
    auth,
    driving_search,
    recover_workspace,
    search_action,
    service,
    wait_for,
)
from backend.tests.test_records import BASE, ORIGIN
from backend.tests.vision_stub import controlled_worker, publish

BUILD = b"\x90" + bytes(31)


@pytest.fixture(scope="session")
def uno_peer_exe(tmp_path_factory: pytest.TempPathFactory) -> Path:
    compiler = os.environ.get("LAF_UNO_HOST_CXX") or shutil.which("c++") or shutil.which("g++")
    if not compiler:
        pytest.skip("C++ compiler required for the Uno parser/watchdog fixture")
    root = Path(__file__).resolve().parents[2]
    target = tmp_path_factory.mktemp("uno-peer") / "uno_peer.exe"
    subprocess.run(
        [compiler, "-std=c++11", "-O2", "-Wall", "-Wextra", "-Werror", "-static", "-Ifirmware/uno",
         "firmware/tests/command_peer.cpp", "firmware/uno/command.cpp", "-o", str(target)],
        cwd=root, check=True, timeout=30,
    )
    return target


class NativePeer:
    def __init__(self, process, clock=monotonic):
        self.process = process
        self.clock = clock
        self.zero = clock()
        self.lock = Lock()
        self.rx = bytearray()
        self.trace: deque[tuple[float, Packet]] = deque(maxlen=512)
        self.outputs: deque[tuple[float, int]] = deque([(self.zero, 0)], maxlen=512)
        self.fault = None
        self.connected = True

    def step(self, frame=b"", *, now=None):
        arrival = self.clock()
        timestamp = round((arrival - self.zero) * 1000) if now is None else now
        stimulus = frame.hex() if isinstance(frame, bytes) else frame
        stdin, stdout = self.process.stdin, self.process.stdout
        stdin.write(f"{timestamp} {stimulus}\n")
        stdin.flush()
        out, hex_reply = stdout.readline().rstrip("\r\n").split(" ", 1)
        direction = int(out)
        if self.outputs[-1][1] != direction:
            self.outputs.append((arrival, direction))
        return direction, bytes.fromhex(hex_reply)

    @property
    def output(self):
        with self.lock:
            return self.step()[0]

    def write(self, data):
        with self.lock:
            if not self.connected:
                raise OSError("fixture link unplugged")
            packet = decode(data.removeprefix(DISCARD_PARTIAL))
            self.trace.append((self.clock(), packet))
            _, reply = self.step(data)
            if packet.op == DRIVE and self.fault:
                if self.fault == "invalid":
                    reply = encode(replace(decode(reply), challenge=0))
                elif self.fault == "replayed":
                    reply = encode(replace(decode(reply), sequence=packet.sequence - 1))
                elif self.fault == "reset":
                    self.step("reset")
                    reply = encode(replace(decode(reply), boot=packet.boot + 1))
                elif self.fault == "late":
                    # The read side will release this correlated reply beyond the profile deadline.
                    self.delayed = (self.clock() + 0.12, reply)
                    reply = b""
                else:
                    reply = b""
                self.fault = None
            elif (packet.op, self.fault) in ((STATUS, "idle_missing"), (STOP, "stop_missing")):
                reply = b""
                self.fault = None
            self.rx.extend(reply)
            return len(data)

    delayed = None

    def read(self, size):
        with self.lock:
            if not self.connected:
                raise OSError("fixture link unplugged")
            if self.delayed and self.clock() >= self.delayed[0]:
                self.rx.extend(self.delayed[1])
                self.delayed = None
            chunk = bytes(self.rx[:size])
            del self.rx[:size]
            return chunk

    @contextmanager
    def open(self):
        with self.lock:
            self.rx.clear()
            self.delayed = None
        yield self


@contextmanager
def native_peer(exe: Path, packet=25, challenge=180, expiry=220):
    process = subprocess.Popen(
        [str(exe), str(packet), str(challenge), str(expiry)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        yield NativePeer(process)
    finally:
        process.stdin.close()
        process.wait(3)
        process.stdout.close()


def exchange(peer, packet, timestamp):
    state, wire = peer.step(encode(packet), now=timestamp)
    return state, decode(wire)


def armed(peer, start=0):
    state, hello = exchange(peer, Packet(HELLO, sequence=314), start)
    assert state == 0 and hello == Packet(HELLO | REPLY, boot=1, sequence=314, next_challenge=1, build=BUILD)
    state, arm = exchange(peer, Packet(ARM, 1, 1, 1, 1), start + 1)
    assert state == 0 and arm == Packet(ARM | REPLY, 1, 1, 1, 1, 2, flags=1)
    command = Packet(DRIVE, 1, 1, 2, 2, direction=1)
    state, drive = exchange(peer, command, start + 2)
    assert state == 1 and drive == Packet(DRIVE | REPLY, 1, 1, 2, 2, 3, 1, 1)
    return command


@pytest.mark.parametrize("bad", ["partial", "corrupt", "oversized", "framing", "boot", "generation", "sequence",
                                 "challenge", "range", "expired", "replay", "reset"])
def test_uno_rejects_invalid_or_expired_wire_and_requires_new_arm(uno_peer_exe: Path, bad: str) -> None:
    with native_peer(uno_peer_exe) as peer:
        replay = armed(peer)
        valid = Packet(DRIVE, 1, 1, 3, 3, direction=2)
        packet = encode(valid)
        if bad == "partial":
            assert peer.step(packet[:8], now=10) == (1, b"")
            bad_wire, timestamp = packet[8:], 35
        elif bad == "expired":
            bad_wire, timestamp = packet, 182
        elif bad == "reset":
            assert peer.step("reset", now=3) == (0, b"")
            bad_wire, timestamp = packet, 4
        else:
            bad_wire, timestamp = {
                "corrupt": packet[:-3] + bytes([packet[-3] ^ 1 or 2]) + packet[-2:],
                "oversized": bytes([3]) * 80 + b"\0", "framing": b"\xff\x09\0",
                "boot": encode(replace(valid, boot=2)), "generation": encode(replace(valid, generation=2)),
                "sequence": encode(replace(valid, sequence=2)), "challenge": encode(replace(valid, challenge=2)),
                "range": encode(replace(valid, direction=5)), "replay": encode(replay),
            }[bad], 20
        assert peer.step(bad_wire, now=timestamp) == (0, b"")
        assert peer.step(packet, now=timestamp + 1) == (0, b"")
        _, hello = exchange(peer, Packet(HELLO, sequence=12), timestamp + 2)
        if bad != "reset":
            old_arm = Packet(ARM, hello.boot, hello.generation, hello.challenge + 1, hello.next_challenge)
            assert peer.step(encode(old_arm), now=timestamp + 3) == (0, b"")


def test_uno_expiry_during_incomplete_and_continuous_input(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        armed(peer)
        assert peer.step(b"\x02", now=220) == (1, b"")
        assert peer.step(b"\x01", now=221) == (1, b"")
        assert peer.step(b"\x01", now=222) == (0, b"")
        assert peer.step(b"\x01" * 4096, now=223) == (0, b"")
        assert peer.step(encode(Packet(DRIVE, 1, 1, 3, 3, direction=1)), now=224) == (0, b"")


def test_uno_expiry_survives_monotonic_clock_wrap(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        armed(peer, start=2**32 - 4)
        assert peer.step(now=217) == (1, b"")
        assert peer.step(now=218) == (0, b"")


def test_stop_preempts_partial_wire_and_invalidates_an_armed_generation(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        _, hello = exchange(peer, Packet(HELLO, sequence=9), 0)
        _, arm = exchange(peer, Packet(ARM, hello.boot, 1, 1, hello.next_challenge), 1)
        queued = encode(Packet(DRIVE, 1, 1, 2, arm.next_challenge, direction=2))
        assert peer.step(queued[:-1], now=2) == (0, b"")
        assert peer.step(DISCARD_PARTIAL, now=3) == (0, b"")
        stop = encode(Packet(STOP, 1, 1, 3, arm.next_challenge))
        output, reply = peer.step(stop, now=4)
        assert output == 0 and decode(reply) == Packet(STOP | REPLY, 1, 1, 3, 2, 3)
        assert peer.step(queued, now=5) == (0, b"")


def wait_until(predicate, timeout=3):
    end = monotonic() + timeout
    while monotonic() < end:
        if predicate():
            return
        sleep(0.005)
    assert predicate()


@pytest.mark.parametrize("mode", ["Controller", "Gestures"])
def test_protected_workspace_drives_and_stops_over_the_uno_wire(
    tmp_path: Path, uno_peer_exe: Path, mode: str,
) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            with service(tmp_path, live_command=link) as laf:
                if mode == "Controller":
                    laf.observations.fingers = 4
                else:
                    laf.observations.dpad = ("right",)
                    laf.observations.circle = True
                with driving_search(laf, mode) as (headers, _):
                    for direction, name in enumerate(DIRECTIONS, 1):
                        wait_for(laf.http, "/snapshot", headers,
                                 lambda s: s["runtime"]["motion_permission"] == "Arming")
                        if mode == "Controller":
                            laf.observations.dpad = (name,)
                        else:
                            laf.observations.fingers = direction
                        wait_until(lambda: peer.output == direction)
                        if mode == "Controller":
                            laf.observations.dpad = ()
                        else:
                            laf.observations.fingers = 0
                        wait_until(lambda: peer.output == 0)
                        active = wait_for(laf.http, "/snapshot", headers)["active_session"]
                        assert active["state"] == "Searching" and active["pause_causes"] == []
                    wait_for(laf.http, "/snapshot", headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    if mode == "Controller":
                        laf.observations.dpad = ("forward",)
                    else:
                        laf.observations.fingers = 1
                    wait_until(lambda: peer.output == 1)
                    if mode == "Controller":
                        laf.observations.dpad = ("forward", "right")
                    else:
                        laf.observations.fingers, laf.observations.stable = 4, False
                    wait_until(lambda: peer.output == 0)
                    if mode == "Controller":
                        laf.observations.dpad = ("right",)
                    else:
                        laf.observations.stable = True
                    sleep(0.23)
                    assert peer.output == 0
                    if mode == "Controller":
                        laf.observations.dpad = ()
                    else:
                        laf.observations.fingers = 0
                    wait_for(laf.http, "/snapshot", headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    if mode == "Controller":
                        laf.observations.dpad = ("forward",)
                    else:
                        laf.observations.fingers = 1
                    wait_until(lambda: peer.output == 1)
                    stopped = laf.http.post(API + "/emergency-stop", headers=headers,
                                            json={"request_id": str(uuid4())})
                    assert stopped.is_success and stopped.json()["permission_revoked"]
                    wait_until(lambda: peer.output == 0)
                    wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        finally:
            link.close()


@pytest.mark.parametrize("fault", ["missing", "late", "invalid", "replayed", "reset", "link"])
def test_serial_failure_drops_authority_and_reconnects_disarmed(uno_peer_exe: Path, fault: str) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            wait_until(link.probe)
            wait_until(lambda: link.pulse(1, "forward", monotonic() + 0.24) is None and link.output == "forward")
            if fault == "link":
                peer.connected = False
            else:
                peer.fault = fault
            until = monotonic() + 2
            while link.probe() and monotonic() < until:
                link.pulse(1, "forward", monotonic() + 0.24)
                sleep(0.005)
            assert not link.probe() and link.output is None
            wait_until(lambda: peer.output == 0)
            peer.connected = True
            # Successful diagnostic traffic cannot restore the previous generation.
            wait_until(lambda: sum(packet.op == HELLO for _, packet in peer.trace) >= 2)
            assert not link.probe()
            link.revoke(1, "InputReleased")
            assert not link.probe(), "healthy release cannot clear a serial fault"
            link.revoke(1, "CommandUnavailable")
            wait_until(link.probe)
            assert peer.output == 0
        finally:
            link.close()


@pytest.mark.parametrize("condition", [
    "matched", "matched_ble", "mixed_endpoint", "wrong_build", "changed_artifact", "fixture_artifact",
    "same_pin", "usb_identity",
])
def test_selected_command_is_independent_of_device_camera(
    tmp_path: Path, uno_peer_exe: Path, condition: str,
) -> None:
    profile, interfaces, evidence, recorded_result = device_documents()
    initialize_command_selection(profile, interfaces, evidence, condition)
    selected = interfaces["hc05_uno"]
    build = selected_command_build(profile, selected, condition)
    digest = selected["build_artifact_sha256"] = sha256(build).hexdigest()
    folder = write_device_documents(tmp_path, profile, interfaces, evidence, recorded_result)
    (folder / "artifacts" / digest).write_bytes(build if condition != "changed_artifact" else b"changed")
    with native_peer(uno_peer_exe, challenge=80, expiry=140) as peer:
        app = create_app(Config(tmp_path, backend_mode="device"), command_transport=lambda: nullcontext(peer))
        expected = [] if condition in ("matched", "matched_ble") else [
            "PROTOCOL_UNSUPPORTED" if condition in ("wrong_build", "usb_identity") else "NOT_READY",
        ]
        with TestClient(app, base_url=BASE) as client:
            headers = auth(client.get(API + "/bootstrap", headers=ORIGIN).json())
            view = wait_for(client, "/health", headers, lambda s: component(s, "Command")["cause_codes"] == expected)
            assert component(view, "RobotVideo")["status"] == "Unavailable"
            assert view["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            status = client.get(API + "/snapshot", headers=headers).json()
            assert status["runtime"]["motion_permission"] == "Disarmed"
            assert peer.output == 0
            if condition in ("changed_artifact", "fixture_artifact", "mixed_endpoint", "same_pin", "usb_identity"):
                assert not peer.trace
            elif condition in ("matched", "matched_ble"):
                assert any(packet.op == HELLO for _, packet in peer.trace)


def initialize_command_selection(profile: dict, interfaces: dict, evidence: dict, condition: str) -> None:
    profile["serial_max_packet_bytes"] = evidence["measurements"]["serial_max_packet_bytes"]["value"] = MAX_FRAME
    selected = interfaces["hc05_uno"]
    profile["serial_baud"] = evidence["measurements"]["serial_baud"]["value"] = selected["serial_baud"] = 38400
    selected["uno"]["target"] = "arduino:avr:uno"
    if condition == "usb_identity":
        selected["identity"] = "USB VID:PID=1A86:7523"
    if condition in ("matched_ble", "mixed_endpoint"):
        selected.update(transport="ble_gatt", identity=r"BTHLE\DEV_020102030405\7&synthetic", ble_address_type="public")
        if condition == "matched_ble":
            del selected["windows_port"]


def selected_command_build(profile: dict, selected: dict, condition: str) -> bytes:
    return json.dumps({
        **selected["uno"], "version": 1, "kind": "DisabledFixture" if condition == "fixture_artifact" else "Device",
        "build_id": (bytes(32) if condition == "wrong_build" else BUILD).hex(),
        "logical_output_sha256": selected["logical_output_sha256"], "serial_baud": profile["serial_baud"],
        "serial_rx_pin": 2, "serial_tx_pin": 2 if condition == "same_pin" else 3,
        "packet_ms": 25, "challenge_lifetime_ms": profile["challenge_lifetime_ms"],
        "firmware_expiry_ms": profile["firmware_expiry_ms"],
        "hardware_watchdog_ms": 120, "reset_evidence_sha256": selected["logical_output_sha256"],
    }).encode()


def test_selected_camera_shares_the_detection_frame_with_display_and_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(realtime, "VisionProcess", partial(realtime.VisionProcess, target=controlled_worker))

    class DisabledCommandPeer:
        cause = latched_failure = output = None
        failure = "CommandUnavailable"

        def start(self):
            pass

        def close(self):
            pass

        def probe(self):
            return True

        def revoke(self, generation, cause):
            pass

        def pulse(self, generation, direction, deadline):
            pytest.fail("The camera and evidence check must leave motion disabled")

    monkeypatch.setattr(app_entry, "SerialCommandLink", lambda *args: DisabledCommandPeer())
    documents = device_documents()
    profile, interfaces, evidence, result = documents
    initialize_command_selection(profile, interfaces, evidence, "matched")
    # Leave scheduling room for real sockets and the subprocess. These are synthetic test bounds.
    for name, value in {"clock_uncertainty_limit_us": 10_000, "camera_sync_max_rtt_us": 20_000,
                        "heartbeat_deadline_ms": 170, "display_deadline_ms": 180,
                        "capture_age_limit_ms": 200, "input_sample_deadline_ms": 160}.items():
        profile[name] = evidence["measurements"][name]["value"] = value
    evidence["stop_budget"] = {"software_ms": 460, "mechanical_margin_ms": 40}
    command = interfaces["hc05_uno"]
    build = selected_command_build(profile, command, "matched")
    digest = command["build_artifact_sha256"] = sha256(build).hexdigest()
    interfaces["controller"] = {"identity": SERIAL, "profile_sha256": sha256(result).hexdigest()}
    folder = write_camera_documents(tmp_path, CAMERA_BUILD, CAMERA_TOKEN, documents=documents)
    (folder / "artifacts" / digest).write_bytes(build)
    jpeg = jpeg_sample()
    sequence = 0

    async def camera(path, headers, read_body, timeout):
        nonlocal sequence
        if path == CLOCK:
            stamp = int(perf_counter() * 1_000_000)
            fields = clock_headers(headers, rx=stamp, tx=stamp)
        else:
            await asyncio.sleep(0.02)
            sequence += 1
            fields = frame_headers(len(jpeg), sequence, int(perf_counter() * 1_000_000))
        size = read_body(200, fields, 256)
        return Reply(jpeg if size else b"", perf_counter(), utc_ms())

    def app_factory(port):
        controller = Controller(SERIAL, 0.16, lambda: nullcontext(lambda: fresh_reports([device(1)])),
                                clock=perf_counter)
        return create_app(Config(tmp_path, backend_port=port, backend_mode="device", yoloe_assets=tmp_path),
                          controller=controller, camera_exchange=camera)

    with service(tmp_path, app_factory=app_factory) as laf, driving_search(laf) as (headers, driver):
        worker = tmp_path / "vision"
        await_file(worker / "prompt.json")
        publish(worker / "request", "candidate")
        try:
            await_file(worker / "frame.json")
            frame = json.loads((worker / "frame.json").read_text(encoding="utf-8"))
            wait_for(laf.http, "/snapshot", headers,
                     lambda _: driver.latest and driver.latest["capture_seq"] > frame["sequence"])
        finally:
            (worker / "release").touch()
        match, _ = review(laf, headers)
        display = next(item for item in tuple(driver.received_frames) if item["frame_id"] == match["frame_id"])
        assert (match["frame_id"], match["stream_epoch"]) == (frame["frame"], frame["stream"])
        assert (display["capture_seq"], display["source_capture_us"], display["source_clock_epoch"]) == (
            frame["sequence"], frame["source_us"], frame["clock"],
        )
        assert match["captured_at_ms"] == display["received_at_ms"] - display["capture_age_bound_ms"]
        assert match["box"] == {"x": 2, "y": 3, "width": 5, "height": 7}
        response = laf.http.get(f"{API}/media/{match['evidence_media']['id']}", headers=headers)
        assert response.status_code == 200 and response.headers["content-type"] == "image/png"
        with Image.open(BytesIO(jpeg)) as original, Image.open(BytesIO(response.content)) as captured:
            assert original.convert("RGB").tobytes() == captured.tobytes()


def test_serial_shutdown_waits_for_late_open_without_transmitting(uno_peer_exe: Path) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    entered, release, closed = Event(), Event(), Event()
    with native_peer(uno_peer_exe) as peer:
        @contextmanager
        def slow_open():
            entered.set()
            assert release.wait(3)
            try:
                yield peer
            finally:
                closed.set()

        link = SerialCommandLink(fixture.profile, BUILD, slow_open)
        link.start()
        closer = Thread(target=link.close, daemon=True)
        assert entered.wait(2)
        closer.start()
        try:
            closer.join(0.75)
            assert closer.is_alive() and not closed.is_set()
        finally:
            release.set()
            closer.join(3)
        assert closed.is_set() and not closer.is_alive()
        assert not peer.trace


def test_neutral_search_pauses_on_lost_status_ack_and_recovers_diagnostics(
    tmp_path: Path, uno_peer_exe: Path,
) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            with service(tmp_path, live_command=link) as laf, driving_search(laf) as (headers, _):
                assert peer.output == 0
                peer.fault = "idle_missing"
                snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: (
                    s["active_session"]["state"] == "Paused"
                    and any(f["cause"] == "CommandUnavailable" and f["restored"] for f in s["failures"])
                ))
                assert snapshot["runtime"]["motion_permission"] == "Disarmed"
                assert not any(packet.op == DRIVE for _, packet in peer.trace)
        finally:
            link.close()


@pytest.mark.parametrize("fault", ["idle_missing", "stop_missing"])
def test_reconnect_keeps_unobserved_disarmed_command_fault(uno_peer_exe: Path, fault: str) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            wait_until(link.probe)
            if fault == "stop_missing":
                wait_until(lambda: link.pulse(1, "forward", monotonic() + 0.24) is None and link.output == "forward")
            peer.fault = fault
            if fault == "stop_missing":
                link.revoke(1, "InputReleased")
            wait_until(lambda: sum(packet.op == HELLO for _, packet in peer.trace) >= 2)
            assert link.latched_failure == "CommandUnavailable" and not link.probe()
            assert peer.output == 0
            link.revoke(1, "CommandUnavailable")
            wait_until(link.probe)
        finally:
            link.close()


class SocketTransport:
    def __init__(self, channel: socket.socket):
        self.channel = channel
        channel.settimeout(0.05)

    def write(self, data: bytes) -> int:
        self.channel.sendall(data)
        return len(data)

    def read(self, size: int) -> bytes:
        if not select.select([self.channel], [], [], 0)[0]:
            return b""
        data = self.channel.recv(size)
        if not data:
            raise OSError("Command fixture link closed")
        return data


def serve_search(root: Path, listener: socket.socket, channel: socket.socket, held) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    observation = Observations(fixture)
    class Adapter:
        def observe(self, now, scope):
            observation.dpad = ("forward",) if held.is_set() else ()
            return observation.observe(now, scope)

    transport = SocketTransport(channel)
    link = SerialCommandLink(fixture.profile, BUILD, lambda: nullcontext(transport))
    link.start()
    try:
        port = listener.getsockname()[1]
        app = create_app(Config(root, backend_port=port),
                         simulation=replace(fixture, adapter=Adapter(), command_sink=link))
        server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=port, proxy_headers=False, access_log=False, ws="websockets",
            ws_max_size=app.state.socket_message_limit, ws_max_queue=1, ws_per_message_deflate=False,
            log_level="error",
        ))
        server.run(sockets=[listener])
    finally:
        link.close()


def test_killed_backend_leaves_one_queued_frame_then_firmware_expires(
    tmp_path: Path, uno_peer_exe: Path,
) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    context = get_context("spawn")
    with native_peer(uno_peer_exe) as peer, socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        host, child = socket.socketpair()
        held, queued, release, closed = context.Event(), Event(), Event(), Event()
        deferred = []

        def broker():
            pending = bytearray()
            attached = True
            while not closed.is_set():
                peer.output  # Drive the board clock even when nothing arrives from the backend.
                if deferred and release.is_set():
                    peer.write(deferred.pop())
                    release.clear()
                if not attached:
                    closed.wait(0.003)
                    continue
                if not select.select([host], [], [], 0.003)[0]:
                    continue
                try:
                    data = host.recv(256)
                except ConnectionResetError:
                    data = b""
                if not data:
                    attached = False
                    continue
                pending.extend(data)
                while (index := pending.find(0)) >= 0:
                    frame = bytes(pending[:index + 1])
                    del pending[:index + 1]
                    if len(frame) == 1:
                        continue
                    if frame == DISCARD_PARTIAL:
                        with peer.lock:
                            assert peer.step(frame)[0] == 0
                        continue
                    command = decode(frame)
                    if command.op == DRIVE and peer.output == 1 and not queued.is_set():
                        deferred.append(frame)
                        queued.set()
                        continue
                    peer.write(frame)
                    host.sendall(peer.read(MAX_FRAME))

        worker = Thread(target=broker, daemon=True)
        worker.start()
        backend = context.Process(target=serve_search, args=(tmp_path, listener, child, held))
        backend.start()
        child.close()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=0.5, trust_env=False) as http:
                def serving():
                    try:
                        return http.get(API + "/bootstrap", headers=ORIGIN).is_success
                    except httpx.TransportError:
                        return False

                wait_until(serving, 8)
                laf = Loopback(http, port, Clock(), Observations(fixture), [], None)
                with driving_search(laf) as (headers, driver):
                    wait_for(http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
                    held.set()
                    assert queued.wait(3)
                    killed = monotonic()
                    backend.kill()
                    release.set()
                    backend.join(3)
                    assert backend.exitcode
                    wait_until(lambda: any(at >= killed and p.op == DRIVE for at, p in peer.trace))
                    wait_until(lambda: peer.output == 0)
                    [(delivered, command)] = [(at, p) for at, p in peer.trace if at >= killed and p.op == DRIVE]
                    disabled, _ = peer.outputs[-1]
                    assert 0.215 <= disabled - delivered <= 0.27
                    assert not any(p.op == STOP for _, p in peer.trace)
                    print(f"Fixture backend kill to queued delivery {(delivered - killed) * 1000:.1f} ms, "
                          f"to logical disable {(disabled - killed) * 1000:.1f} ms")
                    with peer.lock:
                        assert peer.step(encode(command))[0] == 0
                    session_id = driver.session["id"]
        finally:
            closed.set()
            if backend.is_alive():
                backend.kill()
            backend.join(3)
            backend.close()
            worker.join(3)
            host.close()
        with service(tmp_path) as laf:
            new_headers = auth(laf.bootstrap())
            session = wait_for(laf.http, f"/sessions/{session_id}", new_headers)
            assert session["state"] == "Ended" and session["end_reason"] == "Interrupted"
            assert wait_for(laf.http, "/snapshot", new_headers)["runtime"]["motion_permission"] == "Disarmed"


def test_command_reset_pauses_search_through_deliberate_recovery(tmp_path: Path, uno_peer_exe: Path) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            with service(tmp_path, live_command=link) as laf:
                with driving_search(laf) as (old_headers, _):
                    wait_for(laf.http, "/snapshot", old_headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    laf.observations.dpad = ("forward",)
                    wait_until(lambda: peer.output == 1)
                    peer.fault = "reset"
                    state = wait_for(laf.http, "/snapshot", old_headers, lambda s:
                                     s["active_session"]["state"] == "Paused")
                    failure = next(f for f in state["failures"] if f["cause"] == "CommandUnavailable")
                    paused = state["active_session"]
                    assert {"cause": "RecoveryRequired", "failure_id": failure["failure_id"]} in paused["pause_causes"]
                    wait_until(link.probe)
                    assert peer.output == 0
                with recover_workspace(laf, paused) as (headers, driver):
                    restored = wait_for(laf.http, "/snapshot", headers, lambda state: any(
                        fault["cause"] == "CommandUnavailable" and fault["restored"] for fault in state["failures"]
                    ))
                    failure = next(f for f in restored["failures"] if f["cause"] == "CommandUnavailable")
                    revision = restored["active_session"]["revision"]
                    reply = search_action(laf, headers, driver, "resume", revision)
                    assert reply.json()["code"] == "RECOVERY_REQUIRED"
                    reply = search_action(laf, headers, driver, "acknowledge", revision,
                                          failure_ids=[failure["failure_id"]])
                    assert reply.is_success, reply.text
                    ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_resume"])
                    reply = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
                    assert reply.is_success, reply.text
                    sleep(0.25)
                    assert peer.output == 0
                    laf.observations.dpad = ()
                    wait_for(laf.http, "/snapshot", headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    laf.observations.dpad = ("left",)
                    wait_until(lambda: peer.output == 3)
                    laf.observations.circle = True
                    wait_until(lambda: peer.output == 0)
                    stopped = wait_for(laf.http, "/snapshot", headers, lambda s:
                                       s["active_session"]["state"] == "Paused")
                    assert any(f["cause"] == "EmergencyStop" for f in stopped["failures"])
        finally:
            link.close()
