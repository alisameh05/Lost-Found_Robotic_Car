from dataclasses import replace
from pathlib import Path
from threading import Event
from time import monotonic
from uuid import uuid4

import pytest

from backend.app import sessions
from backend.app.simulation import CandidateObservation, InferenceSample
from backend.app.storage import DAY_MS, utc_ms
from backend.tests.test_realtime import (
    API,
    acquire_control,
    arm,
    auth,
    driving_search,
    event,
    search_action,
    service,
    validate,
    wait_for,
    wait_output,
)


def candidate(sample: InferenceSample) -> bool | CandidateObservation:
    capture, scope, frame = sample.capture, sample.scope, sample.frame_id
    if capture is None or scope is None or frame is None:
        return True
    return CandidateObservation(scope, frame, capture.stream_epoch, capture.clock_epoch, capture.sequence,
                                (2.25, 3.5, 4.0, 6.0))


def review(laf, headers):
    state = wait_for(laf.http, "/snapshot", headers, lambda data: data["pending_candidate"] is not None)
    return state["pending_candidate"], state["active_session"]


def action_body(driver, match, session, action="confirm"):
    return {
        "action_id": str(uuid4()), "session_id": session["id"], "expected_revision": session["revision"],
        "action": action, "client_id": driver.owner["client_id"], "client_lease_id": driver.lease["client_lease_id"],
        **({"candidate_id": match["id"]} if action == "confirm" else {}),
    }


def test_invalid_and_superseded_observations_do_not_pause_or_save(tmp_path: Path) -> None:
    valid = Event()
    rejected: list[str] = []
    first: CandidateObservation | None = None

    def infer(sample: InferenceSample) -> bool | CandidateObservation:
        nonlocal first
        result = candidate(sample)
        if not isinstance(result, CandidateObservation):
            return result
        if valid.is_set():
            assert sample.capture
            return replace(result, box=(sample.capture.width - 1.5, -0.5, 2.0, 4.0))
        first = first or result
        replacements = [
            {"frame_id": "wrong"}, {"stream_epoch": "wrong"}, {"clock_epoch": "wrong"},
            {"capture_sequence": result.capture_sequence + 1}, {"scope": replace(result.scope, session="wrong")},
            {"scope": replace(result.scope, generation=result.scope.generation - 1)},
            {"box": (2.0, 3.0, 0.0, 4.0)}, {"box": (float("nan"), 3.0, 2.0, 3.0)},
            {"box": (10000, 0, 2, 3)},
        ]
        index = len(rejected)
        rejected.append(result.frame_id)
        return replace(result, **replacements[index]) if index < len(replacements) else first

    with service(tmp_path, inference=infer) as laf, driving_search(laf) as (headers, _):
        state = wait_for(laf.http, "/snapshot", headers, lambda _: len(rejected) > 12)
        assert state["active_session"]["revision"] == 1
        assert state["runtime"]["effective_session_state"] == "Searching"
        assert state["pending_candidate"] is None
        valid.set()
        match, session = review(laf, headers)
        assert match["frame_id"] not in rejected and session["revision"] == 2
        assert match["box"] == {"x": match["evidence_media"]["width"] - 2, "y": 0, "width": 2, "height": 4}
        history = laf.http.get(f"{API}/sessions/{session['id']}/matches", headers=headers).json()
        assert history["items"] == [match]


