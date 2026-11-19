"""Boot-scoped realtime transport and workspace authority on the service event loop."""

import asyncio
import json
import math
import re
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from hashlib import sha256
from secrets import compare_digest, token_urlsafe
from typing import Literal, cast
from uuid import uuid4

from fastapi import Request, WebSocket
from PIL import Image
from starlette.websockets import WebSocketDisconnect

from .config import Config
from .control import (
    HEARTBEAT_FIELDS,
    MAX_ISSUED_FRAMES,
    MAX_RUNTIME_RECEIPTS,
    TOKEN,
    WORKSPACE_FLAGS,
    Lease,
    LeaseReceipt,
    LeaseRejected,
    LeaseRequest,
    Revocation,
    counter,
    domain_id,
    public_lease,
    token,
)
from .http import DOMAIN_ID, HEADER_LIMIT, HttpError, authorize_address, header, json_fields, read_json
from .motion import FixtureCommandSink, InputScope, Motion
from .registration_input import SAFE_INTEGER, canonical_json
from .simulation import (
    SOURCES,
    Capture,
    InferenceSample,
    ProximityAdvisory,
    QualificationProfile,
    Simulation,
    Source,
    capture_identity_valid,
    dimensions_allowed,
    read_sample,
)

Channel = Literal["events", "robot-video", "webcam-video"]
CHANNELS: dict[str, Channel] = {"/events": "events", "/video/robot": "robot-video", "/video/webcam": "webcam-video"}
PROTOCOL = "laf.v1"
TICKET_PREFIX = "laf.ticket."
TICKET_SECONDS = 10
MAX_OUTSTANDING = 32
# Keep recent consumed entries distinguishable from unknown tickets without an unbounded replay cache.
MAX_KNOWN_TICKETS = 256
CAPTURE_INTERVAL = 0.1
PROJECTION_INTERVAL = 0.25
Projection = dict[str, object]
EventKind = Literal["snapshot", "session_changed", "recovery_changed", "readiness_changed",
                    "retention_changed", "storage_fault", "object_removed", "proximity_warning_changed"]
PATH_FAILURES = {
    "Command": "CommandUnavailable", "AI": "AIUnavailable", "RobotVideo": "RobotVideoUnavailable",
    "Controller": "InputUnavailable", "Webcam": "InputUnavailable", "Storage": "StorageFault",
}
REVOCATION_FAILURES = {
    "EventConnectionLost": "WorkspaceDisconnected", "RobotVideoLost": "RobotVideoUnavailable",
    "CameraEpochChanged": "CameraEpochChanged", "WorkspaceHidden": "WorkspaceHidden",
    "WorkspaceUnfocused": "WorkspaceUnfocused", "WorkspaceUnusable": "WorkspaceUnusable",
    "HeartbeatExpired": "HeartbeatExpired", "DisplayStale": "DisplayStale",
    "ProtocolMismatch": "ProtocolMismatch", "InputUnavailable": "InputUnavailable",
    "AIUnavailable": "AIUnavailable", "StorageUnavailable": "StorageFault", "StorageFault": "StorageFault",
    "CommandUnavailable": "CommandUnavailable", "CommandExpired": "CommandExpired",
    "RobotVideoUnavailable": "RobotVideoUnavailable",
}


@dataclass(repr=False)
class Ticket:
    client: str
    channel: Channel
    expires: float
    consumed: bool = False


@dataclass(frozen=True)
class Frame:
    id: str
    capture: Capture

    def age(self, now: float) -> int:
        return self.capture.age_ms + math.ceil((now - self.capture.observed_at) * 1000)

    def header(self, source: Source, now: float, utc: int, profile: QualificationProfile) -> bytes | None:
        sample = self.capture
        age = self.age(now)
        if now < sample.observed_at or age >= profile.bound("capture_age_limit_ms"):
            return None
        metadata = canonical_json({
            "protocol_version": 1, "source": source, "stream_epoch": sample.stream_epoch,
            "capture_seq": sample.sequence, "frame_id": self.id, "width": sample.width, "height": sample.height,
            "received_at_ms": utc, "capture_age_bound_ms": age, "source_capture_us": sample.source_us,
            "source_clock_epoch": sample.clock_epoch,
        }).encode("utf-8")
        if len(metadata) > profile.bound("max_header_bytes") or (
            4 + len(metadata) + len(sample.jpeg) > profile.bound("max_frame_bytes")
        ):
            return None
        return metadata


@dataclass(frozen=True)
class IssuedFrame:
    stream_epoch: str
    display_deadline: float
    captured_at: float
    retire_at: float


@dataclass
class Connection:
    client: str
    channel: Channel
    close: asyncio.Future[int]
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    events: deque[bytes] = field(default_factory=deque)
    event_bytes: int = 0
    waiting: Frame | None = None
    issued: dict[str, IssuedFrame] = field(default_factory=dict)
    video_generation: int = 0

    def end(self, code: int) -> None:
        if not self.close.done():
            self.close.set_result(code)
        self.events.clear()
        self.event_bytes = 0
        self.waiting = None
        self.issued.clear()

    def queue(self, message: bytes, profile: QualificationProfile) -> int | None:
        size = len(message)
        if size > min(profile.bound("max_event_message_bytes"), profile.bound("event_queue_bytes")):
            return 1009
        if (len(self.events) >= profile.bound("event_queue_messages")
                or self.event_bytes + size > profile.bound("event_queue_bytes")):
            return 1008
        self.events.append(message)
        self.event_bytes += size
        self.ready.set()
        return None


