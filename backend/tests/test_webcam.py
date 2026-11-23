from collections.abc import Iterator
from contextlib import contextmanager
from importlib import import_module
from io import BytesIO
from os import environ
from pathlib import Path
from queue import Queue
from threading import Event
from time import monotonic, sleep

import pytest
from PIL import Image

from backend.app.gestures import Hand, Pose, classify
from backend.app.motion import Direction, InputSample, InputScope
from backend.app.runtime import RecordsRuntime
from backend.app.simulation import load_simulation
from backend.app.storage import RecordsStorage
from backend.app.webcam import (
    AcquiredImage,
    ReadFrame,
    Recognition,
    Recognize,
    Webcam,
    WebcamFrame,
    encode_preview,
    open_hand_landmarker,
)
from backend.tests.test_gestures import hand
from backend.tests.test_realtime import (
    Loopback,
    arm,
    assert_stopped,
    driving_search,
    frame,
    recover_workspace,
    search_action,
    service,
    status,
    wait_for,
    wait_output,
)


class WebcamReplay:
    def __init__(self) -> None:
        self.hands: tuple[Hand, ...] = (hand(0),)
        self.capture = Event()
        self.capture.set()
        self.recognition = Event()
        self.recognition.set()
        self.preview = Event()
        self.preview.set()
        self.first_read_delay = .033
        self.label = ""
        out = BytesIO()
        Image.new("RGB", (640, 480)).save(out, "JPEG")
        self.jpeg = out.getvalue()

    @contextmanager
    def camera(self) -> Iterator[ReadFrame]:
        first = True

        def read() -> tuple[Hand, ...]:
            nonlocal first
            sleep(self.first_read_delay if first else .033)
            first = False
            if not self.capture.wait(.7):
                raise OSError("Capture disconnected")
            return self.hands

        yield read

    @contextmanager
    def recognizer(self) -> Iterator[Recognize]:
        def recognize(hands: tuple[Hand, ...]) -> Pose:
            if not self.recognition.wait(.7):
                raise OSError("Landmarker stalled")
            return classify(hands, 640, 480)

        yield recognize

    def encode(self, _image: object, label: str, _limit: int) -> bytes:
        if not self.preview.wait(.7):
            raise OSError("Preview encoding stalled")
        self.label = label
        return self.jpeg

    def pose(self, mask: int, side: str = "Left") -> None:
        self.hands = (hand(mask, side),)


@contextmanager
def replay_service(tmp_path: Path, replay: WebcamReplay) -> Iterator[Loopback]:
    def reset() -> None:
        replay.capture.set()
        replay.recognition.set()
        replay.preview.set()

    with service(tmp_path, local_gestures=True, webcam_factory=lambda p, clock: Webcam(
        p, replay.camera, replay.recognizer, replay.encode, clock,
    )) as laf:
        try:
            yield laf
        finally:
            reset()


def gesture_neutral(laf: Loopback, headers: dict[str, str], replay: WebcamReplay, side: str = "Left") -> None:
    replay.pose(0, side)
    wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming"
             and status(s, "DisplayedRobotVideo") == "Ready")
    # A motion generation change can precede a renewed proof of neutral.
    sleep(.16)


def test_protected_webcam_and_validated_holds_share_the_coordinator(tmp_path: Path) -> None:
    replay = WebcamReplay()
    replay.first_read_delay = .28  # A slow first frame must not cause a reopen loop.
    with replay_service(tmp_path, replay) as laf, driving_search(laf, "Gestures") as (headers, driver):
        directions: tuple[Direction, ...] = ("forward", "backward", "left", "right")
        for mask, direction, side in zip((1, 3, 7, 15), directions, ("Left", "Right", "Left", "Right"), strict=True):
            gesture_neutral(laf, headers, replay, side)
            replay.pose(mask, side)
            wait_output(laf, direction)
            if mask == 1:
                with laf.open("/video/webcam", laf.ticket(headers, "webcam-video")) as video:
                    header, _ = frame(video)
                    assert (header["source"], header["width"], header["height"]) == ("webcam", 640, 480)
                    # Encoding may stall even while the camera and recognizer work.
                    replay.preview.clear()
                    sleep(.82)
                    wait_output(laf, "forward")
                # Losing the preview consumer does not turn healthy recognition into a fault.
                wait_output(laf, "forward")
                replay.pose(3, side)
                changed = monotonic()
                assert_stopped(laf, "InputInvalid")
                assert monotonic() - changed < .18
                sleep(.18)
                wait_output(laf, None)
                replay.preview.set()
            else:
                replay.pose(0, side)
                wait_output(laf, None)
            snapshot = wait_for(laf.http, "/snapshot", headers)
            assert snapshot["active_session"]["id"] == driver.session["id"]
            assert snapshot["active_session"]["state"] == "Searching"
            assert status(snapshot, "Webcam") == "Ready"

        gesture_neutral(laf, headers, replay)
        replay.pose(1)
        wait_output(laf, "forward")
        replay.pose(31)
        wait_output(laf, None)
        for invalid in ((), (hand(0), hand(1)), (hand(1),)):
            replay.hands = invalid
            sleep(.18)
            wait_output(laf, None)
        assert not wait_for(laf.http, "/snapshot", headers)["failures"]


