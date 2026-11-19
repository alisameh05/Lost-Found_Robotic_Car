"""Normalized simulated input and a bounded, expiring logical command device."""

import math
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import TYPE_CHECKING, Literal, Protocol, cast, get_args

from .registration_input import SAFE_INTEGER

if TYPE_CHECKING:
    from .simulation import QualificationProfile

Direction = Literal["forward", "backward", "left", "right"]
Intent = Literal[Direction, "neutral", "invalid", "emergency"]
DIRECTIONS = get_args(Direction)


@dataclass(frozen=True)
class InputScope:
    boot: str
    session: str
    generation: int


@dataclass(frozen=True)
class InputSample:
    scope: InputScope
    at: float
    intent: Intent


def gesture_intent(fingers: int | None, *, hands: int = 1, certain: bool = True, stable: bool = True) -> Intent:
    if hands != 1 or not certain or not stable or type(fingers) is not int or not 0 <= fingers <= 4:
        return "invalid"
    return ("neutral", "forward", "backward", "left", "right")[fingers]


def controller_intent(held: tuple[Direction, ...], *, circle: bool = False) -> Intent:
    if circle:
        return "emergency"
    if not held:
        return "neutral"
    return held[0] if len(held) == 1 and held[0] in DIRECTIONS else "invalid"


@dataclass(frozen=True)
class Challenge:
    scope: InputScope
    generation: int
    sequence: int
    expires: float


@dataclass(frozen=True)
class Command:
    challenge: Challenge
    direction: Direction


@dataclass(frozen=True)
class CommandEvent:
    event: str
    at: float
    generation: int
    output: Direction | None
    deadline: float | None
    cause: str | None = None


class CommandSink(Protocol):
    """Bounded, nonblocking device calls. A dropped or mismatched ACK is a failed renewal."""

    @property
    def output(self) -> Direction | None: ...
    def probe(self) -> bool: ...
    def challenge(self, scope: InputScope, generation: int) -> Challenge: ...
    def renew(self, command: Command) -> Command | None: ...
    def revoke(self, generation: int, cause: str) -> None: ...


class FixtureCommandSink:
    def __init__(self, profile: "QualificationProfile", clock: Callable[[], float]):
        self._clock = clock
        self._challenge_lifetime = profile.bound("challenge_lifetime_ms") / 1000
        self._permission_lifetime = profile.bound("firmware_expiry_ms") / 1000
        self._lock = Lock()
        self._wake = Event()
        self._closed = Event()
        self._watchdog: Thread | None = None
        self._boot: str | None = None
        self._scope: InputScope | None = None
        self._generation = 0
        self._invalid_through = 0
        self._sequence = 0
        self._challenge: Challenge | None = None
        self._output: Direction | None = None
        self._deadline: float | None = None
        self._journal: deque[CommandEvent] = deque(maxlen=256)

    def start(self) -> None:
        self._watchdog = Thread(target=self._watch, name="fixture-command-watchdog", daemon=True)
        self._watchdog.start()

    def close(self) -> None:
        self._closed.set()
        self._wake.set()
        if self._watchdog is not None:
            self._watchdog.join()

    def _watch(self) -> None:
        while not self._closed.is_set():
            self._wake.clear()
            with self._lock:
                now = self._clock()
                self._expire(now)
                delay = None if self._deadline is None else max(0.0, self._deadline - now)
            self._wake.wait(delay)

    @property
    def journal(self) -> tuple[CommandEvent, ...]:
        with self._lock:
            self._expire(self._clock())
            return tuple(self._journal)

    @property
    def output(self) -> Direction | None:
        with self._lock:
            self._expire(self._clock())
            return self._output

    def probe(self) -> bool:
        return not self._closed.is_set()

    def _expire(self, now: float) -> None:
        if self._deadline is not None and now >= self._deadline:
            deadline, self._deadline = self._deadline, None
            self._invalid_through = self._generation
            self._challenge = None
            self._output = None
            self._journal.append(CommandEvent("expired", now, self._generation, None, deadline))

    def challenge(self, scope: InputScope, generation: int) -> Challenge:
        with self._lock:
            now = self._clock()
            self._expire(now)
            self._sequence += 1
            challenge = Challenge(scope, generation, self._sequence, now + self._challenge_lifetime)
            if (not self._closed.is_set() and self._sequence <= SAFE_INTEGER
                    and self._invalid_through < generation <= SAFE_INTEGER
                    and generation >= self._generation and self._boot in (None, scope.boot)
                    and (self._output is None or (generation == self._generation and scope == self._scope))):
                self._challenge = challenge
            return challenge

    def renew(self, command: Command) -> Command | None:
        with self._lock:
            now = self._clock()
            self._expire(now)
            challenge = command.challenge
            if (self._closed.is_set() or challenge != self._challenge or now >= challenge.expires
                    or challenge.generation <= self._invalid_through or command.direction not in DIRECTIONS):
                self._journal.append(CommandEvent("rejected", now, challenge.generation, self._output, self._deadline))
                return None
            self._challenge = None
            self._boot = challenge.scope.boot
            self._scope = challenge.scope
            self._generation = challenge.generation
            self._deadline = now + self._permission_lifetime
            self._output = command.direction
            self._journal.append(CommandEvent("renewed", now, self._generation, self._output, self._deadline))
            self._wake.set()
            return command

    def revoke(self, generation: int, cause: str) -> None:
        with self._lock:
            now = self._clock()
            self._expire(now)
            self._invalid_through = max(self._invalid_through, generation)
            self._challenge = None
            self._journal.append(CommandEvent("revoked", now, generation, self._output, self._deadline, cause))
            self._output, self._deadline = None, None
            self._journal.append(CommandEvent("stop", now, generation, None, None, cause))
            self._wake.set()


