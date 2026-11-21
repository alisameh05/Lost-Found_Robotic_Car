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

from .motion import DIRECTIONS, InputSample, InputScope, Intent

POLL_SECONDS = 0.015
PYGAME_VERSION = "2.6.1"
SDL_VERSION = (2, 28, 4)
SONY = 0x054C
DUALSHOCK_4 = (0x05C4, 0x09CC)
USB_PATH = re.compile(r"\\\\\?\\hid#vid_054c&pid_(05c4|09cc)(?:&[^#]+)?#[^#]+#\{[0-9a-f-]+\}", re.I)
USB_REPORT_SIZE = 64
MAX_REPORTS = 64
HAT: tuple[Intent, ...] = ("forward", "invalid", "right", "invalid", "backward", "invalid", "left", "invalid", "neutral")


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
    reports: tuple[bytes, ...] | None  # None means unavailable. An empty batch cannot refresh freshness.
    complete: bool = True  # A broken drain can only report an emergency from its valid prefix.


def decode_usb_report(report: bytes) -> tuple[int, Intent] | None:
    # SDL's pinned PS4 USB state report has a 1-byte ID followed by PS4StatePacket_t.
    if len(report) != USB_REPORT_SIZE or report[0] != 1 or report[31] & 4:
        return None
    buttons = report[5]
    hat = buttons & 0x0F
    if hat >= len(HAT):
        return None
    tick = int.from_bytes(report[10:12], "little")
    return tick, "emergency" if buttons & 0x40 else HAT[hat]


@dataclass(frozen=True)
class ControllerObservation:
    generation: int
    at: float | None
    sample: InputSample | None = None


Poll = Callable[[], tuple[DeviceState, ...]]


def same_session(left: InputScope | None, right: InputScope | None) -> bool:
    return left is not None and right is not None and (left.boot, left.session) == (right.boot, right.session)


class Controller:
    def __init__(self, serial: str | None, deadline: float, open_device: Callable[[], AbstractContextManager[Poll]],
                 clock: Callable[[], float] = monotonic) -> None:
        self._serial = serial_key(serial)
        self._deadline, self._open_device, self._clock = deadline, open_device, clock
        self._lock, self._stop = Lock(), Event()
        self._scope: InputScope | None = None
        self._instance: tuple[int, str] | None = None
        self._report_instance: tuple[int, str] | None = None
        self._report_tick = 0
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
            now = self._clock()
            ready = latest.at is not None and 0 <= now - latest.at < self._deadline
            at = latest.at if ready else None
            emergency = self._emergency
            self._emergency = None
            if (emergency and scope and same_session(emergency.scope, scope)
                    and 0 <= now - emergency.at < self._deadline):
                # A valid press keeps stop-only authority within the same active session.
                return ControllerObservation(latest.generation, at, InputSample(scope, emergency.at, "emergency"))
            if not ready:
                return ControllerObservation(latest.generation, None)
            for pending in (self._interruption, latest.sample):
                if pending and pending.scope == scope and 0 <= now - pending.at < self._deadline:
                    if pending is self._interruption:
                        self._interruption = None
                    return ControllerObservation(latest.generation, at, pending)
            return ControllerObservation(latest.generation, at)

    def _publish(self, devices: tuple[DeviceState, ...], at: float, scope: InputScope | None,
                 previous_scope: InputScope | None = None) -> None:
        matches = [device for device in devices if serial_key(device.serial) == self._serial]
        with self._lock:
            device = matches[0] if len(matches) == 1 else next((
                old for old in matches if not old.complete and (old.instance, old.path.casefold()) == self._instance
            ), None)
            previous = self._latest
            reports = (device.reports if device is not None and USB_PATH.fullmatch(device.path) else None)
            if device is None or reports is None or not 0 <= self._clock() - at < self._deadline:
                self._unavailable()
                return
            instance = (device.instance, device.path.casefold())
            complete = device.complete
            fresh = []
            for raw in reports:
                report = decode_usb_report(raw)
                if report is None:
                    complete = False
                    break
                tick, intent = report
                if self._report_instance == instance and not 0 < (tick - self._report_tick) % 65536 < 32768:
                    continue
                self._report_instance, self._report_tick = instance, tick
                fresh.append(intent)
            if (scope and same_session(previous_scope, scope) and same_session(scope, self._scope)
                    and "emergency" in fresh):
                self._emergency = InputSample(scope, at, "emergency")
            if not complete:
                self._unavailable()
                return
            if not fresh:
                if self._instance != instance:
                    self._unavailable()
                return
            new_connection = (self._instance != instance or previous.at is None
                              or not 0 <= at - previous.at < self._deadline)
            generation = previous.generation + int(new_connection)
            self._instance = instance
            current_scope = scope is not None and scope == previous_scope == self._scope
            if new_connection or not current_scope:
                self._interruption = None
            sample = None
            if scope is not None and current_scope:
                prior = previous.sample if not new_connection else None
                for intent in fresh:
                    sample = InputSample(scope, at, intent)
                    if (intent == "invalid" or (intent != "emergency" and prior and prior.scope == scope
                                                and prior.intent in DIRECTIONS and prior.intent != intent)):
                        # A later direction cannot hide a stop before the coordinator sees it.
                        self._interruption = sample if intent == "neutral" else InputSample(scope, at, "invalid")
                    prior = sample
            self._latest = ControllerObservation(generation, at, sample)

    def _unavailable(self) -> None:
        self._instance = None
        self._latest = ControllerObservation(self._latest.generation, None)
        self._interruption = None

    def _run(self) -> None:
        if self._serial is None:
            return
        while not self._stop.is_set():
            try:
                with self._open_device() as poll:
                    with self._lock:
                        previous_poll, previous_scope = self._clock(), self._scope
                    while not self._stop.is_set():
                        with self._lock:
                            at, scope = self._clock(), self._scope
                        if at <= previous_poll:
                            # Windows can return the same monotonic tick on adjacent wakes.
                            # Leave reports queued until they can carry a distinct timestamp.
                            self._stop.wait(POLL_SECONDS)
                            continue
                        # Reports may have accumulated since the previous drain. Use
                        # the oldest possible timestamp and pass both scope boundaries.
                        self._publish(poll(), previous_poll, scope, previous_scope)
                        previous_poll, previous_scope = at, scope
                        self._stop.wait(POLL_SECONDS)
            except Exception:
                self._publish((), self._clock(), None)
                self._stop.wait(0.5)


