import asyncio
import json
import socket
from collections import Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from shutil import copytree
from threading import Event, Thread
from time import monotonic, sleep

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import ClientConnection, connect

from backend.app import realtime
from backend.app import simulation as fixture
from backend.app.config import Config
from backend.app.main import create_app
from backend.app.realtime import Channel
from backend.app.simulation import (
    FIXTURES,
    Capture,
    Observation,
    Simulation,
    contract_definitions,
    load_simulation,
)
from backend.app.storage import RecordsStorage

ORIGIN = "http://127.0.0.1:3000"
API = "/api/v1"


def validate(name: str, value: object) -> None:
    Draft202012Validator({"$defs": contract_definitions(), "$ref": f"#/$defs/{name}"}).validate(value)


@pytest.mark.parametrize("selection, expected", [(None, "NOT_READY"), ("future-v2", "PROTOCOL_UNSUPPORTED")])
def test_disabled_or_incompatible_profile_keeps_records(tmp_path: Path, selection: str | None, expected: str) -> None:
    config = Config(tmp_path, simulation_profile=selection)
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000") as client:
        boot = client.get(API + "/bootstrap", headers={"Origin": ORIGIN}).json()
        assert boot["qualification_profile"] is None
        headers = {"Origin": ORIGIN, "X-App-Capability": boot["capability"], "X-App-Client-Id": boot["client_id"]}
        response = client.post(API + "/websocket-tickets", headers=headers,
                               json={"client_id": boot["client_id"], "channel": "events"})
        assert response.status_code == 503
        assert response.json()["code"] == expected
        assert response.headers["Cache-Control"] == "no-store"
        health = wait_for(client, "/health", headers=headers)
        assert health["backend_boot_id"] == boot["backend_boot_id"]
        assert client.get(API + "/objects", headers=headers).status_code == 200


@pytest.mark.parametrize("field,value", [
    ("evidence_manifest_sha256", "0" * 64), ("max_frame_pixels", 0), ("max_header_bytes", 131072),
    ("event_queue_bytes", 2000), ("max_client_message_bytes", 65537), ("heartbeat_deadline_ms", 100),
    ("clock_uncertainty_limit_us", 10000), ("challenge_lifetime_ms", 60), ("proximity_clear_mm", 150),
])
def test_invalid_fixture_fails_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str, value: object) -> None:
    folder = tmp_path / "fixture"
    copytree(FIXTURES, folder)
    monkeypatch.setattr(fixture, "FIXTURES", folder)
    profile = folder / "profile.json"
    profile.write_text(json.dumps({**json.loads(profile.read_bytes()), field: value}), encoding="utf-8")
    config = Config(tmp_path / "records", simulation_profile="fixture-v1")
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000") as client:
        boot = client.get(API + "/bootstrap", headers={"Origin": ORIGIN}).json()
        assert boot["qualification_profile"] is None
        headers = {"X-App-Capability": boot["capability"], "X-App-Client-Id": boot["client_id"]}
        wait_for(client, "/health", headers=headers)
        assert client.get(API + "/settings", headers=headers).status_code == 200
        response = client.post(API + "/websocket-tickets", headers=headers,
                               json={"client_id": boot["client_id"], "channel": "events"})
        assert response.status_code == 503 and response.json()["code"] == "NOT_READY"


class Clock:
    offset = 0.0

    def __call__(self) -> float:
        return monotonic() + self.offset


class Observations:
    def __init__(self, composition: Simulation):
        self.adapter = composition.adapter
        self.inference = True
        self.webcam = False
        self.robot = "live"
        self.latest: Capture | None = None

    def observe(self, now: float) -> Observation:
        base = self.adapter.observe(now)
        if self.robot == "live":
            self.latest = base.robot
        robot = self.latest
        if self.robot == "invalid" and base.robot:
            robot = replace(base.robot, width=base.robot.width - 1)
        return replace(base, inference=self.inference, webcam=base.webcam if self.webcam else None, robot=robot)


