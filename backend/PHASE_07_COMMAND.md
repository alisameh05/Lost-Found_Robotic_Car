# Phase 07 Uno command build and verification

## Build and profile

Build with Arduino CLI 1.6.0, Arduino AVR Boards 1.8.8, AVR GCC 7.3.0-atmel3.6.1-arduino7 and the core's EEPROM library 2.0. The target is `arduino:avr:uno`. Windows BLE uses Bleak 3.1.0. The Classic COM adapter uses pySerial 3.5. The dedicated sketch lives under [firmware/uno](../firmware/uno). The [T6 wire contract](../firmware/UNO_COMMAND.md) is version 1.

```powershell
arduino-cli core install arduino:avr@1.8.8
$unoBuild = Join-Path ([System.IO.Path]::GetTempPath()) 'laf-uno-fixture-build'
python firmware/build_uno.py firmware/uno/disabled-output.fixture.json $unoBuild
```

Use a new build directory for each image you retain. The build emits `uno.ino.hex` and `build.json`. The controller reports a 32-byte build ID derived from the target, pins, source, build script and exact logical mapping bytes. The generated artifact maps this ID to the SHA-256 of the HEX and the mapping. The device handshake checks the ID. Retain the installed-image hash and flash procedure in the selected build record.

The checked-in `uno-disabled-output-v1` mapping uses the USB UART at 115200 baud and touches no motor pins. Its packet, challenge, logical expiry and nominal hardware watchdog times are 25, 180, 220 and 120 ms. The fixture HEX SHA-256 is `bc4c139bd3e1422c5a55f385b50f804430db99df795733b255f0e704a6cad98d` and its build ID is `5e9a57f68bf8ce6159545690bde6775faff6a22da95f86e30989e1310d358799`. It used 4,508 bytes of flash and 363 bytes of static RAM. The D2/D3 UART and motor-output branches also compiled at 9600, 19200 and 38400 baud with synthetic mappings.

A selected Device build requires a local v1 mapping with `kind: "Device"`, a new `profile_id` and the five numeric serial and timer fields from the fixture schema. Enter `serial_rx_pin` and `serial_tx_pin` in the confirmed D2/D3 order and record the measured HC-05 UART baud. The interrupt-driven driver uses Timer2, leaving Timer0 for the watchdog clock. Valid motor PWM enable pins are D5, D6, D9 and D10. The local motor-test sketch lists D5/D6 enables and D11/D10/D9/D8 direction pins as reference.

Enter the two `enable_pins` and `enable_active_high` booleans, four `direction_pins`, five rows each of `direction_levels` and `duty` in disabled, forward, backward, left and right order, two measured `reset_enable_levels`, and `reset_evidence_sha256`. The reset evidence covers the driver enable levels from reset through boot and watchdog reset. Apply the same order to the left and right motor enables and duty columns. Use the team-confirmed pin levels, PWM and reset behavior. The generated output code drives the configured disabled levels first, sets direction with both enables disabled, and then applies the configured duty.

Follow the [Device startup bundle](PHASE_07_DEVICE_STARTUP.md) for evidence and values. Set the selected BLE identity and address type in the private manifest. Put the generated Device `build.json` under `device/artifacts/<sha256>` and reference it as `hc05_uno.build_artifact_sha256`. Set `hc05_uno.uno` and `logical_output_sha256` to the corresponding fields from the build. Add the exact logical mapping, reset evidence and wire contract as hashed artifacts. The firmware reopens disarmed after reset. Reconcile and requalify the build and profile together before changing them.

Windows serial reads and writes have explicit time bounds. Port enumeration and opening run on the serial worker. Graceful shutdown retains exclusive backend ownership until the Windows driver returns and the worker closes.

## Verification

```powershell
python -m pytest backend/tests/test_uno_wire.py backend/tests/test_uno_serial.py
python -m pytest backend/tests/test_motion.py backend/tests/test_motion_process.py backend/tests/test_realtime.py
```

The tests compile the same command parser and watchdog for the host. Use a working GCC-compatible C++ compiler on PATH or set `LAF_UNO_HOST_CXX` to its executable. The protected workspace uses `fixture-v1` video and normalized input. Tests drive and release each direction in both modes, exercise UI Emergency Stop and Controller Circle, and check that a reset pauses the search until acknowledgment, Resume, neutral input and a fresh hold. Fault cases cover malformed, partial and oversized traffic, corrupt or replayed frames, late or missing acknowledgments, invalid correlations and serial loss. The backend process-loss test delivers one already queued renewal after termination, observes independent firmware expiry without STOP, rejects replay after expiry and checks that restart reconciles the session as Interrupted.

A host register simulation exercised all 256 received byte values, stop-bit errors, receive overflow, and a bounded 60-byte transmit queue for both D2/D3 orders at all three supported rates. Timing on the actual Uno and HC-05 remains open.

In one Windows fixture run, the queued delivery occurred within the 0.1 ms reporting resolution of backend termination. The logical output was observed disabled 234 ms after termination, with a configured 220 ms lease and host polling overhead. The timestamp comes from the native host fixture and its external polling loop.

The selected Uno initially reported a bootloader synchronization failure. After the operator restored Arduino IDE uploads and closed the IDE, Arduino CLI uploaded and verified the disabled-output image on COM7. A USB wire v1 HELLO returned the expected build ID and boot generation 2. The subsequent STATUS matched that boot, its request sequence and challenge, and confirmed disarmed, disabled logical output.

