"""Versioned HC-SR04 observations alongside Uno command replies."""

from binascii import crc_hqx
from dataclasses import dataclass
from struct import Struct

from .uno_wire import decode_cobs

VERSION = 1
TAG = 1  # A Uno command ACK starts with a COBS block containing version and opcode.
BODY = Struct("<BIIIHHB")
FRAME_BYTES = BODY.size + 5  # Route byte, CRC16, one COBS byte, delimiter.
MAX_DISTANCE_MM = 6000
CONTRACT_SHA256 = "bb79c841a7cbdc299c1f4399c0455f3ecc4e7abbf473f5825def7a34e5e4045d"


@dataclass(frozen=True)
class AdvisoryPacket:
    boot: int
    credit: int
    sequence: int
    age_ms: int
    distance_mm: int | None


def decode_advisory(frame: bytes) -> AdvisoryPacket:
    if len(frame) != FRAME_BYTES or frame[0] != TAG:
        raise ValueError("Invalid Uno proximity frame length or route")
    raw = decode_cobs(frame[1:])
    if len(raw) != BODY.size + 2 or crc_hqx(raw[:-2], 0xFFFF) != int.from_bytes(raw[-2:], "little"):
        raise ValueError("Invalid Uno proximity frame checksum")
    version, boot, credit, sequence, age, distance, valid = BODY.unpack_from(raw)
    if (version != VERSION or not all((boot, credit, sequence, age))
            or valid not in (0, 1) or (valid and not 1 <= distance <= MAX_DISTANCE_MM)
            or (not valid and distance != 0)):
        raise ValueError("Invalid or incompatible Uno proximity observation")
    return AdvisoryPacket(boot, credit, sequence, age, distance if valid else None)


def misrouted_advisory(frame: bytes) -> bool:
    # A corrupt route can itself become a delimiter. Accept neither form
    # as telemetry, even when its original body and CRC are intact.
    if len(frame) not in (FRAME_BYTES - 1, FRAME_BYTES):
        return False
    try:
        decode_advisory(bytes((TAG,)) + frame[-(FRAME_BYTES - 1):])
    except ValueError:
        return False
    return True
