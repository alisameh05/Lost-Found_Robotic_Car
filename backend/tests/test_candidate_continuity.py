"""Replay identified robot frames through the local matcher and protected review flow."""

import json
from collections import deque
from dataclasses import replace
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from queue import Empty
from random import Random
from threading import Event
from time import monotonic, sleep

from PIL import Image, ImageDraw, ImageEnhance

from backend.tests.test_candidate_review import review
from backend.tests.test_local_matching import await_file
from backend.tests.test_local_matching import matcher_fixture as matcher_fixture
from backend.tests.test_realtime import (
    API,
    Loopback,
    WorkspaceDriver,
    arm,
    driving_search,
    recover_workspace,
    search_action,
    service,
    wait_for,
    wait_output,
)
from backend.tests.vision_stub import publish

WIDTH, HEIGHT = 480, 262
BOX_WIDTH, BOX_HEIGHT, TOP = 96, 72, 84
INTERIOR, BORDER = 336, WIDTH - BOX_WIDTH


def pattern(seed: int) -> Image.Image:
    values = Random(seed)
    block = Image.new("L", (12, 9))
    block.putdata([values.choice((35, 85, 170, 230)) for _ in range(108)])
    return block.resize((BOX_WIDTH, BOX_HEIGHT), Image.Resampling.NEAREST)


@lru_cache(maxsize=32)
def scene(*positions: int, similar: int | None = None, occluded: bool = False, faint: bool = False,
          row: int = TOP, shadow: bool = False) -> bytes:
    image = Image.new("L", (WIDTH, HEIGHT), 123)
    if shadow:
        image.paste(ImageEnhance.Brightness(pattern(17)).enhance(0.5), (INTERIOR, TOP))
    for x in positions:
        patch = pattern(17)
        if faint:
            patch = Image.blend(patch, Image.new("L", patch.size, 123), 0.55)
        image.paste(patch, (x, row))
    if similar is not None:
        image.paste(pattern(21), (similar, TOP))
    if occluded:
        ImageDraw.Draw(image).rectangle((420, TOP - 6, WIDTH, TOP + BOX_HEIGHT + 6), fill=216)
    stream = BytesIO()
    image.convert("RGB").save(stream, "JPEG", quality=95)
    return stream.getvalue()


def show(laf: Loopback, headers: dict, driver: WorkspaceDriver, jpeg: bytes) -> dict:
    sequence = driver.latest["capture_seq"] if driver.latest else 0
    laf.observations.robot_jpeg = jpeg
    wait_for_display(driver, sequence + 3)
    return wait_for(laf.http, "/snapshot", headers)


def wait_for_display(driver: WorkspaceDriver, sequence: int) -> None:
    deadline = monotonic() + 5
    while monotonic() < deadline:
        latest = driver.latest
        if latest is not None and latest["capture_seq"] >= sequence:
            return
        sleep(0.025)
    raise AssertionError(f"Robot preview did not reach acquisition {sequence}")


def replay(laf: Loopback, headers: dict, driver: WorkspaceDriver, images: list[bytes]) -> dict:
    """Feed ordered JPEGs at acquisition cadence independently of HTTP polling."""
    pending = deque(images)
    finished = Event()
    final_sequence = 0
    source_adapter = laf.observations.continuity

    def feed(capture, scope):
        nonlocal final_sequence
        if source_adapter:
            capture = source_adapter(capture, scope)
        if not pending:
            return capture
        jpeg = pending.popleft()
        if not pending:
            laf.observations.robot_jpeg = jpeg
            final_sequence = capture.sequence
            finished.set()
        return replace(capture, jpeg=jpeg)

    laf.observations.continuity = feed
    try:
        assert finished.wait(5), "Robot source did not finish the replay"
        wait_for_display(driver, final_sequence + 2)
        return wait_for(laf.http, "/snapshot", headers)
    finally:
        laf.observations.continuity = source_adapter


def match_at(worker: Path, x: int) -> None:
    publish(worker / "candidate.json", json.dumps([x, TOP, x + BOX_WIDTH, TOP + BOX_HEIGHT]))


def alerts(driver: WorkspaceDriver) -> list[str]:
    result = []
    while True:
        try:
            message = driver.messages.get_nowait()
        except Empty:
            return result
        if message["type"] == "candidate_pending":
            result.append(message["payload"]["match"]["id"])


def next_alert(driver: WorkspaceDriver) -> str:
    while True:
        message = driver.messages.get(timeout=5)
        if message["type"] == "candidate_pending":
            return message["payload"]["match"]["id"]


def resume(laf: Loopback, headers: dict, driver: WorkspaceDriver) -> dict:
    ready = wait_for(laf.http, "/snapshot", headers, lambda state: state["readiness"]["can_resume"])
    resumed = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
    assert resumed.status_code in (200, 202), resumed.text
    return wait_for(laf.http, "/snapshot", headers, lambda state: state["active_session"]["state"] == "Searching")


