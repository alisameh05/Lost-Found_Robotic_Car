import asyncio
import sqlite3
from dataclasses import dataclass, field
from secrets import token_urlsafe
from time import monotonic

from .storage import IncompatibleStorage, Inspection, RecordsStorage, utc_ms

CLIENT_IDLE_SECONDS = 30 * 60
MAX_CLIENTS = 64
DEFERRED_COMPONENTS = (
    "Command", "RobotVideo", "DisplayedRobotVideo", "Webcam", "Controller", "AI", "Workspace", "QualificationProfile",
)


@dataclass
class RecordsRuntime:
    storage: RecordsStorage
    boot_id: str = field(default_factory=lambda: token_urlsafe(24))
    capability: str = field(default_factory=lambda: token_urlsafe(32), repr=False)
    _clients: dict[str, float] = field(default_factory=dict, repr=False)
    _starting: bool = True
    _startup_fault: Inspection | None = None

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
            "server_time_ms": utc_ms(), "qualification_profile": None,
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
        except (OSError, sqlite3.Error):
            self._startup_fault = Inspection(problem="Records storage could not initialize. Check local storage and restart.")
        finally:
            self._starting = False

    async def inspect(self) -> Inspection | None:
        if self._starting:
            return None
        if self._startup_fault:
            return self._startup_fault
        return await asyncio.to_thread(self.storage.inspect)

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

    def snapshot(self, storage: Inspection) -> dict[str, object]:
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
                "persistence_pending": False,
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
            "operations": [], "qualification_profile_id": None, "qualification_profile": None,
        }
