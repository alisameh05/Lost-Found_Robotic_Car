import hashlib
import json
import re
import sqlite3
import time
from collections.abc import Callable, Collection, Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Lock
from typing import Literal, TypedDict
from uuid import uuid4

from .http import HttpError
from .managed_media import GENERATED_ID, STAGING_NAME, ManagedMedia, sync_directory
from .reference_image import Reference
from .registration_input import SAFE_INTEGER, Registration, canonical_json
from .retention_input import RetentionChange, RetentionProposal
from .unicode_search import casefold

DAY_MS = 86_400_000
SUBMISSION_WINDOW = 600_000
CLOCK_TOLERANCE = 2_000
MIGRATIONS = Path(__file__).with_name("migrations")
RECONCILE_ERROR = "A storage operation needs recovery. Keep the data intact for recovery."
CLEANUP_PENDING = "Retention cleanup is in progress."
CLEANUP_FAILED = "Retention cleanup failed. Restore access to managed storage."
RETENTION_RECHECK_SECONDS = 1.0
GRACE = """EXISTS (SELECT 1 FROM sessions AS active
                   WHERE active.object_id = o.id AND active.state IN ('Searching', 'Paused'))"""
DELETING = """(o.deletion_pending OR EXISTS (
               SELECT 1 FROM storage_operations AS purge WHERE purge.kind = 'Purge' AND purge.owner_object_id = o.id))"""
EXPIRED = f"(o.registered_at_ms <= ? AND NOT {GRACE})"
ELIGIBLE = f"(NOT {DELETING} AND NOT {EXPIRED})"
OBJECT_ROWS = f"""
    SELECT o.*, m.relative_path, m.format, m.byte_length, m.checksum, m.created_at_ms,
           {GRACE} AS grace, {DELETING} AS deleting
    FROM objects AS o JOIN media AS m ON m.id = o.reference_media_id
"""
MATCH_ROWS = """
    SELECT c.*, m.relative_path, m.byte_length, m.checksum, m.created_at_ms
    FROM match_events AS c JOIN media AS m ON m.id = c.evidence_media_id
"""
SESSION_FIELDS = ("id", "object_id", "control_mode", "state", "started_at_ms", "ended_at_ms", "end_reason", "revision")
HistoryKind = Literal["sessions", "matches"]


class Settings(TypedDict):
    retention_days: int
    revision: int
    updated_at_ms: int


@dataclass(frozen=True)
class Inspection:
    settings: Settings | None = None
    problem: str | None = None
    deletion_status: Literal["Pending", "Complete", "Failed"] = "Complete"
    remaining_objects: int = 0
    remaining_files: int = 0
    recovery_pending: bool = False
    active_session_state: str | None = None

    @property
    def cleanup_pending(self) -> bool:
        return self.deletion_status != "Complete"

    def deletion(self) -> dict[str, object]:
        return {
            "status": self.deletion_status, "remaining_objects": self.remaining_objects,
            "remaining_files": self.remaining_files,
            "error_code": "STORAGE_UNAVAILABLE" if self.deletion_status == "Failed" else None,
        }


class IncompatibleStorage(Exception):
    pass


class StorageRecoveryRequired(Exception):
    pass


@dataclass(frozen=True)
class Receipt:
    body: str
    status: int
    location: str | None


@dataclass(frozen=True)
class RetentionImpact:
    digest: str
    counts: dict[str, int]


@dataclass(frozen=True)
class RetentionPreview:
    client: str
    proposal: RetentionProposal
    deadline: float
    impact: RetentionImpact


def preview_stale() -> HttpError:
    return HttpError(409, "PREVIEW_STALE", "The retention preview is outdated. Preview the current impact again.")


def storage_unavailable(message: str = "Records storage is unavailable. Check local storage and retry.") -> HttpError:
    return HttpError(503, "STORAGE_UNAVAILABLE", message, True)


def utc_ms() -> int:
    return time.time_ns() // 1_000_000


def retention_ms(days: int) -> int:
    return days * DAY_MS


@contextmanager
def read_transaction(db: sqlite3.Connection) -> Iterator[None]:
    db.execute("BEGIN")
    try:
        yield
        db.commit()
    except BaseException:
        db.rollback()
        raise


@contextmanager
def write_transaction(db: sqlite3.Connection) -> Iterator[None]:
    db.execute("BEGIN IMMEDIATE")
    try:
        yield
        db.commit()
    except BaseException:
        db.rollback()
        raise


def schema(db: sqlite3.Connection) -> list[tuple[str, str, str]]:
    return [
        (kind, name, sql)
        for kind, name, sql in db.execute(
            "SELECT type, name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name"
        )
    ]


def migrate(db: sqlite3.Connection) -> None:
    files = sorted(MIGRATIONS.glob("*.sql"))
    scripts = [path.read_text(encoding="utf-8") for path in files]
    if [path.name.split("_", 1)[0] for path in files] != [f"{n:03}" for n in range(1, len(files) + 1)]:
        raise IncompatibleStorage
    checksums = [hashlib.sha256(script.encode("utf-8")).hexdigest() for script in scripts]
    version, = db.execute("PRAGMA user_version").fetchone()
    if version < 0 or version > len(scripts):
        raise IncompatibleStorage

    # Check the actual structure as well as the recorded migration checksums.
    with closing(sqlite3.connect(":memory:")) as expected:
        expected.execute("PRAGMA foreign_keys = ON")
        for script in scripts[:version]:
            expected.executescript(script)
        if schema(db) != schema(expected):
            raise IncompatibleStorage
    if version:
        applied = db.execute("SELECT version, checksum FROM schema_migrations ORDER BY version").fetchall()
        if applied != list(enumerate(checksums[:version], start=1)):
            raise IncompatibleStorage
    if db.execute("PRAGMA quick_check").fetchall() != [("ok",)] or db.execute("PRAGMA foreign_key_check").fetchone():
        raise IncompatibleStorage

    # Only the lifespan's owner calls migrate. Each migration and receipt are atomic.
    for number, script in enumerate(scripts[version:], start=version + 1):
        try:
            db.executescript("BEGIN IMMEDIATE;\n" + script)
            db.execute(
                "INSERT INTO schema_migrations VALUES (?, ?, ?)", (number, utc_ms(), checksums[number - 1])
            )
            db.execute(f"PRAGMA user_version = {number}")
            db.commit()
        except BaseException:
            db.rollback()
            raise