def wait_failure(laf: Loopback, headers: dict, cause: str) -> dict:
    return wait_for(laf.http, "/snapshot", headers, lambda state: (
        state["active_session"]["state"] == "Paused"
        and any(item["cause"] == "RecoveryRequired" for item in state["active_session"]["pause_causes"])
        and any(failure["cause"] == cause for failure in state["failures"])
    ))


def acknowledge(laf: Loopback, headers: dict, driver: WorkspaceDriver) -> None:
    state = wait_for(laf.http, "/snapshot", headers, lambda state: (
        state["failures"] and all(failure["restored"] for failure in state["failures"])
    ))
    session = state["active_session"]
    blocked = search_action(laf, headers, driver, "resume", session["revision"])
    assert blocked.status_code == 409 and blocked.json()["code"] == "RECOVERY_REQUIRED"
    saved = search_action(laf, headers, driver, "acknowledge", session["revision"],
                          failure_ids=[failure["failure_id"] for failure in state["failures"]])
    assert saved.status_code in (200, 202), saved.text


def test_verified_exit_and_reentry_while_paused_allow_a_fresh_review(
    tmp_path: Path, spawned_matcher: Path,
) -> None:
    with service(tmp_path, local_vision=True) as laf:
        laf.observations.robot_jpeg = scene(INTERIOR)
        with driving_search(laf) as (headers, driver):
            match_at(spawned_matcher, INTERIOR)
            first, paused = review(laf, headers)
            assert first["box"] == {"x": INTERIOR, "y": TOP, "width": BOX_WIDTH, "height": BOX_HEIGHT}
            rejected = search_action(laf, headers, driver, "reject", paused["revision"], candidate_id=first["id"])
            assert rejected.status_code == 200, rejected.text
            history_path = f"/sessions/{paused['id']}/matches"
            history = wait_for(laf.http, history_path, headers)["items"]
            assert len(history) == 1 and history[0]["disposition"] == "Rejected" and history[0]["reviewed_at_ms"]
            assert next_alert(driver) == first["id"]
            assert laf.http.get(f"{API}/objects/{paused['object_id']}", headers=headers).json()["status"] == "Lost"

            show(laf, headers, driver, scene(INTERIOR))
            last_match_work = (spawned_matcher / "matched.json").read_bytes()
            state = replay(laf, headers, driver, [scene(x) for x in (BORDER, 408, 432, 456)] + [scene()])
            assert state["pending_candidate"] is None and state["readiness"]["can_resume"]
            assert state["runtime"]["motion_permission"] == "Disarmed"
            assert alerts(driver) == []
            assert (spawned_matcher / "matched.json").read_bytes() == last_match_work

            state = replay(laf, headers, driver, [scene(x) for x in (456, 432, 408, BORDER)])
            assert state["pending_candidate"] is None and state["active_session"]["state"] == "Paused"
            match_at(spawned_matcher, BORDER)
            resumed = search_action(laf, headers, driver, "resume", state["active_session"]["revision"])
            assert resumed.status_code in (200, 202), resumed.text
            second, _ = review(laf, headers)
            assert second["id"] != first["id"] and second["frame_id"] != first["frame_id"]
            assert next_alert(driver) == second["id"]
            assert {entry["disposition"] for entry in wait_for(laf.http, history_path, headers)["items"]} == {
                "Rejected", "Pending",
            }


