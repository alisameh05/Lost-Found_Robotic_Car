"""Atomic session transitions through the existing records writer."""

import json
import sqlite3
from collections.abc import Callable, Collection
from dataclasses import dataclass
from typing import cast

from .http import HttpError
from .registration_input import SAFE_INTEGER, canonical_json
from .search_input import SearchRequest
from .storage import (
    DELETING,
    GRACE,
    OBJECT_ROWS,
    Receipt,
    RecordsStorage,
    read_transaction,
    retention_ms,
    storage_unavailable,
    write_transaction,
)

Payload = dict[str, object]
EMPTY_RESULT: Payload = dict.fromkeys(("object", "session", "match", "settings", "deletion"))


@dataclass(frozen=True)
class SavedSearch:
    session: Payload | None
    owner: str | None
    removed: bool = False
    receipt: Receipt | None = None
    target: Payload | None = None


def search_record(db: sqlite3.Connection, request: SearchRequest, now: int, days: int) -> sqlite3.Row:
    if request.mode:
        row = db.execute(OBJECT_ROWS + " WHERE o.id = ?", (request.resource_id,)).fetchone()
    else:
        row = db.execute(f"""
            SELECT s.*, o.registered_at_ms, {GRACE} AS grace, {DELETING} AS deleting
            FROM sessions AS s JOIN objects AS o ON o.id = s.object_id WHERE s.id = ?
        """, (request.resource_id,)).fetchone()
    if row is None:
        raise HttpError(404, "NOT_FOUND", "The saved resource could not be found.")
    if row["deleting"] or (not row["grace"] and row["registered_at_ms"] + retention_ms(days) <= now):
        raise HttpError(410, "EXPIRED", "The retention period for this record has ended.")
    return cast(sqlite3.Row, row)


def verify_transition(row: sqlite3.Row, request: SearchRequest) -> None:
    if (row["status"] != "Lost" if request.mode else row["state"] == "Ended"):
        raise HttpError(409, "INVALID_TRANSITION", "The saved record does not allow this search action.")
    if row["revision"] != request.revision:
        raise HttpError(409, "REVISION_CONFLICT", "The saved record changed. Refresh and try again.",
                        revision=row["revision"])


def inspect_search(
    storage: RecordsStorage, request: SearchRequest, fingerprint: str, *, transition: bool = False,
) -> tuple[Receipt | None, str]:
    with storage.connect() as db, read_transaction(db):
        db.row_factory = sqlite3.Row
        now, _ = storage.now()
        row = search_record(db, request, now, storage.settings(db)["retention_days"])
        prior = storage.find_receipt(db, request.action_id, fingerprint)
        if transition and prior is None:
            if request.mode and storage.active_session_state(db):
                raise HttpError(409, "ACTIVE_SESSION_EXISTS", "A saved search is already active.")
            verify_transition(row, request)
        return prior, row["id" if request.mode else "object_id"]


def advance_revision(row: sqlite3.Row) -> None:
    if row["revision"] >= SAFE_INTEGER:
        raise HttpError(503, "COUNTER_EXHAUSTED", "The session revision cannot advance.")


def pause(db: sqlite3.Connection, row: sqlite3.Row, failure_id: str | None) -> None:
    causes = json.loads(row["pause_causes"])
    if failure_id is not None:
        cause = {"cause": "RecoveryRequired", "failure_id": failure_id}
        if cause in causes:
            return
        causes.append(cause)
    elif row["state"] == "Paused":
        return
    else:
        causes.append({"cause": "ManualPause", "failure_id": None})
    advance_revision(row)
    db.execute("UPDATE sessions SET state = 'Paused', pause_causes = ?, revision = revision + 1 WHERE id = ?",
               (canonical_json(causes), row["id"]))


