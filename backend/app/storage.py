import hashlib
import json
import re
import sqlite3
import time
from collections.abc import Callable, Collection, Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import TypedDict
from uuid import uuid4

from .http import HttpError
from .managed_media import GENERATED_ID, STAGING_NAME, ManagedMedia, sync_directory
from .reference_image import Reference
from .registration_input import Registration, canonical_json

DAY_MS = 86_400_000
SUBMISSION_WINDOW = 600_000
CLOCK_TOLERANCE = 2_000
MIGRATIONS = Path(__file__).with_name("migrations")
RECONCILE_ERROR = "A storage operation needs recovery. Keep the data intact for recovery."
GRACE = """EXISTS (SELECT 1 FROM sessions AS active
                   WHERE active.object_id = o.id AND active.state IN ('Searching', 'Paused'))"""
DELETING = """(o.deletion_pending OR EXISTS (
               SELECT 1 FROM storage_operations AS purge WHERE purge.kind = 'Purge' AND purge.owner_object_id = o.id))"""
OBJECT_ROWS = f"""
    SELECT o.*, m.relative_path, m.format, m.byte_length, m.checksum, m.created_at_ms,
           {GRACE} AS grace, {DELETING} AS deleting
    FROM objects AS o JOIN media AS m ON m.id = o.reference_media_id
"""


class Settings(TypedDict):
    retention_days: int
    revision: int
    updated_at_ms: int


@dataclass(frozen=True)
class Inspection:
    settings: Settings | None = None
    problem: str | None = None
    cleanup_pending: bool = False
    remaining_objects: int = 0
    remaining_files: int = 0


class IncompatibleStorage(Exception):
    pass


class StorageRecoveryRequired(Exception):
    pass


@dataclass(frozen=True)
class Receipt:
    body: str
    status: int
    location: str | None


def storage_unavailable(message: str = "Records storage is unavailable. Check local storage and retry.") -> HttpError:
    return HttpError(503, "STORAGE_UNAVAILABLE", message, True)


