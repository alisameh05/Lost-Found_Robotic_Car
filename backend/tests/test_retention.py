"""Default retention through protected HTTP and real managed storage."""

import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient

from backend.app.config import Config
from backend.app.main import create_app
from backend.app.storage import DAY_MS, RecordsStorage, utc_ms
from backend.tests.test_object_library import seed_objects
from backend.tests.test_process import connect, free_port, launch
from backend.tests.test_records import BASE, credentials, wait_for_health
from backend.tests.test_registration import PNG, context_headers, submit
from backend.tests.test_session_history import captured_png, insert_match


def wait_for_cleanup(browser: TestClient, headers: dict[str, str], status: str) -> dict:
    deadline = monotonic() + 8
    while monotonic() < deadline:
        reply = browser.get("/api/v1/snapshot", headers=headers)
        body = reply.json()
        snapshot = body if reply.status_code == 200 else body.get("snapshot")
        if snapshot and snapshot["retention"]["deletion"]["status"] == status:
            return snapshot
        sleep(0.03)
    raise AssertionError(f"Cleanup did not reach {status}: {body}")


@pytest.mark.parametrize("days", [1, 7, 30])
def test_deadline_removes_the_owner_receipt_and_managed_copy_without_polling(tmp_path: Path, days: int) -> None:
    registered = now = 1_800_000_000_000
    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: 0.0)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        response = submit(browser, headers, submitted=registered)
        assert response.status_code == 201
        saved = response.json()["result"]["object"]
        assert saved["expires_at_ms"] == registered + 7 * DAY_MS
        media = saved["reference_media"]["id"]
        managed = next((tmp_path / "media").iterdir())
        if days != 7:
            with closing(sqlite3.connect(storage.path)) as db, db:
                db.execute("UPDATE app_settings SET retention_days = ?, revision = 2", (days,))
        now += days * DAY_MS - 1
        detail = browser.get(response.headers["location"], headers=headers)
        assert detail.status_code == 200
        assert detail.json()["expires_at_ms"] == registered + days * DAY_MS
        assert detail.json()["registered_at_ms"] == registered
        assert browser.get(f"/api/v1/media/{media}", headers=headers).status_code == 200

        now += 1
        deadline = monotonic() + 5
        with closing(sqlite3.connect(storage.path)) as db:
            while monotonic() < deadline and (
                db.execute("SELECT 1 FROM objects").fetchone()
                or db.execute("SELECT 1 FROM storage_operations").fetchone()
            ):
                sleep(0.02)
            for table in ("objects", "media", "action_receipts", "storage_operations"):
                assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)
        assert not managed.exists()
        assert browser.get(response.headers["location"], headers=headers).status_code == 404
        assert browser.get(f"/api/v1/media/{media}", headers=headers).status_code == 404
        snapshot = browser.get("/api/v1/snapshot", headers=headers).json()
        assert snapshot["retention"]["deletion"]["status"] == "Complete"
        assert not snapshot["operations"]


