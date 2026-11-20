"""T4 finger-count classification and stability, independent of preview mirroring."""

from dataclasses import dataclass
from math import dist, isfinite

from .motion import Intent, gesture_intent

CONFIDENCE = 0.70
MAX_GAP = 0.12
NEUTRAL_TIME = 0.06
HOLD_TIME = 0.09

Point = tuple[float, float, float]


@dataclass(frozen=True)
class Hand:
    side: str
    confidence: float
    image: tuple[Point, ...]


@dataclass(frozen=True)
class Pose:
    label: str
    count: int | None = None
    side: str = ""
    fingers: int = 0
    center: tuple[float, float] = (0., 0.)
    scale: float = 0.


def _vector(start: Point, end: Point) -> Point:
    return end[0] - start[0], end[1] - start[1], end[2] - start[2]


def _dot(a: Point, b: Point) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def _cos(a: Point, b: Point) -> float:
    scale = (_dot(a, a) * _dot(b, b)) ** 0.5
    return _dot(a, b) / scale if scale > 0 else 0


def _finger(joints: tuple[Point, ...], palm: Point, thumb_axis: Point | None = None) -> bool | None:
    base, first, second, tip = joints
    bones = [_vector(a, b) for a, b in zip(joints[:-1], joints[1:], strict=True)]
    span = sum(dist(a, b) for a, b in zip(joints[:-1], joints[1:], strict=True))
    if not span or min(_dot(bone, bone) for bone in bones) ** 0.5 < span * 0.09:
        return None
    reach = dist(base, tip) / span
    bend = min(_cos(bones[0], bones[1]), _cos(bones[1], bones[2]))
    if thumb_axis is not None:
        radial = _cos(thumb_axis, _vector(first, tip))
        if radial > 0.55 and reach > 0.86 and bend > 0.60:
            return True
        if radial < 0.12 or reach < 0.70:
            return False
    else:
        along = _cos(palm, _vector(first, tip))
        if reach > 0.88 and bend > 0.70 and along > 0.45:
            return True
        if reach < 0.72 and (bend < 0.65 or along < 0.20):
            return False
    return None


def classify(hands: tuple[Hand, ...], width: int, height: int) -> Pose:
    if len(hands) != 1:
        return Pose("No hand detected" if not hands else "Multiple hands detected")
    hand = hands[0]
    unclear = Pose("Unclear hand pose")
    if (hand.side not in ("Left", "Right") or not CONFIDENCE <= hand.confidence <= 1
            or len(hand.image) != 21 or any(not isfinite(v) for p in hand.image for v in p)):
        return unclear
    if any(not (0.025 <= x <= 0.975 and 0.025 <= y <= 0.975) for x, y, _ in hand.image):
        return Pose("Keep the whole hand in view")
    pixels = tuple((x * width, y * height, 0.) for x, y, _ in hand.image)
    across = _vector(pixels[17], pixels[5])
    up = _vector(pixels[0], pixels[9])
    area = abs(across[0] * up[1] - across[1] * up[0])
    scale = _dot(up, up) ** 0.5
    if scale < 32 or area < 0.45 * scale ** 2:
        return Pose("Face the palm toward the camera")
    # The task normalizes z on approximately the same scale as x. Keep the
    # image-space hand geometry so horizontal reflection preserves joint angles.
    joints = tuple((x * width, y * height, z * width) for x, y, z in hand.image)
    palm = _vector(joints[0], joints[9])
    thumb_axis = _vector(joints[17], joints[5])
    fingers = 0
    for index, base in enumerate((1, 5, 9, 13, 17)):
        state = _finger(joints[base:base + 4], palm, thumb_axis if base == 1 else None)
        if state is None:
            return unclear
        if state:
            fingers |= 1 << index
    center = ((pixels[0][0] + pixels[9][0]) / 2, (pixels[0][1] + pixels[9][1]) / 2)
    return Pose("", fingers.bit_count(), hand.side, fingers, center, scale)


class StableGesture:
    def __init__(self) -> None:
        self._last: tuple[float, int, Pose] | None = None
        self._since = 0.
        self._neutral = False
        self._settling = False

    def accept(self, pose: Pose, at: float, sequence: int) -> tuple[Intent, str]:
        last = self._last
        if last and (at <= last[0] or sequence <= last[1]):
            return "invalid", "Gesture sample unavailable"
        previous = last[2] if last else None
        same_hand = bool(previous and pose.side == previous.side and previous.scale and pose.scale
                         and min(previous.scale, pose.scale) >= .6 * max(previous.scale, pose.scale)
                         and dist(previous.center, pose.center) <= .7 * min(previous.scale, pose.scale))
        contiguous = bool(last and sequence == last[1] + 1 and at - last[0] <= MAX_GAP and same_hand)
        same = bool(contiguous and previous and pose.fingers == previous.fingers)
        self._last = (at, sequence, pose)
        if not same:
            self._since = at
            self._settling = contiguous and self._neutral
            self._neutral = False
        count = pose.count
        if count is None or count == 5:
            self._neutral = self._settling = False
            return "invalid", pose.label or "5 fingers - unsupported"
        intent = gesture_intent(count)
        label = f"{count} {'finger' if count == 1 else 'fingers'} - {intent}"
        if at - self._since < (HOLD_TIME if count else NEUTRAL_TIME):
            return ("settling" if count and self._settling else "invalid"), f"{label} (stabilizing)"
        self._neutral = count == 0
        return intent, label
