"""Read the selected Windows USB DualShock 4 through Pygame's pinned SDL HIDAPI driver."""

import ctypes
import os
import re
import sys
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from threading import Event, Lock, Thread
from time import monotonic
from typing import Any, cast

from .motion import DIRECTIONS, Direction, InputSample, InputScope, controller_intent

POLL_SECONDS = 0.015
PYGAME_VERSION = "2.6.1"
SDL_VERSION = (2, 28, 4)
SONY = 0x054C
DUALSHOCK_4 = (0x05C4, 0x09CC)
USB_PATH = re.compile(r"\\\\\?\\hid#vid_054c&pid_(05c4|09cc)(?:&[^#]+)?#[^#]+#\{[0-9a-f-]+\}", re.I)
DPAD: tuple[tuple[int, Direction], ...] = ((11, "forward"), (12, "backward"), (13, "left"), (14, "right"))
CIRCLE = 1
CONTROLS = (CIRCLE, *(index for index, _ in DPAD))


def serial_key(serial: str | None) -> str | None:
    if not serial:
        return None
    key = serial.lower().replace("-", "").replace(":", "")
    return key if re.fullmatch(r"[0-9a-f]{12}", key) and key != "000000000000" else None


@dataclass(frozen=True)
class DeviceState:
    instance: int
    serial: str
    path: str
    buttons: frozenset[int] | None  # None until a report proves the pinned profile is usable.


@dataclass(frozen=True)
class ControllerObservation:
    generation: int
    at: float | None
    sample: InputSample | None = None


Poll = Callable[[], tuple[DeviceState, ...]]


class Controller:
    def __init__(self, serial: str | None, deadline: float, open_device: Callable[[], AbstractContextManager[Poll]],
                 clock: Callable[[], float] = monotonic) -> None:
        self._serial = serial_key(serial)
        self._deadline, self._open_device, self._clock = deadline, open_device, clock
        self._lock, self._stop = Lock(), Event()
        self._scope: InputScope | None = None
        self._instance: tuple[int, str] | None = None
        self._latest = ControllerObservation(0, None)
        self._emergency: InputSample | None = None
        self._interruption: InputSample | None = None
        self._worker = Thread(target=self._run, name="controller-poll", daemon=True)

    def start(self) -> None:
        self._worker.start()

    def close(self) -> None:
        self._stop.set()
        self._worker.join(timeout=0.2)

    def observe(self, scope: InputScope | None) -> ControllerObservation:
        with self._lock:
            self._scope = scope
            latest = self._latest
            if latest.at is None or not 0 <= self._clock() - latest.at < self._deadline:
                return ControllerObservation(latest.generation, None)
            for pending in (self._emergency, self._interruption, latest.sample):
                if pending and pending.scope == scope and 0 <= self._clock() - pending.at < self._deadline:
                    if pending is self._emergency:
                        self._emergency = None
                    elif pending is self._interruption:
                        self._interruption = None
                    return ControllerObservation(latest.generation, latest.at, pending)
            return ControllerObservation(latest.generation, latest.at)

    def _publish(self, devices: tuple[DeviceState, ...], at: float, scope: InputScope | None) -> None:
        matches = [device for device in devices if serial_key(device.serial) == self._serial]
        device = matches[0] if len(matches) == 1 else None
        with self._lock:
            previous = self._latest
            usable = (device is not None and device.buttons is not None and USB_PATH.fullmatch(device.path)
                      and 0 <= self._clock() - at < self._deadline)
            if not usable or device is None or device.buttons is None:
                self._instance = None
                self._latest = ControllerObservation(previous.generation, None)
                self._emergency = self._interruption = None
                return
            instance = (device.instance, device.path.casefold())
            new_connection = (self._instance != instance or previous.at is None
                              or not 0 <= at - previous.at < self._deadline)
            generation = previous.generation + int(new_connection)
            self._instance = instance
            if new_connection or scope != self._scope:
                self._emergency = self._interruption = None
            sample = None
            if scope is not None and scope == self._scope:
                intent = controller_intent(tuple(direction for index, direction in DPAD if index in device.buttons),
                                           circle=CIRCLE in device.buttons)
                sample = InputSample(scope, at, intent)
                if intent == "emergency":
                    self._emergency = sample
                before = previous.sample
                if (not new_connection and before and before.scope == scope and before.intent in DIRECTIONS
                        and before.intent != intent and intent != "emergency"):
                    # A latest-value mailbox must not hide release, conflict or a direction change.
                    self._interruption = sample if intent == "neutral" else InputSample(scope, at, "invalid")
            self._latest = ControllerObservation(generation, at, sample)

    def _run(self) -> None:
        if self._serial is None:
            return
        while not self._stop.is_set():
            try:
                with self._open_device() as poll:
                    while not self._stop.is_set():
                        with self._lock:
                            at, scope = self._clock(), self._scope
                        self._publish(poll(), at, scope)
                        self._stop.wait(POLL_SECONDS)
            except Exception:
                self._publish((), self._clock(), None)
                self._stop.wait(0.5)


