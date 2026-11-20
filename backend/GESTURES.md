# Windows webcam gestures

`local-gestures-v1` runs OpenCV and MediaPipe in the local backend. The robot video, command sink, matching readiness and Controller input are simulated. Use the simulated command sink for pose and recovery checks.

## Set up and select the camera

From the repository root, run `./experiments/vision/setup.ps1` once to cache the hash-locked Windows x64 Python 3.11.14 dependencies and provision the assets. Rerun it with `-Offline` to install from the wheel cache. The adapter verifies the exact Hand Landmarker asset size and SHA-256 from the [asset manifest](../experiments/vision/assets.json) before loading it from memory. It checks MediaPipe 0.10.32, OpenCV contrib 4.11.0.86, NumPy 1.26.4 and the DirectShow enumerator 1.4.0. See the [dependency notices](../experiments/vision/NOTICES.md).

```powershell
$visionPython = (Resolve-Path '.local-runtime/venv/Scripts/python.exe').Path
& $visionPython -c 'from backend.app.webcam import directshow_devices; [print(i, name, path) for i, name, path in directshow_devices()]'
$env:LAF_SIMULATION_PROFILE = 'local-gestures-v1'
$env:LAF_GESTURE_ASSETS = (Resolve-Path '.local-runtime/assets').Path
$env:LAF_WEBCAM_DEVICE_PATH = '<exact DirectShow path for the selected camera>'
& $visionPython -m backend.app
```

Copy the path printed after the camera name. Restart the backend to change selection. The adapter resolves the exact path on each open and verifies the backend and selection again after opening. A missing or ambiguous selection, unreadable frame, or missing recognizer leaves Gestures unavailable. Controller can still Start when its shared prerequisites are met.

Open a saved Lost object's Search Setup in records mode. Select Gestures, acquire control, then Start Search. The Live Search Workspace shows the mirrored protected preview with the recognized count and direction or pose feedback. Motion permission is a separate indicator. For a direction, show a stable closed fist, then hold 1, 2, 3 or 4 fingers for forward, backward, left or right. Face the camera with the whole hand visible. Count the thumb. Release to a valid fist before applying another direction. Emergency Stop remains reachable during recovery.

## T4 profile v1

| Setting | Value and behavior |
| --- | --- |
| Selected capture | Integrated Camera, USB VID `04F2` and PID `B7B9`, DirectShow index 0 on the test laptop. Exact instance path supplied in local configuration. Request 640 × 480 BGR at 30 fps and reject frames with an unexpected size or format. |
| Recognition | Local CPU Hand Landmarker in IMAGE mode with room for two hands. Detection and presence thresholds are 0.50 so a second detected hand rejects the pose. Require one hand and a Left/Right classification score of at least 0.70. Treat reported per-point presence or visibility below 0.50 as unclear. This pinned model can leave those scores unset. |
| Pose | Use all 21 image landmarks. Require them within the inner 95% of the image, a wrist-to-middle-joint distance of at least 32 px and a projected area of at least 0.45 times that distance squared. The thumb uses the index-to-pinky palm axis. The other fingers use joint extension, curl and palm direction. Border, edge-on and ambiguous geometry produce no valid count. Orientation and hand size affect useful recognition range. |
| Stability | Continuously observe the same handedness and same extended-finger set for at least 60 ms for zero and 90 ms for a direction. Adjacent acquisitions must arrive within 120 ms. The smaller palm scale must be at least 60% of the larger, and the palm center must move at most 70% of the smaller scale between frames. A gap, pose change, ambiguous result, or 5 fingers clears the held direction immediately. A direction settling after a valid zero preserves only that neutral step. |
| Freshness | Local profile uses a 240 ms capture/recognition deadline and polls results every 15 ms. Acquisition age starts before the blocking read. A slow first frame is discarded without reopening the device. Capture restart or acquisition timeout invalidates the previous stream epoch. The coordinator rejects old scope and repeated samples, and the independent command sink expires after 220 ms without renewal. |
| Preview | Raw BGR frames go to recognition. A separate encoder flips a copy horizontally and draws feedback for the corresponding frame. Only bounded latest frames are retained. The existing protected webcam WebSocket carries JPEG with v1 frame metadata. The browser displays those pixels without changing the recognition or direction mapping. |

## Verification

The selected Windows laptop camera returned 640 × 480 frames through DirectShow on two independent opens. With 45 warmed sequential observations and no operator poses, camera reads took 79.5 ms median and 97.6 ms maximum. CPU landmark processing took 16.1 ms median and 30.0 ms maximum. JPEG encoding took 1.1 ms median and 2.1 ms maximum. The first frame took 1.91–2.34 seconds including device setup. These observations informed the local profile deadline. Lighting, native buffering and concurrent workloads can change latency.

```powershell
$env:LAF_TEST_GESTURE_ASSETS = (Resolve-Path '.local-runtime/assets').Path
& $visionPython -m pytest backend/tests/test_gestures.py backend/tests/test_webcam.py backend/tests/test_motion_process.py -q
$env:LAF_TEST_PYTHON = $visionPython
$env:LAF_TEST_WEBCAM_DEVICE_PATH = $env:LAF_WEBCAM_DEVICE_PATH
Push-Location frontend
node node_modules/next/dist/bin/next build
node node_modules/@playwright/test/cli.js test e2e/records.spec.ts --workers=1 -g 'selected webcam|selected Windows webcam'
Pop-Location
```

Recorded-image checks exercise the pinned landmarker with both original and reflected single-hand images, a two-hand image, and a no-hand frame. The replay covers both handedness labels, thumb, counts 0–5, orientation, partial and ambiguous input, sample ordering, four directions, stop on transition and release, independent capture and recognition loss, recovery, and Controller isolation. Pose mapping, partial occlusion, end-to-end responsiveness with an operator and a real device disconnect/reconnect still need a hands-on pass on the selected webcam. Reopening a capture and injecting loss during replay are separate observations.
