# Offline YOLOE on Windows

`local-yoloe-v1` runs the local visual matcher with recorded robot video and simulated operator input, command output and proximity. Profiles are selected at process startup. Leave `LAF_SIMULATION_PROFILE` unset for records only. The explicit `fixture-v1` and `fixture-review-v1` profiles run without model dependencies.

## Set up and start

Use the isolated Phase 04 Python 3.11.14 environment and review the [vision dependency and asset notices](../experiments/vision/NOTICES.md). The one-time online setup downloads the hash-pinned CUDA wheels and assets. Install the backend lock into the same environment with `install` so the vision packages remain installed. The two locks agree on overlapping pins.

```powershell
./experiments/vision/setup.ps1
$visionPython = '.local-runtime/venv/Scripts/python.exe'
uv pip install --python $visionPython --require-hashes --only-binary :all: -r backend/requirements.lock --cache-dir .local-runtime/uv-cache
& $visionPython -m pip check
```

After this setup the same commands can use `setup.ps1 -Offline` and `uv pip install --offline` with the populated caches. Both application environments use project-local Python. Start the [records-mode frontend](README.md) and the backend from the repository root.

```powershell
$env:LAF_SIMULATION_PROFILE = 'local-yoloe-v1'
$env:LAF_YOLOE_ASSETS = (Resolve-Path '.local-runtime/assets').Path
& $visionPython -m backend.app
```

The default footage is the included robot JPEG. To use a different recorded scene, set `LAF_RECORDED_ROBOT_JPEG` to its local path before launch. The backend validates a single RGB JPEG with a maximum of 640 × 480 pixels and a 128 KiB total frame envelope. The simulation repeatedly samples the recording with new acquisition IDs. Open an eligible saved Lost target, select the simulated input mode, acquire control, and start when the matching service reports Ready.

## Matching profile v1

| Setting | Value |
| --- | --- |
| Checkpoint | `yoloe-26s-seg.pt`, Ultralytics assets release v8.4.0, 31,072,171 bytes |
| Checkpoint SHA-256 | `48f24206bc8680d60cbbfa296b0140da849669b9515058b72f5a945142df0654` |
| Device and packages | NVIDIA CUDA device 0, PyTorch 2.6.0+cu124, torchvision 0.21.0+cu124, Ultralytics 8.4.23, NumPy 1.26.4, OpenCV 4.11.0.86 with contrib installed last, Pillow 12.1.1 |
| Predictor | YOLOEVPSegPredictor, one visual class, FP32, inference size 640, confidence 0.25 |
| Candidate selection | Highest-confidence valid box. Ties use ascending original-frame left, top, right, then bottom. Clip to the frame and round outward for the stored overlay. |
| Supervision | 90 s startup deadline, 2.5 s without fresh progress, 250 ms idle probe interval, 2 s restart delay. Frames older than the fixture profile's 750 ms acquisition-age limit cannot refresh readiness or produce evidence. |

The worker checks the local checkpoint and package versions, initializes CUDA, and runs a visual-prompt warmup before reporting Ready. It disables Ultralytics automatic installs and online mode and denies DNS and socket connections inside the worker. It stores library settings under the backend's local data root. The selected model uses the [Ultralytics AGPL-3.0 license](../experiments/vision/notices/Ultralytics-AGPL-3.0.txt). The model and sample assets are installed explicitly. The hash inventory and upstream terms are in the [Phase 04 asset manifest](../experiments/vision/assets.json) and [notices](../experiments/vision/NOTICES.md).

The backend resolves the saved object's checksum-validated normalized reference and ROI once per session and worker. The worker uses source-pixel corners against that image, encodes the first prompt against a separate robot frame, and reuses the embedding for subsequent frames. A new session, worker or configured checkpoint requires a new prompt. Control generation changes require new eligible frames and give no authority to earlier replies. Captured evidence is the full decoded JPEG saved as a lossless PNG with an independent box. After Reject, the session suppresses subsequent candidates while continuity is uncertain.

## Internal worker IPC v1

The Windows spawned child receives a private, bounded pipe. The parent sends at most one request at a time and keeps only the latest waiting robot frame. Pipe I/O runs outside the event loop. JSON headers use a 4 KiB limit and strict keys, types and version. `prepare` and `frame` carry a separate bounded binary message whose length and image size must agree with the validated header. A reference can use up to 100,000,000 encoded bytes and 20 million pixels. A robot image uses the simulation profile's frame bounds.

- Startup sends `ready` or `startup_failed`, tagged with the backend boot and worker instance.
- `prepare` supplies the session, immutable managed reference ID, format, dimensions, byte count and ROI. `clear` invalidates the prompt when the session ends.
- `frame` carries the prompt and session IDs, control generation, source stream and clock epochs, acquisition sequence, source timestamp, unique backend frame ID, dimensions and byte count.
- `probe` exercises CUDA when no eligible search work is active. Every solicited reply must echo the entire request identity and its single-use counter. A frame reply adds either one original-pixel box or null. Other replies use null.

The backend checks the echoed identity, live stream epoch, current session and control generation, and the conservative age from original acquisition. A malformed or replayed reply, hung call or dead child closes AI readiness and routes active recovery through `AIUnavailable`. The backend revokes logical permission before terminating or replacing the child. The child watches the backend owner's process handle so an owner exit shuts down the child. A replacement can restore readiness. Acknowledgment, explicit Resume, neutral and a fresh hold are still required before logical movement.

## Reproduce acceptance checks

```powershell
$env:LAF_TEST_YOLOE_ASSETS = (Resolve-Path '.local-runtime/assets').Path
& $visionPython -m pytest backend/tests/test_vision_worker.py -q -s
& $visionPython -m pytest backend/tests/test_local_matching.py -q
& $visionPython -m pytest experiments/vision -q
```

For the browser journey, set `LAF_TEST_PYTHON` to the absolute path to the same interpreter. Build the frontend, then run `npm run test:e2e -- e2e/records.spec.ts -g 'offline assets|offline YOLOE' --workers=1` from `frontend`.

On the Windows RTX 4050 Laptop GPU (driver 560.94, 6,141 MiB dedicated VRAM), two spawned checks reached Ready in 9.8 and 43.1 s under different local loads. The off-center person ROI from `bus.jpg` found a candidate in `zidane.jpg` (640 × 360). Its original-pixel box was approximately `[374.41, 21.90, 574.93, 359.65]` in corner order. The first prompted exchanges took 172 and 1,084 ms. Five warmed exchanges per run took 19–79 ms across both runs. These timings include IPC and decode. The slower first result exceeded the 750 ms assembled-search frame cutoff, so the next fresh warmed frame was eligible. The hand-only distractor and flat negative returned no match. The synthetic wallet in the default full-frame scene was also missed at 0.25, so use the recorded person pair above to reproduce the connected browser match. The browser run confirmed the match, compared all evidence pixels with the recorded source, and reopened the saved outcome after a backend restart using the same temporary SQLite and media directories.
