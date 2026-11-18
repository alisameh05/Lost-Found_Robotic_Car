"""Configurable retention through the protected HTTP API and real storage."""

import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path
from threading import Event
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
from backend.tests.test_retention import wait_for_cleanup
from backend.tests.test_session_history import captured_png, insert_match

PREVIEW = "/api/v1/settings/retention-preview"
COMMIT = "/api/v1/settings/retention"
SETTINGS = "/api/v1/settings"


def proposal(client: httpx.Client, headers: dict[str, str], days: int, revision: int = 1) -> dict:
    response = client.post(PREVIEW, headers=headers, json={"expected_revision": revision, "retention_days": days})
    assert response.status_code == 200, response.text
    return response.json()


def confirmation(preview: dict) -> dict:
    return {
        "action_id": str(uuid4()), "expected_revision": preview["settings_revision"],
        "retention_days": preview["retention_days"], "preview_id": preview["preview_id"], "confirmed": True,
    }


def error_code(response: httpx.Response) -> str:
    body = response.json()
    return (body.get("error") or body)["code"]


def test_preview_is_read_only_and_commit_purges_only_the_confirmed_impact(tmp_path: Path) -> None:
    registered = now = 1_800_000_000_000
    elapsed = 0.0
    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: elapsed)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        owner_action = str(uuid4())
        saved = submit(browser, headers, submitted=registered, action=owner_action)
        reference = saved.json()["result"]["object"]["reference_media"]
        now += 2 * DAY_MS
        original = browser.get(SETTINGS, headers=headers).json()
        reply = browser.post(PREVIEW, headers=headers, json={"expected_revision": 1, "retention_days": 1})
        assert reply.status_code == 200, reply.text
        preview = reply.json()
        assert preview["impact"] == {"objects": 1, "sessions": 0, "matches": 0,
                                     "managed_image_bytes": reference["byte_length"]}
        assert browser.get(SETTINGS, headers=headers).json() == original
        assert browser.get(saved.headers["location"], headers=headers).status_code == 200

        unrelated = submit(browser, headers, submitted=now, name="Unrelated")
        action = {"action_id": str(uuid4()), "expected_revision": 1, "retention_days": 1,
                  "preview_id": preview["preview_id"], "confirmed": True}
        applied = browser.put(COMMIT, headers=headers, json=action)
        assert applied.status_code == 200, applied.text
        assert applied.json()["result"]["settings"]["revision"] == 2
        assert applied.json()["result"]["deletion"]["status"] == "Pending"
        assert browser.get(saved.headers["location"], headers=headers).status_code in (404, 410)
        wait_for_cleanup(browser, headers, "Complete")
        assert browser.get(unrelated.headers["location"], headers=headers).json()["registered_at_ms"] == now
        assert len(list((tmp_path / "media").iterdir())) == 1

        elapsed += 61
        now += 61_000
        replay = browser.put(COMMIT, headers=credentials(browser), json=action)
        assert (replay.status_code, replay.content) == (200, applied.content)
        assert browser.put(COMMIT, headers=headers, json={**action, "retention_days": 2}).json()["code"] == "ACTION_ID_CONFLICT"
        assert error_code(submit(browser, headers, submitted=registered, action=owner_action)) == "ACTION_EXPIRED"
        with closing(sqlite3.connect(storage.path)) as db:
            canonical, digest, body = db.execute("""
                SELECT canonical_request, request_fingerprint, response_body FROM action_receipts WHERE scope='Settings'
            """).fetchone()
            assert json.loads(canonical) == {"scope": "Settings", "action_type": "retention", "resource_id": None,
                "expected_revision": 1, "payload": {
                    "retention_days": 1, "preview_id": preview["preview_id"], "confirmed": True,
                }}
            assert hashlib.sha256(canonical.encode()).hexdigest() == digest
            assert body.encode() == applied.content
            assert db.execute("SELECT 1 FROM action_receipts WHERE action_id=?", (owner_action,)).fetchone() is None