@pytest.mark.parametrize("path", ["capture", "recognition"])
def test_required_webcam_loss_pauses_and_held_pose_needs_new_neutral(tmp_path: Path, path: str) -> None:
    replay = WebcamReplay()
    with replay_service(tmp_path, replay) as laf, driving_search(laf, "Gestures") as (headers, _):
        gesture_neutral(laf, headers, replay)
        replay.pose(1)
        wait_output(laf, "forward")
        lost = getattr(replay, path)
        lost.clear()
        assert_stopped(laf, "InputInvalid" if path == "recognition" else "InputUnavailable")
        paused = wait_for(laf.http, "/snapshot", headers,
                          lambda s: s["active_session"]["state"] == "Paused" and bool(s["failures"]))
        assert status(paused, "Webcam") == "Unavailable"
        [failure] = paused["failures"]
        assert failure["cause"] == "InputUnavailable" and not failure["restored"]
        if path == "recognition":
            # A healthy capture still supplies a protected preview during loss of recognition.
            with laf.open("/video/webcam", laf.ticket(headers, "webcam-video")) as video:
                assert frame(video)[0]["source"] == "webcam"
        with recover_workspace(laf, paused["active_session"]) as (owner, driver):
            lost.set()
            restored = wait_for(laf.http, "/snapshot", owner, lambda s: s["failures"][0]["restored"])
            assert not restored["readiness"]["can_resume"]
            ack = search_action(laf, owner, driver, "acknowledge", restored["active_session"]["revision"],
                                failure_ids=[failure["failure_id"]])
            assert ack.status_code == 200, ack.text
            ready = wait_for(laf.http, "/snapshot", owner, lambda s: s["readiness"]["can_resume"])
            resume = search_action(laf, owner, driver, "resume", ready["active_session"]["revision"])
            assert resume.status_code == 200, resume.text
            sleep(.35)
            wait_output(laf, None)
            gesture_neutral(laf, owner, replay)
            replay.pose(2)
            wait_output(laf, "forward")


def test_missing_selected_camera_blocks_gestures_and_leaves_controller_ready(tmp_path: Path) -> None:
    with service(tmp_path, local_gestures=True) as laf, driving_search(laf) as (headers, _):
        assert status(wait_for(laf.http, "/snapshot", headers), "Webcam") == "Unavailable"
        arm(laf, headers)


def test_realtime_reads_an_admitted_webcam_result_before_the_input_poll(tmp_path: Path) -> None:
    composition = load_simulation("local-gestures-v1")
    assert composition
    now = 1.0

    def clock() -> float:
        return now

    runtime = RecordsRuntime(RecordsStorage(tmp_path, monotonic=clock))
    router = runtime.enable_realtime(composition, "NOT_READY", lambda *_: None, lambda _: None)
    replay = WebcamReplay()
    adapter = Webcam(composition.profile, replay.camera, replay.recognizer, replay.encode, clock)
    router.webcam = adapter
    scope = InputScope(runtime.boot_id, "session", 1)
    frame = WebcamFrame("current", 2, 0.9, scope, replay.hands)
    adapter._frame = frame
    adapter._last_recognized = frame.epoch, frame.at
    adapter._result = Recognition(frame, "forward", "1 finger - forward")
    interruption = InputSample(scope, 0.82, "invalid")
    adapter._interruption = interruption
    router._input_deadlines["Webcam"] = 0.99
    router._readiness["Webcam"] = True

    assert router.component_cause("Webcam") is None
    assert router._input_deadlines["Webcam"] == 0.99
    assert adapter.observe(scope).input == interruption

    adapter._frame = WebcamFrame("reopened", 1, 0.95, scope, replay.hands)
    assert router.component_cause("Webcam") == "NOT_READY"
    adapter._frame = frame
    now = 1.2
    assert router.component_cause("Webcam") == "NOT_READY"