class PauseDelivery:
    """Pause only the first connection on each selected path, at the real ASGI send boundary."""

    def __init__(self, app: ASGIApp):
        self.app = app
        self.initial: Counter[str] = Counter()
        self.entered = {API + path: Event() for path in ("/events", "/video/robot")}
        self.resume_video = Event()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "websocket" or path not in self.entered:
            await self.app(scope, receive, send)
            return
        self.initial[path] += 1
        if self.initial[path] != 1:
            await self.app(scope, receive, send)
            return

        async def delay(message: Message) -> None:
            if message["type"] == "websocket.send":
                self.entered[path].set()
                while path == API + "/events" or not self.resume_video.is_set():
                    await asyncio.sleep(0.01)
            await send(message)

        await self.app(scope, receive, delay)


class Loopback:
    def __init__(self, http: httpx.Client, port: int, clock: Clock, observations: Observations,
                 invalidations: list[tuple[str, Channel]], blocked: PauseDelivery | None):
        self.http = http
        self.ws = f"ws://127.0.0.1:{port}" + API
        self.clock = clock
        self.observations = observations
        self.invalidations = invalidations
        self.blocked = blocked

    def bootstrap(self) -> dict[str, str]:
        response = self.http.get(API + "/bootstrap", headers={"Origin": ORIGIN})
        assert response.status_code == 200
        validate("BootstrapResponse", response.json())
        return response.json()

    def ticket(self, headers: dict[str, str], channel: str) -> str:
        response = self.http.post(API + "/websocket-tickets", headers=headers,
                                  json={"client_id": headers["X-App-Client-Id"], "channel": channel})
        assert response.status_code == 200, response.json()
        validate("TicketResponse", response.json())
        return response.json()["ticket"]

    def open(self, path: str, ticket: str, *, version: str = "laf.v1", origin: str | None = ORIGIN,
             extra_protocols: tuple[str, ...] = ()) -> ClientConnection:
        return connect(self.ws + path, origin=origin, subprotocols=[version, f"laf.ticket.{ticket}", *extra_protocols],
                       open_timeout=3, close_timeout=1, proxy=None)


def auth(boot: dict[str, str]) -> dict[str, str]:
    return {"X-App-Capability": boot["capability"], "X-App-Client-Id": boot["client_id"]}


def wait_for(client: httpx.Client, path: str, headers: dict[str, str], check=lambda _: True) -> dict:
    deadline = monotonic() + 5
    while monotonic() < deadline:
        response = client.get(API + path, headers=headers)
        if response.status_code == 200 and check(response.json()):
            return response.json()
        sleep(0.02)
    raise AssertionError(f"Timed out waiting for {path}")


@contextmanager
def service(root: Path, *, blocked: bool = False, event_limit: int | None = None,
            frame_limit: int | None = None) -> Iterator[Loopback]:
    clock = Clock()
    storage = RecordsStorage(root, monotonic=clock)
    simulation = load_simulation("fixture-v1")
    assert simulation
    observations = Observations(simulation)
    profile = simulation.profile
    if blocked:
        profile = replace(profile, values={**profile.values, "event_queue_messages": 1})
    if event_limit is not None:
        profile = replace(profile, values={**profile.values, "max_event_message_bytes": event_limit})
    if frame_limit is not None:
        profile = replace(profile, values={**profile.values, "max_frame_bytes": frame_limit})
    invalidations: list[tuple[str, Channel]] = []
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        app = create_app(Config(root, backend_port=port), storage=storage,
                         simulation=Simulation(profile, observations),
                         on_channel_invalidated=lambda client, channel: invalidations.append((client, channel)))
        delayed = PauseDelivery(app) if blocked else None
        server = uvicorn.Server(uvicorn.Config(
            delayed or app, host="127.0.0.1", port=port, proxy_headers=False, access_log=False,
            ws="websockets", ws_max_size=app.state.socket_message_limit, ws_max_queue=1,
            ws_per_message_deflate=False, timeout_graceful_shutdown=2, log_level="error",
        ))
        worker = Thread(target=lambda: server.run(sockets=[listener]), daemon=True)
        worker.start()
        try:
            deadline = monotonic() + 5
            while not server.started and worker.is_alive() and monotonic() < deadline:
                sleep(0.01)
            assert server.started
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=3, trust_env=False) as http:
                yield Loopback(http, port, clock, observations, invalidations, delayed)
        finally:
            server.should_exit = True
            worker.join(5)
            assert not worker.is_alive()


