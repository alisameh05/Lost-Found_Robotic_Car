from dataclasses import replace
from math import cos, radians, sin

import pytest

from backend.app.gestures import Hand, StableGesture, classify


def hand(mask: int, side: str = "Left", angle: int = 0, mirror: bool = False) -> Hand:
    """A frontal hand skeleton with independent thumb/finger joints in palm units."""
    points = [(0.0, 0.0, 0.0)]
    points.extend([
        (-.32, .22, 0), (-.55, .46, 0), (-.83, .65, 0), (-1.10, .83, 0),
    ] if mask & 1 else [
        (-.32, .22, 0), (-.55, .46, 0), (-.47, .66, .14), (-.23, .68, .20),
    ])
    for index, x in enumerate((-.45, -.15, .17, .45), 1):
        points.extend([(x, 1., 0), (x, 1.33, 0), (x, 1.59, 0), (x, 1.80, 0)] if mask & (1 << index)
                      else [(x, 1., 0), (x, 1.24, .15), (x, 1.20, .38), (x, 1.04, .43)])
    c, s = cos(radians(angle)), sin(radians(angle))
    direction = -1 if (side == "Right") != mirror else 1
    pixels = tuple((.5 + .15 * direction * (x * c - y * s), .5 - .20 * (x * s + y * c), .15 * z)
                   for x, y, z in points)
    return Hand(side, .99, pixels)


@pytest.mark.parametrize("side", ["Left", "Right"])
@pytest.mark.parametrize("rotation", [0, 87, 180])
@pytest.mark.parametrize("mirror", [False, True])
@pytest.mark.parametrize("mask", [0, 1, 2, 7, 11, 15, 31])
def test_counts_each_finger_independent_of_hand_and_preview_orientation(
    mask: int, mirror: bool, rotation: int, side: str,
) -> None:
    assert classify((hand(mask, side, rotation, mirror),), 640, 480).count == mask.bit_count()


def test_rejects_low_confidence_partial_edge_on_and_ambiguous_hands() -> None:
    sample = hand(0)
    edge = replace(sample, image=tuple((.01, y, z) for _, y, z in sample.image))
    sideways = replace(sample, image=tuple((.5 + (x - .5) * .1, y, z) for x, y, z in sample.image))
    ambiguous = replace(sample, image=(*sample.image[:8], sample.image[7], *sample.image[9:]))
    for hands in [(), (sample, hand(1)), (replace(sample, confidence=.4),), (edge,), (sideways,), (ambiguous,)]:
        assert classify(hands, 640, 480).count is None


def test_stability_rejects_old_duplicate_and_skipped_observations() -> None:
    stability = StableGesture()
    zero = classify((hand(0),), 640, 480)
    one = classify((hand(1),), 640, 480)
    for seq, at, pose, expected in [
        (1, 1., zero, "invalid"), (2, 1.04, zero, "invalid"), (3, 1.08, zero, "neutral"),
        (3, 1.10, zero, "invalid"), (4, 1.06, zero, "invalid"), (4, 1.12, one, "settling"),
        (6, 1.19, one, "invalid"), (7, 1.23, one, "invalid"), (8, 1.27, one, "invalid"),
        (9, 1.31, one, "forward"), (10, 1.6, one, "invalid"),
    ]:
        assert stability.accept(pose, at, seq)[0] == expected


def test_distant_same_handed_observation_cannot_inherit_neutral_or_a_hold() -> None:
    stability = StableGesture()
    zero = classify((hand(0),), 640, 480)
    one = classify((hand(1),), 640, 480)
    far_away = replace(one, center=(one.center[0] + 100, one.center[1]))
    assert stability.accept(zero, 1., 1)[0] == "invalid"
    assert stability.accept(zero, 1.08, 2)[0] == "neutral"
    assert stability.accept(far_away, 1.11, 3)[0] == "invalid"
    assert stability.accept(far_away, 1.22, 4)[0] == "forward"
    assert stability.accept(one, 1.26, 5)[0] == "invalid"
