import sqlite3
from contextlib import closing
from dataclasses import replace
from pathlib import Path
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import pytest
from websockets.exceptions import ConnectionClosed

from backend.app import sessions
from backend.app.simulation import CandidateObservation, FixturePresence, InferenceSample
from backend.app.storage import DAY_MS, utc_ms
from backend.tests.test_realtime import (
    API,
    acquire_control,
    arm,
    auth,
    driving_search,
    event,
    recover_workspace,
    search_action,
    service,
    validate,
    wait_for,
    wait_output,
)
from backend.tests.test_registration import PNG, submit


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
        **({"candidate_id": match["id"]} if action in ("confirm", "reject") else {}),
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
@pytest.mark.parametrize("action", ["confirm", "reject"])
def test_review_race_preserves_the_winning_durable_outcome(tmp_path: Path, interrupt: str, action: str) -> None:
    entered, release = Event(), Event()

    def checkpoint(point: str) -> None:
        if point == f"before_{action}_commit":
            entered.set()
            assert release.wait(5)

    with service(tmp_path, inference=candidate, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        path = f"{API}/sessions/{session['id']}"
        decision = action_body(driver, match, session, action)
        stop = action_body(driver, match, session, "stop")
        try:
            first = laf.http.post(path + "/actions", headers=headers, json=decision)
            assert entered.is_set() and first.status_code == 202
            assert laf.http.post(path + "/actions", headers=headers, json=decision).content == first.content
            collision = laf.http.post(path + "/actions", headers=headers, json={**decision, "candidate_id": "different"})
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
            op["action_id"] == decision["action_id"] and op["persistence"] == "Failed" for op in state["operations"]
        ))
        failure = next(op for op in completion["operations"] if op["action_id"] == decision["action_id"])
        assert failure["error"]["code"] == ("INVALID_TRANSITION" if interrupt == "stop" else "LEASE_EXPIRED")
        if interrupt == "stop":
            saved = wait_for(laf.http, f"/sessions/{session['id']}", headers, lambda data: data["state"] == "Ended")
            assert saved["end_reason"] == "Stopped" and saved["revision"] == session["revision"] + 1
            first_stop = laf.http.post(path + "/actions", headers=headers, json=stop).json()
            assert first_stop["result"]["match"]["disposition"] == "NotReviewed"
            assert first_stop["result"]["match"]["reviewed_at_ms"] is None
            assert laf.http.post(path + "/actions", headers=headers, json=decision).status_code == 409
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
    root = tmp_path / "records"
    original = tmp_path / "original.png"
    original.write_bytes(PNG)
    owner_id = ""
    with service(root, inference=candidate, wall=lambda: utc_ms() + offset) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        owner_id = match["object_id"]
        target = f"{API}/objects/{owner_id}"
        owner = laf.http.get(target, headers=headers).json()
        evidence_id = match["evidence_media"]["id"]
        evidence = root / "media" / f"{evidence_id}.png"
        staged = root / "staging" / f"{evidence_id}.part"
        staged.write_bytes(evidence.read_bytes())
        offset += 7 * DAY_MS
        graced = wait_for(laf.http, "/snapshot", headers, lambda state: state["retention"]["active_object_grace"])
        assert graced["active_session"]["state"] == "Paused"
        assert graced["pending_candidate"]["id"] == match["id"]
        assert graced["active_object"]["registered_at_ms"] == owner["registered_at_ms"]
        assert graced["active_object"]["expires_at_ms"] == owner["expires_at_ms"]
        assert laf.http.get(f"{API}/media/{evidence_id}", headers=headers).status_code == 200
        settings = {"expected_revision": 1, "retention_days": 30}
        blocked = laf.http.post(f"{API}/settings/retention-preview", headers=headers, json=settings)
        assert blocked.status_code == 409 and blocked.json()["code"] == "ACTIVE_SESSION_EXISTS"
        blocked = laf.http.put(f"{API}/settings/retention", headers=headers, json={
            **settings, "action_id": str(uuid4()), "preview_id": "saved-preview", "confirmed": True,
        })
        assert blocked.status_code == 409 and blocked.json()["code"] == "ACTIVE_SESSION_EXISTS"
        independent = submit(laf.http, headers, submitted=utc_ms() + offset, image=original.read_bytes())
        assert independent.status_code == 201, independent.text
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
        current = wait_for(laf.http, "/snapshot", headers, lambda state: state["active_object"] is None and
                           state["retention"]["deletion"]["status"] == "Complete")
        assert current["pending_candidate"] is None and current["active_object"] is None
        assert all(operation["action_id"] != body["action_id"] for operation in current["operations"])
        assert laf.http.post(path + "/actions", headers=headers, json=body).status_code in (404, 410)
        assert laf.http.get(path + "/matches", headers=headers).status_code == 404
        assert laf.http.get(target, headers=headers).status_code == 404
        assert laf.http.get(f"{API}/media/{evidence_id}", headers=headers).status_code == 404
        assert not evidence.exists() and not staged.exists()
        assert original.read_bytes() == PNG
    with closing(sqlite3.connect(root / "records.sqlite3")) as db:
        assert db.execute("SELECT id FROM objects WHERE id=?", (owner_id,)).fetchone() is None
        for table in ("sessions", "match_events", "media", "action_receipts"):
            assert db.execute(f"SELECT 1 FROM {table} WHERE object_id=?", (owner_id,)).fetchone() is None
        assert db.execute("SELECT 1 FROM storage_operations WHERE owner_object_id=?", (owner_id,)).fetchone() is None