@pytest.mark.parametrize("race", ["client", "days", "revision", "elapsed", "crossing", "media size",
                                  "same counts replacement", "new evidence", "reclaimed"])
def test_commit_rejects_a_changed_preview(tmp_path: Path, race: str) -> None:
    now = 1_800_000_000_000
    elapsed = 0.0
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(
        tmp_path, clock=lambda: now, monotonic=lambda: elapsed,
    )), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        initial_age = 2 * DAY_MS - 1 if race == "crossing" else 3 * DAY_MS
        seed_objects(tmp_path, [("old", "Old record", "Lost", now - initial_age)], {"old": PNG})
        action = confirmation(proposal(browser, headers, 2))
        if race == "client":
            headers = credentials(browser)
        elif race == "days":
            action["retention_days"] += 1
        elif race == "revision":
            assert browser.put(COMMIT, headers=headers, json=confirmation(proposal(browser, headers, 30))).status_code == 200
        elif race == "elapsed":
            elapsed = 60.0
        elif race == "crossing":
            now += 1
        elif race == "media size":
            (tmp_path / "media" / "old-reference.png").write_bytes(PNG + b"changed size")
        elif race == "same counts replacement":
            with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
                db.execute("PRAGMA foreign_keys = ON")
                db.execute("DELETE FROM objects WHERE id='old'")
            seed_objects(tmp_path, [("replacement", "Old record", "Lost", now - initial_age)], {"replacement": PNG})
        elif race == "new evidence":
            with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
                db.execute("PRAGMA foreign_keys = ON")
                db.execute("INSERT INTO sessions VALUES ('stored','old','Controller','Ended',?,?,'Stopped','[]',1)",
                           (now - 2, now))
                insert_match(db, tmp_path, "capture", "stored", "old", now - 1, "NotReviewed", None, captured_png())
        elif race == "reclaimed":
            for _ in range(32):
                proposal(browser, headers, 2)
        rejected = browser.put(COMMIT, headers=headers, json=action)
        assert rejected.status_code == 409, rejected.text
        assert error_code(rejected) == "PREVIEW_STALE"
        assert browser.get(SETTINGS, headers=headers).json()["retention_days"] == (30 if race == "revision" else 7)


@pytest.mark.parametrize("state", ["Searching", "Paused"])
def test_active_session_blocks_preview_and_commit_but_allows_registration(tmp_path: Path, state: str) -> None:
    now = 1_800_000_000_000
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(
        tmp_path, clock=lambda: now, monotonic=lambda: 0,
    )), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        saved = submit(browser, headers, submitted=now).json()["result"]["object"]
        preview = proposal(browser, headers, 30)
        with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            causes = '[]' if state == "Searching" else '[{"cause":"ManualPause","failure_id":null}]'
            db.execute("INSERT INTO sessions VALUES ('active',?,'Controller',?,?,NULL,NULL,?,1)",
                       (saved["id"], state, now, causes))
        response = browser.get("/api/v1/health", headers=headers)
        assert response.json()["active_session_state"] == state
        assert error_code(browser.post(PREVIEW, headers=headers, json={
            "expected_revision": 1, "retention_days": 30,
        })) == "ACTIVE_SESSION_EXISTS"
        assert error_code(browser.put(COMMIT, headers=headers, json=confirmation(preview))) == "ACTIVE_SESSION_EXISTS"
        assert submit(browser, headers, submitted=now, name="Independent").status_code == 201


