import json
import sqlite3
from functools import partial
from io import BytesIO
from pathlib import Path
from time import monotonic, sleep
from uuid import uuid4

import pytest
from PIL import Image

from backend.app import realtime
from backend.app.storage import RecordsStorage
from backend.tests.test_candidate_review import review
from backend.tests.test_realtime import (
    API,
    arm,
    auth,
    driving_search,
    recover_workspace,
    search_action,
    service,
    wait_for,
)
from backend.tests.vision_stub import controlled_worker, publish


def await_file(path: Path) -> None:
    deadline = monotonic() + 5
    while monotonic() < deadline and not path.exists():
        sleep(0.01)
    assert path.exists(), path


@pytest.fixture(name="spawned_matcher")
def matcher_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(realtime, "VisionProcess", partial(realtime.VisionProcess, target=controlled_worker))
    return tmp_path / "vision"


def test_worker_evidence_uses_analyzed_pixels_after_display_advances(tmp_path: Path, spawned_matcher: Path) -> None:
    # A monotonic-derived wall clock avoids Windows wall-clock quantization in the timestamp comparison.
    def wall() -> int:
        return 1_800_000_000_000 + int(monotonic() * 1000)

    with service(tmp_path, local_vision=True, wall=wall) as laf, driving_search(laf) as (headers, driver):
        prompt_file = spawned_matcher / "prompt.json"
        await_file(prompt_file)
        prompt = json.loads(prompt_file.read_text(encoding="utf-8"))
        target = laf.http.get(f"{API}/objects/{driver.session['object_id']}", headers=headers).json()
        assert prompt["prompt"] == target["reference_media"]["id"]
        assert prompt["roi"] == [target["roi"][key] for key in ("x", "y", "width", "height")]
        arm(laf, headers)
        publish(spawned_matcher / "request", "candidate")
        await_file(spawned_matcher / "frame.json")
        analyzed = json.loads((spawned_matcher / "frame.json").read_text(encoding="utf-8"))
        analyzed_jpeg = (spawned_matcher / "analyzed.jpg").read_bytes()
        video = BytesIO()
        Image.new("RGB", (analyzed["width"], analyzed["height"]), "orange").save(video, "JPEG")
        laf.observations.robot_jpeg = video.getvalue()
        wait_for(laf.http, "/snapshot", headers, lambda _: (
            driver.latest is not None and driver.latest["capture_seq"] >= analyzed["sequence"] + 2
        ))
        assert driver.latest and driver.latest["frame_id"] != analyzed["frame"]
        (spawned_matcher / "release").touch()
        match, session = review(laf, headers)
        assert laf.command is not None and laf.command.output is None
        assert match["frame_id"] == analyzed["frame"] and match["stream_epoch"] == analyzed["stream"]
        assert match["box"] == {"x": 2, "y": 3, "width": 5, "height": 7}
        packet = next(item for item in tuple(driver.received_frames) if item["frame_id"] == match["frame_id"])
        assert packet["source_capture_us"] == analyzed["source_us"]
        assert packet["capture_seq"] == analyzed["sequence"]
        assert abs(match["captured_at_ms"] - (packet["received_at_ms"] - packet["capture_age_bound_ms"])) <= 3
        url = f"{API}/media/{match['evidence_media']['id']}"
        evidence = laf.http.get(url, headers=headers)
        assert evidence.status_code == 200 and evidence.headers["content-type"] == "image/png"
        with Image.open(BytesIO(analyzed_jpeg)) as decoded, Image.open(BytesIO(evidence.content)) as saved:
            assert decoded.size == saved.size
            assert decoded.convert("RGB").tobytes() == saved.tobytes()
        rejected = search_action(laf, headers, driver, "reject", session["revision"], candidate_id=match["id"])
        assert rejected.status_code in (200, 202), rejected.text
        latest = wait_for(laf.http, f"/sessions/{session['id']}/matches", headers,
                          lambda data: data["items"][0]["disposition"] == "Rejected")
        assert latest["items"][0]["reviewed_at_ms"] is not None


