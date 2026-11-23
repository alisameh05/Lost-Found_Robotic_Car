"""Local webcam capture, recognition and protected preview for the T4 profile."""

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from hashlib import sha256
from importlib import import_module
from importlib.metadata import version
from pathlib import Path
from threading import Condition, Event, Thread
from time import monotonic
from typing import Any
from uuid import uuid4

from .gestures import Hand, Point, Pose, StableGesture, classify
from .motion import InputSample, InputScope, Intent
from .simulation import Capture, QualificationProfile

WIDTH, HEIGHT, FPS = 640, 480, 30
POLL_SECONDS = 0.015
RETRY_SECONDS = 0.5
TASK_SIZE = 7819105
TASK_SHA256 = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
VERSIONS = {"mediapipe": "0.10.32", "opencv-contrib-python": "4.11.0.86", "numpy": "1.26.4"}
CAMERA_ENUM_VERSION = "1.4.0"


@dataclass(frozen=True)
class AcquiredImage:
    at: float
    bgr: Any


@dataclass(frozen=True)
class WebcamFrame:
    epoch: str
    sequence: int
    at: float
    scope: InputScope | None
    bgr: Any


@dataclass(frozen=True)
class Recognition:
    frame: WebcamFrame
    intent: Intent
    label: str


@dataclass(frozen=True)
class WebcamObservation:
    preview: Capture | None
    recognition_at: float | None
    input: InputSample | None


ReadFrame = Callable[[], Any]
Recognize = Callable[[Any], Pose]
Encode = Callable[[Any, str, int], bytes]


