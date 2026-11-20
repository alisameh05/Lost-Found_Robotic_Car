# Windows DualShock 4 input

`local-controller-v1` uses a selected USB DualShock 4. Robot video, logical command output, AI readiness and Gestures use fixtures. Run this profile in records mode with an eligible saved Lost object.

## Select the device

Install the hash-locked Windows x64 Python 3.11 runtime using `./experiments/vision/setup.ps1`. The lock pins Pygame 2.6.1, and the adapter also requires its SDL 2.28.4 runtime. See the [locked dependencies](../experiments/vision/requirements.lock) and [notices](../experiments/vision/NOTICES.md).

Connect the selected controller with a USB data cable and run the discovery command below. A device entry shows the SDL instance, serial, Windows HID path and last valid USB report's tick and normalized input. Release the D-pad and Circle before starting. Copy the selected unit's serial to private local configuration.

```powershell
$visionPython = (Resolve-Path '.local-runtime/venv/Scripts/python.exe').Path
& $visionPython -m backend.app.controller
$env:LAF_SIMULATION_PROFILE = 'local-controller-v1'
$env:LAF_CONTROLLER_SERIAL = '<serial from the selected USB controller>'
& $visionPython -m backend.app
```

The adapter checks Sony VID `054C`, PID `05C4` or `09CC`, a matching serial and the Windows USB HID path. It requires the SDL HIDAPI profile with 16 digital buttons, six axes and no hats. A second unit with another serial cannot take over, and duplicate identities make the path unavailable. Change the selected unit through a disarmed backend restart. Verification currently targets a directly connected USB controller.

## Mapping and recovery

The pinned SDL 2.28.4 HIDAPI PS4 driver documents the USB report format. The D-pad hat values `0`, `4`, `6` and `2` mean Up, Down, Left and Right. Those directions yield forward, backward, left and right while held. Hat value `8` is a clean release. Diagonal hat values stop without establishing neutral. The Circle bit overrides the D-pad and invokes Emergency Stop. [SDL PS4 input decoder](https://github.com/libsdl-org/SDL/blob/release-2.28.4/src/joystick/hidapi/SDL_hidapi_ps4.c)

The worker updates SDL and drains a bounded batch of USB reports every 15 ms with background joystick input enabled. It requires a valid 64-byte USB state report with an advancing device tick to refresh input. It preserves stop and Circle transitions when later reports arrive in the same batch. A fresh Circle report retains stop-only authority in the same session if a disconnect or control change occurs before processing. Movement samples expire after 180 ms and carry a connection generation and coordinator scope. The browser still needs a current controlling lease, a focused and usable workspace, and fresh displayed video. Following controller loss, reconnect the selected unit, reacquire control, acknowledge the failure, choose Resume, release the D-pad, then hold a direction. Circle release leaves Emergency Stop recovery in place. The UI Emergency Stop remains available in either mode.

## Verification

The Windows discovery smoke check loaded Pygame 2.6.1 and SDL 2.28.4 and returned zero qualifying devices. Windows reported virtual gamepad buses. The selected physical unit was unavailable. The mapping above comes from the pinned SDL source. Actual USB identity, button and diagonal observations, native background polling, disconnect and reconnect, and timing from a physical press or removal to logical STOP require a hands-on run.

The deterministic tests use synthetic USB reports through the device polling boundary and the actual coordinator, protected records service and simulated command device. They cover the four directions, release, conflicts, ambiguous identity, a second device, removal, a stalled poll, replayed report ticks, held input across recovery, browser focus and Circle during Pause, blocked inference and a blocked writer. The timeout bounds the age of a report using the previous poll's monotonic timestamp.
