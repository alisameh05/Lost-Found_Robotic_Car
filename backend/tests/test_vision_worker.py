import asyncio
import base64
import json
import os
import time
from io import BytesIO
from pathlib import Path
from threading import Event

import pytest
from PIL import Image, ImageOps

from backend.app.vision_model import select_box
from backend.app.vision_worker import (
    FrameLimits,
    LocalPipe,
    Prompt,
    VisionProcess,
    WorkerFault,
    launch_process,
    receive,
    send,
)

LIMITS = FrameLimits(131072, 640, 480, 307200)


def test_stalled_os_launch_reports_deadline_and_reaps_late_worker() -> None:
    release, closed = Event(), Event()

    class DelayedLaunch:
        def start(self):
            assert release.wait(3)

        def close(self):
            closed.set()
            return True

    async def exercise():
        overdue = asyncio.Event()
        launch = asyncio.create_task(launch_process(DelayedLaunch, 0.05, overdue.set))
        await asyncio.wait_for(overdue.wait(), timeout=2)
        assert not launch.done()
        launch.cancel()
        with pytest.raises(asyncio.CancelledError):
            await launch
        release.set()
        assert await asyncio.to_thread(closed.wait, 2)

    asyncio.run(exercise())


def test_original_pixel_box_selection_clips_edges_and_orders_ties() -> None:
    rows = [
        [float("nan"), 0, 80, 40, 0.99, 0],
        [130, 0, 160, 30, 0.92, 0],
        [3, 10, 80, 5, 0.9, 0],
        [2, 2, 25, 100, 0.81, 0],
        [-0.25, 2.5, 150, 80, 0.81, 0],
        [1, 1, 30, 30, 0.99, 1],
    ]
    assert select_box(rows, 120, 70) == (0.0, 2.5, 120.0, 70.0)


def replay_worker(
    pipe: LocalPipe, boot: str, worker: str, assets: Path | None, settings: Path, limits: FrameLimits,
) -> None:
    with pipe:
        send(pipe, {"kind": "ready", "boot": boot, "worker": worker})
        request = receive(pipe)
        response = {**request, "box": None}
        send(pipe, response)
        receive(pipe)
        send(pipe, response)


def test_worker_cannot_refresh_progress_with_a_replayed_reply(tmp_path: Path) -> None:
    with VisionProcess("test-boot", None, tmp_path, LIMITS, target=replay_worker) as worker:
        worker.initialize()
        assert worker.exchange("probe") is None
        with pytest.raises(WorkerFault, match="identity"):
            worker.exchange("probe")


@pytest.mark.parametrize("bad_asset", ["missing", "changed"])
def test_invalid_local_assets_fail_before_native_start(tmp_path: Path, bad_asset: str) -> None:
    if os.name != "nt":
        pytest.skip("The pinned CUDA profile requires Windows")
    if bad_asset == "changed":
        (tmp_path / "yoloe-26s-seg.pt").write_bytes(b"not the approved checkpoint")
    with VisionProcess("test-boot", tmp_path, tmp_path / "config", LIMITS) as worker:
        with pytest.raises(WorkerFault) as failure:
            worker.initialize()
        assert failure.value.cause == "MEDIA_UNAVAILABLE"


def jpeg_frame(path: Path, limit: tuple[int, int]) -> tuple[bytes, int, int]:
    output = BytesIO()
    with Image.open(path) as original, ImageOps.exif_transpose(original) as image:
        image.thumbnail(limit)
        image.convert("RGB").save(output, "JPEG", quality=88)
        return output.getvalue(), image.width, image.height


def test_pinned_windows_gpu_worker(tmp_path: Path) -> None:
    selection = os.environ.get("LAF_TEST_YOLOE_ASSETS")
    if not selection:
        pytest.skip("Set LAF_TEST_YOLOE_ASSETS to run the real offline Windows CUDA worker")
    assets = Path(selection).resolve()
    reference, width, height = jpeg_frame(assets / "bus.jpg", (900, 1100))
    prompt = Prompt("saved-reference", "image/jpeg", width, height, (50, 390, 190, 510), reference)
    positive = jpeg_frame(assets / "zidane.jpg", (640, 480))
    hands = jpeg_frame(assets / "right_hands.jpg", (640, 480))
    neutral = BytesIO()
    Image.new("RGB", (320, 192), "#888888").save(neutral, "JPEG")
    negative = neutral.getvalue(), 320, 192
    start = time.perf_counter()
    with VisionProcess("test-boot", assets, tmp_path / "config", LIMITS) as worker:
        worker.initialize()
        startup_ms = (time.perf_counter() - start) * 1000
        worker.exchange("prepare", prompt.fields("test-session"), reference)
        for sequence, (image, w, h) in enumerate([positive] * 6 + [hands, negative], 1):
            fields = {"session": "test-session", "generation": 1, "prompt": prompt.id,
                      "frame": f"frame-{sequence}", "stream": "stream-1", "clock": "clock-1",
                      "sequence": sequence, "source_us": sequence,
                      "width": w, "height": h, "size": len(image)}
            started = time.perf_counter()
            result = worker.exchange("frame", fields, image)
            elapsed_ms = (time.perf_counter() - started) * 1000
            print(f"frame={sequence} box={result} worker_roundtrip_ms={elapsed_ms:.2f}")
            if sequence <= 6:
                assert result is not None and 0 <= result[0] < result[2] <= w
                assert 0 <= result[1] < result[3] <= h
            else:
                assert result is None
        first_fields = fields
        library = Path(__file__).resolve().parents[2] / "frontend/src/lib/fixtures/reference-images.json"
        wallet = json.loads(library.read_text(encoding="utf-8"))["sample-wallet-reference"]
        wallet_bytes = base64.b64decode(wallet["base64"])
        prompt = Prompt("wallet-reference", "image/jpeg", wallet["width"], wallet["height"],
                        (148, 87, 342, 186), wallet_bytes)
        worker.exchange("clear")
        worker.exchange("prepare", prompt.fields("wallet-session"), wallet_bytes)
        robot = Path(__file__).resolve().parents[1] / "app/preview_fixture/robot.jpg"
        image, w, h = jpeg_frame(robot, (640, 480))
        fields = {
            **first_fields, "session": "wallet-session", "prompt": prompt.id, "frame": "wallet-1",
            "sequence": 9, "source_us": 9, "width": w, "height": h, "size": len(image),
        }
        print(f"wallet_box={worker.exchange('frame', fields, image)}")
    print(f"worker_startup_ms={startup_ms:.2f}")
