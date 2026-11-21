# Phase 07 Uno command build and verification

## Build and profile

Build with Arduino CLI 1.6.0, Arduino AVR Boards 1.8.8, AVR GCC 7.3.0-atmel3.6.1-arduino7 and the core's EEPROM library 2.0. The target is `arduino:avr:uno`. The Windows adapter uses pySerial 3.5. The dedicated sketch lives under [firmware/uno](../firmware/uno). The [T6 wire contract](../firmware/UNO_COMMAND.md) is version 1.

```powershell
arduino-cli core install arduino:avr@1.8.8
$unoBuild = Join-Path ([System.IO.Path]::GetTempPath()) 'laf-uno-fixture-build'
python firmware/build_uno.py firmware/uno/disabled-output.fixture.json $unoBuild
```

Use a new build directory for each image you retain. The build emits `uno.ino.hex` and `build.json`. The controller reports a 32-byte build ID derived from the target, pins, source, build script and exact logical mapping bytes. The generated artifact maps this ID to the SHA-256 of the HEX and the mapping. The device handshake checks the ID. Retain the installed-image hash and flash procedure in the selected build record.

The checked-in `uno-disabled-output-v1` mapping uses the USB UART at 115200 baud and touches no motor pins. Its packet, challenge, logical expiry and nominal hardware watchdog times are 25, 180, 220 and 120 ms. The fixture HEX SHA-256 is `bc4c139bd3e1422c5a55f385b50f804430db99df795733b255f0e704a6cad98d` and its build ID is `5e9a57f68bf8ce6159545690bde6775faff6a22da95f86e30989e1310d358799`. It used 4,508 bytes of flash and 363 bytes of static RAM. The D2/D3 UART and motor-output branches also compiled at 9600, 19200 and 38400 baud with synthetic mappings.

A selected Device build requires a local v1 mapping with `kind: "Device"`, a new `profile_id` and the five numeric serial and timer fields from the fixture schema. Enter `serial_rx_pin` and `serial_tx_pin` in the confirmed D2/D3 order and record the measured HC-05 UART baud. The interrupt-driven driver uses Timer2, leaving Timer0 for the watchdog clock. Valid motor PWM enable pins are D5, D6, D9 and D10. The local motor-test sketch lists D5/D6 enables and D11/D10/D9/D8 direction pins as reference.

Enter the two `enable_pins` and `enable_active_high` booleans, four `direction_pins`, five rows each of `direction_levels` and `duty` in disabled, forward, backward, left and right order, two measured `reset_enable_levels`, and `reset_evidence_sha256`. The reset evidence covers the driver enable levels from reset through boot and watchdog reset. Apply the same order to the left and right motor enables and duty columns. Use the team-confirmed pin levels, PWM and reset behavior. The generated output code drives the configured disabled levels first, sets direction with both enables disabled, and then applies the configured duty.

Follow the [Device startup bundle](PHASE_07_DEVICE_STARTUP.md) for evidence and values. Set the selected Windows outgoing serial COM assignment and its exact Bluetooth instance identity. Put the generated Device `build.json` under `device/artifacts/<sha256>` and reference it as `hc05_uno.build_artifact_sha256`. Set `hc05_uno.uno` and `logical_output_sha256` to the corresponding fields from the build. Add the exact logical mapping, reset evidence and wire contract as hashed artifacts. The firmware reopens disarmed after reset. Reconcile and requalify the build and profile together before changing them.

Windows serial reads and writes have explicit time bounds. Port enumeration and opening run on the serial worker. Graceful shutdown retains exclusive backend ownership until the Windows driver returns and the worker closes.

## Verification

```powershell
python -m pytest backend/tests/test_uno_wire.py backend/tests/test_uno_serial.py
python -m pytest backend/tests/test_motion.py backend/tests/test_motion_process.py backend/tests/test_realtime.py
```

The tests compile the same command parser and watchdog for the host. Use a working GCC-compatible C++ compiler on PATH or set `LAF_UNO_HOST_CXX` to its executable. The protected workspace uses `fixture-v1` video and normalized input. Tests drive and release each direction in both modes, exercise UI Emergency Stop and Controller Circle, and check that a reset pauses the search until acknowledgment, Resume, neutral input and a fresh hold. Fault cases cover malformed, partial and oversized traffic, corrupt or replayed frames, late or missing acknowledgments, invalid correlations and serial loss. The backend process-loss test delivers one already queued renewal after termination, observes independent firmware expiry without STOP, rejects replay after expiry and checks that restart reconciles the session as Interrupted.

A host register simulation exercised all 256 received byte values, stop-bit errors, receive overflow, and a bounded 60-byte transmit queue for both D2/D3 orders at all three supported rates. Timing on the actual Uno and HC-05 remains open.

In one Windows fixture run, the queued delivery occurred within the 0.1 ms reporting resolution of backend termination. The logical output was observed disabled 234 ms after termination, with a configured 220 ms lease and host polling overhead. The timestamp comes from the native host fixture and its external polling loop.

Windows identified the selected Uno's USB bridge on COM5. The uploader reached the port and reported a bootloader synchronization failure. Windows had a cached Bluetooth Low Energy entry named HC-05 and reported no outgoing Bluetooth serial port. The selected Classic Bluetooth endpoint, D2/D3 RX/TX order and baud, logical direction and reset evidence, selected Device firmware image, and component stop allocation remain open. The Device link requires the selected measured bundle and current acknowledgments. The selected camera path is tracked separately. SM-2 requires external event-to-wheel-stop timing.
