import asyncio
import re
import sqlite3
from collections import OrderedDict
from collections.abc import Callable, Collection
from dataclasses import dataclass, field, replace
from secrets import token_urlsafe
from time import monotonic
from typing import Literal

from .control import Revocation
from .http import HttpError
from .operations import MAX_ORDINARY_PENDING, MAX_TERMINAL, Operation, mutation
from .realtime import Channel, Realtime
from .reference_image import Reference, prepare_reference
from .registration_input import SAFE_INTEGER, Registration
from .retention_input import RetentionChange, RetentionProposal
from .sessions import SessionCoordinator
from .simulation import Simulation
from .storage import (
    HistoryKind,
    IncompatibleStorage,
    Inspection,
    Receipt,
    RecordsStorage,
    RetentionPreview,
    StorageRecoveryRequired,
    preview_stale,
    storage_unavailable,
)
from .unicode_search import casefold

CLIENT_IDLE_SECONDS = 30 * 60
CURSOR_LIFETIME_SECONDS = 30 * 60
MAX_CLIENTS = 64
MAX_CLIENT_CURSORS = 32
MAX_CURSORS = 1024
PREVIEW_SECONDS = 60
MAX_CLIENT_PREVIEWS = 32
MAX_PREVIEWS = 1024
MAX_QUEUED_REFERENCE_BYTES = 128 * 1024**2
DEFERRED_COMPONENTS = (
    "Command", "RobotVideo", "DisplayedRobotVideo", "Webcam", "Controller", "AI", "Workspace", "QualificationProfile",
)

@dataclass(frozen=True)
class CursorScope:
    boot_id: str
    client: str
    name: str
    status: str
    limit: int
    route: str
    parent: str | None


@dataclass
class Cursor:
    scope: CursorScope
    before: tuple[int, str]
    deadline: float
    readers: int = 0


class PageError(Exception):
    def __init__(self, reason: Literal["cursor_expired", "scope_mismatch", "capacity", "client_expired"]):
        super().__init__(reason)
        self.reason = reason


def registration_unknown() -> HttpError:
    return HttpError(500, "INTERNAL_ERROR", "The registration outcome is unknown. Retry the same request.", True)


