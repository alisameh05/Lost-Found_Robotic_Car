import asyncio
import json
import socket
import sqlite3
from collections import Counter, deque
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager, nullcontext
from dataclasses import replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from queue import Empty, Full, Queue
from shutil import copytree
from threading import Event, Thread
from time import monotonic, sleep
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from PIL import Image
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from websockets.exceptions import ConnectionClosed, InvalidStatus
from websockets.sync.client import ClientConnection, connect

from backend.app import realtime, sessions
from backend.app import simulation as fixture
from backend.app.config import Config
from backend.app.control import Revocation
from backend.app.controller import Controller, Poll
from backend.app.main import create_app
from backend.app.motion import (
    Command,
    Direction,
    FixtureCommandSink,
    InputSample,
    InputScope,
    LiveCommandSink,
    controller_intent,
    gesture_intent,
)
from backend.app.realtime import Channel
from backend.app.simulation import (
    FIXTURES,
    CandidateObservation,
    Capture,
    Inference,
    InferenceSample,
    Observation,
    ProximitySample,
    QualificationProfile,
    Simulation,
    contract_definitions,
    load_simulation,
)
from backend.app.storage import RecordsStorage
from backend.app.webcam import Webcam
from backend.tests.test_controller import SERIAL, device, fresh_reports
from backend.tests.test_registration import submit
from backend.tests.test_session_history import captured_png, insert_match

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


def test_phase_06_never_substitutes_fixture_input_or_matching(tmp_path: Path) -> None:
    config = Config(tmp_path, simulation_profile="phase-06-v1", recorded_robot_jpeg=FIXTURES / "robot.jpg")
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000") as client:
        boot = client.get(API + "/bootstrap", headers={"Origin": ORIGIN}).json()
        assert boot["qualification_profile"]["profile_id"] == "phase-06-v1"
        headers = auth(boot)
        wait_for(client, "/health", headers)
        deadline = monotonic() + 3
        while True:
            readiness = client.get(API + "/health", headers=headers).json()["readiness"]
            status = {item["component"]: item["status"] for item in readiness["components"]}
            if status["RobotVideo"] == "Ready" and status["AI"] == "Unavailable":
                break
            assert monotonic() < deadline, status
            sleep(0.02)
        assert status["Controller"] == status["Webcam"] == "Unavailable"
        assert status["Command"] == "Ready"


@pytest.mark.parametrize("recording", ["missing", "invalid", "oversized"])
def test_phase_06_reports_an_unavailable_recording_without_losing_the_profile(tmp_path: Path, recording: str) -> None:
    invalid = tmp_path / "invalid.jpg"
    if recording == "oversized":
        # Valid JPEG with a comment that leaves no room for the frame envelope.
        jpeg = (FIXTURES / "robot.jpg").read_bytes()
        padding = 131_000 - len(jpeg) - 2 - 60_002
        invalid.write_bytes(jpeg[:2] + b"\xff\xfe" + (60_002).to_bytes(2, "big") + bytes(60_000)
                            + b"\xff\xfe" + padding.to_bytes(2, "big") + bytes(padding - 2) + jpeg[2:])
        with Image.open(invalid) as image:
            image.load()
    elif recording == "invalid":
        invalid.write_bytes(b"Not a JPEG.")
    config = Config(tmp_path / "records", simulation_profile="phase-06-v1",
                    recorded_robot_jpeg=invalid if recording != "missing" else None)
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000") as client:
        boot = client.get(API + "/bootstrap", headers={"Origin": ORIGIN}).json()
        assert boot["qualification_profile"]["profile_id"] == "phase-06-v1"
        headers = auth(boot)
        health = wait_for(client, "/health", headers)
        assert status(health, "RobotVideo") == "Unavailable"
        assert client.get(API + "/objects", headers=headers).status_code == 200


@pytest.mark.parametrize("invalid_interface", ["deadline", "shape"])
def test_phase_06_rejects_invalid_device_manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                 invalid_interface: str) -> None:
    folder = tmp_path / "fixture"
    copytree(FIXTURES, folder)
    monkeypatch.setattr(fixture, "FIXTURES", folder)
    interfaces = folder / "phase06" / "interfaces.json"
    profile = folder / "phase06" / "profile.json"
    document = [] if invalid_interface == "shape" else {
        **json.loads(interfaces.read_bytes()), "controller_sample_deadline_ms": 241,
    }
    data = json.dumps(document).encode()
    interfaces.write_bytes(data)
    profile.write_text(json.dumps({
        **json.loads(profile.read_bytes()), "device_protocol_manifest_sha256": sha256(data).hexdigest(),
    }), encoding="utf-8")
    config = Config(tmp_path / "records", simulation_profile="phase-06-v1")
    with TestClient(create_app(config), base_url="http://127.0.0.1:8000") as client:
        boot = client.get(API + "/bootstrap", headers={"Origin": ORIGIN}).json()
        assert boot["qualification_profile"] is None
        headers = auth(boot)
        wait_for(client, "/health", headers)
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
        self.controller_sample = True
        self.gesture_sample = True
        self.robot = "live"
        self.robot_jpeg: bytes | None = None
        self.latest: Capture | None = None
        self.command = True
        self.storage = True
        self.fingers: int | None = 0
        self.hands = 1
        self.certain = self.stable = True
        self.dpad: tuple[Direction, ...] = ()
        self.circle = False
        self.proximity: int | None = None
        self.protocol_fault = False
        self.capture_barrier: Event | None = None
        self.continuity: Callable[[Capture, InputScope], Capture] | None = None

    def observe(self, now: float, scope: InputScope | None = None) -> Observation:
        barrier = self.capture_barrier
        if barrier is not None:
            assert barrier.wait(5)
        if self.protocol_fault:
            raise ValueError("Simulated incompatible adapter")
        base = self.adapter.observe(now, scope)
        if self.robot == "live":
            self.latest = replace(base.robot, jpeg=self.robot_jpeg) if base.robot and self.robot_jpeg else base.robot
        robot = self.latest
        if self.robot == "missing":
            robot = None
        elif self.robot == "unknown-age" and base.robot:
            robot = replace(base.robot, age_ms=-1)
        elif self.robot == "invalid" and base.robot:
            robot = replace(base.robot, width=base.robot.width - 1)
        elif self.robot == "epoch" and base.robot:
            robot = replace(base.robot, stream_epoch="replacement")
        if self.robot == "live" and robot and scope and self.continuity:
            robot = self.continuity(robot, scope)
        gesture = gesture_intent(self.fingers, hands=self.hands, certain=self.certain, stable=self.stable)
        controller = controller_intent(self.dpad, circle=self.circle)
        return replace(base, inference=self.inference, webcam=base.webcam if self.webcam else None, robot=robot,
                       command=self.command,
                       controller_input=InputSample(scope, now, controller) if scope and self.controller_sample else None,
                       gesture_input=InputSample(scope, now, gesture) if scope and self.gesture_sample else None,
                       proximity=ProximitySample("fixture-range", base.proximity.sequence, now, self.proximity)
                       if base.proximity else None,
                       controller_sample_at=base.controller_sample_at if self.controller_sample else now - 1,
                       gesture_sample_at=base.gesture_sample_at if self.gesture_sample else now - 1)


class CommandDevice(FixtureCommandSink):
    def __init__(self, profile: QualificationProfile):
        self.device_clock = Clock()
        super().__init__(profile, self.device_clock)
        self.acknowledgment = "valid"

    def renew(self, command: Command) -> Command | None:
        accepted = super().renew(command)
        if self.acknowledgment == "missing":
            return None
        if self.acknowledgment == "replayed":
            return replace(command, challenge=replace(command.challenge, sequence=command.challenge.sequence - 1))
        return accepted

    def probe(self) -> bool:
        return self.acknowledgment == "valid" and super().probe()


class PauseDelivery:
    """Pause one connection on each selected path at the real ASGI send boundary."""

    def __init__(self, app: ASGIApp, connection_number: int):
        self.app = app
        self.connection_number = connection_number
        self.initial: Counter[str] = Counter()
        self.entered = {API + path: Event() for path in ("/events", "/video/robot")}
        self.resume_events = Event()
        self.resume_video = Event()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "websocket" or path not in self.entered:
            await self.app(scope, receive, send)
            return
        self.initial[path] += 1
        if self.initial[path] != self.connection_number:
            await self.app(scope, receive, send)
            return

        async def delay(message: Message) -> None:
            if message["type"] == "websocket.send":
                self.entered[path].set()
                release = self.resume_events if path == API + "/events" else self.resume_video
                while not release.is_set():
                    await asyncio.sleep(0.01)
            await send(message)

        await self.app(scope, receive, delay)


class Loopback:
    def __init__(self, http: httpx.Client, port: int, clock: Clock, observations: Observations,
                 invalidations: list[tuple[str, Channel]], blocked: PauseDelivery | None,
                 command: CommandDevice | None = None):
        self.http = http
        self.ws = f"ws://127.0.0.1:{port}" + API
        self.clock = clock
        self.observations = observations
        self.invalidations = invalidations
        self.blocked = blocked
        self.command = command

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
    context = response.json()
    readiness = context.get("readiness")
    failures = [item["cause"] for item in context.get("failures", [])]
    raise AssertionError(f"Timed out waiting for {path}. Status {response.status_code}, {readiness=}, {failures=}")


