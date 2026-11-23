import pytest

from backend.app.proximity_wire import AdvisoryPacket, decode_advisory
from backend.app.simulation import ProximityAdvisory, ProximitySample, load_simulation
from backend.tests.proximity_replay import advisory_frame


def test_advisory_frame_reports_sample_identity_validity_and_age():
    assert decode_advisory(advisory_frame()) == AdvisoryPacket(7, 12, 3, 8, 200)
    assert decode_advisory(advisory_frame(valid=0, distance=0)) == AdvisoryPacket(7, 12, 3, 8, None)


@pytest.mark.parametrize("fields", [
    {"version": 2}, {"boot": 0}, {"credit": 0}, {"sequence": 0},
    {"age_ms": 0}, {"valid": 2}, {"valid": 0}, {"distance": 0}, {"distance": 6001},
])
def test_untrusted_advisory_frames_are_rejected(fields):
    with pytest.raises(ValueError):
        decode_advisory(advisory_frame(**fields))


def test_a_new_boot_cannot_finish_the_previous_boots_clear_run():
    fixture = load_simulation("fixture-v1")
    assert fixture
    advisory = ProximityAdvisory(fixture.profile, minimum=15)
    observations = [
        ("uno-7", 1, 150, "Warning"),
        ("uno-7", 2, 230, "Warning"),
        ("uno-7", 3, 230, "Warning"),
        ("uno-8", 1, 230, "Warning"),
        ("uno-8", 2, 230, "Warning"),
        ("uno-8", 3, 230, "Clear"),
        ("uno-8", 4, 14, "Unknown"),
        ("uno-8", 5, 230, "Unknown"),
    ]
    for index, (boot, sequence, distance, expected) in enumerate(observations):
        now = 1 + index * 0.05
        advisory.observe(ProximitySample(boot, sequence, now, distance), now, 1000)
        assert advisory.payload["state"] == expected
        assert advisory.payload["warning_latched"] is (expected == "Warning")
        if distance == 14:
            assert advisory.payload["distance_mm"] is None
