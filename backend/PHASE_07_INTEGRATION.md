# Phase 07 connected integration handoff

Handoff version 1 · Comparison baseline `f18dda8227c7831046479505715349ac94755734` · [Integration ticket #93](https://github.com/alisameh05/Lost-Found_Robotic_Car/issues/93).

The operator confirmed that the components were tested individually. The connected operator journey is open. The Windows application data directory has no measured Device bundle, and the recorded HC-05 timing exceeds the Device stop allocation. Both control modes require the shared command, video, display and AI paths for Start. A successful Start still requires neutral and a fresh held input before movement. Saved records, Health and Emergency Stop are available with Device mode disarmed.

## Selected connections

| Connection | Existing evidence | Open evidence and next owner |
| --- | --- | --- |
| Windows laptop and offline YOLOE | [Phase 06 replay](PHASE_06.md) and [model configuration](VISION.md) record the selected CUDA checkpoint, reference and ROI, asset hashes, local runtime and measured replay load. | Integration team records the current Windows, driver, dependency and asset inventory and the simultaneous load with WAN disconnected and Bluetooth and protected local Wi-Fi available. |
| Gestures | [DirectShow and MediaPipe profile](GESTURES.md#t4-profile-v1) and Phase 06 replay. | Operator and integration team confirm the selected webcam identity in the private bundle and verify live hand mapping, neutral and loss/recovery through Device mode. |
| Controller | [USB DualShock 4 profile](CONTROLLER.md) and Phase 06 replay. | Operator and integration team confirm the selected USB serial and verify held D-pad, conflict, Circle and unplug/reconnect through Device mode. |
| HC-05 and Uno | [Selected Windows BLE GATT and wire v1 bench](PHASE_07_COMMAND.md#windows-ble-bench-2026-11-22). Logical directions and STOP were acknowledged on a motor-disabled image. The later selected-link proximity image also has disabled motor outputs. | Firmware and integration teams need the selected output-enabled build and reset/output evidence, a stable BLE run, and a passing measured watchdog and STOP allocation with the selected telemetry load. |
| ESP32-CAM and displayed video | The [pinned AI Thinker build](../firmware/ESP32_CAMERA.md#selected-device-bench-record) returned authenticated clock replies. After the address repair, the backend recorded 77–108 ms for received clock replies and 186 ms for one received frame response. The configured bench bounds accepted zero acquisitions. [PR #97](https://github.com/alisameh05/Lost-Found_Robotic_Car/pull/97) | Integration team verifies the unique protected-LAN endpoint and the selected build, then measures sustained fresh captures and browser draw/acknowledgment under simultaneous load. |
| HC-SR04 over Uno command v1 | [Selected Uno advisory bench](../firmware/UNO_PROXIMITY.md) saw Warning and Clear on USB. BLE produced Warning with ACK interruptions. | Firmware and integration teams record reference distances and ages, then qualify repeated Warning and Clear on the selected production build and BLE endpoint. Until then the Device advisory is Unknown. |

## Reproduce Device readiness and the connected journey

1. Use the pinned [Phase 06 Windows install](PHASE_06.md#install-once-and-run-offline), [vision lock and notices](../experiments/vision/NOTICES.md), [backend lock](requirements.lock), and [frontend lock](../frontend/package-lock.json). Retain the commit SHA, actual tool/core versions, local input profiles, app and asset digests, and the Uno and ESP32-CAM build artifacts. Use the owning [Uno](PHASE_07_COMMAND.md#build-and-profile) and [ESP32-CAM](../firmware/ESP32_CAMERA.md#build-and-connect) build procedures. The ESP32-CAM build assigns a fresh build ID, so retain the deployed image and its matching upload and peer-handshake record.
2. Place the measured configuration and hashed artifacts in the [private Device startup bundle](PHASE_07_DEVICE_STARTUP.md#startup-bundle-v1). Record the exact IDs and protocol versions privately. Use the manifest for input selection. Keep the camera bearer token and private frames in the protected local data directory. Change a selected identity, bound, endpoint, protocol or build only during a disarmed restart and revalidate the paths that depend on it.
3. Disconnect internet access after setup. Keep the selected Bluetooth connection and protected WLAN available. Start the backend with `LAF_BACKEND_MODE=device` and `LAF_YOLOE_ASSETS` and `LAF_GESTURE_ASSETS` pointing at the verified local assets. Start the frontend with `LAF_MODE=records`. Check Devices, the published safe profile ID, local records and the disarmed state. For an invalid selection, record the affected readiness cause and verify that Start is blocked only for modes requiring that path. Keep the separate [Phase 06 fixture](PHASE_06.md) available as a comparison.
4. For each selected mode, open Search Setup for a saved Lost reference, verify a fresh drawn preview, acquire control, and Start with input held to check that Start remains disarmed. Establish neutral, then hold and release Forward, Backward, Left and Right. Hold an input in the inactive mode and check that it has no authority. For Gestures, check both handednesses and thumb counting, changing or ambiguous poses, occlusion and selected webcam disconnect. For Controller, check D-pad conflict, Circle and the selected controller unplug/reconnect. Use keyboard Emergency Stop in each selected mode.
5. In each mode, exercise deliberate Pause/Resume and check that recovery requires neutral and a fresh hold. If the selected advisory is calibrated, verify silent Warning and consistent clearing while observing the same required readiness and movement permission. Review a local match, compare the source acquisition identity, box and captured pixels, save the outcome, and reopen the exact evidence after restarting the application.

## Independent faults and timing

Apply one fault per run while observing the active session and logical output. Record the cause, failure occurrence ID, loss/release detection, backend revocation, STOP acknowledgment or last-valid Uno lease expiry, logical output change and committed Paused state. Observe effective Paused before durability completes when a writer is held. For backend termination, retain the outstanding challenge and queued packet trace, observe expiry with STOP unavailable, and check disarmed startup and Interrupted reconciliation. Check both orders of restored readiness and acknowledgment. Reconnect or restore with an input still held, then require explicit Resume, neutral and a fresh hold before renewed output.

| Inject independently | Existing deterministic seam |
| --- | --- |
| Lost, invalid, late or replayed command ACK, loss of command transport, and backend termination with queued traffic | `test_uno_serial.py`, `test_motion_process.py` pass logical commands through the native firmware peer or independent lease fixture. |
| Selected input loss or invalid input, camera disconnect or freeze or epoch change, and stale display with open socket | `test_controller.py`, `test_webcam.py`, `test_camera_link.py`, `test_realtime.py` and protected Chromium. |
| Focus, visibility or lease loss, blocked storage or inference, stalled event or video consumers, and recovery ordering | `test_realtime.py`, `test_local_matching.py`, protected Chromium and the Phase 06 replay. |

Report each occurrence with the evidence kind (`Fixture`, `Device` or external), test condition, private artifact reference and result. The backend budget takes the largest applicable detection deadline plus outstanding challenge lifetime and firmware expiry. Compare that allocation with measured bounds for scheduling, wire transfer, queued traffic and measurement uncertainty. Leave a positive mechanical margin inside 500 ms. The motor-disabled 350 ms challenge plus 220 ms expiry already totals 570 ms before detection. Even the earlier optimized observed 141 ms ACK at 9600 baud with a 63 ms UART reserve and a minimum positive renewal interval requires at least 553 ms under the current validation rule. The telemetry-bearing BLE bench also observed interruptions. The selected stop budget remains open. Keep external event-to-wheel-stop and battery endurance open for separately measured evidence.

For SM-4, with active control and YOLOE inference, record an observable event in the robot camera's view and the laptop display together on one recording. Retain event and first visible display frame indices or timestamps, recording rate, uncertainty, camera/display acquisition identity, network arrangement and workload. Compare the conservative interval to 500 ms. Both control modes' under-load measurements are open.

For NFR-2, keep the operator at one desk for the route through two adjacent furnished rooms. Record the desk, doorway, distances, obstacles, protected wireless arrangement and checkpoints. Keep obstacles stationary and people clear of the path. At each checkpoint log observed command delivery and fresh drawn video separately, including any dropout, affected path, time and recovery. The connected route is open.

## Repeatable software verification

Run the backend checks and both owning firmware builds on the revision containing this handoff. Record its `git rev-parse HEAD` and use the comparison baseline above to investigate inherited failures. The combined Device replay is `test_device_search_drives_and_reviews_the_displayed_camera_acquisition` in `tests/test_uno_serial.py`. It exercises both selected modes across the protected API and sockets, the serial adapter and native Uno peer, the production camera adapter with a clock/frame peer, and a spawned matching fixture. Its Python workspace client emulates display acknowledgment. The separate Chromium camera fixture draws the preview in Search Setup and checks the last image after link loss. [Backend checks](README.md#verify) · [Chromium fixture](../frontend/e2e/records.spec.ts)

From `frontend` in PowerShell 7, use the application runtime installed under `.local-runtime` and the verified local assets.

```powershell
$env:npm_config_script_shell = (Get-Process -Id $PID).Path
$env:LAF_TEST_PYTHON = (Resolve-Path '../.local-runtime/venv/Scripts/python.exe').Path
$env:LAF_TEST_PHASE06_ASSETS = (Resolve-Path '../.local-runtime/assets').Path
$env:LAF_TEST_YOLOE_ASSETS = $env:LAF_TEST_PHASE06_ASSETS
npm.cmd run verify -- -- --workers=1
```

Keep the physical webcam browser case open when its selected path is unavailable. Record counts and any reproduced baseline failures with the run evidence.

### November 23 verification record

| Check | Result and evidence |
| --- | --- |
| Uno fixture build | Two Arduino CLI 1.6.0 builds reproduced the disabled-output Uno HEX SHA-256 `7981aad4f136b8c658a339f98adfac271c64fd088172faf883c1d93a6be0bf17`. The local build artifacts are under `.local-runtime/issue93-uno-*`. |
| ESP32-CAM compile-only | The pinned AI Thinker build compiled with placeholder settings. Image SHA-256 `2bc48abda0533129e86c46f48d6f610a11553dcc04a33d25b2110825bf5f1ee8`. The local artifact is under `.local-runtime/issue93-camera-*`. |
| Combined protected Device replay | Both modes passed in the final serial suite of 49 tests. The loopback client emulates a workspace acknowledging camera frame IDs. In both modes the fixture verifies disarmed Start with held input, neutral and a fresh hold, all four directions and releases, inactive-mode isolation, stale acknowledgments during advancing acquisitions, typed Pause and deliberate recovery. Matching uses a spawned fixture and compares the analyzed acquisition with the saved frame identity, box and PNG pixels after restart. |
| Backend verification | Full pytest recorded 485 passes, two asset-gated skips and one failure. The unchanged `test_saved_search_lifecycle_and_historical_retry` received `409 REVISION_CONFLICT` on Stop and passed on a focused rerun. The Phase 06 continuity test that previously timed out passed in the full run. Ruff, mypy and the backend v1 contract export check passed. |
| Native backend asset checks | The recorded Hand Landmarker test passed with local assets. The pinned YOLOE worker returned results on CUDA, then its shutdown check reported `Local YOLOE worker has not exited`. The standalone retry passed. |
| Frontend and Chromium | Contract parity and 69 fixture assertions, lint, type checking, 83 unit tests and the production build passed. Chromium recorded 148 passes, one skip for the selected physical webcam and two failures. The unchanged saved-search recovery case reported `REVISION_CONFLICT` on Stop and passed on retry. Both Phase 06 selected-mode replays passed. The unchanged Phase 06 native workload paused with `InputUnavailable` in both runs. On retry the 10-second sample window recorded zero inference exchanges. The initial failures are under `frontend/test-results`, with the retry trace under `.local-runtime/results/issue93-chromium-retry`. |
