"""Run local recorded-image experiments, writing measurements even on failure.

No cameras, serial ports, production workers, sessions or training are opened.
"""

import argparse
import gc
import hashlib
import json
import os
import statistics
import sys
import time
from pathlib import Path

from .coordinates import clamp_box, roi_xyxy
from .inventory import collect, command, memory


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def deny_network(attempts: list) -> None:
    def audit(event, args):
        if event in {"socket.connect", "socket.getaddrinfo"}:
            attempts.append(event)
            raise RuntimeError(f"Offline probe denied {event}")

    sys.addaudithook(audit)


def normalized_image(path: Path):
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(path) as image:
        return np.array(ImageOps.exif_transpose(image).convert("RGB"))[:, :, ::-1].copy()


def timed(operation, torch, device):
    if device != "cpu":
        torch.cuda.synchronize()
    start = time.perf_counter()
    value = operation()
    if device != "cpu":
        torch.cuda.synchronize()
    return value, (time.perf_counter() - start) * 1000


def resources(torch, device):
    result = memory()
    if device != "cpu":
        result.update(
            cuda_allocated_bytes=torch.cuda.memory_allocated(),
            cuda_reserved_bytes=torch.cuda.memory_reserved(),
            cuda_peak_allocated_bytes=torch.cuda.max_memory_allocated(),
            cuda_free_total_bytes=list(torch.cuda.mem_get_info()),
        )
    return result


def model_probe(path: Path, reference, target, negative, device: str, repetitions: int, output: dict) -> None:
    import numpy as np
    import torch
    from ultralytics import YOLOE
    from ultralytics.models.yolo.yoloe.predict import YOLOEVPSegPredictor

    class CountingPredictor(YOLOEVPSegPredictor):
        encodes = 0
        embeddings: list = []

        def get_vpe(self, source):
            type(self).encodes += 1
            value = super().get_vpe(source)
            type(self).embeddings.append(hashlib.sha256(value.detach().cpu().numpy().tobytes()).hexdigest())
            return value

    def load():
        return YOLOE(str(path)).to(device)

    if device != "cpu":
        torch.cuda.reset_peak_memory_stats()
    output["before"] = resources(torch, device)
    output["dedicated_vram_before"] = command(
        ["nvidia-smi", "--query-gpu=memory.total,memory.used,memory.free", "--format=csv"]
    )
    model, output["checkpoint_load_ms"] = timed(load, torch, device)
    output["actual_parameter_device"] = str(next(model.model.parameters()).device)
    roi = roi_xyxy((50, 390, 190, 510), (reference.shape[1], reference.shape[0]))

    def prompt(image, box):
        return model.predict(
            source=target,
            refer_image=image,
            visual_prompts={"bboxes": np.array([box], dtype=np.float32), "cls": np.array([0])},
            predictor=CountingPredictor,
            device=device,
            imgsz=640,
            conf=0.25,
            verbose=False,
            save=False,
        )

    first, output["prompt_and_first_target_ms"] = timed(lambda: prompt(reference, roi), torch, device)
    output["reference_roi_xyxy"] = list(roi)
    output["encodes_after_prompt"] = CountingPredictor.encodes

    def infer(image):
        return model.predict(source=image, device=device, imgsz=640, conf=0.25, verbose=False, save=False)

    def boxes(results):
        result = results[0]
        height, width = result.orig_shape
        return [
            {"xyxy": list(clamp_box(tuple(row[:4]), (width, height))), "confidence": float(row[4])}
            for row in result.boxes.data.cpu().tolist()
        ]

    output["target_shape_hw"] = list(first[0].orig_shape)
    output["target_boxes_source_xyxy"] = boxes(first)
    times = []
    output["memory_samples"] = []
    for _ in range(repetitions):
        _, elapsed = timed(lambda: infer(target), torch, device)
        times.append(elapsed)
        output["memory_samples"].append(resources(torch, device))
    output["warm_target_ms"] = times
    output["warm_median_ms"] = statistics.median(times)
    output["warm_min_max_ms"] = [min(times), max(times)]
    output["encodes_after_repeated_targets"] = CountingPredictor.encodes
    output["encoded_prompt_reused"] = CountingPredictor.encodes == 1
    result, output["negative_ms"] = timed(lambda: infer(negative), torch, device)
    output["negative_boxes_source_xyxy"] = boxes(result)
    output["negative_shape_hw"] = list(result[0].orig_shape)
    output["after_warm"] = resources(torch, device)
    output["dedicated_vram_after_warm"] = command(
        ["nvidia-smi", "--query-gpu=memory.total,memory.used,memory.free", "--format=csv"]
    )

    # Replace the reference, including its bytes and ROI, then restore by reload.
    changed_roi = roi_xyxy((150, 180, 480, 520), (target.shape[1], target.shape[0]))
    _, output["reference_change_ms"] = timed(lambda: prompt(target, changed_roi), torch, device)
    output["encodes_after_reference_change"] = CountingPredictor.encodes
    output["reference_change_embedding_changed"] = (
        CountingPredictor.embeddings[0] != CountingPredictor.embeddings[1]
    )
    del model
    gc.collect()
    if device != "cpu":
        torch.cuda.empty_cache()
    model = load()
    prompt(reference, roi)
    output["encodes_after_reload"] = CountingPredictor.encodes
    output["reload_restores_reference_embedding"] = (
        CountingPredictor.embeddings[0] == CountingPredictor.embeddings[2]
    )
    output["embedding_sha256"] = CountingPredictor.embeddings
    output["after_reload"] = resources(torch, device)
    if not output["encoded_prompt_reused"] or not output["reference_change_embedding_changed"]:
        raise RuntimeError("Prompt reuse or reference invalidation failed")
    if not output["reload_restores_reference_embedding"]:
        raise RuntimeError("Reload did not restore the reference embedding")


