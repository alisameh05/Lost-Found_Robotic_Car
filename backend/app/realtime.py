"""Boot-scoped observational transport. All authority changes run on the service event loop."""

import asyncio
import json
import math
import re
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from hashlib import sha256
from secrets import token_urlsafe
from typing import Literal, cast

from fastapi import Request, WebSocket
from PIL import Image
from starlette.websockets import WebSocketDisconnect

from .config import Config
from .http import DOMAIN_ID, HEADER_LIMIT, HttpError, authorize_address, header, json_fields, read_json
from .registration_input import SAFE_INTEGER, canonical_json
from .simulation import (
    SOURCES,
    Capture,
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
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
TICKET_SECONDS = 10
MAX_OUTSTANDING = 32
# Keep recent consumed entries distinguishable from unknown tickets without an unbounded replay cache.
MAX_KNOWN_TICKETS = 256
CAPTURE_INTERVAL = 0.1
PROJECTION_INTERVAL = 0.25
Projection = dict[str, object]
EventKind = Literal["snapshot", "readiness_changed", "retention_changed", "storage_fault", "object_removed"]


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


@dataclass
class Connection:
    client: str
    channel: Channel
    close: asyncio.Future[int]
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    events: deque[bytes] = field(default_factory=deque)
    event_bytes: int = 0
    waiting: Frame | None = None

    def end(self, code: int) -> None:
        if not self.close.done():
            self.close.set_result(code)
        self.events.clear()
        self.event_bytes = 0
        self.waiting = None

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
        invalidate: Callable[[str, Channel], None],
    ):
        self.simulation = simulation
        self.unavailable_code = unavailable_code
        self.boot = boot
        self.monotonic = monotonic
        self.utc = utc
        self.touch_client = touch_client
        self.project = project
        self.invalidate = invalidate
        self.sequence = 1
        self._tickets: dict[bytes, Ticket] = {}
        self._connections: dict[tuple[str, Channel], Connection] = {}
        self._frames: dict[Source, Frame] = {}
        self._live_sources: set[Source] = set()
        self._readiness: dict[str, bool] = {}
        self._projection: Projection | None = None
        self._projection_lock = asyncio.Lock()
        self._closed = False

    @property
    def profile(self) -> QualificationProfile | None:
        return self.simulation.profile if self.simulation else None

    def requires_profile(self) -> QualificationProfile:
        if not self.profile or self._closed:
            code = self.unavailable_code if not self.profile else "NOT_READY"
            raise HttpError(503, code, "A compatible backend simulation profile is unavailable.")
        return self.profile

    def client_has_events(self, client: str) -> bool:
        return (client, "events") in self._connections

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
        return None if self._readiness.get(name, False) else "NOT_READY"

    def remove(self, connection: Connection, code: int) -> None:
        key = (connection.client, connection.channel)
        if self._connections.get(key) is connection:
            self.invalidate(*key)
            if connection.channel == "events":
                self.touch_client(connection.client)
            del self._connections[key]
        connection.end(code)

    def _envelope(self, kind: EventKind, payload: object) -> bytes:
        return canonical_json({
            "protocol_version": 1, "backend_boot_id": self.boot, "event_seq": self.sequence,
            "session_id": None, "session_revision": None, "type": kind,
            "occurred_at_ms": self.utc(), "payload": payload,
        }).encode("utf-8")

    def _publish(self, kind: EventKind, payload: object, *, ordered: bool = True) -> None:
        profile = self.profile
        if self._closed or profile is None:
            return
        if ordered:
            if self.sequence >= SAFE_INTEGER:
                self.stop(1011)
                return
            self.sequence += 1
        if self._projection is not None:
            self._projection["event_seq"] = self.sequence
        message = self._envelope(kind, payload)
        for connection in tuple(self._connections.values()):
            if connection.channel == "events":
                code = connection.queue(message, profile)
                if code is not None:
                    self.remove(connection, code)

    async def _refresh_projection(self) -> Projection | None:
        # The caller holds _projection_lock for the read, commit and initial subscription.
        next_state = await self.project()
        if next_state is None or self._closed:
            return None
        before = self._projection
        retention = cast(Projection, next_state["retention"])
        if retention["settings"] is None:
            if before is None:
                return None
            retention["settings"] = cast(Projection, before["retention"])["settings"]
        next_state["event_seq"] = self.sequence
        self._projection = next_state
        if before is None:
            return next_state
        if before["readiness"] != next_state["readiness"] or before["runtime"] != next_state["runtime"]:
            self._publish("readiness_changed", {key: next_state[key] for key in ("readiness", "runtime")})
        if before["retention"] != next_state["retention"]:
            self._publish("retention_changed", {"retention": next_state["retention"], "operation": None})
        if next_state["storage_problem"] and next_state["storage_problem"] != before["storage_problem"]:
            self._publish("storage_fault", {
                "code": "STORAGE_UNAVAILABLE", "message": "Managed storage is unavailable.", "operation": None,
                "blocked_capabilities": ["Register", "Start", "Resume", "Review", "RetentionChange"],
                "deletion": retention["deletion"], "runtime": next_state["runtime"],
            })
        if before["operations"] != next_state["operations"]:
            if not self._closed:
                self._publish("snapshot", self._public_snapshot(next_state), ordered=False)
        return next_state

    @staticmethod
    def _public_snapshot(projection: Projection) -> Projection:
        return {key: value for key, value in projection.items() if key != "storage_problem"}

    async def snapshot(self) -> Projection | None:
        async with self._projection_lock:
            state = await self._refresh_projection()
            return self._public_snapshot(state) if state is not None else None

    async def maintain_projection(self) -> None:
        while not self._closed:
            if any(channel == "events" for _, channel in self._connections):
                await self.snapshot()
            await asyncio.sleep(PROJECTION_INTERVAL)

    def _check_capture(self, capture: Capture, previous: Frame | None, now: float,
                       profile: QualificationProfile) -> Frame | None:
        if (not capture_identity_valid(capture) or not math.isfinite(capture.observed_at)
                or capture.observed_at > now or not dimensions_allowed(profile, capture.width, capture.height)
                or len(capture.jpeg) + 4 >= profile.bound("max_frame_bytes")
                or capture.age_ms + (now - capture.observed_at) * 1000 >= profile.bound("capture_age_limit_ms")):
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
                return Frame(token_urlsafe(18), capture)
        try:
            read_sample(capture.jpeg, profile, (capture.width, capture.height))
        except (OSError, ValueError, Image.DecompressionBombError):
            return None
        return Frame(token_urlsafe(18), capture)

    async def capture(self) -> None:
        simulation = self.simulation
        if simulation is None:
            return
        while not self._closed:
            now = self.monotonic()
            observation = simulation.adapter.observe(now)
            for source, capture in zip(SOURCES, (observation.robot, observation.webcam), strict=True):
                self._observe_source(source, capture, now, simulation.profile)
            self._readiness = {
                "Command": observation.command, "Controller": observation.controller, "AI": observation.inference,
                "RobotVideo": "robot" in self._live_sources, "Webcam": "webcam" in self._live_sources,
            }
            await asyncio.sleep(CAPTURE_INTERVAL)

    def _observe_source(self, source: Source, capture: Capture | None, now: float,
                        profile: QualificationProfile) -> None:
        old = self._frames.get(source)
        frame = self._check_capture(capture, old, now, profile) if capture is not None else None
        channel: Channel = "robot-video" if source == "robot" else "webcam-video"
        if frame and frame.header(source, now, self.utc(), profile) is not None:
            self._frames[source] = frame
            self._live_sources.add(source)
            for connection in tuple(self._connections.values()):
                if connection.channel != channel:
                    continue
                if old and old.capture.stream_epoch != frame.capture.stream_epoch:
                    self.remove(connection, 1008)
                else:
                    connection.waiting = frame
                    connection.ready.set()
        elif capture is None or old is None or now < old.capture.observed_at or old.age(now) >= profile.bound("capture_age_limit_ms"):
            was_live = source in self._live_sources
            self._live_sources.discard(source)
            for connection in tuple(self._connections.values()):
                if connection.channel == channel:
                    connection.waiting = None
                    if was_live:
                        self.invalidate(connection.client, channel)

    def object_removed(self, owner: str) -> None:
        if not self._closed and self.profile:
            self._publish("object_removed", {"object_id": owner, "reason": "Expired"})

    def stop(self, code: int = 1000) -> None:
        self._closed = True
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
                    # Snapshot serialization and registration have no scheduling point between them.
                    self._replace(connection)
                    code = connection.queue(self._envelope("snapshot", self._public_snapshot(state)), profile)
                    if code is not None:
                        self.remove(connection, code)
            else:
                self._replace(connection)
                source: Source = "robot" if channel == "robot-video" else "webcam"
                if source in self._live_sources:
                    connection.waiting = self._frames[source]
                    connection.ready.set()
            await socket.accept(subprotocol=PROTOCOL)
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
        receiver = asyncio.create_task(self._receive(socket, connection.channel, profile))
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
                    await socket.send_bytes(len(metadata).to_bytes(4, "big") + metadata + frame.capture.jpeg)
                continue
            connection.ready.clear()

    @staticmethod
    async def _receive(socket: WebSocket, channel: Channel, profile: QualificationProfile) -> int | None:
        message = await socket.receive()
        if message["type"] == "websocket.disconnect":
            return None
        value = message.get("text") if channel == "events" else message.get("bytes")
        if value is None:
            return 1003
        size = len(value.encode("utf-8")) if isinstance(value, str) else len(value)
        if size > profile.bound("max_client_message_bytes"):
            return 1009
        if isinstance(value, str):
            try:
                json.loads(value, object_pairs_hook=json_fields, parse_constant=_reject_json_constant)
            except (ValueError, RecursionError):
                return 1007
            except HttpError:
                return 1008
        # There is no lease in the preview slice. Even a valid heartbeat is unauthorized.
        return 1008


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