def test_continuous_and_uncertain_presence_stay_suppressed_through_resume(
    tmp_path: Path, spawned_matcher: Path,
) -> None:
    with service(tmp_path, local_vision=True) as laf:
        laf.observations.robot_jpeg = scene(INTERIOR)
        with driving_search(laf) as (headers, driver):
            match_at(spawned_matcher, INTERIOR)
            first, paused = review(laf, headers)
            assert next_alert(driver) == first["id"]
            rejected = search_action(laf, headers, driver, "reject", paused["revision"], candidate_id=first["id"])
            assert rejected.status_code == 200, rejected.text
            laf.observations.dpad = ("forward",)
            resume(laf, headers, driver)
            show(laf, headers, driver, scene(INTERIOR))
            wait_output(laf, None)
            laf.observations.dpad = ()
            arm(laf, headers)

            def show_without_review(jpeg: bytes) -> dict:
                current = show(laf, headers, driver, jpeg)
                assert current["active_session"]["state"] == "Searching"
                assert current["pending_candidate"] is None
                return current

            for interruption in (
                scene(), scene(BORDER, faint=True), scene(BORDER, 220),
                scene(similar=408), scene(occluded=True),
            ):
                for jpeg in (scene(INTERIOR, similar=224), scene(BORDER), scene(408), interruption,
                             scene(456), scene(), scene(456), scene(432), scene(408), scene(BORDER)):
                    show_without_review(jpeg)

            # An uncorroborated lookalike moving along a different border segment is
            # unable to establish the rejected target's exit and return.
            for positions in ((INTERIOR,), (BORDER,), (408,), (432,), (456,), (), (456,), (432,), (408,), (BORDER,)):
                show_without_review(scene(*positions, row=165))

            # The bright copy can overlap the still-visible original in shadow.
            show_without_review(scene(INTERIOR))
            for positions in ((INTERIOR,), (BORDER,), (408,), (432,), (456,), (), (456,), (432,), (408,), (BORDER,)):
                show_without_review(scene(*positions, row=114, shadow=True))

            # A missing acquisition between the departure and empty border cannot complete an exit.
            for x in (INTERIOR, BORDER, 408, 432, 456):
                show_without_review(scene(x))
            latest = laf.observations.latest
            assert latest is not None
            duplicate_seen = False

            def duplicate_then_gap(capture, _scope):
                nonlocal duplicate_seen
                if not duplicate_seen:
                    duplicate_seen = True
                    return latest
                return capture

            laf.observations.continuity = duplicate_then_gap
            show_without_review(scene())
            laf.observations.continuity = None
            for x in (456, 432, 408, BORDER):
                current = show_without_review(scene(x))
            assert duplicate_seen and alerts(driver) == []
            assert wait_for(laf.http, f"/sessions/{paused['id']}/matches", headers)["items"][0]["id"] == first["id"]
            stopped = search_action(laf, headers, driver, "stop", current["active_session"]["revision"])
            assert stopped.status_code in (200, 202), stopped.text
            wait_for(laf.http, "/snapshot", headers, lambda state: state["active_session"] is None)
            target = wait_for(laf.http, f"/objects/{paused['object_id']}", headers)
        with driving_search(laf, takeover=True, target=target) as (headers, driver):
            fresh, _ = review(laf, headers)
            assert fresh["session_id"] != paused["id"] and driver.session["object_id"] == paused["object_id"]
            assert next_alert(driver) == fresh["id"]


def test_source_and_worker_resets_keep_rejection_and_require_deliberate_recovery(
    tmp_path: Path, spawned_matcher: Path,
) -> None:
    with service(tmp_path, local_vision=True) as laf:
        laf.observations.robot_jpeg = scene(INTERIOR)
        with driving_search(laf) as (headers, driver):
            match_at(spawned_matcher, INTERIOR)
            first, paused = review(laf, headers)
            assert next_alert(driver) == first["id"]
            laf.observations.continuity = lambda capture, _: replace(
                capture, stream_epoch="camera-reset", clock_epoch="source-clock-reset",
            )
            camera_pause = wait_failure(laf, headers, "CameraEpochChanged")["active_session"]

        with recover_workspace(laf, camera_pause) as (headers, driver):
            camera_pause = wait_for(laf.http, "/snapshot", headers, lambda state: (
                state["failures"] and all(failure["restored"] for failure in state["failures"])
            ))["active_session"]
            rejected = search_action(laf, headers, driver, "reject", camera_pause["revision"],
                                     candidate_id=first["id"])
            assert rejected.status_code == 200, rejected.text
            causes = rejected.json()["result"]["session"]["pause_causes"]
            assert any(entry["cause"] == "ReviewRejected" for entry in causes)
            assert [entry for entry in causes if entry["cause"] != "ReviewRejected"] == [
                entry for entry in camera_pause["pause_causes"] if entry["cause"] != "CandidateReview"
            ]
            acknowledge(laf, headers, driver)
            resume(laf, headers, driver)
            for x in (INTERIOR, BORDER, 408, 432, 456):
                show(laf, headers, driver, scene(x))
            publish(spawned_matcher / "request", "exit")
            await_file(spawned_matcher / "frame.json")
            worker_pause = wait_failure(laf, headers, "AIUnavailable")["active_session"]
            laf.observations.robot_jpeg = scene()

        with recover_workspace(laf, worker_pause) as (headers, driver):
            acknowledge(laf, headers, driver)
            resume(laf, headers, driver)
            for x in (456, 432, 408, BORDER):
                state = show(laf, headers, driver, scene(x))
                assert state["pending_candidate"] is None and state["active_session"]["state"] == "Searching"
            assert alerts(driver) == []
            assert [entry["id"] for entry in wait_for(laf.http, f"/sessions/{paused['id']}/matches",
                                                     headers)["items"]] == [first["id"]]
            # A complete new witness after recovery can still make the candidate eligible.
            match_at(spawned_matcher, BORDER)
            exited = replay(laf, headers, driver, [
                scene(x) for x in (INTERIOR, BORDER, 408, 432, 456)
            ] + [scene()])
            assert exited["pending_candidate"] is None and exited["active_session"]["state"] == "Searching"
            replay(laf, headers, driver, [scene(x) for x in (456, 432, 408, BORDER)])
            second, _ = review(laf, headers)
            assert second["id"] != first["id"] and next_alert(driver) == second["id"]
