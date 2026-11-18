import errno
import hashlib
import os
import sqlite3
import struct
import subprocess
import zlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from io import BytesIO
from pathlib import Path
from threading import Event
from time import monotonic, sleep, time_ns
from uuid import uuid4

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.app.config import Config
from backend.app.main import create_app
from backend.app.managed_media import ManagedEntry
from backend.app.storage import DAY_MS, SUBMISSION_WINDOW, RecordsStorage
from backend.tests.test_process import connect, free_port, launch, raw_http
from backend.tests.test_records import BASE, credentials, wait_for_health

# A non-catalogue one-pixel RGBA PNG.
PNG = bytes.fromhex(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
    '0000000d49444154789c6360606060000000050001a5f645400000000049454e44ae426082'
)
ROI = '{"x":0,"y":0,"width":1,"height":1}'
OBJECTS = "/api/v1/objects"


def now_ms() -> int:
    return time_ns() // 1_000_000


def context_headers(context: dict) -> dict[str, str]:
    return {"X-App-Capability": context["capability"], "X-App-Client-Id": context["client_id"]}


def submit(
    client: httpx.Client, headers: dict[str, str], *, action: str | None = None, submitted: int | None = None,
    name: str = "Desk plant", roi: str = ROI, image: bytes = PNG, filename: str = "reference.png", wait: bool = True,
) -> httpx.Response:
    protected = {
        **headers, "X-Action-Created-At-Ms": str(now_ms() if submitted is None else submitted),
    }
    fields = {"name": name, "action_id": action or str(uuid4()), "roi": roi}
    files = {"reference_image": (filename, image, "application/octet-stream")}
    deadline = monotonic() + 8
    while True:
        response = client.post(OBJECTS, headers=protected, data=fields, files=files)
        if not wait or response.status_code != 202 or monotonic() >= deadline:
            return response
        sleep(0.02)


def image_bytes(
    mode: str, kind: str, size: tuple[int, int] = (5, 3), *, orientation: int = 1, **options: object,
) -> bytes:
    output = BytesIO()
    with Image.new(mode, size) as image:
        exif = image.getexif()
        exif[274] = orientation
        if mode == "RGBA":
            image.putpixel((0, 0), (80, 140, 220, 128))
        if mode == "P":
            image.putpalette([17, 18, 19, 20, 21, 22])
        image.save(output, format=kind, exif=exif, **options)
    return output.getvalue()


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))


def incomplete_jpeg_scan() -> bytes:
    source = image_bytes("RGB", "JPEG", (64, 64))
    scan = source.index(b"\xff\xda")
    start = scan + 2 + int.from_bytes(source[scan + 2:scan + 4], "big")
    return source[:start + 2] + b"\xff\xd9"


def test_registration_reopens_managed_reference(tmp_path: Path) -> None:
    config = Config(tmp_path / 'records')
    source = tmp_path / 'source.png'
    source.write_bytes(PNG)
    with TestClient(create_app(config), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        saved = submit(browser, headers, name="\u2003Cafe\u0301\u00a0", image=source.read_bytes(), filename=source.name)
        assert saved.status_code == 201, saved.json()
        record = saved.json()['result']['object']
        assert record['name'] == 'Café' and record['status'] == 'Lost'
        location = saved.headers['location']
        assert location == f"/api/v1/objects/{record['id']}"
    assert source.read_bytes() == PNG
    source.unlink()
    with TestClient(create_app(config), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        assert browser.get(location, headers=headers).json() == record
        response = browser.get(f"/api/v1/media/{record['reference_media']['id']}", headers={
            **headers, 'Range': 'bytes=0-0',
        })
        assert response.status_code == 200 and response.content.startswith(PNG[:8])
        assert response.headers['accept-ranges'] == 'none'
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize("boundary", ["staged", "journaled", "promoted", "before_commit", "committed"])
def test_real_process_crash_reconciles_reference_and_receipt(tmp_path: Path, boundary: str) -> None:
    root = tmp_path / "records"
    port = free_port()
    process = launch(root, port, ("backend.tests.crash_registration", boundary))
    action, anchor = str(uuid4()), now_ms()
    image = image_bytes("RGBA", "PNG", orientation=6)
    roi = '{"x":2,"y":4,"width":1,"height":1}'
    try:
        headers = context_headers(connect(process, port))
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            try:
                admitted = submit(http, headers, action=action, submitted=anchor, image=image, roi=roi, wait=False)
            except httpx.TransportError:
                pass
            else:
                assert admitted.status_code == 202
        assert process.wait(timeout=10) == 84
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)

    port = free_port()
    replacement = launch(root, port)
    try:
        headers = context_headers(connect(replacement, port))
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=5) as http:
            before = http.get(OBJECTS, headers=headers).json()["items"]
            assert len(before) == (1 if boundary == "committed" else 0)
            assert not list((root / "staging").iterdir())
            assert len(list((root / "media").iterdir())) == len(before)
            saved = submit(http, headers, action=action, submitted=anchor, image=image, roi=roi)
            assert saved.status_code == 201, saved.json()
            record = saved.json()["result"]["object"]
            if before:
                assert record == before[0]
            assert record["roi"] == {"x": 2, "y": 4, "width": 1, "height": 1}
            assert (record["reference_media"]["width"], record["reference_media"]["height"]) == (3, 5)
            actual = http.get(f"/api/v1/media/{record['reference_media']['id']}", headers=headers)
            with Image.open(BytesIO(actual.content)) as result:
                assert result.getpixel((2, 0)) == (167, 197, 237)
                assert result.getpixel((0, 0)) == (255, 255, 255)
                assert 274 not in result.getexif()
            assert http.get(saved.headers["location"], headers=headers).json() == record
            assert http.get(OBJECTS, headers=headers).json()["items"] == [record]
    finally:
        replacement.kill()
        replacement.communicate(timeout=10)


