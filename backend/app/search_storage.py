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
    ELIGIBLE,
    GRACE,
    MATCH_ROWS,
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
    acknowledged: tuple[str, ...] = ()
    restored: tuple[str, ...] = ()
    match: Payload | None = None


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


def verify_transition(
    db: sqlite3.Connection, row: sqlite3.Row, request: SearchRequest, now: int, days: int,
    superseded_resume: str | None,
) -> None:
    if (row["status"] != "Lost" if request.mode else row["state"] == "Ended"):
        raise HttpError(409, "INVALID_TRANSITION", "The saved record does not allow this search action.")
    # A safety action admitted at the visible revision may overtake its exact in-flight Resume commit.
    resume_committed = (superseded_resume is not None and request.safety_action and row["state"] == "Searching"
                        and row["revision"] == request.revision + 1 and db.execute("""
                            SELECT 1 FROM action_receipts WHERE action_id = ? AND session_id = ?
                            AND action_type = 'resume' AND result_revision = ?
                        """, (superseded_resume, row["id"], row["revision"])).fetchone() is not None)
    if row["revision"] != request.revision and not resume_committed:
        raise HttpError(409, "REVISION_CONFLICT", "The saved record changed. Refresh and try again.",
                        revision=row["revision"])
    if request.candidate_id:
        candidate = db.execute(f"""
            SELECT c.session_id, c.disposition
            FROM match_events AS c JOIN objects AS o ON o.id = c.object_id
            WHERE c.id = ? AND {ELIGIBLE}
        """, (request.candidate_id, now - retention_ms(days))).fetchone()
        if not candidate:
            raise HttpError(404, "NOT_FOUND", "The referenced candidate could not be found.")
        if candidate["session_id"] != row["id"]:
            raise HttpError(409, "OWNERSHIP_MISMATCH", "The candidate belongs to a different session.")
        if candidate["disposition"] != "Pending" or row["state"] != "Paused":
            raise HttpError(409, "INVALID_TRANSITION", "The candidate is no longer pending review.")
    if request.action == "resume":
        if row["state"] != "Paused":
            raise HttpError(409, "INVALID_TRANSITION", "Pause the search before resuming.")
        if db.execute("SELECT 1 FROM match_events WHERE session_id = ? AND disposition = 'Pending'",
                      (row["id"],)).fetchone():
            raise HttpError(409, "PENDING_REVIEW", "Complete the pending review before resuming.")
        if db.execute("""SELECT 1 FROM session_failures WHERE session_id = ? AND (NOT restored OR NOT acknowledged)
                      """, (row["id"],)).fetchone():
            raise HttpError(409, "RECOVERY_REQUIRED", "Restore and acknowledge each outstanding failure.")
    if request.failure_ids:
        placeholders = ",".join("?" for _ in request.failure_ids)
        failures = db.execute(f"""
            SELECT f.session_id
            FROM session_failures AS f JOIN sessions AS s ON s.id = f.session_id
            JOIN objects AS o ON o.id = s.object_id WHERE {ELIGIBLE} AND f.failure_id IN ({placeholders})
        """, (now - retention_ms(days), *request.failure_ids)).fetchall()
        if len(failures) != len(request.failure_ids):
            raise HttpError(404, "NOT_FOUND", "A referenced failure could not be found.")
        if any(f["session_id"] != row["id"] for f in failures):
            raise HttpError(409, "OWNERSHIP_MISMATCH", "A referenced failure belongs to a different session.")


def inspect_search(
    storage: RecordsStorage, request: SearchRequest, fingerprint: str, *, transition: bool = False,
    superseded_resume: str | None = None,
) -> tuple[Receipt | None, str]:
    with storage.connect() as db, read_transaction(db):
        db.row_factory = sqlite3.Row
        now, _ = storage.now()
        days = storage.settings(db)["retention_days"]
        row = search_record(db, request, now, days)
        prior = storage.find_receipt(db, request.action_id, fingerprint)
        if transition and prior is None:
            if request.mode and storage.active_session_state(db):
                raise HttpError(409, "ACTIVE_SESSION_EXISTS", "A saved search is already active.")
            verify_transition(db, row, request, now, days, superseded_resume)
        return prior, row["id" if request.mode else "object_id"]


