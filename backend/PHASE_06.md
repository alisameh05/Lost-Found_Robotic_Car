# Phase 06 local search runtime

`phase-06-v1` runs the Windows records backend, offline YOLOE and both local input adapters. An eligible saved Lost record supplies the reference and ROI. Start locks the selected control mode for the session. Robot video comes from an explicitly selected local JPEG, sampled with new acquisition IDs. Logical commands and proximity are simulated.

## Install once and run offline

Use PowerShell 7 on Windows x64. Run the setup from the repository root. The `-Application` switch resolves the two hash-locked dependency sets together and installs the pinned OpenCV contrib provider last, as required by the combined runtime. Install the frontend and Playwright browser during the same online setup.

```powershell
./experiments/vision/setup.ps1 -Application
Push-Location frontend
npm.cmd ci
node node_modules/@playwright/test/cli.js install chromium
Pop-Location
```

Once the wheel cache and assets are populated, `./experiments/vision/setup.ps1 -Application -Offline` installs from the local wheel directory and verifies the offline assets without downloading. The [asset inventory](../experiments/vision/assets.json) records SHA-256 hashes, upstream revisions, and source terms. Review the [dependency and redistribution notices](../experiments/vision/NOTICES.md) before distributing the runtime or pretrained assets.

Use the [webcam discovery](GESTURES.md#set-up-and-select-the-camera) and [controller discovery](CONTROLLER.md#select-the-device) commands to select the exact DirectShow path and USB serial. Keep both identifiers in the local environment. Run the [records-mode frontend](README.md#start) in a separate terminal. Start the backend with the following settings.

```powershell
$phasePython = (Resolve-Path '.local-runtime/venv/Scripts/python.exe').Path
$assets = (Resolve-Path '.local-runtime/assets').Path
$recording = Join-Path $assets 'phase06-robot.jpg'
& $phasePython -c 'import sys; from PIL import Image; image = Image.open(sys.argv[1]).convert("RGB"); image.thumbnail((640, 480)); image.save(sys.argv[2], quality=88)' (Join-Path $assets 'zidane.jpg') $recording

$env:LAF_SIMULATION_PROFILE = 'phase-06-v1'
$env:LAF_YOLOE_ASSETS = $assets
$env:LAF_GESTURE_ASSETS = $assets
$env:LAF_RECORDED_ROBOT_JPEG = $recording
$env:LAF_WEBCAM_DEVICE_PATH = '<exact DirectShow path>'
$env:LAF_CONTROLLER_SERIAL = '<selected USB DualShock 4 serial>'
& $phasePython -m backend.app
```

Register `bus.jpg` and set the saved target rectangle to `x=50, y=390, width=190, height=510` to reproduce the recorded person match. If a camera or controller is missing or incompatible, its mode shows Unavailable. The other mode can start when its own input and the shared paths are ready. A missing or incompatible checkpoint prevents either mode from starting. A missing or invalid robot recording leaves the profile active and marks Robot camera Unavailable for both modes. Protected records and health remain available in each case.

The [versioned qualification profile](app/preview_fixture/phase06/profile.json) validates its evidence and interface manifest hashes at startup. These are the component profiles frozen for this runtime.

| Component | Settings and evidence |
| --- | --- |
| T4 webcam | DirectShow and MediaPipe Hand Landmarker at 640 × 480. The 240 ms sample limit covers the measured Windows acquisition and processing time. [Webcam profile, thresholds, and device evidence](GESTURES.md#t4-profile-v1) |
| T4 controller | Selected USB DualShock 4, Pygame 2.6.1, SDL 2.28.4, 15 ms polling and 180 ms freshness. The shortened controller deadline remains in effect alongside the webcam deadline. [USB identity, mapping, and evidence](CONTROLLER.md) |
| T5 matching | YOLOE Small on CUDA device 0, image size 640, FP32 and confidence 0.25. The worker has a 90 s startup timeout and 2.5 s progress deadline. [Checkpoint, measured rationale, and continuity thresholds](VISION.md) |
| T6 worker | Private IPC version 1 with scoped immutable prompt and frame IDs. One request is in flight and one latest frame waits. [Message shapes and bounds](VISION.md#internal-worker-ipc-v1) |
| Shared gates | 640 × 480 and 128 KiB frame envelope, with 2,052 bytes reserved for the frame header and length. Simulated capture runs at approximately 10 Hz. Acquisition age is limited to 750 ms, the displayed-frame deadline is 600 ms, and workspace heartbeats run every 100 ms with 350 ms expiry. Logical renewal is due every 60 ms and the independent simulated device expires commands after 220 ms. [Frozen shared bounds](app/preview_fixture/phase06/profile.json) |

End the active search while disarmed, wait for its save, then stop the backend before changing any profile, asset, device selection, or robot recording. Start the new configuration against the same local data root. One process owns the data root and startup validates the dependent paths again. Reacquire control and start from neutral after restart. Recovery in the same boot requires restoring the path, acknowledging the failure, explicitly selecting Resume, returning to neutral, and applying a fresh hold.

## Replay and review evidence

The connected Playwright cases use temporary SQLite and media, protected HTTP and WebSocket channels, recorded robot scenes, and the simulated command journal. They run the pinned CUDA worker. Gesture direction checks replay controlled hand observations through the classifier and webcam adapter. The separate combined workload runs the real MediaPipe Hand Landmarker on a recorded hand image. Controller checks replay advancing USB report bytes through the selected-device adapter.

```powershell
$env:LAF_TEST_PYTHON = (Resolve-Path '.local-runtime/venv/Scripts/python.exe').Path
$env:LAF_TEST_PHASE06_ASSETS = (Resolve-Path '.local-runtime/assets').Path
$env:npm_config_script_shell = (Get-Process -Id $PID).Path
Push-Location frontend
npm.cmd run build
npm.cmd run test:e2e -- e2e/records.spec.ts --workers=1 -g 'Phase 06 '
Pop-Location
```

Playwright attaches the capture, model exchange, input, logical command, and resource traces. The combined workload records browser canvas draws separately from capture and inference. The browser permits application requests to the two loopback origins. The replay backend denies external Python connections and DNS, and the spawned YOLOE worker denies network access. These runs use preinstalled assets and packages on a Windows host with its network interfaces left enabled.

### Windows replay measurements

Windows 11 26H2 build 26300.9974 x64, CPython 3.11.14, SQLite 3.50.4, Node 24.21.0, npm 11.19.0, Playwright 1.65.1, and Chromium 159.0.8154.6. The NVIDIA RTX 4050 Laptop GPU used driver 560.94 and had 6,141 MiB of dedicated memory. The positive robot scene used the 640 × 360 downsample of `zidane.jpg`. A synthetic flat scene supplied the negative run. The Controller re-entry replay translated a crop of the recorded person through the right edge and back, with about 125 ms between acquisitions during the crossing. Incomplete crossings leave suppression in effect, so the browser test can feed a new complete crossing while Paused.

| Replay | Trace duration | Initial worker Ready | First prompted exchange | Warmed exchange median and max |
| --- | ---: | ---: | ---: | ---: |
| Gesture observations replayed through the classifier and webcam adapter | 33.4 s | 17.8 s | 438 ms | 64 ms and 165 ms |
| Controller USB reports replayed through the DualShock 4 adapter | 49.2 s | 8.5 s | 128 ms | 29 ms and 171 ms |
| Native CPU Hand Landmarker with a single-hand crop of `right_hands.jpg` | 37.7 s | 26.3 s | 137 ms | 38 ms and 98 ms |

| Combined window | Duration | Robot capture | Browser draws | YOLOE exchanges | Webcam capture | Landmark results |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Controller USB-report replay | 10.08 s | 10.12/s | 9.99/s | 9.92/s | Inactive | Inactive |
| Native MediaPipe with recorded single hand | 10.12 s | 10.17/s | 10.16/s | 10.07/s | 12.35/s | 12.25/s |

The native replay captured an 80 ms loop based on the selected webcam’s earlier measurements. The Landmarker call took 183 ms on its first frame and a warmed median of 33 ms, with a 97 ms maximum after the first call. A two-hand full-image replay outpaced recognition at 33 ms. In another two-hand run, the 100 ms replay plus processing briefly exceeded the 240 ms freshness limit around Start, which caused an `InputUnavailable` pause. The single-hand run sustained recognition and inference together.

The first positive scene change produced a matching response after 94 ms in Gestures and 125 ms in Controller. In the runs without an evidence barrier, the captured evidence became visible in the browser about 0.91 to 0.95 s after switching to the positive scene. Webcam replay loss reached logical STOP within 47 ms of the replay change and robot capture loss within 32 ms. The Controller poll detected input loss 32 ms after the replay change and logged STOP 15 ms later. A blocked exchange reached STOP after 2.47 s with the barrier still set. Circle and STOP were recorded in the same 15.6 ms monotonic tick with the writer already stalled. The keyboard Emergency Stop reached STOP while the writer was stalled. The simulated sink recorded revocation and STOP together in both modes.

In the reviewed replays, UI Emergency Stop and Circle reached STOP 266 ms and 94 ms after entry to the positive-reply barrier, respectively. Both stopped before the barrier released, and the late positive replies produced no review. With the registration writer already blocked, the corresponding barrier-to-STOP observations were 156 ms and 141 ms. Candidate admission revoked output before PNG preparation, and the saved evidence came from the earlier positive frame after the browser displayed the negative scene. Stale display and separate focus loss also revoked output.

The Controller and native MediaPipe windows peaked at 38.1% and 91.5% system CPU, 12.26 and 12.54 GiB system RAM, 1.52 and 1.00 GiB backend-plus-worker resident memory, and 48% and 17% GPU utilization. Both recorded 351 MiB dedicated VRAM use. GPU utilization and VRAM came from periodic `nvidia-smi` samples of the whole device. These short controlled workloads measured the software gates and resource use. Physical stop and long-duration release qualification remain separate.

The full backend regression run passed 377 cases and reported four failures. Three passed on a focused rerun. `test_source_and_worker_resets_keep_rejection_and_require_deliberate_recovery` timed out waiting for the second candidate both on this branch and on the original `main` commit `2dee839`. The integrated CUDA browser replay verified suppression and re-entry while Paused before an explicit Resume.

Hands-on operator qualification remains open. On the selected Integrated Camera, check live hand mapping, occlusion and viewpoint, preview orientation, end-to-end response, and capture disconnect/reopen. On the selected DualShock 4, check all four directions, release and diagonal, Circle with a held direction, focus loss, unplug/reconnect and timing with the simulated sink. The prior adapter reports preserve the camera identity and SDL/HID observations already measured.

## Phase 08 short native replay

The baseline was `42fbfeb312228be51ee92cd42f7c50b04ba09548` on a Lenovo 82XV with an Intel Core i7-13620H, 13.0 GiB detected RAM, and Windows 11 26H2 build 26300.9974 on the Balanced power plan. The NVIDIA GeForce RTX 4050 Laptop GPU reported driver 560.94 and 6,141 MiB dedicated VRAM. The native runtime used CPython 3.11.14, SQLite 3.50.4, FastAPI 0.163.2, MediaPipe 0.10.32, OpenCV contrib 4.11.0.86, Ultralytics 8.4.23, and PyTorch 2.6.0+cu124 on CUDA device 0. The browser build used Node 24.21.0, npm 11.19.0, Next.js 16.4.6, Playwright 1.65.1 and Chromium 159.0.8154.6. Package locks record the complete dependencies.

| Local file used | Observed SHA-256 |
| --- | --- |
| `yoloe-26s-seg.pt` | `48f24206bc8680d60cbbfa296b0140da849669b9515058b72f5a945142df0654` |
| `hand_landmarker.task` | `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1` |
| `bus.jpg` | `c02019c4979c191eb739ddd944445ef408dad5679acab6fd520ef9d434bfbc63` |
| `zidane.jpg` | `16d73869e3267a7d4ed00de8e860833bd1657c1b252e94c0c348277adc7b6edb` |
| `right_hands.jpg` | `4b5134daa4cb60465535239535f9f74c2842aba3aa5fd30bf04ef5678f93d87f` |
| `phase06/profile.json` | `4a168cec6fe6f8c84a65e94a599c77dffb90bf7b7593e46fea3cbe667e0d25ac` |
| CPython `python.exe` | `77ce191aa5d30b17288a3d6adaf83813154998b8de82b82485d393d11ce47c58` |
| `node.exe` | `ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32` |
| `backend/requirements.lock` | `46198fdc2ede30712a3260163559a710fbecbf78aa0fe14628d1cda341ab3bb2` |
| `experiments/vision/requirements.lock` | `7a268224173bfbaebcd315463b66839076ee123c77abfb0e3ffd6676e9933ff1` |
| `frontend/package-lock.json` | `201cd3365da38f50820d72ba5712bf5fa61490f0e0dda207a7f5045fb748d3b2` |

Run the same protected production browser workload. The browser driver creates the 640 × 360 quality-88 positive JPEG from `zidane.jpg` and uses the same size and quality for the flat RGB (45, 45, 45) negative frame. The reference and saved ROI are `bus.jpg` and (50, 390, 190, 510). The native webcam path crops `right_hands.jpg` to its first 360 columns, scales it to 480 px tall and centers it in a 640 × 480 frame. The replay driver uses the same 80 ms delivery cadence and sends the recorded pixels through the pinned CPU Hand Landmarker. The fixture stamps acquisition when it emits the pixels. The baseline counted the pacing wait in sample age, as DirectShow does for blocking reads without a source timestamp. The other selected-mode journeys simulate hand landmarks or DualShock 4 USB reports. Robot input, commands and proximity are fixtures. The matching model, protected HTTP/WebSocket traffic, browser drawing, and managed SQLite/media storage are real. The replay permits application traffic on loopback and denies network access in the worker. Windows network interfaces remained enabled. [Replay command](#replay-and-review-evidence) · [Browser driver](../frontend/e2e/records.spec.ts) · [Replay driver](tests/phase06_replay.py)

### Baseline and isolation

- The [Phase 07 repeat](PHASE_07_INTEGRATION.md#november-23-verification-record) recorded an `InputUnavailable` revocation, 222 Landmarker results across the run and zero YOLOE frame exchanges. The worker cannot exchange search frames after a required input pauses a search.
- On current main, the first Chromium replay completed with 106 frame exchanges across the journey. The next two stopped at Search Setup with Webcam `Unavailable`, the other required paths Ready and zero frame exchanges. MediaPipe still returned 416 and 350 results. The baseline logs and browser traces retain all three outcomes.
- The first standalone CUDA check returned detections and then raised `Local YOLOE worker has not exited`. The first focused retry passed. A deterministic spawned worker fixture reproduced an idle child being terminated before its EOF cleanup.
- The deterministic webcam test reproduced the stale readiness signal when another acquisition arrived before MediaPipe completed. Timely results from the current capture epoch now prove recognition progress using their original acquisition timestamps. A result completed after a newer acquisition cannot stabilize or authorize a gesture. Camera loss and stale recognition still disarm under the 240 ms bound.
- The worker receives EOF for orderly exit after draining an in-flight exchange. Shutdown can terminate and reap an unresponsive child. This timeout applies to process teardown. The worker startup, inference progress and input readiness bounds retain their existing values.
- A focused run after separating recognition readiness still reproduced `InputUnavailable` during the simulated blocking read, with zero exchanges in the 10.18 s window. The prior acquisition was about 250 ms old when the next result arrived. The controlled replay now uses its known delivery timestamp. The real DirectShow adapter continues to use the start of the blocking read.
- With the Windows launcher stdin pipe held open, the spawned worker never reported Ready. A protected supervisor regression showed AI stayed `Initializing` with missing assets. Polling the pipe for data or EOF before reading lets the worker report `MEDIA_UNAVAILABLE` and preserves launcher-driven shutdown.
- After fixing supervised startup, one replay completed, one paused during a 296 ms MediaPipe call, and one lost webcam readiness at Start. All three workers exited with code 0. One-thread CPU preprocessing was evaluated but had no verified CUDA result before the host lost access to the GPU. The recorded results use the pinned model settings.

### Changed revision evidence

| Replay | Window | Robot acquisitions | Browser draws | YOLOE exchanges | Landmarker results |
| --- | ---: | ---: | ---: | ---: | ---: |
| Controller USB-report replay | 10.150 s | 101 | 101 | 101 | Inactive |
| Real MediaPipe with recorded hand, temporary test shutdown signal | 10.173 s | 104 | 103 | 104 | 127 |
| Real MediaPipe with recorded hand, production stdin supervision | 10.178 s | 101 | 102 | 101 | 126 |

Both selected-mode journeys passed with the temporary test shutdown signal. The production-supervised native pass sustained the negative scene without a revocation, exercised a deliberate `InputUnavailable` pause and recovery, then displayed a positive match. Stop Search and launcher EOF ended the run. The backend and the original CUDA worker both exited with code 0. Both other production-supervised attempts also released their worker with code 0. One retained 31 exchanges before a timed-out gesture sample paused the session. The other lost webcam readiness during Start and stayed in Search Setup.

The later installed-launcher check reached records readiness and exited cleanly. Its native retry reported `PROTOCOL_UNSUPPORTED` during worker startup. Windows listed the RTX 4050 as `Unknown / CM_PROB_PHANTOM`, PyTorch reported CUDA 12.4 with zero visible devices, and OpenCV 4.11.0 still exposed `aruco`. The later GPU-dependent browser and backend reruns were blocked. The short native workload has a complete production-supervised observation and repeatability remains open on this host.

Local evidence is under `.local-runtime/results/issue109`. `baseline-browser` preserves the first run and both repeats. `baseline-pinned-models.xml` and `baseline-pinned-model-retry.xml` preserve the first worker-exit result and retry. `changed-native-stop-signal` preserves the focused zero-exchange result and protected transition trace. `final-phase06` and `supervised-native-repeat` contain the replay inputs, readiness transitions, resource and model-exchange samples, and worker exit rows. The missing-asset supervisor regression is recorded in `red-supervised-worker.xml` and `green-supervised-worker.xml`.

The final focused backend run passed 34 checks, including the real CPU Hand Landmarker, with the CUDA worker benchmark gated off after the device disappeared. Five deterministic cases from the full-suite failures passed on focused retry. The full backend runs recorded 495/496 and 493/498 passes. The later run included the unavailable CUDA startup. Ruff, mypy, the contract export, frontend lint and type checking, the production build, and all 90 frontend unit tests passed. The raw backend reports are `changed-backend-full.xml`, `final-backend-full.xml`, `final-affected-tests.xml`, and `final-deterministic-retries.xml`.