def event(channel: ClientConnection) -> dict:
    value = json.loads(channel.recv(timeout=4))
    validate("EventEnvelope", value)
    return value


def frame(channel: ClientConnection) -> tuple[dict, bytes]:
    data = channel.recv(timeout=4)
    assert isinstance(data, bytes)
    size = int.from_bytes(data[:4], "big")
    metadata = json.loads(data[4:4 + size].decode("utf-8", errors="strict"))
    validate("FrameMetadata", metadata)
    jpeg = data[4 + size:]
    assert jpeg[:2] == b"\xff\xd8" and jpeg[-2:] == b"\xff\xd9"
    return metadata, jpeg


def rejects(loopback: Loopback, path: str, token: str, status: int, code: str, **kwargs) -> None:
    with pytest.raises(InvalidStatus) as error:
        loopback.open(path, token, **kwargs)
    assert error.value.response.status_code == status
    assert error.value.response.headers["cache-control"] == "no-store"
    assert json.loads(error.value.response.body)["code"] == code


def test_ticket_protection_expiry_single_use_and_restart(tmp_path: Path) -> None:
    with service(tmp_path) as app:
        first = app.bootstrap()
        headers = auth(first)
        body = {"client_id": first["client_id"], "channel": "events"}
        url = API + "/websocket-tickets"
        preflight = app.http.options(url, headers={
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type, x-app-capability",
        })
        assert preflight.status_code == 204 and preflight.headers["Access-Control-Allow-Origin"] == ORIGIN
        assert app.http.post(url, json=body).json()["code"] == "CAPABILITY_INVALID"
        assert app.http.post(url, headers={**headers, "Host": "localhost:8000"}, json=body).json()["code"] == "HOST_REJECTED"
        assert app.http.post(url, headers={**headers, "Origin": "null"}, json=body).json()["code"] == "ORIGIN_REJECTED"
        other = app.bootstrap()
        assert app.http.post(url, headers=headers, json={**body, "client_id": other["client_id"]}).status_code == 422
        assert app.http.post(url, headers=headers, content=b"\xff").status_code == 415
        assert app.http.post(url, headers={**headers, "Content-Type": "application/json"},
                             content=b'{"channel":"events","channel":"events"}').status_code == 422
        wait_for(app.http, "/health", headers)
        stale = app.ticket(headers, "events")
        app.clock.offset += 10.01
        rejects(app, "/events", stale, 403, "TICKET_EXPIRED")
        rejects(app, "/events", stale, 403, "TICKET_INVALID")
        token = app.ticket(headers, "events")
        rejects(app, "/video/robot", token, 403, "TICKET_INVALID")
        rejects(app, "/events", token, 403, "ORIGIN_REJECTED", origin=None)
        rejects(app, "/events", token, 503, "PROTOCOL_UNSUPPORTED", version="laf.v2")
        rejects(app, "/events", token, 503, "PROTOCOL_UNSUPPORTED", extra_protocols=("laf.v1",))
        with app.open("/events", token) as stream:
            assert stream.subprotocol == "laf.v1"
            received = event(stream)
            assert received["payload"]["qualification_profile"] == first["qualification_profile"]
            assert received["payload"]["runtime"]["motion_permission"] == "Disarmed"
            assert token not in json.dumps(received) and first["capability"] not in json.dumps(received)
            rejects(app, "/events", token, 403, "TICKET_CONSUMED")
        unspent = [app.ticket(headers, "events") for _ in range(32)]
        assert len(set(unspent)) == 32
        assert app.http.post(url, headers=headers, json=body).json()["code"] == "CAPACITY_REACHED"
        restarted_ticket = unspent[0]

    with service(tmp_path) as restarted:
        next_boot = restarted.bootstrap()
        assert next_boot["backend_boot_id"] != first["backend_boot_id"]
        assert next_boot["capability"] != first["capability"]
        rejects(restarted, "/events", restarted_ticket, 403, "TICKET_INVALID")
        assert restarted.http.get(API + "/snapshot", headers=headers).json()["code"] == "CAPABILITY_INVALID"
        new_auth = auth(next_boot)
        wait_for(restarted.http, "/health", new_auth)
        with restarted.open("/events", restarted.ticket(new_auth, "events")) as stream:
            snapshot = event(stream)
            assert snapshot["event_seq"] == 1
            assert snapshot["payload"]["lease"]["state"] == "Unowned"