def utc_ms() -> int:
    return time.time_ns() // 1_000_000


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
        self.clock = clock
        self.monotonic = monotonic
        self.checkpoint = checkpoint or (lambda _: None)
        self._clock_lock = Lock()
        self._wall_floor = 0
        self._repair_needed = False
        self._anchor = (clock(), monotonic())

    @contextmanager
    def connect(self, *, initialize: bool = False, write: bool = False) -> Iterator[sqlite3.Connection]:
        if self.path.is_symlink():
            raise OSError
        mode = "rwc" if initialize else "rw" if write else "ro"
        with closing(sqlite3.connect(f"{self.path.as_uri()}?mode={mode}", uri=True, isolation_level=None)) as db:
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("PRAGMA synchronous = FULL")
            yield db

    def initialize(self) -> None:
        with self.writer, self.connect(initialize=True) as db:
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
            self.files.directory("media", create=True)
            self.files.directory("staging", create=True)
            sync_directory(self.files.root)
            try:
                self.recover_preparations(db)
            except (OSError, sqlite3.Error) as exc:
                raise StorageRecoveryRequired(RECONCILE_ERROR) from exc
            if db.execute("SELECT 1 FROM sessions WHERE state <> 'Ended' LIMIT 1").fetchone() or db.execute(
                "SELECT 1 FROM match_events WHERE disposition = 'Pending' LIMIT 1"
            ).fetchone():
                raise StorageRecoveryRequired("Interrupted search records need recovery. Keep the data intact.")

    def inspect(self, preparing: Collection[str] = ()) -> Inspection:
        try:
            with self.connect() as db, read_transaction(db):
                now, _ = self.now()
                result = self._inspect(db, now, preparing)
            if result.cleanup_pending:
                # Preserve an observed expiry if the wall clock moves backwards across a restart.
                self.observe_clock(now)
            return result
        except (OSError, sqlite3.Error):
            return Inspection(problem="Records storage cannot be read. Check local storage and restart the backend.")

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
        with self.writer, self.connect(write=True) as db:
            self.persist_clock(db, now)

    @staticmethod
    def settings(db: sqlite3.Connection) -> Settings:
        row = db.execute("SELECT retention_days, revision, updated_at_ms FROM app_settings WHERE id = 1").fetchone()
        if row is None:
            raise sqlite3.DatabaseError("Missing settings singleton")
        days, revision, updated = row
        return Settings(retention_days=days, revision=revision, updated_at_ms=updated)

    def _inspect(self, db: sqlite3.Connection, now: int, preparing: Collection[str]) -> Inspection:
        settings = self.settings(db)
        cutoff = now - settings["retention_days"] * DAY_MS
        needs_purge, count, files = db.execute(
            f"""WITH due AS (
                   SELECT id FROM objects AS o
                   WHERE deletion_pending = 1 OR (registered_at_ms <= ? AND NOT {GRACE})
               ), purge AS (
                   SELECT owner_object_id, generated_paths FROM storage_operations WHERE kind = 'Purge'
               ), pending_owners AS (
                   SELECT id FROM due UNION SELECT owner_object_id FROM purge WHERE owner_object_id IS NOT NULL
               ), pending_paths AS (
                   SELECT relative_path FROM media WHERE object_id IN (SELECT id FROM pending_owners)
                   UNION SELECT value FROM purge, json_each(purge.generated_paths) WHERE type = 'text'
               )
               SELECT EXISTS(SELECT 1 FROM due) OR EXISTS(SELECT 1 FROM purge),
                      (SELECT COUNT(*) FROM pending_owners), (SELECT COUNT(*) FROM pending_paths)""",
            (cutoff,),
        ).fetchone()
        if needs_purge:
            return Inspection(settings, "Retention cleanup is incomplete. Keep the data intact for recovery.",
                              True, count, files)
        if self._repair_needed or any(
            row[0] not in preparing or row[1] != "Pending"
            for row in db.execute("SELECT id, phase FROM storage_operations")
        ) or db.execute("SELECT 1 FROM media WHERE lifecycle = 'Staging' LIMIT 1").fetchone():
            return Inspection(settings, RECONCILE_ERROR)
        return Inspection(settings)

    def require_new_registration(self, submitted_at: int, preparing: Collection[str]) -> None:
        now, clock_valid = self.now()
        if not clock_valid:
            raise HttpError(503, "NOT_READY", "Restore the system clock before registering a belonging.", True)
        inspection = self.inspect(preparing)
        if inspection.problem:
            raise storage_unavailable(inspection.problem)
        if not 0 <= self.clock() - submitted_at <= SUBMISSION_WINDOW:
            # An observed stale submission must not become new work after a clock rollback and restart.
            self.observe_clock(now)
            raise HttpError(410, "ACTION_EXPIRED", "The registration submission window has ended.")

    def require_eligible(self, row: sqlite3.Row | None, now: int, days: int) -> sqlite3.Row:
        if row is None:
            raise HttpError(404, "NOT_FOUND", "The saved resource could not be found.")
        expired = row["registered_at_ms"] <= now - days * DAY_MS and not row["grace"]
        if expired:
            try:
                self.observe_clock(now)
            except (OSError, sqlite3.Error):
                self._repair_needed = True
        if row["deleting"] or expired:
            raise HttpError(410, "EXPIRED", "The retention period for this record has ended.")
        return row

    def object_payload(self, row: sqlite3.Row, days: int, now: int) -> dict[str, object]:
        expires = row["registered_at_ms"] + days * DAY_MS
        availability, _ = self.files.read(row["relative_path"], row["byte_length"], row["checksum"], metadata_only=True)
        return {
            "id": row["id"], "name": row["name"], "status": row["status"], "revision": row["revision"],
            "registered_at_ms": row["registered_at_ms"], "found_at_ms": row["found_at_ms"],
            "expires_at_ms": expires, "retention_grace": bool(row["grace"] and expires <= now),
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
            row = self.require_eligible(db.execute(OBJECT_ROWS + " WHERE o.id = ?", (object_id,)).fetchone(), now, days)
            self.check_read_storage(db, now, preparing)
            return self.object_payload(row, days, now)

    def read_objects(
        self, folded_name: str, status: str, limit: int, before: tuple[int, str],
        preparing: Collection[str],
    ) -> tuple[list[dict[str, object]], tuple[int, str] | None]:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            db.create_function("unicode_casefold", 1, str.casefold, deterministic=True)
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            inspection = self._inspect(db, now, preparing)
            if inspection.problem:
                raise storage_unavailable(inspection.problem)
            rows = db.execute(OBJECT_ROWS + f"""
                WHERE NOT o.deletion_pending AND (o.registered_at_ms > ? OR {GRACE})
                AND (? = '' OR o.status = ?) AND instr(unicode_casefold(o.name), ?) > 0
                AND (o.registered_at_ms, o.id) < (?, ?)
                ORDER BY o.registered_at_ms DESC, o.id DESC LIMIT ?
            """, (now - days * DAY_MS, status, status, folded_name, *before, limit + 1)).fetchall()
            items = [self.object_payload(row, days, now) for row in rows[:limit]]
            return items, (rows[limit - 1]["registered_at_ms"], rows[limit - 1]["id"]) if len(rows) > limit else None

    def read_media(self, media_id: str, preparing: Collection[str]) -> tuple[str, bytes]:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            row = self.require_eligible(db.execute(f"""
                SELECT m.*, o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting
                FROM media AS m JOIN objects AS o ON o.id = m.object_id
                WHERE m.id = ? AND m.lifecycle = 'Ready'
            """, (media_id,)).fetchone(), now, days)
            self.check_read_storage(db, now, preparing)
            availability, data = self.files.read(row["relative_path"], row["byte_length"], row["checksum"])
        if data is None:
            raise HttpError(503, "MEDIA_UNAVAILABLE", f"The managed image is {availability.lower()}.", True)
        return row["format"], data

    def check_read_storage(self, db: sqlite3.Connection, now: int, preparing: Collection[str]) -> None:
        inspection = self._inspect(db, now, preparing)
        if inspection.problem and not inspection.cleanup_pending:
            raise storage_unavailable(inspection.problem)

    def receipt(self, action_id: str, fingerprint: str) -> Receipt | None:
        with self.connect() as db, read_transaction(db):
            db.row_factory = sqlite3.Row
            row = db.execute(f"""
                SELECT r.*, o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting
                FROM action_receipts AS r LEFT JOIN objects AS o ON o.id = r.object_id
                WHERE r.action_id = ?
            """, (action_id,)).fetchone()
            if row is None:
                return None
            if row["object_id"] is not None:
                now, _ = self.now()
                self.require_eligible(row, now, self.settings(db)["retention_days"])
            if row["request_fingerprint"] != fingerprint:
                raise HttpError(409, "ACTION_ID_CONFLICT", "This action ID already belongs to a different request.")
            return Receipt(row["response_body"], row["response_status"], row["response_location"])

    def retain_terminal(self, owner: str) -> bool:
        with self.connect() as db, read_transaction(db):
            now, _ = self.now()
            days = self.settings(db)["retention_days"]
            return db.execute(f"""
                SELECT 1 FROM objects AS o WHERE id = ? AND NOT {DELETING}
                AND (registered_at_ms > ? OR {GRACE})
            """, (owner, now - days * DAY_MS)).fetchone() is not None

    def recover_preparations(self, db: sqlite3.Connection) -> None:
        for operation, owner, paths in db.execute("""
            SELECT id, owner_object_id, generated_paths FROM storage_operations WHERE kind = 'Prepare'
        """).fetchall():
            self.recover_preparation(db, operation, owner, json.loads(paths))
        for path in self.files.directory("staging").iterdir():
            if STAGING_NAME.fullmatch(path.name):
                relative = f"staging/{path.name}"
                if not db.execute("SELECT 1 FROM media WHERE relative_path = ?", (relative,)).fetchone():
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

    def save_registration(self, request: Registration, reference: Reference, fingerprint: str) -> tuple[Receipt, str]:
        owner, media_id = uuid4().hex, uuid4().hex
        extension = "jpg" if reference.content_type == "image/jpeg" else "png"
        staging = f"staging/{media_id}.part"
        final = f"media/{media_id}.{extension}"
        with self.writer, self.connect(write=True) as db:
            try:
                checksum = self.files.stage(staging, reference.data)
                self.checkpoint("staged")
                with write_transaction(db):
                    db.execute("""
                        INSERT INTO storage_operations
                        VALUES (?, 'Prepare', ?, ?, 'Pending', ?, NULL)
                    """, (request.action_id, owner, canonical_json([staging, final]), self.now()[0]))
                self.checkpoint("journaled")
                self.files.promote(staging, final)
                self.checkpoint("promoted")
                with write_transaction(db):
                    now, valid = self.now()
                    if not valid:
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
                    row = db.execute(OBJECT_ROWS + " WHERE o.id = ?", (owner,)).fetchone()
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
                        VALUES (?, 'Object', ?, NULL, NULL, 'register', ?, 1, ?, ?, ?, ?)
                    """, (request.action_id, owner, fingerprint, now, receipt.status, receipt.body, receipt.location))
                    self.persist_clock(db, now)
                    db.execute("DELETE FROM storage_operations WHERE id = ?", (request.action_id,))
                    self.checkpoint("before_commit")
            except (OSError, sqlite3.Error, HttpError):
                # A committed reference is excluded by recovery's Ready-media ownership check.
                try:
                    self.recover_preparation(db, request.action_id, owner, [staging, final])
                except (OSError, sqlite3.Error):
                    self._repair_needed = True
                    raise
                raise
            self.checkpoint("committed")
        return receipt, owner
