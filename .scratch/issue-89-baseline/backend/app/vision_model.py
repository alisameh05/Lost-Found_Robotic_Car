"""Pinned YOLOE visual prompting. Loaded only by the isolated child."""

import hashlib
import math
import os
import sys
from importlib import import_module
from importlib.metadata import PackageNotFoundError, version
from io import BytesIO
from pathlib import Path
from typing import Protocol, cast

from PIL import Image

from .vision_worker import Box, WorkerFault

CHECKPOINT = "yoloe-26s-seg.pt"
CHECKPOINT_BYTES = 31_072_171
CHECKPOINT_SHA256 = "48f24206bc8680d60cbbfa296b0140da849669b9515058b72f5a945142df0654"
PINS = {
    "ultralytics": "8.4.23", "torch": "2.6.0+cu124", "torchvision": "0.21.0+cu124",
    "numpy": "1.26.4", "opencv-python": "4.11.0.86", "opencv-contrib-python": "4.11.0.86",
    "pillow": "12.1.1",
}
DEVICE = "cuda:0"
IMAGE_SIZE = 640
CONFIDENCE = 0.25


class Detections(Protocol):
    orig_shape: tuple[int, int]

    @property
    def boxes(self) -> "PredictionBoxes": ...


class PredictionBoxes(Protocol):
    @property
    def data(self) -> "PredictionTensor": ...


class PredictionTensor(Protocol):
    def cpu(self) -> "PredictionTensor": ...
    def tolist(self) -> list[list[float]]: ...


class VisualPredictor(Protocol):
    def predict(self, **options: object) -> list[Detections]: ...


def load_pixels(header: dict[str, object], data: bytes, format_name: str, *, reference: bool = False) -> Image.Image:
    with Image.open(BytesIO(data), formats=[format_name]) as image:
        if image.size != (header["width"], header["height"]) or (reference and image.getexif().get(274, 1) != 1):
            raise WorkerFault("Image dimensions or normalized orientation changed", "PROTOCOL_UNSUPPORTED")
        return image.convert("RGB")


def select_box(rows: list[list[float]], width: int, height: int) -> Box | None:
    ranked: list[tuple[float, Box]] = []
    for left, top, right, bottom, score, label in rows:
        if (label != 0 or not all(map(math.isfinite, (left, top, right, bottom, score)))
                or not CONFIDENCE <= score <= 1):
            continue
        box = (max(0.0, left), max(0.0, top), min(float(width), right), min(float(height), bottom))
        if box[0] < box[2] and box[1] < box[3]:
            ranked.append((-score, box))
    return min(ranked)[1] if ranked else None


