import asyncio
from unittest.mock import AsyncMock, Mock, call

import pytest

from backend.app.ble_link import CHARACTERISTIC, RECEIVE_LIMIT, SERVICE, BleTransport
from backend.app.uno_wire import DISCARD_PARTIAL, HELLO, Packet, WireVersionError, encode


def fake_gatt():
    client = Mock(connect=AsyncMock(), start_notify=AsyncMock(), write_gatt_char=AsyncMock())
    characteristic = client.services.get_service.return_value.get_characteristic.return_value
    characteristic.properties = ["write", "notify"]
    client.mtu_size = 517
    client.is_connected = True
    return client, characteristic


def test_ble_writes_complete_request_and_bounds_notifications():
    pytest.importorskip("bleak")
    client, characteristic = fake_gatt()
    request = encode(Packet(HELLO, sequence=1))
    with asyncio.Runner() as runner:
        transport = BleTransport(runner, client, 0.1)
        runner.run(transport.connect())
        client.services.get_service.assert_called_once_with(SERVICE)
        client.services.get_service.return_value.get_characteristic.assert_called_once_with(CHARACTERISTIC)
        callback = client.start_notify.await_args.args[1]

        assert transport.write(DISCARD_PARTIAL + request) == len(DISCARD_PARTIAL + request)
        assert client.write_gatt_char.await_args_list == [
            call(characteristic, DISCARD_PARTIAL, response=True), call(characteristic, request, response=True),
        ]
        callback(characteristic, bytearray(b"ab"))
        callback(characteristic, bytearray(b"cd"))
        assert transport.read(3) == b"abc"
        assert transport.read(3) == b"d"
        callback(characteristic, bytearray(RECEIVE_LIMIT + 1))
        with pytest.raises(OSError):
            transport.read(20)


def test_ble_requires_write_and_notify_and_surfaces_failed_write():
    bleak = pytest.importorskip("bleak.exc")
    client, characteristic = fake_gatt()
    with asyncio.Runner() as runner:
        transport = BleTransport(runner, client, 0.1)
        characteristic.properties = ["write-without-response", "notify"]
        with pytest.raises(WireVersionError):
            runner.run(transport.connect())
        client.start_notify.assert_not_awaited()

        characteristic.properties = ["write", "notify"]
        runner.run(transport.connect())
        client.write_gatt_char.side_effect = bleak.BleakError("Disconnected")
        with pytest.raises(OSError):
            transport.write(DISCARD_PARTIAL + encode(Packet(HELLO, sequence=1)))
        client.write_gatt_char.assert_awaited_once_with(characteristic, DISCARD_PARTIAL, response=True)