def test_identical_pending_attempts_join_and_no_op_preserves_revision(tmp_path: Path) -> None:
    entered, proceed = Event(), Event()

    def gate(boundary: str) -> None:
        if boundary == "retention_before_commit":
            entered.set()
            assert proceed.wait(6)

    storage = RecordsStorage(tmp_path, checkpoint=gate)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser, ThreadPoolExecutor() as workers:
        wait_for_health(browser, headers := credentials(browser))
        original = browser.get(SETTINGS, headers=headers).json()
        action = confirmation(proposal(browser, headers, 7))
        first = workers.submit(browser.put, COMMIT, headers=headers, json=action)
        try:
            assert entered.wait(4)
            response = browser.put(COMMIT, headers=headers, json=action)
            assert response.status_code == 202
            assert response.json()["persistence"] == "Pending"
            assert browser.get(SETTINGS, headers=headers).json() == original
            assert error_code(browser.put(COMMIT, headers=headers, json={**action, "retention_days": 8})) == "ACTION_ID_CONFLICT"
            assert error_code(browser.put(COMMIT, headers=credentials(browser), json=action)) == "PREVIEW_STALE"
            for _ in range(32):
                proposal(browser, headers, 7)
        finally:
            proceed.set()
        assert first.result().status_code in (200, 202)
        snapshot = wait_for_cleanup(browser, headers, "Complete")
        assert snapshot["retention"]["settings"] == original
        receipt = browser.put(COMMIT, headers=headers, json=action)
        if receipt.status_code == 202:
            receipt = browser.put(COMMIT, headers=headers, json=action)
        assert receipt.status_code == 200
        assert receipt.json()["result"]["settings"] == original
        with closing(sqlite3.connect(storage.path)) as db:
            assert db.execute("SELECT COUNT(*) FROM action_receipts WHERE scope='Settings'").fetchone() == (1,)


@pytest.mark.parametrize("deadline_days", [1, 7])
def test_new_expiry_while_saving_rolls_back_settings_receipt_and_purge_intent(
    tmp_path: Path, deadline_days: int,
) -> None:
    now = 1_800_000_000_000

    def cross_deadline(boundary: str) -> None:
        nonlocal now
        if boundary == "retention_before_commit":
            now += 1

    storage = RecordsStorage(tmp_path, clock=lambda: now, monotonic=lambda: 0, checkpoint=cross_deadline)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        seed_objects(tmp_path, [
            ("due", "Initially affected", "Lost", now - 2 * DAY_MS),
            ("boundary", "Cutoff crossing during save", "Lost", now - deadline_days * DAY_MS + 1),
        ], {"due": PNG, "boundary": PNG})
        preview = proposal(browser, headers, 1)
        assert preview["impact"]["objects"] == (1 if deadline_days == 1 else 2)
        response = browser.put(COMMIT, headers=headers, json=confirmation(preview))
        assert response.status_code == 409 and error_code(response) == "PREVIEW_STALE"
        wait_for_cleanup(browser, headers, "Complete")
        assert browser.get(SETTINGS, headers=headers).json()["retention_days"] == 7
        survivors = 2 if deadline_days == 1 else 1
        assert proposal(browser, headers, 1)["impact"]["objects"] == survivors
        with closing(sqlite3.connect(storage.path)) as db:
            assert db.execute("SELECT COUNT(*) FROM action_receipts").fetchone() == (0,)
            assert db.execute("SELECT COUNT(*) FROM storage_operations").fetchone() == (0,)
            assert db.execute("SELECT SUM(deletion_pending) FROM objects").fetchone() == (0,)
        assert len(list((tmp_path / "media").iterdir())) == survivors