def save_search(
    storage: RecordsStorage, request: SearchRequest, fingerprint: str, session_id: str,
    preparing: Collection[str], authorize: Callable[[bool], None],
) -> SavedSearch:
    with storage.mutation_connection() as db, write_transaction(db):
        db.row_factory = sqlite3.Row
        try:
            now, clock_valid = storage.now()
            days = storage.settings(db)["retention_days"]
            row = search_record(db, request, now, days)
            owner = row["id" if request.mode else "object_id"]
            prior = storage.find_receipt(db, request.action_id, fingerprint)
            if prior:
                return SavedSearch(None, owner, receipt=prior)
            if request.mode and storage.active_session_state(db):
                raise HttpError(409, "ACTIVE_SESSION_EXISTS", "A saved search is already active.")
            verify_transition(row, request)
            authorize(False)
            match = None
            target = None
            if request.mode:
                inspection = storage._inspect(db, now, preparing)
                if inspection.problem:
                    raise storage_unavailable(inspection.problem)
                if not clock_valid:
                    raise HttpError(503, "NOT_READY", "The local clock is unavailable.", True)
                target = storage.object_payload(row, days, now)
                media = target["reference_media"]
                if not isinstance(media, dict) or media["availability"] != "Available":
                    raise HttpError(503, "MEDIA_UNAVAILABLE", "The target reference is unavailable.")
                db.execute("""
                    INSERT INTO sessions (id, object_id, control_mode, state, started_at_ms, revision)
                    VALUES (?, ?, ?, 'Searching', ?, 1)
                """, (session_id, owner, request.mode, max(now, row["registered_at_ms"])))
            elif request.action == "pause":
                pause(db, row, None)
            else:
                advance_revision(row)
                pending = db.execute("""
                    SELECT c.*, m.relative_path, m.byte_length, m.checksum, m.created_at_ms
                    FROM match_events AS c JOIN media AS m ON m.id = c.evidence_media_id
                    WHERE c.session_id = ? AND c.disposition = 'Pending'
                """, (session_id,)).fetchone()
                if pending:
                    db.execute("UPDATE match_events SET disposition = 'NotReviewed' WHERE id = ?", (pending["id"],))
                db.execute("""
                    UPDATE sessions SET state = 'Ended', ended_at_ms = MAX(?, started_at_ms, COALESCE((
                        SELECT MAX(COALESCE(reviewed_at_ms, captured_at_ms)) FROM match_events WHERE session_id = ?
                    ), 0)), end_reason = 'Stopped', pause_causes = '[]', revision = revision + 1 WHERE id = ?
                """, (now, session_id, session_id))
                if pending and row["registered_at_ms"] + retention_ms(days) > now:
                    match = {**storage.match_payload(pending), "disposition": "NotReviewed"}

            saved = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            session = storage.session_payload(saved)
            storage.checkpoint(f"before_{request.action}_commit")
            authorize(True)
            now, _ = storage.now()
            expired = row["registered_at_ms"] + retention_ms(days) <= now
            if request.mode and expired:
                raise HttpError(410, "EXPIRED", "The retention period for this record has ended.")
            removed = request.action == "stop" and expired
            result = EMPTY_RESULT if removed else {**EMPTY_RESULT, "session": session, "match": match}
            receipt = Receipt(canonical_json({
                "action_id": request.action_id, "persistence": "Committed", "result": result, "error": None,
            }), 201 if request.mode else 200, f"/api/v1/sessions/{session_id}" if request.mode else None)
            db.execute("""
                INSERT INTO action_receipts VALUES (?, 'Object', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """, (request.action_id, owner, session_id, request.action, fingerprint, saved["revision"],
                  now, receipt.status, receipt.body, receipt.location))
            storage.persist_clock(db, now)
            return SavedSearch(None if removed else session, owner, removed, receipt, target)
        finally:
            db.row_factory = None


def save_safety_pause(storage: RecordsStorage, session_id: str, failure: Payload | None) -> SavedSearch:
    with storage.mutation_connection() as db, write_transaction(db):
        db.row_factory = sqlite3.Row
        try:
            row = db.execute("SELECT * FROM sessions WHERE id = ? AND state <> 'Ended'", (session_id,)).fetchone()
            if row is None:
                return SavedSearch(None, None)
            if failure is not None:
                db.execute("""
                    INSERT INTO session_emergencies (failure_id, session_id, observed_at_ms)
                    VALUES (?, ?, ?) ON CONFLICT (failure_id) DO NOTHING
                """, (failure["failure_id"], session_id, failure["observed_at_ms"]))
            pause(db, row, str(failure["failure_id"]) if failure else None)
            storage.checkpoint("before_safety_pause_commit")
            saved = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            return SavedSearch(storage.session_payload(saved), saved["object_id"])
        finally:
            db.row_factory = None
