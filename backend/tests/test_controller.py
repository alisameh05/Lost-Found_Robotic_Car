from contextlib import nullcontext
from time import monotonic, sleep

from backend.app.controller import Controller, DeviceState
from backend.app.motion import InputScope

SERIAL = "12-34-56-78-9a-bc"
PATH = r"\\?\hid#vid_054c&pid_09cc#sample#{4d1e55b2-f16f-11cf-88cb-001111000030}"


def device(instance: int, *buttons: int, serial: str = SERIAL, path: str = PATH) -> DeviceState:
    return DeviceState(instance, serial, path, frozenset(buttons))


def test_selected_usb_device_supplies_fresh_scoped_digital_input() -> None:
    devices = [device(1), device(2, 14, serial="01-23-45-67-89-ab")]
    controller = Controller(SERIAL, 0.18, lambda: nullcontext(lambda: tuple(devices)))
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
