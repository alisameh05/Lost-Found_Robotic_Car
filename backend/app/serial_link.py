"""Single-owner HC-05 worker. The application hands it one bounded renewal at a time."""

import sys
from collections import deque
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass
from secrets import randbelow
from threading import Event, Lock, Thread
from time import monotonic
from typing import TYPE_CHECKING, Protocol, cast

from .motion import COMMAND_FAILURES, DIRECTIONS, Direction
from .proximity_wire import TAG, decode_advisory, misrouted_advisory
from .simulation import ProximitySample
from .uno_wire import (
    ARM,
    ARMED,
    DISCARD_PARTIAL,
    DRIVE,
    HELLO,
    MAX_COUNTER,
    MAX_FRAME,
    REPLY,
    REQUEST_FRAME,
    STATUS,
    STOP,
    VERSION,
    Packet,
    WireError,
    WireVersionError,
    decode,
    encode,
)

if TYPE_CHECKING:
    from .device_startup import CommandInterface
    from .simulation import QualificationProfile


class Transport(Protocol):
    def read(self, size: int) -> bytes: ...
    def write(self, data: bytes) -> int: ...


OpenTransport = Callable[[], AbstractContextManager[Transport]]


@contextmanager
def open_selected(selection: "CommandInterface", deadline: float) -> Iterator[Transport]:
    if sys.platform != "win32":
        raise OSError("The selected HC-05 requires Windows")
    import serial  # type: ignore[import-untyped]
    from serial.tools import list_ports  # type: ignore[import-untyped]

    address = selection.windows_port
    if address is None:
        raise OSError("The selected COM port is missing")

    def identity_matches() -> bool:
        matches = [port.hwid for port in list_ports.comports() if port.device.upper() == address]
        return matches == [selection.identity]

    if not identity_matches():
        raise OSError("The configured HC-05 identity is absent")
    with serial.Serial(
        address, baudrate=selection.serial_baud, bytesize=8, parity="N",
        stopbits=1, timeout=0, write_timeout=deadline, rtscts=False, xonxoff=False, dsrdtr=False,
    ) as port:
        if not identity_matches():
            raise OSError("The selected HC-05 changed while opening")
        # Retained transport packets cannot satisfy the newly correlated HELLO.
        port.reset_input_buffer()
        yield cast(Transport, port)


@dataclass(frozen=True)
class Renewal:
    generation: int
    direction: Direction
    deadline: float


class Preempted(Exception):
    pass