def test_searching_grace_and_removal_are_visible_while_managed_cleanup_is_blocked(tmp_path: Path) -> None:
    offset = 0
    deleting, proceed = Event(), Event()

    def checkpoint(point: str) -> None:
        if point in ("purge_before_journal", "purge_file_removed"):
            deleting.set()
            assert proceed.wait(8)

    with service(tmp_path, wall=lambda: utc_ms() + offset, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        session = driver.session
        path = f"{API}/sessions/{session['id']}"
        target = f"{API}/objects/{session['object_id']}"
        owner = laf.http.get(target, headers=headers).json()
        reference = f"{API}/media/{owner['reference_media']['id']}"
        offset += 7 * DAY_MS
        current = wait_for(laf.http, "/snapshot", headers, lambda state: state["retention"]["active_object_grace"])
        assert current["active_session"]["state"] == "Searching"
        assert laf.http.get(reference, headers=headers).status_code == 200
        spectator = auth(laf.bootstrap())
        with laf.open("/events", laf.ticket(spectator, "events")) as events:
            initial = event(events)
            assert initial["payload"]["active_object"]["id"] == owner["id"]
            body = action_body(driver, None, session, "stop")
            try:
                ended = laf.http.post(path + "/actions", headers=headers, json=body)
                assert ended.status_code == 200, ended.text
                assert ended.json()["result"] == dict.fromkeys(("object", "session", "match", "settings", "deletion"))
                assert deleting.wait(2)
                assert laf.http.get(target, headers=spectator).status_code == 410
                assert laf.http.get(reference, headers=spectator).status_code == 410
                assert laf.http.post(path + "/actions", headers=headers, json=body).status_code == 410
                last_seq = initial["event_seq"]
                while (message := event(events))["type"] != "object_removed":
                    assert message["event_seq"] == last_seq + 1
                    last_seq = message["event_seq"]
                    assert message["type"] != "session_changed" or message["payload"]["session"]["state"] != "Ended"
                assert message["event_seq"] == last_seq + 1
                assert message["payload"] == {"object_id": owner["id"], "reason": "Expired"}
                with closing(sqlite3.connect(tmp_path / "records.sqlite3")) as db:
                    assert db.execute("SELECT deletion_pending FROM objects WHERE id=?", (owner["id"],)).fetchone() == (1,)
                    assert db.execute("SELECT phase FROM storage_operations WHERE owner_object_id=?",
                                      (owner["id"],)).fetchone() == ("Pending",)
            finally:
                proceed.set()
        wait_for(laf.http, "/snapshot", headers, lambda state: not state["operations"])
        assert laf.http.get(target, headers=headers).status_code in (404, 410)


def test_slow_spectator_drops_queued_review_at_grace_end_and_rejoins_idle(tmp_path: Path) -> None:
    offset = 0
    with service(tmp_path, blocked=True, blocked_connection=2, inference=candidate,
                 wall=lambda: utc_ms() + offset) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        offset += 7 * DAY_MS
        wait_for(laf.http, "/snapshot", headers, lambda state: state["retention"]["active_object_grace"])
        spectator = auth(laf.bootstrap())
        assert laf.blocked
        with laf.open("/events", laf.ticket(spectator, "events")) as slow:
            assert laf.blocked.entered[API + "/events"].wait(2)
            path = f"{API}/sessions/{session['id']}/actions"
            response = laf.http.post(path, headers=headers, json=action_body(driver, match, session))
            assert response.status_code in (200, 202), response.text
            with pytest.raises(ConnectionClosed) as closed:
                slow.recv(timeout=2)
            assert closed.value.rcvd and closed.value.rcvd.code == 1008
        laf.blocked.resume_events.set()
        with laf.open("/events", laf.ticket(spectator, "events")) as restored:
            snapshot = event(restored)["payload"]
            assert snapshot["active_object"] is snapshot["active_session"] is snapshot["pending_candidate"] is None
            assert snapshot["operations"] == []
            assert snapshot["lease"]["state"] == "Unowned"


def test_confirm_receipt_is_recovered_with_a_new_boot_client_and_lease(tmp_path: Path) -> None:
    with service(tmp_path, inference=candidate) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        body = action_body(driver, match, session)
        path = f"{API}/sessions/{session['id']}"
        result = laf.http.post(path + "/actions", headers=headers, json=body)
        assert result.status_code == 200, result.text
        stop = action_body(driver, match, session, "stop")
        stopped = laf.http.post(path + "/actions", headers=headers, json=stop)
        assert stopped.status_code == 409 and stopped.json()["code"] == "INVALID_TRANSITION", stopped.text
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
            assert laf.http.get(path + "/matches", headers=headers).json()["items"] == [result.json()["result"]["match"]]
            assert laf.http.get(API + "/snapshot", headers=headers).json()["active_session"] is None


def test_reject_rollback_and_lost_completion_preserve_receipt_and_evidence(tmp_path: Path) -> None:
    fault = "before_reject_commit"

    def checkpoint(point: str) -> None:
        if point == fault:
            raise OSError("Injected rejection result failure")

    with service(tmp_path, inference=candidate, checkpoint=checkpoint) as laf, driving_search(laf) as (headers, driver):
        match, session = review(laf, headers)
        body = action_body(driver, match, session, "reject")
        path = f"{API}/sessions/{session['id']}"
        target_path = f"{API}/objects/{match['object_id']}"
        evidence_path = f"{API}/media/{match['evidence_media']['id']}"
        target = laf.http.get(target_path, headers=headers).json()
        image = laf.http.get(evidence_path, headers=headers).content
        assert laf.http.get(evidence_path).status_code == 403
        assert search_action(laf, headers, driver, "resume", session["revision"]).json()["code"] == "PENDING_REVIEW"
        for change, code in [
            ({"expected_revision": session["revision"] - 1}, "REVISION_CONFLICT"),
            ({"candidate_id": "unknown"}, "NOT_FOUND"),
            ({"client_lease_id": "x" * 43}, "LEASE_REQUIRED"),
            ({"failure_ids": ["other"]}, "VALIDATION_FAILED"),
        ]:
            result = laf.http.post(path + "/actions", headers=headers, json={**body, **change})
            assert result.json()["code"] == code, result.text
        failed = laf.http.post(path + "/actions", headers=headers, json=body)
        assert failed.status_code == 503 and failed.json()["persistence"] == "Failed"
        assert review(laf, headers) == (match, session)
        assert laf.http.get(target_path, headers=headers).json() == target

        fault = "after_reject_commit"
        committed = laf.http.post(path + "/actions", headers=headers, json=body)
        assert committed.status_code == 200, committed.text
        validate("MutationResponse", committed.json())
        outcome = committed.json()["result"]
        saved, rejected = outcome["session"], outcome["match"]
        assert saved == {**session, "revision": session["revision"] + 1,
                         "pause_causes": [{"cause": "ReviewRejected", "failure_id": None}]}
        assert rejected == {**match, "disposition": "Rejected", "reviewed_at_ms": rejected["reviewed_at_ms"]}
        assert rejected["reviewed_at_ms"] >= match["captured_at_ms"]
        assert laf.http.get(target_path, headers=headers).json() == target
        assert laf.http.post(path + "/actions", headers=headers, json=body).content == committed.content
        repeat = {**body, "expected_revision": saved["revision"], "action_id": str(uuid4())}
        assert laf.http.post(path + "/actions", headers=headers, json=repeat).json()["code"] == "INVALID_TRANSITION"
        state = wait_for(laf.http, "/snapshot", headers, lambda value: value["readiness"]["can_resume"])
        assert state["active_session"] == saved and state["pending_candidate"] is None
        while True:
            message = driver.messages.get(timeout=3)
            operation = message["payload"].get("operation")
            if message["type"] == "session_changed" and operation and operation["action_id"] == body["action_id"]:
                if operation["persistence"] == "Committed":
                    validate("EventEnvelope", message)
                    assert operation["result"] == outcome and message["session_revision"] == saved["revision"]
                    break

    with service(tmp_path) as laf:
        headers = auth(laf.bootstrap())
        wait_for(laf.http, "/health", headers)
        assert laf.http.get(path + "/matches", headers=headers).json()["items"] == [rejected]
        assert laf.http.get(evidence_path, headers=headers).content == image
        assert laf.http.get(target_path, headers=headers).json()["revision"] == target["revision"]
        assert laf.http.get(target_path, headers=headers).json()["status"] == "Lost"
        replacement = {**body, "client_id": headers["X-App-Client-Id"], "client_lease_id": "y" * 43}
        assert laf.http.post(path + "/actions", headers=headers, json=replacement).content == committed.content


def test_reject_continuity_is_scoped_and_does_not_block_recovery(tmp_path: Path) -> None:
    presence = True
    foreign = False
    sampled = 0

    def infer(sample: InferenceSample) -> bool | CandidateObservation:
        nonlocal sampled
        result = candidate(sample)
        if not isinstance(result, CandidateObservation):
            return result
        sampled += 1
        observation = sample.capture.presence if sample.capture else None
        return replace(result, association="wallet") if observation and observation.present else True

    def continuity(capture, scope):
        return replace(capture, presence=FixturePresence(
            replace(scope, session="foreign") if foreign else scope,
            capture.stream_epoch, capture.clock_epoch, capture.sequence, "wallet", presence,
        ))

    with service(tmp_path, inference=infer) as laf:
        laf.observations.continuity = continuity
        with driving_search(laf) as (headers, driver):
            first, initial = review(laf, headers)
            laf.observations.robot = "missing"
            paused = wait_for(laf.http, "/snapshot", headers, lambda state:
                              len(state["active_session"]["pause_causes"]) > 1)["active_session"]
        laf.observations.robot = "live"
        with recover_workspace(laf, paused) as (headers, driver):
            state = wait_for(laf.http, "/snapshot", headers, lambda value: all(
                failure["restored"] for failure in value["failures"]
            ))
            paused = state["active_session"]
            reject = action_body(driver, first, paused, "reject")
            path = f"{API}/sessions/{paused['id']}"
            response = laf.http.post(path + "/actions", headers=headers, json=reject)
            assert response.status_code == 200, response.text
            saved = response.json()["result"]["session"]
            assert saved["revision"] == paused["revision"] + 1
            assert [cause for cause in saved["pause_causes"] if cause["cause"] != "ReviewRejected"] == [
                cause for cause in paused["pause_causes"] if cause["cause"] != "CandidateReview"
            ]
            assert search_action(laf, headers, driver, "resume", saved["revision"]).json()["code"] == "RECOVERY_REQUIRED"
            ack = search_action(laf, headers, driver, "acknowledge", saved["revision"],
                                failure_ids=[failure["failure_id"] for failure in state["failures"]])
            assert ack.status_code == 200, ack.text
            ready = wait_for(laf.http, "/snapshot", headers, lambda value: value["readiness"]["can_resume"])
            laf.observations.dpad = ("forward",)
            resumed = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
            assert resumed.status_code == 200, resumed.text
            wait_output(laf, None)
            before = sampled
            continuous = wait_for(laf.http, "/snapshot", headers, lambda _: sampled >= before + 5)
            assert continuous["pending_candidate"] is None and laf.command.output is None
            laf.observations.dpad = ()
            arm(laf, headers)
            stopped = search_action(laf, headers, driver, "pause", continuous["active_session"]["revision"])
            assert stopped.status_code == 200, stopped.text
            before = sampled
            foreign, presence = True, False
            sleep(0.4)
            foreign, presence = False, True
            sleep(0.3)
            assert sampled == before
            ready = wait_for(laf.http, "/snapshot", headers, lambda value: value["readiness"]["can_resume"])
            resumed = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
            assert resumed.status_code == 200, resumed.text
            current = wait_for(laf.http, "/snapshot", headers, lambda _: sampled >= before + 5)
            assert current["pending_candidate"] is None
            presence = False
            sleep(0.4)
            laf.observations.robot = "missing"
            paused = wait_for(laf.http, "/snapshot", headers, lambda value: value["active_session"]["state"] == "Paused")
            assert paused["pending_candidate"] is None
        presence = True
        laf.observations.robot = "live"
        with recover_workspace(laf, paused["active_session"]) as (headers, driver):
            state = wait_for(laf.http, "/snapshot", headers, lambda value: all(
                failure["restored"] for failure in value["failures"]
            ))
            ack = search_action(laf, headers, driver, "acknowledge", state["active_session"]["revision"],
                                failure_ids=[failure["failure_id"] for failure in state["failures"]])
            assert ack.status_code == 200, ack.text
            ready = wait_for(laf.http, "/snapshot", headers, lambda value: value["readiness"]["can_resume"])
            resumed = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
            assert resumed.status_code == 200, resumed.text
            before = sampled
            current = wait_for(laf.http, "/snapshot", headers, lambda _: sampled >= before + 5)
            assert current["active_session"]["state"] == "Searching" and current["pending_candidate"] is None
            presence = False
            sleep(0.5)
            presence = True
            second, session = review(laf, headers)
            assert second["id"] != first["id"] and second["frame_id"] != first["frame_id"]
            assert search_action(laf, headers, driver, "reject", session["revision"], candidate_id=second["id"]).status_code == 200
            assert search_action(laf, headers, driver, "stop", session["revision"] + 1).status_code == 200
        with driving_search(laf, takeover=True) as (headers, driver):
            fresh, session = review(laf, headers)
            assert fresh["session_id"] != initial["id"]
            wrong = search_action(laf, headers, driver, "reject", session["revision"], candidate_id=first["id"])
            assert wrong.status_code == 409 and wrong.json()["code"] == "OWNERSHIP_MISMATCH"