@pytest.mark.parametrize("state", ["Searching", "Paused"])
@pytest.mark.parametrize("restart", [False, True])
def test_active_owner_keeps_grace_only_until_end_or_interrupted_restart(
    tmp_path: Path, state: str, restart: bool,
) -> None:
    registered = now = 1_800_000_000_000
    action = str(uuid4())
    config = Config(tmp_path)
    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: 0.0)
    with TestClient(create_app(config, storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        saved = submit(browser, headers, submitted=registered, action=action)
        owner = saved.json()["result"]["object"]["id"]
        with closing(sqlite3.connect(storage.path)) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            causes = '[]' if state == "Searching" else '[{"cause":"CandidateReview","failure_id":null}]'
            db.execute("INSERT INTO sessions VALUES ('active',?,'Controller',?,?,NULL,NULL,?,1)",
                       (owner, state, registered, causes))
            if state == "Paused":
                insert_match(db, tmp_path, "active-frame", "active", owner, registered, "Pending", None, captured_png())
        now += 2
        unrelated = submit(browser, headers, submitted=now)
        now = registered + 7 * DAY_MS
        detail = browser.get(saved.headers["location"], headers=headers).json()
        assert detail["retention_grace"] and detail["registered_at_ms"] == registered
        assert detail["expires_at_ms"] == now
        assert browser.get("/api/v1/sessions/active", headers=headers).json()["state"] == state
        if state == "Paused":
            assert browser.get("/api/v1/media/evidence-active-frame", headers=headers).status_code == 200
        assert submit(browser, headers, submitted=registered, action=action).content == saved.content
        assert browser.post(f"{saved.headers['location']}/sessions", headers=headers).status_code == 404
        wait_for_cleanup(browser, headers, "Complete")
        if not restart:
            with closing(sqlite3.connect(storage.path)) as db, db:
                db.execute("UPDATE match_events SET disposition='NotReviewed' WHERE session_id='active'")
                db.execute("""UPDATE sessions SET state='Ended', end_reason='Stopped', ended_at_ms=?,
                              pause_causes='[]' WHERE id='active'""", (now,))
            wait_for_cleanup(browser, headers, "Complete")
            assert browser.get(saved.headers["location"], headers=headers).status_code == 404
    if restart:
        now -= DAY_MS  # A clock rollback cannot restore grace after interruption.
    with TestClient(create_app(config, storage=RecordsStorage(
        tmp_path, clock=lambda: now, monotonic=lambda: 0.0,
    )), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        assert browser.get(saved.headers["location"], headers=headers).status_code == 404
        assert browser.get(unrelated.headers["location"], headers=headers).status_code == 200
        with closing(sqlite3.connect(storage.path)) as db:
            assert db.execute("SELECT id FROM sessions").fetchall() == []
            assert db.execute("SELECT id FROM match_events").fetchall() == []
            assert db.execute("SELECT id FROM media WHERE object_id=?", (owner,)).fetchall() == []
            assert db.execute("SELECT action_id FROM action_receipts WHERE object_id=?", (owner,)).fetchall() == []
            assert db.execute("SELECT id FROM storage_operations").fetchall() == []
        assert not (tmp_path / "media" / "evidence-active-frame.png").exists()


def test_pending_purge_denies_access_and_reports_rows_and_actual_files(tmp_path: Path) -> None:
    now = 1_800_000_000_000
    entered, proceed = Event(), Event()

    def checkpoint(boundary: str) -> None:
        if boundary == "purge_journaled":
            entered.set()
            assert proceed.wait(8)

    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: 0.0, checkpoint=checkpoint)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        seed_objects(tmp_path, [("due", "Old umbrella", "Lost", now - 7 * DAY_MS + 1)])
        now += 1
        try:
            assert entered.wait(5)
            assert browser.get("/api/v1/objects/due", headers=headers).status_code == 410
            assert browser.get("/api/v1/media/due-reference", headers=headers).status_code == 410
            assert submit(browser, headers, submitted=now).json()["code"] == "STORAGE_UNAVAILABLE"
            snapshot = wait_for_cleanup(browser, headers, "Pending")
            assert snapshot["retention"]["deletion"] == {
                "status": "Pending", "remaining_objects": 1, "remaining_files": 0, "error_code": None,
            }
            with closing(sqlite3.connect(storage.path)) as db:
                assert db.execute("SELECT deletion_pending FROM objects").fetchall() == [(1,)]
                assert db.execute("SELECT generated_paths FROM storage_operations").fetchall() == [
                    ('["media/due-reference.png"]',),
                ]
        finally:
            proceed.set()
        wait_for_cleanup(browser, headers, "Complete")


def test_missing_managed_directories_reconcile_without_restart(tmp_path: Path) -> None:
    now = 1_800_000_000_000
    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: 0.0)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        saved = submit(browser, headers, submitted=now)
        next((tmp_path / "media").iterdir()).unlink()
        (tmp_path / "media").rmdir()
        (tmp_path / "staging").rmdir()
        now += 7 * DAY_MS
        assert wait_for_cleanup(browser, headers, "Complete")["operations"] == []
        assert browser.get(saved.headers["location"], headers=headers).status_code == 404
        assert list((tmp_path / "media").iterdir()) == []
        assert list((tmp_path / "staging").iterdir()) == []


def test_a_media_read_overtaken_by_expiry_cannot_return_the_loaded_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 1_800_000_000_000
    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: 0.0)
    loaded, release = Event(), Event()
    read_file = storage.files.read

    def held_read(*args, **kwargs):
        result = read_file(*args, **kwargs)
        if result[1] is not None:
            loaded.set()
            assert release.wait(8)
        return result

    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        media = submit(browser, headers, submitted=now).json()["result"]["object"]["reference_media"]["id"]
        monkeypatch.setattr(storage.files, "read", held_read)
        with ThreadPoolExecutor(max_workers=1) as reader:
            pending = reader.submit(browser.get, f"/api/v1/media/{media}", headers=headers)
            try:
                assert loaded.wait(3)
                now += 7 * DAY_MS
                wait_for_cleanup(browser, headers, "Complete")
            finally:
                release.set()
            response = pending.result(timeout=3)
            assert response.status_code in (404, 410)
            assert response.json()["code"] in ("NOT_FOUND", "EXPIRED")


