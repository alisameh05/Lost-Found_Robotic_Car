"""Windows GATT transport for the selected Uno serial bridge."""

import asyncio
import sys
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from typing import TYPE_CHECKING

from .device_startup import WINDOWS_BLE_ID, CommandInterface
from .uno_wire import DISCARD_PARTIAL, MAX_FRAME, REQUEST_FRAME, WireVersionError

if TYPE_CHECKING:
    from bleak import BleakClient
    from bleak.backends.characteristic import BleakGATTCharacteristic

SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC = "0000ffe1-0000-1000-8000-00805f9b34fb"
CONNECT_TIMEOUT = 12.0
NOTIFY_TIMEOUT = 4.0
DISCONNECT_TIMEOUT = 4.0
RECEIVE_LIMIT = 2 * MAX_FRAME  # One outstanding reply may arrive before a STOP acknowledgment.


class BleTransport:
    def __init__(self, runner: asyncio.Runner, client: "BleakClient", write_timeout: float):
        self._runner = runner
        self._client = client
        self._write_timeout = write_timeout
        self._characteristic: BleakGATTCharacteristic | None = None
        self._received = bytearray()
        self._overflow = False

    async def connect(self) -> None:
        await asyncio.wait_for(self._client.connect(), CONNECT_TIMEOUT)
        service = self._client.services.get_service(SERVICE)
        endpoint = service.get_characteristic(CHARACTERISTIC) if service else None
        if endpoint is None or not {"write", "notify"}.issubset(endpoint.properties):
            raise WireVersionError("The selected BLE serial service is incompatible")
        await asyncio.wait_for(self._client.start_notify(endpoint, self._notification), NOTIFY_TIMEOUT)
        if self._client.mtu_size < 3 + len(DISCARD_PARTIAL):
            raise OSError("The BLE link cannot carry a complete Uno request")
        self._characteristic = endpoint

    def _notification(self, _: "BleakGATTCharacteristic", chunk: bytearray) -> None:
        if self._overflow or len(self._received) + len(chunk) > RECEIVE_LIMIT:
            self._overflow = True
            self._received.clear()
            return
        self._received.extend(chunk)

    def read(self, size: int) -> bytes:
        # Notifications are dispatched on the same loop that owns this worker's GATT session.
        self._runner.run(asyncio.sleep(0))
        if not self._client.is_connected or self._overflow:
            raise OSError("The BLE notification stream is unavailable")
        result = bytes(self._received[:size])
        del self._received[:size]
        return result

    def write(self, data: bytes) -> int:
        chunks: tuple[bytes, ...]
        if len(data) == REQUEST_FRAME:
            chunks = (data,)
        elif len(data) == len(DISCARD_PARTIAL) + REQUEST_FRAME and data.startswith(DISCARD_PARTIAL):
            chunks = (DISCARD_PARTIAL, data[len(DISCARD_PARTIAL):])
        else:
            raise ValueError("Unexpected Uno command transport length")
        self._runner.run(self._write_chunks(chunks))
        return len(data)

    async def _write_chunks(self, chunks: tuple[bytes, ...]) -> None:
        from bleak.exc import BleakError

        endpoint = self._characteristic
        if endpoint is None or not self._client.is_connected:
            raise OSError("The BLE command link is disconnected")
        try:
            async with asyncio.timeout(self._write_timeout):
                for chunk in chunks:
                    await self._client.write_gatt_char(endpoint, chunk, response=True)
        except BleakError as error:
            raise OSError("The BLE command write failed") from error


@contextmanager
def open_selected_ble(selection: CommandInterface, write_timeout: float) -> Iterator[BleTransport]:
    if sys.platform != "win32":
        raise OSError("The selected BLE command path requires Windows")
    try:
        from bleak import BleakClient
        from bleak.backends.device import BLEDevice
        from bleak.exc import BleakError
    except ImportError as error:
        raise OSError("The Windows BLE runtime is unavailable") from error

    match = WINDOWS_BLE_ID.fullmatch(selection.identity)
    address_type = selection.ble_address_type
    if match is None or address_type is None:
        raise OSError("The selected Windows BLE identity is unavailable")
    digits = match.group(1).upper()
    address = ":".join(digits[index:index + 2] for index in range(0, 12, 2))
    # Use the configured Windows address directly. A connected peripheral may cease advertising.
    device = BLEDevice(address, None, None)
    client = BleakClient(device, services=[SERVICE], winrt={"address_type": address_type, "use_cached_services": True})

    with asyncio.Runner() as runner:
        transport = BleTransport(runner, client, write_timeout)
        try:
            runner.run(transport.connect())
            yield transport
        except BleakError as error:
            raise OSError("The selected BLE command link is unavailable") from error
        finally:
            with suppress(OSError, BleakError):
                runner.run(asyncio.wait_for(client.disconnect(), DISCONNECT_TIMEOUT))