The operator's reference sketch shows HC-05 TX connected to Uno D2 and HC-05 RX connected to Uno D3. The later sketch supplied for troubleshooting opens the Uno hardware serial port at 9600. The separate D2/D3 bench image uses 9600 as a candidate rate and keeps motor outputs disabled. Arduino CLI uploaded and verified that image on COM7. Its build ID is `97e06ecff0986e13c4e0f8daa6cf6d364baba0c164a895ed734b6e0cfed60ee6` and its HEX SHA-256 is `fff7d19a20010007e8aac24b5b500b4ab1777498c709c7f8c6246d98e85c27ce`.

Windows detected a live BLE advertisement named HC-05 and listed an FFE0 service with an FFE1 characteristic supporting writes and notifications. Classic discovery found no matching device, and Windows created no outgoing Bluetooth COM port. The operator connected in the phone's BLE terminal and then showed the phone disconnected for the Windows retry.

The Windows bench received a wire v1 HELLO with the expected build ID and boot generation 175, followed by a correlated disarmed STATUS. Each 28-byte command was sent as a single GATT write. The host observed write completion at 250 ms for HELLO and 93 ms for STATUS. This confirms communication over the D2/D3 UART at 9600 for that exchange. A prior split write returned no Uno reply, and two subsequent attempts to test directions and STOP failed during GATT service discovery. BLE reconnect reliability, direction and STOP acknowledgments, and stop timing remain unverified.

### Windows BLE bench, 2026-11-22

The operator confirmed USB power, the existing HC-05 wiring, the motor battery disconnected, and the phone BLE terminal disconnected. The retained D2/D3 bench HEX matched the SHA-256 above. With Bleak 3.1.0 on Windows, the probe matched the configured module's Windows LE identity to a live public-address advertisement. All completed sessions verified the same disabled-output build ID and boot generation 176 before sending ARM. The probe sent one 28-byte request per write with response and assembled notifications into wire v1 frames. Timings below are from the host immediately before the write to receipt of a correlated Uno acknowledgment, unless otherwise stated.

| Check | Observation |
| --- | --- |
| Fresh disarmed sessions | Two of three sessions completed HELLO and STATUS. HELLO took 187–188 ms and STATUS took 109–110 ms. One session timed out during GATT discovery. |
| Logical directions and STOP | The first two attempts timed out during GATT discovery. The third session completed ARM, DRIVE and STOP for forward, backward, left and right. DRIVE took 110–172 ms. STOP took 109–187 ms and each reply reported disarmed and logical output zero. |
| Parser resynchronization and STOP | The first two attempts disconnected before notification subscription completed. The third session sent the 29-byte overflow prefix and 28-byte STOP as separate writes. From prefix write start to the correlated disarmed STOP acknowledgment took 204 ms. |
| Late DRIVE after no renewal or STOP | After an acknowledged DRIVE, the probe withheld input for 240 ms and received no reply to the new-sequence DRIVE. A fresh HELLO and STATUS succeeded. This checks the outcome at the command link. Independent logical output timing at the Uno and backend loss over BLE with queued traffic still need direct measurements. |
| Reconnect with phone Bluetooth off | After the USB power cycle and after the operator turned off the phone's Bluetooth radio, all three fresh sessions completed HELLO and STATUS at boot 177. Across 18 STATUS samples in each condition, acknowledgments took 109–203 ms with the default settings and 78–125 ms after requesting the Windows throughput-optimized preference. Windows still reported a 30 ms connection interval on those sessions. |
| Windows already connected | The probe opened the selected Windows BLE identity directly from a single Windows device match. HELLO and STATUS each acknowledged in 125 ms at boot 179. On this connection the temporary Windows throughput request changed the reported interval from 30 ms to 15 ms and peripheral latency from 10 events to zero. All four logical directions and prefixed STOPs were acknowledged. DRIVE took 78–141 ms and prefix through STOP acknowledgment took 109–141 ms. The request was released at the end of the test. |
| Application GATT adapter | Four opened sessions on the same motor-disabled build completed correlated disarmed HELLO, STATUS and prefixed STOP at boot 179. HELLO took 203–219 ms, STATUS 125–141 ms, and STOP 172–219 ms. These checks used the application transport and command session, with diagnostic deadlines and no Device profile or motion authority. |

The Windows backend suites passed 154 tests, including the BLE transport and Device selection fixtures and the fixture backend-loss expiry test. The Devices, search lifecycle and search recovery browser fixtures passed 22 tests. The disabled-output USB fixture rebuilt to the recorded HEX checksum.

[Issue #90](https://github.com/alisameh05/Lost-Found_Robotic_Car/issues/90) records BLE GATT as the selected Windows transport for this module. The application adapter uses the versioned wire contract and the same command coordinator for both transport selections. The 350 ms challenge and 220 ms expiry in the bench image total 570 ms before detection or mechanical stopping. Even the optimized run's observed 141 ms acknowledgment, the 63 ms UART reserve at 9600 and the minimum positive renewal interval would require at least 553 ms under the current conservative Device calculation, before mechanical margin. These are observations and a lower bound under that calculation, with no qualified timing profile. The selected Device still needs measured BLE bounds, logical direction and reset evidence, a selected Device firmware image, and a stop allocation with positive mechanical margin. SM-2 requires external event-to-wheel-stop timing.
