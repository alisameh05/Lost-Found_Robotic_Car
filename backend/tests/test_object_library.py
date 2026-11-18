import hashlib
import json
import re
import sqlite3
import unicodedata
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Config
from backend.app.main import create_app
from backend.app.storage import DAY_MS, RecordsStorage
from backend.app.unicode_search import UCD_VERSION, casefold
from backend.tests.test_records import BASE, credentials, wait_for_health

NOW = 1_800_000_000_000


def seed_objects(root: Path, records: list[tuple[str, str, str, int]], references: dict[str, bytes] | None = None) -> None:
    """Storage-only setup for historical records, including unavailable references."""
    with closing(sqlite3.connect(root / "records.sqlite3")) as db, db:
        db.execute("PRAGMA foreign_keys = ON")
        for object_id, name, status, registered in records:
            media = f"{object_id}-reference"
            path = f"media/{media}.png"
            data = (references or {}).get(object_id)
            if data is not None:
                (root / path).write_bytes(data)
            db.execute(
                """INSERT INTO objects
                   (id,name,status,registered_at_ms,found_at_ms,roi_x,roi_y,roi_width,roi_height,revision,
                    reference_media_id,reference_width,reference_height)
                   VALUES (?,?,?,?,?,0,0,1,1,1,?,1,1)""",
                (object_id, name, status, registered, registered if status == "Found" else None, media),
            )
            db.execute(
                "INSERT INTO media VALUES (?, ?, NULL, 'Reference', ?, 'image/png', 1, 1, ?, ?, ?, 'Ready')",
                (media, object_id, path, len(data) if data else 1,
                 hashlib.sha256(data).hexdigest() if data else "a" * 64, registered),
            )


def test_continuation_rechecks_eligibility_and_excludes_the_binary_boundary(tmp_path: Path) -> None:
    now = NOW
    storage = RecordsStorage(tmp_path, clock=lambda: now)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        seed_objects(tmp_path, [
            ("a", "Recent", "Lost", NOW - 1), ("Z", "Recent", "Found", NOW - 1),
            ("earlier", "Earlier", "Lost", NOW - 50),
            ("due", "Old reference", "Lost", NOW - 7 * DAY_MS + 10),
        ])
        first = browser.get("/api/v1/objects", headers=headers, params={"limit": 2}).json()
        assert [item["id"] for item in first["items"]] == ["a", "Z"]
        now += 10
        page = browser.get("/api/v1/objects", headers=headers, params={"limit": 2, "cursor": first["next_cursor"]})
        assert page.status_code == 200
        assert [item["id"] for item in page.json()["items"]] == ["earlier"]
        assert page.json()["next_cursor"] is None
        assert browser.get("/api/v1/objects/due", headers=headers).status_code == 410
        assert browser.get("/api/v1/media/due-reference", headers=headers).status_code == 410
        assert browser.get("/api/v1/objects/earlier", headers=headers).json() == page.json()["items"][0]

    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: now)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers, status=503)
        page = browser.get("/api/v1/objects", headers=headers)
        assert page.status_code == 503 and page.json()["code"] == "STORAGE_UNAVAILABLE"
        assert browser.get("/api/v1/objects/earlier", headers=headers).status_code == 503
        assert browser.get("/api/v1/objects/due", headers=headers).status_code == 410
        assert browser.get("/api/v1/snapshot", headers=headers).json()["snapshot"]["retention"]["deletion"] == {
            "status": "Failed", "remaining_objects": 1, "remaining_files": 1, "error_code": "STORAGE_UNAVAILABLE",
        }


def test_search_uses_pinned_unicode_fold_and_literal_wildcards(tmp_path: Path) -> None:
    storage = RecordsStorage(tmp_path, clock=lambda: NOW)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        seed_objects(tmp_path, [
            ("a", "Straße%_  Café \u1c89", "Lost", NOW - 1),
            ("Z", "Straße%_  Café \u1c89", "Found", NOW - 1),
            ("single", "Straße%_ Café \u1c89", "Lost", NOW - 1),
            ("similar", "StrasseXY  Café \u1c89", "Lost", NOW - 1),
            ("long", "🧭" * 120, "Lost", NOW - 1),
        ])
        search = "/api/v1/objects"
        query = {"name": "\u0085STRASSE%_  CAFE\u0301 \u1c8a\u2003", "limit": 1}
        first = browser.get(search, headers=headers, params=query).json()
        assert [item["id"] for item in first["items"]] == ["a"]
        second = browser.get(search, headers=headers, params={
            "name": "straße%_  Café \u1c89", "limit": "01", "cursor": first["next_cursor"],
        }).json()
        assert [item["id"] for item in second["items"]] == ["Z"]
        assert second["next_cursor"] is None
        found = browser.get(search, headers=headers, params={**query, "status": "Found"}).json()
        assert [item["id"] for item in found["items"]] == ["Z"]
        maximum = browser.get(search, headers=headers, params={"name": "\u2003" + "🧭" * 120 + "\u0085"})
        assert [item["id"] for item in maximum.json()["items"]] == ["long"]
        invalid = browser.get(search, headers=headers, params={"name": "🧭" * 121})
        assert invalid.status_code == 422 and invalid.json()["field_errors"][0]["path"] == "/query/name"