@contextmanager
def open_windows_controller() -> Iterator[Poll]:
    if sys.platform != "win32":
        raise OSError("The controller profile requires Windows.")
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    pygame = import_module("pygame")
    if pygame.__file__ is None or pygame.version.ver != PYGAME_VERSION or pygame.get_sdl_version() != SDL_VERSION:
        raise ValueError("Install the pinned Windows Pygame/SDL runtime.")

    # Pygame exposes held state and instance IDs. The same SDL DLL also exposes the
    # serial, OS device path, initial-report check and headless joystick event pump.
    sdl = ctypes.CDLL(str(Path(pygame.__file__).with_name("SDL2.dll")))
    sdl.SDL_SetHintWithPriority.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int]
    for hint in (b"SDL_JOYSTICK_ALLOW_BACKGROUND_EVENTS", b"SDL_JOYSTICK_HIDAPI_PS4"):
        if not sdl.SDL_SetHintWithPriority(hint, b"1", 2):  # SDL_HINT_OVERRIDE
            raise OSError("Could not enable background input and the SDL PS4 driver.")
    sdl.SDL_JoystickUpdate.argtypes = []
    sdl.SDL_JoystickUpdate.restype = None
    sdl.SDL_JoystickEventState.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickEventState.restype = ctypes.c_int
    sdl.SDL_JoystickFromInstanceID.argtypes = [ctypes.c_int32]
    sdl.SDL_JoystickFromInstanceID.restype = ctypes.c_void_p
    for query in (sdl.SDL_JoystickGetSerial, sdl.SDL_JoystickPath):
        query.argtypes, query.restype = [ctypes.c_void_p], ctypes.c_char_p
    sdl.SDL_JoystickGetAttached.argtypes = [ctypes.c_void_p]
    sdl.SDL_JoystickGetAttached.restype = ctypes.c_int
    sdl.SDL_JoystickGetAxisInitialState.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int16)]
    sdl.SDL_JoystickGetAxisInitialState.restype = ctypes.c_int
    sdl.SDL_JoystickGetDeviceVendor.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickGetDeviceVendor.restype = ctypes.c_uint16
    sdl.SDL_JoystickGetDeviceProduct.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickGetDeviceProduct.restype = ctypes.c_uint16
    sdl.SDL_JoystickGetDeviceInstanceID.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickGetDeviceInstanceID.restype = ctypes.c_int32
    pygame.joystick.init()
    try:
        sdl.SDL_JoystickEventState(0)  # SDL_IGNORE: poll current state without retaining joystick events.
        joysticks: dict[int, Any] = {}

        def poll() -> tuple[DeviceState, ...]:
            sdl.SDL_JoystickUpdate()
            devices = []
            present = set()
            for index in range(pygame.joystick.get_count()):
                if (sdl.SDL_JoystickGetDeviceVendor(index) != SONY or
                        sdl.SDL_JoystickGetDeviceProduct(index) not in DUALSHOCK_4):
                    continue
                instance = int(sdl.SDL_JoystickGetDeviceInstanceID(index))
                joystick = joysticks.get(instance)
                if joystick is None:
                    joystick = pygame.joystick.Joystick(index)
                    if joystick.get_instance_id() != instance:
                        raise OSError("The controller changed during enumeration.")
                    joysticks[instance] = joystick
                handle = sdl.SDL_JoystickFromInstanceID(instance)
                if not handle or not sdl.SDL_JoystickGetAttached(handle):
                    continue
                present.add(instance)
                serial = cast(bytes, sdl.SDL_JoystickGetSerial(handle) or b"").decode("ascii", errors="replace")
                path = cast(bytes, sdl.SDL_JoystickPath(handle) or b"").decode("utf-8", errors="replace")
                guid = bytes.fromhex(joystick.get_guid())
                buttons = None
                if (len(guid) == 16 and guid[14] == ord("h") and joystick.get_numhats() == 0
                        and joystick.get_numbuttons() == 16 and joystick.get_numaxes() == 6
                        and sdl.SDL_JoystickGetAxisInitialState(handle, 0, ctypes.byref(ctypes.c_int16()))):
                    buttons = frozenset(button for button in CONTROLS if joystick.get_button(button))
                devices.append(DeviceState(instance, serial, path, buttons))
            for removed in joysticks.keys() - present:
                joysticks.pop(removed).quit()
            return tuple(devices)

        yield poll
    finally:
        pygame.joystick.quit()


if __name__ == "__main__":
    with open_windows_controller() as poll:
        poll()
        Event().wait(0.10)
        print(poll())