def test_matching_concurrent_registration_tracks_one_write(tmp_path: Path) -> None:
    entered, release = Event(), Event()

    def checkpoint(name: str) -> None:
        if name == "journaled":
            entered.set()
            assert release.wait(5)

    storage = RecordsStorage(tmp_path, checkpoint=checkpoint)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        action, anchor = str(uuid4()), now_ms()
        with ThreadPoolExecutor(max_workers=1) as executor:
            first = executor.submit(submit, browser, headers, action=action, submitted=anchor, wait=False)
            try:
                assert entered.wait(3)
                duplicate = submit(browser, headers, action=action, submitted=anchor, filename="renamed.bin", wait=False)
                assert duplicate.status_code == 202
                assert first.result(timeout=3).json() == duplicate.json()
                assert browser.get(OBJECTS, headers=headers).json()["items"] == []
                snapshot = browser.get("/api/v1/snapshot", headers=headers).json()
                assert snapshot["operations"] == [{**duplicate.json(), "request_id": None}]
                assert snapshot["runtime"]["persistence_pending"]
                changed = submit(browser, headers, action=action, submitted=anchor, name="Changed")
                assert changed.status_code == 409 and changed.json()["code"] == "ACTION_ID_CONFLICT"
            finally:
                release.set()
        receipt = submit(browser, headers, action=action, submitted=anchor)
        assert receipt.status_code == 201, receipt.text
        assert len(browser.get(OBJECTS, headers=headers).json()["items"]) == 1
        assert browser.get("/api/v1/snapshot", headers=headers).json()["operations"] == [
            {**receipt.json(), "request_id": None},
        ]


@pytest.mark.parametrize("failure", [errno.EACCES, errno.ENOSPC])
def test_storage_failure_rolls_back_and_same_action_can_retry(tmp_path: Path, failure: int) -> None:
    repaired = False

    def checkpoint(name: str) -> None:
        if name == "before_commit" and not repaired:
            raise OSError(failure, "Injected storage failure")

    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(tmp_path, checkpoint=checkpoint)),
                    base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        action, anchor = str(uuid4()), now_ms()
        denied = submit(browser, headers, action=action, submitted=anchor)
        assert denied.status_code == 503
        assert denied.json()["persistence"] == "Failed" and denied.json()["error"]["code"] == "STORAGE_UNAVAILABLE"
        assert browser.get(OBJECTS, headers=headers).json()["items"] == []
        assert not list((tmp_path / "media").iterdir()) and not list((tmp_path / "staging").iterdir())
        repaired = True
        assert submit(browser, headers, action=action, submitted=anchor).status_code == 201


@pytest.mark.parametrize("failure", [errno.EACCES, errno.ENOSPC])
def test_staging_write_failure_keeps_records_empty(
    tmp_path: Path, failure: int, monkeypatch: pytest.MonkeyPatch,
) -> None:
    def deny_stage(_: ManagedEntry) -> None:
        raise OSError(failure, "Injected staging filesystem failure")

    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        action, anchor = str(uuid4()), now_ms()
        with monkeypatch.context() as faults:
            faults.setattr(ManagedEntry, "open_stage", deny_stage)
            denied = submit(browser, headers, action=action, submitted=anchor)
        assert denied.status_code == 503 and denied.json()["persistence"] == "Failed"
        assert browser.get(OBJECTS, headers=headers).json()["items"] == []
        assert not list((tmp_path / "media").iterdir())
        assert submit(browser, headers, action=action, submitted=anchor).status_code == 201