def test_unicode_tables_match_the_frontend_across_all_code_points() -> None:
    library = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib"
    frontend_fold = json.loads((library / "fixtures" / "casefold-data.json").read_text(encoding="utf-8"))
    frontend_ranges = (library / "unicode-14-unassigned.ts").read_text(encoding="utf-8")
    ranges = re.findall(r"\\u\{([0-9a-f]+)\}(?:-\\u\{([0-9a-f]+)\})?", frontend_ranges)
    unassigned = {point for first, last in ranges for point in range(int(first, 16), int(last or first, 16) + 1)}
    assert unicodedata.unidata_version == UCD_VERSION
    for point in range(0x110000):
        character = chr(point)
        assert casefold(character) == frontend_fold.get(character, character)
        assert (point in unassigned) == (unicodedata.category(character) == "Cn")


def test_page_defaults_refresh_and_cursor_binding(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ticks = 0
    monkeypatch.setattr("backend.app.runtime.monotonic", lambda: ticks)
    search = "/api/v1/objects"
    config = Config(tmp_path)
    with TestClient(create_app(config, storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        headers = credentials(browser)
        other = credentials(browser)
        wait_for_health(browser, headers)
        seed_objects(tmp_path, [(f"item-{i:02}", "Spare", "Lost", NOW - 1) for i in range(26)])
        page = browser.get(search, headers=headers).json()
        token = page["next_cursor"]
        assert [item["id"] for item in page["items"]] == [f"item-{i:02}" for i in range(25, 0, -1)]
        assert browser.get(search, headers=headers, params={"limit": 100}).json()["next_cursor"] is None
        assert browser.get(search, headers=headers, params={"cursor": token, "limit": 1}).json()["code"] == "CURSOR_INVALID"
        assert browser.get(search, headers=headers, params={"cursor": token, "name": "Spare"}).json()["code"] == "CURSOR_INVALID"
        assert browser.get(search, headers=headers, params={"cursor": token, "status": "Lost"}).json()["code"] == "CURSOR_INVALID"
        assert browser.get(search, headers=other, params={"cursor": token}).json()["code"] == "CURSOR_INVALID"
        assert browser.get(search, headers=headers, params=[("cursor", token), ("cursor", token)]).status_code == 422
        seed_objects(tmp_path, [("new", "Newest", "Found", NOW)])
        ticks = 1799
        next_page = browser.get(search, headers=headers, params={"cursor": token, "limit": "025"}).json()
        assert [item["id"] for item in next_page["items"]] == ["item-00"]
        refreshed = browser.get(search, headers=headers).json()
        assert refreshed["items"][0]["id"] == "new"
        ticks = 1800
        assert browser.get(search, headers=headers, params={"cursor": token}).json()["code"] == "CURSOR_EXPIRED"

    with TestClient(create_app(config, storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, current := credentials(browser))
        assert browser.get(search, headers=headers, params={"cursor": refreshed["next_cursor"]}).json()["code"] == "CAPABILITY_INVALID"
        assert browser.get(search, headers=current, params={"cursor": refreshed["next_cursor"]}).json()["code"] == "CURSOR_EXPIRED"


def test_cursors_reclaim_oldest_inactive_entries_at_both_caps(tmp_path: Path) -> None:
    common = "abcdefghijklmnopqrstuvwxyz1234567890"
    search = "/api/v1/objects"
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, clock=lambda: NOW)), base_url=BASE) as browser:
        wait_for_health(browser, first := credentials(browser))
        seed_objects(tmp_path, [("a", common, "Found", NOW - 1), ("b", common, "Lost", NOW - 1)])

        def page(client: dict[str, str], index: int, cursor: str | None = None) -> dict:
            params = {"name": common[index:index + 4], "limit": "1"}
            if cursor is not None:
                params["cursor"] = cursor
            return browser.get(search, headers=client, params=params).json()

        tokens = [page(first, i)["next_cursor"] for i in range(32)]
        assert len(set(tokens)) == 32
        assert page(first, 0, tokens[0])["items"][0]["id"] == "a"  # The used cursor moves past the oldest idle one.
        page(first, 32)
        assert page(first, 1, tokens[1])["code"] == "CURSOR_EXPIRED"
        assert page(first, 0, tokens[0])["items"][0]["id"] == "a"
        for _ in range(31):
            client = credentials(browser)
            for i in range(32):
                assert page(client, i)["next_cursor"]
        extra = credentials(browser)
        assert page(extra, 0)["next_cursor"]
        assert page(first, 2, tokens[2])["code"] == "CURSOR_EXPIRED"
        assert page(first, 0, tokens[0])["items"][0]["id"] == "a"
