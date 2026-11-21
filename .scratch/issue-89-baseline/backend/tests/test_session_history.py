"""Stored-history tests and explicitly test-only data setup."""

import hashlib
import json
import sqlite3
from contextlib import closing
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.config import Config
from backend.app.main import create_app
from backend.app.storage import DAY_MS, RecordsStorage
from backend.tests.test_object_library import NOW, seed_objects
from backend.tests.test_records import BASE, credentials, wait_for_health


def captured_png(
    size: tuple[int, int] = (80, 40), accent: tuple[int, int, int] = (251, 37, 59),
) -> bytes:
    with Image.new("RGB", size, (20, 90, 160)) as image, BytesIO() as output:
        image.putpixel((79, 39), accent)
        image.save(output, format="PNG")
        return output.getvalue()


def seed_history(root: Path, now: int) -> None:
    """Populate a temporary database at the storage seam, never through an application route."""
    with Image.new("RGB", (1, 1), "white") as reference, BytesIO() as output:
        reference.save(output, format="PNG")
        seed_objects(root, [
            ("history-owner", "History test · Wallet", "Lost", now - 60_000),
            ("different-owner", "History test · Keys", "Lost", now - 55_000),
        ], {"history-owner": output.getvalue()})
    with closing(sqlite3.connect(root / "records.sqlite3")) as db, db:
        db.execute("PRAGMA foreign_keys = ON")
        sessions = [
            ("session-Z", "history-owner", "Gestures", now - 50_000, now - 44_000, "Stopped"),
            ("session-a", "history-owner", "Controller", now - 50_000, now - 43_000, "Stopped"),
            ("session-confirmed", "history-owner", "Gestures", now - 35_000, now - 29_000, "Confirmed"),
            ("session-other", "different-owner", "Controller", now - 31_000, now - 30_000, "Stopped"),
        ]
        db.executemany("INSERT INTO sessions VALUES (?, ?, ?, 'Ended', ?, ?, ?, '[]', 2)", sessions)
        db.execute(
            "UPDATE objects SET status = 'Found', found_at_ms = ?, revision = 2 WHERE id = 'history-owner'",
            (now - 29_000,),
        )
        cases = [
            ("match-Z", "session-a", now - 49_000, "Rejected", now - 48_000, (30, 51, 94), (5, 4, 20, 12)),
            ("match-a", "session-a", now - 49_000, "NotReviewed", None, (80, 35, 100), (50, 20, 20, 12)),
            ("match-confirmed", "session-confirmed", now - 30_000, "Confirmed", now - 29_000, (251, 37, 59), (10, 8, 30, 16)),
        ]
        for match_id, session, captured, disposition, reviewed, accent, box in cases:
            insert_match(db, root, match_id, session, "history-owner", captured, disposition, reviewed,
                         captured_png(accent=accent), box=box)


