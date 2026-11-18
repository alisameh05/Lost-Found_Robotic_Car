import sqlite3
from contextlib import closing
from pathlib import Path
from threading import Event
from time import monotonic, sleep, time

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Config
from backend.app.main import create_app
from backend.app.storage import RecordsStorage

ORIGIN = {"Origin": "http://127.0.0.1:3000"}
BASE = "http://127.0.0.1:8000"


def wait_for_health(browser: TestClient, headers: dict[str, str], status: int = 200) -> None:
    deadline = monotonic() + 5
    while monotonic() < deadline:
        response = browser.get("/api/v1/health", headers=headers)
        if response.json().get("initialization") != "Starting":
            assert response.status_code == status, response.json()
            return
        sleep(0.01)
    raise AssertionError("Records backend did not initialize")


def credentials(browser: TestClient) -> dict[str, str]:
    response = browser.get("/api/v1/bootstrap", headers=ORIGIN)
    assert response.status_code == 200
    context = response.json()
    return {"X-App-Capability": context["capability"], "X-App-Client-Id": context["client_id"]}


def test_empty_records_remain_disarmed_and_settings_survive_restart(tmp_path: Path) -> None:
    config = Config(tmp_path)
    with TestClient(create_app(config), base_url=BASE) as browser:
        bootstrap = browser.get("/api/v1/bootstrap", headers=ORIGIN)
        assert bootstrap.status_code == 200
        first = bootstrap.json()
        headers = {
            "X-App-Capability": first["capability"],
            "X-App-Client-Id": first["client_id"],
        }
        wait_for_health(browser, headers)
        health = browser.get("/api/v1/health", headers=headers)
        assert health.status_code == 200
        assert health.json()["storage_integrity"] == "Healthy"
        snapshot = browser.get("/api/v1/snapshot", headers=headers).json()
        assert snapshot["runtime"]["motion_permission"] == "Disarmed"
        assert not snapshot["lease"]["can_acquire"]
        assert snapshot["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
        assert not snapshot["readiness"]["can_resume"]
        assert snapshot["qualification_profile"] is None
        assert len(snapshot["readiness"]["components"]) == 10
        records = browser.get("/api/v1/objects", headers=headers)
        assert records.json() == {"items": [], "next_cursor": None}
        assert records.headers["cache-control"] == "no-store"
        settings = browser.get("/api/v1/settings", headers=headers).json()
        assert settings["retention_days"] == 7
        assert settings["revision"] == 1

    with TestClient(create_app(config), base_url=BASE) as browser:
        assert browser.get("/api/v1/health", headers=headers).json()["code"] == "CAPABILITY_INVALID"
        second = browser.get("/api/v1/bootstrap", headers=ORIGIN).json()
        assert all(second[key] != first[key] for key in ("backend_boot_id", "capability", "client_id"))
        new_headers = {"X-App-Capability": second["capability"]}
        wait_for_health(browser, new_headers)
        result = browser.get("/api/v1/settings", headers=new_headers)
        assert result.json() == settings


def test_address_capability_client_and_preflight(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        assert browser.get("/api/v1/bootstrap").json()["code"] == "ORIGIN_REJECTED"
        headers = credentials(browser)
        wait_for_health(browser, headers)
        for rejected in ({"Origin": "null"}, {"Origin": "http://localhost:3000"}):
            response = browser.get("/api/v1/health", headers={**headers, **rejected})
            assert response.status_code == 403 and response.json()["code"] == "ORIGIN_REJECTED"
            assert "access-control-allow-origin" not in response.headers
        for rejected in ({"Host": "localhost:8000"}, {"X-Forwarded-Host": "127.0.0.1:8000"},
                         {"Forwarded": "host=127.0.0.1:8000"}):
            response = browser.get("/api/v1/health", headers={**headers, **rejected})
            assert response.status_code == 403 and response.json()["code"] == "HOST_REJECTED"
            assert response.headers["cache-control"] == "no-store"
        assert browser.get("/api/v1/health", headers=ORIGIN).json()["code"] == "CAPABILITY_INVALID"
        capability = {"X-App-Capability": headers["X-App-Capability"]}
        assert browser.get("/api/v1/health", headers=capability).status_code == 200
        assert browser.get("/api/v1/snapshot", headers=capability).json()["code"] == "CLIENT_INVALID"
        assert browser.get("/api/v1/objects", headers={**capability, "X-App-Client-Id": "made-up"}).json()[
            "code"] == "CLIENT_INVALID"
        preflight = {**ORIGIN, "Access-Control-Request-Method": "GET",
                     "Access-Control-Request-Headers": "X-App-Capability, X-App-Client-Id"}
        result = browser.options("/api/v1/snapshot", headers=preflight)
        assert result.status_code == 204
        assert result.headers["access-control-allow-origin"] == ORIGIN["Origin"]
        assert result.headers["vary"] == "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
        assert result.headers["cache-control"] == "no-store"
        assert "access-control-allow-credentials" not in result.headers
        assert browser.options("/api/v1/control-lease", headers=preflight).status_code == 404
        register = browser.options("/api/v1/objects", headers={**preflight, "Access-Control-Request-Method": "POST"})
        assert register.status_code == 204 and register.headers["access-control-allow-methods"] == "POST"
        assert browser.options("/api/v1/snapshot", headers={
            **preflight, "Access-Control-Request-Headers": "X-Unknown",
        }).status_code == 422
        assert browser.post("/api/v1/objects", headers=ORIGIN, data={"name": "test"}).status_code == 403
        assert browser.post("/api/v1/control-lease", headers=headers).json()["code"] == "NOT_FOUND"


@pytest.mark.parametrize(("query", "expected"), [
    ("?limit=4&limit=5", "DUPLICATE_FIELD"), ("?unknown=private", "UNKNOWN_FIELD"),
    ("?name=%ff", "INVALID_VALUE"), ("?name=%f", "INVALID_VALUE"), ("?limit=1.0", "INVALID_TYPE"),
    ("?limit=0", "OUT_OF_RANGE"), ("?limit=101", "OUT_OF_RANGE"), ("?status=lost", "INVALID_VALUE"),
])
def test_empty_feed_still_validates_queries(tmp_path: Path, query: str, expected: str) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        response = browser.get(f"/api/v1/objects{query}", headers=headers)
        assert response.status_code == 422
        assert response.json()["field_errors"][0]["code"] == expected
        assert "private" not in response.text


def test_read_body_is_rejected_with_safe_error(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        for body, expected in ((b'{"private":true}', 422), (b"x" * 65_537, 413)):
            response = browser.request("GET", "/api/v1/health", headers=headers, content=body)
            assert response.status_code == expected and "private" not in response.text
        assert browser.get("/api/v1/health", headers={**headers, "Content-Encoding": "gzip"}).status_code == 415


def test_empty_feed_distinguishes_malformed_and_inactive_cursors(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        for cursor, code in (("malformed", "CURSOR_INVALID"), ("A" * 43, "CURSOR_EXPIRED")):
            result = browser.get("/api/v1/objects", headers=headers, params={"cursor": cursor})
            assert result.status_code == 400 and result.json()["code"] == code


def test_inactive_clients_expire_without_evicting_healthy_clients(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    now = 0
    monkeypatch.setattr("backend.app.runtime.monotonic", lambda: now)
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        clients = [credentials(browser) for _ in range(64)]
        assert len({item["X-App-Client-Id"] for item in clients}) == 64
        assert browser.get("/api/v1/bootstrap", headers=ORIGIN).json()["code"] == "CAPACITY_REACHED"
        wait_for_health(browser, clients[0])
        now = 1799
        assert browser.get("/api/v1/snapshot", headers=clients[0]).status_code == 200
        now = 1800
        assert browser.get("/api/v1/snapshot", headers=clients[1]).json()["code"] == "CLIENT_INVALID"
        assert browser.get("/api/v1/snapshot", headers=clients[0]).status_code == 200
        credentials(browser)


def test_health_preserves_initialization_without_exposing_records(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    can_initialize = Event()
    initialize = RecordsStorage.initialize

    def delayed(storage: RecordsStorage) -> None:
        assert can_initialize.wait(timeout=5)
        initialize(storage)

    monkeypatch.setattr(RecordsStorage, "initialize", delayed)
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        try:
            health = browser.get("/api/v1/health", headers=headers)
            assert health.status_code == 503
            assert health.json()["storage_integrity"] == "Reconciling"
            assert health.json()["initialization"] == "Starting"
            assert browser.get("/api/v1/objects", headers=headers).json()["code"] == "INITIALIZING"
        finally:
            can_initialize.set()
        wait_for_health(browser, headers)


@pytest.mark.parametrize("fault", ["version", "checksum", "schema", "extra table", "journal", "due expiry"])
def test_storage_fault_keeps_history_and_fails_closed(tmp_path: Path, fault: str) -> None:
    config = Config(tmp_path)
    with TestClient(create_app(config), base_url=BASE) as browser:
        wait_for_health(browser, credentials(browser))
    database = tmp_path / "records.sqlite3"
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("PRAGMA journal_mode").fetchone() == ("wal",)
        assert db.execute("SELECT COUNT(*) FROM objects").fetchone() == (0,)
        assert db.execute("SELECT COUNT(*) FROM sessions").fetchone() == (0,)
        assert db.execute("SELECT COUNT(*) FROM media").fetchone() == (0,)
        db.execute("PRAGMA foreign_keys = ON")
        if fault == "version":
            db.execute("PRAGMA user_version = 99")
        elif fault == "checksum":
            db.execute("UPDATE schema_migrations SET checksum = ?", ("0" * 64,))
        elif fault == "schema":
            db.execute("DROP INDEX one_active_session")
        elif fault == "extra table":
            db.execute("CREATE TABLE sqliteExtra (value TEXT)")
        elif fault == "journal":
            db.execute("INSERT INTO storage_operations VALUES ('recovery', 'Purge', 'saved', '[\"media/saved.jpg\"]', "
                       "'Pending', 1, NULL)")
        else:
            db.execute(
                """INSERT INTO objects
                   (id,name,status,registered_at_ms,roi_x,roi_y,roi_width,roi_height,revision,
                    reference_media_id,reference_width,reference_height)
                   VALUES ('saved','Existing belongings','Lost',?,0,0,1,1,1,'reference',20,30)""",
                (int((time() - 8 * 86400) * 1000),),
            )
            with pytest.raises(sqlite3.IntegrityError):
                db.commit()  # A committed object requires its own Ready reference, with exact dimensions.
            db.execute(
                """INSERT INTO media
                   VALUES ('reference','saved',NULL,'Reference','media/reference.png','image/png',20,30,1,?,1,'Ready')""",
                ("1" * 64,),
            )
        db.commit()

    with TestClient(create_app(config), base_url=BASE) as browser:
        headers = credentials(browser)
        deadline = monotonic() + 5
        while monotonic() < deadline:
            health = browser.get("/api/v1/health", headers=headers)
            if health.json()["initialization"] != "Starting":
                break
            sleep(0.01)
        assert health.status_code == 503 and health.json()["storage_integrity"] == "Unavailable"
        for path in ("settings", "snapshot"):
            denied = browser.get(f"/api/v1/{path}", headers=headers)
            assert denied.status_code == 503
            assert denied.headers["cache-control"] == "no-store"
            assert denied.json()["code"] == "STORAGE_UNAVAILABLE"
            assert str(tmp_path) not in denied.text and "Existing belongings" not in denied.text
            if fault in ("journal", "due expiry"):
                deletion = denied.json()["snapshot"]["retention"]["deletion"]
                assert deletion == {"status": "Failed", "remaining_objects": 1, "remaining_files": 1,
                                    "error_code": "STORAGE_UNAVAILABLE"}
        objects = browser.get("/api/v1/objects", headers=headers)
        assert objects.headers["cache-control"] == "no-store"
        assert objects.status_code == 503 and objects.json()["code"] == "STORAGE_UNAVAILABLE"
        assert "Existing belongings" not in objects.text
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("SELECT retention_days FROM app_settings").fetchone() == (7,)
        if fault == "due expiry":
            assert db.execute("SELECT COUNT(*) FROM objects").fetchone() == (1,)
        if fault == "journal":
            assert db.execute("SELECT COUNT(*) FROM storage_operations").fetchone() == (1,)


def test_durable_baseline_enforces_pause_and_capture_constraints(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        wait_for_health(browser, credentials(browser))
    with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db:
        db.execute("PRAGMA foreign_keys = ON")
        insert_owner = """INSERT INTO objects
            (id,name,status,registered_at_ms,roi_x,roi_y,roi_width,roi_height,revision,
             reference_media_id,reference_width,reference_height)
            VALUES ('saved',?,'Lost',1,0,0,1,1,1,'reference',20,30)"""
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(insert_owner, ("\t\u00a0\n",))
        db.execute(insert_owner, ("Saved",))
        db.execute(
            "INSERT INTO media VALUES ('reference','saved',NULL,'Reference','media/reference.png','image/png',20,30,1,?,1,'Ready')",
            ("1" * 64,),
        )
        insert_session = "INSERT INTO sessions VALUES (?, 'saved', 'Gestures', 'Paused', 2, NULL, NULL, ?, 1)"
        pause_causes = '[{"cause":"CandidateReview","failure_id":null}]'
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(insert_session, ("invalid", "[null]"))
        db.execute(insert_session, ("session", pause_causes))
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(insert_session, ("second", pause_causes))
        db.execute(
            """INSERT INTO match_events
               (id,session_id,object_id,captured_at_ms,frame_id,stream_epoch,box_x,box_y,box_width,box_height,
                disposition,evidence_media_id,evidence_width,evidence_height)
               VALUES ('match','session','saved',3,'frame','stream',0,0,1,1,'Pending','capture',20,30)"""
        )
        insert_evidence = "INSERT INTO media VALUES ('capture','saved','match','Evidence',?,?,20,30,1,?,3,'Ready')"
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(insert_evidence, ("media/capture.jpg", "image/jpeg", "1" * 64))
        db.execute(insert_evidence, ("media/capture.png", "image/png", "1" * 64))
        db.commit()
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE match_events SET frame_id = 'changed'")
        with pytest.raises(sqlite3.IntegrityError):
            db.execute("UPDATE sessions SET pause_causes = '[{\"cause\":\"RecoveryRequired\",\"failure_id\":null}]'")