class LocalModel:
    def __init__(self, assets: Path | None, settings: Path):
        if sys.platform != "win32" or sys.version_info[:2] != (3, 11):
            raise WorkerFault("Use the isolated Windows Python 3.11 runtime", "PROTOCOL_UNSUPPORTED")
        if assets is None:
            raise WorkerFault("Set LAF_YOLOE_ASSETS to the prepared local assets", "MEDIA_UNAVAILABLE")
        checkpoint = assets / CHECKPOINT
        try:
            with checkpoint.open("rb") as stream:
                if (os.fstat(stream.fileno()).st_size != CHECKPOINT_BYTES
                        or hashlib.file_digest(stream, "sha256").hexdigest() != CHECKPOINT_SHA256):
                    raise WorkerFault("Local checkpoint checksum or length differs", "MEDIA_UNAVAILABLE")
        except OSError as exc:
            raise WorkerFault("Local checkpoint cannot be read", "MEDIA_UNAVAILABLE") from exc
        try:
            if any(version(package) != expected for package, expected in PINS.items()):
                raise WorkerFault("Incompatible vision packages", "PROTOCOL_UNSUPPORTED")
        except PackageNotFoundError as exc:
            raise WorkerFault("Missing pinned vision package", "PROTOCOL_UNSUPPORTED") from exc

        self._network_denied = False
        sys.addaudithook(self._offline)
        (settings / "Ultralytics").mkdir(parents=True, exist_ok=True)
        os.environ["YOLO_CONFIG_DIR"] = str(settings)
        os.environ["YOLO_AUTOINSTALL"] = "false"
        os.environ["YOLO_OFFLINE"] = "true"
        cv2 = import_module("cv2")
        np = import_module("numpy")
        torch = import_module("torch")
        yolo = import_module("ultralytics.models.yolo.model")
        visual_prompt = import_module("ultralytics.models.yolo.yoloe.predict")

        if not (torch.version.cuda == "12.4" and torch.cuda.is_available()
                and cv2.__version__ == "4.11.0" and hasattr(cv2, "aruco")):
            raise WorkerFault("Pinned CUDA or OpenCV runtime unavailable", "PROTOCOL_UNSUPPORTED")
        self._np = np
        self._torch = torch
        self._predictor = visual_prompt.YOLOEVPSegPredictor
        self._model = cast(VisualPredictor, yolo.YOLOE(str(checkpoint)).to(DEVICE))
        self._options = dict(device=DEVICE, imgsz=IMAGE_SIZE, conf=CONFIDENCE, verbose=False, save=False)
        self._prompt: tuple[object, object] | None = None
        self._reference: tuple[object, Box] | None = None
        self._encoded = False
        # Warm the actual visual-prompt path on two different local arrays before advertising readiness.
        reference = np.full((96, 128, 3), 20, dtype=np.uint8)
        reference[12:70, 32:86] = 220
        target = np.zeros((96, 128, 3), dtype=np.uint8)
        self._predict(target, (reference, (32.0, 12.0, 86.0, 70.0)))
        self.probe()

    def _offline(self, event: str, args: tuple[object, ...]) -> None:
        if event in {"socket.connect", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"}:
            self._network_denied = True
            raise RuntimeError("Local YOLOE network access denied")

    def probe(self) -> None:
        if self._network_denied:
            raise WorkerFault("Local YOLOE attempted network access")
        # Exercise the device, including synchronization, without replacing a prepared prompt.
        self._torch.ones(1, device=DEVICE).sum().item()

    def _predict(self, target: object, prompt: tuple[object, Box] | None) -> Detections:
        if prompt is None:
            return self._model.predict(source=target, **self._options)[0]
        reference, box = prompt
        return self._model.predict(
            source=target, refer_image=reference, predictor=self._predictor,
            visual_prompts={"bboxes": self._np.array([box], dtype=self._np.float32), "cls": self._np.array([0])},
            **self._options,
        )[0]

    def prepare(self, header: dict[str, object], data: bytes) -> None:
        kind = "PNG" if header["format"] == "image/png" else "JPEG"
        with load_pixels(header, data, kind, reference=True) as image:
            reference = self._np.array(image)[:, :, ::-1].copy()
        x, y, w, h = cast(list[int], header["roi"])
        self._reference = (reference, (float(x), float(y), float(x + w), float(y + h)))
        self._prompt = (header["session"], header["prompt"])
        self._encoded = False

    def clear(self) -> None:
        self._reference = None
        self._prompt = None
        self._encoded = False

    def infer(self, header: dict[str, object], data: bytes) -> Box | None:
        if self._prompt != (header["session"], header["prompt"]) or self._reference is None:
            raise WorkerFault("Frame requested an unprepared visual prompt", "PROTOCOL_UNSUPPORTED")
        with load_pixels(header, data, "JPEG") as image:
            width, height = image.size
            target = self._np.array(image)[:, :, ::-1].copy()
        result = self._predict(target, None if self._encoded else self._reference)
        self._encoded = True
        if self._network_denied or result.orig_shape != (height, width):
            raise WorkerFault("Inference did not preserve the offline source coordinate contract")
        # The pinned Results boxes are already in original frame pixels.
        return select_box(result.boxes.data.cpu().tolist(), width, height)
