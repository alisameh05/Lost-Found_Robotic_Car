from contextlib import nullcontext
from dataclasses import replace
from queue import Empty, Queue
from threading import Event
from time import monotonic, perf_counter_ns, sleep
from types import SimpleNamespace
from unittest.mock import Mock

from backend.app import controller as native
from backend.app.controller import Controller, DeviceState
from backend.app.motion import InputScope

SERIAL = "12-34-56-78-9a-bc"
PATH = r"\\?\hid#vid_054c&pid_09cc#sample#{4d1e55b2-f16f-11cf-88cb-001111000030}"


def device(instance: int, *buttons: int, serial: str = SERIAL, path: str = PATH) -> DeviceState:
    hats = {frozenset(): 8, frozenset((11,)): 0, frozenset((12,)): 4, frozenset((13,)): 6,
            frozenset((14,)): 2, frozenset((11, 14)): 1}
    report = bytearray(64)
    report[0] = 1
    report[5] = (hats[frozenset(buttons) & {11, 12, 13, 14}]
                 | (0x40 if 1 in buttons else 0) | (0x80 if 3 in buttons else 0))
    return DeviceState(instance, serial, path, (bytes(report),))


def fresh_reports(devices: list[DeviceState]) -> tuple[DeviceState, ...]:
    tick = (perf_counter_ns() * 3 // 16000) % 65536
    return tuple(replace(device, reports=tuple(
        report[:10] + ((tick + index) % 65536).to_bytes(2, "little") + report[12:]
        for index, report in enumerate(device.reports)
    )) if device.reports is not None else device for device in devices)


def test_selected_usb_device_supplies_fresh_scoped_digital_input() -> None:
    devices = [device(1), device(2, 14, serial="01-23-45-67-89-ab")]
    controller = Controller(SERIAL, 0.18, lambda: nullcontext(lambda: fresh_reports(devices)))
    scope = InputScope("boot", "session", 1)

    def expect(intent: str | None) -> None:
        until = monotonic() + 2
        while monotonic() < until:
            observation = controller.observe(scope)
            if intent is None and observation.at is None:
                return
            if observation.sample and observation.sample.intent == intent:
                assert observation.sample.scope == scope
                return
            sleep(0.005)
        raise AssertionError((intent, observation))

    controller.start()
    try:
        expect("neutral")
        for button, intent in [(11, "forward"), (12, "backward"), (13, "left"), (14, "right")]:
            devices[0] = device(1, button)
            expect(intent)
        devices[0] = device(1, 11, 14)
        expect("invalid")
        devices[0] = device(1, 11, 14, 1)
        expect("emergency")
        devices[0] = device(1, 3)
        expect("neutral")
        devices.append(device(3, 11))
        expect(None)
        devices[:] = [device(2, 14, serial="01-23-45-67-89-ab")]
        expect(None)
    finally:
        controller.close()


def test_report_batches_preserve_conflict_release_and_circle_before_removal() -> None:
    queue: Queue[tuple[DeviceState, ...]] = Queue()
    received = Event()
    scope = InputScope("boot", "session", 1)

    def poll() -> tuple[DeviceState, ...]:
        received.set()
        try:
            return queue.get(timeout=0.04)
        except Empty:
            return (replace(device(1), reports=()),)

    controller = Controller(SERIAL, 0.5, lambda: nullcontext(poll))

    def send(states: tuple[DeviceState, ...]) -> None:
        received.clear()
        queue.put(states)
        # Reentry into the device poll proves the preceding batch was published.
        assert received.wait(1)

    def batch(*held: tuple[int, ...]) -> tuple[DeviceState, ...]:
        combined = tuple(report for buttons in held for report in (device(1, *buttons).reports or ()))
        return fresh_reports([replace(device(1), reports=combined)])

    def expect(intent: str) -> None:
        observation = controller.observe(scope)
        assert observation.sample and observation.sample.intent == intent

    controller.observe(scope)
    controller.start()
    try:
        assert received.wait(1)
        send(batch((11,), (11, 3)))
        expect("forward")  # Up has a zero button byte and is still a held direction.
        send(batch((), (11, 14), (11,)))
        expect("invalid")
        send(batch((), (11,)))
        expect("neutral")
        send(batch((11, 1), (11,)))
        send(())
        stopped = controller.observe(scope)
        assert stopped.at is None and stopped.sample and stopped.sample.intent == "emergency"
        assert controller.observe(scope).sample is None
        send(batch((11,)))
        failed = batch((11, 1))
        send((replace(failed[0], complete=False),))
        send(())
        reconnected = batch((11,))
        send((replace(reconnected[0], instance=2),))
        expect("emergency")
        expect("forward")
    finally:
        controller.close()


def test_native_poll_verifies_the_raw_unit_and_preserves_circle_when_discovery_fails(monkeypatch) -> None:
    sdl = Mock()
    sdl.SDL_SetHintWithPriority.return_value = 1
    sdl.SDL_JoystickGetDeviceVendor.return_value = 0x054C
    sdl.SDL_JoystickGetDeviceProduct.return_value = 0x09CC
    sdl.SDL_JoystickGetDeviceInstanceID.return_value = 1
    sdl.SDL_JoystickFromInstanceID.return_value = 1
    sdl.SDL_JoystickGetAttached.return_value = 1
    sdl.SDL_JoystickGetSerial.return_value = SERIAL.encode()
    sdl.SDL_JoystickPath.return_value = PATH.encode()
    sdl.SDL_hid_open_path.return_value = 7
    feature_serial = "deadbeefcafe"
    pending: list[bytes] = []

    def read_identity(handle, data, size):
        assert handle == 7 and data[0] == 0x12
        data[1:7] = bytes.fromhex(feature_serial)[::-1]
        return 7

    def read_report(handle, data, size, timeout):
        if not pending:
            return 0
        report = pending.pop(0)
        data[:len(report)] = report
        return len(report)

    sdl.SDL_hid_get_feature_report.side_effect = read_identity
    sdl.SDL_hid_read_timeout.side_effect = read_report
    joystick = SimpleNamespace(get_instance_id=lambda: 1, get_guid=lambda: "00" * 14 + "6800",
                               get_numhats=lambda: 0, get_numbuttons=lambda: 16, get_numaxes=lambda: 6,
                               quit=lambda: None)
    get_count = Mock(return_value=1)
    pygame = SimpleNamespace(__file__="pygame/__init__.py", version=SimpleNamespace(ver=native.PYGAME_VERSION),
                             get_sdl_version=lambda: native.SDL_VERSION, error=RuntimeError,
                             joystick=SimpleNamespace(init=lambda: None, quit=lambda: None,
                                                      get_count=get_count, Joystick=lambda _: joystick))
    monkeypatch.setattr(native.sys, "platform", "win32")
    monkeypatch.setattr(native.ctypes, "CDLL", lambda _: sdl)
    monkeypatch.setattr(native, "import_module", lambda _: pygame)
    with native.open_windows_controller(SERIAL) as poll:
        assert poll()[0].reports is None
        sdl.SDL_hid_read_timeout.assert_not_called()
        sdl.SDL_hid_close.assert_called_once_with(7)

        feature_serial = SERIAL.replace("-", "")
        pending.extend(device(1).reports or ())
        assert poll()[0].reports == device(1).reports

        pending.extend(device(1, 1, 11).reports or ())
        get_count.side_effect = pygame.error("controller changed during enumeration")
        failed = poll()
        assert len(failed) == 1 and not failed[0].complete
        assert failed[0].reports == device(1, 1, 11).reports
        assert poll() == ()
        assert sdl.SDL_hid_open_path.call_count == 2
