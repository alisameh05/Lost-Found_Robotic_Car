import asyncio
import json
import re
import sqlite3
from collections import OrderedDict
from collections.abc import Callable, Collection
from dataclasses import dataclass, field, replace
from secrets import token_urlsafe
from time import monotonic
from typing import Literal

from .http import HttpError
from .reference_image import Reference, prepare_reference
from .registration_input import SAFE_INTEGER, Registration, canonical_json
from .storage import (
    HistoryKind,
    IncompatibleStorage,
    Inspection,
    Receipt,
    RecordsStorage,
    StorageRecoveryRequired,
    storage_unavailable,
)
from .unicode_search import casefold

CLIENT_IDLE_SECONDS = 30 * 60
CURSOR_LIFETIME_SECONDS = 30 * 60
MAX_CLIENTS = 64
MAX_CLIENT_CURSORS = 32
MAX_CURSORS = 1024
MAX_ORDINARY_PENDING = 62
MAX_TERMINAL = 64
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


@dataclass(frozen=True)
class Operation:
    fingerprint: str
    response: Receipt
    owner: str | None = None

    def payload(self) -> dict[str, object]:
        data: dict[str, object] = json.loads(self.response.body)
        return {"request_id": None, **data}


def mutation(action_id: str, persistence: str, status: int, error: HttpError | None = None) -> Receipt:
    return Receipt(canonical_json({
        "action_id": action_id, "persistence": persistence, "result": None,
        "error": json.loads(bytes(error.response().body)) if error else None,
    }), status, None)


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
    _stopping: bool = False
    _stop_retention: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _retention_task: asyncio.Task[None] | None = field(default=None, repr=False)
    _queued_reference_bytes: int = 0

    def _expire_clients(self, now: float) -> None:
        for client, touched in list(self._clients.items()):
            if now - touched >= CLIENT_IDLE_SECONDS:
                del self._clients[client]

    def bootstrap(self) -> dict[str, object] | None:
        now = monotonic()
        self._expire_clients(now)
        if len(self._clients) >= MAX_CLIENTS:
            return None
        client = token_urlsafe(24)
        self._clients[client] = now
        return {
            "client_id": client, "backend_boot_id": self.boot_id, "capability": self.capability,
            "server_time_ms": self.storage.clock(), "qualification_profile": None,
        }

    def touch_client(self, client: str) -> bool:
        now = monotonic()
        self._expire_clients(now)
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
        while not self._stop_retention.is_set():
            delay = await asyncio.to_thread(self.storage.service_retention)
            await self.prune_terminal()
            try:
                await asyncio.wait_for(self._stop_retention.wait(), delay)
            except TimeoutError:
                pass

    async def inspect(self) -> Inspection | None:
        if self._starting:
            return None
        if self._startup_fault:
            return self._startup_fault
        return await asyncio.to_thread(self.storage.inspect, tuple(self._pending))

    def check_started(self) -> None:
        if self._starting:
            raise HttpError(503, "INITIALIZING", "Checking records storage. Retry when initialization finishes.", True)
        if self._startup_fault:
            raise storage_unavailable(self._startup_fault.problem or "Records storage could not initialize.")

    def preparing(self) -> tuple[str, ...]:
        return tuple(self._pending)

    async def page(self, route: str, client: str, query: dict[str, str], parent: str | None) -> dict[str, object]:
        scope = CursorScope(self.boot_id, client, casefold(query.get("name", "")), query.get("status", ""),
                            int(query.get("limit", "25")), route, parent)
        history: HistoryKind = "sessions" if route == "/objects/{id}/sessions" else "matches"
        try:
            cursor = self.resolve_cursor(scope, query.get("cursor"))
        except PageError:
            if parent is not None:
                await asyncio.to_thread(self.storage.check_history_parent, parent, history)
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
        self._expire_clients(now)
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
            if self._stopping or len(self._pending) >= MAX_ORDINARY_PENDING:
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
        self._terminal[action_id] = Operation(fingerprint, receipt, owner)
        if len(self._terminal) > MAX_TERMINAL:
            self._terminal.popitem(last=False)
        return receipt

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
        return [operation.payload() for operation, _ in self._pending.values()] + [
            operation.payload() for operation in self._terminal.values()
        ]

    async def stop(self) -> None:
        self._stopping = True
        self._stop_retention.set()
        async with self._admission:
            await asyncio.gather(*(task for _, task in self._pending.values()), return_exceptions=True)
        if self._retention_task is not None:
            await self._retention_task

    def readiness(self, storage: Inspection | None) -> dict[str, object]:
        status = "Initializing" if storage is None else "Unavailable" if storage.problem else "Ready"
        cause = {"Initializing": ["INITIALIZING"], "Unavailable": ["STORAGE_UNAVAILABLE"], "Ready": []}[status]
        return {
            "components": [
                {"component": "Backend", "status": "Ready", "cause_codes": []},
                {"component": "Storage", "status": status, "cause_codes": cause},
                *({"component": name, "status": "Unavailable", "cause_codes": ["NOT_READY"]}
                  for name in DEFERRED_COMPONENTS),
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
            "active_session_state": None,
            "operational_state": "Idle" if healthy else "Reconciling" if starting else "Faulted",
        }

    async def snapshot(self, storage: Inspection) -> dict[str, object]:
        deletion = {
            "status": storage.deletion_status,
            "remaining_objects": storage.remaining_objects,
            "remaining_files": storage.remaining_files,
            "error_code": "STORAGE_UNAVAILABLE" if storage.deletion_status == "Failed" else None,
        }
        return {
            "protocol_version": 1, "backend_boot_id": self.boot_id, "event_seq": 1,
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
                "active_object_grace": False, "deletion": deletion,
            },
            "operations": await self.operations(), "qualification_profile_id": None, "qualification_profile": None,
        }