def test_blocked_matcher_skips_superseded_frames(tmp_path: Path, spawned_matcher: Path) -> None:
    with service(tmp_path, local_vision=True) as laf, driving_search(laf) as (headers, driver):
        publish(spawned_matcher / "request", "hold")
        await_file(spawned_matcher / "frame.json")
        first = json.loads((spawned_matcher / "frame.json").read_text(encoding="utf-8"))
        wait_for(laf.http, "/snapshot", headers, lambda _: (
            driver.latest is not None and driver.latest["capture_seq"] >= first["sequence"] + 3
        ))
        (spawned_matcher / "record-next").touch()
        (spawned_matcher / "release").touch()
        await_file(spawned_matcher / "next-frame.json")
        latest = json.loads((spawned_matcher / "next-frame.json").read_text(encoding="utf-8"))
        assert latest["sequence"] >= first["sequence"] + 3
        assert latest["frame"] != first["frame"]


def test_pause_discards_the_old_generation_reply(tmp_path: Path, spawned_matcher: Path) -> None:
    with service(tmp_path, local_vision=True) as laf, driving_search(laf) as (headers, driver):
        arm(laf, headers)
        prompt_file = spawned_matcher / "prompt.json"
        await_file(prompt_file)
        prepared = prompt_file.read_bytes()
        publish(spawned_matcher / "request", "candidate")
        await_file(spawned_matcher / "frame.json")
        pause = search_action(laf, headers, driver, "pause", 1)
        assert pause.status_code in (200, 202), pause.text
        captured = wait_for(laf.http, "/snapshot", headers, lambda state: state["active_session"]["state"] == "Paused")
        (spawned_matcher / "release").touch()
        wait_for(laf.http, "/snapshot", headers, lambda state: state["readiness"]["can_resume"])
        (spawned_matcher / "record-next").touch()
        resume = search_action(laf, headers, driver, "resume", captured["active_session"]["revision"])
        assert resume.status_code in (200, 202), resume.text
        await_file(spawned_matcher / "next-frame.json")
        first = json.loads((spawned_matcher / "frame.json").read_text(encoding="utf-8"))
        latest = json.loads((spawned_matcher / "next-frame.json").read_text(encoding="utf-8"))
        assert latest["generation"] > first["generation"] and latest["sequence"] > first["sequence"]
        assert prompt_file.read_bytes() == prepared
        assert laf.http.get(f"{API}/sessions/{driver.session['id']}/matches", headers=headers).json()["items"] == []


def test_replaced_robot_epoch_cannot_publish_an_inflight_match(tmp_path: Path, spawned_matcher: Path) -> None:
    with service(tmp_path, local_vision=True) as laf, driving_search(laf) as (headers, driver):
        publish(spawned_matcher / "request", "candidate")
        await_file(spawned_matcher / "frame.json")
        laf.observations.robot = "epoch"
        wait_for(laf.http, "/snapshot", headers, lambda state: any(
            failure["cause"] == "CameraEpochChanged" for failure in state["failures"]
        ))
        (spawned_matcher / "record-probe").touch()
        (spawned_matcher / "release").touch()
        await_file(spawned_matcher / "probe.json")
        saved = wait_for(laf.http, f"/sessions/{driver.session['id']}", headers,
                         lambda session: session["state"] == "Paused")
        assert laf.http.get(f"{API}/sessions/{saved['id']}/matches", headers=headers).json()["items"] == []


def test_stopped_match_cannot_cross_into_a_new_session(tmp_path: Path, spawned_matcher: Path) -> None:
    with service(tmp_path, local_vision=True) as laf:
        with driving_search(laf) as (headers, driver):
            publish(spawned_matcher / "request", "candidate")
            await_file(spawned_matcher / "frame.json")
            first = driver.session["id"]
            stopped = search_action(laf, headers, driver, "stop", driver.session["revision"])
            assert stopped.status_code in (200, 202), stopped.text
            wait_for(laf.http, f"/sessions/{first}", headers, lambda session: session["state"] == "Ended")
        with driving_search(laf, takeover=True) as (headers, driver):
            second = driver.session["id"]
            assert first != second
            (spawned_matcher / "record-next").touch()
            (spawned_matcher / "release").touch()
            await_file(spawned_matcher / "next-frame.json")
            latest = json.loads((spawned_matcher / "next-frame.json").read_text(encoding="utf-8"))
            assert latest["session"] == second
            for session in (first, second):
                assert laf.http.get(f"{API}/sessions/{session}/matches", headers=headers).json()["items"] == []