def insert_match(
    db: sqlite3.Connection, root: Path, match: str, session: str, owner: str,
    captured: int, disposition: str, reviewed: int | None, frame: bytes, *,
    size: tuple[int, int] = (80, 40), box: tuple[int, int, int, int] = (10, 8, 30, 16),
) -> None:
    media = f"evidence-{match}"
    relative = f"media/{media}.png"
    db.execute(
        """INSERT INTO match_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (match, session, owner, captured, f"frame-{match}", "epoch-capture", *box, disposition, reviewed, media, *size),
    )
    db.execute(
        """INSERT INTO media VALUES (?, ?, ?, 'Evidence', ?, 'image/png', ?, ?, ?, ?, ?, 'Ready')""",
        (media, owner, match, relative, *size, len(frame), hashlib.sha256(frame).hexdigest(), captured),
    )
    (root / relative).write_bytes(frame)


def test_protected_history_uses_shared_models_and_binary_keysets(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ticks = 0
    monkeypatch.setattr("backend.app.runtime.monotonic", lambda: ticks)
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        other_client = credentials(browser)
        owner_sessions = "/api/v1/objects/history-owner/sessions"
        assert browser.get(owner_sessions, headers=headers).status_code == 404
        seed_history(tmp_path, NOW)
        session_path = "/api/v1/sessions/session-a"
        matches_path = f"{session_path}/matches"
        assert browser.get(matches_path).json()["code"] == "CAPABILITY_INVALID"
        assert browser.get(matches_path, headers={"X-App-Capability": headers["X-App-Capability"]}).json()["code"] == "CLIENT_INVALID"
        assert browser.get(matches_path, headers=headers, params={"status": "Found"}).status_code == 422
        assert browser.get(matches_path, headers=headers, params=[("limit", 1), ("limit", 2)]).status_code == 422

        first = browser.get(owner_sessions, headers=headers, params={"limit": 2})
        assert first.status_code == 200 and first.headers["cache-control"] == "no-store"
        sessions = first.json()
        assert [item["id"] for item in sessions["items"]] == ["session-confirmed", "session-a"]
        assert browser.get(session_path, headers=headers).json() == {
            "id": "session-a", "object_id": "history-owner", "control_mode": "Controller", "state": "Ended",
            "started_at_ms": NOW - 50_000, "ended_at_ms": NOW - 43_000, "end_reason": "Stopped",
            "pause_causes": [], "revision": 2,
        } == sessions["items"][1]
        continuation = {"limit": 2, "cursor": sessions["next_cursor"]}
        for route, client in [
            ("/api/v1/objects/different-owner/sessions", headers), (owner_sessions, other_client), (matches_path, headers),
        ]:
            assert browser.get(route, headers=client, params=continuation).json()["code"] == "CURSOR_INVALID"
        assert [item["id"] for item in browser.get(owner_sessions, headers=headers, params=continuation).json()["items"]] == ["session-Z"]

        page = browser.get(matches_path, headers=headers, params={"limit": 1}).json()
        assert [item["id"] for item in page["items"]] == ["match-a"]
        assert browser.get("/api/v1/sessions/session-Z/matches", headers=headers, params={
            "limit": 1, "cursor": page["next_cursor"],
        }).json()["code"] == "CURSOR_INVALID"
        next_page = browser.get(matches_path, headers=headers, params={"limit": 1, "cursor": page["next_cursor"]}).json()
        assert [item["id"] for item in next_page["items"]] == ["match-Z"]
        assert next_page["next_cursor"] is None
        assert browser.get("/api/v1/sessions/session-other/matches", headers=headers).json() == {"items": [], "next_cursor": None}
        ticks = 1799
        assert browser.get(matches_path, headers=headers, params={"limit": 1, "cursor": page["next_cursor"]}).status_code == 200
        ticks = 1800
        assert browser.get(matches_path, headers=headers, params={"limit": 1, "cursor": page["next_cursor"]}).json()["code"] == "CURSOR_EXPIRED"


def seed_interrupted(root: Path, now: int, *, paused: bool = True) -> None:
    """Store one unfinished session and a separate uncommitted evidence preparation."""
    with closing(sqlite3.connect(root / "records.sqlite3")) as db, db:
        db.execute("PRAGMA foreign_keys = ON")
        causes = '[{"cause":"CandidateReview","failure_id":null}]' if paused else "[]"
        db.execute("INSERT INTO sessions VALUES ('session-interrupted', 'different-owner', 'Controller', ?, ?, NULL, NULL, ?, 3)",
                   ("Paused" if paused else "Searching", now - 10_000, causes))
        if paused:
            insert_match(db, root, "match-pending", "session-interrupted", "different-owner", now - 5_000,
                         "Pending", None, captured_png())
        generated = "a" * 32
        staging, promoted = f"staging/{generated}.part", f"media/{generated}.png"
        db.execute(
            "INSERT INTO storage_operations VALUES ('prepared-capture', 'Prepare', 'different-owner', ?, 'Pending', ?, NULL)",
            (json.dumps([staging, promoted]), now),
        )
        (root / staging).write_bytes(b"incomplete")
        (root / promoted).write_bytes(b"uncommitted")


def test_exact_evidence_unavailability_does_not_rewrite_a_committed_review(tmp_path: Path) -> None:
    config = Config(tmp_path)
    with TestClient(create_app(config, storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        seed_history(tmp_path, NOW)
        route = "/api/v1/sessions/session-confirmed/matches"
        capture = browser.get(route, headers=headers).json()["items"][0]
        assert capture["frame_id"] == "frame-match-confirmed" and capture["stream_epoch"] == "epoch-capture"
        assert capture["box"] == {"x": 10, "y": 8, "width": 30, "height": 16}
        media = f"/api/v1/media/{capture['evidence_media']['id']}"
        response = browser.get(media, headers={**headers, "Range": "bytes=0-12"})
        assert response.status_code == 200 and response.content == captured_png()
        assert response.headers["content-type"] == "image/png" and response.headers["cache-control"] == "no-store"
        assert response.headers["x-content-type-options"] == "nosniff" and response.headers["accept-ranges"] == "none"
        rejected = browser.get("/api/v1/sessions/session-a/matches", headers=headers).json()["items"][1]
        assert rejected["frame_id"] == "frame-match-Z" and rejected["box"] == {"x": 5, "y": 4, "width": 20, "height": 12}
        other_frame = browser.get(f"/api/v1/media/{rejected['evidence_media']['id']}", headers=headers)
        assert other_frame.status_code == 200 and other_frame.content == captured_png(accent=(30, 51, 94))
        assert other_frame.content != response.content
        saved = tmp_path / "media" / "evidence-match-confirmed.png"
        saved.unlink()
        for availability in ("Missing", "Corrupt"):
            item = browser.get(route, headers=headers).json()["items"][0]
            assert item["evidence_media"]["availability"] == availability
            assert item["disposition"] == "Confirmed" and item["reviewed_at_ms"] == NOW - 29_000
            error = browser.get(media, headers=headers)
            assert error.status_code == 503 and error.json()["code"] == "MEDIA_UNAVAILABLE"
            assert browser.get("/api/v1/objects/history-owner", headers=headers).json()["status"] == "Found"
            if availability == "Missing":
                frame = captured_png()
                saved.write_bytes(frame[:-1] + bytes([frame[-1] ^ 1]))
        assert browser.get("/api/v1/media/unknown", headers=headers).status_code == 404


def test_evidence_can_exceed_the_reference_upload_dimensions(tmp_path: Path) -> None:
    size = (5120, 4096)
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        seed_history(tmp_path, NOW)
        frame = captured_png(size)
        with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            insert_match(db, tmp_path, "large", "session-other", "different-owner", NOW - 30_500,
                         "NotReviewed", None, frame, size=size)
        saved = browser.get("/api/v1/sessions/session-other/matches", headers=headers).json()["items"][0]["evidence_media"]
        assert (saved["width"], saved["height"], saved["availability"]) == (*size, "Available")
        assert browser.get("/api/v1/media/evidence-large", headers=headers).content == frame


def test_evidence_with_a_saved_digest_still_requires_a_complete_png(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        seed_history(tmp_path, NOW)
        frame = captured_png()
        with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            cases = {
                "truncated": frame[:-4],
                "bad-crc": frame[:-1] + bytes([frame[-1] ^ 1]),
                "trailing": frame + b"trailing bytes",
            }
            for label, data in cases.items():
                insert_match(db, tmp_path, label, "session-other", "different-owner", NOW - 30_500,
                             "NotReviewed", None, data)
        saved = browser.get("/api/v1/sessions/session-other/matches", headers=headers).json()["items"]
        assert {item["id"]: item["evidence_media"]["availability"] for item in saved} == dict.fromkeys(cases, "Corrupt")
        for label in cases:
            response = browser.get(f"/api/v1/media/evidence-{label}", headers=headers)
            assert response.status_code == 503 and response.json()["code"] == "MEDIA_UNAVAILABLE"


@pytest.mark.parametrize("paused", [True, False])
def test_startup_reconciles_unfinished_sessions_and_preparation(tmp_path: Path, paused: bool) -> None:
    config = Config(tmp_path)
    with TestClient(create_app(config, storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, credentials(browser))
        seed_history(tmp_path, NOW)
    seed_interrupted(tmp_path, NOW, paused=paused)

    for elapsed in (1000, 2000):
        with TestClient(create_app(config, storage=RecordsStorage(tmp_path, clock=lambda: NOW + elapsed)), base_url=BASE) as browser:
            wait_for_health(browser, headers := credentials(browser))
            interrupted = browser.get("/api/v1/sessions/session-interrupted", headers=headers).json()
            assert (interrupted["state"], interrupted["end_reason"], interrupted["revision"]) == ("Ended", "Interrupted", 4)
            assert interrupted["ended_at_ms"] == NOW + 1000 and interrupted["pause_causes"] == []
            items = browser.get("/api/v1/sessions/session-interrupted/matches", headers=headers).json()["items"]
            if paused:
                assert items[0]["disposition"] == "NotReviewed" and items[0]["reviewed_at_ms"] is None
                evidence = browser.get("/api/v1/media/evidence-match-pending", headers=headers)
                assert evidence.status_code == 200 and evidence.content == captured_png()
            else:
                assert items == []
            assert browser.get("/api/v1/sessions/session-confirmed", headers=headers).json()["end_reason"] == "Confirmed"
            matches = browser.get("/api/v1/sessions/session-a/matches", headers=headers).json()["items"]
            assert [(item["disposition"], item["reviewed_at_ms"]) for item in matches] == [
                ("NotReviewed", None), ("Rejected", NOW - 48_000),
            ]
            assert browser.get("/api/v1/snapshot", headers=headers).json()["active_session"] is None
            assert not (tmp_path / "staging" / ("a" * 32 + ".part")).exists()
            assert not (tmp_path / "media" / ("a" * 32 + ".png")).exists()


def test_expiry_denies_every_history_resource_even_with_a_current_cursor(tmp_path: Path) -> None:
    now = NOW
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: now)), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        seed_history(tmp_path, now)
        sessions = "/api/v1/objects/history-owner/sessions"
        matches = "/api/v1/sessions/session-a/matches"
        tokens = [browser.get(route, headers=headers, params={"limit": 1}).json()["next_cursor"]
                  for route in (sessions, matches)]
        now += 7 * DAY_MS - 60_000
        for route, token in zip((sessions, matches), tokens, strict=True):
            for cursor in (token, "wrong"):
                expired = browser.get(route, headers=headers, params={"limit": 1, "cursor": cursor})
                assert expired.json()["code"] == {410: "EXPIRED", 404: "NOT_FOUND"}[expired.status_code]
        for route in ("/api/v1/sessions/session-a", "/api/v1/media/evidence-match-a"):
            assert browser.get(route, headers=headers).status_code in (410, 404)
        assert browser.get("/api/v1/sessions/unknown/matches", headers=headers).status_code == 404
        assert browser.get("/api/v1/sessions/session-other", headers=headers).status_code == 200


def test_history_schema_rejects_cross_owner_associations_and_rewritten_facts(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, credentials(browser))
        seed_history(tmp_path, NOW)
    with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db:
        db.execute("PRAGMA foreign_keys = ON")
        statements = [
            ("INSERT INTO match_events VALUES ('cross', 'session-a', 'different-owner', ?, 'frame', 'epoch', "
             "0,0,1,1,'NotReviewed',NULL,'capture',80,40)", (NOW - 49_000,)),
            ("INSERT INTO sessions VALUES ('before', 'different-owner', 'Controller', 'Ended', ?, ?, 'Stopped', '[]', 1)",
             (NOW - 55_001, NOW - 54_000)),
            ("INSERT INTO sessions VALUES ('restart', 'history-owner', 'Controller', 'Searching', ?, NULL, NULL, '[]', 1)",
             (NOW - 29_000,)),
            ("UPDATE sessions SET end_reason = 'Confirmed' WHERE id = 'session-a'", ()),
            ("INSERT INTO sessions VALUES ('later', 'history-owner', 'Controller', 'Ended', ?, ?, 'Confirmed', '[]', 1)",
             (NOW - 30_000, NOW - 28_000)),
            ("UPDATE match_events SET disposition = 'Confirmed' WHERE id = 'match-Z'", ()),
            ("UPDATE match_events SET box_x = 0 WHERE id = 'match-Z'", ()),
            ("UPDATE media SET checksum = ? WHERE id = 'evidence-match-a'", ("a" * 64,)),
            ("UPDATE objects SET found_at_ms = ? WHERE id = 'history-owner'", (NOW - 27_000,)),
        ]
        for sql, params in statements:
            with pytest.raises(sqlite3.IntegrityError), db:
                db.execute(sql, params)
        with pytest.raises(sqlite3.IntegrityError, match="match is outside its session"), db:
            insert_match(db, tmp_path, "too-late", "session-a", "history-owner", NOW - 49_000,
                         "Rejected", NOW - 42_999, captured_png())
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"), db:
            insert_match(db, tmp_path, "another-confirmation", "session-confirmed", "history-owner", NOW - 30_000,
                         "Confirmed", NOW - 29_000, captured_png())
        with pytest.raises(sqlite3.IntegrityError, match="FOREIGN KEY"), db:
            db.execute(
                "INSERT INTO match_events VALUES ('owned', 'session-a', 'history-owner', ?, "
                "'frame', 'epoch', 0, 0, 1, 1, 'NotReviewed', NULL, 'cross', 80, 40)", (NOW - 49_000,),
            )
            db.execute(
                "INSERT INTO media VALUES ('cross', 'different-owner', 'owned', 'Evidence', 'media/cross.png', "
                "'image/png', 80, 40, 1, ?, ?, 'Ready')", ("a" * 64, NOW - 49_000),
            )