def advance_revision(row: sqlite3.Row) -> None:
    if row["revision"] >= SAFE_INTEGER:
        raise HttpError(503, "COUNTER_EXHAUSTED", "The session revision cannot advance.")


def pause(db: sqlite3.Connection, row: sqlite3.Row) -> None:
    if row["state"] == "Paused":
        return
    causes = [{"cause": "ManualPause", "failure_id": None}]
    advance_revision(row)
    db.execute("UPDATE sessions SET state = 'Paused', pause_causes = ?, revision = revision + 1 WHERE id = ?",
               (canonical_json(causes), row["id"]))


def acknowledge(db: sqlite3.Connection, row: sqlite3.Row, ids: tuple[str, ...]) -> None:
    placeholders = ",".join("?" for _ in ids)
    updated = db.execute(f"""
        UPDATE session_failures SET acknowledged = 1
        WHERE NOT acknowledged AND failure_id IN ({placeholders})
    """, ids)
    if updated.rowcount:
        # The Paused record retains its causes until the explicit Resume transaction.
        advance_revision(row)
        db.execute("UPDATE sessions SET revision = revision + 1 WHERE id = ?", (row["id"],))


def review_candidate(
    storage: RecordsStorage, db: sqlite3.Connection, row: sqlite3.Row, candidate_id: str, action: str,
) -> Payload:
    candidate = db.execute("SELECT captured_at_ms FROM match_events WHERE id = ?", (candidate_id,)).fetchone()
    owner = db.execute("SELECT status, revision FROM objects WHERE id = ?", (row["object_id"],)).fetchone()
    if owner["status"] != "Lost":
        raise HttpError(409, "INVALID_TRANSITION", "The target is already Found.")
    advance_revision(row)
    reviewed = max(storage.now()[0], row["started_at_ms"], candidate["captured_at_ms"])
    disposition = "Confirmed" if action == "confirm" else "Rejected"
    db.execute("""
        UPDATE match_events SET disposition = ?, reviewed_at_ms = ? WHERE id = ?
    """, (disposition, reviewed, candidate_id))
    if action == "confirm":
        advance_revision(owner)
        db.execute("""
            UPDATE objects SET status = 'Found', found_at_ms = ?, revision = revision + 1 WHERE id = ?
        """, (reviewed, row["object_id"]))
        db.execute("""
            UPDATE sessions SET state = 'Ended', ended_at_ms = ?, end_reason = 'Confirmed', pause_causes = '[]',
                                revision = revision + 1 WHERE id = ?
        """, (reviewed, row["id"]))
    else:
        causes = [cause for cause in json.loads(row["pause_causes"]) if cause["cause"] != "CandidateReview"]
        causes.append({"cause": "ReviewRejected", "failure_id": None})
        db.execute("UPDATE sessions SET pause_causes = ?, revision = revision + 1 WHERE id = ?",
                   (canonical_json(causes), row["id"]))
    storage.checkpoint(f"before_{action}_commit")
    match = storage.match_payload(db.execute(MATCH_ROWS + " WHERE c.id = ?", (candidate_id,)).fetchone())
    evidence = match["evidence_media"]
    if not isinstance(evidence, dict) or evidence["availability"] != "Available":
        raise HttpError(503, "MEDIA_UNAVAILABLE", "The saved capture is missing or corrupt.", True)
    return match