def test_overlapped_recognition_proves_health_without_authorizing_motion() -> None:
    composition = load_simulation("local-gestures-v1")
    assert composition
    captures: Queue[str] = Queue()
    acquiring, old_started, old_finish, newer_published, newer_started, newer_finish = (Event() for _ in range(6))

    @contextmanager
    def camera() -> Iterator[ReadFrame]:
        def read() -> str:
            acquiring.set()
            return captures.get(timeout=.5)

        yield read

    @contextmanager
    def recognizer() -> Iterator[Recognize]:
        def recognize(sample: str) -> Pose:
            started, finish = (old_started, old_finish) if sample == "old" else (newer_started, newer_finish)
            started.set()
            assert finish.wait(1)
            return classify((hand(1),), 640, 480)

        yield recognize

    def preview(sample: str, _label: str, _limit: int) -> bytes:
        if sample == "new":
            newer_published.set()
        return b"preview"

    now = 1.0
    scope = InputScope("boot", "session", 1)
    adapter = Webcam(composition.profile, camera, recognizer, preview, lambda: now)
    adapter.observe(scope)
    adapter.start()
    try:
        assert acquiring.wait(1)
        now = 1.1
        captures.put("old")
        assert old_started.wait(1)
        captures.put("new")
        assert newer_published.wait(1)
        old_finish.set()
        assert newer_started.wait(1)
        observation = adapter.observe(scope)
        assert observation.recognition_at == 1.0
        assert observation.input is None
        assert adapter.recognition_ready()
        now = 1.25
        assert not adapter.recognition_ready()
        assert adapter.observe(scope).recognition_at is None
    finally:
        old_finish.set()
        newer_finish.set()
        captures.put("stop")
        adapter.close()


def test_recorded_capture_uses_its_known_acquisition_time() -> None:
    composition = load_simulation("local-gestures-v1")
    assert composition
    replay = WebcamReplay()
    acquiring = Event()
    samples: Queue[AcquiredImage] = Queue()
    now = 1.0

    @contextmanager
    def camera() -> Iterator[ReadFrame]:
        def read() -> AcquiredImage:
            acquiring.set()
            return samples.get(timeout=0.5)

        yield read

    adapter = Webcam(composition.profile, camera, replay.recognizer, replay.encode, lambda: now)
    adapter.start()
    try:
        assert acquiring.wait(1)
        now = 1.3  # Delivery was paced for longer than the sample deadline.
        samples.put(AcquiredImage(now, replay.hands))
        deadline = monotonic() + 1
        while not adapter.recognition_ready() and monotonic() < deadline:
            sleep(0.005)
        assert adapter.observe(None).recognition_at == 1.3
        now = 1.55
        assert not adapter.recognition_ready()
    finally:
        samples.put(AcquiredImage(now, replay.hands))
        adapter.close()


def test_intervening_invalid_pose_survives_latest_result_replacement() -> None:
    composition = load_simulation("local-gestures-v1")
    assert composition
    replay = WebcamReplay()
    scope = InputScope("boot", "session", 1)
    adapter = Webcam(composition.profile, replay.camera, replay.recognizer, replay.encode)

    def wait_label(label: str) -> None:
        deadline = monotonic() + 2
        while replay.label != label and monotonic() < deadline:
            sleep(.005)
        assert replay.label == label

    adapter.observe(scope)
    replay.pose(1)
    adapter.start()
    try:
        wait_label("1 finger - forward")
        adapter.observe(scope)
        assert adapter.observe(scope).input.intent == "forward"
        replay.hands = ()
        wait_label("No hand detected")
        replay.pose(1)
        wait_label("1 finger - forward")
        assert adapter.observe(scope).input.intent == "invalid"
        assert adapter.observe(scope).input.intent == "forward"
        new_scope = InputScope("boot", "session", 2)
        handoff = adapter.observe(new_scope)
        assert handoff.recognition_at is not None and handoff.input is None
    finally:
        adapter.close()


def test_pinned_landmarker_and_preview_on_recorded_images(monkeypatch: pytest.MonkeyPatch) -> None:
    directory = environ.get("LAF_TEST_GESTURE_ASSETS")
    if not directory:
        pytest.skip("Set LAF_TEST_GESTURE_ASSETS to the pinned offline assets directory.")
    assets = Path(directory)
    cv = import_module("cv2")
    np = import_module("numpy")

    def no_network(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("The pinned local Hand Landmarker must work without network access.")

    monkeypatch.setattr("socket.create_connection", no_network)
    monkeypatch.setattr("socket.getaddrinfo", no_network)
    recorded = cv.imread(str(assets / "right_hands.jpg"))
    assert recorded.shape == (382, 720, 3)
    with open_hand_landmarker(assets) as recognize:
        assert recognize(recorded).label == "Multiple hands detected"
        sample = recorded[:, :360]
        assert (recognize(sample).side, recognize(sample).count) == ("Right", 5)
        other = recognize(cv.flip(sample, 1))
        assert (other.side, other.count) == ("Left", 5)
        assert recognize(np.zeros((480, 640, 3), dtype=np.uint8)).label == "No hand detected"

    raw = np.zeros((480, 640, 3), dtype=np.uint8)
    raw[:, :320] = [255, 80, 0]
    copy = raw.copy()
    preview = Image.open(BytesIO(encode_preview(raw, "5 fingers - unsupported", 125_000)))
    assert preview.size == (640, 480)
    assert preview.getpixel((540, 100))[2] > 230 and preview.getpixel((100, 100))[2] < 15
    assert np.array_equal(raw, copy)