@pytest.mark.parametrize("fault", ["missing", "corrupt", "commit"])
def test_failed_confirm_keeps_pending_and_original_intent_can_retry(tmp_path: Path, fault: str) -> None:
    fail = True

    def checkpoint(point: str) -> None:
        if fail and fault == "commit" and point == "before_confirm_commit":
            raise OSError("Test storage failure")

    with service(tmp_path, inference=candidate, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        path = f"{API}/sessions/{session['id']}"
        evidence = tmp_path / "media" / f"{match['evidence_media']['id']}.png"
        png = evidence.read_bytes()
        if fault == "missing":
            evidence.unlink()
        elif fault == "corrupt":
            evidence.write_bytes(b"corrupt")
        attempt = action_body(driver, match, session)
        failed = laf.http.post(path + "/actions", headers=headers, json=attempt)
        assert failed.status_code == 503, failed.text
        failed_save = failed.json()
        assert failed_save["persistence"] == "Failed" and failed_save["result"] is None
        assert failed_save["error"]["code"] == ("STORAGE_UNAVAILABLE" if fault == "commit" else "MEDIA_UNAVAILABLE")
        current, saved = review(laf, headers)
        assert saved == session and current["disposition"] == "Pending" and current["reviewed_at_ms"] is None
        if fault != "commit":
            assert current["evidence_media"]["availability"] == fault.capitalize()
            assert laf.http.get(f"{API}/media/{match['evidence_media']['id']}", headers=headers).status_code == 503
            evidence.write_bytes(png)
        target = laf.http.get(f"{API}/objects/{match['object_id']}", headers=headers).json()
        assert target["status"] == "Lost" and target["revision"] == 1
        fail = False
        committed = laf.http.post(path + "/actions", headers=headers, json=attempt)
        assert committed.status_code == 200, committed.text
        result = committed.json()["result"]
        validate("MutationResponse", committed.json())
        assert result["object"]["status"] == "Found" and result["object"]["revision"] == 2
        assert result["session"]["revision"] == session["revision"] + 1
        assert result["session"]["end_reason"] == result["match"]["disposition"] == "Confirmed"
        assert result["object"]["found_at_ms"] == result["session"]["ended_at_ms"] == result["match"]["reviewed_at_ms"]
        evidence.unlink()
        assert laf.http.post(path + "/actions", headers=headers, json=attempt).content == committed.content
        history = laf.http.get(path + "/matches", headers=headers).json()["items"][0]
        assert history["disposition"] == "Confirmed" and history["evidence_media"]["availability"] == "Missing"


@pytest.mark.parametrize("interrupt", ["stop", "emergency"])
def test_confirm_race_preserves_the_winning_durable_outcome(tmp_path: Path, interrupt: str) -> None:
    entered, release = Event(), Event()

    def checkpoint(point: str) -> None:
        if point == "before_confirm_commit":
            entered.set()
            assert release.wait(5)

    with service(tmp_path, inference=candidate, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        path = f"{API}/sessions/{session['id']}"
        confirm = action_body(driver, match, session)
        stop = action_body(driver, match, session, "stop")
        try:
            first = laf.http.post(path + "/actions", headers=headers, json=confirm)
            assert entered.is_set() and first.status_code == 202
            assert laf.http.post(path + "/actions", headers=headers, json=confirm).content == first.content
            collision = laf.http.post(path + "/actions", headers=headers, json={**confirm, "candidate_id": "different"})
            assert collision.status_code == 409 and collision.json()["code"] == "ACTION_ID_CONFLICT"
            if interrupt == "stop":
                overtakes = laf.http.post(path + "/actions", headers=headers, json=stop)
            else:
                overtakes = laf.http.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
            assert overtakes.status_code == 202, overtakes.text
            wait_output(laf, None)
            assert laf.http.get(f"{API}/objects/{match['object_id']}", headers=headers).json()["status"] == "Lost"
        finally:
            release.set()
        completion = wait_for(laf.http, "/snapshot", headers, lambda state: any(
            op["action_id"] == confirm["action_id"] and op["persistence"] == "Failed" for op in state["operations"]
        ))
        failure = next(op for op in completion["operations"] if op["action_id"] == confirm["action_id"])
        assert failure["error"]["code"] == ("INVALID_TRANSITION" if interrupt == "stop" else "LEASE_EXPIRED")
        if interrupt == "stop":
            saved = wait_for(laf.http, f"/sessions/{session['id']}", headers, lambda data: data["state"] == "Ended")
            assert saved["end_reason"] == "Stopped" and saved["revision"] == session["revision"] + 1
            first_stop = laf.http.post(path + "/actions", headers=headers, json=stop).json()
            assert first_stop["result"]["match"]["disposition"] == "NotReviewed"
            assert first_stop["result"]["match"]["reviewed_at_ms"] is None
            assert laf.http.post(path + "/actions", headers=headers, json=confirm).status_code == 409
        else:
            current, _ = review(laf, headers)
            assert current["disposition"] == "Pending" and completion["lease"]["state"] == "Unowned"


@pytest.mark.parametrize("boundary", ["candidate_promoted", "before_candidate_commit"])
def test_stop_invalidates_uncommitted_evidence(tmp_path: Path, boundary: str) -> None:
    trigger, reached, release = Event(), Event(), Event()

    def checkpoint(point: str) -> None:
        if point == boundary:
            reached.set()
            assert release.wait(5)

    def infer(value: InferenceSample) -> bool | CandidateObservation:
        return candidate(value) if trigger.is_set() else True

    with service(tmp_path, inference=infer, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        arm(laf, headers)
        trigger.set()
        try:
            assert reached.wait(3)
            assert laf.command.output is None
            snapshot = laf.http.get(API + "/snapshot", headers=headers).json()
            assert snapshot["active_session"]["state"] == "Searching"
            assert snapshot["runtime"]["effective_session_state"] == "Paused"
            assert snapshot["pending_candidate"] is None
            response = search_action(laf, headers, driver, "stop", snapshot["active_session"]["revision"])
            assert response.status_code == 202, response.text
        finally:
            release.set()
        session = driver.session["id"]
        saved = wait_for(laf.http, f"/sessions/{session}", headers, lambda data: data["state"] == "Ended")
        assert saved["end_reason"] == "Stopped"
        assert laf.http.get(f"{API}/sessions/{session}/matches", headers=headers).json()["items"] == []
        assert len(list((tmp_path / "media").iterdir())) == 1
        assert not list((tmp_path / "staging").iterdir())


def test_failed_candidate_preparation_saves_fault_and_cleans_up(tmp_path: Path) -> None:
    def checkpoint(point: str) -> None:
        if point == "before_candidate_commit":
            raise OSError("Test evidence commit failure")

    with service(tmp_path, inference=candidate, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        state = wait_for(laf.http, "/snapshot", headers, lambda data: data["active_session"]["state"] == "Paused")
        assert state["pending_candidate"] is None and state["runtime"]["motion_permission"] == "Disarmed"
        assert any(failure["cause"] == "StorageFault" for failure in state["failures"])
        assert laf.http.get(f"{API}/sessions/{driver.session['id']}/matches", headers=headers).json()["items"] == []
        assert len(list((tmp_path / "media").iterdir())) == 1
        assert not list((tmp_path / "staging").iterdir())


def test_superseded_encoder_does_not_suspend_a_new_search(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    entered, release, observe = Event(), Event(), Event()
    sampled_sessions: set[str] = set()
    encode = sessions.encode_evidence

    def gated_encode(capture):
        if not entered.is_set():
            entered.set()
            assert release.wait(8)
        return encode(capture)

    def infer(sample: InferenceSample) -> bool | CandidateObservation:
        if observe.is_set() and sample.scope:
            sampled_sessions.add(sample.scope.session)
            return candidate(sample)
        return True

    monkeypatch.setattr(sessions, "encode_evidence", gated_encode)
    with service(tmp_path, inference=infer) as laf:
        try:
            with driving_search(laf) as (headers, driver):
                observe.set()
                assert entered.wait(2)
                first = driver.session["id"]
                stopped = search_action(laf, headers, driver, "stop", 1)
                assert stopped.status_code == 200 and stopped.json()["result"]["match"] is None
            with driving_search(laf, takeover=True) as (headers, driver):
                current = wait_for(laf.http, "/snapshot", headers, lambda _: driver.session["id"] in sampled_sessions)
                assert current["runtime"]["effective_session_state"] == "Searching" and current["pending_candidate"] is None
                assert not release.is_set()
                release.set()
                match, _ = review(laf, headers)
                assert match["session_id"] == driver.session["id"] != first
                assert laf.http.get(f"{API}/sessions/{first}/matches", headers=headers).json()["items"] == []
        finally:
            release.set()


@pytest.mark.parametrize("action", ["confirm", "stop"])
def test_expired_review_ends_grace_without_returning_saved_owner(tmp_path: Path, action: str) -> None:
    offset = 0
    with service(tmp_path, inference=candidate, wall=lambda: utc_ms() + offset) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        offset += 7 * DAY_MS
        wait_for(laf.http, "/snapshot", headers, lambda state: state["retention"]["active_object_grace"])
        path = f"{API}/sessions/{session['id']}"
        body = action_body(driver, match, session, action)
        ended = laf.http.post(path + "/actions", headers=headers, json=body)
        assert ended.status_code == 200, ended.text
        assert ended.json()["result"] == dict.fromkeys(("object", "session", "match", "settings", "deletion"))
        deadline = monotonic() + 2
        while monotonic() < deadline:
            message = driver.messages.get(timeout=1)
            if message["type"] == "object_removed":
                assert message["payload"]["object_id"] == match["object_id"]
                break
        else:
            pytest.fail("Expected object removal event")
        current = wait_for(laf.http, "/snapshot", headers, lambda state: state["active_object"] is None)
        assert current["pending_candidate"] is None and current["active_object"] is None
        assert current["operations"] == []
        assert laf.http.post(path + "/actions", headers=headers, json=body).status_code in (404, 410)
        assert laf.http.get(path + "/matches", headers=headers).status_code in (404, 410)


def test_confirm_receipt_is_recovered_with_a_new_boot_client_and_lease(tmp_path: Path) -> None:
    with service(tmp_path, inference=candidate) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        body = action_body(driver, match, session)
        path = f"{API}/sessions/{session['id']}"
        result = laf.http.post(path + "/actions", headers=headers, json=body)
        assert result.status_code == 200, result.text
        original, previous_boot = result.content, driver.owner["backend_boot_id"]

    with service(tmp_path) as laf:
        owner = laf.bootstrap()
        assert owner["backend_boot_id"] != previous_boot and owner["client_id"] != body["client_id"]
        headers = auth(owner)
        wait_for(laf.http, "/health", headers)
        with laf.open("/events", laf.ticket(headers, "events")) as events:
            assert event(events)["payload"]["active_session"] is None
            lease = acquire_control(laf, owner)
            retry = {**body, "client_id": owner["client_id"], "client_lease_id": lease["client_lease_id"]}
            assert retry["client_lease_id"] != body["client_lease_id"]
            same = laf.http.post(path + "/actions", headers=headers, json=retry)
            assert same.status_code == 200 and same.content == original
            changed = laf.http.post(path + "/actions", headers=headers, json={**retry, "candidate_id": "other"})
            assert changed.status_code == 409 and changed.json()["code"] == "ACTION_ID_CONFLICT"
            assert laf.http.get(path, headers=headers).json()["end_reason"] == "Confirmed"
            assert laf.http.get(API + "/snapshot", headers=headers).json()["active_session"] is None