class CommandSession:
    """Correlate replies within one opened transport. A reconnect starts with HELLO."""

    def __init__(self, link: "SerialCommandLink", port: Transport):
        self.link, self.port = link, port
        self.boot = self.sequence = self.challenge = self.floor = self.issued_floor = 0
        self.challenge_until = 0.0
        self.generation: int | None = None
        self.frame = bytearray()
        self.discard_advisory = False
        self.advisory_credit: tuple[int, int, float] | None = None
        self.sent = 0.0

    def _observe_advisory(self, frame: bytes) -> bool:
        credit, self.advisory_credit = self.advisory_credit, None
        try:
            sample = decode_advisory(frame)
        except ValueError:
            self.link._note_proximity(None)
            return False
        if self.link.proximity_minimum is None:
            return True
        if credit is None or (sample.boot, sample.credit) != credit[:2] or sample.boot < self.link._proximity_boot:
            self.link._note_proximity(None)
            return True
        # Capture preceded the firmware reply. Request send is the earliest
        # possible reply creation time, so this bounds age through BLE buffering.
        self.link._note_proximity(ProximitySample(
            f"uno-{sample.boot}", sample.sequence, credit[2] - sample.age_ms / 1000, sample.distance_mm,
        ))
        return True

    def _recover_ack(self, frame: bytes, request: Packet) -> Packet | None:
        # An advisory may lose its delimiter or split into fragments. Only a
        # complete, correlated command ACK can end recovery before the deadline.
        opcode = request.op | REPLY
        for offset in range(max(0, len(frame) - MAX_FRAME), len(frame) - 3):
            if frame[offset + 1:offset + 3] != bytes((VERSION, opcode)):
                continue
            try:
                reply = decode(frame[offset:])
            except WireError:
                continue
            if (reply.op, reply.sequence) == (opcode, request.sequence):
                return reply
        return None

    def _exchange(self, packet: Packet, deadline: float) -> Packet:
        signal, clock = self.link._wake, self.link._clock
        resync = packet.op in (HELLO, STOP)
        wire = (DISCARD_PARTIAL if resync else b"") + encode(packet)
        self.sent = self.link._commit_write(
            packet.op, deadline if resync else min(deadline, self.challenge_until),
        )
        if self.port.write(wire) != len(wire):
            raise OSError("Incomplete command write")
        recovering = self.discard_advisory
        while clock() < deadline:
            if packet.op != STOP and self.link._stopping():
                raise Preempted
            data = self.port.read(MAX_FRAME)
            if not data:
                signal.wait(min(0.002, max(0.0, deadline - clock())))
                signal.clear()
                continue
            self.frame.extend(data)
            while (index := self.frame.find(0)) >= 0:
                frame = bytes(self.frame[:index + 1])
                del self.frame[:index + 1]
                if not self.discard_advisory and frame[0] == TAG:
                    if self._observe_advisory(frame):
                        continue
                    recovering = True
                elif not self.discard_advisory and misrouted_advisory(frame):
                    self.advisory_credit = None
                    self.link._note_proximity(None)
                    continue
                self.discard_advisory = False
                if len(frame) == 1:
                    continue
                if recovering:
                    reply = self._recover_ack(frame, packet)
                    if reply is None:
                        continue
                else:
                    reply = decode(frame)
                if packet.op == STOP and reply.boot == self.boot and reply.sequence < packet.sequence:
                    # A previously transmitted request can finish while STOP is written.
                    continue
                if (reply.op != packet.op | REPLY or reply.sequence != packet.sequence or clock() >= deadline
                        or reply.next_challenge <= self.challenge):
                    raise WireError("Unexpected or late command acknowledgment")
                self.challenge_until = self.sent + self.link._challenge
                return reply
            if len(self.frame) >= MAX_FRAME:
                if not self.discard_advisory and self.frame[0] != TAG:
                    raise WireError("Oversized command acknowledgment")
                if not self.discard_advisory:
                    self.advisory_credit = None
                    self.link._note_proximity(None)
                recovering = True
                self.discard_advisory = True
                del self.frame[:-(MAX_FRAME - 1)]
        raise WireError("Command acknowledgment deadline expired")

    def hello(self) -> None:
        request = Packet(HELLO, sequence=1 + randbelow(MAX_COUNTER))
        reply = self._exchange(request, self.link._clock() + self.link._hello_ack)
        if reply.build != self.link._build:
            raise WireVersionError("Unexpected Uno build")
        if not reply.boot or reply.flags or reply.direction or reply.challenge == MAX_COUNTER:
            raise WireError("Invalid disarmed HELLO reply")
        self.boot, self.sequence, self.challenge = reply.boot, reply.challenge, reply.next_challenge
        self.floor = self.issued_floor = reply.generation
        if self.link.proximity_minimum is not None and self.boot > self.link._proximity_boot:
            self.link._proximity_boot = self.boot
            self.link._note_proximity(None)
        self.advisory_credit = (self.boot, self.challenge, self.sent)

    def send(self, op: int, deadline: float, renewal: Renewal | None = None) -> None:
        if self.sequence == MAX_COUNTER:
            raise WireError("Uno sequence exhausted")
        self.sequence += 1
        generation = self.floor
        direction = 0
        if renewal is not None:
            if op == ARM:
                if self.floor == MAX_COUNTER:
                    raise WireError("Uno generation exhausted")
                generation = self.issued_floor = self.floor + 1
            elif self.generation != renewal.generation:
                raise WireError("Missing STOP between control generations")
            else:
                direction = DIRECTIONS.index(renewal.direction) + 1
        request = Packet(op, self.boot, 0 if op == STATUS else generation, self.sequence, self.challenge,
                         direction=direction)
        reply = self._exchange(request, deadline)
        armed = ARMED if op in (ARM, DRIVE) else 0
        generation_ok = (
            self.floor <= reply.generation <= self.issued_floor if op == STOP else reply.generation == generation
        )
        if (reply.boot != self.boot or reply.challenge != self.challenge or not generation_ok
                or reply.flags != armed or reply.direction != direction):
            raise WireError("Inconsistent Uno boot, generation, challenge or logical state")
        self.floor = self.issued_floor = reply.generation
        self.challenge = reply.next_challenge
        self.generation = renewal.generation if renewal is not None else None
        self.advisory_credit = (self.boot, self.challenge, self.sent)

    def best_effort_stop(self) -> None:
        # Even an uncorrelated STOP disables any compatible boot before it can acknowledge.
        packet = Packet(STOP, self.boot, self.floor, min(MAX_COUNTER, self.sequence + 1), self.challenge)
        try:
            self.port.write(DISCARD_PARTIAL + encode(packet))
        except (OSError, ValueError):
            pass