def test_protection_and_strict_json_cover_both_retention_routes(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        wait_for_health(browser, headers := credentials(browser))
        action = confirmation(proposal(browser, headers, 30))
        for method, path, payload in (("POST", PREVIEW, {"expected_revision": 1, "retention_days": 30}),
                                      ("PUT", COMMIT, action)):
            for extra, expected in (({"Host": "foreign.test"}, "HOST_REJECTED"),
                ({"Origin": "null"}, "ORIGIN_REJECTED"), ({"X-App-Capability": "invalid"}, "CAPABILITY_INVALID"),
                ({"X-App-Client-Id": "invalid"}, "CLIENT_INVALID")):
                denied = browser.request(method, path, headers={**headers, **extra}, json=payload)
                assert denied.status_code == 403 and error_code(denied) == expected
                assert denied.headers["cache-control"] == "no-store"
            allowed = browser.options(path, headers={
                "Origin": "http://127.0.0.1:3000", "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": "content-type,x-app-capability,x-app-client-id",
            })
            assert allowed.status_code == 204
            for raw, status in ((b"\xff", 400), (b'{"retention_days":NaN}', 400),
                (b'{"retention_days":1,"retention_days":2}', 422), (b" " * 65537, 413)):
                assert browser.request(method, path, headers={
                    **headers, "Content-Type": "application/json",
                }, content=raw).status_code == status
            for invalid in (True, 0, 31, 1.0, "7"):
                assert browser.request(method, path, headers=headers, json={**payload, "retention_days": invalid}).status_code == 422
            assert browser.request(method, path, headers=headers, json={**payload, "extra": "field"}).status_code == 422
            assert browser.request(method, path, headers=headers, data={"retention_days": "7"}).status_code == 415
        assert browser.put(COMMIT, headers=headers, json={**action, "confirmed": False}).status_code == 422
        assert browser.get(SETTINGS, headers=headers).json()["revision"] == 1


def test_restart_recovers_a_committed_change_after_purge_process_death(tmp_path: Path) -> None:
    storage = RecordsStorage(tmp_path)
    storage.initialize()
    storage.close()
    now = utc_ms()
    seed_objects(tmp_path, [("old", "Due record", "Lost", now - 2 * DAY_MS),
                            ("young", "Keep record", "Lost", now - DAY_MS // 2)], {"old": PNG, "young": PNG})
    port = free_port()
    crashed = launch(tmp_path, port, ("backend.tests.crash_registration", "purge_file_removed"))
    try:
        headers = context_headers(connect(crashed, port))
        previous_client = headers["X-App-Client-Id"]
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            action = confirmation(proposal(http, headers, 1))
            try:
                http.put(COMMIT, headers=headers, json=action)
            except httpx.TransportError:
                pass
        crashed.communicate(timeout=15)
        assert crashed.returncode == 84
        with closing(sqlite3.connect(storage.path)) as db:
            body, = db.execute("SELECT response_body FROM action_receipts WHERE scope='Settings'").fetchone()
            assert db.execute("SELECT deletion_pending FROM objects WHERE id='old'").fetchone() == (1,)
            assert db.execute("SELECT COUNT(*) FROM storage_operations").fetchone() == (1,)
    finally:
        if crashed.poll() is None:
            crashed.kill()
            crashed.communicate(timeout=10)

    port = free_port()
    restarted = launch(tmp_path, port)
    try:
        headers = context_headers(connect(restarted, port))
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            replaced = {**headers, "X-App-Client-Id": previous_client}
            recovered = http.put(COMMIT, headers=replaced, json=action)
            assert (recovered.status_code, recovered.content) == (200, body.encode())
            assert error_code(http.put(COMMIT, headers=replaced, json={**action, "retention_days": 2})) == "CLIENT_INVALID"
            new_action = {**action, "action_id": str(uuid4())}
            assert error_code(http.put(COMMIT, headers=replaced, json=new_action)) == "CLIENT_INVALID"
            assert http.get("/api/v1/objects/old", headers=headers).status_code == 404
            lengthen = confirmation(proposal(http, headers, 30, 2))
            assert http.put(COMMIT, headers=headers, json=lengthen).status_code == 200
            assert http.get("/api/v1/objects/old", headers=headers).status_code == 404
            kept = http.get("/api/v1/objects/young", headers=headers).json()
            assert kept["expires_at_ms"] == kept["registered_at_ms"] + 30 * DAY_MS
        assert [path.name for path in (tmp_path / "media").iterdir()] == ["young-reference.png"]
    finally:
        restarted.kill()
        restarted.communicate(timeout=10)