@pytest.mark.parametrize("fault", ["disk full", "denied", "hard link", "traversal"])
def test_failed_purge_never_exposes_or_replays_and_recovers_after_repair(
    tmp_path: Path, fault: str, monkeypatch: pytest.MonkeyPatch,
) -> None:
    registered = now = 1_800_000_000_000
    broken = True

    def checkpoint(boundary: str) -> None:
        if broken and fault == "disk full" and boundary == "purge_before_journal":
            raise sqlite3.OperationalError("database or disk is full")

    root = tmp_path / "records"
    storage = RecordsStorage(root, clock=lambda: now, monotonic=lambda: 0.0, checkpoint=checkpoint)
    original = tmp_path / "original.png"
    original.write_bytes(PNG)
    with TestClient(create_app(Config(root), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        action = str(uuid4())
        saved = submit(browser, headers, submitted=registered, action=action, image=original.read_bytes())
        assert saved.status_code == 201
        owner = saved.json()["result"]["object"]["id"]
        managed = next((root / "media").iterdir())
        staging = root / "staging" / f"{managed.stem}.part"
        staging.write_bytes(b"Interrupted staging owned by this reference")
        discard = storage.files.discard
        encoded_paths = None
        if fault == "denied":
            def deny(path: str) -> None:
                if broken and path == f"media/{managed.name}":
                    raise PermissionError("Managed file is in use")
                discard(path)
            monkeypatch.setattr(storage.files, "discard", deny)
        elif fault == "hard link":
            managed.unlink()
            os.link(original, managed)
        elif fault == "traversal":
            with closing(sqlite3.connect(storage.path)) as db, db:
                db.execute("UPDATE objects SET deletion_pending = 1 WHERE id = ?", (owner,))
                encoded_paths = json.dumps([f"media/{managed.name}", f"staging/{managed.stem}.part"])
                db.execute("INSERT INTO storage_operations VALUES ('test','Purge',?,?, 'Pending',?,NULL)",
                           (owner, '["media/../../original.png"]', now))
        now += 7 * DAY_MS
        snapshot = wait_for_cleanup(browser, headers, "Failed")
        assert snapshot["retention"]["deletion"]["remaining_objects"] == 1
        assert snapshot["retention"]["deletion"]["remaining_files"] >= 1
        assert snapshot["operations"] == []
        assert browser.get(saved.headers["location"], headers=headers).status_code == 410
        assert submit(browser, headers, submitted=registered, action=action).json()["code"] == "EXPIRED"
        assert submit(browser, headers, submitted=now).json()["code"] == "STORAGE_UNAVAILABLE"
        assert original.read_bytes() == PNG
        if fault == "hard link":
            managed.unlink()
        if encoded_paths:
            with closing(sqlite3.connect(storage.path)) as db, db:
                db.execute("UPDATE storage_operations SET generated_paths=? WHERE kind='Purge'", (encoded_paths,))
        broken = False
        wait_for_cleanup(browser, headers, "Complete")
        assert not managed.exists() and not staging.exists() and original.read_bytes() == PNG
        assert submit(browser, headers, submitted=registered, action=action).json()["code"] == "ACTION_EXPIRED"
        assert submit(browser, headers, submitted=now).status_code == 201


@pytest.mark.parametrize("boundary,files_left,rows_left,journals_left", [
    ("purge_before_journal", 1, 1, 0),
    ("purge_journaled", 1, 1, 1),
    ("purge_file_removed", 0, 1, 1),
    ("purge_rows_removed", 0, 0, 1),
    ("purge_journal_removed", 0, 0, 0),
])
def test_process_death_during_startup_purge_recovers_on_restart(
    tmp_path: Path, boundary: str, files_left: int, rows_left: int, journals_left: int,
) -> None:
    root = tmp_path / "records"
    root.mkdir()
    storage = RecordsStorage(root)
    storage.initialize()
    storage.close()
    seed_objects(root, [("old", "Expired keys", "Lost", utc_ms() - 8 * DAY_MS)], {"old": PNG})
    crashed = launch(root, free_port(), ("backend.tests.crash_registration", boundary))
    try:
        crashed.communicate(timeout=15)
        assert crashed.returncode == 84
    finally:
        if crashed.poll() is None:
            crashed.kill()
            crashed.communicate(timeout=10)
    with closing(sqlite3.connect(storage.path)) as db:
        assert db.execute("SELECT COUNT(*) FROM objects").fetchone() == (rows_left,)
        assert db.execute("SELECT COUNT(*) FROM storage_operations").fetchone() == (journals_left,)
    assert len(list((root / "media").iterdir())) == files_left

    port = free_port()
    recovered = launch(root, port)
    try:
        headers = context_headers(connect(recovered, port))
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            assert http.get("/api/v1/objects/old", headers=headers).status_code == 404
            assert http.get("/api/v1/snapshot", headers=headers).json()["retention"]["deletion"]["status"] == "Complete"
        with closing(sqlite3.connect(storage.path)) as db:
            for table in ("objects", "media", "sessions", "match_events", "action_receipts", "storage_operations"):
                assert db.execute(f"SELECT COUNT(*) FROM {table}").fetchone() == (0,)
        assert not list((root / "media").iterdir())
    finally:
        recovered.kill()
        recovered.communicate(timeout=10)


def test_runtime_crash_before_journal_then_clock_rollback_does_not_restore_access(tmp_path: Path) -> None:
    root = tmp_path / "records"
    registered = utc_ms() - 6 * DAY_MS
    storage = RecordsStorage(root, clock=lambda: registered, monotonic=lambda: 0.0)
    with TestClient(create_app(Config(root), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        saved = submit(browser, headers, submitted=registered)
        reference = saved.json()["result"]["object"]["reference_media"]["id"]
        owned_stage = root / "staging" / (reference + ".part")
        owned_stage.write_bytes(PNG)
        orphan = root / "staging" / ("a" * 32 + ".part")
        orphan.write_bytes(PNG)

    clock = tmp_path / "clock-offset"
    clock.write_text("0")
    port = free_port()
    crashed = launch(root, port, ("backend.tests.crash_registration", "clock", str(clock), "purge_before_journal"))
    try:
        headers = context_headers(connect(crashed, port))
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            assert http.get(saved.headers["location"], headers=headers).status_code == 200
        assert owned_stage.is_file() and not orphan.exists()
        clock.write_text(str(2 * DAY_MS))
        crashed.communicate(timeout=15)
        assert crashed.returncode == 84
    finally:
        if crashed.poll() is None:
            crashed.kill()
            crashed.communicate(timeout=10)
    assert owned_stage.is_file()
    with closing(sqlite3.connect(storage.path)) as db:
        assert db.execute("SELECT deletion_pending FROM objects").fetchall() == [(0,)]
        assert not db.execute("SELECT 1 FROM storage_operations").fetchone()

    recovered = launch(root, port)
    try:
        headers = context_headers(connect(recovered, port))
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            assert http.get(saved.headers["location"], headers=headers).status_code == 404
        assert not owned_stage.exists()
        assert not list((root / "media").iterdir())
    finally:
        recovered.kill()
        recovered.communicate(timeout=10)