@pytest.mark.parametrize(("image", "status"), [
    (lambda: b"not a photograph", 422),
    (lambda: PNG[:-7], 422),
    (lambda: PNG.replace(b"\xa5\xf6", b"\x00\x01"), 422),
    (incomplete_jpeg_scan, 422),
    (lambda: image_bytes("CMYK", "JPEG"), 422),
    (lambda: image_bytes("I;16", "PNG"), 422),
    (lambda: PNG[:33] + png_chunk(b"acTL", struct.pack(">II", 2, 0)) + PNG[33:], 422),
    (lambda: image_bytes("L", "PNG", (5000, 4001)), 413),
    (lambda: b"x" * (10 * 1024**2 + 1), 413),
])
def test_bad_images_are_plain_admission_errors(tmp_path: Path, image, status: int) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        denied = submit(browser, headers, image=image())
        assert denied.status_code == status and "persistence" not in denied.json(), denied.text
        assert browser.get("/api/v1/snapshot", headers=headers).json()["operations"] == []


@pytest.mark.parametrize(("mode", "kind", "options"), [
    ("L", "JPEG", {}), ("RGB", "JPEG", {"progressive": True}),
    ("P", "PNG", {"bits": 1, "transparency": 0}), ("RGB", "PNG", {}),
])
def test_supported_variants_keep_format_and_normalized_edge_roi(
    tmp_path: Path, mode: str, kind: str, options: dict,
) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        saved = submit(browser, headers, image=image_bytes(mode, kind, orientation=6, **options),
                       roi='{"x":2,"y":4,"width":1,"height":1}')
        assert saved.status_code == 201, saved.json()
        record = saved.json()["result"]["object"]
        media = record["reference_media"]
        assert [media["width"], media["height"]] == [3, 5]
        actual = browser.get(f"/api/v1/media/{media['id']}", headers=headers)
        assert actual.headers["Content-Type"] == f"image/{kind.lower()}"
        with Image.open(BytesIO(actual.content)) as decoded:
            assert decoded.size == (3, 5) and not decoded.getexif()
            if mode == "P":
                assert decoded.getpixel((2, 0)) == (255, 255, 255)


def test_inclusive_image_and_text_size_bounds(tmp_path: Path) -> None:
    source = image_bytes("L", "PNG", (5000, 4000))
    pad = 10 * 1024**2 - len(source) - 12
    source = source[:-12] + png_chunk(b"tEXt", b"comment\0" + b"x" * (pad - 8)) + source[-12:]
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        action, anchor = str(uuid4()), now_ms()
        name = "Pixel boundary"
        roi = ROI + " " * (65_536 - len(action) - len(name) - len(ROI))
        saved = submit(browser, headers, action=action, submitted=anchor, image=source, name=name, roi=roi)
        assert saved.status_code == 201, saved.text
        assert submit(browser, headers, name=name, roi=roi + " " * 2).status_code == 413


@pytest.mark.parametrize(("roi", "status", "field_code"), [
    ('{"x":0', 400, None),
    ('{"x":0,"x":0,"y":0,"width":1,"height":1}', 422, "DUPLICATE_FIELD"),
    ('{"x":0,"y":false,"width":1,"height":1}', 422, "INVALID_TYPE"),
    ('{"x":0,"y":0,"width":1.0,"height":1}', 422, "INVALID_TYPE"),
    ('{"x":0,"y":0,"width":1,"height":NaN}', 422, "INVALID_TYPE"),
    ('{"x":0,"y":0,"width":0,"height":1}', 422, "OUT_OF_RANGE"),
    ('{"x":0,"y":0,"width":2,"height":1}', 422, "OUT_OF_RANGE"),
    ('{"x":0,"y":0,"width":1,"size":1}', 422, "UNKNOWN_FIELD"),
])
def test_roi_validation(tmp_path: Path, roi: str, status: int, field_code: str | None) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        response = submit(browser, headers, roi=roi)
        assert response.status_code == status
        if field_code:
            assert response.json()["field_errors"][0]["code"] == field_code
        else:
            assert response.json()["code"] == "INVALID_JSON"


