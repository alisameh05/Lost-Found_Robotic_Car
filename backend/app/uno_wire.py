"""Bounded Uno command wire v1. See firmware/UNO_COMMAND.md."""

from binascii import crc_hqx
from dataclasses import dataclass
from struct import Struct

VERSION = 1
HELLO, STATUS, ARM, DRIVE, STOP = range(1, 6)
REPLY = 0x80
ARMED = 1
MAX_COUNTER = 0xFFFFFFFF
HEADER = Struct("<BBIIIIIBB")
REQUEST_FRAME = HEADER.size + 2 + 2
MAX_FRAME = REQUEST_FRAME + 32
# Overflow the Uno's request parser before supplying a delimiter. A bare
# delimiter could complete a request whose entire body already arrived.
DISCARD_PARTIAL = bytes([0xFF]) * REQUEST_FRAME + b"\0"


class WireError(ValueError):
    pass


class WireVersionError(WireError):
    pass


@dataclass(frozen=True)
class Packet:
    op: int
    boot: int = 0
    generation: int = 0
    sequence: int = 0
    challenge: int = 0
    next_challenge: int = 0
    direction: int = 0
    flags: int = 0
    build: bytes = b""


def encode(packet: Packet) -> bytes:
    raw = HEADER.pack(
        VERSION, packet.op, packet.boot, packet.generation, packet.sequence,
        packet.challenge, packet.next_challenge, packet.direction, packet.flags,
    ) + packet.build
    raw += crc_hqx(raw, 0xFFFF).to_bytes(2, "little")
    blocks = raw.split(b"\0")
    return b"".join(bytes((len(block) + 1,)) + block for block in blocks) + b"\0"


def decode(frame: bytes) -> Packet:
    if len(frame) > MAX_FRAME:
        raise WireError("Invalid frame delimiter or length")
    raw = decode_cobs(frame)
    if len(raw) < HEADER.size + 2 or crc_hqx(raw[:-2], 0xFFFF) != int.from_bytes(raw[-2:], "little"):
        raise WireError("Invalid packet length or checksum")
    version, op, boot, generation, sequence, challenge, successor, direction, flags = HEADER.unpack_from(raw)
    if version != VERSION:
        raise WireVersionError("Unsupported Uno command protocol")
    build = bytes(raw[HEADER.size:-2])
    if len(build) != (32 if op == HELLO | REPLY else 0):
        raise WireError("Invalid packet payload length")
    return Packet(op, boot, generation, sequence, challenge, successor, direction, flags, build)


def decode_cobs(frame: bytes) -> bytearray:
    if len(frame) < 2 or frame[-1] != 0 or 0 in frame[:-1]:
        raise WireError("Invalid frame delimiter or length")
    raw = bytearray()
    cursor = 0
    end = len(frame) - 1
    while cursor < end:
        offset = cursor + frame[cursor]
        if offset > end:
            raise WireError("Invalid COBS block")
        raw.extend(frame[cursor + 1:offset])
        if offset < end:
            raw.append(0)
        cursor = offset
    return raw