class Realtime:
    def __init__(
        self, simulation: Simulation | None, unavailable_code: str, boot: str,
        monotonic: Callable[[], float], utc: Callable[[], int], touch_client: Callable[[str], bool],
        project: Callable[[], Awaitable[Projection | None]],
        invalidate: Callable[[str, Channel], None], expire_clients: Callable[[], None],
        on_control_revoked: Callable[[Revocation], None],
        on_failure_changed: Callable[[Projection], None],
        on_simulated_emergency: Callable[[], None],
    ):
        self.simulation = simulation
        self.unavailable_code = unavailable_code
        self.boot = boot
        self.monotonic = monotonic
        self.utc = utc
        self.touch_client = touch_client
        self.project = project
        self.invalidate = invalidate
        self.expire_clients = expire_clients
        self.on_control_revoked = on_control_revoked
        self.on_failure_changed = on_failure_changed
        self.on_simulated_emergency = on_simulated_emergency
        self.sequence = 1
        self._tickets: dict[bytes, Ticket] = {}
        self._connections: dict[tuple[str, Channel], Connection] = {}
        self._frames: dict[Source, Frame] = {}
        self._live_sources: set[Source] = set()
        self._readiness: dict[str, bool] = {}
        self._input_deadlines: dict[str, float] = {}
        self._generation = 1
        self._lease: Lease | None = None
        self._pause_required_for: str | None = None
        self._starting_session: str | None = None
        self._active_session: str | None = None
        self._active_owner: str | None = None
        self._active_mode: str | None = None
        self._active_state: str | None = None
        self.active_revision: int | None = None
        self.emergency_requests: set[str] = set()
        self._failures: dict[str, Projection] = {}
        self._outstanding: dict[tuple[str | None, str], str] = {}
        self._receipts: dict[str, LeaseReceipt] = {}
        self._projection: Projection | None = None
        self._projection_lock = asyncio.Lock()
        self._projection_revision = 0
        self._closed = False
        self._storage_ready = False
        self._storage_until = 0.0
        self._inference_until = 0.0
        self._motion = None
        self._proximity = None
        self._fixture_sink = None
        self._published_permission = "Disarmed"
        self._circle_held = False
        if simulation:
            self._proximity = ProximityAdvisory(simulation.profile)
            if simulation.command_sink is None:
                self._fixture_sink = FixtureCommandSink(simulation.profile, monotonic)
                self._fixture_sink.start()
            sink = simulation.command_sink or self._fixture_sink
            assert sink is not None
            self._motion = Motion(sink, simulation.profile)

    @property
    def profile(self) -> QualificationProfile | None:
        return self.simulation.profile if self.simulation else None

    def requires_profile(self) -> QualificationProfile:
        if not self.profile or self._closed:
            code = self.unavailable_code
            raise HttpError(503, code, "A compatible backend simulation profile is unavailable.")
        return self.profile

    def client_is_live(self, client: str) -> bool:
        return (client, "events") in self._connections or bool(self._lease and self._lease.client == client)

    def _advance_generation(self) -> None:
        if self._generation < SAFE_INTEGER:
            self._generation += 1

    @property
    def safety_session(self) -> str | None:
        return self._starting_session or self._active_session

    @property
    def active_owner(self) -> str | None:
        return self._active_owner

    def request_at_capacity(self) -> bool:
        return len(self._receipts) + len(self.emergency_requests) >= MAX_RUNTIME_RECEIPTS

    def lease_request_used(self, request_id: str) -> bool:
        return request_id in self._receipts

    def authorize_search(self, client: str, secret: str, session: str | None, mode: str | None) -> int:
        if not self.touch_client(client):
            raise HttpError(403, "CLIENT_INVALID", "Reconnect to obtain a current page identity.")
        self._expire_lease(self.monotonic())
        lease = self._lease
        if lease is None:
            raise HttpError(403, "LEASE_EXPIRED", "The control lease is no longer current.")
        if lease.client != client or not compare_digest(lease.secret, secret):
            raise HttpError(403, "LEASE_REQUIRED", "Use the current private control lease.")
        if (client, "events") not in self._connections or lease.session != session:
            raise HttpError(409, "OWNERSHIP_MISMATCH", "The active search changed.")
        if mode:
            self.requires_profile()
            required = ("Command", "RobotVideo", "AI", "Storage", "Webcam" if mode == "Gestures" else "Controller")
            if (not lease.workspace or not lease.displayed or
                    any(self.component_cause(name) is not None for name in required)):
                raise HttpError(503, "NOT_READY", "Restore the required search paths and displayed preview.", True)
        return self._generation

    def prepare_start(self, session: str) -> None:
        # A loss after the last writer guard still knows which session to pause.
        self._starting_session = session

    def resolve_start(self, session: str, committed: bool, *, uncertain: bool = False) -> None:
        if self._starting_session != session:
            return
        if uncertain:
            self._revoke("StorageUnavailable")
        self._starting_session = None
        if committed and self._lease is not None:
            self._lease.session = session
            self._lease.setup_handoff = True
        if not committed and not uncertain and self._pause_required_for == session:
            self._pause_required_for = None

    def suspend_search(self, session: str) -> None:
        had_permission = self._motion and self._motion.permission != "Disarmed"
        if self._motion:
            self._motion.stop("SearchSuspended")
        self._pause_required_for = session
        if had_permission:
            self._rotate_motion_generation()
        if self._projection is not None:
            self._publish("readiness_changed", None)

    def emergency_revoke(self) -> str | None:
        session = self.safety_session
        if session:
            self._pause_required_for = session
        self._revoke("EmergencyStop")
        if self._projection is not None:
            self._publish("readiness_changed", None)
        return session

    def search_committed(self, session: Projection) -> None:
        if session["state"] != "Ended":
            self._active_session = str(session["id"])
            self._active_owner = str(session["object_id"])
            self._active_mode = str(session["control_mode"])
            self._active_state = str(session["state"])
            self.active_revision = cast(int, session["revision"])
            return
        self.search_ended(str(session["id"]))

    def search_ended(self, session: str) -> None:
        if self._active_session == session:
            self._active_session = self._active_owner = None
            self._active_mode = self._active_state = None
            self.active_revision = None
        if self._pause_required_for == session:
            self._pause_required_for = None
        self._failures = {key: failure for key, failure in self._failures.items() if failure["session_id"] != session}
        self._outstanding = {key: value for key, value in self._outstanding.items() if key[0] != session}
        if self._lease is not None and self._lease.session == session:
            self._revoke("SessionEnded")

    def _revoke(self, reason: str, request_id: str | None = None) -> None:
        if self._motion:
            self._motion.stop(reason)
        lease, self._lease = self._lease, None
        if lease is None:
            return
        self._advance_generation()
        session = lease.session or self._starting_session
        if session is not None and reason != "SessionEnded":
            self._pause_required_for = session
        if cause := REVOCATION_FAILURES.get(reason):
            self.record_failure(cause, session, publish=False)
        if reason != "SessionEnded":
            # A new generation needs its public lease snapshot before any correlated delta.
            self._publish_snapshot()
        self.on_control_revoked(Revocation(lease.client, session, self._generation, reason, request_id))

    def _expire_lease(self, now: float) -> None:
        lease = self._lease
        if lease is not None:
            if now >= lease.display_deadline and lease.display_deadline <= lease.heartbeat_deadline:
                self._revoke("DisplayStale")
            elif now >= lease.heartbeat_deadline:
                self._revoke("HeartbeatExpired")

    async def maintain_control(self) -> None:
        profile = self.requires_profile()
        interval = min(20, profile.bound("command_renewal_interval_ms") / 4,
                       profile.bound("heartbeat_deadline_ms") / 2, profile.bound("display_deadline_ms") / 2) / 1000
        while not self._closed:
            now = self.monotonic()
            self._evaluate_motion(now)
            robot = self._frames.get("robot")
            if robot and "robot" in self._live_sources and robot.age(now) >= profile.bound("capture_age_limit_ms"):
                self._observe_source("robot", None, None, now, profile)
            if self._proximity:
                before = self._proximity.payload
                self._proximity.expire(now)
                self._publish_proximity(before)
            await asyncio.sleep(interval)

    def _input_scope(self) -> InputScope | None:
        return InputScope(self.boot, self._active_session, self._generation) if self._active_session else None

    def _motion_scope(self) -> InputScope | None:
        lease = self._lease
        if (lease and lease.session == self._active_session and lease.workspace and lease.displayed and not lease.setup_handoff
                and self._active_state == "Searching" and self._pause_required_for != self._active_session):
            return self._input_scope()
        return None

    def _rotate_motion_generation(self) -> None:
        lease = self._lease
        if lease is None or self._motion is None:
            return
        if self._generation >= SAFE_INTEGER - 1:
            self._revoke("ProtocolMismatch")
            return
        self._motion.stop("GenerationChanged")
        lease.previous_generation = self._generation
        self._advance_generation()
        lease.generation_started = self.monotonic()
        lease.motion_generation = True
        lease.workspace = lease.displayed = False
        self._publish_snapshot()

    def _evaluate_motion(self, now: float) -> None:
        self._expire_lease(now)
        scope = self._motion_scope()
        if scope and self._motion:
            selected = self._selected_input()
            assert selected is not None
            required = ("RobotVideo", "Command", selected, "AI", "Storage")
            failed = next((PATH_FAILURES[name] for name in required if self.component_cause(name)), None)
            now = self.monotonic()
            self._expire_lease(now)
            if scope == self._motion_scope() and (failed or (failed := self._motion.tick(scope, now, self.monotonic))):
                self._revoke(failed)
        self._publish_permission()

    def _publish_permission(self) -> None:
        permission = self._motion.permission if self._motion else "Disarmed"
        if self._published_permission != permission:
            self._published_permission = permission
            if self._projection is not None:
                self._publish("readiness_changed", None)

    def _can_acquire(self, client: str | None) -> bool:
        return bool(client and self.profile and not self._closed and self._generation < SAFE_INTEGER - 1
                    and (client, "events") in self._connections)

    async def change_lease(self, request: LeaseRequest) -> Projection:
        if not self.touch_client(request.client):
            raise LeaseRejected("CLIENT_INVALID")
        profile = self.requires_profile()
        fingerprint = request.fingerprint()
        # Release revokes before waiting for storage. Acquire refreshes current session/record facts first.
        if request.secret is None and request.request_id not in self._receipts:
            if await self.snapshot(request.client) is None:
                raise LeaseRejected("NOT_READY")
            if not self.touch_client(request.client):
                raise LeaseRejected("CLIENT_INVALID")
        self._expire_lease(self.monotonic())
        if request.request_id in self.emergency_requests:
            raise LeaseRejected("REQUEST_ID_CONFLICT")
        receipt = self._receipts.get(request.request_id)
        if receipt is not None:
            if receipt.fingerprint != fingerprint:
                raise LeaseRejected("REQUEST_ID_CONFLICT")
        else:
            receipt = self._change_lease(request, fingerprint, profile)
        snapshot = await self.snapshot(request.client)
        if snapshot is None:
            raise LeaseRejected("NOT_READY", permission_revoked=request.secret is not None)
        return receipt.outcome(request.request_id, snapshot)

    def _change_lease(self, request: LeaseRequest, fingerprint: bytes,
                      profile: QualificationProfile) -> LeaseReceipt:
        lease = self._lease
        full = self.request_at_capacity()
        current_session = self._active_session
        if request.secret is not None:
            if lease is None or request.generation != self._generation:
                raise LeaseRejected("LEASE_EXPIRED")
            if lease.client != request.client or not compare_digest(lease.secret, request.secret):
                raise LeaseRejected("LEASE_REQUIRED")
            if request.session != current_session or request.session != lease.session:
                raise LeaseRejected("OWNERSHIP_MISMATCH")
            if full:
                self._revoke("Released", request.request_id)
                raise LeaseRejected("CAPACITY_REACHED", permission_revoked=True)
            receipt = LeaseReceipt(fingerprint, self._generation + 1, None, None,
                                   self._can_acquire(request.client) and
                                   len(self._receipts) + len(self.emergency_requests) + 1 < MAX_RUNTIME_RECEIPTS)
            self._receipts[request.request_id] = receipt
            self._revoke("Released", request.request_id)
            return receipt

        if lease is not None:
            raise LeaseRejected("LEASE_OWNED")
        # Leave a generation available to invalidate the authorization on revocation.
        if self._generation >= SAFE_INTEGER - 1:
            raise LeaseRejected("COUNTER_EXHAUSTED")
        if not self._projection or self._starting_session or not self._can_acquire(request.client):
            raise LeaseRejected("NOT_READY")
        if request.session != current_session:
            raise LeaseRejected("OWNERSHIP_MISMATCH")
        if not request.takeover and (self._generation > 1 or current_session is not None):
            raise LeaseRejected("INVALID_TRANSITION")
        if full:
            raise LeaseRejected("CAPACITY_REACHED")
        now = self.monotonic()
        secret = token_urlsafe(32)
        self._advance_generation()
        self._lease = Lease(request.client, request.session, secret,
                            now + profile.bound("heartbeat_deadline_ms") / 1000,
                            now + profile.bound("display_deadline_ms") / 1000)
        receipt = LeaseReceipt(fingerprint, self._generation, request.client, secret)
        self._receipts[request.request_id] = receipt
        self._publish_snapshot()
        return receipt

    def expire_client(self, client: str) -> None:
        for channel in CHANNELS.values():
            connection = self._connections.get((client, channel))
            if connection is not None:
                self.remove(connection, 1008)
        for key, ticket in tuple(self._tickets.items()):
            if ticket.client == client:
                del self._tickets[key]

    def issue(self, client: str, channel: Channel) -> Projection:
        if not self.touch_client(client):
            raise HttpError(403, "CLIENT_INVALID", "Reconnect to obtain a current page identity.")
        self.requires_profile()
        now = self.monotonic()
        for key, ticket in tuple(self._tickets.items()):
            if ticket.expires <= now:
                del self._tickets[key]
        owned = [ticket for ticket in self._tickets.values() if ticket.client == client]
        if len(owned) >= MAX_KNOWN_TICKETS or sum(not ticket.consumed for ticket in owned) >= MAX_OUTSTANDING:
            raise HttpError(503, "CAPACITY_REACHED", "Wait for outstanding WebSocket tickets to expire.", True)
        token = token_urlsafe(32)
        self._tickets[sha256(token.encode("ascii")).digest()] = Ticket(client, channel, now + TICKET_SECONDS)
        return {"ticket": token, "expires_at_ms": self.utc() + TICKET_SECONDS * 1000}

    def consume(self, socket: WebSocket, channel: Channel, config: Config) -> str:
        if sum(len(k) + len(v) + 4 for k, v in socket.scope["headers"]) > HEADER_LIMIT:
            raise HttpError(413, "PAYLOAD_TOO_LARGE", "The request headers exceed the supported size.")
        authorize_address(socket, config, origin_required=True)
        if socket.scope["query_string"]:
            raise HttpError(422, "VALIDATION_FAILED", "Socket URLs do not accept query parameters.")
        self.requires_profile()
        offers = [offer.strip() for line in socket.headers.getlist("sec-websocket-protocol")
                  for offer in line.split(",")]
        tickets = [offer.removeprefix(TICKET_PREFIX) for offer in offers if offer.startswith(TICKET_PREFIX)]
        versions = [offer for offer in offers if not offer.startswith(TICKET_PREFIX)]
        if versions != [PROTOCOL]:
            raise HttpError(503, "PROTOCOL_UNSUPPORTED", "Offer exactly one supported WebSocket application protocol.")
        error = HttpError(403, "TICKET_INVALID", "Obtain a current ticket for this channel.")
        if len(tickets) != 1 or not TOKEN.fullmatch(tickets[0]):
            raise error
        key = sha256(tickets[0].encode("ascii")).digest()
        ticket = self._tickets.get(key)
        if ticket is None or ticket.channel != channel:
            raise error
        if ticket.expires <= self.monotonic():
            del self._tickets[key]
            raise HttpError(403, "TICKET_EXPIRED", "The WebSocket ticket expired.")
        if ticket.consumed:
            raise HttpError(403, "TICKET_CONSUMED", "The WebSocket ticket was already used.")
        if not self.touch_client(ticket.client):
            raise error
        ticket.consumed = True
        return ticket.client

    def component_cause(self, name: str) -> str | None:
        if not self.profile:
            return self.unavailable_code if name == "QualificationProfile" else "NOT_READY"
        if name == "QualificationProfile":
            return None
        now = self.monotonic()
        if name == "Storage":
            return None if self._storage_ready and now < self._storage_until else "STORAGE_UNAVAILABLE"
        if name == "RobotVideo":
            frame = self._frames.get("robot")
            live = "robot" in self._live_sources and frame and frame.age(now) < self.profile.bound("capture_age_limit_ms")
            return None if live else "NOT_READY"
        if (name == "Command" and self._motion and
                (self.failure_for(self.safety_session, "CommandUnavailable") or
                 self.failure_for(self.safety_session, "CommandExpired")) and not self._motion.command_ready()):
            return "NOT_READY"
        if name == "AI" and self.simulation and self.simulation.inference and now >= self._inference_until:
            return "NOT_READY"
        if name in ("Webcam", "Controller") and now >= self._input_deadlines.get(name, 0):
            return "NOT_READY"
        return None if self._readiness.get(name, False) else "NOT_READY"

    def remove(self, connection: Connection, code: int) -> None:
        key = (connection.client, connection.channel)
        connection.end(code)
        if self._connections.get(key) is connection:
            if connection.channel == "events":
                self.touch_client(connection.client)
            del self._connections[key]
            self._invalidate_channel(*key)

    def _invalidate_channel(self, client: str, channel: Channel, reason: str | None = None) -> None:
        if self._lease and self._lease.client == client:
            if channel == "events":
                self._revoke(reason or "EventConnectionLost")
            elif channel == "robot-video":
                self._revoke(reason or "RobotVideoLost")
            elif channel == "webcam-video" and self._selected_input() == "Webcam":
                self._revoke("InputUnavailable")
        self.invalidate(client, channel)

    def _selected_input(self) -> str | None:
        if not self._active_mode or not self._active_session:
            return None
        return "Webcam" if self._active_mode == "Gestures" else "Controller"

    def _envelope(self, kind: EventKind, payload: object) -> bytes:
        session = (payload.get("session") if kind == "session_changed" and isinstance(payload, dict)
                   else self._projection.get("active_session") if self._projection and kind in ("snapshot", "recovery_changed") else None)
        return canonical_json({
            "protocol_version": 1, "backend_boot_id": self.boot, "event_seq": self.sequence,
            "session_id": session["id"] if isinstance(session, dict) else None,
            "session_revision": session["revision"] if isinstance(session, dict) else None, "type": kind,
            "occurred_at_ms": self.utc(), "payload": payload,
        }).encode("utf-8")

    def _publish(self, kind: EventKind, payload: object, *, ordered: bool = True) -> None:
        profile = self.profile
        if self._closed or profile is None:
            return
        if ordered:
            if self.sequence >= SAFE_INTEGER:
                self.unavailable_code = "COUNTER_EXHAUSTED"
                self.stop(1011)
                return
            self.sequence += 1
        if self._projection is not None:
            self._projection["event_seq"] = self.sequence
        message = self._envelope(kind, payload) if kind not in ("snapshot", "readiness_changed") else None
        closing = []
        for connection in tuple(self._connections.values()):
            if connection.channel == "events":
                data = message or self._client_message(kind, connection.client)
                code = connection.queue(data, profile)
                if code is not None:
                    closing.append((connection, code))
        # Queue the current sequence everywhere before a slow owner is revoked and publishes the next one.
        for connection, code in closing:
            self.remove(connection, code)

    def _client_message(self, kind: EventKind, client: str) -> bytes:
        assert self._projection is not None
        state = self._public_snapshot(self._projection, client)
        payload = {key: state[key] for key in ("readiness", "runtime")} if kind == "readiness_changed" else state
        return self._envelope(kind, payload)

    def _publish_snapshot(self) -> None:
        if self._projection is not None:
            self._publish("snapshot", None)

    async def _refresh_projection(self) -> Projection | None:
        # The caller holds _projection_lock for the read, commit and initial subscription.
        for _ in range(3):
            revision = self._projection_revision
            next_state = await self.project()
            if revision == self._projection_revision:
                break
        else:
            return None
        if next_state is None or self._closed:
            return None
        before = self._projection
        # The writer can become visible to a read just before its main-loop commit publication.
        if self._starting_session and next_state["session_id"] == self._starting_session:
            return before
        retention = cast(Projection, next_state["retention"])
        if retention["settings"] is None:
            if before is None:
                return None
            retention["settings"] = cast(Projection, before["retention"])["settings"]
        next_state["event_seq"] = self.sequence
        self._projection = next_state
        session = next_state["active_session"]
        next_state["failures"] = self.failures_for(cast(str | None, next_state["session_id"]))
        if isinstance(session, dict):
            self.search_committed(session)
        elif not next_state["storage_problem"]:
            if self._active_session:
                self.search_ended(self._active_session)
            self._active_session = self._active_owner = None
            self.active_revision = None
        if self._pause_required_for is not None and not next_state["storage_problem"] and (
            next_state["session_id"] != self._pause_required_for
            or (isinstance(session, dict) and session["state"] == "Paused")
        ):
            self._pause_required_for = None
        if before is None:
            return next_state
        invalid = ("ActiveSessionChanged" if self._lease and self._lease.session != next_state["session_id"] else
                   "StorageUnavailable" if next_state["storage_problem"] and not before["storage_problem"] else None)
        if self._lease and invalid:
            self._revoke(invalid)
        elif before["active_session"] != next_state["active_session"] or before["active_object"] != next_state["active_object"]:
            self._publish_snapshot()
        elif any(before[key] != next_state[key] for key in ("readiness", "runtime", "eligible_target")):
            self._publish("readiness_changed", None)
        if before["retention"] != next_state["retention"]:
            self._publish("retention_changed", {"retention": next_state["retention"], "operation": None})
        if next_state["storage_problem"] and next_state["storage_problem"] != before["storage_problem"]:
            self._publish("storage_fault", {
                "code": "STORAGE_UNAVAILABLE", "message": "Managed storage is unavailable.", "operation": None,
                "blocked_capabilities": ["Register", "Start", "Resume", "Review", "RetentionChange"],
                "deletion": retention["deletion"], "runtime": self._runtime(next_state),
            })
        if before["operations"] != next_state["operations"] or before["failures"] != next_state["failures"]:
            if not self._closed:
                self._publish_snapshot()
        return next_state

    def effective_state(self, state: str | None) -> str:
        if state == "Searching" and self._pause_required_for is not None and self._pause_required_for == self._active_session:
            return "Paused"
        return state or "Idle"

    def failures_for(self, session: str | None) -> list[Projection]:
        return [failure for failure in self._failures.values() if failure["session_id"] == session]

    def failure_for(self, session: str | None, cause: str) -> Projection | None:
        identity = self._outstanding.get((session, cause))
        return self._failures.get(identity) if identity else None

    def record_failure(self, cause: str, session: str | None, *, publish: bool = True) -> Projection:
        if session is not None and session == self.safety_session:
            self._pause_required_for = session
        if previous := self.failure_for(session, cause):
            return previous
        identity = uuid4().hex
        failure: Projection = {"failure_id": identity, "session_id": session, "cause": cause,
                               "observed_at_ms": self.utc(), "restored": False, "acknowledged": False}
        self._outstanding[session, cause] = identity
        self._failures[identity] = failure
        if session is not None and cause != "EmergencyStop":
            self.on_failure_changed(failure)
        if publish:
            self._publish_failures()
        return failure

    def _publish_failures(self) -> None:
        if self._projection is not None:
            failures = self.failures_for(cast(str | None, self._projection["session_id"]))
            self._projection["failures"] = failures
            self._publish("recovery_changed", {"failures": failures, "runtime": self._runtime(self._projection)})

    def _restore_failures(self) -> None:
        lease = self._lease
        workspace = bool(lease and lease.workspace)
        displayed = bool(workspace and lease and lease.displayed)
        available = {
            "WorkspaceDisconnected": workspace, "WorkspaceHidden": workspace, "WorkspaceUnfocused": workspace,
            "WorkspaceUnusable": workspace, "HeartbeatExpired": workspace, "DisplayStale": displayed,
            "ProtocolMismatch": workspace, "RobotVideoUnavailable": self.component_cause("RobotVideo") is None,
            "CameraEpochChanged": displayed,
            "InputUnavailable": self.component_cause(self._selected_input() or "Webcam") is None,
            "CommandExpired": self.component_cause("Command") is None,
            "CommandUnavailable": self.component_cause("Command") is None,
            "AIUnavailable": self.component_cause("AI") is None,
            "StorageFault": self.component_cause("Storage") is None,
        }
        changed = False
        for key, identity in tuple(self._outstanding.items()):
            session, cause = key
            if not available.get(cause):
                continue
            del self._outstanding[key]
            if session is None:
                del self._failures[identity]
            else:
                failure = {**self._failures[identity], "restored": True}
                self._failures[identity] = failure
                self.on_failure_changed(failure)
            changed = True
        if changed:
            self._publish_failures()

    @staticmethod
    def _project_operation(state: Projection, operation: Projection) -> bool:
        identity = operation["action_id"], operation["request_id"]
        operations = [entry for entry in cast(list[Projection], state["operations"])
                      if (entry["action_id"], entry["request_id"]) != identity]
        operations.append(operation)
        pending = [entry for entry in operations if entry["persistence"] == "Pending"]
        completed = [entry for entry in operations if entry["persistence"] != "Pending"]
        state["operations"] = pending + completed[-64:]
        return bool(pending)

    def operation_changed(self, session_id: str, operation: Projection) -> None:
        if self._projection is None:
            return
        self._projection_revision += 1
        current = self._projection["active_session"]
        runtime = cast(Projection, self._projection["runtime"])
        runtime["persistence_pending"] = self._project_operation(self._projection, operation)
        if isinstance(current, dict) and current["id"] == session_id:
            error = operation["error"]
            if isinstance(error, dict) and error["code"] == "STORAGE_UNAVAILABLE":
                retention = cast(Projection, self._projection["retention"])
                self._publish("storage_fault", {
                    "code": "STORAGE_UNAVAILABLE", "message": "The search could not be saved.",
                    "operation": operation, "blocked_capabilities": ["Register", "Start", "Resume", "Review", "RetentionChange"],
                    "deletion": retention["deletion"], "runtime": self._runtime(self._projection),
                })
            else:
                self._publish("session_changed", {"session": current, "operation": operation,
                                                  "runtime": self._runtime(self._projection)})
        else:
            self._publish_snapshot()

    def publish_search_commit(
        self, session: Projection, operation: Projection | None, target: Projection | None, pending: bool,
    ) -> None:
        self.search_committed(session)
        state = self._projection
        if state is None:
            return
        self._projection_revision += 1
        ended = session["state"] == "Ended"
        target = target or cast(Projection | None, state["active_object"])
        if not ended and (target is None or target["id"] != session["object_id"]):
            # Receipt recovery can establish the commit before an eligible owner projection is available.
            return
        if operation is not None:
            self._project_operation(state, operation)
        state.update(active_session=None if ended else session, active_object=None if ended else target,
                     session_id=None if ended else session["id"],
                     failures=self.failures_for(None if ended else str(session["id"])))
        runtime = cast(Projection, state["runtime"])
        runtime.update(effective_session_state=None if ended else session["state"], persistence_pending=pending)
        retention = cast(Projection, state["retention"])
        retention.update(active_object_expires_at_ms=target["expires_at_ms"] if target and not ended else None,
                         active_object_grace=bool(target and not ended and target["retention_grace"]))
        if self._pause_required_for == session["id"] and session["state"] == "Paused":
            self._pause_required_for = None
        # The full projection introduces a new owner or lease generation before the typed completion.
        self._publish_snapshot()
        self._publish("session_changed", {"session": session, "operation": operation, "runtime": self._runtime(state)})

    def _runtime(self, state: Projection) -> Projection:
        runtime = {**cast(Projection, state["runtime"]), "control_generation": self._generation,
                   "motion_permission": self._motion.permission if self._motion else "Disarmed"}
        if self._pause_required_for == state["session_id"] and runtime["effective_session_state"] == "Searching":
            runtime["effective_session_state"] = "Paused"
            runtime["persistence_pending"] = True
        return runtime

    def _public_snapshot(self, projection: Projection, client: str | None) -> Projection:
        state = {key: value for key, value in projection.items()
                 if key not in ("storage_problem", "eligible_target", "session_id")}
        lease = self._lease
        owns = lease is not None and lease.client == client
        readiness = cast(Projection, state["readiness"])
        live = {"Workspace": bool(owns and lease and lease.workspace),
                "DisplayedRobotVideo": bool(owns and lease and lease.displayed),
                **{name: self.component_cause(name) is None for name in
                   ("Webcam", "Controller", "RobotVideo", "Command", "AI")}}
        components = [
            {"component": name, "status": "Ready" if live[name] else "Unavailable",
             "cause_codes": [] if live[name] else ["NOT_READY"]}
            if (name := str(component["component"])) in live else component
            for component in cast(list[Projection], readiness["components"])
        ]
        statuses = {component["component"]: component["status"] == "Ready" for component in components}
        shared = (owns and projection["session_id"] is None and bool(projection["eligible_target"])
                  and all(ready for name, ready in statuses.items() if name not in ("Webcam", "Controller")))
        state["readiness"] = {**readiness, "components": components,
                              "can_start": {"Gestures": shared and statuses["Webcam"],
                                            "Controller": shared and statuses["Controller"]}}
        state["runtime"] = self._runtime(projection)
        state["failures"] = self.failures_for(cast(str | None, projection["session_id"]))
        if self._proximity:
            state["proximity"] = self._proximity.payload
        state["lease"] = public_lease(lease.client if lease else None, self._generation,
                                      self._can_acquire(client) and not self.request_at_capacity())
        return state

    async def snapshot(self, client: str | None = None) -> Projection | None:
        async with self._projection_lock:
            self._expire_lease(self.monotonic())
            state = await self._refresh_projection()
            self._expire_lease(self.monotonic())
            return self._public_snapshot(state, client) if state is not None else None

    async def maintain_projection(self) -> None:
        while not self._closed:
            self.expire_clients()
            if any(channel == "events" for _, channel in self._connections):
                await self.snapshot()
            await asyncio.sleep(PROJECTION_INTERVAL)

    def _check_capture(self, source: Source, capture: Capture, previous: Frame | None, now: float,
                       profile: QualificationProfile) -> Frame | None:
        if (not capture_identity_valid(capture) or not math.isfinite(capture.observed_at)
                or capture.observed_at > now or not dimensions_allowed(profile, capture.width, capture.height)
                or len(capture.jpeg) + 4 >= profile.bound("max_frame_bytes")
                or capture.age_ms + (now - capture.observed_at) * 1000 >= profile.bound("capture_age_limit_ms")):
            return None
        frame = Frame(token_urlsafe(18), capture)
        if frame.header(source, now, self.utc(), profile) is None:
            return None
        if previous:
            old = previous.capture
            if old.stream_epoch == capture.stream_epoch and (
                old.clock_epoch != capture.clock_epoch or old.sequence >= capture.sequence
                or old.source_us >= capture.source_us
            ):
                return None
            # Static scene bytes have already been decoded and checked.
            if capture.jpeg is old.jpeg and (capture.width, capture.height) == (old.width, old.height):
                return frame
        try:
            read_sample(capture.jpeg, profile, (capture.width, capture.height))
        except (OSError, ValueError, Image.DecompressionBombError):
            return None
        return frame

    async def capture(self) -> None:
        simulation = self.simulation
        if simulation is None:
            return
        profile = simulation.profile
        deadline = profile.bound("input_sample_deadline_ms") / 1000
        decoding: dict[Source, asyncio.Task[None]] = {}
        try:
            while not self._closed:
                sampled_at, scope = self.monotonic(), self._input_scope()
                try:
                    observation = await asyncio.to_thread(simulation.adapter.observe, sampled_at, scope)
                except (OSError, ValueError):
                    self._revoke("ProtocolMismatch")
                    self._set_readiness(dict.fromkeys(PATH_FAILURES.keys() - {"Storage"}, False))
                    await asyncio.sleep(CAPTURE_INTERVAL)
                    continue
                now = self.monotonic()
                self._expire_lease(now)
                for source, capture in zip(SOURCES, (observation.robot, observation.webcam), strict=True):
                    pending = decoding.get(source)
                    if capture is None:
                        if pending:
                            pending.cancel()
                        self._observe_source(source, None, None, now, profile)
                    elif pending is None or pending.done():
                        decoding[source] = asyncio.create_task(self._decode_source(source, capture, profile))
                for name, reported_at, sample in (
                    ("Controller", observation.controller_sample_at, observation.controller_input),
                    ("Webcam", observation.gesture_sample_at, observation.gesture_input),
                ):
                    at = reported_at
                    if scope is not None and name == self._selected_input():
                        if scope != self._input_scope():
                            continue
                        if sample is None or sample.scope != scope:
                            if at is not None and now - at < deadline:
                                # An invalid identity cannot refresh the last accepted deadline.
                                continue
                        else:
                            at = min(sample.at, at) if at is not None else None
                    if at is not None and math.isfinite(at) and at <= now:
                        self._input_deadlines[name] = at + deadline
                    else:
                        self._input_deadlines.pop(name, None)
                self._set_readiness({
                    "Command": observation.command, "AI": observation.inference,
                    "Controller": observation.controller and now < self._input_deadlines.get("Controller", now),
                    "RobotVideo": "robot" in self._live_sources,
                    "Webcam": "webcam" in self._live_sources and now < self._input_deadlines.get("Webcam", now),
                })
                motion = self._motion
                if motion and scope and scope == self._input_scope():
                    selected = self._selected_input()
                    sample = observation.gesture_input if selected == "Webcam" else observation.controller_input
                    # Circle is routed through the same latch even after a manual Pause.
                    circle = bool(selected == "Controller" and sample and sample.scope == scope
                                  and sample.intent == "emergency" and 0 <= now - sample.at < deadline)
                    if circle:
                        if not self._circle_held:
                            self.on_simulated_emergency()
                    elif scope == self._motion_scope():
                        if lost := motion.loss(now):
                            self._revoke(lost)
                        else:
                            prior = motion.permission
                            motion.accept(scope, sample, now)
                            lease = self._lease
                            assert lease is not None
                            if ((prior == "Armed" and motion.permission != "Armed") or
                                    (motion.permission == "Arming" and not lease.motion_generation)):
                                self._rotate_motion_generation()
                    self._circle_held = circle
                elif scope is None:
                    self._circle_held = False
                self._evaluate_motion(self.monotonic())
                self._restore_failures()
                if self._proximity:
                    before = self._proximity.payload
                    self._proximity.observe(observation.proximity, now, self.utc())
                    self._publish_proximity(before)
                await asyncio.sleep(min(CAPTURE_INTERVAL, deadline / 2))
        finally:
            if self._motion:
                self._motion.stop("AdapterStopped")
            for pending in decoding.values():
                pending.cancel()
            await asyncio.gather(*decoding.values(), return_exceptions=True)

    async def _decode_source(self, source: Source, capture: Capture, profile: QualificationProfile) -> None:
        frame = await asyncio.to_thread(
            self._check_capture, source, capture, self._frames.get(source), self.monotonic(), profile,
        )
        now = self.monotonic()
        if frame is not None and frame.age(now) >= profile.bound("capture_age_limit_ms"):
            frame = None
        self._observe_source(source, capture, frame, now, profile)
        self._set_readiness({
            **self._readiness,
            "RobotVideo": "robot" in self._live_sources,
            "Webcam": "webcam" in self._live_sources and now < self._input_deadlines.get("Webcam", now),
        })

    async def maintain_inference(self) -> None:
        simulation = self.simulation
        assert simulation and simulation.inference
        limit = simulation.profile.bound("capture_age_limit_ms") / 1000
        while not self._closed:
            frame = self._frames.get("robot")
            scope = self._motion_scope()
            if frame and "robot" in self._live_sources:
                sample = InferenceSample(scope, frame.id if scope else None, frame.capture if scope else None)
                started = self.monotonic()
                try:
                    available = await asyncio.to_thread(simulation.inference, sample)
                except (OSError, ValueError):
                    available = False
                if scope == self._motion_scope() and started + limit > self.monotonic():
                    self._inference_until = started + limit if available else 0
            await asyncio.sleep(CAPTURE_INTERVAL)

    def observe_storage(self, available: bool, started: float) -> None:
        if not self.profile:
            return
        was_ready = self._storage_ready
        self._storage_ready = available
        self._storage_until = started + self.profile.bound("capture_age_limit_ms") / 1000
        if was_ready and not available:
            self._path_lost("Storage")
        if was_ready != available and self._projection is not None:
            self._publish("readiness_changed", None)

    def _publish_proximity(self, before: Projection) -> None:
        if self._proximity and self._projection is not None and before != self._proximity.payload:
            self._publish("proximity_warning_changed", {"proximity": self._proximity.payload})

    def _path_lost(self, name: str) -> None:
        cause = PATH_FAILURES[name]
        if self._lease and (self.safety_session is not None or name in ("Command", "AI", "Storage")):
            self._revoke(cause)
        elif self.safety_session is not None:
            self.record_failure(cause, self.safety_session)

    def _set_readiness(self, observations: dict[str, bool]) -> None:
        if observations == self._readiness:
            return
        previous = self._readiness
        self._readiness = observations
        for name in ("Command", "AI", self._selected_input()):
            if name and previous.get(name) and not observations[name]:
                self._path_lost(name)
        if self._projection is not None:
            current = cast(Projection, self._projection["readiness"])
            components = cast(list[Projection], current["components"])
            updated = {**current, "components": [
                {"component": name, "status": "Ready" if observations[name] else "Unavailable",
                 "cause_codes": [] if observations[name] else ["NOT_READY"]}
                if (name := str(component["component"])) in observations else component
                for component in components
            ]}
            if updated != current:
                self._projection["readiness"] = updated
                self._publish("readiness_changed", None)

    def _observe_source(self, source: Source, capture: Capture | None, frame: Frame | None, now: float,
                        profile: QualificationProfile) -> None:
        old = self._frames.get(source)
        channel: Channel = "robot-video" if source == "robot" else "webcam-video"
        if frame:
            self._frames[source] = frame
            self._live_sources.add(source)
            epoch_changed = bool(old and old.capture.stream_epoch != frame.capture.stream_epoch)
            if epoch_changed and source == "robot":
                if self._lease:
                    self._revoke("CameraEpochChanged")
                elif self.safety_session is not None:
                    self.record_failure("CameraEpochChanged", self.safety_session)
            for connection in tuple(self._connections.values()):
                if connection.channel != channel:
                    continue
                if epoch_changed:
                    self.remove(connection, 1008)
                else:
                    connection.waiting = frame
                    connection.ready.set()
        elif (old is None or capture != old.capture or now < old.capture.observed_at
              or old.age(now) >= profile.bound("capture_age_limit_ms")):
            was_live = source in self._live_sources
            self._live_sources.discard(source)
            if was_live and source == "robot" and self._lease is None:
                self._path_lost("RobotVideo")
            for connection in tuple(self._connections.values()):
                if connection.channel == channel:
                    connection.waiting = None
                    connection.issued.clear()
                    if was_live:
                        connection.video_generation += 1
                        self._invalidate_channel(connection.client, channel)

    def object_removed(self, owner: str) -> None:
        if self._closed or not self.profile:
            return
        self._projection_revision += 1
        if self._projection is not None:
            if self._projection["session_id"] is not None and (
                isinstance(active := self._projection["active_session"], dict) and active["object_id"] == owner
            ):
                self._projection.update(active_object=None, active_session=None, session_id=None, failures=[])
                runtime = cast(Projection, self._projection["runtime"])
                runtime["effective_session_state"] = None
                retention = cast(Projection, self._projection["retention"])
                retention.update(active_object_expires_at_ms=None, active_object_grace=False)
            operations = cast(list[Projection], self._projection["operations"])
            self._projection["operations"] = [
                operation for operation in operations if _operation_owner(operation) != owner
            ]
        # A queued snapshot may still contain eligible-when-projected record data.
        marker = canonical_json(owner).encode("utf-8")
        for connection in tuple(self._connections.values()):
            if any(marker in message for message in connection.events):
                self.remove(connection, 1008)
        self._publish("object_removed", {"object_id": owner, "reason": "Expired"})

    def stop(self, code: int = 1000) -> None:
        self._closed = True
        self._revoke("ServiceStopped")
        if self._fixture_sink:
            self._fixture_sink.close()
        for connection in tuple(self._connections.values()):
            self.remove(connection, code)
        self._tickets.clear()

    async def serve(self, socket: WebSocket, channel: Channel, config: Config) -> None:
        try:
            client = self.consume(socket, channel, config)
            profile = self.requires_profile()
        except HttpError as error:
            response = error.response()
            response.headers["Cache-Control"] = "no-store"
            await socket.send_denial_response(response)
            return
        connection = Connection(client, channel, asyncio.get_running_loop().create_future())
        try:
            if channel == "events":
                async with self._projection_lock:
                    state = await self._refresh_projection()
                    if state is None:
                        response = HttpError(503, "INITIALIZING", "Checking backend readiness.", True).response()
                        response.headers["Cache-Control"] = "no-store"
                        await socket.send_denial_response(response)
                        return
                    await socket.accept(subprotocol=PROTOCOL)
                    if self._closed or not self.touch_client(client):
                        await socket.close(code=1008)
                        return
                    # Snapshot serialization and registration have no scheduling point between them.
                    self._replace(connection)
                    code = connection.queue(self._client_message("snapshot", client), profile)
                    if code is not None:
                        self.remove(connection, code)
            else:
                await socket.accept(subprotocol=PROTOCOL)
                if self._closed or not self.touch_client(client):
                    await socket.close(code=1008)
                    return
                self._replace(connection)
                source: Source = "robot" if channel == "robot-video" else "webcam"
                if source in self._live_sources:
                    connection.waiting = self._frames[source]
                    connection.ready.set()
            await self._deliver(socket, connection, profile)
        except (WebSocketDisconnect, OSError):
            pass
        finally:
            self.remove(connection, 1000)

    def _replace(self, connection: Connection) -> None:
        key = (connection.client, connection.channel)
        old = self._connections.get(key)
        if old:
            self.remove(old, 1008)
        self._connections[key] = connection

    async def _deliver(self, socket: WebSocket, connection: Connection, profile: QualificationProfile) -> None:
        sender = asyncio.create_task(self._send(socket, connection, profile))
        receiver = asyncio.create_task(self._receive(socket, connection, profile))
        code: int | None = 1011
        try:
            done, _ = await asyncio.wait((sender, receiver, connection.close), return_when=asyncio.FIRST_COMPLETED)
            if connection.close in done:
                code = connection.close.result()
            elif receiver in done:
                code = receiver.result()
            elif sender in done:
                sender.result()
        except (WebSocketDisconnect, OSError):
            code = None
        finally:
            self.remove(connection, code or 1000)
            sender.cancel()
            receiver.cancel()
            await asyncio.gather(sender, receiver, return_exceptions=True)
        if code is not None:
            try:
                await socket.close(code=code)
            except (RuntimeError, WebSocketDisconnect, OSError):
                pass

    async def _send(self, socket: WebSocket, connection: Connection, profile: QualificationProfile) -> None:
        while not connection.close.done():
            await connection.ready.wait()
            if connection.close.done():
                return
            if connection.channel == "events":
                if connection.events:
                    data = connection.events.popleft()
                    connection.event_bytes -= len(data)
                    await socket.send_text(data.decode("utf-8"))
                    continue
            elif connection.waiting is not None:
                frame, connection.waiting = connection.waiting, None
                source: Source = "robot" if connection.channel == "robot-video" else "webcam"
                metadata = frame.header(source, self.monotonic(), self.utc(), profile)
                if metadata is not None:
                    generation = connection.video_generation
                    await socket.send_bytes(len(metadata).to_bytes(4, "big") + metadata + frame.capture.jpeg)
                    if source == "robot" and not connection.close.done() and generation == connection.video_generation:
                        self._track_frame(connection, frame, profile)
                continue
            connection.ready.clear()

    def _track_frame(self, connection: Connection, frame: Frame, profile: QualificationProfile) -> None:
        now = self.monotonic()
        limit = min(profile.bound("capture_age_limit_ms"), profile.bound("display_deadline_ms"))
        for ident, old in tuple(connection.issued.items()):
            if now >= old.retire_at:
                del connection.issued[ident]
        if frame.age(now) < limit and "robot" in self._live_sources:
            if len(connection.issued) >= MAX_ISSUED_FRAMES:
                del connection.issued[next(iter(connection.issued))]
            capture = frame.capture
            deadline = capture.observed_at + (limit - capture.age_ms) / 1000
            retired = capture.observed_at + (profile.bound("capture_age_limit_ms") - capture.age_ms) / 1000
            connection.issued[frame.id] = IssuedFrame(capture.stream_epoch, deadline, capture.observed_at, retired)

    def _heartbeat(self, connection: Connection, data: object, profile: QualificationProfile) -> bool:
        now = self.monotonic()
        self._expire_lease(now)
        lease = self._lease
        if not lease or (self._connections.get((connection.client, "events")) is not connection
                         or connection.client != lease.client):
            return False
        if (not isinstance(data, dict) or data.keys() != HEARTBEAT_FIELDS
                or data["type"] != "workspace_heartbeat" or type(data["protocol_version"]) is not int
                or data["protocol_version"] != 1 or data["backend_boot_id"] != self.boot
                or data["client_id"] != lease.client or not token(data["client_lease_id"])
                or not compare_digest(data["client_lease_id"], lease.secret)
                or (data["session_id"] != lease.session and not
                    (data["session_id"] is None and lease.setup_handoff))
                or not counter(data["control_generation"])
                or not counter(data["heartbeat_seq"])
                or (data["heartbeat_seq"] <= lease.heartbeat_seq if lease.heartbeat_seq else data["heartbeat_seq"] != 1)
                or any(type(data[flag]) is not bool for flag in WORKSPACE_FLAGS)):
            return False
        if data["control_generation"] != self._generation:
            # Old in-flight heartbeats cannot refresh either deadline during an owner handoff.
            return bool(data["control_generation"] == lease.previous_generation)
        indication = data["displayed_robot_frame"]
        setup_heartbeat = lease.setup_handoff and data["session_id"] is None
        for flag, reason in (("workspace_visible", "WorkspaceHidden"), ("workspace_focused", "WorkspaceUnfocused"),
                             ("workspace_operational", "WorkspaceUnusable")):
            if not data[flag]:
                self._revoke(reason)
                return True
        if indication is None and lease.displayed and lease.session and not setup_heartbeat:
            self._revoke("DisplayStale")
            return True
        if indication is not None:
            video = self._connections.get((connection.client, "robot-video"))
            if (not isinstance(indication, dict) or indication.keys() != {"frame_id", "stream_epoch"}
                    or not all(domain_id(value) for value in indication.values()) or video is None
                    or "robot" not in self._live_sources):
                return False
            frame = video.issued.get(indication["frame_id"])
            if frame is None or indication["stream_epoch"] != frame.stream_epoch:
                return False
            if now >= frame.display_deadline:
                self._revoke("DisplayStale")
                return True
            if lease.generation_started is not None and frame.captured_at < lease.generation_started:
                return True
            # The deadline is anchored to acquisition, so receiving the same identity never extends it.
            if not setup_heartbeat:
                lease.display_deadline = frame.display_deadline
        changed = not lease.workspace or lease.displayed != (indication is not None)
        lease.heartbeat_seq = data["heartbeat_seq"]
        if setup_heartbeat:
            # An in-flight setup heartbeat cannot renew the newly bound session.
            return True
        lease.setup_handoff = False
        lease.previous_generation = None
        lease.heartbeat_deadline = now + profile.bound("heartbeat_deadline_ms") / 1000
        lease.workspace = True
        lease.displayed = indication is not None
        if changed and self._projection is not None:
            self._publish("readiness_changed", None)
        return True

    async def _receive(self, socket: WebSocket, connection: Connection, profile: QualificationProfile) -> int | None:
        while not connection.close.done():
            message = await socket.receive()
            if message["type"] == "websocket.disconnect":
                if message.get("code") in (1002, 1003, 1007, 1009):
                    self._protocol_failure(connection)
                return None
            value = message.get("text") if connection.channel == "events" else message.get("bytes")
            if value is None:
                self._protocol_failure(connection)
                return 1003
            size = len(value.encode("utf-8")) if isinstance(value, str) else len(value)
            if size > profile.bound("max_client_message_bytes"):
                self._protocol_failure(connection)
                return 1009
            if not isinstance(value, str):
                self._protocol_failure(connection)
                return 1008
            try:
                data = json.loads(value, object_pairs_hook=json_fields, parse_constant=_reject_json_constant)
            except (ValueError, RecursionError):
                self._protocol_failure(connection)
                return 1007
            except HttpError:
                self._protocol_failure(connection)
                return 1008
            if not self._heartbeat(connection, data, profile):
                self._protocol_failure(connection)
                return 1008
        return None

    def _protocol_failure(self, connection: Connection) -> None:
        if self._lease and self._lease.client == connection.client and (
            self._connections.get((connection.client, connection.channel)) is connection
            and (connection.channel in ("events", "robot-video") or self._selected_input() == "Webcam")
        ):
            self._revoke("ProtocolMismatch")


def _operation_owner(operation: Projection) -> object:
    result = operation.get("result")
    obj = result.get("object") if isinstance(result, dict) else None
    return obj.get("id") if isinstance(obj, dict) else None


def _reject_json_constant(_: str) -> None:
    raise ValueError("Nonfinite JSON")


async def ticket_request(request: Request, realtime: Realtime) -> Projection:
    data = await read_json(request)
    if not isinstance(data, dict) or set(data) != {"client_id", "channel"}:
        raise HttpError(422, "VALIDATION_FAILED", "Provide client_id and a supported WebSocket channel.")
    client, channel = data["client_id"], data["channel"]
    if not isinstance(client, str) or not re.fullmatch(DOMAIN_ID, client) or (
        not isinstance(channel, str) or channel not in CHANNELS.values()
    ):
        raise HttpError(422, "VALIDATION_FAILED", "Provide client_id and a supported WebSocket channel.")
    offered = header(request, "x-app-client-id", 403, "CLIENT_INVALID")
    if offered is not None and offered != client:
        raise HttpError(422, "VALIDATION_FAILED", "The header and body client IDs must match.")
    return realtime.issue(client, cast(Channel, channel))