def test_atomic_snapshot_handoff_replacement_and_close_codes(tmp_path: Path) -> None:
    with service(tmp_path) as app:
        first = auth(app.bootstrap())
        watcher = auth(app.bootstrap())
        wait_for(app.http, "/health", first)
        with app.open("/events", app.ticket(first, "events")) as initial:
            baseline = event(initial)
            assert baseline["event_seq"] == baseline["payload"]["event_seq"] == 1
            token = app.ticket(watcher, "events")
            with ThreadPoolExecutor(max_workers=1) as attempts:
                subscription = attempts.submit(app.open, "/events", token)
                app.observations.inference = False
                wait_for(app.http, "/health", first, lambda health: status(health, "AI") == "Unavailable")
                changed = event(initial)
                assert changed["type"] == "readiness_changed" and changed["event_seq"] == 2
                with subscription.result(timeout=5) as spectator:
                    fresh = event(spectator)
                    if fresh["event_seq"] == 1:
                        fresh = event(spectator)
                        assert fresh["type"] == "readiness_changed"
                    assert fresh["event_seq"] == 2 and status(fresh["payload"], "AI") == "Unavailable"
                    with app.open("/events", app.ticket(first, "events")) as replacement:
                        assert event(replacement)["event_seq"] == 2
                        assert (first["X-App-Client-Id"], "events") in app.invalidations
                        closed(initial, 1008)
                        replacement.send("{")
                        closed(replacement, 1007)
                    assert (watcher["X-App-Client-Id"], "events") not in app.invalidations
                    spectator.send(b"bad")
                    closed(spectator, 1003)
        with app.open("/events", app.ticket(first, "events")) as stream:
            event(stream)
            stream.send("x" * 4097)
            closed(stream, 1009)


def status(payload: dict, name: str) -> str:
    return next(component["status"] for component in payload["readiness"]["components"] if component["component"] == name)


def closed(channel: ClientConnection, code: int, *, drain: bool = False) -> None:
    with pytest.raises(ConnectionClosed) as error:
        channel.recv(timeout=4)
        if drain:
            while True:
                channel.recv(timeout=4)
    assert error.value.rcvd and error.value.rcvd.code == code


def test_video_freshness_dimensions_and_independent_channels(tmp_path: Path) -> None:
    with service(tmp_path) as app:
        headers = auth(app.bootstrap())
        wait_for(app.http, "/health", headers)
        with app.open("/video/robot", app.ticket(headers, "robot-video")) as video:
            first, scene = frame(video)
            second, same_scene = frame(video)
            assert same_scene == scene
            assert second["capture_seq"] > first["capture_seq"] and first["frame_id"] != second["frame_id"]
            assert second["source_capture_us"] > first["source_capture_us"]
            assert second["stream_epoch"] == first["stream_epoch"]
            assert second["source_clock_epoch"] == first["source_clock_epoch"]
            assert second["width"] == 480 and second["height"] == 262
            assert app.http.get(API + "/health", headers=headers).json()["readiness"]["can_start"]["Controller"] is False
            assert status(app.http.get(API + "/health", headers=headers).json(), "Webcam") == "Unavailable"

            app.observations.robot = "frozen"
            app.clock.offset += 1
            wait_for(app.http, "/health", headers, lambda health: status(health, "RobotVideo") == "Unavailable")
            app.observations.robot = "invalid"
            with app.open("/video/robot", app.ticket(headers, "robot-video")) as replacement:
                closed(video, 1008, drain=True)
                assert (headers["X-App-Client-Id"], "robot-video") in app.invalidations
                with pytest.raises(TimeoutError):
                    replacement.recv(timeout=0.25)
                app.observations.robot = "live"
                resumed, _ = frame(replacement)
                assert resumed["capture_seq"] > second["capture_seq"]
                app.observations.webcam = True
                with app.open("/video/webcam", app.ticket(headers, "webcam-video")) as webcam:
                    assert frame(webcam)[0]["source"] == "webcam"
                    assert frame(replacement)[0]["source"] == "robot"
                    webcam.send("bad")
                    closed(webcam, 1003)


