# Uno command wire v1

The Windows backend owns motion authority. The Uno reports commanded logical motor output and armed state. An enabled build can also send independently framed [HC-SR04 advisory observations](UNO_PROXIMITY.md) over the same HC-05 link. The camera uses its own transport.

## Framing and fields

Serial uses binary 8N1 and no flow control. Use the baud rate in the selected build and measured profile. Each packet is a COBS-encoded payload and CRC followed by a zero delimiter. Empty delimited spans are ignored. The backend prefixes HELLO and STOP with 28 bytes of 0xff followed by a delimiter. This overflows and clears any abandoned request before a delimiter could complete it. There is one request in flight. The fixed receive bound is 28 bytes including delimiter for a request, and 60 bytes for a reply. Only the HELLO reply uses the longer form. Including the prefix, a HELLO or STOP occupies 57 bytes.

On Windows BLE, use service FFE0 and characteristic FFE1. Send each complete request as one GATT write with response. For HELLO and STOP, send the 29-byte prefix as a separate write before the request under the same deadline. Assemble FFE1 notifications as a bounded serial byte stream. GATT write completion confirms transport only. The Uno acknowledgment supplies protocol correlation and logical state.

| Byte offset | Type | Field |
| --- | --- | --- |
| 0 | u8 | Version, 1 |
| 1 | u8 | Request opcode or request opcode OR 0x80 for its acknowledgment |
| 2 | u32 LE | Uno boot generation |
| 6 | u32 LE | Control generation |
| 10 | u32 LE | Sequence or HELLO correlation nonce |
| 14 | u32 LE | Current challenge or HELLO accepted-sequence high-water mark |
| 18 | u32 LE | Next challenge, zero in requests |
| 22 | u8 | Logical direction, 0 disabled, 1 forward, 2 backward, 3 left, 4 right |
| 23 | u8 | Flags, zero in requests, 1 armed and 0 disarmed in acknowledgments |
| 24 | 32 bytes | Build ID in the HELLO acknowledgment only |
| 24 or 56 | u16 LE | CRC-16/CCITT-FALSE of the unencoded preceding bytes. Polynomial 0x1021, initial value 0xffff, no reflection and no final XOR. |

The DRIVE payload for boot 2, generation 3, sequence 4, challenge 5 and forward has CRC 0x8ba2. The complete wire frame is `04 01 04 02 01 01 02 03 01 01 02 04 01 01 02 05 01 01 01 01 01 01 02 01 03 a2 8b 00`.

## Operations

| Request | Acceptance and effect |
| --- | --- |
| 1 HELLO | A nonzero host nonce occupies sequence. Boot, control generation, challenge, direction and flags are zero. The Uno disables output and answers with the nonce, current boot and control high-water, accepted-sequence high-water, a new challenge, and build ID. |
| 2 STATUS | Current boot and challenge, next increasing sequence, zero generation and direction. Valid only while disarmed. Confirms disarmed state and rotates the challenge. |
| 3 ARM | Current boot and challenge, next increasing sequence, strictly higher nonzero control generation and zero direction. Valid only while disarmed. Starts an armed lease with output disabled. A separate authorized DRIVE is needed for movement. |
| 4 DRIVE | Current boot and challenge, next increasing sequence, current armed control generation and a direction from 1 through 4. Applies the commanded logical direction and renews the lease. |
| 5 STOP | A correctly framed v1 STOP with zero direction disables immediately, even with stale counters or after a reset. The Uno acknowledges only for its current boot and a sequence above its accepted high-water. It echoes the request challenge for correlation. |

All accepted operations issue a new, single-use challenge. The Uno starts each challenge at acknowledgment creation and evaluates it against its own monotonic time. Counter exhaustion disarms. Neither a replay nor an expired challenge can renew permission. The firmware persists boot generations in an alternating EEPROM journal and retains sequence and armed-generation high-water marks during that boot. STOP, expiry, and parser failure disable output and invalidate the armed generation. Recovery requires a higher ARM generation backed by a newly issued challenge. Changing the firmware or erasing EEPROM requires disarmed requalification and clearing the transport.

Every acknowledgment must match the expected opcode, sequence, boot, challenge, reported generation and commanded state within the configured acknowledgment deadline. HELLO additionally matches the build ID against the selected build artifact. A malformed packet, invalid fields, incomplete packet across its parser deadline, or overlong span invalidates permission. The Uno checks expiry with and without bytes arriving. It limits work per loop and only writes a reply when the UART buffer can accept the whole frame.

## Renewal and timing

The adapter accepts one renewal from the coordinator when the current Searching scope, held selected input, and owned browser lease with fresh acquisition and display are valid. STOP supersedes a pending renewal. The worker checks revocation and the deadline together before committing the single outstanding write. That write can reach the board before STOP or after backend loss. The device admits it only with a still-valid challenge, then expires under its own timer. An idle backend sends disarmed STATUS requests. Reconnect can restore diagnostics and must complete a disarmed HELLO exchange.

The selected Device profile supplies the measured baud, packet bound, acknowledgment and renewal budgets, challenge lifetime and firmware expiry. The disarmed HELLO deadline adds the wire time of its maximum-length exchange to the command acknowledgment deadline. The build adds an explicit partial-packet deadline and nominal hardware watchdog setting. Document actual clock, scheduling and serial delays and allow for one outstanding challenge and the final possible renewal in the measured stop allocation. The measured allocation must leave time for mechanical stopping. See the [build and verification record](../backend/PHASE_07_COMMAND.md).