class Motion:
    def __init__(self, sink: CommandSink, profile: "QualificationProfile"):
        self.sink = sink
        self._interval = profile.bound("command_renewal_interval_ms") / 1000
        self._ack_limit = profile.bound("command_ack_deadline_ms") / 1000
        self._limit = profile.bound("input_sample_deadline_ms") / 1000
        self._generation = 0
        self._scope: InputScope | None = None
        self._sample_at = -math.inf
        self._neutral = False
        self._direction: Direction | None = None
        self._renew_at: float | None = None

    @property
    def permission(self) -> str:
        if self._direction is not None and self._logical_output() == self._direction:
            return "Armed"
        return "Arming" if self._direction is None and self._neutral else "Disarmed"

    def command_ready(self) -> bool:
        try:
            return self.sink.probe()
        except OSError:
            return False

    def stop(self, cause: str) -> None:
        was_held = self._direction is not None
        self._neutral = False
        self._direction = None
        self._renew_at = None
        if was_held:
            try:
                self.sink.revoke(self._generation, cause)
            except OSError:
                # Loss of the STOP transport leaves only the independent device deadline.
                pass

    def _logical_output(self) -> Direction | None:
        try:
            return self.sink.output
        except OSError:
            return None

    def accept(self, scope: InputScope, sample: InputSample | None, now: float) -> None:
        if self._scope != scope:
            self.stop("ScopeChanged")
            self._scope, self._sample_at = scope, now
            return
        if (sample is None or sample.scope != scope or not math.isfinite(sample.at)
                or not self._sample_at < sample.at <= now or now - sample.at >= self._limit):
            return
        self._sample_at = sample.at
        intent = sample.intent
        if intent not in DIRECTIONS:
            self.stop("InputReleased" if intent == "neutral" else "InputInvalid")
            self._neutral = intent == "neutral"
            return
        if self._direction is not None and self._direction != intent:
            self.stop("InputChanged")
        if self._neutral and self._direction is None:
            if self._generation >= SAFE_INTEGER:
                self.stop("CounterExhausted")
                return
            self._generation += 1
            self._direction = cast(Direction, intent)

    def loss(self, now: float) -> str | None:
        if self._direction is None:
            return None
        if self._renew_at is not None and self._logical_output() != self._direction:
            return "CommandExpired"
        return "InputUnavailable" if now - self._sample_at >= self._limit else None

    def tick(self, scope: InputScope, now: float, clock: Callable[[], float]) -> str | None:
        if self._direction is None or self._scope != scope:
            return None
        if failure := self.loss(now):
            return failure
        if self._renew_at is not None and self._renew_at > now:
            return None
        try:
            command = Command(self.sink.challenge(scope, self._generation), self._direction)
            if self.sink.renew(command) != command or clock() - now >= self._ack_limit:
                return "CommandUnavailable"
        except OSError:
            return "CommandUnavailable"
        self._renew_at = now + self._interval
        return None