class Webcam:
    def __init__(
        self, profile: QualificationProfile,
        open_camera: Callable[[], AbstractContextManager[ReadFrame]],
        open_recognizer: Callable[[], AbstractContextManager[Recognize]],
        encode: Encode,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self._camera, self._recognizer, self._encode = open_camera, open_recognizer, encode
        self._clock = clock
        self._deadline = profile.bound("input_sample_deadline_ms") / 1000
        self._bytes = profile.bound("max_frame_bytes") - profile.bound("max_header_bytes") - 4
        self._changed = Condition()
        self._stop = Event()
        self._scope: InputScope | None = None
        self._frame: WebcamFrame | None = None
        self._result: Recognition | None = None
        self._last_recognized: tuple[str, float] | None = None
        self._interruption: InputSample | None = None
        self._preview: Capture | None = None
        self._threads = [
            Thread(target=target, name=f"webcam-{target.__name__[1:]}", daemon=True)
            for target in (self._capture, self._recognize, self._render)
        ]

    def start(self) -> None:
        for thread in self._threads:
            thread.start()

    def close(self) -> None:
        with self._changed:
            self._stop.set()
            self._changed.notify_all()
        for thread in self._threads:
            thread.join(timeout=0.2)

    def recognition_ready(self) -> bool:
        with self._changed:
            frame, now = self._frame, self._clock()
            return (frame is not None and 0 <= now - frame.at < self._deadline
                    and self._recognition_at(frame, now) is not None)

    def _recognition_at(self, frame: WebcamFrame, now: float) -> float | None:
        recognized = self._last_recognized
        if recognized is None:
            return None
        epoch, at = recognized
        return at if epoch == frame.epoch and 0 <= now - at < self._deadline else None

    def _recent_recognition(self, frame: WebcamFrame, now: float) -> Recognition | None:
        result = self._result
        if (result is not None and result.frame.epoch == frame.epoch
                and 0 <= now - result.frame.at < self._deadline):
            return result
        return None

    def observe(self, scope: InputScope | None) -> WebcamObservation:
        with self._changed:
            self._scope = scope
            now = self._clock()
            frame, preview = self._frame, self._preview
            interruption, self._interruption = self._interruption, None
            if frame is None or not 0 <= now - frame.at < self._deadline:
                return WebcamObservation(None, None, None)
            if preview is not None and preview.stream_epoch != frame.epoch:
                preview = None
            recognition_at = self._recognition_at(frame, now)
            result = self._recent_recognition(frame, now)
            if result is None:
                return WebcamObservation(preview, recognition_at, None)
            at = result.frame.at
            sample = None
            if scope and result.frame.scope == scope:
                if frame.sequence > result.frame.sequence + 1:
                    # Capture advanced beyond the in-flight frame. Clear the
                    # old hold immediately without extending recognition health.
                    sample = InputSample(scope, frame.at, "invalid") if frame.scope == scope else None
                elif interruption and interruption.scope == scope and interruption.at < at:
                    # Consume an intervening stop before any newer hold can renew.
                    sample = interruption
                else:
                    sample = InputSample(scope, at, result.intent)
            # Device health has its own capture clock. A fresh result across
            # scope rotation can prove progress, but has no motion authority.
            return WebcamObservation(preview, recognition_at, sample)

    def _capture(self) -> None:
        while not self._stop.is_set():
            try:
                with self._camera() as read:
                    epoch = uuid4().hex
                    sequence = 0
                    while not self._stop.is_set():
                        with self._changed:
                            at, scope = self._clock(), self._scope
                        image = read()
                        received_at = self._clock()
                        if isinstance(image, AcquiredImage):
                            if not at <= image.at <= received_at:
                                raise OSError("Webcam acquisition time is outside its read interval.")
                            at, image = image.at, image.bgr
                        if received_at - at >= self._deadline:
                            # Opening a DirectShow device can delay its first
                            # frame. Discard it without repeatedly reopening.
                            self._clear_capture()
                            epoch, sequence = uuid4().hex, 0
                            continue
                        sequence += 1
                        with self._changed:
                            self._frame = WebcamFrame(epoch, sequence, at, scope, image)
                            self._changed.notify_all()
            except Exception:
                self._clear_capture()
                self._stop.wait(RETRY_SECONDS)

    def _clear_capture(self) -> None:
        with self._changed:
            self._frame = None
            self._result = None
            self._last_recognized = None
            self._interruption = None
            self._preview = None
            self._changed.notify_all()

    def _recognize(self) -> None:
        previous: WebcamFrame | None = None
        while not self._stop.is_set():
            stable = StableGesture()
            try:
                with self._recognizer() as recognize:
                    while not self._stop.is_set():
                        with self._changed:
                            self._changed.wait_for(lambda: self._stop.is_set() or (
                                self._frame is not None and self._frame is not previous))
                            frame = self._frame
                        if frame is None or self._stop.is_set():
                            break
                        if previous is None or (frame.epoch, frame.scope) != (previous.epoch, previous.scope):
                            stable = StableGesture()
                        previous = frame
                        pose = recognize(frame.bgr)
                        with self._changed:
                            latest = self._frame
                            if (latest is None or latest.epoch != frame.epoch
                                    or not 0 <= self._clock() - frame.at < self._deadline):
                                continue
                            # A timely result from this epoch proves recognition is working.
                            # A superseded frame cannot drive gesture stabilization or motion.
                            self._last_recognized = frame.epoch, frame.at
                            if latest is not frame:
                                continue
                            if frame.scope == self._scope:
                                intent, label = stable.accept(pose, frame.at, frame.sequence)
                            else:
                                intent, label = "invalid", "Waiting for a fresh hand sample"
                            self._result = Recognition(frame, intent, label)
                            if frame.scope and intent in ("invalid", "neutral"):
                                self._interruption = InputSample(frame.scope, frame.at, "invalid")
                            self._changed.notify_all()
            except Exception:
                with self._changed:
                    self._result = None
                    self._last_recognized = None
                    self._interruption = None
                    self._changed.notify_all()
                self._stop.wait(RETRY_SECONDS)

    def _render(self) -> None:
        previous: WebcamFrame | None = None
        while not self._stop.is_set():
            with self._changed:
                latest, result = self._frame, self._result
                if latest is None or self._clock() - latest.at >= self._deadline:
                    self._changed.wait(POLL_SECONDS)
                    continue
                frame, label = latest, "Gesture recognition unavailable"
                if (result is not None and result.frame.epoch == latest.epoch
                        and latest.sequence <= result.frame.sequence + 1
                        and self._clock() - result.frame.at < self._deadline):
                    frame, label = result.frame, result.label
                if previous and frame.epoch == previous.epoch and frame.sequence <= previous.sequence:
                    self._changed.wait(POLL_SECONDS)
                    continue
            previous = frame
            try:
                jpeg = self._encode(frame.bgr, label, self._bytes)
            except Exception:
                continue
            with self._changed:
                latest = self._frame
                if latest is not None and latest.epoch == frame.epoch and 0 < len(jpeg) <= self._bytes:
                    self._preview = Capture(frame.epoch, frame.epoch, frame.sequence, int(frame.at * 1_000_000),
                                            frame.at, 0, WIDTH, HEIGHT, jpeg)


def directshow_devices() -> list[tuple[int, str, str]]:
    if version("cv2-enumerate-cameras") != CAMERA_ENUM_VERSION:
        raise OSError("The pinned camera enumerator is required.")
    cv = import_module("cv2")
    enumerate_cameras = import_module("cv2_enumerate_cameras").enumerate_cameras
    return [(device.index, device.name, device.path) for device in enumerate_cameras(cv.CAP_DSHOW)]


@contextmanager
def open_windows_camera(device_path: str | None) -> Iterator[ReadFrame]:
    if not device_path or version("opencv-contrib-python") != VERSIONS["opencv-contrib-python"]:
        raise OSError("Select the verified DirectShow camera and install the pinned runtime.")
    cv = import_module("cv2")
    matching = [(index, path) for index, _, path in directshow_devices()
                if path and path.casefold() == device_path.casefold()]
    if len(matching) != 1 or cv.__version__ != "4.11.0":
        raise OSError("The selected camera or OpenCV provider is unavailable.")
    index, path = matching[0]
    camera = cv.VideoCapture(index, cv.CAP_DSHOW)
    try:
        if not camera.isOpened() or camera.getBackendName() != "DSHOW":
            raise OSError("Could not open the selected DirectShow camera.")
        camera.set(cv.CAP_PROP_FRAME_WIDTH, WIDTH)
        camera.set(cv.CAP_PROP_FRAME_HEIGHT, HEIGHT)
        camera.set(cv.CAP_PROP_FPS, FPS)
        if not any(i == index and candidate == path for i, _, candidate in directshow_devices()):
            raise OSError("The camera selection changed during capture startup.")

        def read() -> Any:
            ok, bgr = camera.read()
            if not ok or bgr.shape != (HEIGHT, WIDTH, 3) or bgr.dtype.name != "uint8":
                raise OSError("The selected camera stopped providing 640 x 480 BGR frames.")
            return bgr

        yield read
    finally:
        camera.release()


def _points(landmarks: Any) -> tuple[Point, ...]:
    if any(score is not None and not 0.50 <= score <= 1.0
           for point in landmarks for score in (point.presence, point.visibility)):
        return ()
    return tuple((point.x, point.y, point.z) for point in landmarks)


@contextmanager
def open_hand_landmarker(assets: Path | None) -> Iterator[Recognize]:
    if assets is None or any(version(name) != pinned for name, pinned in VERSIONS.items()):
        raise OSError("Install the pinned gesture runtime and Hand Landmarker asset.")
    with (assets / "hand_landmarker.task").open("rb") as stream:
        model = stream.read(TASK_SIZE + 1)
    if len(model) != TASK_SIZE or sha256(model).hexdigest() != TASK_SHA256:
        raise OSError("The Hand Landmarker asset failed validation.")
    mp = import_module("mediapipe")
    cv = import_module("cv2")
    vision = mp.tasks.vision
    options = vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_buffer=model),
        running_mode=vision.RunningMode.IMAGE, num_hands=2,
        min_hand_detection_confidence=0.50, min_hand_presence_confidence=0.50,
    )
    with vision.HandLandmarker.create_from_options(options) as task:
        def recognize(bgr: Any) -> Pose:
            height, width = bgr.shape[:2]
            rgb = cv.cvtColor(bgr, cv.COLOR_BGR2RGB)
            result = task.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
            size = len(result.handedness)
            if size != len(result.hand_landmarks) or any(len(entry) != 1 for entry in result.handedness):
                return Pose("Unclear hand pose")
            hands = tuple(Hand(category[0].category_name, category[0].score, _points(image))
                          for category, image in zip(result.handedness, result.hand_landmarks, strict=True))
            return classify(hands, width, height)

        yield recognize


def encode_preview(bgr: Any, label: str, limit: int) -> bytes:
    cv = import_module("cv2")
    # The raw array is shared read-only with recognition. Draw only on the mirrored copy.
    preview = cv.flip(bgr, 1)
    cv.rectangle(preview, (0, HEIGHT - 40), (WIDTH, HEIGHT), (23, 27, 31), -1)
    cv.putText(preview, label, (14, HEIGHT - 14), cv.FONT_HERSHEY_SIMPLEX, 0.58, (243, 243, 240), 1, cv.LINE_AA)
    for quality in (65, 40):
        ok, jpeg = cv.imencode(".jpg", preview, [cv.IMWRITE_JPEG_QUALITY, quality])
        if ok and jpeg.nbytes <= limit:
            return bytes(jpeg)
    raise ValueError("The preview exceeded its frame bound.")
