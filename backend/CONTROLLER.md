# Windows DualShock 4 input

`local-controller-v1` uses a selected USB DualShock 4. Robot video, logical command output, AI readiness and Gestures use fixtures. Run this profile in records mode with an eligible saved Lost object.

## Select the device

Install the hash-locked Windows x64 Python 3.11 runtime using `./experiments/vision/setup.ps1`. The lock pins Pygame 2.6.1, and the adapter also requires its SDL 2.28.4 runtime. See the [locked dependencies](../experiments/vision/requirements.lock) and [notices](../experiments/vision/NOTICES.md).

Connect the selected controller with a USB data cable and run the discovery command below. A device entry shows the SDL instance, serial, Windows HID path and any currently held buttons in the profile. Release the D-pad and Circle before starting. Copy the selected unit's serial to private local configuration.

```powershell
$visionPython = (Resolve-Path '.local-runtime/venv/Scripts/python.exe').Path
& $visionPython -m backend.app.controller
$env:LAF_SIMULATION_PROFILE = 'local-controller-v1'
$env:LAF_CONTROLLER_SERIAL = '<serial from the selected USB controller>'
& $visionPython -m backend.app
```

The adapter checks Sony VID `054C`, PID `05C4` or `09CC`, a matching serial and the Windows USB HID path. It requires the SDL HIDAPI profile with 16 digital buttons, six axes and no hats. A second unit with another serial cannot take over, and duplicate identities make the path unavailable. Change the selected unit through a disarmed backend restart. Verification currently targets a directly connected USB controller.

## Mapping and recovery

The SDL 2.28.4 HIDAPI PS4 driver decodes the physical D-pad hat into four digital joystick buttons. The pinned mapping is Up `11`, Down `12`, Left `13`, Right `14` and Circle `1`. Up, Down, Left and Right yield forward, backward, left and right while held. Release all directions to stop and establish neutral. Diagonals and conflicts stop without establishing neutral. Circle overrides D-pad input and invokes Emergency Stop. [SDL PS4 input decoder](https://github.com/libsdl-org/SDL/blob/release-2.28.4/src/joystick/hidapi/SDL_hidapi_ps4.c) · [SDL button definitions](https://github.com/libsdl-org/SDL/blob/release-2.28.4/include/SDL_gamecontroller.h)

The worker updates SDL and polls current state every 15 ms with background joystick input enabled. It waits for SDL to report an initial input before using a newly opened instance. Samples expire after 180 ms and carry a connection generation and coordinator scope. The browser still needs a current controlling lease, a focused and usable workspace, and fresh displayed video. Following controller loss, reconnect the selected unit, reacquire control, acknowledge the failure, choose Resume, release the D-pad, then hold a direction. Circle release leaves Emergency Stop recovery in place. The UI Emergency Stop remains available in either mode.

## Verification

The Windows discovery smoke check loaded Pygame 2.6.1 and SDL 2.28.4 and returned zero qualifying devices. Windows reported virtual gamepad buses. The selected physical unit was unavailable. The mapping above comes from the pinned SDL source. Actual USB identity, button and diagonal observations, native background polling, disconnect and reconnect, and timing from a physical press or removal to logical STOP require a hands-on run.

The deterministic tests use the device polling boundary and the actual coordinator, protected records service and simulated command device. They cover the four directions, release, conflicts, ambiguous identity, a second device, removal, stale polling, held input across recovery, browser focus and Circle during Pause, blocked inference and a blocked writer. The timeout measures the age of a completed SDL polling observation. SDL's state API does not expose the age of the last unchanged USB report.