def test_control_is_exclusive_and_historical_retries_do_not_reacquire(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        alice, bob = laf.bootstrap(), laf.bootstrap()
        alice_headers, bob_headers = auth(alice), auth(bob)
        wait_for(laf.http, "/health", alice_headers, simulation_ready)
        acquire = {"request_id": str(uuid4()), "client_id": alice["client_id"], "session_id": None, "takeover": False}
        with laf.open("/events", laf.ticket(alice_headers, "events")) as owner, \
                laf.open("/events", laf.ticket(bob_headers, "events")) as spectator:
            assert event(owner)["payload"]["lease"]["can_acquire"]
            assert event(spectator)["payload"]["lease"]["can_acquire"]
            path = API + "/control-lease"
            response = laf.http.post(path, headers=alice_headers, json=acquire)
            assert response.status_code == 200, response.json()
            owned = response.json()
            validate("LeaseResponse", owned)
            owner_update, spectator_update = (lease_event(channel, "Owned") for channel in (owner, spectator))
            assert owner_update["event_seq"] == spectator_update["event_seq"]
            assert owned["client_lease_id"] not in json.dumps([owner_update, spectator_update])
            for identity, headers in ((alice, alice_headers), (bob, bob_headers)):
                competing = {**acquire, "request_id": str(uuid4()), "client_id": identity["client_id"], "takeover": True}
                response = laf.http.post(path, headers=headers, json=competing)
                assert (response.status_code, response.json()["code"]) == (403, "LEASE_OWNED")

            release = {"request_id": str(uuid4()), "client_id": alice["client_id"], "session_id": None,
                       "client_lease_id": owned["client_lease_id"], "control_generation": owned["control_generation"]}
            result = laf.http.post(path + "/release", headers=alice_headers, json=release)
            assert result.status_code == 200
            assert result.json()["client_lease_id"] is None
            for channel in (owner, spectator):
                lease_event(channel, "Unowned")
            retry = laf.http.post(path, headers=alice_headers, json=acquire).json()
            assert retry["client_lease_id"] == owned["client_lease_id"]
            assert retry["lease"] == owned["lease"]
            assert retry["snapshot"]["lease"]["state"] == "Unowned"
            conflict = laf.http.post(path, headers=alice_headers, json={**acquire, "takeover": True})
            assert (conflict.status_code, conflict.json()["code"]) == (409, "REQUEST_ID_CONFLICT")
            next_request = {**acquire, "request_id": str(uuid4()), "client_id": bob["client_id"]}
            assert laf.http.post(path, headers=bob_headers, json=next_request).status_code == 409
            accepted = laf.http.post(path, headers=bob_headers, json={**next_request, "takeover": True}).json()
            assert accepted["lease"]["owner_client_id"] == bob["client_id"]
            released = laf.http.post(path + "/release", headers=alice_headers, json=release).json()
            assert released["lease"]["state"] == "Unowned"
            assert released["snapshot"]["lease"]["owner_client_id"] == bob["client_id"]


@contextmanager
def service(root: Path, *, blocked: bool = False, event_limit: int | None = None,
            frame_limit: int | None = None, revocations: list[Revocation] | None = None,
            inference: Inference | None = None, blocked_connection: int = 1,
            checkpoint: Callable[[str], None] | None = None, wall: Callable[[], int] | None = None,
            local_vision: bool = False, webcam_factory: Callable[[QualificationProfile, Clock], Webcam] | None = None,
            local_gestures: bool = False, controller_poll: Poll | None = None,
            live_command: LiveCommandSink | None = None,
            app_factory: Callable[[int], FastAPI] | None = None) -> Iterator[Loopback]:
    clock = Clock()
    selected = "local-controller-v1" if controller_poll else "local-gestures-v1" if local_gestures else "fixture-v1"
    simulation = load_simulation(selected)
    assert simulation
    observations = Observations(simulation)

    class ObservedStorage(RecordsStorage):
        def safety_storage_healthy(self, preparing):
            return observations.storage and super().safety_storage_healthy(preparing)

    storage = ObservedStorage(root, monotonic=clock, checkpoint=checkpoint, **({"clock": wall} if wall else {}))
    profile = simulation.profile
    if blocked and blocked_connection == 1:
        profile = replace(profile, values={**profile.values, "event_queue_messages": 1})
    if event_limit is not None:
        profile = replace(profile, values={**profile.values, "max_event_message_bytes": event_limit})
    if frame_limit is not None:
        profile = replace(profile, values={**profile.values, "max_frame_bytes": frame_limit})
    command = None if live_command or app_factory else CommandDevice(profile)
    if command:
        command.start()
    invalidations: list[tuple[str, Channel]] = []
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        config = Config(root, backend_port=port, simulation_profile="local-yoloe-v1" if local_vision else selected)
        app = app_factory(port) if app_factory else create_app(config, storage=storage,
                         simulation=Simulation(profile, observations, live_command or command, inference),
                         webcam=webcam_factory(profile, clock) if webcam_factory else None,
                         controller=Controller(SERIAL, profile.bound("input_sample_deadline_ms") / 1000,
                                               lambda: nullcontext(controller_poll), clock) if controller_poll else None,
                         on_channel_invalidated=lambda client, channel: invalidations.append((client, channel)),
                         **({"on_control_revoked": revocations.append} if revocations is not None else {}))
        delayed = PauseDelivery(app, blocked_connection) if blocked else None
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
                yield Loopback(http, port, clock, observations, invalidations, delayed, command)
        finally:
            server.should_exit = True
            worker.join(5)
            if command:
                command.close()
            assert not worker.is_alive()


def event(channel: ClientConnection) -> dict:
    value = json.loads(channel.recv(timeout=4))
    validate("EventEnvelope", value)
    return value


def lease_event(channel: ClientConnection, state: str) -> dict:
    for _ in range(12):
        update = event(channel)
        if update["type"] == "snapshot" and update["payload"]["lease"]["state"] == state:
            return update
    raise AssertionError(f"Missing {state} lease snapshot")


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
        wait_for(app.http, "/health", first, simulation_ready)
        with app.open("/events", app.ticket(first, "events")) as initial:
            baseline = event(initial)
            assert baseline["event_seq"] == baseline["payload"]["event_seq"] == 1
            token = app.ticket(watcher, "events")
            with ThreadPoolExecutor(max_workers=1) as attempts:
                subscription = attempts.submit(app.open, "/events", token)
                app.observations.inference = False
                wait_for(app.http, "/health", first, lambda health: status(health, "AI") == "Unavailable")
                def failed_ai(channel: ClientConnection, latest: dict) -> dict:
                    for _ in range(12):
                        if (latest["type"] in ("snapshot", "readiness_changed")
                                and status(latest["payload"], "AI") == "Unavailable"):
                            return latest
                        following = event(channel)
                        assert following["event_seq"] == latest["event_seq"] + 1
                        latest = following
                    raise AssertionError("Missing AI readiness transition")

                changed = failed_ai(initial, baseline)
                assert changed["type"] == "readiness_changed"
                with subscription.result(timeout=5) as spectator:
                    fresh = failed_ai(spectator, event(spectator))
                    assert fresh["event_seq"] >= changed["event_seq"]
                    with app.open("/events", app.ticket(first, "events")) as replacement:
                        replaced = event(replacement)
                        assert replaced["event_seq"] >= changed["event_seq"]
                        assert status(replaced["payload"], "AI") == "Unavailable"
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


def simulation_ready(payload: dict) -> bool:
    return all(status(payload, name) == "Ready" for name in ("Storage", "RobotVideo", "Controller", "Command", "AI"))


def closed(channel: ClientConnection, code: int, *, drain: bool = False) -> None:
    with pytest.raises(ConnectionClosed) as error:
        channel.recv(timeout=4)
        if drain:
            while True:
                channel.recv(timeout=4)
    assert error.value.rcvd and error.value.rcvd.code == code


def acquire_body(boot: dict, *, takeover: bool = False) -> dict:
    return {"request_id": str(uuid4()), "client_id": boot["client_id"], "session_id": None, "takeover": takeover}


def acquire_control(laf: Loopback, boot: dict, *, takeover: bool = False) -> dict:
    response = laf.http.post(API + "/control-lease", headers=auth(boot), json=acquire_body(boot, takeover=takeover))
    assert response.status_code == 200
    validate("LeaseResponse", response.json())
    return response.json()


def heartbeat(boot: dict, lease: dict, seq: int, metadata: dict | None = None, **flags: object) -> dict:
    return {"type": "workspace_heartbeat", "protocol_version": 1, "backend_boot_id": boot["backend_boot_id"],
            "client_id": boot["client_id"], "client_lease_id": lease["client_lease_id"], "session_id": None,
            "control_generation": lease["control_generation"], "heartbeat_seq": seq,
            "workspace_visible": True, "workspace_focused": True, "workspace_operational": True,
            "displayed_robot_frame": {k: metadata[k] for k in ("frame_id", "stream_epoch")} if metadata else None,
            **flags}


def test_only_current_owner_display_and_fresh_selected_input_make_start_eligible(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        owner, spectator = laf.bootstrap(), laf.bootstrap()
        headers = auth(owner)
        wait_for(laf.http, "/health", headers)
        with (
            laf.open("/events", laf.ticket(headers, "events")) as events,
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video,
            laf.open("/events", laf.ticket(auth(spectator), "events")) as watching,
        ):
            event(events)
            event(watching)
            lease = acquire_control(laf, owner)
            assert lease["snapshot"]["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            events.send(json.dumps(heartbeat(owner, lease, 1)))
            null = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Workspace") == "Ready")
            assert status(null, "DisplayedRobotVideo") == "Unavailable"
            assert null["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            events.send(json.dumps(heartbeat(owner, lease, 2, frame(video)[0])))
            no_target = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
            assert no_target["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            events.send(json.dumps(heartbeat(owner, lease, 3, workspace_operational=False)))
            wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
            assert submit(laf.http, headers).status_code == 201
            lease = acquire_control(laf, owner, takeover=True)
            events.send(json.dumps(heartbeat(owner, lease, 1, frame(video)[0])))
            ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"]["Controller"])
            assert ready["readiness"]["can_start"] == {"Gestures": False, "Controller": True}
            assert ready["active_session"] is None and ready["runtime"]["motion_permission"] == "Disarmed"
            assert status(ready, "Webcam") == "Unavailable"
            spectator_state = laf.http.get(API + "/snapshot", headers=auth(spectator)).json()
            assert spectator_state["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            assert status(spectator_state, "DisplayedRobotVideo") == "Unavailable"
            laf.observations.webcam = True
            laf.observations.controller_sample = False
            events.send(json.dumps(heartbeat(owner, lease, 2, frame(video)[0])))
            selected = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"]["Gestures"])
            assert selected["readiness"]["can_start"] == {"Gestures": True, "Controller": False}
            laf.observations.gesture_sample = False
            events.send(json.dumps(heartbeat(owner, lease, 3, frame(video)[0])))
            unavailable = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Webcam") == "Unavailable")
            assert unavailable["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            events.send(json.dumps(heartbeat(owner, lease, 4, workspace_focused=False)))
            ended = wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
            assert ended["lease"]["control_generation"] > lease["control_generation"]
            assert status(ended, "DisplayedRobotVideo") == "Unavailable"


@pytest.mark.parametrize("invalid", ["sequence-start", "replay", "boot", "session", "generation", "secret",
                                     "other-robot", "webcam", "epoch", "unknown", "type"])
def test_heartbeat_rejects_replay_and_unissued_frames(tmp_path: Path, invalid: str) -> None:
    with service(tmp_path) as laf:
        owner, other = laf.bootstrap(), laf.bootstrap()
        headers = auth(owner)
        wait_for(laf.http, "/health", headers)
        other_frame = None
        if invalid == "other-robot":
            other_headers = auth(other)
            with laf.open("/video/robot", laf.ticket(other_headers, "robot-video")) as unrelated:
                other_frame = frame(unrelated)[0]
                frame(unrelated)
        with (
            laf.open("/events", laf.ticket(headers, "events")) as events,
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as robot,
        ):
            event(events)
            lease = acquire_control(laf, owner)
            metadata = frame(robot)[0]
            sent = heartbeat(owner, lease, 1, metadata)
            if invalid == "replay":
                events.send(json.dumps(sent))
                wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
            elif invalid == "other-robot":
                assert other_frame and other_frame["capture_seq"] < metadata["capture_seq"]
                sent = heartbeat(owner, lease, 1, other_frame)
            elif invalid == "webcam":
                laf.observations.webcam = True
                with laf.open("/video/webcam", laf.ticket(headers, "webcam-video")) as webcam:
                    sent = heartbeat(owner, lease, 1, frame(webcam)[0])
            elif invalid == "epoch":
                sent["displayed_robot_frame"]["stream_epoch"] = "old-epoch"
            elif invalid == "unknown":
                sent["displayed_robot_frame"]["frame_id"] = "unissued-frame"
            else:
                field, value = {
                    "sequence-start": ("heartbeat_seq", 2), "boot": ("backend_boot_id", "other-boot"),
                    "session": ("session_id", "other-session"), "generation": ("control_generation", 1),
                    "secret": ("client_lease_id", "x" * 43), "type": ("type", "direction"),
                }[invalid]
                sent[field] = value
            events.send(json.dumps(sent))
            closed(events, 1008, drain=True)
            snapshot = laf.http.get(API + "/snapshot", headers=headers).json()
            assert snapshot["lease"]["state"] == "Unowned"
            assert not snapshot["lease"]["can_acquire"]
            assert snapshot["runtime"]["motion_permission"] == "Disarmed"


def test_owner_only_revocation_on_replacement_and_expiry(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        owner, other = laf.bootstrap(), laf.bootstrap()
        headers, other_headers = auth(owner), auth(other)
        wait_for(laf.http, "/health", headers)
        with (
            laf.open("/events", laf.ticket(headers, "events")) as initial,
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video,
            laf.open("/events", laf.ticket(other_headers, "events")) as spectator,
        ):
            event(initial)
            event(spectator)
            first = acquire_control(laf, owner)
            spectator.send(json.dumps(heartbeat(owner, first, 1, frame(video)[0])))
            closed(spectator, 1008, drain=True)
            assert laf.http.get(API + "/snapshot", headers=headers).json()["lease"]["state"] == "Owned"
            with laf.open("/events", laf.ticket(headers, "events")) as replacement:
                revoked = event(replacement)["payload"]
                assert revoked["lease"]["state"] == "Unowned" and revoked["lease"]["can_acquire"]
                closed(initial, 1008, drain=True)
                second = acquire_control(laf, owner, takeover=True)
                replacement.send(json.dumps(heartbeat(owner, second, 1, frame(video)[0])))
                wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
                with laf.open("/video/robot", laf.ticket(headers, "robot-video")) as newer_video:
                    closed(video, 1008, drain=True)
                    cleared = laf.http.get(API + "/snapshot", headers=headers).json()
                    assert cleared["lease"]["state"] == "Unowned"
                    assert status(cleared, "DisplayedRobotVideo") == "Unavailable"
                    third = acquire_control(laf, owner, takeover=True)
                    replacement.send(json.dumps(heartbeat(owner, third, 1, frame(newer_video)[0])))
                    wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
                    laf.clock.offset += 0.4
                    # Socket remains connected. Observe independent expiry before making another HTTP request.
                    for _ in range(14):
                        expiry = event(replacement)
                        if (expiry["type"] == "snapshot" and expiry["payload"]["lease"]["state"] == "Unowned"
                                and expiry["payload"]["lease"]["control_generation"] > third["control_generation"]):
                            break
                    assert expiry["payload"]["lease"]["control_generation"] > third["control_generation"]


def test_repeated_acknowledgment_cannot_extend_old_robot_capture(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        boot = laf.bootstrap()
        headers = auth(boot)
        wait_for(laf.http, "/health", headers)
        with (
            laf.open("/events", laf.ticket(headers, "events")) as events,
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video,
        ):
            event(events)
            first = frame(video)[0]
            acquired = acquire_control(laf, boot)
            events.send(json.dumps(heartbeat(boot, acquired, 1, first)))
            wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
            for seq in range(2, 4):
                laf.clock.offset += 0.12
                events.send(json.dumps(heartbeat(boot, acquired, seq, first)))
                # The next observation provides a fresh frame, which is deliberately never acknowledged.
                frame(video)
            still_owned = laf.http.get(API + "/snapshot", headers=headers).json()
            assert still_owned["lease"]["state"] == "Owned"
            laf.clock.offset += 0.24
            expired = wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
            assert status(expired, "DisplayedRobotVideo") == "Unavailable"
            events.send(json.dumps(heartbeat(boot, acquired, 4, first)))
            closed(events, 1008, drain=True)


@pytest.mark.parametrize("source", ["missing", "invalid", "unknown-age"])
def test_unusable_robot_observation_revokes_even_with_old_display(tmp_path: Path, source: str) -> None:
    with service(tmp_path) as laf:
        boot = laf.bootstrap()
        headers = auth(boot)
        wait_for(laf.http, "/health", headers)
        with (
            laf.open("/events", laf.ticket(headers, "events")) as events,
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video,
        ):
            event(events)
            lease = acquire_control(laf, boot)
            events.send(json.dumps(heartbeat(boot, lease, 1, frame(video)[0])))
            wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "DisplayedRobotVideo") == "Ready")
            laf.observations.robot = source
            snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "RobotVideo") == "Unavailable")
            assert snapshot["lease"]["state"] == "Unowned"
            assert status(snapshot, "DisplayedRobotVideo") == "Unavailable"


@pytest.mark.parametrize("capacity", [1, 2])
def test_acquire_race_and_runtime_capacity_preserve_owner_and_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capacity: int,
) -> None:
    assert realtime.MAX_RUNTIME_RECEIPTS == 8192
    monkeypatch.setattr(realtime, "MAX_RUNTIME_RECEIPTS", capacity)
    with service(tmp_path) as laf:
        first, second = laf.bootstrap(), laf.bootstrap()
        wait_for(laf.http, "/health", auth(first))
        path = API + "/control-lease"
        with (
            laf.open("/events", laf.ticket(auth(first), "events")) as first_socket,
            laf.open("/events", laf.ticket(auth(second), "events")) as second_socket,
            ThreadPoolExecutor(max_workers=2) as threads,
        ):
            event(first_socket)
            event(second_socket)
            clients = (first, second)
            requests = [acquire_body(client) for client in clients]
            results = [threads.submit(laf.http.post, path, headers=auth(client), json=body)
                       for client, body in zip(clients, requests, strict=True)]
            responses = [result.result(timeout=3) for result in results]
            assert {response.status_code for response in responses} == {200, 403}
            winner = next(idx for idx, response in enumerate(responses) if response.status_code == 200)
            headers = auth(clients[winner])
            lease = responses[winner].json()
            assert responses[1 - winner].json()["code"] == "LEASE_OWNED"
            before = laf.http.get(API + "/snapshot", headers=headers).json()
            assert before["lease"]["owner_client_id"] == clients[winner]["client_id"]
            result = laf.http.post(path + "/release", headers=headers, json={
                "request_id": str(uuid4()), "client_id": clients[winner]["client_id"], "session_id": None,
                "client_lease_id": lease["client_lease_id"], "control_generation": lease["control_generation"],
            })
            if capacity == 1:
                assert (result.status_code, result.json()["code"], result.json()["permission_revoked"]) == (
                    503, "CAPACITY_REACHED", True,
                )
            else:
                assert result.status_code == 200
                assert not result.json()["lease"]["can_acquire"]
            spectator = (first_socket, second_socket)[1 - winner]
            while True:
                update = event(spectator)
                if (update["type"] == "snapshot"
                        and update["payload"]["lease"]["control_generation"] > lease["control_generation"]):
                    break
            assert update["payload"]["lease"]["state"] == "Unowned"
            assert not update["payload"]["lease"]["can_acquire"]
            attempt = laf.http.post(path, headers=headers, json=acquire_body(clients[winner], takeover=True))
            assert (attempt.status_code, attempt.json()["code"]) == (503, "CAPACITY_REACHED")
            replay = laf.http.post(path, headers=headers, json=requests[winner]).json()
            assert replay["client_lease_id"] == lease["client_lease_id"]
            assert replay["snapshot"]["lease"]["state"] == "Unowned"


def test_client_capacity_preserves_connected_clients(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        owner = laf.bootstrap()
        wait_for(laf.http, "/health", auth(owner))
        with laf.open("/events", laf.ticket(auth(owner), "events")) as events:
            event(events)
            idle = [laf.bootstrap() for _ in range(63)]
            overflow = laf.http.get(API + "/bootstrap", headers={"Origin": ORIGIN})
            assert (overflow.status_code, overflow.json()["code"]) == (503, "CAPACITY_REACHED")
            laf.clock.offset += 1801
            assert laf.http.get(API + "/snapshot", headers=auth(idle[0])).json()["code"] == "CLIENT_INVALID"
            assert laf.bootstrap()["client_id"] not in {client["client_id"] for client in idle}
            assert laf.http.get(API + "/snapshot", headers=auth(owner)).json()["lease"]["can_acquire"]


def test_current_active_session_requires_matching_identity_and_takeover(tmp_path: Path) -> None:
    revocations: list[Revocation] = []
    with service(tmp_path, revocations=revocations) as laf:
        owner, other = laf.bootstrap(), laf.bootstrap()
        headers = auth(owner)
        wait_for(laf.http, "/health", headers)
        registered = submit(laf.http, headers)
        assert registered.status_code == 201
        obj = registered.json()["result"]["object"]
        # Seed an active session independently of Start to exercise takeover without setup readiness.
        with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("INSERT INTO sessions VALUES ('active', ?, 'Controller', 'Searching', ?, NULL, NULL, '[]', 1)",
                       (obj["id"], obj["registered_at_ms"]))
        path = API + "/control-lease"
        body = acquire_body(owner)
        assert laf.http.post(path, headers=headers, json=body).json()["code"] == "NOT_READY"
        with laf.open("/events", laf.ticket(headers, "events")) as events:
            assert event(events)["payload"]["active_session"]["id"] == "active"
            assert laf.http.post(path, headers=headers, json=body).json()["code"] == "OWNERSHIP_MISMATCH"
            body["session_id"] = "active"
            assert laf.http.post(path, headers=headers, json=body).json()["code"] == "INVALID_TRANSITION"
            result = laf.http.post(path, headers=headers, json={**body, "takeover": True})
            assert result.status_code == 200
            lease = result.json()
            release = {"request_id": str(uuid4()), "client_id": owner["client_id"], "session_id": "active",
                       "client_lease_id": lease["client_lease_id"], "control_generation": lease["control_generation"]}
            response = laf.http.post(path + "/release", headers=auth(other), json={**release, "client_id": other["client_id"]})
            assert response.json()["code"] == "LEASE_REQUIRED"
            response = laf.http.post(path + "/release", headers=headers, json={**release, "session_id": None})
            assert response.json()["code"] == "OWNERSHIP_MISMATCH"
            response = laf.http.post(path + "/release", headers=headers, json=release)
            assert response.status_code == 200, response.text
            validate("LeaseResponse", response.json())
            snapshot = response.json()["snapshot"]
            assert snapshot["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            assert snapshot["lease"]["state"] == "Unowned"
            assert snapshot["active_session"]["state"] == "Paused"
            assert snapshot["runtime"]["effective_session_state"] == "Paused"
            assert snapshot["runtime"]["motion_permission"] == "Disarmed"
            assert not snapshot["runtime"]["persistence_pending"]
            retry = laf.http.post(path + "/release", headers=headers, json=release)
            assert retry.status_code == 200 and retry.json()["snapshot"]["active_session"] == snapshot["active_session"]
            assert revocations == [Revocation(owner["client_id"], "active", snapshot["runtime"]["control_generation"],
                                             "Released", release["request_id"])]
            wait_for(laf.http, "/health", headers, lambda health: status(health, "Controller") == "Ready")
            acquired = laf.http.post(path, headers=headers, json={**body, "request_id": str(uuid4()), "takeover": True})
            assert acquired.status_code == 200
            laf.observations.controller_sample = False
            unavailable = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Controller") == "Unavailable")
            assert unavailable["lease"]["state"] == "Unowned"
            assert revocations[-1] == Revocation(owner["client_id"], "active", unavailable["runtime"]["control_generation"],
                                                 "InputUnavailable", None)


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

def test_saved_search_lifecycle_and_historical_retry(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        owner = laf.bootstrap()
        headers = auth(owner)
        wait_for(laf.http, "/health", headers)
        target = submit(laf.http, headers).json()["result"]["object"]
        with laf.open("/events", laf.ticket(headers, "events")) as events, \
                laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video:
            event(events)
            lease = acquire_control(laf, owner)
            events.send(json.dumps(heartbeat(owner, lease, 1, frame(video)[0])))
            wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"]["Controller"])
            start = {"action_id": str(uuid4()), "object_id": target["id"], "control_mode": "Controller",
                     "expected_revision": target["revision"], "client_id": owner["client_id"],
                     "client_lease_id": lease["client_lease_id"]}
            created = laf.http.post(API + "/sessions", headers=headers, json=start)
            assert created.status_code == 201, created.text
            session = created.json()["result"]["session"]
            assert session["revision"] == 1 and session["state"] == "Searching"
            path = created.headers["location"]
            assert path == API + "/sessions/" + session["id"]
            wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"] == session)
            actions = {"session_id": session["id"], "expected_revision": 1, "action": "pause",
                       "client_id": owner["client_id"], "client_lease_id": lease["client_lease_id"]}
            paused = laf.http.post(path + "/actions", headers=headers, json={**actions, "action_id": str(uuid4())})
            assert paused.status_code == 200, paused.text
            saved_pause = paused.json()["result"]["session"]
            assert saved_pause["revision"] == 2
            assert saved_pause["pause_causes"] == [{"cause": "ManualPause", "failure_id": None}]
            actions["expected_revision"] = 2
            noop = laf.http.post(path + "/actions", headers=headers, json={**actions, "action_id": str(uuid4())})
            assert noop.json()["result"]["session"] == saved_pause
            stop = {**actions, "action": "stop", "action_id": str(uuid4())}
            ended = laf.http.post(path + "/actions", headers=headers, json=stop)
            assert ended.status_code == 200, ended.text
            assert ended.json()["result"]["session"]["end_reason"] == "Stopped"
            assert ended.json()["result"]["session"]["revision"] == 3
            assert laf.http.post(path + "/actions", headers=headers, json=stop).json() == ended.json()
            another = laf.bootstrap()
            retry = laf.http.post(API + "/sessions", headers=auth(another), json={
                **start, "client_id": another["client_id"], "client_lease_id": "x" * 43,
            })
            assert retry.status_code == 201 and retry.content == created.content and retry.headers["location"] == path
            current = laf.http.get(API + "/objects/" + target["id"], headers=headers).json()
            assert current["revision"] == target["revision"] and current["status"] == "Lost"

            completions, last_sequence = [], None
            while len(completions) < 4:
                update = event(events)
                if last_sequence is not None:
                    assert update["event_seq"] == last_sequence + 1
                last_sequence = update["event_seq"]
                operation = update["payload"].get("operation")
                if update["type"] == "session_changed" and operation and operation["persistence"] == "Committed":
                    assert update["session_id"] == session["id"]
                    completions.append((operation["action_id"], update["session_revision"]))
            assert completions == [(response.json()["action_id"], revision) for response, revision in
                                   zip((created, paused, noop, ended), (1, 2, 2, 3), strict=True)]


@contextmanager
def ready_search(
    laf: Loopback, mode: str = "Controller", acquired: dict | None = None, *, takeover: bool = False,
    target: dict | None = None,
) -> Iterator[tuple[dict, dict, ClientConnection, ClientConnection]]:
    owner = laf.bootstrap()
    headers = auth(owner)
    wait_for(laf.http, "/health", headers)
    if target is None:
        target = submit(laf.http, headers, submitted=owner.get("server_time_ms")).json()["result"]["object"]
    with laf.open("/events", laf.ticket(headers, "events")) as events, \
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video:
        event(events)
        lease = acquire_control(laf, owner, takeover=takeover)
        if acquired is not None:
            acquired.update(lease)
        events.send(json.dumps(heartbeat(owner, lease, 1, frame(video)[0])))
        if acquired is None:
            wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"][mode])
        start = {"action_id": str(uuid4()), "object_id": target["id"], "control_mode": mode,
                 "expected_revision": target["revision"], "client_id": owner["client_id"],
                 "client_lease_id": lease["client_lease_id"]}
        yield owner, start, events, video


class WorkspaceDriver:
    def __init__(self, owner: dict, lease: dict, events: ClientConnection, video: ClientConnection):
        self.owner, self.lease, self.events, self.video = owner, lease, events, video
        self.session: dict = {}
        self.flags: dict[str, object] = {}
        self.freeze = False
        self.latest: dict | None = None
        self.received_frames: deque[dict] = deque(maxlen=24)
        self.stop = Event()
        self.messages: Queue[dict] = Queue(128)

    def observe_events(self) -> None:
        while not self.stop.is_set():
            try:
                message = json.loads(self.events.recv(timeout=0.1))
            except TimeoutError:
                continue
            except ConnectionClosed:
                return
            if message["type"] == "snapshot":
                public = message["payload"]["lease"]
                if public["owner_client_id"] == self.owner["client_id"]:
                    self.lease["control_generation"] = public["control_generation"]
            try:
                self.messages.put_nowait(message)
            except Full:
                try:
                    self.messages.get_nowait()
                except Empty:
                    pass
                self.messages.put_nowait(message)

    def run(self) -> None:
        seq = 2
        while not self.stop.is_set():
            try:
                latest = frame(self.video)[0]
                self.received_frames.append(latest)
                if not self.freeze or self.latest is None:
                    self.latest = latest
                self.events.send(json.dumps(heartbeat(
                    self.owner, self.lease, seq, self.latest, session_id=self.session.get("id"), **self.flags,
                )))
                seq += 1
            except (ConnectionClosed, TimeoutError):
                return


@contextmanager
def driving_search(
    laf: Loopback, mode: str = "Controller", *, takeover: bool = False,
    target: dict | None = None,
) -> Iterator[tuple[dict, WorkspaceDriver]]:
    laf.observations.webcam = mode == "Gestures"
    lease: dict = {}
    with ready_search(laf, mode, lease, takeover=takeover, target=target) as (owner, start, events, video):
        headers = auth(owner)
        driver = WorkspaceDriver(owner, lease, events, video)
        worker = Thread(target=driver.run, daemon=True)
        observer = Thread(target=driver.observe_events, daemon=True)
        worker.start()
        observer.start()
        try:
            wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"][mode])
            result = laf.http.post(API + "/sessions", headers=headers, json=start)
            if result.status_code == 202:
                wait_for(laf.http, "/snapshot", headers, lambda state: state["active_session"] is not None)
                result = laf.http.post(API + "/sessions", headers=headers, json=start)
            assert result.status_code == 201, result.text
            driver.session = result.json()["result"]["session"]
            yield headers, driver
        finally:
            driver.stop.set()
            video.close()
            worker.join(2)
            observer.join(2)


def wait_output(laf: Loopback, expected: Direction | None) -> None:
    assert laf.command is not None
    until = monotonic() + 3
    while monotonic() < until:
        if laf.command.output == expected:
            return
        sleep(0.005)
    assert laf.command.output == expected, laf.command.journal


def search_action(laf: Loopback, headers: dict, driver: WorkspaceDriver, action: str, revision: int, **extra):
    session = driver.session["id"]
    return laf.http.post(f"{API}/sessions/{session}/actions", headers=headers, json={
        "action_id": str(uuid4()), "session_id": session, "expected_revision": revision, "action": action,
        "client_id": driver.owner["client_id"], "client_lease_id": driver.lease["client_lease_id"], **extra,
    })


@contextmanager
def recover_workspace(laf: Loopback, session: dict) -> Iterator[tuple[dict, WorkspaceDriver]]:
    owner = laf.bootstrap()
    headers = auth(owner)
    with laf.open("/events", laf.ticket(headers, "events")) as events, \
            laf.open("/video/robot", laf.ticket(headers, "robot-video")) as video:
        assert event(events)["payload"]["active_session"]["id"] == session["id"]
        acquisition = {**acquire_body(owner), "session_id": session["id"]}
        denied = laf.http.post(API + "/control-lease", headers=headers, json=acquisition)
        assert denied.status_code == 409 and denied.json()["code"] == "INVALID_TRANSITION"
        accepted = laf.http.post(API + "/control-lease", headers=headers, json={**acquisition, "takeover": True})
        assert accepted.status_code == 200, accepted.text
        lease = accepted.json()
        driver = WorkspaceDriver(owner, lease, events, video)
        driver.session = session
        events.send(json.dumps(heartbeat(owner, lease, 1, frame(video)[0], session_id=session["id"])))
        worker = Thread(target=driver.run, daemon=True)
        observer = Thread(target=driver.observe_events, daemon=True)
        worker.start()
        observer.start()
        try:
            wait_for(laf.http, "/snapshot", headers, lambda state: status(state, "DisplayedRobotVideo") == "Ready")
            yield headers, driver
        finally:
            driver.stop.set()
            video.close()
            worker.join(2)
            observer.join(2)


def test_manual_resume_requires_fresh_neutral_and_keeps_the_saved_search(tmp_path: Path) -> None:
    with service(tmp_path) as laf, driving_search(laf, "Gestures") as (headers, driver):
        arm(laf, headers, "Gestures")
        pause_id = str(uuid4())
        pause = search_action(laf, headers, driver, "pause", 1, action_id=pause_id)
        if pause.status_code == 202:
            wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
            pause = search_action(laf, headers, driver, "pause", 1, action_id=pause_id)
        assert pause.status_code == 200, pause.text
        wait_output(laf, None)
        wait_for(laf.http, "/snapshot", headers, lambda state: state["readiness"]["can_resume"])
        action_id = str(uuid4())
        response = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
        if response.status_code == 202:
            wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["revision"] == 3)
            response = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
        assert response.status_code == 200, response.text
        resumed = {**driver.session, "state": "Searching", "revision": 3, "pause_causes": []}
        assert response.json()["result"]["session"] == resumed
        assert laf.http.get(f"{API}/sessions/{resumed['id']}", headers=headers).json() == resumed
        previous_sequence = None
        while True:
            update = driver.messages.get(timeout=3)
            if previous_sequence is not None:
                assert update["event_seq"] == previous_sequence + 1
            previous_sequence = update["event_seq"]
            operation = update["payload"].get("operation")
            if update["type"] == "session_changed" and operation and operation["action_id"] == action_id and (
                operation["persistence"] == "Committed"
            ):
                validate("EventEnvelope", update)
                assert update["session_revision"] == 3 and update["payload"]["session"] == resumed
                break
        since_pause = len(laf.command.journal)
        for fingers, hands in ((1, 1), (5, 1), (0, 0), (0, 2), (1, 1)):
            laf.observations.fingers, laf.observations.hands = fingers, hands
            sleep(0.25)
            assert laf.command.output is None
        assert all(entry.output is None for entry in laf.command.journal[since_pause:])
        assert search_action(laf, headers, driver, "resume", 2, action_id=action_id).content == response.content
        laf.observations.fingers = 0
        arm(laf, headers, "Gestures")


def test_recovery_reconciles_independent_occurrences_in_both_orders(tmp_path: Path) -> None:
    with service(tmp_path) as laf, driving_search(laf) as (old_headers, old_driver):
        arm(laf, old_headers)
        laf.observations.inference = False
        laf.observations.command = False
        paused = wait_for(laf.http, "/snapshot", old_headers, lambda state:
                          len(state["active_session"]["pause_causes"]) == 2)["active_session"]
        with recover_workspace(laf, paused) as (headers, driver):
            def snapshot(check=lambda _: True):
                return wait_for(laf.http, "/snapshot", headers, check)

            before = snapshot()
            ids = {f["cause"]: f["failure_id"] for f in before["failures"]}
            ai, command = ids["AIUnavailable"], ids["CommandUnavailable"]
            revision = paused["revision"]
            assert search_action(laf, old_headers, old_driver, "acknowledge", revision,
                                 failure_ids=[ai]).json()["code"] == "LEASE_REQUIRED"
            for invalid in ([], [ai, ai], [str(uuid4()) for _ in range(65)]):
                assert search_action(laf, headers, driver, "acknowledge", revision, failure_ids=invalid).status_code == 422
            assert search_action(laf, headers, driver, "acknowledge", revision,
                                 failure_ids=[uuid4().hex]).json()["code"] == "NOT_FOUND"
            assert search_action(laf, headers, driver, "acknowledge", revision - 1,
                                 failure_ids=[ai]).json()["code"] == "REVISION_CONFLICT"
            assert search_action(laf, headers, driver, "pause", revision).json()["result"]["session"] == paused
            acknowledged = search_action(laf, headers, driver, "acknowledge", revision, failure_ids=[ai])
            assert acknowledged.status_code == 200, acknowledged.text
            assert acknowledged.json()["result"]["session"]["revision"] == revision + 1
            assert search_action(laf, headers, driver, "resume", revision + 1).json()["code"] == "RECOVERY_REQUIRED"
            assert {f["failure_id"]: (f["restored"], f["acknowledged"]) for f in snapshot()["failures"]} == {
                ai: (False, True), command: (False, False),
            }

            laf.observations.command = True
            restored = snapshot(lambda s: s["active_session"]["revision"] == revision + 2)
            assert not restored["readiness"]["can_resume"]
            assert next(f for f in restored["failures"] if f["failure_id"] == command)["restored"]
            action_id = str(uuid4())
            both = search_action(laf, headers, driver, "acknowledge", revision + 2,
                                 action_id=action_id, failure_ids=[command, ai])
            assert both.status_code == 200, both.text
            assert both.json()["result"]["session"]["pause_causes"] == paused["pause_causes"]
            assert [f["failure_id"] for f in snapshot()["failures"]] == [ai]
            retry = search_action(laf, headers, driver, "acknowledge", revision + 2,
                                  action_id=action_id, failure_ids=[ai, command])
            assert retry.content == both.content

            laf.observations.inference = True
            ready = snapshot(lambda s: s["readiness"]["can_resume"])
            assert ready["active_session"]["revision"] == revision + 4 and ready["failures"] == []
            no_op = search_action(laf, headers, driver, "acknowledge", revision + 4, failure_ids=[ai, command])
            assert no_op.json()["result"]["session"] == ready["active_session"]
            assert laf.command.output is None

            laf.observations.inference = False
            recurrent = snapshot(lambda s: s["active_session"]["revision"] == revision + 5)
            [failure] = recurrent["failures"]
            assert failure["cause"] == "AIUnavailable" and failure["failure_id"] != ai
            assert not failure["acknowledged"] and not recurrent["readiness"]["can_resume"]



@pytest.mark.parametrize(("barrier", "interruption"), [
    ("before_resume_commit", "pause"),
    ("before_resume_commit", "stop"),
    ("before_resume_commit", "storage"),
    ("before_resume_commit", "inference"),
    ("before_resume_commit", "historical-pause"),
    ("after_resume_commit", "pause"),
    ("after_resume_commit", "stop"),
    ("after_resume_commit", "camera"),
    ("after_resume_commit", "emergency"),
])
def test_pending_resume_yields_to_safety(tmp_path: Path, barrier: str, interruption: str) -> None:
    entered, release = Event(), Event()
    block_inference, release_inference = Event(), Event()

    def checkpoint(point):
        if point == barrier:
            entered.set()
            assert release.wait(5)
            if interruption == "storage":
                raise OSError("Simulated writer unavailable")

    def inference(_sample: InferenceSample) -> bool:
        if block_inference.is_set():
            assert release_inference.wait(5)
        return True

    with service(tmp_path, checkpoint=checkpoint, inference=inference if interruption == "inference" else None) as laf, \
            driving_search(laf) as (headers, driver):
        arm(laf, headers)
        assert search_action(laf, headers, driver, "pause", 1).status_code == 200
        wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_resume"])
        action_id = str(uuid4())
        if interruption == "historical-pause":
            pause_id = str(uuid4())
            historical = search_action(laf, headers, driver, "pause", 2, action_id=pause_id)
            for _ in range(65):
                assert search_action(laf, headers, driver, "pause", 2).status_code == 200
        try:
            pending = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
            assert entered.is_set() and pending.status_code == 202, pending.text
            identical = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
            if barrier == "before_resume_commit":
                assert identical.content == pending.content
            else:
                assert identical.json()["persistence"] == "Committed"
            changed = search_action(laf, headers, driver, "resume", 1, action_id=action_id)
            assert changed.status_code == 409 and changed.json()["code"] == "ACTION_ID_CONFLICT"

            if interruption in ("pause", "stop"):
                safety = search_action(laf, headers, driver, interruption, 2)
                assert safety.status_code == 202, safety.text
            elif interruption == "camera":
                laf.observations.robot = "missing"
                wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
            elif interruption == "inference":
                block_inference.set()
                wait_for(laf.http, "/snapshot", headers, lambda s:
                         any(failure["cause"] == "AIUnavailable" for failure in s["failures"]))
                release_inference.set()
                wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "AI") == "Ready")
            elif interruption == "emergency":
                emergency = laf.http.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
                assert emergency.status_code == 202 and emergency.json()["permission_revoked"]
            elif interruption == "historical-pause":
                assert search_action(laf, headers, driver, "pause", 2, action_id=pause_id).content == historical.content
            halted = wait_for(laf.http, "/snapshot", headers)
            assert halted["runtime"]["effective_session_state"] == "Paused"
            assert halted["runtime"]["motion_permission"] == "Disarmed"
            assert laf.command.output is None
        finally:
            release_inference.set()
            release.set()

        def completed(state):
            return next((operation for operation in state["operations"] if operation["action_id"] == action_id
                         and operation["persistence"] != "Pending"), None)

        terminal = wait_for(laf.http, "/snapshot", headers, completed)
        completion = completed(terminal)
        path = "/sessions/" + driver.session["id"]
        if interruption == "historical-pause":
            assert completion["persistence"] == "Committed"
            searching = wait_for(laf.http, path, headers)
            assert searching["state"] == "Searching" and searching["revision"] == 3
        elif barrier == "after_resume_commit":
            assert completion["persistence"] == "Committed"
            state = "Ended" if interruption == "stop" else "Paused"
            durable = wait_for(laf.http, path, headers, lambda s: s["state"] == state and s["revision"] >= 4)
            if interruption in ("pause", "stop"):
                assert durable["revision"] == 4
            retry = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
            assert retry.content == identical.content
            final = wait_for(laf.http, "/snapshot", headers, lambda s:
                             s["active_session"] == (None if state == "Ended" else durable))
            assert final["runtime"]["motion_permission"] == "Disarmed"
            if interruption != "pause":
                assert final["lease"]["state"] == "Unowned"
        else:
            assert completion["persistence"] == "Failed"
            error = {"storage": "STORAGE_UNAVAILABLE", "inference": "LEASE_EXPIRED"}.get(interruption, "INVALID_TRANSITION")
            assert completion["error"]["code"] == error
            if interruption == "stop":
                wait_for(laf.http, path, headers, lambda s: s["state"] == "Ended")
            elif interruption == "inference":
                wait_for(laf.http, path, headers, lambda s:
                         s["revision"] >= 3 and s["state"] == "Paused" and len(s["pause_causes"]) == 2)
            else:
                durable = wait_for(laf.http, path, headers)
                assert durable["state"] == "Paused" and durable["revision"] == 2
            if interruption == "pause":
                for _ in range(65):
                    assert search_action(laf, headers, driver, "pause", 2).status_code == 200
                assert not completed(wait_for(laf.http, "/snapshot", headers))
                retry = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
                assert retry.json()["persistence"] == "Failed"
                assert retry.json()["error"]["code"] == "INVALID_TRANSITION"
        assert laf.command.output is None


def test_pause_overtakes_resume_still_checking_its_receipt(tmp_path: Path, monkeypatch) -> None:
    entered, release = Event(), Event()
    inspect = sessions.inspect_search

    def inspect_with_barrier(storage, request, fingerprint, **options):
        if request.action == "resume" and not options.get("transition"):
            entered.set()
            assert release.wait(5)
        return inspect(storage, request, fingerprint, **options)

    monkeypatch.setattr(sessions, "inspect_search", inspect_with_barrier)
    with service(tmp_path) as laf, driving_search(laf) as (headers, driver):
        assert search_action(laf, headers, driver, "pause", 1).status_code == 200
        ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_resume"])
        with ThreadPoolExecutor(max_workers=2) as requests:
            resume = requests.submit(search_action, laf, headers, driver, "resume", 2)
            try:
                assert entered.wait(3)
                pause = requests.submit(search_action, laf, headers, driver, "pause", 2)
                wait_for(laf.http, "/snapshot", headers, lambda s: s["event_seq"] > ready["event_seq"])
            finally:
                release.set()
            rejected = resume.result(timeout=3)
            assert rejected.status_code == 503 and rejected.json()["code"] == "NOT_READY"
            assert pause.result(timeout=3).status_code == 200
        saved = wait_for(laf.http, "/sessions/" + driver.session["id"], headers)
        assert saved["state"] == "Paused" and saved["revision"] == 2


def test_recovered_resume_commit_waits_for_stop_admission(tmp_path: Path, monkeypatch) -> None:
    commit, release_commit, receipt = Event(), Event(), Event()
    stop_lookup, release_stop = Event(), Event()
    inspect = sessions.inspect_search

    def checkpoint(point):
        if point == "after_resume_commit":
            commit.set()
            assert release_commit.wait(5)
            raise OSError("Simulated error after SQLite committed")

    def inspect_with_barrier(storage, request, fingerprint, **options):
        if request.action == "stop" and not options.get("transition"):
            stop_lookup.set()
            assert release_stop.wait(5)
        result = inspect(storage, request, fingerprint, **options)
        if request.action == "resume" and commit.is_set() and result[0] is not None:
            receipt.set()
        return result

    monkeypatch.setattr(sessions, "inspect_search", inspect_with_barrier)
    with service(tmp_path, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        assert search_action(laf, headers, driver, "pause", 1).status_code == 200
        ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_resume"])
        action_id = str(uuid4())
        with ThreadPoolExecutor(max_workers=1) as requests:
            try:
                assert search_action(laf, headers, driver, "resume", 2, action_id=action_id).status_code == 202
                assert commit.is_set()
                stop = requests.submit(search_action, laf, headers, driver, "stop", 2)
                assert stop_lookup.wait(3)
                release_commit.set()
                assert receipt.wait(3)
                sleep(0.2)
                guarded = wait_for(laf.http, "/snapshot", headers)
                assert guarded["active_session"]["revision"] == 2
                assert guarded["runtime"]["motion_permission"] == "Disarmed"
                assert guarded["lease"]["control_generation"] == ready["lease"]["control_generation"]
            finally:
                release_commit.set()
                release_stop.set()
            ended = stop.result(timeout=3)
            assert ended.status_code == 200, ended.text
            assert ended.json()["result"]["session"]["revision"] == 4
        retry = search_action(laf, headers, driver, "resume", 2, action_id=action_id)
        assert retry.status_code == 200 and retry.json()["result"]["session"]["revision"] == 3
        assert laf.command.output is None


def test_acknowledgment_rejects_a_failure_from_another_saved_search(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        with driving_search(laf) as (headers, driver):
            emergency = laf.http.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
            assert emergency.status_code in (200, 202), emergency.text
            failure_id = emergency.json()["failure_id"]
            paused = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
            with recover_workspace(laf, driver.session) as (owner, recovered):
                settled = wait_for(laf.http, "/snapshot", owner, lambda s: s["failures"][0]["restored"] and
                                   s["active_session"]["revision"] > paused["active_session"]["revision"])
                stopped = search_action(laf, owner, recovered, "stop", settled["active_session"]["revision"])
                assert stopped.status_code in (200, 202), stopped.text
                wait_for(laf.http, f"/sessions/{driver.session['id']}", owner, lambda session: session["state"] == "Ended")
        with driving_search(laf, takeover=True) as (headers, driver):
            rejected = search_action(laf, headers, driver, "acknowledge", 1, failure_ids=[failure_id])
            assert rejected.status_code == 409 and rejected.json()["code"] == "OWNERSHIP_MISMATCH"


def test_pending_review_blocks_resume_even_with_current_control(tmp_path: Path) -> None:
    with service(tmp_path) as laf, driving_search(laf) as (headers, driver):
        assert search_action(laf, headers, driver, "pause", 1).status_code == 200
        session = driver.session
        with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            insert_match(db, tmp_path, "pending-match", session["id"], session["object_id"],
                         session["started_at_ms"], "Pending", None, captured_png())
        blocked = search_action(laf, headers, driver, "resume", 2)
        assert blocked.status_code == 409 and blocked.json()["code"] == "PENDING_REVIEW"
        assert laf.command.output is None


def test_presession_failure_settles_without_a_session_action(tmp_path: Path) -> None:
    with service(tmp_path) as laf, ready_search(laf) as (owner, _, events, _):
        headers = auth(owner)
        baseline = wait_for(laf.http, "/snapshot", headers)
        laf.observations.command = False
        diagnostic = wait_for(laf.http, "/snapshot", headers, lambda s: bool(s["failures"]))
        assert lease_event(events, "Unowned")["payload"]["active_session"] is None
        [failure] = diagnostic["failures"]
        assert failure["cause"] == "CommandUnavailable" and failure["session_id"] is None
        laf.observations.command = True
        settled = wait_for(laf.http, "/snapshot", headers, lambda s: s["failures"] == [])
        assert settled["active_session"] is None and settled["operations"] == baseline["operations"]


def arm(laf: Loopback, headers: dict, mode: str = "Controller") -> None:
    wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
    if mode == "Gestures":
        laf.observations.fingers = 1
    else:
        laf.observations.dpad = ("forward",)
    wait_output(laf, "forward")


def assert_stopped(laf: Loopback, cause: str) -> None:
    wait_output(laf, None)
    assert laf.command is not None
    until = monotonic() + 1
    while laf.command.journal[-1].event != "stop" and monotonic() < until:
        sleep(0.005)
    revoked, stopped = laf.command.journal[-2:]
    assert (revoked.event, revoked.cause, stopped.event, stopped.output) == ("revoked", cause, "stop", None)
    assert revoked.at <= stopped.at
    assert any(entry.event == "renewed" and entry.output is not None and entry.at <= revoked.at
               for entry in laf.command.journal[:-2])


def test_motion_generation_requires_a_post_rotation_display(tmp_path: Path) -> None:
    lease: dict = {}
    with service(tmp_path) as laf, ready_search(laf, acquired=lease) as (owner, start, events, video):
        headers = auth(owner)
        wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"]["Controller"])
        result = laf.http.post(API + "/sessions", headers=headers, json=start)
        assert result.status_code == 201, result.text
        session = result.json()["result"]["session"]["id"]
        old_frame = frame(video)[0]
        events.send(json.dumps(heartbeat(owner, lease, 2, old_frame, session_id=session)))
        for _ in range(12):
            update = event(events)
            if update["type"] == "snapshot" and (
                update["payload"]["runtime"]["control_generation"] > lease["control_generation"]
            ):
                break
        generation = update["payload"]["runtime"]["control_generation"]
        assert generation > lease["control_generation"]
        lease["control_generation"] = generation
        events.send(json.dumps(heartbeat(owner, lease, 3, None, session_id=session)))
        events.send(json.dumps(heartbeat(owner, lease, 4, old_frame, session_id=session)))
        wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Workspace") == "Ready")
        current = laf.http.get(API + "/snapshot", headers=headers).json()
        assert status(current, "DisplayedRobotVideo") == "Unavailable"
        assert current["runtime"]["motion_permission"] == "Disarmed"
        recent = frame(video)[0]
        while recent["capture_seq"] < old_frame["capture_seq"] + 3:
            recent = frame(video)[0]
        events.send(json.dumps(heartbeat(owner, lease, 5, recent, session_id=session)))
        wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")


@pytest.mark.parametrize("mode", ["Gestures", "Controller"])
def test_neutral_fresh_hold_and_release_drive_the_same_sink(tmp_path: Path, mode: str) -> None:
    with service(tmp_path) as laf:
        laf.observations.fingers = 1
        laf.observations.dpad = ("forward",)
        with driving_search(laf, mode) as (headers, driver):
            lease_at_start = driver.lease["control_generation"]
            for _ in range(3):
                sleep(0.09)
                assert laf.command.output is None
            if mode == "Controller":
                assert not laf.observations.webcam
            for fingers, direction in enumerate(("forward", "backward", "left", "right"), start=1):
                if mode == "Gestures":
                    laf.observations.fingers = 0
                else:
                    laf.observations.dpad = ()
                wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
                if mode == "Gestures":
                    laf.observations.fingers = fingers
                else:
                    laf.observations.dpad = (direction,)
                wait_output(laf, direction)
                if mode == "Gestures":
                    laf.observations.fingers = 5
                else:
                    laf.observations.dpad = ("left", "right")
                assert_stopped(laf, "InputInvalid")
                if mode == "Gestures":
                    laf.observations.fingers = fingers
                else:
                    laf.observations.dpad = (direction,)
                sleep(0.15)
                assert laf.command.output is None
            laf.observations.fingers, laf.observations.dpad = 0, ()
            arm(laf, headers, mode)
            laf.observations.fingers, laf.observations.dpad = 0, ()
            assert_stopped(laf, "InputReleased")
            current = laf.http.get(API + "/snapshot", headers=headers).json()
            assert current["active_session"] == driver.session and current["failures"] == []
            assert current["runtime"]["control_generation"] > lease_at_start


@pytest.mark.parametrize("loss", ["unplug", "stalled poll", "frozen reports", "browser focus"])
def test_selected_dualshock_uses_shared_motion_and_recovery(tmp_path: Path, loss: str) -> None:
    devices = [device(1, 14), device(2, 11, serial="01-23-45-67-89-ab")]
    stall, entered, release = Event(), Event(), Event()
    freeze = Event()
    captured = ()

    def poll():
        nonlocal captured
        if not freeze.is_set():
            captured = fresh_reports(devices)
        if stall.is_set():
            entered.set()
            assert release.wait(5)
        return captured

    with service(tmp_path, controller_poll=poll) as laf, driving_search(laf) as (headers, driver):
        try:
            assert status(laf.http.get(API + "/snapshot", headers=headers).json(), "Webcam") == "Unavailable"
            sleep(0.15)
            assert laf.command.output is None
            for button, direction in ((11, "forward"), (12, "backward"), (13, "left"), (14, "right")):
                devices[0] = device(1)
                wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
                devices[0] = device(1, button)
                wait_output(laf, direction)
                devices[0] = device(1, 11, 14)
                assert_stopped(laf, "InputInvalid")
                devices[0] = device(1, button)
                sleep(0.08)
                assert laf.command.output is None

            devices[0] = device(1)
            wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
            devices[0] = device(1, 13)
            wait_output(laf, "left")
            devices[0] = device(1)
            assert_stopped(laf, "InputReleased")
            wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
            devices[0] = device(1, 11)
            wait_output(laf, "forward")

            if loss == "unplug":
                devices.pop(0)
            elif loss == "stalled poll":
                stall.set()
                assert entered.wait(2)
            elif loss == "frozen reports":
                freeze.set()
            else:
                driver.flags = {"workspace_focused": False}
            cause = "WorkspaceUnfocused" if loss == "browser focus" else "InputUnavailable"
            assert_stopped(laf, cause)
            snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
            assert status(snapshot, "Controller") == ("Ready" if loss == "browser focus" else "Unavailable")
            assert snapshot["runtime"]["motion_permission"] == "Disarmed"
            assert snapshot["failures"][0]["cause"] == cause
            if loss == "unplug":
                devices.insert(0, device(3, 11))
            stall.clear()
            freeze.clear()
            release.set()
            wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Controller") == "Ready")
            assert laf.command.output is None
            with recover_workspace(laf, snapshot["active_session"]) as (new_headers, recovered):
                restored = wait_for(laf.http, "/snapshot", new_headers, lambda s: s["failures"][0]["restored"])
                acknowledge = search_action(laf, new_headers, recovered, "acknowledge", restored["active_session"]["revision"],
                                            failure_ids=[restored["failures"][0]["failure_id"]])
                assert acknowledge.status_code == 200, acknowledge.text
                ready = wait_for(laf.http, "/snapshot", new_headers, lambda s: s["readiness"]["can_resume"])
                assert laf.command.output is None
                resume = search_action(laf, new_headers, recovered, "resume", ready["active_session"]["revision"])
                assert resume.status_code == 200, resume.text
                sleep(0.15)
                assert laf.command.output is None
                devices[0] = device(3 if loss == "unplug" else 1)
                wait_for(laf.http, "/snapshot", new_headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
                devices[0] = device(3 if loss == "unplug" else 1, 11)
                wait_output(laf, "forward")
        finally:
            release.set()


@pytest.mark.parametrize("busy", ["inference", "writer", "paused"])
def test_selected_dualshock_circle_stops_without_waiting_for_other_work(tmp_path: Path, busy: str) -> None:
    devices = [device(1)]
    blocked, entered, release = Event(), Event(), Event()

    def hold() -> None:
        if blocked.is_set():
            entered.set()
            assert release.wait(5)

    def inference(_: InferenceSample) -> bool:
        hold()
        return True

    def checkpoint(point: str) -> None:
        if point == "before_commit":
            hold()

    with service(tmp_path, controller_poll=lambda: fresh_reports(devices),
                 inference=inference if busy == "inference" else None,
                 checkpoint=checkpoint if busy == "writer" else None) as laf, driving_search(laf) as (headers, driver):
        try:
            wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
            devices[0] = device(1, 11)
            wait_output(laf, "forward")
            active = driver.session
            if busy == "paused":
                paused = search_action(laf, headers, driver, "pause", active["revision"])
                assert paused.status_code == 200, paused.text
                wait_output(laf, None)
            else:
                blocked.set()
                if busy == "writer":
                    assert submit(laf.http, headers, wait=False).status_code == 202
                assert entered.wait(2)
            devices[0] = device(1, 11, 1)
            if busy != "paused":
                assert_stopped(laf, "EmergencyStop")
            stopped = wait_for(laf.http, "/snapshot", headers, lambda s: any(
                failure["cause"] == "EmergencyStop" for failure in s["failures"]))
            assert stopped["runtime"]["effective_session_state"] == "Paused"
            assert stopped["runtime"]["motion_permission"] == "Disarmed"
            assert not release.is_set()
            blocked.clear()
            release.set()
            saved = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused"
                             and any(entry["cause"] == "RecoveryRequired" for entry in s["active_session"]["pause_causes"]))
            assert len([entry for entry in saved["failures"] if entry["cause"] == "EmergencyStop"]) == 1
            assert not next(entry for entry in saved["failures"] if entry["cause"] == "EmergencyStop")["restored"]
            with recover_workspace(laf, saved["active_session"]) as (recovered, _):
                assert not laf.http.get(API + "/snapshot", headers=recovered).json()["readiness"]["can_resume"]
                devices[0] = device(1, 11)
                assert not wait_for(laf.http, "/snapshot", recovered, lambda s: any(
                    entry["cause"] == "EmergencyStop" and entry["restored"] for entry in s["failures"]
                ))["readiness"]["can_resume"]
                assert laf.command.output is None
        finally:
            release.set()


def test_local_dualshock_cannot_drive_or_pause_gestures(tmp_path: Path) -> None:
    devices = [device(1)]
    with service(tmp_path, controller_poll=lambda: fresh_reports(devices)) as laf, driving_search(laf, "Gestures") as (headers, _):
        wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Controller") == "Ready")
        arm(laf, headers, "Gestures")
        devices[0] = device(1, 1, 14)
        sleep(0.10)
        assert laf.command.output == "forward"
        devices.clear()
        snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Controller") == "Unavailable")
        assert snapshot["active_session"]["state"] == "Searching" and snapshot["failures"] == []
        assert laf.command.output == "forward"


@pytest.mark.parametrize(("fault", "cause"), [
    ("controller", "InputUnavailable"),
    ("gesture", "InputUnavailable"),
    ("robot", "RobotVideoUnavailable"),
    ("epoch", "CameraEpochChanged"),
    ("command", "CommandUnavailable"),
    ("missing-ack", "CommandUnavailable"),
    ("replayed-ack", "CommandUnavailable"),
    ("device-expiry", "CommandExpired"),
    ("AI", "AIUnavailable"),
    ("storage", "StorageFault"),
    ("protocol", "ProtocolMismatch"),
    ("hide", "WorkspaceHidden"),
    ("blur", "WorkspaceUnfocused"),
    ("unusable", "WorkspaceUnusable"),
    ("display", "DisplayStale"),
    ("browser-loss", "WorkspaceDisconnected"),
    ("heartbeat", "HeartbeatExpired"),
    ("circle", "EmergencyStop"),
])
def test_required_path_failure_disarms_and_saves_typed_pause(tmp_path: Path, fault: str, cause: str) -> None:
    mode = "Gestures" if fault == "gesture" else "Controller"
    with service(tmp_path) as laf, driving_search(laf, mode) as (headers, driver):
        arm(laf, headers, mode)
        if fault == "controller":
            laf.observations.controller_sample = False
        elif fault == "gesture":
            laf.observations.gesture_sample = False
        elif fault in ("robot", "epoch"):
            laf.observations.robot = "missing" if fault == "robot" else "epoch"
        elif fault == "command":
            laf.observations.command = False
        elif fault in ("missing-ack", "replayed-ack"):
            laf.command.acknowledgment = "missing" if fault == "missing-ack" else "replayed"
        elif fault == "device-expiry":
            laf.command.device_clock.offset += 0.3
        elif fault == "AI":
            laf.observations.inference = False
        elif fault == "storage":
            laf.observations.storage = False
        elif fault == "protocol":
            laf.observations.protocol_fault = True
        elif fault in ("hide", "blur", "unusable"):
            flag = {"hide": "visible", "blur": "focused", "unusable": "operational"}[fault]
            driver.flags = {f"workspace_{flag}": False}
        elif fault == "display":
            driver.freeze = True
        elif fault == "browser-loss":
            driver.events.close()
        elif fault == "heartbeat":
            driver.stop.set()
        else:
            laf.observations.circle = True
        reason = {"RobotVideoUnavailable": "RobotVideoLost", "WorkspaceDisconnected": "EventConnectionLost"}.get(cause, cause)
        assert_stopped(laf, reason)
        snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        assert snapshot["runtime"]["effective_session_state"] == "Paused"
        assert snapshot["runtime"]["motion_permission"] == "Disarmed"
        failure = next(entry for entry in snapshot["failures"] if entry["cause"] == cause)
        assert {"cause": "RecoveryRequired", "failure_id": failure["failure_id"]} in snapshot["active_session"]["pause_causes"]
        assert not failure["acknowledged"]
        if fault in ("missing-ack", "replayed-ack"):
            assert not failure["restored"] and status(snapshot, "Command") == "Unavailable"
        renewals = sum(entry.event == "renewed" for entry in laf.command.journal)
        sleep(0.15)
        assert laf.command.output is None
        assert sum(entry.event == "renewed" for entry in laf.command.journal) == renewals


def test_emergency_revokes_while_an_ordinary_writer_is_blocked(tmp_path: Path, monkeypatch) -> None:
    entered, unblock = Event(), Event()
    hold = False

    def checkpoint(point: str) -> None:
        if hold and point == "before_commit":
            entered.set()
            assert unblock.wait(5)

    with service(tmp_path, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        from backend.app import runtime

        monkeypatch.setattr(runtime, "MAX_ORDINARY_PENDING", 1)
        active = driver.session
        wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"] == active)
        arm(laf, headers)
        path = API + "/emergency-stop"
        unknown = laf.http.post(path, headers={**headers, "X-App-Capability": "bad"}, json={"request_id": str(uuid4())})
        assert unknown.status_code == 403
        assert laf.command.output == "forward"
        assert laf.http.get(API + "/snapshot", headers=headers).json()["lease"]["state"] == "Owned"
        hold = True
        try:
            busy = submit(laf.http, headers, wait=False)
            assert busy.status_code == 202 and entered.wait(2)
            excess = submit(laf.http, headers, wait=False)
            assert excess.status_code == 503 and excess.json()["code"] == "CAPACITY_REACHED"
            body_started, end_body = Event(), Event()

            def stalled_body() -> Iterator[bytes]:
                yield b"{"
                body_started.set()
                assert end_body.wait(4)

            with ThreadPoolExecutor(max_workers=1) as pool:
                rejected = pool.submit(laf.http.post, path, headers={**headers, "Content-Type": "application/json"},
                                       content=stalled_body())
                try:
                    assert body_started.wait(2)
                    assert_stopped(laf, "EmergencyStop")
                    stopped = wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
                    assert stopped["runtime"]["effective_session_state"] == "Paused"
                    assert not rejected.done()
                    emergency = {"request_id": str(uuid4())}
                    reply = laf.http.post(path, headers=headers, json=emergency)
                finally:
                    end_body.set()
                malformed = rejected.result()
                assert malformed.status_code == 400 and malformed.json()["permission_revoked"]
            assert reply.status_code == 202, reply.text
            validate("EmergencyStopResponse", reply.json())
            snapshot = laf.http.get(API + "/snapshot", headers=headers).json()
            assert snapshot["active_session"] == active and snapshot["lease"]["state"] == "Unowned"
            assert snapshot["runtime"]["effective_session_state"] == "Paused"
            assert snapshot["runtime"]["motion_permission"] == "Disarmed"
            assert snapshot["runtime"]["persistence_pending"]
            assert snapshot["failures"][0]["failure_id"] == reply.json()["failure_id"]
        finally:
            unblock.set()
        paused = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        assert paused["active_session"]["revision"] == 2
        same = laf.http.post(path, headers=headers, json=emergency)
        again = laf.http.post(path, headers=headers, json={"request_id": str(uuid4())})
        assert same.status_code == again.status_code == 200
        assert same.json()["failure_id"] == again.json()["failure_id"] == reply.json()["failure_id"]


def test_candidate_saves_exact_frame_before_review(tmp_path: Path) -> None:
    trigger, entered, release = Event(), Event(), Event()
    sampled: list[InferenceSample] = []

    def infer(sample: InferenceSample) -> bool | CandidateObservation:
        if not trigger.is_set() or sampled or not sample.scope:
            return True
        assert sample.capture and sample.frame_id
        sampled.append(sample)
        entered.set()
        assert release.wait(2)
        return CandidateObservation(
            sample.scope, sample.frame_id, sample.capture.stream_epoch, sample.capture.clock_epoch,
            sample.capture.sequence, (2.25, 3.5, 4.0, 6.0),
        )

    with service(tmp_path, inference=infer) as laf, driving_search(laf) as (headers, driver):
        arm(laf, headers)
        trigger.set()
        assert entered.wait(2)
        try:
            sample = sampled[0].capture
            assert sample is not None
            changed = BytesIO()
            Image.new("RGB", (sample.width, sample.height), (200, 10, 30)).save(changed, format="JPEG")
            laf.observations.robot_jpeg = changed.getvalue()
            wait_for(laf.http, "/snapshot", headers,
                     lambda _: driver.latest and driver.latest["capture_seq"] > sample.sequence
                     and laf.observations.latest and laf.observations.latest.jpeg == changed.getvalue())
        finally:
            release.set()
        state = wait_for(laf.http, "/snapshot", headers, lambda value: value["pending_candidate"] is not None)
        match, session = state["pending_candidate"], state["active_session"]
        validate("Snapshot", state)
        assert match["frame_id"] == sampled[0].frame_id
        assert match["stream_epoch"] == sampled[0].capture.stream_epoch
        assert match["box"] == {"x": 2, "y": 3, "width": 5, "height": 7}
        assert session["state"] == "Paused"
        assert session["pause_causes"] == [{"cause": "CandidateReview", "failure_id": None}]
        assert state["active_object"]["status"] == "Lost"
        assert state["runtime"]["motion_permission"] == "Disarmed"
        assert not state["readiness"]["can_resume"]
        while (candidate := driver.messages.get(timeout=2))["type"] != "candidate_pending":
            pass
        validate("EventEnvelope", candidate)
        assert candidate["session_revision"] == session["revision"]
        assert candidate["payload"]["match"] == match
        wait_output(laf, None)
        media = laf.http.get(f"{API}/media/{match['evidence_media']['id']}", headers=headers)
        assert media.status_code == 200, media.text
        with Image.open(BytesIO(media.content)) as png, Image.open(BytesIO(sampled[0].capture.jpeg)) as jpeg:
            assert png.format == "PNG"
            assert png.size == jpeg.size
            assert png.convert("RGB").tobytes() == jpeg.convert("RGB").tobytes()


def test_inference_stall_cannot_renew_held_motion(tmp_path: Path) -> None:
    blocked, entered, unblock = Event(), Event(), Event()

    def inference(observation: InferenceSample) -> bool:
        if blocked.is_set() and observation.scope:
            assert observation.frame_id and observation.capture
            entered.set()
            assert unblock.wait(5)
        return True

    with service(tmp_path, inference=inference) as laf, driving_search(laf) as (headers, driver):
        arm(laf, headers)
        blocked.set()
        try:
            assert entered.wait(2)
            assert_stopped(laf, "AIUnavailable")
            assert not unblock.is_set()
            current = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
            assert status(current, "RobotVideo") == "Ready"
            assert status(current, "Controller") == "Ready"
            assert current["failures"][0]["cause"] == "AIUnavailable"
        finally:
            unblock.set()


def test_stopping_does_not_need_a_blocked_subscriber_or_video_consumer(tmp_path: Path) -> None:
    with service(tmp_path, blocked=True, blocked_connection=2) as laf, driving_search(laf) as (headers, _):
        arm(laf, headers)
        spectator = auth(laf.bootstrap())
        held = laf.blocked
        assert held
        with (laf.open("/events", laf.ticket(spectator, "events")),
              laf.open("/video/robot", laf.ticket(spectator, "robot-video"))):
            assert all(signal.wait(2) for signal in held.entered.values())
            assert laf.command.output == "forward"
            try:
                laf.observations.command = False
                assert_stopped(laf, "CommandUnavailable")
                assert not held.resume_events.is_set() and not held.resume_video.is_set()
            finally:
                held.resume_events.set()
                held.resume_video.set()


def test_proximity_advisory_preserves_latch_and_has_no_motion_or_revision_effect(tmp_path: Path) -> None:
    with service(tmp_path) as laf, driving_search(laf) as (headers, driver):
        arm(laf, headers)
        laf.observations.proximity = 150
        for _ in range(30):
            update = driver.messages.get(timeout=4)
            if update["type"] == "proximity_warning_changed" and update["payload"]["proximity"]["state"] == "Warning":
                break
        warning = update["payload"]["proximity"]
        validate("EventEnvelope", update)
        assert warning["distance_mm"] == 150 and warning["warning_latched"]
        assert warning["sample_seq"] and warning["source_epoch"] and warning["observed_at_ms"]
        laf.observations.proximity = None
        unknown = wait_for(laf.http, "/snapshot", headers, lambda s: s["proximity"]["state"] == "Unknown")
        assert unknown["proximity"]["warning_latched"] and unknown["proximity"]["distance_mm"] is None
        laf.observations.proximity = 229
        retained = wait_for(laf.http, "/snapshot", headers, lambda s: s["proximity"]["distance_mm"] == 229)
        assert retained["proximity"]["warning_latched"]
        laf.observations.proximity = 230
        cleared = wait_for(laf.http, "/snapshot", headers, lambda s: s["proximity"]["state"] == "Clear")
        assert cleared["proximity"]["sample_seq"] >= retained["proximity"]["sample_seq"] + 3
        assert not cleared["proximity"]["warning_latched"]
        assert cleared["active_session"] == driver.session and cleared["runtime"]["motion_permission"] == "Armed"
        assert laf.command.output == "forward"


def test_repeated_path_observations_share_an_id_until_restoration(tmp_path: Path) -> None:
    with service(tmp_path) as laf, driving_search(laf) as (headers, _):
        arm(laf, headers)
        laf.observations.inference = False
        before = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        first = next(failure for failure in before["failures"] if failure["cause"] == "AIUnavailable")
        sleep(0.2)
        assert laf.http.get(API + "/snapshot", headers=headers).json()["failures"] == [first]
        laf.observations.inference = True
        restored = wait_for(laf.http, "/snapshot", headers, lambda s: s["failures"][0]["restored"] and
                            s["active_session"]["revision"] == before["active_session"]["revision"] + 1)
        assert restored["failures"] == [{**first, "restored": True}]
        assert laf.command.output is None
        laf.observations.inference = False
        recurring = wait_for(laf.http, "/snapshot", headers, lambda s: len(s["active_session"]["pause_causes"]) == 2)
        assert [failure["restored"] for failure in recurring["failures"]] == [True, False]
        assert len({failure["failure_id"] for failure in recurring["failures"]}) == 2
        assert recurring["runtime"]["motion_permission"] == "Disarmed"


def test_silent_capture_staleness_is_recorded_even_after_another_fault_pauses(tmp_path: Path) -> None:
    release = Event()
    with service(tmp_path) as laf, driving_search(laf) as (headers, _):
        arm(laf, headers)
        laf.observations.inference = False
        paused = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        assert paused["lease"]["state"] == "Unowned"
        try:
            laf.observations.capture_barrier = release
            stale = wait_for(laf.http, "/snapshot", headers, lambda s: len(s["active_session"]["pause_causes"]) == 2)
            assert {failure["cause"] for failure in stale["failures"]} == {"AIUnavailable", "RobotVideoUnavailable"}
            assert status(stale, "RobotVideo") == "Unavailable"
            assert laf.command.output is None
        finally:
            release.set()


@pytest.mark.parametrize("action", ["pause", "stop"])
def test_pause_and_stop_use_reserved_capacity_and_disarm_before_writer(tmp_path: Path, action: str, monkeypatch) -> None:
    from backend.app import runtime

    entered, release = Event(), Event()
    blocked = False

    def checkpoint(point: str) -> None:
        if blocked and point == "before_commit":
            entered.set()
            assert release.wait(5)

    with service(tmp_path, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        monkeypatch.setattr(runtime, "MAX_ORDINARY_PENDING", 1)
        arm(laf, headers)
        blocked = True
        session = driver.session["id"]
        request = {"action": action, "action_id": str(uuid4()), "session_id": session,
                   "expected_revision": driver.session["revision"], "client_id": driver.owner["client_id"],
                   "client_lease_id": driver.lease["client_lease_id"]}
        try:
            assert submit(laf.http, headers, wait=False).status_code == 202 and entered.is_set()
            path = f"{API}/sessions/{session}/actions"
            pending = laf.http.post(path, headers=headers, json=request)
            assert pending.status_code == 202, pending.text
            assert_stopped(laf, "SearchSuspended")
            current = laf.http.get(API + "/snapshot", headers=headers).json()
            assert current["active_session"]["state"] == "Searching"
            assert current["runtime"]["effective_session_state"] == "Paused"
        finally:
            release.set()
        expected = "Paused" if action == "pause" else "Ended"
        wait_for(laf.http, f"/sessions/{session}", headers, lambda s: s["state"] == expected)


def test_concurrent_start_has_one_durable_winner(tmp_path: Path) -> None:
    entered, unblock = Event(), Event()

    def checkpoint(point: str) -> None:
        if point == "before_start_commit":
            entered.set()
            assert unblock.wait(5)

    with service(tmp_path, checkpoint=checkpoint) as laf, ready_search(laf) as (owner, start, events, video):
        headers = auth(owner)
        path = API + "/sessions"
        generation = laf.http.get(API + "/snapshot", headers=headers).json()["lease"]["control_generation"]
        lease = {**start, "control_generation": generation}
        try:
            first = laf.http.post(path, headers=headers, json=start)
            assert first.status_code == 202 and entered.is_set()
            events.send(json.dumps(heartbeat(owner, lease, 2, frame(video)[0])))
            duplicate = laf.http.post(path, headers=headers, json=start)
            assert duplicate.json() == first.json()
            collision = laf.http.post(path, headers=headers, json={**start, "control_mode": "Gestures"})
            assert collision.status_code == 409 and collision.json()["code"] == "ACTION_ID_CONFLICT"
            other_start = {**start, "action_id": str(uuid4())}
            events.send(json.dumps(heartbeat(owner, lease, 3, frame(video)[0])))
            competing = laf.http.post(path, headers=headers, json=other_start)
            assert competing.status_code == 202
        finally:
            unblock.set()
        snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: any(
            o["action_id"] == other_start["action_id"] and o["persistence"] == "Failed" for o in s["operations"]
        ))
        assert snapshot["active_session"]["revision"] == 1 and snapshot["lease"]["state"] == "Owned"
        rejected = next(o for o in snapshot["operations"] if o["action_id"] == other_start["action_id"])
        assert rejected["error"]["code"] == "ACTIVE_SESSION_EXISTS"
        history = laf.http.get(API + f"/objects/{start['object_id']}/sessions", headers=headers).json()
        assert history["items"] == [snapshot["active_session"]]


def test_failed_pause_retains_effective_stop_and_retries_same_request(tmp_path: Path) -> None:
    fail = True

    def checkpoint(point: str) -> None:
        if fail and point == "before_pause_commit":
            raise OSError("test commit failure")

    with service(tmp_path, checkpoint=checkpoint) as laf, ready_search(laf) as (owner, start, _, _):
        headers = auth(owner)
        created = laf.http.post(API + "/sessions", headers=headers, json=start)
        path = created.headers["Location"] + "/actions"
        session = created.json()["result"]["session"]
        action = {"action_id": str(uuid4()), "session_id": session["id"], "action": "pause",
                  "expected_revision": 1, "client_id": owner["client_id"], "client_lease_id": start["client_lease_id"]}
        failure = laf.http.post(path, headers=headers, json=action)
        assert failure.status_code == 503, failure.text
        assert failure.json()["persistence"] == "Failed"
        snapshot = laf.http.get(API + "/snapshot", headers=headers).json()
        assert snapshot["active_session"] == session
        assert snapshot["runtime"]["effective_session_state"] == "Paused"
        assert snapshot["runtime"]["persistence_pending"]
        fail = False
        retry = laf.http.post(path, headers=headers, json=action)
        assert retry.status_code == 200 and retry.json()["result"]["session"]["revision"] == 2


def test_idle_emergency_and_session_end_with_expired_grace(tmp_path: Path) -> None:
    from backend.app.storage import DAY_MS, utc_ms

    now = utc_ms()
    with service(tmp_path, wall=lambda: now) as laf, ready_search(laf) as (owner, start, _, _):
        headers = auth(owner)
        emergency = laf.http.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
        assert emergency.status_code == 200 and emergency.json()["session_id"] is None and emergency.json()["failure_id"] is None
        # Start needs a current lease again after an authorized idle stop.
        lost = laf.http.post(API + "/sessions", headers=headers, json=start)
        assert lost.status_code == 403

    with service(tmp_path / "grace", wall=lambda: now) as laf, ready_search(laf) as (owner, start, _, _):
        headers = auth(owner)
        created = laf.http.post(API + "/sessions", headers=headers, json=start)
        session = created.json()["result"]["session"]
        now += 7 * DAY_MS
        active = wait_for(laf.http, "/snapshot", headers, lambda s: s["retention"]["active_object_grace"])
        assert active["active_object"]["retention_grace"]
        path = created.headers["Location"]
        stopped = laf.http.post(path + "/actions", headers=headers, json={
            "action_id": str(uuid4()), "session_id": session["id"], "action": "stop", "expected_revision": 1,
            "client_id": owner["client_id"], "client_lease_id": start["client_lease_id"],
        })
        assert stopped.status_code == 200, stopped.text
        assert stopped.json()["result"] == dict.fromkeys(("object", "session", "match", "settings", "deletion"))
        assert laf.http.get(path, headers=headers).status_code in (404, 410)
        final = wait_for(laf.http, "/snapshot", headers, lambda s: not s["retention"]["active_object_grace"])
        assert final["active_session"] is None and final["active_object"] is None
        assert not any(o["result"] and o["result"]["session"] for o in final["operations"])


def test_revoked_setup_cannot_commit_a_blocked_start(tmp_path: Path) -> None:
    entered, unblock = Event(), Event()

    def checkpoint(point: str) -> None:
        if point == "before_start_commit":
            entered.set()
            assert unblock.wait(5)

    with service(tmp_path, checkpoint=checkpoint) as laf, ready_search(laf) as (owner, start, events, _):
        headers = auth(owner)
        try:
            pending = laf.http.post(API + "/sessions", headers=headers, json=start)
            assert pending.status_code == 202 and entered.is_set()
            events.close()
            wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
        finally:
            unblock.set()
        final = wait_for(laf.http, "/snapshot", headers, lambda s: any(
            op["action_id"] == start["action_id"] and op["persistence"] == "Failed" for op in s["operations"]
        ))
        assert final["active_session"] is None
        assert laf.http.get(API + f"/objects/{start['object_id']}/sessions", headers=headers).json()["items"] == []


def test_release_failure_keeps_stop_in_effect(tmp_path: Path) -> None:
    def checkpoint(point: str) -> None:
        if point == "before_safety_pause_commit":
            raise OSError("test release persistence failure")

    with service(tmp_path, checkpoint=checkpoint) as laf, ready_search(laf) as (owner, start, _, _):
        headers = auth(owner)
        started = laf.http.post(API + "/sessions", headers=headers, json=start).json()["result"]["session"]
        current = laf.http.get(API + "/snapshot", headers=headers).json()
        release = {"request_id": str(uuid4()), "client_id": owner["client_id"], "session_id": started["id"],
                   "control_generation": current["lease"]["control_generation"], "client_lease_id": start["client_lease_id"]}
        for _ in range(2):
            failed = laf.http.post(API + "/control-lease/release", headers=headers, json=release)
            assert failed.status_code == 503 and failed.json()["permission_revoked"]
            snapshot = failed.json()["snapshot"]
            assert snapshot["active_session"]["state"] == "Searching"
            assert snapshot["runtime"]["effective_session_state"] == "Paused"
            assert snapshot["runtime"]["persistence_pending"]
            assert snapshot["lease"]["state"] == "Unowned"


def test_owner_loss_pauses_after_a_pending_pause_loses_its_lease(tmp_path: Path) -> None:
    entered, unblock = Event(), Event()

    def checkpoint(point: str) -> None:
        if point == "before_pause_commit":
            entered.set()
            assert unblock.wait(5)

    with service(tmp_path, checkpoint=checkpoint) as laf, ready_search(laf) as (owner, start, events, _):
        headers = auth(owner)
        created = laf.http.post(API + "/sessions", headers=headers, json=start)
        session = created.json()["result"]["session"]
        path = created.headers["Location"] + "/actions"
        action = {"action_id": str(uuid4()), "session_id": session["id"], "action": "pause",
                  "expected_revision": 1, "client_id": owner["client_id"], "client_lease_id": start["client_lease_id"]}
        try:
            pending = laf.http.post(path, headers=headers, json=action)
            assert pending.status_code == 202 and entered.is_set()
            conflict = laf.http.post(path, headers=headers, json={**action, "action_id": str(uuid4()), "action": "stop"})
            assert conflict.status_code == 503 and conflict.json()["code"] == "CAPACITY_REACHED"
            assert conflict.json()["permission_revoked"]
            events.close()
            wait_for(laf.http, "/snapshot", headers, lambda s: s["lease"]["state"] == "Unowned")
        finally:
            unblock.set()
        snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        assert snapshot["runtime"]["effective_session_state"] == "Paused"
        assert snapshot["active_session"]["revision"] == 2
        assert not snapshot["runtime"]["persistence_pending"]
