import pytest

from backend.app.motion import Command, FixtureCommandSink, InputSample, InputScope, Motion, gesture_intent
from backend.app.simulation import load_simulation


def test_device_expires_without_stop_or_a_backend_tick() -> None:
    simulation = load_simulation("fixture-v1")
    assert simulation is not None
    now = 1.0
    sink = FixtureCommandSink(simulation.profile, lambda: now)
    scope = InputScope("boot", "session", 2)
    challenge = sink.challenge(scope, 1)
    command = Command(challenge, "forward")
    assert sink.renew(command) == command
    assert sink.output == "forward"
    assert sink.renew(command) is None
    now = 1.221
    assert sink.output is None
    assert sink.renew(command) is None
    assert [entry.event for entry in sink.journal] == ["renewed", "rejected", "expired", "rejected"]
    expiry = sink.journal[2]
    assert expiry.deadline == 1.22
    assert expiry.output is None


def test_released_generation_and_old_input_cannot_rearm() -> None:
    simulation = load_simulation("fixture-v1")
    assert simulation is not None
    now = 1.0
    sink = FixtureCommandSink(simulation.profile, lambda: now)
    scope = InputScope("boot", "session", 2)
    motion = Motion(sink, simulation.profile)
    motion.accept(scope, None, now)
    now += 0.01
    motion.accept(scope, InputSample(scope, now, "neutral"), now)
    now += 0.01
    held = InputSample(scope, now, "left")
    motion.accept(scope, held, now)
    assert motion.tick(scope, now, lambda: now) is None and sink.output == "left"
    queued = Command(sink.challenge(scope, 1), "left")
    now += 0.01
    motion.accept(scope, InputSample(scope, now, "neutral"), now)
    assert sink.renew(queued) is None
    assert sink.renew(Command(sink.challenge(scope, 1), "left")) is None
    motion.accept(scope, held, now)
    motion.accept(scope, InputSample(InputScope("boot", "other", 2), now, "left"), now)
    assert motion.tick(scope, now, lambda: now) is None and sink.output is None
    now += 0.01
    motion.accept(scope, InputSample(scope, now, "right"), now)
    assert motion.tick(scope, now, lambda: now) is None and sink.output == "right"
    assert sink.journal[-1].generation == 2


@pytest.mark.parametrize("qualities", [{"hands": 0}, {"hands": 2}, {"certain": False}, {"stable": False}])
def test_unqualified_zero_does_not_count_as_neutral(qualities: dict) -> None:
    assert gesture_intent(0, **qualities) == "invalid"