@pytest.mark.parametrize("fault", ["stall", "exit", "bad-scope", "bad-box"])
def test_matcher_fault_revokes_logical_output_and_records_ai_recovery(
    tmp_path: Path, spawned_matcher: Path, fault: str,
) -> None:
    with service(tmp_path, local_vision=True) as laf, driving_search(laf) as (headers, _):
        arm(laf, headers)
        publish(spawned_matcher / "request", fault)
        await_file(spawned_matcher / "frame.json")
        state = wait_for(laf.http, "/snapshot", headers, lambda snapshot: any(
            failure["cause"] == "AIUnavailable" for failure in snapshot["failures"]
        ))
        assert state["runtime"]["effective_session_state"] == "Paused"
        assert state["runtime"]["motion_permission"] == "Disarmed"
        assert state["pending_candidate"] is None and laf.command is not None and laf.command.output is None
        assert laf.http.get(API + "/health", headers=headers).status_code == 200
        restored = wait_for(laf.http, "/snapshot", headers, lambda snapshot: any(
            part["component"] == "AI" and part["status"] == "Ready"
            for part in snapshot["readiness"]["components"]
        ))
        assert not restored["readiness"]["can_resume"]
        assert restored["runtime"]["motion_permission"] == "Disarmed"
        if fault == "exit":
            paused = wait_for(laf.http, "/snapshot", headers, lambda state: (
                state["active_session"]["state"] == "Paused"
                and any(failure["restored"] for failure in state["failures"] if failure["cause"] == "AIUnavailable")
            ))
            failure = next(failure for failure in paused["failures"] if failure["cause"] == "AIUnavailable")
            with recover_workspace(laf, paused["active_session"]) as (current_headers, driver):
                ack = search_action(laf, current_headers, driver, "acknowledge",
                                    paused["active_session"]["revision"], failure_ids=[failure["failure_id"]])
                assert ack.status_code in (200, 202), ack.text
                ready = wait_for(laf.http, "/snapshot", current_headers,
                                 lambda state: state["readiness"]["can_resume"])
                resume = search_action(laf, current_headers, driver, "resume", ready["active_session"]["revision"])
                assert resume.status_code in (200, 202), resume.text
                wait_for(laf.http, "/snapshot", current_headers,
                         lambda state: state["active_session"]["state"] == "Searching")
                sleep(0.3)
                assert laf.command.output is None
                laf.observations.dpad = ()
                arm(laf, current_headers)


@pytest.mark.parametrize("mode", ["Gestures", "Controller"])
def test_emergency_is_independent_of_a_blocked_spawned_matcher(
    tmp_path: Path, spawned_matcher: Path, mode: str,
) -> None:
    with service(tmp_path, local_vision=True) as laf, driving_search(laf, mode) as (headers, _):
        arm(laf, headers, mode)
        publish(spawned_matcher / "request", "stall")
        await_file(spawned_matcher / "frame.json")
        response = laf.http.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
        assert response.status_code in (200, 202), response.text
        assert not (spawned_matcher / "release").exists()
        assert laf.command is not None and laf.command.output is None


def test_missing_matcher_assets_block_start_but_leave_records_and_emergency_available(tmp_path: Path) -> None:
    with service(tmp_path, local_vision=True) as laf:
        headers = auth(laf.bootstrap())
        health = wait_for(laf.http, "/health", headers, lambda snapshot: any(
            item["component"] == "AI" and item["status"] == "Unavailable" for item in snapshot["readiness"]["components"]
        ))
        assert not any(health["readiness"]["can_start"].values())
        assert laf.http.get(API + "/objects", headers=headers).status_code == 200
        response = laf.http.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
        assert response.status_code == 200


def test_prompt_read_failure_allows_worker_recovery(
    tmp_path: Path, spawned_matcher: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    read_media = RecordsStorage.read_media
    failed = False

    def fail_once(storage, media_id, preparing):
        nonlocal failed
        if not failed:
            failed = True
            raise sqlite3.OperationalError("temporary test read failure")
        return read_media(storage, media_id, preparing)

    monkeypatch.setattr(RecordsStorage, "read_media", fail_once)
    with service(tmp_path, local_vision=True) as laf, driving_search(laf) as (headers, _):
        restored = wait_for(laf.http, "/snapshot", headers, lambda state: any(
            failure["cause"] == "AIUnavailable" and failure["restored"] for failure in state["failures"]
        ))
        assert failed and restored["runtime"]["motion_permission"] == "Disarmed"
        assert not restored["readiness"]["can_resume"] and not (spawned_matcher / "prompt.json").exists()
