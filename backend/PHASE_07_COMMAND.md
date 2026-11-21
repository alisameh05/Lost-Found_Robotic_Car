# Phase 07 Uno command build and verification

## Build and profile

Build with Arduino CLI 1.6.0, Arduino AVR Boards 1.8.8, AVR GCC 7.3.0-atmel3.6.1-arduino7 and the core's EEPROM library 2.0. The target is `arduino:avr:uno`. The Windows adapter uses pySerial 3.5. The dedicated sketch lives under [firmware/uno](../firmware/uno). The [T6 wire contract](../firmware/UNO_COMMAND.md) is version 1.

```powershell
arduino-cli core install arduino:avr@1.8.8
$unoBuild = Join-Path ([System.IO.Path]::GetTempPath()) 'laf-uno-fixture-build'
python firmware/build_uno.py firmware/uno/disabled-output.fixture.json $unoBuild
```

Use a new build directory for each image you retain. The build emits `uno.ino.hex` and `build.json`. The controller reports a 32-byte build ID derived from the target, pins, source, build script and exact logical mapping bytes. The generated artifact maps this ID to the SHA-256 of the HEX and the mapping. The device handshake checks the ID. Retain the installed-image hash and flash procedure in the selected build record.

The only checked-in output mapping is `uno-disabled-output-v1`. It touches no motor pins. Its fixture baud is 115200 and its packet, challenge, logical expiry and nominal hardware watchdog times are 25, 180, 220 and 120 ms. The fixture HEX SHA-256 is `77e9c9509835a8b38b344bbb4493205c24cc520adfcfbeea4e7ab0ed81a480a1` and its build ID is `912268d0c3881a00a67db8535f481e692b74c6dba5cc12fc25ac77e5a5b9bdff`. The build used 4,490 bytes of flash and 363 bytes of static RAM. The motor output branch also compiled with a temporary synthetic pin and PWM map.

A selected Device build requires a local v1 mapping with `kind: "Device"`, a new `profile_id` and the five numeric serial and timer fields from the fixture schema. Enter the two `enable_pins` and `enable_active_high` booleans, four `direction_pins`, five rows each of `direction_levels` and `duty` in disabled, forward, backward, left and right order, two measured `reset_enable_levels`, and `reset_evidence_sha256`. The reset evidence covers the driver enable levels from reset through boot and watchdog reset. Apply the same order to the left and right motor enables and duty columns. Use the team-confirmed pin levels, PWM and reset behavior. The generated output code drives the configured disabled levels first, sets direction with both enables disabled, and then applies the configured duty.

Follow the [Device startup bundle](PHASE_07_DEVICE_STARTUP.md) for evidence and values. Set the selected Windows outgoing serial COM assignment and its exact Bluetooth instance identity. Put the generated Device `build.json` under `device/artifacts/<sha256>` and reference it as `hc05_uno.build_artifact_sha256`. Set `hc05_uno.uno` and `logical_output_sha256` to the corresponding fields from the build. Add the exact logical mapping, reset evidence and wire contract as hashed artifacts. The firmware reopens disarmed after reset. Reconcile and requalify the build and profile together before changing them.

## Verification

```powershell
python -m pytest backend/tests/test_uno_wire.py backend/tests/test_uno_serial.py
python -m pytest backend/tests/test_motion.py backend/tests/test_motion_process.py backend/tests/test_realtime.py
```

The tests compile the same command parser and watchdog for the host. Use a working GCC-compatible C++ compiler on PATH or set `LAF_UNO_HOST_CXX` to its executable. The protected workspace uses `fixture-v1` video and normalized input. Tests drive and release each direction in both modes, exercise UI Emergency Stop and Controller Circle, and check that a reset pauses the search until acknowledgment, Resume, neutral input and a fresh hold. Fault cases cover malformed, partial and oversized traffic, corrupt or replayed frames, late or missing acknowledgments, invalid correlations and serial loss. The backend process-loss test delivers one already queued renewal after termination, observes independent firmware expiry without STOP, rejects replay after expiry and checks that restart reconciles the session as Interrupted.

In one Windows fixture run, the queued delivery occurred within the 0.1 ms reporting resolution of backend termination. The logical output was observed disabled 234 ms after termination, with a configured 220 ms lease and host polling overhead. The timestamp comes from the native host fixture and its external polling loop.

The selected Windows HC-05 connection, measured logical direction and reset mapping, selected Device firmware image, and component stop allocation remain open. No serial port was visible on this Windows host during verification. The Device link requires the selected measured bundle and current acknowledgments. The selected camera path is tracked separately. SM-2 requires external event-to-wheel-stop timing.
