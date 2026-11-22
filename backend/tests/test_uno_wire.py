import pytest

from backend.app.uno_wire import DRIVE, Packet, WireError, decode, encode


def test_v1_drive_golden_frame_and_integrity() -> None:
    packet = Packet(DRIVE, boot=2, generation=3, sequence=4, challenge=5, direction=1)
    # CRC-16/CCITT-FALSE of 010402000000030000000400000005000000000000000100 is 0x8ba2.
    wire = bytes.fromhex("04010402010102030101020401010205010101010101020103a28b00")
    assert encode(packet) == wire
    assert decode(wire) == packet
    with pytest.raises(WireError):
        decode(wire[:-3] + b"\xa3" + wire[-2:])