def test_video_only_client_expires_without_disturbing_the_event_watcher(tmp_path: Path) -> None:
    with service(tmp_path) as app:
        camera = auth(app.bootstrap())
        watcher = auth(app.bootstrap())
        wait_for(app.http, "/health", camera)
        with (
            app.open("/video/robot", app.ticket(camera, "robot-video")) as video,
            app.open("/events", app.ticket(watcher, "events")) as events,
        ):
            frame(video)
            initial = event(events)
            app.clock.offset += 1801
            closed(video, 1008, drain=True)
            assert app.http.get(API + "/snapshot", headers=camera).json()["code"] == "CLIENT_INVALID"
            app.observations.inference = False
            assert event(events)["event_seq"] == initial["event_seq"] + 1
            assert app.http.get(API + "/snapshot", headers=watcher).status_code == 200


def test_full_frame_bound_applies_before_jpeg_decode(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    decoded = Event()

    def unexpected_decode(*args, **kwargs):
        decoded.set()
        raise ValueError("This candidate cannot fit the frame envelope")

    monkeypatch.setattr(realtime, "read_sample", unexpected_decode)
    # This accepts the raw JPEG and prefix but lacks space for the metadata.
    with service(tmp_path, frame_limit=(FIXTURES / "robot.jpg").stat().st_size + 5) as app:
        headers = auth(app.bootstrap())
        wait_for(app.http, "/health", headers)
        with app.open("/video/robot", app.ticket(headers, "robot-video")) as video:
            with pytest.raises(TimeoutError):
                video.recv(timeout=0.25)
        assert not decoded.is_set()
        assert status(app.http.get(API + "/health", headers=headers).json(), "RobotVideo") == "Unavailable"


def test_oversized_snapshot_explicitly_closes_only_the_event_channel(tmp_path: Path) -> None:
    with service(tmp_path, event_limit=1024) as app:
        headers = auth(app.bootstrap())
        wait_for(app.http, "/health", headers)
        with app.open("/video/robot", app.ticket(headers, "robot-video")) as video:
            assert frame(video)[0]["source"] == "robot"
            with app.open("/events", app.ticket(headers, "events")) as events:
                closed(events, 1009)
            assert (headers["X-App-Client-Id"], "events") in app.invalidations
            assert (headers["X-App-Client-Id"], "robot-video") not in app.invalidations
            assert frame(video)[0]["source"] == "robot"
            assert app.http.get(API + "/snapshot", headers=headers).status_code == 200


def test_slow_event_and_video_consumers_do_not_stall_other_channels(tmp_path: Path) -> None:
    with service(tmp_path, blocked=True) as app:
        held = app.blocked
        assert held
        slow = auth(app.bootstrap())
        fast = auth(app.bootstrap())
        wait_for(app.http, "/health", fast)
        with (
            app.open("/events", app.ticket(slow, "events")) as slow_events,
            app.open("/video/robot", app.ticket(slow, "robot-video")) as slow_video,
            app.open("/events", app.ticket(fast, "events")) as fast_events,
            app.open("/video/robot", app.ticket(fast, "robot-video")) as fast_video,
        ):
            assert all(signal.wait(3) for signal in held.entered.values())
            initial = event(fast_events)
            first, _ = frame(fast_video)
            for index, ready in enumerate((False, True), start=1):
                app.observations.inference = ready
                changed = event(fast_events)
                assert changed["event_seq"] == initial["event_seq"] + index
                assert status(changed["payload"], "AI") == ("Ready" if ready else "Unavailable")
            closed(slow_events, 1008)
            live = first
            while live["capture_seq"] <= first["capture_seq"] + 2:
                live, _ = frame(fast_video)
            held.resume_video.set()
            in_flight, _ = frame(slow_video)
            latest, _ = frame(slow_video)
            assert in_flight["capture_seq"] <= first["capture_seq"]
            assert latest["capture_seq"] >= live["capture_seq"] > in_flight["capture_seq"] + 1