def test_clock_and_receipt_replay_across_authority_and_age(tmp_path: Path) -> None:
    wall, mono = now_ms(), 0
    storage = RecordsStorage(tmp_path, clock=lambda: wall, monotonic=lambda: mono)
    original_time = wall
    action = str(uuid4())
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        response = submit(browser, headers, action=action, submitted=original_time, name="Cafe\u0301")
        assert response.status_code == 201
        # A large rollback must not allow a previously unseen request to become fresh.
        mono += 700
        wall += 50
        assert submit(browser, headers, submitted=original_time).json()["code"] == "NOT_READY"
        assert submit(browser, headers, action=action, submitted=original_time, name="Café").content == response.content
        wall = original_time + 700_000
        assert submit(browser, headers, submitted=original_time).json()["code"] == "ACTION_EXPIRED"
        assert submit(browser, headers, submitted=wall + 1).json()["code"] == "ACTION_EXPIRED"
        assert submit(browser, headers, submitted=wall - SUBMISSION_WINDOW).status_code == 201
    storage = RecordsStorage(tmp_path, clock=lambda: wall, monotonic=lambda: mono)
    with TestClient(create_app(Config(tmp_path), storage=storage), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        stale_client = {**headers, "X-App-Client-Id": "replaced-client"}
        replay = submit(browser, stale_client, action=action, submitted=original_time, name="\u2003Café")
        assert (replay.status_code, replay.content, replay.headers["location"]) == (
            response.status_code, response.content, response.headers["location"],
        )
        assert submit(browser, stale_client, submitted=wall).json()["code"] == "CLIENT_INVALID"
        assert submit(browser, headers, action=action, submitted=original_time + 1, name="Café").status_code == 409
        assert submit(browser, headers, action=action, submitted=original_time, name="Café",
                      image=image_bytes("RGB", "PNG", (1, 1))).status_code == 409
        # The receipt owner expires exactly at seven days, even before purge exists.
        wall = original_time + 7 * DAY_MS
        assert submit(browser, stale_client, action=action, submitted=original_time, name="Café").json()["code"] == "EXPIRED"
        assert browser.get(response.headers["location"], headers=headers).status_code == 410
        record = response.json()["result"]["object"]
        assert browser.get(f"/api/v1/media/{record['reference_media']['id']}", headers=headers).status_code == 410
        assert submit(browser, headers, submitted=wall).json()["code"] == "STORAGE_UNAVAILABLE"
        diagnostic = browser.get("/api/v1/snapshot", headers=headers).json()["snapshot"]
        assert diagnostic["retention"]["deletion"]["status"] == "Failed" and diagnostic["operations"] == []
    wall = original_time
    with TestClient(create_app(Config(tmp_path), storage=RecordsStorage(
        tmp_path, clock=lambda: wall, monotonic=lambda: mono,
    )), base_url=BASE) as browser:
        headers = credentials(browser)
        for _ in range(100):
            health = browser.get("/api/v1/health", headers=headers)
            if health.json()["initialization"] != "Starting":
                break
        assert browser.get(response.headers["location"], headers=headers).status_code == 410
        assert submit(browser, headers, submitted=wall).status_code == 503


def test_backward_clock_fault_survives_restart_before_clock_is_restored(tmp_path: Path) -> None:
    anchor = wall = now_ms()
    mono = 0.0
    config = Config(tmp_path)

    def application():
        return create_app(config, storage=RecordsStorage(tmp_path, clock=lambda: wall, monotonic=lambda: mono))

    with TestClient(application(), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        mono += 700
        wall += 50
        rejected = submit(browser, headers, submitted=anchor)
        assert rejected.status_code == 503 and rejected.json()["code"] == "NOT_READY"
    with TestClient(application(), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        assert submit(browser, headers, submitted=anchor).json()["code"] == "NOT_READY"
        wall = anchor + 700_000
        assert submit(browser, headers, submitted=anchor).json()["code"] == "ACTION_EXPIRED"
        assert submit(browser, headers, submitted=wall).status_code == 201


def test_backward_clock_during_commit_survives_rollback_and_restart(tmp_path: Path) -> None:
    wall = now_ms()
    mono = 0.0

    def jump_during_write(boundary: str) -> None:
        nonlocal wall, mono
        if boundary == "promoted":
            mono += 700
            wall += 50

    config = Config(tmp_path)
    with TestClient(create_app(config, storage=RecordsStorage(
        tmp_path, clock=lambda: wall, monotonic=lambda: mono, checkpoint=jump_during_write,
    )), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        rejected = submit(browser, headers, submitted=wall)
        assert rejected.status_code == 503
        assert rejected.json()["error"]["code"] == "NOT_READY"
        assert browser.get(OBJECTS, headers=headers).json()["items"] == []
    with TestClient(create_app(config, storage=RecordsStorage(
        tmp_path, clock=lambda: wall, monotonic=lambda: mono,
    )), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        assert submit(browser, headers, submitted=wall).json()["code"] == "NOT_READY"


def test_receipt_query_failure_remains_an_unknown_outcome(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        action, anchor = str(uuid4()), now_ms()
        first = submit(browser, headers, action=action, submitted=anchor)
        assert first.status_code == 201
        receipt = RecordsStorage.receipt

        def unreadable(*args: object) -> None:
            raise sqlite3.OperationalError("Injected receipt read failure")

        with monkeypatch.context() as faults:
            faults.setattr(RecordsStorage, "receipt", unreadable)
            uncertain = submit(browser, headers, action=action, submitted=anchor)
            assert uncertain.status_code == 500 and uncertain.json()["code"] == "INTERNAL_ERROR"
            assert "outcome is unknown" in uncertain.json()["message"]
        assert RecordsStorage.receipt is receipt
        replay = submit(browser, headers, action=action, submitted=anchor)
        assert replay.content == first.content
        assert len(browser.get(OBJECTS, headers=headers).json()["items"]) == 1


def test_found_records_media_errors_and_independent_duplicate(tmp_path: Path) -> None:
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        first = submit(browser, headers)
        earlier = first.json()["result"]["object"]
        with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db, db:
            db.execute("PRAGMA foreign_keys = ON")
            owner, registered = earlier["id"], earlier["registered_at_ms"]
            db.execute("UPDATE objects SET status = 'Found', found_at_ms = ?, revision = 2 WHERE id = ?", (registered, owner))
            db.execute("INSERT INTO sessions VALUES ('historic', ?, 'Controller', 'Ended', ?, ?, 'Confirmed', '[]', 2)",
                       (owner, registered, registered))
            db.execute("INSERT INTO match_events VALUES ('match','historic',?,?,'frame','epoch',0,0,1,1,"
                       "'Confirmed',?,'evidence',1,1)", (owner, registered, registered))
            db.execute("INSERT INTO media VALUES ('evidence',?,'match','Evidence','media/evidence.png','image/png',"
                       "1,1,?,?,?,'Ready')", (owner, len(PNG), hashlib.sha256(PNG).hexdigest(), registered))
        second = submit(browser, headers).json()["result"]["object"]
        assert second["id"] != earlier["id"] and second["name"] == earlier["name"] and second["status"] == "Lost"
        assert browser.get(first.headers["location"], headers=headers).json()["status"] == "Found"
        media_id = earlier["reference_media"]["id"]
        stored_path = tmp_path / "media" / f"{media_id}.png"
        data = stored_path.read_bytes()
        for label in ("Missing", "Corrupt"):
            if label == "Missing":
                stored_path.unlink()
            else:
                stored_path.write_bytes(b"?" + data[1:])
            detail = browser.get(first.headers["location"], headers=headers).json()
            assert detail["reference_media"]["availability"] == label and detail["status"] == "Found"
            media = browser.get(f"/api/v1/media/{media_id}", headers=headers)
            assert media.status_code == 503 and media.json()["code"] == "MEDIA_UNAVAILABLE"
        assert browser.get("/api/v1/media/never-issued", headers=headers).status_code == 404
        assert browser.get("/api/v1/objects/never-issued", headers=headers).status_code == 404


def multipart_body(parts: list[tuple[str, bytes]]) -> bytes:
    return b"".join(
        b'--test-boundary\r\nContent-Disposition: form-data; name="' + name.encode() + b'"\r\n\r\n' + value + b"\r\n"
        for name, value in parts
    ) + b"--test-boundary--\r\n"


@pytest.mark.parametrize("case", ["unknown", "duplicate", "missing", "epilogue", "truncated", "charset", "empty"])
def test_strict_multipart_framing(tmp_path: Path, case: str) -> None:
    parts = [("action_id", str(uuid4()).encode()), ("name", b"Desk plant"), ("roi", ROI.encode()),
             ("reference_image", PNG)]
    if case == "duplicate":
        parts.append(("name", b"Repeated name"))
    elif case == "unknown":
        parts.append(("description", b"Unsupported field"))
    elif case == "missing":
        parts.pop()
    elif case == "empty":
        parts[1] = ("name", b"")
    body = multipart_body(parts)
    if case == "epilogue":
        body += b"extraneous data"
    elif case == "truncated":
        body = body[:-7]
    elif case == "charset":
        body = body.replace(b'name="name"\r\n', b'name="name"\r\nContent-Type: text/plain; charset=iso-8859-1\r\n')
    with TestClient(create_app(Config(tmp_path)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        response = browser.post(OBJECTS, headers={
            **headers, "Content-Type": "multipart/form-data; boundary=test-boundary",
            "X-Action-Created-At-Ms": str(now_ms()),
        }, content=body)
        assert response.json()["code"] == {
            "charset": "UNSUPPORTED_MEDIA_TYPE", "empty": "VALIDATION_FAILED",
        }.get(case, "INVALID_MULTIPART"), response.text
        assert browser.get(OBJECTS, headers=headers).json()["items"] == []


def test_real_chunked_multipart_and_request_limit(tmp_path: Path) -> None:
    port = free_port()
    backend = launch(tmp_path / "records", port)
    try:
        headers = {
            **context_headers(connect(backend, port)), "Content-Type": "multipart/form-data; boundary=test-boundary",
            "X-Action-Created-At-Ms": str(now_ms()),
        }
        multipart = multipart_body([("action_id", str(uuid4()).encode()), ("name", b"Desk plant"),
                                    ("roi", ROI.encode()), ("reference_image", PNG)])
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=10) as http:
            result = http.post(OBJECTS, headers=headers, content=(multipart[i:i + 7] for i in range(0, len(multipart), 7)))
            assert result.status_code == 201, result.text
            request = f"POST {OBJECTS} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n"
            request += "".join(f"{key}: {value}\r\n" for key, value in headers.items())
            response_headers, response_body = raw_http(
                port, (request + f"Content-Length: {11 * 1024**2 + 1}\r\n\r\n").encode(),
            )
            assert "413" in response_headers and b"PAYLOAD_TOO_LARGE" in response_body
            oversized = multipart_body([("reference_image", b"x" * (10 * 1024**2 + 1))])
            result = http.post(OBJECTS, headers=headers, content=(
                oversized[i:i + 65536] for i in range(0, len(oversized), 65536)
            ))
            assert result.status_code == 413 and result.json()["code"] == "PAYLOAD_TOO_LARGE"
    finally:
        backend.kill()
        backend.communicate(timeout=10)


def test_reference_hard_link_cannot_make_external_file_available(tmp_path: Path) -> None:
    root = tmp_path / "records"
    with TestClient(create_app(Config(root)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        saved = submit(browser, headers)
        media_id = saved.json()["result"]["object"]["reference_media"]["id"]
        managed = root / "media" / (media_id + ".png")
        external = tmp_path / "original.png"
        contents = managed.read_bytes()
        external.write_bytes(contents)
        managed.unlink()
        os.link(external, managed)
        assert browser.get(f"/api/v1/media/{media_id}", headers=headers).json()["code"] == "MEDIA_UNAVAILABLE"
        assert browser.get(saved.headers["location"], headers=headers).json()["reference_media"]["availability"] == "Corrupt"
        assert external.read_bytes() == contents


def test_managed_staging_rejects_redirected_directory(tmp_path: Path) -> None:
    root = tmp_path / "records"
    external = tmp_path / "outside"
    external.mkdir()
    source = external / "original.png"
    source.write_bytes(PNG)
    staging = root / "staging"
    with TestClient(create_app(Config(root)), base_url=BASE) as browser:
        headers = credentials(browser)
        wait_for_health(browser, headers)
        staging.rmdir()
        if os.name == "nt":
            subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                            "New-Item -ItemType Junction -Path $env:LAF_TEST_LINK -Target $env:LAF_TEST_LINK_TARGET"],
                           env={**os.environ, "LAF_TEST_LINK": str(staging), "LAF_TEST_LINK_TARGET": str(external)},
                           check=True, capture_output=True, timeout=10)
        else:
            staging.symlink_to(external, target_is_directory=True)
        try:
            rejected = submit(browser, headers)
            assert rejected.status_code == 503 and rejected.json()["persistence"] == "Failed", rejected.text
            assert browser.get("/api/v1/health", headers=headers).json()["storage_integrity"] == "Unavailable"
            assert list(external.iterdir()) == [source] and source.read_bytes() == PNG
            assert not list((root / "media").iterdir())
        finally:
            if os.name == "nt":
                staging.rmdir()
            else:
                staging.unlink()
