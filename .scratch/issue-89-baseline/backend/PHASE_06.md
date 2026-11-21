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
