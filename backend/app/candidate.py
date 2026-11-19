"""Candidate evidence preparation and the linked durable review transition."""

import math
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from uuid import uuid4

from PIL import Image

from .registration_input import canonical_json
from .search_storage import SavedSearch, advance_revision
from .simulation import Capture
from .storage import MATCH_ROWS, RecordsStorage, write_transaction

Box = tuple[int, int, int, int]


@dataclass(frozen=True)
class CandidateCapture:
    id: str
    session: str
    owner: str
    revision: int
    generation: int
    frame_id: str
    captured_at_ms: int
    capture: Capture
    box: Box


def evidence_box(raw: tuple[float, float, float, float], width: int, height: int) -> Box | None:
    if (not isinstance(raw, tuple) or len(raw) != 4
            or not all(type(value) in (int, float) and 0 <= value <= max(width, height) for value in raw)):
        return None
    x, y, w, h = raw
    if not (0 <= x < x + w <= width and 0 <= y < y + h <= height):
        return None
    left, top = math.floor(x), math.floor(y)
    right, bottom = min(width, math.ceil(x + w)), min(height, math.ceil(y + h))
    if left >= right or top >= bottom:
        return None
    return left, top, right - left, bottom - top


def encode_evidence(capture: Capture) -> bytes:
    with Image.open(BytesIO(capture.jpeg), formats=["JPEG"]) as image:
        if image.size != (capture.width, capture.height):
            raise ValueError("The sampled robot frame dimensions changed.")
        output = BytesIO()
        rgb = image.convert("RGB")
        rgb.info.clear()
        rgb.save(output, format="PNG")
        return output.getvalue()


def save_candidate(
    storage: RecordsStorage, work: CandidateCapture, data: bytes, current: Callable[[], bool],
) -> SavedSearch | None:
    media_id = uuid4().hex
    staging, final = f"staging/{media_id}.part", f"media/{media_id}.png"
    capture = work.capture
    with storage.mutation_connection() as db:
        if not current():
            return None
        committed = False
        try:
            checksum = storage.prepare_media(db, work.id, work.owner, staging, final, data, boundary="candidate_")
            with write_transaction(db):
                db.row_factory = sqlite3.Row
                session = db.execute("""
                    SELECT s.* FROM sessions AS s JOIN objects AS o ON o.id = s.object_id
                    WHERE s.id = ? AND s.object_id = ? AND s.revision = ? AND s.state = 'Searching'
                      AND o.status = 'Lost' AND NOT o.deletion_pending
                """, (work.session, work.owner, work.revision)).fetchone()
                if not session or not current():
                    return None
                advance_revision(session)
                created = max(storage.now()[0], work.captured_at_ms)
                db.execute("""
                    UPDATE sessions SET state = 'Paused', pause_causes = ?, revision = revision + 1 WHERE id = ?
                """, (canonical_json([{"cause": "CandidateReview", "failure_id": None}]), work.session))
                db.execute("""
                    INSERT INTO match_events
                        (id, session_id, object_id, captured_at_ms, frame_id, stream_epoch,
                         box_x, box_y, box_width, box_height, disposition, evidence_media_id,
                         evidence_width, evidence_height)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?)
                """, (work.id, work.session, work.owner, work.captured_at_ms, work.frame_id, capture.stream_epoch,
                      *work.box, media_id, capture.width, capture.height))
                db.execute("""
                    INSERT INTO media (id, object_id, match_event_id, role, relative_path, format, width, height,
                                       byte_length, checksum, created_at_ms, lifecycle)
                    VALUES (?, ?, ?, 'Evidence', ?, 'image/png', ?, ?, ?, ?, ?, 'Ready')
                """, (media_id, work.owner, work.id, final, capture.width, capture.height, len(data), checksum, created))
                saved = db.execute("SELECT * FROM sessions WHERE id = ?", (work.session,)).fetchone()
                match = storage.match_payload(db.execute(MATCH_ROWS + " WHERE c.id = ?", (work.id,)).fetchone())
                media = match["evidence_media"]
                if not isinstance(media, dict) or media["availability"] != "Available":
                    raise OSError("The promoted candidate evidence is unavailable.")
                storage.persist_clock(db, created)
                db.execute("DELETE FROM storage_operations WHERE id = ?", (work.id,))
                storage.checkpoint("before_candidate_commit")
                if not current():
                    # The context manager commits normal returns, so explicitly roll back these writes.
                    db.rollback()
                    return None
            committed = True
            return SavedSearch(storage.session_payload(saved), work.owner, match=match)
        finally:
            db.row_factory = None
            if not committed:
                storage.discard_preparation(db, work.id, work.owner, staging, final)
