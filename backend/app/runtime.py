import asyncio
import json
import re
import sqlite3
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from secrets import token_urlsafe
from time import monotonic

from .http import HttpError
from .reference_image import Reference, prepare_reference
from .registration_input import SAFE_INTEGER, Registration, canonical_json, normalize_name
from .storage import (
    IncompatibleStorage,
    Inspection,
    Receipt,
    RecordsStorage,
    StorageRecoveryRequired,
    storage_unavailable,
)

CLIENT_IDLE_SECONDS = 30 * 60
MAX_CLIENTS = 64
MAX_ORDINARY_PENDING = 62
MAX_TERMINAL = 64
MAX_QUEUED_REFERENCE_BYTES = 128 * 1024**2
DEFERRED_COMPONENTS = (
    "Command", "RobotVideo", "DisplayedRobotVideo", "Webcam", "Controller", "AI", "Workspace", "QualificationProfile",
)

ObjectQuery = tuple[str, str, str, int]  # client, normalized name, status, limit


@dataclass(frozen=True)
class Cursor:
    query: ObjectQuery
    before: tuple[int, str]
    deadline: float


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

    async def objects(self, client: str, query: dict[str, str]) -> dict[str, object]:
        context: ObjectQuery = (client, normalize_name(query.get("name", "")).casefold(),
                                query.get("status", ""), int(query.get("limit", "25")))
        token = query.get("cursor")
        now = monotonic()
        for key, saved_cursor in tuple(self._cursors.items()):
            if saved_cursor.deadline <= now:
                del self._cursors[key]
        before = (SAFE_INTEGER + 1, "")
        if token is not None:
            if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                raise HttpError(400, "CURSOR_INVALID", "Refresh the first page of objects.")
            cursor = self._cursors.get(token)
            if cursor is None:
                raise HttpError(400, "CURSOR_EXPIRED", "Refresh the first page of objects.")
            if cursor.query != context:
                raise HttpError(400, "CURSOR_INVALID", "Use the original page filters.")
            self._cursors.move_to_end(token)
            before = cursor.before
        _, name, status, limit = context
        items, boundary = await asyncio.to_thread(self.storage.read_objects, name, status, limit, before, self.preparing())
        next_cursor = None
        if boundary:
            owned = [key for key, cursor in self._cursors.items() if cursor.query[0] == client]
            if len(owned) >= 32:
                del self._cursors[owned[0]]
            if len(self._cursors) >= 1024:
                self._cursors.popitem(last=False)
            next_cursor = token_urlsafe(32)
            self._cursors[next_cursor] = Cursor(context, boundary, monotonic() + CLIENT_IDLE_SECONDS)
        return {"items": items, "next_cursor": next_cursor}

    async def register(self, registration: Registration, authorize: Callable[[], None]) -> Receipt:
        self.check_started()
        fingerprint = await asyncio.to_thread(registration.fingerprint)
        async with self._admission:
            receipt = await asyncio.to_thread(self.storage.receipt, registration.action_id, fingerprint)
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
                receipt = await asyncio.to_thread(self.storage.receipt, action_id, fingerprint)
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
                unknown = HttpError(500, "INTERNAL_ERROR", "The registration outcome is unknown. Retry the same request.", True)
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

    async def operations(self) -> list[dict[str, object]]:
        for key, operation in tuple(self._terminal.items()):
            if operation.owner and not await asyncio.to_thread(self.storage.retain_terminal, operation.owner):
                if self._terminal.get(key) is operation:
                    del self._terminal[key]
        return [operation.payload() for operation, _ in self._pending.values()] + [
            operation.payload() for operation in self._terminal.values()
        ]

    async def stop(self) -> None:
        self._stopping = True
        async with self._admission:
            await asyncio.gather(*(task for _, task in self._pending.values()), return_exceptions=True)

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
            "status": "Failed" if storage.cleanup_pending else "Complete",
            "remaining_objects": storage.remaining_objects,
            "remaining_files": storage.remaining_files,
            "error_code": "STORAGE_UNAVAILABLE" if storage.cleanup_pending else None,
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