def save_search(
    storage: RecordsStorage, request: SearchRequest, fingerprint: str, session_id: str,
    preparing: Collection[str], authorize: Callable[[bool], None], superseded_resume: str | None,
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
            verify_transition(db, row, request, now, days, superseded_resume)
            authorize(False)
            match = None
            target = None
            if request.mode or request.action in ("confirm", "reject"):
                inspection = storage._inspect(db, now, preparing)
                if inspection.problem:
                    raise storage_unavailable(inspection.problem)
            if request.mode:
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
                pause(db, row)
            elif request.action == "acknowledge":
                acknowledge(db, row, request.failure_ids)
            elif request.action == "resume":
                advance_revision(row)
                db.execute("UPDATE sessions SET state = 'Searching', pause_causes = '[]', revision = revision + 1 WHERE id = ?",
                           (session_id,))
            elif request.action == "stop":
                advance_revision(row)
                pending = db.execute(MATCH_ROWS + " WHERE c.session_id = ? AND c.disposition = 'Pending'",
                                     (session_id,)).fetchone()
                if pending:
                    db.execute("UPDATE match_events SET disposition = 'NotReviewed' WHERE id = ?", (pending["id"],))
                db.execute("""
                    UPDATE sessions SET state = 'Ended', ended_at_ms = MAX(?, started_at_ms, COALESCE((
                        SELECT MAX(COALESCE(reviewed_at_ms, captured_at_ms)) FROM match_events WHERE session_id = ?
                    ), 0)), end_reason = 'Stopped', pause_causes = '[]', revision = revision + 1 WHERE id = ?
                """, (now, session_id, session_id))
                if pending and row["registered_at_ms"] + retention_ms(days) > now:
                    match = {**storage.match_payload(pending), "disposition": "NotReviewed"}
            if request.action in ("confirm", "reject"):
                assert request.candidate_id is not None
                match = review_candidate(storage, db, row, request.candidate_id, request.action)

            saved = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            session = storage.session_payload(saved)
            if request.action not in ("confirm", "reject"):
                storage.checkpoint(f"before_{request.action}_commit")
            found = None
            if request.action == "confirm":
                object_row = db.execute(OBJECT_ROWS + " WHERE o.id = ?", (owner,)).fetchone()
                found = storage.object_payload(object_row, days, now)
            authorize(True)
            now, _ = storage.now()
            expired = row["registered_at_ms"] + retention_ms(days) <= now
            if request.mode and expired:
                raise HttpError(410, "EXPIRED", "The retention period for this record has ended.")
            removed = request.action in ("confirm", "stop") and expired
            if removed:
                storage.journal_owner(db, owner, now)
            result = EMPTY_RESULT if removed else {**EMPTY_RESULT, "object": found, "session": session, "match": match}
            receipt = Receipt(canonical_json({
                "action_id": request.action_id, "persistence": "Committed", "result": result, "error": None,
            }), 201 if request.mode else 200, f"/api/v1/sessions/{session_id}" if request.mode else None)
            db.execute("""
                INSERT INTO action_receipts VALUES (?, 'Object', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """, (request.action_id, owner, session_id, request.action, fingerprint, saved["revision"],
                  now, receipt.status, receipt.body, receipt.location))
            storage.persist_clock(db, now)
            saved_search = SavedSearch(None if removed else session, owner, removed, receipt, target,
                                       acknowledged=request.failure_ids)
        finally:
            db.row_factory = None
    if request.action in ("resume", "reject"):
        storage.checkpoint(f"after_{request.action}_commit")
    return saved_search


def save_safety_pause(storage: RecordsStorage, session_id: str, failures: tuple[Payload, ...]) -> SavedSearch:
    with storage.mutation_connection() as db, write_transaction(db):
        db.row_factory = sqlite3.Row
        try:
            row = db.execute("SELECT * FROM sessions WHERE id = ? AND state <> 'Ended'", (session_id,)).fetchone()
            if row is None:
                return SavedSearch(None, None)
            if not failures:
                pause(db, row)
            else:
                causes = json.loads(row["pause_causes"])
                changed = False
                for failure in failures:
                    updated = db.execute("""
                        INSERT INTO session_failures (failure_id, session_id, observed_at_ms, cause, restored)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT (failure_id) DO UPDATE SET restored = excluded.restored
                        WHERE session_failures.restored < excluded.restored
                    """, (failure["failure_id"], session_id, failure["observed_at_ms"], failure["cause"],
                          failure["restored"]))
                    if updated.rowcount:
                        changed = True
                        cause = {"cause": "RecoveryRequired", "failure_id": failure["failure_id"]}
                        if cause not in causes:
                            causes.append(cause)
                if changed:
                    advance_revision(row)
                    db.execute("UPDATE sessions SET state = 'Paused', pause_causes = ?, revision = revision + 1 WHERE id = ?",
                               (canonical_json(causes), session_id))
            storage.checkpoint("before_safety_pause_commit")
            saved = db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
            restored = tuple(str(failure["failure_id"]) for failure in failures if failure["restored"])
            return SavedSearch(storage.session_payload(saved), saved["object_id"], restored=restored)
        finally:
            db.row_factory = None