class SerialCommandLink:
    def __init__(
        self, profile: "QualificationProfile", build: bytes, open_port: OpenTransport,
        clock: Callable[[], float] = monotonic, *, proximity_minimum: int | None = None,
    ):
        self._clock = clock
        self._open = open_port
        self._build = build
        self._ack = profile.bound("command_ack_deadline_ms") / 1000
        # A disarmed HELLO includes a longer build reply and the resync prefix.
        hello_bits = (REQUEST_FRAME + len(DISCARD_PARTIAL) + MAX_FRAME) * 10
        self._hello_ack = self._ack + hello_bits / profile.bound("serial_baud")
        self._interval = profile.bound("command_renewal_interval_ms") / 1000
        self._challenge = profile.bound("challenge_lifetime_ms") / 1000
        self._expiry = profile.bound("firmware_expiry_ms") / 1000
        self._lock = Lock()
        self._wake, self._closed = Event(), Event()
        self._worker = Thread(target=self._run, daemon=True, name="hc05-command")
        self._pending: Renewal | None = None
        self._active = self._in_flight = self._stop_requested = False
        self._latched_fault: str | None = None
        self._ready_until = self._lease_until = self._submit_after = 0.0
        self._cause = "NOT_READY"
        self._output: Direction | None = None
        self.proximity_minimum = proximity_minimum
        self._proximity_boot = 0
        self._proximity_lock = Lock()
        self._proximity: deque[ProximitySample | None] = deque(maxlen=8)

    def _note_proximity(self, sample: ProximitySample | None) -> None:
        if self.proximity_minimum is None:
            return
        with self._proximity_lock:
            if len(self._proximity) == self._proximity.maxlen:
                self._proximity.clear()
                self._proximity.append(None)
            self._proximity.append(sample)

    def take_proximity(self) -> tuple[ProximitySample | None, ...]:
        with self._proximity_lock:
            samples = tuple(self._proximity)
            self._proximity.clear()
            return samples

    def start(self) -> None:
        self._worker.start()

    def close(self) -> None:
        self._closed.set()
        self._wake.set()
        # A Windows driver may still be opening the port. Retain process-level
        # device ownership until this worker has closed its handle.
        self._worker.join()

    @property
    def cause(self) -> str | None:
        with self._lock:
            if self._latched_fault or self._clock() >= self._ready_until or self._closed.is_set():
                return self._cause
            return None

    @property
    def output(self) -> Direction | None:
        with self._lock:
            return self._output if (self._clock() < self._ready_until and not self._latched_fault
                                    and not self._closed.is_set()) else None

    @property
    def failure(self) -> str:
        with self._lock:
            return self._fault_reason(self._clock())

    @property
    def latched_failure(self) -> str | None:
        with self._lock:
            return self._latched_fault

    def _fault_reason(self, now: float) -> str:
        if self._latched_fault:
            return self._latched_fault
        return "CommandExpired" if self._lease_until and now >= self._lease_until else "CommandUnavailable"

    def probe(self) -> bool:
        return self.cause is None

    def pulse(self, generation: int, direction: Direction, deadline: float) -> str | None:
        with self._lock:
            now = self._clock()
            if now >= self._ready_until or self._latched_fault or self._closed.is_set():
                return self._fault_reason(now)
            if now < deadline and now >= self._submit_after and not (self._in_flight or self._stop_requested):
                self._active = True
                self._pending = Renewal(generation, direction, deadline)
                self._wake.set()
        return None

    def revoke(self, generation: int, cause: str) -> None:
        with self._lock:
            now = self._clock()
            if cause in COMMAND_FAILURES:
                self._latched_fault = None
            elif self._active and now >= self._ready_until:
                self._latched_fault = self._fault_reason(now)
            self._stop_requested |= self._active
            self._active = False
            self._lease_until = 0.0
            self._pending = self._output = None
            self._wake.set()

    def _stopping(self) -> bool:
        with self._lock:
            return self._stop_requested or self._closed.is_set()

    def _commit_write(self, op: int, deadline: float) -> float:
        """Commit the single outstanding write against revoke, without holding the lock across I/O."""
        with self._lock:
            if op != STOP and (self._stop_requested or self._closed.is_set()):
                raise Preempted
            now = self._clock()
            if now >= deadline:
                raise WireError("Command deadline reached before write")
            return now

    def _ready(
        self, challenge_until: float, direction: Direction | None = None, sent: float | None = None,
    ) -> None:
        with self._lock:
            self._ready_until = min(challenge_until, self._clock() + self._interval + self._ack)
            self._cause = "NOT_READY"
            if not self._stop_requested:
                self._lease_until = 0.0 if sent is None else sent + self._expiry
                if self._lease_until:
                    self._ready_until = min(self._ready_until, self._lease_until)
                self._output = direction

    def _failed(self, cause: str) -> None:
        self._note_proximity(None)
        with self._lock:
            if self._ready_until:
                self._latched_fault = self._fault_reason(self._clock())
            self._active = self._in_flight = self._stop_requested = False
            self._pending = self._output = None
            self._ready_until = self._lease_until = 0.0
            self._cause = cause

    def _serve(self, session: CommandSession) -> None:
        session.hello()
        self._ready(session.challenge_until)
        poll_at = self._clock() + self._interval
        while not self._closed.is_set():
            now = self._clock()
            with self._lock:
                stop = self._stop_requested
                renewal, self._pending = self._pending, None
                status = not self._active and now >= poll_at
                self._in_flight = bool(stop or renewal or status)
            if self._in_flight:
                deadline = now + self._ack
                direction = None
                drove = False
                try:
                    if stop:
                        session.send(STOP, deadline)
                        with self._lock:
                            self._stop_requested = False
                    elif renewal:
                        if now >= renewal.deadline:
                            raise WireError("Backend renewal credit expired")
                        op = ARM if session.generation is None else DRIVE
                        session.send(op, min(deadline, renewal.deadline), renewal)
                        drove = op == DRIVE
                        direction = renewal.direction if drove else None
                    else:
                        session.send(STATUS, deadline)
                except Preempted:
                    continue
                self._ready(session.challenge_until, direction, now if renewal else None)
                poll_at = self._clock() + self._interval
                with self._lock:
                    self._submit_after = now + self._interval if drove else 0.0
                    self._in_flight = False
            else:
                self._wake.wait(min(self._interval, max(0.002, poll_at - now)))
                self._wake.clear()

    def _run(self) -> None:
        while not self._closed.is_set():
            try:
                with self._open() as port:
                    if self._closed.is_set():
                        return
                    session = CommandSession(self, port)
                    try:
                        self._serve(session)
                    except (OSError, ValueError) as error:
                        self._failed("PROTOCOL_UNSUPPORTED" if isinstance(error, WireVersionError) else "NOT_READY")
                        raise
                    finally:
                        session.best_effort_stop()
            except (OSError, ValueError, Preempted) as error:
                if isinstance(error, WireVersionError):
                    self._failed("PROTOCOL_UNSUPPORTED")
                # Retry diagnostics only. Reconnect cannot restore a previous hold.
                self._closed.wait(0.25)
