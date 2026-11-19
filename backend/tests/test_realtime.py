import asyncio
import json
import socket
import sqlite3
from collections import Counter
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
from dataclasses import replace
from pathlib import Path
from shutil import copytree
from threading import Event, Thread
from time import monotonic, sleep
from uuid import uuid4

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
from backend.app.control import Revocation
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
from backend.tests.test_registration import submit

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
        self.controller_sample = True
        self.gesture_sample = True
        self.robot = "live"
        self.latest: Capture | None = None

    def observe(self, now: float) -> Observation:
        base = self.adapter.observe(now)
        if self.robot == "live":
            self.latest = base.robot
        robot = self.latest
        if self.robot == "missing":
            robot = None
        elif self.robot == "unknown-age" and base.robot:
            robot = replace(base.robot, age_ms=-1)
        elif self.robot == "invalid" and base.robot:
            robot = replace(base.robot, width=base.robot.width - 1)
        return replace(base, inference=self.inference, webcam=base.webcam if self.webcam else None, robot=robot,
                       controller_sample_at=base.controller_sample_at if self.controller_sample else now - 1,
                       gesture_sample_at=base.gesture_sample_at if self.gesture_sample else now - 1)


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


def test_control_is_exclusive_and_historical_retries_do_not_reacquire(tmp_path: Path) -> None:
    with service(tmp_path) as laf:
        alice, bob = laf.bootstrap(), laf.bootstrap()
        alice_headers, bob_headers = auth(alice), auth(bob)
        wait_for(laf.http, "/health", alice_headers)
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
            owner_update, spectator_update = event(owner), event(spectator)
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
                assert event(channel)["payload"]["lease"]["state"] == "Unowned"
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
            frame_limit: int | None = None, revocations: list[Revocation] | None = None) -> Iterator[Loopback]:
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
                         on_channel_invalidated=lambda client, channel: invalidations.append((client, channel)),
                         **({"on_control_revoked": revocations.append} if revocations is not None else {}))
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
            assert submit(laf.http, headers).status_code == 201
            events.send(json.dumps(heartbeat(owner, lease, 3, frame(video)[0])))
            ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"]["Controller"])
            assert ready["readiness"]["can_start"] == {"Gestures": False, "Controller": True}
            assert ready["active_session"] is None and ready["runtime"]["motion_permission"] == "Disarmed"
            assert status(ready, "Webcam") == "Unavailable"
            spectator_state = laf.http.get(API + "/snapshot", headers=auth(spectator)).json()
            assert spectator_state["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            assert status(spectator_state, "DisplayedRobotVideo") == "Unavailable"
            laf.observations.webcam = True
            laf.observations.controller_sample = False
            events.send(json.dumps(heartbeat(owner, lease, 4, frame(video)[0])))
            selected = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_start"]["Gestures"])
            assert selected["readiness"]["can_start"] == {"Gestures": True, "Controller": False}
            laf.observations.gesture_sample = False
            events.send(json.dumps(heartbeat(owner, lease, 5, frame(video)[0])))
            unavailable = wait_for(laf.http, "/snapshot", headers, lambda s: status(s, "Webcam") == "Unavailable")
            assert unavailable["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            events.send(json.dumps(heartbeat(owner, lease, 6, workspace_focused=False)))
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


def test_acquire_race_and_runtime_capacity_preserve_owner_and_receipts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert realtime.MAX_RUNTIME_RECEIPTS == 8192
    monkeypatch.setattr(realtime, "MAX_RUNTIME_RECEIPTS", 1)
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
            assert (result.status_code, result.json()["code"], result.json()["permission_revoked"]) == (
                503, "CAPACITY_REACHED", True,
            )
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
        # The later lifecycle route will create these records. Seed the durable session after startup reconciliation.
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
            assert response.status_code == 200
            assert response.json()["snapshot"]["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            assert revocations == [Revocation(owner["client_id"], "active", response.json()["control_generation"],
                                             "Released", release["request_id"])]


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