def mediapipe_probe(assets: Path):
    import mediapipe as mp

    start = time.perf_counter()
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(assets / "hand_landmarker.task"), delegate=mp.tasks.BaseOptions.Delegate.CPU
        ),
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_hands=2,
    )
    landmarker = mp.tasks.vision.HandLandmarker.create_from_options(options)
    result = {
        "initialization_ms": (time.perf_counter() - start) * 1000,
        "delegate": "CPU",
        "api": "tasks.vision.HandLandmarker",
        "memory": memory(),
    }
    image = mp.Image.create_from_file(str(assets / "right_hands.jpg"))
    start = time.perf_counter()
    detection = landmarker.detect(image)
    result.update(
        process_ms=(time.perf_counter() - start) * 1000,
        hands=len(detection.hand_landmarks),
        landmark_counts=[len(hand) for hand in detection.hand_landmarks],
    )
    if not detection.hand_landmarks or any(len(hand) != 21 for hand in detection.hand_landmarks):
        landmarker.close()
        raise RuntimeError("Suitable image did not produce 21-point hand landmarks")
    return landmarker, result


def run(args) -> int:
    assets = args.assets.resolve()
    attempts: list = []
    os.environ["YOLO_CONFIG_DIR"] = str(args.output.parent.resolve() / "ultralytics-config")
    os.environ["YOLO_AUTOINSTALL"] = "false"
    os.environ["YOLO_OFFLINE"] = "true"
    os.environ["YOLO_VERBOSE"] = "false"
    os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
    deny_network(attempts)
    report: dict = {
        "offline_enforcement": "Python socket audit denies connect and DNS; not an OS firewall",
        "network_attempts": attempts,
        "failures": [],
        "models": [],
        "conditions": args.condition,
        "repetitions": args.repetitions,
        "imgsz": 640,
        "confidence": 0.25,
        "precision": "FP32",
        "coexistence": "MediaPipe instance remains alive during YOLOE; other load in conditions",
    }
    landmarker = None
    try:
        report["environment"] = collect()
        manifest = json.loads(Path(__file__).with_name("assets.json").read_text())
        report["assets"] = {}
        for name, entry in manifest.items():
            actual = digest(assets / name)
            if actual != entry["sha256"]:
                raise ValueError(f"Asset hash mismatch: {name}")
            report["assets"][name] = actual
        start = time.perf_counter()
        import torch

        report["torch_import_ms"] = (time.perf_counter() - start) * 1000

        report["torch_cuda_available"] = torch.cuda.is_available()
        report["torch_cuda_build"] = torch.version.cuda
        torch.set_num_threads(4)
        report["torch_cpu_threads"] = torch.get_num_threads()
        # Includes a real CUDA operation before the actual YOLOE GPU experiment.
        if args.device != "cpu":
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA is unavailable; CPU is not a GPU-feasibility pass")
            report["cuda_smoke_value"] = (torch.ones(4, device="cuda") * 2).sum().item()
        try:
            landmarker, report["mediapipe"] = mediapipe_probe(assets)
        except Exception as exc:
            report["failures"].append(f"MediaPipe: {type(exc).__name__}: {exc}")
        import cv2
        import fastapi
        import pygame
        import serial
        import uvicorn

        cv2.setNumThreads(4)
        report["supporting_initialization"] = {
            "opencv": cv2.__version__,
            "opencv_contrib_aruco": hasattr(cv2, "aruco"),
            "fastapi_app_created": isinstance(fastapi.FastAPI(), fastapi.FastAPI),
            "uvicorn": uvicorn.__version__,
            "pygame_sdl": list(pygame.get_sdl_version()),
            "pyserial": serial.VERSION,
        }
        reference = normalized_image(assets / "bus.jpg")
        target = normalized_image(assets / "zidane.jpg")
        negative = normalized_image(assets / "right_hands.jpg")
        report["reference_shape_hw"] = list(reference.shape[:2])
        for name in ("yoloe-26n-seg.pt", "yoloe-26s-seg.pt"):
            output = {"model": name, "model_sha256": report["assets"][name], "device": args.device}
            report["models"].append(output)
            try:
                model_probe(assets / name, reference, target, negative, args.device, args.repetitions, output)
            except Exception as exc:
                output["failure"] = f"{type(exc).__name__}: {exc}"
                report["failures"].append(f"{name}: {output['failure']}")
            gc.collect()
            if args.device != "cpu":
                torch.cuda.empty_cache()
        report["model_change_invalidation"] = "Each checkpoint uses a new model and encodes its own reference"
    except Exception as exc:
        report["failures"].append(f"{type(exc).__name__}: {exc}")
    finally:
        if landmarker is not None:
            landmarker.close()
        if attempts:
            report["failures"].append("Unexpected runtime network attempt")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(f"{args.output}: {len(report['failures'])} failure(s)")
    return int(bool(report["failures"]))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=["cpu", "cuda:0"], default="cuda:0")
    parser.add_argument("--repetitions", type=int, default=20)
    parser.add_argument("--condition", required=True)
    args = parser.parse_args()
    if args.repetitions < 2:
        parser.error("--repetitions must be at least 2")
    raise SystemExit(run(args))
