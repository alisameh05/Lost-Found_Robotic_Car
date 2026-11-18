import hashlib
import sqlite3
import time
from collections.abc import Iterator
from contextlib import closing, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TypedDict

DAY_MS = 86_400_000
MIGRATIONS = Path(__file__).with_name("migrations")


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


def utc_ms() -> int:
    return time.time_ns() // 1_000_000


@contextmanager
def transaction(db: sqlite3.Connection, *, write: bool = False) -> Iterator[None]:
    db.execute("BEGIN IMMEDIATE" if write else "BEGIN")
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
            "SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
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
    def __init__(self, root: Path):
        self.path = root / "records.sqlite3"

    @contextmanager
    def connect(self, *, initialize: bool = False) -> Iterator[sqlite3.Connection]:
        if self.path.is_symlink():
            raise OSError
        mode = "rwc" if initialize else "ro"
        with closing(sqlite3.connect(f"{self.path.as_uri()}?mode={mode}", uri=True, isolation_level=None)) as db:
            db.execute("PRAGMA foreign_keys = ON")
            db.execute("PRAGMA synchronous = FULL")
            yield db

    def initialize(self) -> None:
        with self.connect(initialize=True) as db:
            # Detect incompatible manifests before making durability changes to an existing database.
            migrate(db)
            if db.execute("PRAGMA journal_mode = WAL").fetchone() != ("wal",):
                raise IncompatibleStorage

    def inspect(self) -> Inspection:
        try:
            with self.connect() as db, transaction(db):
                return self._inspect(db)
        except (OSError, sqlite3.Error):
            return Inspection(problem="Records storage cannot be read. Check local storage and restart the backend.")

    def _inspect(self, db: sqlite3.Connection) -> Inspection:
        row = db.execute("SELECT retention_days, revision, updated_at_ms FROM app_settings WHERE id = 1").fetchone()
        if row is None:
            return Inspection(problem="The saved retention settings are missing. Restore the data and restart.")
        days, revision, updated = row
        settings = Settings(retention_days=days, revision=revision, updated_at_ms=updated)
        cutoff = utc_ms() - days * DAY_MS
        needs_purge, count, files = db.execute(
            """WITH due AS (
                   SELECT id FROM objects WHERE deletion_pending = 1 OR registered_at_ms <= ?
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
        if db.execute("SELECT 1 FROM storage_operations LIMIT 1").fetchone() or db.execute(
            "SELECT 1 FROM media WHERE lifecycle = 'Staging' LIMIT 1"
        ).fetchone():
            return Inspection(settings, "A storage operation needs recovery. Keep the data intact for recovery.")
        if db.execute("SELECT 1 FROM sessions WHERE state <> 'Ended' LIMIT 1").fetchone() or db.execute(
            "SELECT 1 FROM match_events WHERE disposition = 'Pending' LIMIT 1"
        ).fetchone():
            return Inspection(settings, "Interrupted search records need recovery. Keep the data intact for recovery.")
        if db.execute("SELECT 1 FROM objects LIMIT 1").fetchone():
            return Inspection(settings, "This backend version cannot open existing object records. Keep the data intact.")
        return Inspection(settings)