@contextmanager
def open_windows_controller(selected_serial: str | None = None) -> Iterator[Poll]:
    if sys.platform != "win32":
        raise OSError("The controller profile requires Windows.")
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    selected = serial_key(selected_serial)
    pygame = import_module("pygame")
    if pygame.__file__ is None or pygame.version.ver != PYGAME_VERSION or pygame.get_sdl_version() != SDL_VERSION:
        raise ValueError("Install the pinned Windows Pygame/SDL runtime.")

    # Pygame supplies joystick identity and capabilities. Read ordered reports through
    # the same SDL DLL because the joystick button cache omits both report age and edges.
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
    sdl.SDL_JoystickGetDeviceVendor.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickGetDeviceVendor.restype = ctypes.c_uint16
    sdl.SDL_JoystickGetDeviceProduct.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickGetDeviceProduct.restype = ctypes.c_uint16
    sdl.SDL_JoystickGetDeviceInstanceID.argtypes = [ctypes.c_int]
    sdl.SDL_JoystickGetDeviceInstanceID.restype = ctypes.c_int32
    sdl.SDL_hid_open_path.argtypes = [ctypes.c_char_p, ctypes.c_int]
    sdl.SDL_hid_open_path.restype = ctypes.c_void_p
    sdl.SDL_hid_read_timeout.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_size_t, ctypes.c_int]
    sdl.SDL_hid_read_timeout.restype = ctypes.c_int
    sdl.SDL_hid_get_feature_report.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_size_t]
    sdl.SDL_hid_get_feature_report.restype = ctypes.c_int
    sdl.SDL_hid_close.argtypes = [ctypes.c_void_p]
    sdl.SDL_hid_close.restype = None
    pygame.joystick.init()
    handles: dict[int, tuple[str, bytes, int]] = {}
    try:
        sdl.SDL_JoystickEventState(0)  # SDL_IGNORE: poll current state without retaining joystick events.
        joysticks: dict[int, Any] = {}
        buffer = (ctypes.c_ubyte * (USB_REPORT_SIZE + 1))()

        def open_verified_handle(serial: str, path: bytes) -> int | None:
            expected = serial_key(serial)
            if expected is None:
                return None
            raw = cast(int | None, sdl.SDL_hid_open_path(path, 0))
            if raw is None:
                return None
            # A Windows HID path can be reused. Verify Sony's serial on the actual input handle.
            feature = (ctypes.c_ubyte * USB_REPORT_SIZE)(0x12)
            length = sdl.SDL_hid_get_feature_report(raw, feature, len(feature))
            if length >= 7 and feature[0] == 0x12 and bytes(feature[1:7])[::-1].hex() == expected:
                return raw
            sdl.SDL_hid_close(raw)
            return None

        def read_reports(raw: int, limit: int = MAX_REPORTS) -> tuple[tuple[bytes, ...], bool]:
            reports: list[bytes] = []
            for _ in range(limit):
                length = sdl.SDL_hid_read_timeout(raw, buffer, len(buffer), 0)
                if length == 0:
                    return tuple(reports), True
                if length < 0:
                    break
                reports.append(bytes(buffer[:length]))
            # A saturated or broken stream can't prove that these are current reports.
            return tuple(reports), False

        def discover() -> list[tuple[int, str, bytes, bool]]:
            sdl.SDL_JoystickUpdate()
            devices: list[tuple[int, str, bytes, bool]] = []
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
                serial = cast(bytes, sdl.SDL_JoystickGetSerial(handle) or b"").decode("ascii", errors="replace")
                path_bytes = cast(bytes, sdl.SDL_JoystickPath(handle) or b"")
                path = path_bytes.decode("utf-8", errors="replace")
                guid = bytes.fromhex(joystick.get_guid())
                supported = (len(guid) == 16 and guid[14] == ord("h") and joystick.get_numhats() == 0
                             and joystick.get_numbuttons() == 16 and joystick.get_numaxes() == 6
                             and USB_PATH.fullmatch(path) is not None
                             and (selected is None or serial_key(serial) == selected))
                devices.append((instance, serial, path_bytes, supported))
            return devices

        def poll() -> tuple[DeviceState, ...]:
            # Read already-verified handles before SDL can announce a device removal.
            drained = {instance: read_reports(raw) for instance, (_, _, raw) in handles.items()}
            try:
                found = discover()
            except (OSError, pygame.error):
                # The valid prefix can still deliver Circle. Enumeration cannot authorize motion.
                found = []
            present = {instance for instance, _, _, _ in found}
            supported = {(instance, serial, path) for instance, serial, path, valid in found if valid}
            devices: list[DeviceState] = []
            for instance, (serial, path_bytes, raw) in tuple(handles.items()):
                prefix, complete = drained[instance]
                if (instance, serial, path_bytes) not in supported:
                    if complete:
                        # A pending read may have completed during the SDL removal check.
                        tail, _ = read_reports(raw, MAX_REPORTS - len(prefix))
                        prefix += tail
                    if prefix:
                        path = path_bytes.decode("utf-8", errors="replace")
                        devices.append(DeviceState(instance, serial, path, prefix, False))
                    del drained[instance]
                elif complete:
                    continue
                sdl.SDL_hid_close(raw)
                del handles[instance]

            for instance, serial, path_bytes, valid in found:
                reports: tuple[bytes, ...] | None = None
                complete = False
                if valid:
                    if instance in drained:
                        reports, complete = drained[instance]
                    elif (opened := open_verified_handle(serial, path_bytes)) is not None:
                        reports, complete = read_reports(opened)
                        if complete:
                            handles[instance] = serial, path_bytes, opened
                        else:
                            sdl.SDL_hid_close(opened)
                path = path_bytes.decode("utf-8", errors="replace")
                devices.append(DeviceState(instance, serial, path, reports, complete))
            for removed in joysticks.keys() - present:
                joysticks.pop(removed).quit()
            return tuple(devices)

        yield poll
    finally:
        for _, _, raw in handles.values():
            sdl.SDL_hid_close(raw)
        pygame.joystick.quit()


if __name__ == "__main__":
    with open_windows_controller() as poll:
        poll()
        Event().wait(0.10)
        print([(device.instance, device.serial, device.path,
                decode_usb_report(device.reports[-1]) if device.reports else None) for device in poll()])