class RecordsStorage:
    def __init__(
        self, root: Path, *, clock: Callable[[], int] = utc_ms, monotonic: Callable[[], float] = time.monotonic,
        checkpoint: Callable[[str], None] | None = None,
    ):
        self.path = root / "records.sqlite3"
        self.files = ManagedMedia(root)
        self.writer = Lock()
        self._writer_connection: sqlite3.Connection | None = None
        self.clock = clock
        self.monotonic = monotonic
        self.checkpoint = checkpoint or (lambda _: None)
        self._clock_lock = Lock()
        self._wall_floor = 0
        self._repair_needed = False
        self._purge_fault = False
        self._announced_expiry: set[str] = set()
        self._startup_cleanup_pending = False
        self._anchor = (clock(), monotonic())

    def open_database(self, mode: str) -> sqlite3.Connection:
        if self.path.is_symlink():
            raise OSError
        db = sqlite3.connect(f"{self.path.as_uri()}?mode={mode}", uri=True, isolation_level=None,
                             check_same_thread=mode == "ro")
        try:
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("PRAGMA synchronous = FULL")
        except BaseException:
            db.close()
            raise
        return db

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        with closing(self.open_database("ro")) as db:
            yield db

    @contextmanager
    def mutation_connection(self) -> Iterator[sqlite3.Connection]:
        with self.writer:
            if self._writer_connection is None:
                raise OSError("Records writer is closed")
            yield self._writer_connection

    def initialize(self) -> None:
        with self.writer:
            db = self.open_database("rwc")
            try:
                self.recover_database(db)
                self.purge_expired(db)
                self._startup_cleanup_pending = self._inspect(db, self.now()[0], ()).cleanup_pending
            except BaseException:
                db.close()
                raise
            self._writer_connection = db

    def recover_database(self, db: sqlite3.Connection) -> None:
        # Detect incompatible manifests before making durability changes to an existing database.
        migrate(db)
        if db.execute("PRAGMA journal_mode = WAL").fetchone() != ("wal",):
            raise IncompatibleStorage
        row = db.execute("""
            SELECT MAX(observed_at_ms, COALESCE((SELECT MAX(registered_at_ms) FROM objects), 0))
            FROM registration_clock WHERE id = 1
        """).fetchone()
        if row is None:
            raise IncompatibleStorage
        self._wall_floor = row[0]
        self.persist_clock(db, self.now()[0])
        try:
            self.recover_interrupted_sessions(db)
        except (OSError, sqlite3.Error) as exc:
            raise StorageRecoveryRequired(RECONCILE_ERROR) from exc
        self._repair_needed = True

    def recover_interrupted_sessions(self, db: sqlite3.Connection) -> None:
        now, _ = self.now()
        with write_transaction(db):
            # Pending rows already have an owned Ready media association. Keep that fact
            # even when the underlying file is now unavailable.
            db.execute("UPDATE match_events SET disposition = 'NotReviewed' WHERE disposition = 'Pending'")
            db.execute("""
                UPDATE sessions
                SET state = 'Ended', end_reason = 'Interrupted', pause_causes = '[]', revision = revision + 1,
                    ended_at_ms = MAX(?, started_at_ms, COALESCE((
                        SELECT MAX(COALESCE(reviewed_at_ms, captured_at_ms))
                        FROM match_events WHERE session_id = sessions.id
                    ), 0))
                WHERE state IN ('Searching', 'Paused')
            """, (now,))

    def close(self) -> None:
        with self.writer:
            if self._writer_connection is not None:
                self._writer_connection.close()
                self._writer_connection = None

    def inspect(self, preparing: Collection[str] = ()) -> Inspection:
        try:
            with self.connect() as db, read_transaction(db):
                now, _ = self.now()
                result = self._inspect(db, now, preparing)
                try:
                    self.observe_due_cutoffs(db, now)
                except HttpError:
                    return replace(result, problem=CLEANUP_FAILED, deletion_status="Failed")
                return result
        except (OSError, sqlite3.Error):
            return Inspection(problem="Records storage cannot be read. Check local storage and restart the backend.")

    def safety_storage_healthy(self, preparing: Collection[str]) -> bool:
        # Health for live permission must never wait for the serialized writer.
        try:
            with self.connect() as db, read_transaction(db):
                now, valid = self.now()
                return valid and not self._inspect(db, now, preparing).problem
        except (OSError, sqlite3.Error):
            return False

    def now(self) -> tuple[int, bool]:
        with self._clock_lock:
            wall = self.clock()
            monotonic = self.monotonic()
            anchor_wall, anchor_mono = self._anchor
            expected = anchor_wall + int((monotonic - anchor_mono) * 1000)
            # A forward correction may expire records. Preserve that observation and require the clock
            # to catch up after a backward jump before accepting an unseen submission.
            if wall > expected:
                self._anchor = (wall, monotonic)
            valid = wall >= expected - CLOCK_TOLERANCE and wall >= self._wall_floor
            self._wall_floor = max(self._wall_floor, wall, expected - CLOCK_TOLERANCE)
            return self._wall_floor, valid

    @staticmethod
    def persist_clock(db: sqlite3.Connection, now: int) -> None:
        db.execute("UPDATE registration_clock SET observed_at_ms = MAX(observed_at_ms, ?) WHERE id = 1", (now,))

    def observe_clock(self, now: int) -> None:
        with self.mutation_connection() as db:
            self.persist_clock(db, now)

    def observe_cutoff(self, db: sqlite3.Connection, now: int, deadline: int) -> None:
        # A published expiry must survive a process death followed by a clock rollback.
        # Already recorded cutoffs never wait for a writer that is deleting files.
        if deadline <= db.execute("SELECT observed_at_ms FROM registration_clock WHERE id = 1").fetchone()[0]:
            return
        try:
            if db is self._writer_connection:
                self.persist_clock(db, now)
            else:
                self.observe_clock(now)
        except (OSError, sqlite3.Error) as exc:
            self._purge_fault = True
            raise storage_unavailable(CLEANUP_FAILED) from exc

    def observe_due_cutoffs(self, db: sqlite3.Connection, now: int) -> None:
        days = self.settings(db)["retention_days"]
        latest, = db.execute(f"""
            SELECT MAX(registered_at_ms) FROM objects AS o
            WHERE o.registered_at_ms <= ? AND NOT {DELETING}
        """, (now - retention_ms(days),)).fetchone()
        if latest is not None:
            self.observe_cutoff(db, now, latest + retention_ms(days))

    @staticmethod
    def settings(db: sqlite3.Connection) -> Settings:
        row = db.execute("SELECT retention_days, revision, updated_at_ms FROM app_settings WHERE id = 1").fetchone()
        if row is None:
            raise sqlite3.DatabaseError("Missing settings singleton")
        days, revision, updated = row
        return Settings(retention_days=days, revision=revision, updated_at_ms=updated)

    @staticmethod
    def cutoff(db: sqlite3.Connection, now: int) -> int:
        return now - retention_ms(RecordsStorage.settings(db)["retention_days"])

    @staticmethod
    def owned_paths(db: sqlite3.Connection, owner: str) -> list[str]:
        paths = []
        for media, final in db.execute("SELECT id, relative_path FROM media WHERE object_id = ?", (owner,)):
            paths.append(final)
            if re.fullmatch(GENERATED_ID, media):
                paths.append(f"staging/{media}.part")
        return sorted(paths)

    def journal_owner(self, db: sqlite3.Connection, owner: str, now: int) -> None:
        db.execute("UPDATE objects SET deletion_pending = 1 WHERE id = ?", (owner,))
        db.execute("""
            INSERT INTO storage_operations VALUES (?, 'Purge', ?, ?, 'Pending', ?, NULL)
        """, (uuid4().hex, owner, canonical_json(self.owned_paths(db, owner)), now))

    def journal_expired(
        self, db: sqlite3.Connection, now: int, on_removed: Callable[[str], None] | None = None,
    ) -> list[str]:
        owners = [owner for owner, in db.execute(f"""
            SELECT id FROM objects AS o
            WHERE (o.deletion_pending OR {EXPIRED})
              AND NOT EXISTS (SELECT 1 FROM storage_operations
                              WHERE kind = 'Purge' AND owner_object_id = o.id)
        """, (self.cutoff(db, now),))]
        if on_removed:
            # The persisted clock already denies these owners, even if journal creation fails.
            for owner in owners:
                if owner not in self._announced_expiry:
                    self._announced_expiry.add(owner)
                    on_removed(owner)
        if owners:
            self.checkpoint("purge_before_journal")
        for owner in owners:
            self.journal_owner(db, owner, now)
        return owners

    def purge_owner(self, db: sqlite3.Connection, operation: str, owner: str | None, encoded_paths: str) -> None:
        paths = json.loads(encoded_paths)
        if owner is None or paths != self.owned_paths(db, owner):
            raise OSError("Purge journal does not own the recorded media")
        exists = db.execute("SELECT deletion_pending FROM objects WHERE id = ?", (owner,)).fetchone()
        if exists is not None and exists != (1,):
            raise OSError("Purge owner has not been marked for deletion")
        # Validate the whole manifest before deleting anything. The journal survives
        # partial filesystem work and the independent transaction that removes the rows.
        folders = {path.partition("/")[0] for path in paths}
        if not folders <= {"media", "staging"}:
            raise OSError("Invalid purge directory")
        for folder in folders:
            self.files.directory(folder, create=True)
        for path in paths:
            self.files.exists(path)
        for path in paths:
            self.files.discard(path)
            self.checkpoint("purge_file_removed")
        if any(self.files.exists(path) for path in paths):
            raise OSError("Managed files remain after purge")
        with write_transaction(db):
            db.execute("DELETE FROM objects WHERE id = ?", (owner,))
            db.execute("UPDATE storage_operations SET generated_paths = '[]' WHERE id = ?", (operation,))
        self.checkpoint("purge_rows_removed")
        db.execute("DELETE FROM storage_operations WHERE id = ?", (operation,))
        self.checkpoint("purge_journal_removed")

    def purge_expired(self, db: sqlite3.Connection, on_removed: Callable[[str], None] | None = None) -> None:
        try:
            now, _ = self.now()
            # Commit this separately so a crash or rollback during journal creation
            # cannot reopen an already expired owner after a wall-clock rollback.
            self.persist_clock(db, now)
            if self._repair_needed:
                try:
                    self.files.directory("media", create=True)
                    self.files.directory("staging", create=True)
                    sync_directory(self.files.root)
                    self.recover_preparations(db)
                except (OSError, sqlite3.Error):
                    return  # Preparation recovery must finish before purging owners.
                self._repair_needed = False
            with write_transaction(db):
                journaled = self.journal_expired(db, now, on_removed)
            self._announced_expiry.difference_update(journaled)
            if journaled:
                self.checkpoint("purge_journaled")
            for operation, owner, paths in db.execute("""
                SELECT id, owner_object_id, generated_paths FROM storage_operations WHERE kind = 'Purge'
            """).fetchall():
                try:
                    self.purge_owner(db, operation, owner, paths)
                except (OSError, sqlite3.Error):
                    db.execute("""
                        UPDATE storage_operations SET phase = 'Failed', last_error_code = 'STORAGE_UNAVAILABLE'
                        WHERE id = ?
                    """, (operation,))
            self._purge_fault = False
        except (OSError, sqlite3.Error):
            # A failure before journal commit is still a fault. Reads continue to
            # apply the clock cutoff, and the next pass retries the durable intent.
            self._purge_fault = True

    def service_retention(self, on_removed: Callable[[str], None] | None = None) -> float:
        """Check deadlines and retry cleanup. The caller never needs an HTTP request."""
        try:
            with self.connect() as db, read_transaction(db):
                now, valid = self.now()
                days = self.settings(db)["retention_days"]
                oldest, active_registration, watermark, pending = db.execute(f"""
                    SELECT (SELECT MIN(registered_at_ms) FROM objects AS o WHERE NOT {GRACE}),
                           (SELECT registered_at_ms FROM objects AS o WHERE {GRACE}),
                           (SELECT observed_at_ms FROM registration_clock WHERE id = 1),
                           EXISTS(SELECT 1 FROM objects WHERE deletion_pending)
                           OR EXISTS(SELECT 1 FROM storage_operations WHERE kind = 'Purge')
                """).fetchone()
            duration = retention_ms(days)
            deadline = int(oldest) + duration if oldest is not None else None
            if pending or self._purge_fault or self._repair_needed or (deadline is not None and deadline <= now):
                with self.mutation_connection() as db:
                    self.purge_expired(db, on_removed)
                    if self._startup_cleanup_pending:
                        self._startup_cleanup_pending = self._inspect(db, self.now()[0], ()).cleanup_pending
                return RETENTION_RECHECK_SECONDS
            active_cutoff = int(active_registration) + duration if active_registration is not None else None
            if not valid or (active_cutoff is not None and watermark < active_cutoff <= now):
                self.observe_clock(now)
            if deadline is not None:
                return min(RETENTION_RECHECK_SECONDS, (deadline - now) / 1000)
        except (OSError, sqlite3.Error):
            self._purge_fault = True
        return RETENTION_RECHECK_SECONDS

    def _inspect(self, db: sqlite3.Connection, now: int, preparing: Collection[str]) -> Inspection:
        settings = self.settings(db)
        active = self.active_session_state(db)
        owners = db.execute(f"SELECT id FROM objects AS o WHERE {DELETING} OR {EXPIRED}",
                            (now - retention_ms(settings["retention_days"]),)).fetchall()
        journals = db.execute("SELECT generated_paths, phase FROM storage_operations WHERE kind = 'Purge'").fetchall()
        needs_recovery = self._repair_needed or any(
            row[0] not in preparing or row[1] != "Pending"
            for row in db.execute("SELECT id, phase FROM storage_operations WHERE kind = 'Prepare'")
        ) or db.execute("SELECT 1 FROM media WHERE lifecycle = 'Staging' LIMIT 1").fetchone() is not None
        if owners or journals or self._purge_fault:
            paths = {path for owner, in owners for path in self.owned_paths(db, owner)}
            invalid = 0
            for encoded_paths, _ in journals:
                for path in json.loads(encoded_paths):
                    if isinstance(path, str):
                        paths.add(path)
                    else:
                        invalid += 1
            remaining = invalid
            for path in paths:
                try:
                    remaining += self.files.exists(path)
                except OSError:
                    remaining += 1
            failed = self._purge_fault or needs_recovery or any(phase == "Failed" for _, phase in journals)
            return Inspection(settings, CLEANUP_FAILED if failed else CLEANUP_PENDING, "Failed" if failed else "Pending",
                              len(owners), remaining, needs_recovery, active)
        if needs_recovery:
            return Inspection(settings, RECONCILE_ERROR, recovery_pending=True, active_session_state=active)
        return Inspection(settings, active_session_state=active)

    @staticmethod
    def active_session_state(db: sqlite3.Connection) -> str | None:
        row = db.execute("SELECT state FROM sessions WHERE state IN ('Searching', 'Paused')").fetchone()
        return str(row[0]) if row else None

    def require_inactive(self, db: sqlite3.Connection) -> None:
        if self.active_session_state(db):
            raise HttpError(409, "ACTIVE_SESSION_EXISTS", "End the active search before changing retention.")

    def retention_impact(self, db: sqlite3.Connection, now: int, current: int, proposed: int) -> RetentionImpact:
        # Keep the preview cache bounded independently of the number of affected records.
        digest = hashlib.sha256()
        counts = {"objects": 0, "sessions": 0, "matches": 0, "managed_image_bytes": 0}
        for row in db.execute(f"""
            WITH affected AS (
                SELECT o.id FROM objects AS o WHERE {ELIGIBLE} AND {EXPIRED}
            )
            SELECT 'objects' AS kind, id, id, '', 0 FROM affected
            UNION ALL
            SELECT 'sessions', s.object_id, s.id, '', 0 FROM sessions AS s JOIN affected AS a ON a.id = s.object_id
            UNION ALL
            SELECT 'matches', m.object_id, m.id, m.session_id, 0
            FROM match_events AS m JOIN affected AS a ON a.id = m.object_id
            UNION ALL
            SELECT 'managed_image_bytes', m.object_id, m.id, m.relative_path, m.byte_length
            FROM media AS m JOIN affected AS a ON a.id = m.object_id
            ORDER BY 1, 2, 3
        """, (now - retention_ms(current), now - retention_ms(proposed))):
            kind, _, _, path, _ = row
            size = None
            if kind == "managed_image_bytes":
                try:
                    size = self.files.size(path)
                except OSError as exc:
                    raise storage_unavailable("The affected managed files could not be inspected.") from exc
            digest.update(canonical_json([*row, size]).encode() + b"\n")
            counts[kind] += (size or 0) if kind == "managed_image_bytes" else 1
        if max(counts.values()) > SAFE_INTEGER:
            raise HttpError(503, "COUNTER_EXHAUSTED", "The retention impact exceeds the supported count range.")
        return RetentionImpact(digest.hexdigest(), counts)

    def preview_retention(
        self, proposal: RetentionProposal, preparing: Collection[str],
    ) -> tuple[int, float, RetentionImpact]:
        with self.connect() as db, read_transaction(db):
            self.require_inactive(db)
            now, _ = self.now()
            evaluated_monotonic = self.monotonic()
            inspection = self._inspect(db, now, preparing)
            if inspection.problem:
                raise storage_unavailable(inspection.problem)
            settings = self.settings(db)
            if proposal.expected_revision != settings["revision"]:
                raise HttpError(409, "REVISION_CONFLICT", "The saved retention settings changed. Refresh and preview again.")
            return now, evaluated_monotonic, self.retention_impact(db, now, settings["retention_days"], proposal.retention_days)

    def save_retention(
        self, client: str, change: RetentionChange, preview: RetentionPreview, fingerprint: str,
    ) -> tuple[Receipt, list[str]]:
        with self.mutation_connection() as db, write_transaction(db):
            self.require_inactive(db)
            recovered = self.find_receipt(db, change.action_id, fingerprint)
            if recovered:
                return recovered, []
            now, _ = self.now()
            settings = self.settings(db)
            previous_days = settings["retention_days"]
            proposal = change.proposal
            if (preview.client != client or preview.proposal != proposal
                    or proposal.expected_revision != settings["revision"] or self.monotonic() >= preview.deadline):
                raise preview_stale()
            inspection = self._inspect(db, now, ())
            if inspection.problem and inspection.deletion_status != "Pending":
                raise storage_unavailable(inspection.problem)
            try:
                impact = self.retention_impact(db, now, previous_days, proposal.retention_days)
            except HttpError as exc:
                if exc.code in ("STORAGE_UNAVAILABLE", "COUNTER_EXHAUSTED"):
                    raise preview_stale() from exc
                raise
            if impact != preview.impact or self.monotonic() >= preview.deadline:
                raise preview_stale()
            if inspection.problem:
                raise storage_unavailable(inspection.problem)
            removed = []
            if proposal.retention_days != previous_days:
                if settings["revision"] >= SAFE_INTEGER:
                    raise HttpError(503, "COUNTER_EXHAUSTED", "The settings revision limit was reached.")
                db.execute("""
                    UPDATE app_settings SET retention_days = ?, revision = revision + 1, updated_at_ms = ? WHERE id = 1
                """, (proposal.retention_days, now))
                settings = self.settings(db)
                removed = self.journal_expired(db, now)
            self.persist_clock(db, now)
            result = {
                "settings": settings, "deletion": self._inspect(db, now, ()).deletion(),
                "object": None, "session": None, "match": None,
            }
            receipt = Receipt(canonical_json({
                "action_id": change.action_id, "persistence": "Committed", "result": result, "error": None,
            }), 200, None)
            db.execute("""
                INSERT INTO action_receipts
                VALUES (?, 'Settings', NULL, 1, NULL, 'retention', ?, ?, ?, 200, ?, NULL, ?)
            """, (change.action_id, fingerprint, settings["revision"], now, receipt.body, change.canonical_request()))
            self.checkpoint("retention_before_commit")
            checked_at, _ = self.now()
            if self.monotonic() >= preview.deadline:
                raise preview_stale()
            if checked_at > now:
                # A deadline can be crossed under either policy while the transaction
                # builds its journal. The storage gate ruled out pre-existing purges.
                for days in {previous_days, min(previous_days, proposal.retention_days)}:
                    duration = retention_ms(days)
                    if db.execute("""
                        SELECT 1 FROM objects WHERE registered_at_ms > ? AND registered_at_ms <= ? LIMIT 1
                    """, (now - duration, checked_at - duration)).fetchone():
                        raise preview_stale()
            return receipt, removed

    def require_new_registration(self, submitted_at: int, preparing: Collection[str]) -> None:
        now, clock_valid = self.now()
        if not clock_valid:
            self.observe_clock(now)
            raise HttpError(503, "NOT_READY", "Restore the system clock before registering a belonging.", True)
        inspection = self.inspect(preparing)
        if inspection.problem:
            raise storage_unavailable(inspection.problem)
        if not 0 <= now - submitted_at <= SUBMISSION_WINDOW:
            # An observed stale submission must not become new work after a clock rollback and restart.
            self.observe_clock(now)
            raise HttpError(410, "ACTION_EXPIRED", "The registration submission window has ended.")

    def require_eligible(self, db: sqlite3.Connection, row: sqlite3.Row | None, now: int, days: int) -> sqlite3.Row:
        if row is None:
            raise HttpError(404, "NOT_FOUND", "The saved resource could not be found.")
        expires = row["registered_at_ms"] + retention_ms(days)
        cutoff_crossed = expires <= now
        if cutoff_crossed and not row["deleting"]:
            self.observe_cutoff(db, now, expires)
        if row["deleting"] or (cutoff_crossed and not row["grace"]):
            raise HttpError(410, "EXPIRED", "The retention period for this record has ended.")
        return row

    def object_payload(self, row: sqlite3.Row, days: int, now: int) -> dict[str, object]:
        expires = row["registered_at_ms"] + retention_ms(days)
        grace = bool(row["grace"] and expires <= now)
        availability, _ = self.files.read(row["relative_path"], row["byte_length"], row["checksum"], metadata_only=True)
        return {
            "id": row["id"], "name": row["name"], "status": row["status"], "revision": row["revision"],
            "registered_at_ms": row["registered_at_ms"], "found_at_ms": row["found_at_ms"],
            "expires_at_ms": expires, "retention_grace": grace,
            "roi": {key: row[f"roi_{key}"] for key in ("x", "y", "width", "height")},
            "reference_media": {
                "id": row["reference_media_id"], "role": "Reference", "content_type": row["format"],
                "width": row["reference_width"], "height": row["reference_height"],
                "byte_length": row["byte_length"], "created_at_ms": row["created_at_ms"], "availability": availability,
            },
        }

    def read_object(self, object_id: str, preparing: Collection[str]) -> dict[str, object]:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            row = self.require_eligible(db, db.execute(OBJECT_ROWS + " WHERE o.id = ?", (object_id,)).fetchone(),
                                        now, days)
            self.check_read_storage(db, now, preparing)
            result = self.object_payload(row, days, now)
        self.recheck_eligibility(object_id, session=False)
        return result

    def read_objects(
        self, folded_name: str, status: str, limit: int, before: tuple[int, str],
        preparing: Collection[str],
    ) -> tuple[list[dict[str, object]], tuple[int, str] | None]:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            db.create_function("unicode_casefold", 1, casefold, deterministic=True)
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            self.check_read_storage(db, now, preparing)
            # instr treats %, _ and backslash literally when matching bound text.
            rows = db.execute(OBJECT_ROWS + f"""
                WHERE {ELIGIBLE}
                AND (? = '' OR o.status = ?) AND instr(unicode_casefold(o.name), ?) > 0
                AND (o.registered_at_ms, o.id COLLATE BINARY) < (?, ?)
                ORDER BY o.registered_at_ms DESC, o.id COLLATE BINARY DESC LIMIT ?
            """, (now - retention_ms(days), status, status, folded_name, *before, limit + 1)).fetchall()
            items = [self.object_payload(row, days, now) for row in rows[:limit]]
        if items:
            eligible = self.eligible_owners({str(item["id"]) for item in items})
            items = [item for item in items if item["id"] in eligible]
        return items, (rows[limit - 1]["registered_at_ms"], rows[limit - 1]["id"]) if len(rows) > limit else None

    def search_setup(self) -> tuple[
        dict[str, object] | None, dict[str, object] | None, dict[str, object] | None, bool,
    ]:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            active = db.execute("SELECT * FROM sessions WHERE state IN ('Searching', 'Paused')").fetchone()
            cutoff = now - retention_ms(days)
            if active is not None:
                row = db.execute(OBJECT_ROWS + f" WHERE o.id = ? AND {ELIGIBLE}",
                                 (active["object_id"], cutoff)).fetchone()
                if row is None:
                    return None, None, None, False
                pending = db.execute(MATCH_ROWS + " WHERE c.session_id = ? AND c.disposition = 'Pending'",
                                     (active["id"],)).fetchone()
                return (self.session_payload(active), self.object_payload(row, days, now),
                        self.match_payload(pending) if pending else None, False)
            for path, length, checksum in db.execute(f"""
                SELECT m.relative_path, m.byte_length, m.checksum
                FROM objects AS o JOIN media AS m ON m.id = o.reference_media_id
                WHERE {ELIGIBLE} AND o.status = 'Lost' AND m.lifecycle = 'Ready'
            """, (cutoff,)):
                if self.files.read(path, length, checksum, metadata_only=True)[0] == "Available":
                    return None, None, None, True
            return None, None, None, False

    @staticmethod
    def session_payload(row: sqlite3.Row) -> dict[str, object]:
        return {**{field: row[field] for field in SESSION_FIELDS}, "pause_causes": json.loads(row["pause_causes"])}

    def match_payload(self, row: sqlite3.Row) -> dict[str, object]:
        availability, _ = self.files.read_evidence(
            row["relative_path"], row["byte_length"], row["checksum"], row["evidence_width"], row["evidence_height"],
        )
        return {
            **{field: row[field] for field in (
                "id", "session_id", "object_id", "captured_at_ms", "frame_id", "stream_epoch", "disposition",
                "reviewed_at_ms",
            )},
            "box": {key: row[f"box_{key}"] for key in ("x", "y", "width", "height")},
            "evidence_media": {
                "id": row["evidence_media_id"], "role": "Evidence", "content_type": "image/png",
                "width": row["evidence_width"], "height": row["evidence_height"], "byte_length": row["byte_length"],
                "created_at_ms": row["created_at_ms"], "availability": availability,
            },
        }

    def eligible_record(self, db: sqlite3.Connection, id: str, now: int, *, session: bool) -> sqlite3.Row:
        db.row_factory = sqlite3.Row
        if session:
            row = db.execute(f"""
                SELECT s.*, o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting
                FROM sessions AS s JOIN objects AS o ON o.id = s.object_id WHERE s.id = ?
            """, (id,)).fetchone()
        else:
            row = db.execute(f"""
                SELECT o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting FROM objects AS o WHERE o.id = ?
            """, (id,)).fetchone()
        return self.require_eligible(db, row, now, self.settings(db)["retention_days"])

    def recheck_eligibility(self, id: str, *, session: bool) -> None:
        with self.connect() as db, read_transaction(db):
            self.eligible_record(db, id, self.now()[0], session=session)

    def read_session(self, session_id: str, preparing: Collection[str]) -> dict[str, object]:
        with self.connect() as db, read_transaction(db):
            now, _ = self.now()
            session = self.eligible_record(db, session_id, now, session=True)
            self.check_read_storage(db, now, preparing)
            result = self.session_payload(session)
        self.recheck_eligibility(session_id, session=True)
        return result

    def read_history(
        self, parent: str, kind: HistoryKind, limit: int, before: tuple[int, str], preparing: Collection[str],
    ) -> tuple[list[dict[str, object]], tuple[int, str] | None]:
        with self.connect() as db, read_transaction(db):
            now, _ = self.now()
            self.eligible_record(db, parent, now, session=kind == "matches")
            self.check_read_storage(db, now, preparing)
            parameters = (parent, *before, limit + 1)
            if kind == "sessions":
                rows = db.execute("""
                    SELECT * FROM sessions WHERE object_id = ?
                    AND (started_at_ms, id COLLATE BINARY) < (?, ?)
                    ORDER BY started_at_ms DESC, id COLLATE BINARY DESC LIMIT ?
                """, parameters).fetchall()
                time_field = "started_at_ms"
                items = [self.session_payload(row) for row in rows[:limit]]
            else:
                rows = db.execute("""
                    SELECT c.*, m.relative_path, m.byte_length, m.checksum, m.created_at_ms
                    FROM match_events AS c JOIN media AS m ON m.id = c.evidence_media_id
                    WHERE c.session_id = ? AND (c.captured_at_ms, c.id COLLATE BINARY) < (?, ?)
                    ORDER BY c.captured_at_ms DESC, c.id COLLATE BINARY DESC LIMIT ?
                """, parameters).fetchall()
                time_field = "captured_at_ms"
                items = [self.match_payload(row) for row in rows[:limit]]
        self.recheck_eligibility(parent, session=kind == "matches")
        return items, (rows[limit - 1][time_field], rows[limit - 1]["id"]) if len(rows) > limit else None

    def read_media(self, media_id: str, preparing: Collection[str]) -> tuple[str, bytes]:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            row = self.require_eligible(db, db.execute(f"""
                SELECT m.*, o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting
                FROM media AS m JOIN objects AS o ON o.id = m.object_id
                WHERE m.id = ? AND m.lifecycle = 'Ready'
            """, (media_id,)).fetchone(), now, days)
            self.check_read_storage(db, now, preparing)
            if row["role"] == "Evidence":
                availability, data = self.files.read_evidence(
                    row["relative_path"], row["byte_length"], row["checksum"], row["width"], row["height"],
                )
            else:
                availability, data = self.files.read(row["relative_path"], row["byte_length"], row["checksum"])
        # Media validation can overlap a terminal commit, even while the read
        # transaction still sees its formerly eligible owner.
        self.recheck_eligibility(row["object_id"], session=False)
        if data is None:
            raise HttpError(503, "MEDIA_UNAVAILABLE", f"The managed image is {availability.lower()}.", True)
        return row["format"], data

    def check_read_storage(self, db: sqlite3.Connection, now: int, preparing: Collection[str]) -> Inspection:
        self.observe_due_cutoffs(db, now)
        inspection = self._inspect(db, now, preparing)
        # Finish startup recovery before opening records. During normal operation,
        # cleanup failures hide their owners without taking unexpired reads offline.
        if inspection.problem and (
            self._startup_cleanup_pending or not inspection.cleanup_pending or inspection.recovery_pending
        ):
            raise storage_unavailable(inspection.problem)
        return inspection

    def receipt(self, action_id: str, fingerprint: str) -> Receipt | None:
        with self.connect() as db, read_transaction(db):
            return self.find_receipt(db, action_id, fingerprint)

    def retention_receipt(self, action_id: str, fingerprint: str) -> tuple[Receipt | None, int]:
        with self.connect() as db, read_transaction(db):
            self.require_inactive(db)
            return self.find_receipt(db, action_id, fingerprint), self.settings(db)["revision"]

    def find_receipt(self, db: sqlite3.Connection, action_id: str, fingerprint: str) -> Receipt | None:
        previous = db.row_factory
        db.row_factory = sqlite3.Row
        try:
            row = db.execute(f"""
                SELECT r.*, o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting
                FROM action_receipts AS r LEFT JOIN objects AS o ON o.id = r.object_id
                WHERE r.action_id = ?
            """, (action_id,)).fetchone()
            if row is None:
                return None
            if row["object_id"] is not None:
                now, _ = self.now()
                self.require_eligible(db, row, now, self.settings(db)["retention_days"])
            if row["request_fingerprint"] != fingerprint:
                raise HttpError(409, "ACTION_ID_CONFLICT", "This action ID already belongs to a different request.")
            return Receipt(row["response_body"], row["response_status"], row["response_location"])
        finally:
            db.row_factory = previous

    def eligible_owners(self, owners: Collection[str | None]) -> set[str]:
        with self.connect() as db, read_transaction(db):
            now, _ = self.now()
            return {owner for owner, in db.execute(f"""
                SELECT id FROM objects AS o WHERE {ELIGIBLE}
                AND id IN (SELECT value FROM json_each(?))
            """, (self.cutoff(db, now), canonical_json(sorted(owner for owner in owners if owner is not None))))}

    def recover_preparations(self, db: sqlite3.Connection) -> None:
        for operation, owner, paths in db.execute("""
            SELECT id, owner_object_id, generated_paths FROM storage_operations WHERE kind = 'Prepare'
        """).fetchall():
            self.recover_preparation(db, operation, owner, json.loads(paths))
        for path in self.files.directory("staging").iterdir():
            stage = STAGING_NAME.fullmatch(path.name)
            if stage:
                relative = f"staging/{path.name}"
                if not db.execute("""
                    SELECT 1 FROM media WHERE id = ?
                    UNION ALL
                    SELECT 1 FROM storage_operations, json_each(generated_paths)
                    WHERE kind = 'Purge' AND value = ? LIMIT 1
                """, (stage[1], relative)).fetchone():
                    self.files.discard(relative)

    def recover_preparation(self, db: sqlite3.Connection, operation: str, owner: str | None, paths: object) -> None:
        if not isinstance(paths, list) or len(paths) != 2 or not all(isinstance(path, str) for path in paths):
            raise OSError("Invalid preparation journal")
        staging, final = paths
        stage = re.fullmatch(rf"staging/({GENERATED_ID})\.part", staging)
        if not stage or not re.fullmatch(rf"media/{stage[1]}\.(jpg|png)", final) or not owner:
            raise OSError("Invalid preparation journal")
        saved = db.execute("SELECT object_id, lifecycle FROM media WHERE relative_path = ?", (final,)).fetchone()
        if saved is None:
            self.files.discard(final)
        elif saved != (owner, "Ready"):
            raise OSError("Preparation journal does not own the recorded media")
        self.files.discard(staging)
        db.execute("DELETE FROM storage_operations WHERE id = ? AND kind = 'Prepare'", (operation,))

    def prepare_media(
        self, db: sqlite3.Connection, operation: str, owner: str, staging: str, final: str, data: bytes,
        *, boundary: str = "",
    ) -> str:
        checksum = self.files.stage(staging, data)
        self.checkpoint(boundary + "staged")
        with write_transaction(db):
            db.execute("""
                INSERT INTO storage_operations
                VALUES (?, 'Prepare', ?, ?, 'Pending', ?, NULL)
            """, (operation, owner, canonical_json([staging, final]), self.now()[0]))
        self.checkpoint(boundary + "journaled")
        self.files.promote(staging, final)
        self.checkpoint(boundary + "promoted")
        return checksum

    def discard_preparation(
        self, db: sqlite3.Connection, operation: str, owner: str, staging: str, final: str,
    ) -> None:
        try:
            self.recover_preparation(db, operation, owner, [staging, final])
        except (OSError, sqlite3.Error):
            self._repair_needed = True
            raise

    def save_registration(self, request: Registration, reference: Reference, fingerprint: str) -> tuple[Receipt, str]:
        owner, media_id = uuid4().hex, uuid4().hex
        extension = "jpg" if reference.content_type == "image/jpeg" else "png"
        staging = f"staging/{media_id}.part"
        final = f"media/{media_id}.{extension}"
        with self.mutation_connection() as db:
            invalid_clock_at = None
            try:
                checksum = self.prepare_media(db, request.action_id, owner, staging, final, reference.data)
                with write_transaction(db):
                    now, valid = self.now()
                    if not valid:
                        invalid_clock_at = now
                        raise HttpError(503, "NOT_READY", "Restore the system clock before registering a belonging.", True)
                    inspection = self._inspect(db, now, (request.action_id,))
                    if inspection.problem:
                        raise storage_unavailable(inspection.problem)
                    days = self.settings(db)["retention_days"]
                    roi = request.roi
                    db.execute("""
                        INSERT INTO objects
                           (id, name, status, registered_at_ms, roi_x, roi_y, roi_width, roi_height, revision,
                            reference_media_id, reference_width, reference_height)
                        VALUES (?, ?, 'Lost', ?, ?, ?, ?, ?, 1, ?, ?, ?)
                    """, (owner, request.name, now, roi["x"], roi["y"], roi["width"], roi["height"], media_id,
                          reference.width, reference.height))
                    db.execute("""
                        INSERT INTO media VALUES (?, ?, NULL, 'Reference', ?, ?, ?, ?, ?, ?, ?, 'Ready')
                    """, (media_id, owner, final, reference.content_type, reference.width, reference.height,
                          len(reference.data), checksum, now))
                    db.row_factory = sqlite3.Row
                    try:
                        row = db.execute(OBJECT_ROWS + " WHERE o.id = ?", (owner,)).fetchone()
                    finally:
                        db.row_factory = None
                    record = self.object_payload(row, days, now)
                    media = record["reference_media"]
                    if not isinstance(media, dict) or media["availability"] != "Available":
                        raise OSError("Promoted reference is not available")
                    result = {"object": record, "session": None, "match": None, "settings": None, "deletion": None}
                    receipt = Receipt(canonical_json({
                        "action_id": request.action_id, "persistence": "Committed", "result": result, "error": None,
                    }), 201, f"/api/v1/objects/{owner}")
                    db.execute("""
                        INSERT INTO action_receipts
                        VALUES (?, 'Object', ?, NULL, NULL, 'register', ?, 1, ?, ?, ?, ?, NULL)
                    """, (request.action_id, owner, fingerprint, now, receipt.status, receipt.body, receipt.location))
                    self.persist_clock(db, now)
                    db.execute("DELETE FROM storage_operations WHERE id = ?", (request.action_id,))
                    self.checkpoint("before_commit")
            except (OSError, sqlite3.Error, HttpError):
                # A committed reference is excluded by recovery's Ready-media ownership check.
                try:
                    if invalid_clock_at is not None:
                        self.persist_clock(db, invalid_clock_at)
                    self.discard_preparation(db, request.action_id, owner, staging, final)
                except (OSError, sqlite3.Error):
                    self._repair_needed = True
                    raise
                raise
            self.checkpoint("committed")
        return receipt, owner