@dataclass
class RecordsRuntime:
    storage: RecordsStorage
    boot_id: str = field(default_factory=lambda: token_urlsafe(24))
    capability: str = field(default_factory=lambda: token_urlsafe(32), repr=False)
    _clients: dict[str, float] = field(default_factory=dict, repr=False)
    _starting: bool = True
    _startup_fault: Inspection | None = None
    _admission: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _save: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _pending: dict[str, tuple[Operation, asyncio.Task[Receipt]]] = field(default_factory=dict, repr=False)
    _terminal: OrderedDict[str, Operation] = field(default_factory=OrderedDict, repr=False)
    _cursors: OrderedDict[str, Cursor] = field(default_factory=OrderedDict, repr=False)
    _previews: OrderedDict[str, RetentionPreview] = field(default_factory=OrderedDict, repr=False)
    _reserved_previews: set[str] = field(default_factory=set, repr=False)
    _stopping: bool = False
    _stop_retention: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _retention_changed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _retention_task: asyncio.Task[None] | None = field(default=None, repr=False)
    _queued_reference_bytes: int = 0
    sessions: SessionCoordinator | None = field(default=None, init=False, repr=False)
    realtime: Realtime | None = field(default=None, init=False, repr=False)

    def enable_realtime(self, simulation: Simulation | None, unavailable_code: str,
                        invalidate: Callable[[str, Channel], None],
                        on_control_revoked: Callable[[Revocation], None]) -> Realtime:
        def revoked(revocation: Revocation) -> None:
            if self.sessions:
                self.sessions.revoked(revocation)
            on_control_revoked(revocation)

        def failure_changed(failure: dict[str, object]) -> None:
            if self.sessions:
                self.sessions.path_failure_changed(failure)

        def emergency() -> None:
            if self.sessions:
                self.sessions.emergency_revoke()

        self.realtime = Realtime(simulation, unavailable_code, self.boot_id, self.storage.monotonic,
                                 self.storage.clock, self.touch_client, self.realtime_projection, invalidate,
                                 self.expire_clients, revoked, failure_changed, emergency)
        self.sessions = SessionCoordinator(self, self.realtime)
        self.realtime.on_candidate = self.sessions.admit_candidate
        return self.realtime

    def frontend_profile(self) -> dict[str, int | str] | None:
        profile = self.realtime.profile if self.realtime else None
        return dict(profile.frontend) if profile else None

    def client_time(self) -> float:
        return self.storage.monotonic() if self.realtime and self.realtime.profile else monotonic()

    def expire_clients(self) -> None:
        now = self.client_time()
        for client, touched in list(self._clients.items()):
            protected = self.realtime and self.realtime.client_is_live(client)
            if now - touched >= CLIENT_IDLE_SECONDS and not protected:
                del self._clients[client]
                if self.realtime:
                    self.realtime.expire_client(client)

    def bootstrap(self) -> dict[str, object] | None:
        self.expire_clients()
        now = self.client_time()
        if len(self._clients) >= MAX_CLIENTS:
            return None
        client = token_urlsafe(24)
        self._clients[client] = now
        return {
            "client_id": client, "backend_boot_id": self.boot_id, "capability": self.capability,
            "server_time_ms": self.storage.clock(), "qualification_profile": self.frontend_profile(),
        }

    def touch_client(self, client: str) -> bool:
        self.expire_clients()
        now = self.client_time()
        if client not in self._clients:
            return False
        self._clients[client] = now
        return True

    async def initialize(self) -> None:
        try:
            await asyncio.to_thread(self.storage.initialize)
        except IncompatibleStorage:
            self._startup_fault = Inspection(problem="The saved database schema is incompatible. Restore a compatible version.")
        except StorageRecoveryRequired as exc:
            self._startup_fault = Inspection(problem=str(exc))
        except (OSError, sqlite3.Error):
            self._startup_fault = Inspection(problem="Records storage could not initialize. Check local storage and restart.")
        finally:
            self._starting = False
        if self._startup_fault is None:
            self._retention_task = asyncio.create_task(self.maintain_retention())

    async def maintain_retention(self) -> None:
        loop = asyncio.get_running_loop()
        realtime = self.realtime

        def removed(owner: str) -> None:
            if realtime:
                loop.call_soon_threadsafe(self.hide_removed_owner, owner)

        while not self._stop_retention.is_set():
            self._retention_changed.clear()
            delay = await asyncio.to_thread(self.storage.service_retention, removed)
            await self.prune_terminal()
            try:
                await asyncio.wait_for(self._retention_changed.wait(), delay)
            except TimeoutError:
                pass

    async def inspect(self) -> Inspection | None:
        if self._starting:
            return None
        if self._startup_fault:
            return self._startup_fault
        return await asyncio.to_thread(self.storage.inspect, self.preparing())

    async def maintain_safety_storage(self, realtime: Realtime) -> None:
        while not self._stopping:
            started = realtime.monotonic()
            if not self._starting:
                healthy = not self._startup_fault and await asyncio.to_thread(
                    self.storage.safety_storage_healthy, self.preparing(),
                )
                realtime.observe_storage(healthy, started)
            await asyncio.sleep(0.1)

    def check_started(self) -> None:
        if self._starting:
            raise HttpError(503, "INITIALIZING", "Checking records storage. Retry when initialization finishes.", True)
        if self._startup_fault:
            raise storage_unavailable(self._startup_fault.problem or "Records storage could not initialize.")

    def ordinary_pending(self) -> int:
        return sum(op.slot == "ordinary" for op, _ in self._pending.values())

    def preparing(self) -> tuple[str, ...]:
        candidate = self.sessions.preparing_candidate if self.sessions else None
        return (*self._pending, candidate) if candidate else tuple(self._pending)

    async def page(self, route: str, client: str, query: dict[str, str], parent: str | None) -> dict[str, object]:
        scope = CursorScope(self.boot_id, client, casefold(query.get("name", "")), query.get("status", ""),
                            int(query.get("limit", "25")), route, parent)
        history: HistoryKind = "sessions" if route == "/objects/{id}/sessions" else "matches"
        try:
            cursor = self.resolve_cursor(scope, query.get("cursor"))
        except PageError:
            if parent is not None:
                await asyncio.to_thread(self.storage.recheck_eligibility, parent, session=history == "matches")
            raise
        before = cursor.before if cursor else (SAFE_INTEGER + 1, "")
        if cursor is not None:
            cursor.readers += 1
        try:
            if parent is None:
                items, boundary = await asyncio.to_thread(
                    self.storage.read_objects, scope.name, scope.status, scope.limit, before, self.preparing(),
                )
            else:
                items, boundary = await asyncio.to_thread(
                    self.storage.read_history, parent, history, scope.limit, before, self.preparing(),
                )
        finally:
            if cursor is not None:
                cursor.readers -= 1
        next_cursor = self.issue_cursor(scope, boundary) if boundary else None
        return {"items": items, "next_cursor": next_cursor}

    def resolve_cursor(self, scope: CursorScope, token: str | None) -> Cursor | None:
        self.prune_cursors(monotonic())
        if token is None:
            return None
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise PageError("scope_mismatch")
        cursor = self._cursors.get(token)
        if cursor is None:
            raise PageError("cursor_expired")
        if cursor.scope != scope:
            raise PageError("scope_mismatch")
        self._cursors.move_to_end(token)
        return cursor

    def prune_cursors(self, now: float) -> None:
        for token, cursor in tuple(self._cursors.items()):
            if cursor.deadline <= now or cursor.scope.client not in self._clients:
                del self._cursors[token]

    def issue_cursor(self, scope: CursorScope, boundary: tuple[int, str]) -> str:
        now = monotonic()
        self.expire_clients()
        self.prune_cursors(now)
        if scope.client not in self._clients:
            raise PageError("client_expired")
        owned = [token for token, cursor in self._cursors.items() if cursor.scope.client == scope.client]
        # Polling and going back to a still-current page preserve its existing token and deadline.
        for token in owned:
            cursor = self._cursors[token]
            if cursor.scope == scope and cursor.before == boundary:
                self._cursors.move_to_end(token)
                return token
        if len(owned) >= MAX_CLIENT_CURSORS:
            self.reclaim_cursor(owned)
        if len(self._cursors) >= MAX_CURSORS:
            self.reclaim_cursor(self._cursors)
        token = token_urlsafe(32)
        self._cursors[token] = Cursor(scope, boundary, now + CURSOR_LIFETIME_SECONDS)
        return token

    def reclaim_cursor(self, candidates: Collection[str]) -> None:
        for token in candidates:
            if not self._cursors[token].readers:
                del self._cursors[token]
                return
        raise PageError("capacity")

    def prune_previews(self, now: float) -> None:
        for token, preview in tuple(self._previews.items()):
            if preview.deadline <= now or preview.client not in self._clients:
                del self._previews[token]

    async def preview_retention(self, client: str, proposal: RetentionProposal) -> dict[str, object]:
        self.check_started()
        evaluated, started, impact = await asyncio.to_thread(self.storage.preview_retention, proposal, self.preparing())
        if not self.touch_client(client):
            raise HttpError(403, "CLIENT_INVALID", "Reconnect to obtain a current page identity.")
        now = self.storage.monotonic()
        self.prune_previews(now)
        if started + PREVIEW_SECONDS <= now:
            raise preview_stale()
        owned = [token for token, preview in self._previews.items() if preview.client == client]
        if len(owned) >= MAX_CLIENT_PREVIEWS:
            self.reclaim_preview(owned)
        if len(self._previews) >= MAX_PREVIEWS:
            self.reclaim_preview(self._previews)
        token = token_urlsafe(32)
        self._previews[token] = RetentionPreview(client, proposal, started + PREVIEW_SECONDS, impact)
        return {"preview_id": token, "settings_revision": proposal.expected_revision,
                "retention_days": proposal.retention_days, "evaluated_at_ms": evaluated,
                "expires_at_ms": evaluated + PREVIEW_SECONDS * 1000, "impact": impact.counts}

    def reclaim_preview(self, candidates: Collection[str]) -> None:
        oldest = next((token for token in candidates if token not in self._reserved_previews), None)
        if oldest is None:
            raise HttpError(503, "CAPACITY_REACHED", "All preview slots are in use. Retry when a save finishes.", True)
        del self._previews[oldest]

    async def commit_retention(self, client: str, change: RetentionChange, authorize: Callable[[], None]) -> Receipt:
        self.check_started()
        action = change.action_id
        fingerprint = change.fingerprint()
        async with self._admission:
            receipt, revision = await self.find_retention_receipt(action, fingerprint, authorize)
            if receipt:
                return receipt
            pending = self._pending.get(action)
            previous = pending[0] if pending else self._terminal.get(action)
            if previous and previous.fingerprint == fingerprint and (
                (pending and previous.retention_client != client) or (not pending and previous.response.status == 200)
            ):
                # A save may have committed between the durable read and the in-memory lookup.
                receipt, revision = await self.find_retention_receipt(action, fingerprint, authorize)
                if receipt:
                    return receipt
            authorize()
            if previous and previous.fingerprint != fingerprint:
                raise HttpError(409, "ACTION_ID_CONFLICT", "This action ID already belongs to a different request.")
            if pending:
                if pending[0].retention_client != client:
                    raise preview_stale()
                return pending[0].response
            self.prune_previews(self.storage.monotonic())
            preview = self._previews.get(change.preview_id)
            if (change.proposal.expected_revision != revision
                    or preview is None or preview.client != client or preview.proposal != change.proposal
                    or change.preview_id in self._reserved_previews):
                raise preview_stale()
            if self._stopping or self.ordinary_pending() >= MAX_ORDINARY_PENDING:
                raise HttpError(503, "CAPACITY_REACHED", "Settings are busy. Retry the same request shortly.", True)
            operation = Operation(fingerprint, mutation(action, "Pending", 202), retention_client=client)
            self._reserved_previews.add(change.preview_id)
            task = asyncio.create_task(self.finish_retention(client, change, preview, fingerprint))
            self._pending[action] = (operation, task)
            self._terminal.pop(action, None)
        done, _ = await asyncio.wait((task,), timeout=0.15)
        return task.result() if done else operation.response

    @staticmethod
    def retention_unknown() -> HttpError:
        return HttpError(500, "INTERNAL_ERROR", "The settings save outcome is unknown. Retry the same request.", True)

    async def find_retention_receipt(
        self, action: str, fingerprint: str, authorize: Callable[[], None],
    ) -> tuple[Receipt | None, int]:
        try:
            return await asyncio.to_thread(self.storage.retention_receipt, action, fingerprint)
        except HttpError as exc:
            if exc.code == "ACTION_ID_CONFLICT":
                authorize()
            raise
        except (OSError, sqlite3.Error) as exc:
            raise self.retention_unknown() from exc

    async def finish_retention(
        self, client: str, change: RetentionChange, preview: RetentionPreview, fingerprint: str,
    ) -> Receipt:
        action = change.action_id
        committed = False
        removed: list[str] = []
        try:
            async with self._save:
                receipt, removed = await asyncio.to_thread(self.storage.save_retention, client, change, preview, fingerprint)
            committed = True
        except HttpError as error:
            receipt = mutation(action, "Failed", error.status, error)
        except (OSError, sqlite3.Error):
            try:
                recovered = await asyncio.to_thread(self.storage.receipt, action, fingerprint)
            except (OSError, sqlite3.Error, HttpError):
                unknown = self.retention_unknown()
                return Receipt(bytes(unknown.response().body).decode(), unknown.status, None)
            committed = recovered is not None
            receipt = recovered or mutation(action, "Failed", 503, storage_unavailable())
        finally:
            self._pending.pop(action, None)
            self._reserved_previews.discard(change.preview_id)
        if committed:
            self._previews.pop(change.preview_id, None)
        self.publish_terminal(action, Operation(fingerprint, receipt))
        if committed:
            for owner in removed:
                self.hide_removed_owner(owner)
            self._retention_changed.set()
            await self.prune_terminal()
        return receipt

    async def register(self, registration: Registration, authorize: Callable[[], None]) -> Receipt:
        try:
            self.check_started()
        except HttpError as exc:
            if exc.code == "STORAGE_UNAVAILABLE":
                raise registration_unknown() from exc
            raise
        fingerprint = await asyncio.to_thread(registration.fingerprint)
        async with self._admission:
            receipt = await self.find_registration_receipt(registration.action_id, fingerprint)
            if receipt:
                return receipt
            action_id = registration.action_id
            pending = self._pending.get(action_id)
            previous = pending[0] if pending else self._terminal.get(action_id)
            if previous and previous.fingerprint != fingerprint:
                raise HttpError(409, "ACTION_ID_CONFLICT", "This action ID already belongs to a different request.")
            if pending:
                return pending[0].response
            if previous and previous.owner:
                # The writer may have committed between the receipt read and the pending check.
                receipt = await self.find_registration_receipt(action_id, fingerprint)
                if receipt:
                    return receipt
            authorize()
            if self._stopping or self.ordinary_pending() >= MAX_ORDINARY_PENDING:
                raise HttpError(503, "CAPACITY_REACHED", "Registration is busy. Retry the same request shortly.", True)
            await asyncio.to_thread(self.storage.require_new_registration, registration.submitted_at, self.preparing())
            # Decode under the admission lock so oversized decoded buffers cannot accumulate in parallel.
            reference = await asyncio.to_thread(prepare_reference, registration)
            if self._queued_reference_bytes + len(reference.data) > MAX_QUEUED_REFERENCE_BYTES:
                raise HttpError(503, "CAPACITY_REACHED", "Registration is busy. Retry the same request shortly.", True)
            self._queued_reference_bytes += len(reference.data)
            operation = Operation(fingerprint, mutation(action_id, "Pending", 202))
            task = asyncio.create_task(self.finish_registration(replace(registration, image=b""), reference, fingerprint))
            self._pending[action_id] = (operation, task)
            self._terminal.pop(action_id, None)
        done, _ = await asyncio.wait((task,), timeout=0.15)
        return task.result() if done else operation.response

    async def find_registration_receipt(self, action_id: str, fingerprint: str) -> Receipt | None:
        try:
            return await asyncio.to_thread(self.storage.receipt, action_id, fingerprint)
        except (OSError, sqlite3.Error) as exc:
            raise registration_unknown() from exc

    async def finish_registration(self, registration: Registration, reference: Reference, fingerprint: str) -> Receipt:
        action_id = registration.action_id
        owner = None
        try:
            async with self._save:
                receipt, owner = await asyncio.to_thread(self.storage.save_registration, registration, reference, fingerprint)
        except (OSError, sqlite3.Error, HttpError) as error:
            # Only publish a definitive failure once the durable receipt has been checked.
            try:
                recovered = await asyncio.to_thread(self.storage.receipt, action_id, fingerprint)
            except (OSError, sqlite3.Error, HttpError):
                unknown = registration_unknown()
                return Receipt(bytes(unknown.response().body).decode(), unknown.status, None)
            if recovered is not None:
                receipt = recovered
                owner = recovered.location.rsplit("/", 1)[-1] if recovered.location else None
            else:
                failure = error if isinstance(error, HttpError) else storage_unavailable()
                receipt = mutation(action_id, "Failed", failure.status, failure)
        finally:
            self._pending.pop(action_id, None)
            self._queued_reference_bytes -= len(reference.data)
        self.publish_terminal(action_id, Operation(fingerprint, receipt, owner))
        return receipt

    def publish_terminal(self, action_id: str, operation: Operation) -> None:
        self._terminal[action_id] = operation
        if len(self._terminal) > MAX_TERMINAL:
            self._terminal.popitem(last=False)

    def hide_removed_owner(self, owner: str, action_id: str | None = None) -> None:
        hidden = set()
        for key, (operation, task) in tuple(self._pending.items()):
            if operation.owner == owner:
                hidden.add(operation.request_id or key)
                self._pending[key] = (replace(operation, visible=False), task)
        for key, operation in tuple(self._terminal.items()):
            if operation.owner == owner:
                hidden.add(operation.request_id or key)
                del self._terminal[key]
        if action_id:
            hidden.add(action_id)
        if self.realtime:
            self.realtime.object_removed(owner, hidden)

    async def prune_terminal(self) -> None:
        records = {key: operation for key, operation in self._terminal.items() if operation.owner is not None}
        if records:
            try:
                eligible = await asyncio.to_thread(self.storage.eligible_owners, {op.owner for op in records.values()})
            except (OSError, sqlite3.Error):
                eligible = set()
            for key, operation in records.items():
                if operation.owner not in eligible and self._terminal.get(key) is operation:
                    del self._terminal[key]

    async def operations(self) -> list[dict[str, object]]:
        await self.prune_terminal()
        return [operation.payload() for operation, _ in self._pending.values() if operation.visible] + [
            operation.payload() for operation in self._terminal.values()
        ]

    async def stop(self) -> None:
        self._stopping = True
        self._stop_retention.set()
        self._retention_changed.set()
        async with self._admission:
            await asyncio.gather(*(task for _, task in self._pending.values()), return_exceptions=True)
        if self.sessions:
            await self.sessions.stop()
        if self._retention_task is not None:
            await self._retention_task

    def readiness(self, storage: Inspection | None) -> dict[str, object]:
        simulation_fault = self.realtime and self.realtime.profile and self.realtime.component_cause("Storage")
        status = "Initializing" if storage is None else "Unavailable" if storage.problem or simulation_fault else "Ready"
        cause = {"Initializing": ["INITIALIZING"], "Unavailable": ["STORAGE_UNAVAILABLE"], "Ready": []}[status]
        return {
            "components": [
                {"component": "Backend", "status": "Ready", "cause_codes": []},
                {"component": "Storage", "status": status, "cause_codes": cause},
                *({"component": name, "status": "Unavailable" if code else "Ready",
                   "cause_codes": [code] if code else []}
                  for name in DEFERRED_COMPONENTS
                  for code in [self.realtime.component_cause(name) if self.realtime else "NOT_READY"]),
            ],
            "can_start": {"Gestures": False, "Controller": False},
            "can_resume": False,
        }

    def health(self, storage: Inspection | None) -> dict[str, object]:
        starting = storage is None
        healthy = storage is not None and not storage.problem
        return {
            "backend_boot_id": self.boot_id,
            "process_status": "Healthy" if healthy or starting else "Degraded",
            "initialization": "Starting" if starting else "Failed" if self._startup_fault else "Ready",
            "storage_integrity": "Healthy" if healthy else "Reconciling" if starting else "Unavailable",
            "readiness": self.readiness(storage),
            "active_session_state": storage.active_session_state if storage else None,
            "operational_state": (
                self.realtime.effective_state(storage.active_session_state) if healthy and storage and self.realtime
                else "Idle" if healthy else "Reconciling" if starting else "Faulted"
            ),
        }

    async def realtime_projection(self) -> dict[str, object] | None:
        storage = await self.inspect()
        if storage is None:
            return None
        session, target, candidate, available = (None, None, None, False)
        if storage.settings is not None and (not storage.problem or storage.active_session_state is not None):
            try:
                session, target, candidate, available = await asyncio.to_thread(self.storage.search_setup)
            except (OSError, sqlite3.Error):
                storage = replace(storage, problem="Search setup storage is unavailable.")
        state = await self.snapshot(storage)
        if session and target:
            state["active_session"] = session
            state["active_object"] = target
            state["pending_candidate"] = candidate
            runtime = state["runtime"]
            assert isinstance(runtime, dict)
            runtime["effective_session_state"] = session["state"]
            retention = state["retention"]
            assert isinstance(retention, dict)
            retention["active_object_expires_at_ms"] = target["expires_at_ms"]
            retention["active_object_grace"] = target["retention_grace"]
        return {**state, "storage_problem": bool(storage.problem),
                "eligible_target": available and not storage.problem,
                "session_id": session["id"] if session else None}

    async def snapshot(self, storage: Inspection) -> dict[str, object]:
        profile = self.frontend_profile()
        operations = await self.operations()
        return {
            "protocol_version": 1, "backend_boot_id": self.boot_id, "event_seq": self.realtime.sequence if self.realtime else 1,
            "active_object": None, "active_session": None,
            "runtime": {
                "effective_session_state": None, "motion_permission": "Disarmed", "control_generation": 1,
                "persistence_pending": bool(self._pending),
            },
            "readiness": self.readiness(storage), "failures": [], "pending_candidate": None,
            "lease": {"state": "Unowned", "owner_client_id": None, "control_generation": 1, "can_acquire": False},
            "proximity": {
                "state": "Unknown", "warning_latched": False, "distance_mm": None, "sample_seq": None,
                "source_epoch": None, "observed_at_ms": None,
            },
            "retention": {
                "settings": storage.settings, "active_object_expires_at_ms": None,
                "active_object_grace": False, "deletion": storage.deletion(),
            },
            "operations": operations, "qualification_profile_id": profile["profile_id"] if profile else None,
            "qualification_profile": profile,
        }
