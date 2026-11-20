"""Track a rejected review's image region across identified robot acquisitions."""

from dataclasses import dataclass
from io import BytesIO
from math import sqrt
from typing import Literal

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from .candidate import CandidateCapture
from .motion import InputScope

MAX_IMAGE = (160, 120)
SAMPLES = 10
MAX_GAP_US = 180_000
MATCH_ERROR = 15
ABSENT_ERROR = 26
AMBIGUITY_MARGIN = 5
MIN_CONTRAST = 20
SHADOW_CONTRAST = 8
SHADOW_CORRELATION = 0.93
TRAILING_FRACTION = 0.30
Edge = Literal["left", "right", "top", "bottom"]
EDGES: tuple[Edge, ...] = ("left", "right", "top", "bottom")
Pixels = NDArray[np.int16]


@dataclass(frozen=True)
class Acquisition:
    scope: InputScope
    worker: str
    frame_id: str
    stream: str
    clock: str
    sequence: int
    source_us: int

    def same_stream(self, previous: "Acquisition") -> bool:
        return (self.scope, self.worker, self.stream, self.clock) == (
            previous.scope, previous.worker, previous.stream, previous.clock,
        )


@dataclass(frozen=True)
class Position:
    x: int
    y: int

    def nearby(self, previous: "Position", template: "Template") -> bool:
        return abs(self.x - previous.x) <= template.width / 2 and abs(self.y - previous.y) <= template.height / 2

    def margins(self, template: "Template") -> dict[Edge, int]:
        height, width = template.image_shape
        return {"left": self.x, "right": width - self.x - template.width,
                "top": self.y, "bottom": height - self.y - template.height}


@dataclass(frozen=True)
class Template:
    image_shape: tuple[int, int]
    source_size: tuple[int, int]
    origin: Position
    width: int
    height: int
    samples: tuple[tuple[int, int, int], ...]


@dataclass(frozen=True)
class Observation:
    pixels: Pixels
    template: Template | None
    position: Position | None = None
    absent: bool = False


@dataclass(frozen=True)
class BorderExit:
    edge: Edge
    last_visible: Position


def _pixels(jpeg: bytes) -> Pixels:
    with Image.open(BytesIO(jpeg)) as original:
        image = original.convert("L")
        image.thumbnail(MAX_IMAGE, Image.Resampling.BOX)
        return np.asarray(image, dtype=np.int16)


def _template(seed: CandidateCapture) -> Template | None:
    image = _pixels(seed.capture.jpeg)
    source_width, source_height = seed.capture.width, seed.capture.height
    height, width = image.shape
    x, y, w, h = seed.box
    left, right = (round(value * width / source_width) for value in (x, x + w))
    top, bottom = (round(value * height / source_height) for value in (y, y + h))
    w, h = right - left, bottom - top
    if min(w, h) < SAMPLES:
        return None
    samples = tuple(
        (dx, dy, int(image[top + dy, left + dx]))
        for dy in (int((i + 0.5) * h / SAMPLES) for i in range(SAMPLES))
        for dx in (int((i + 0.5) * w / SAMPLES) for i in range(SAMPLES))
    )
    return Template((height, width), (source_width, source_height), Position(left, top), w, h, samples)


def _original_still_plausible(image: Pixels, template: Template, best: Position, anchor: Position) -> bool:
    # Compare the uncovered part of the last trusted region. A shadow can change absolute
    # brightness without removing its texture, and an overlapping lookalike can hide the rest.
    samples = [
        (value, int(image[anchor.y + dy, anchor.x + dx]))
        for dx, dy, value in template.samples
        if not (best.x <= anchor.x + dx < best.x + template.width
                and best.y <= anchor.y + dy < best.y + template.height)
    ]
    count = len(samples)
    if count < SAMPLES * SAMPLES // 5:
        return False
    reference, observed = zip(*samples, strict=True)
    reference_sum, observed_sum = sum(reference), sum(observed)
    reference_spread = count * sum(x * x for x in reference) - reference_sum**2
    observed_spread = count * sum(y * y for y in observed) - observed_sum**2
    if reference_spread < (MIN_CONTRAST * count)**2 or observed_spread < (SHADOW_CONTRAST * count)**2:
        return False
    covariance = count * sum(x * y for x, y in samples) - reference_sum * observed_sum
    return bool(covariance >= SHADOW_CORRELATION * sqrt(reference_spread * observed_spread))


def observe(jpeg: bytes, size: tuple[int, int], seed: CandidateCapture, template: Template | None,
            anchor: Position | None) -> Observation:
    """Find uniquely associated translations of the exact reviewed region, including clipped ones."""
    image = _pixels(jpeg)
    template = template or _template(seed)
    if template is None or template.source_size != size or template.image_shape != image.shape:
        return Observation(image, template)
    height, width = image.shape
    # Each cell represents the template's origin. Compare only sample points inside the image.
    offset_x, offset_y = template.width - 1, template.height - 1
    shape = (height + offset_y, width + offset_x)
    error = np.zeros(shape, dtype=np.int32)
    count = np.zeros(shape, dtype=np.int16)
    total = np.zeros(shape, dtype=np.int32)
    squares = np.zeros(shape, dtype=np.int32)
    for dx, dy, intensity in template.samples:
        region = np.s_[offset_y - dy:offset_y - dy + height, offset_x - dx:offset_x - dx + width]
        error[region] += np.abs(image - intensity)
        count[region] += 1
        total[region] += intensity
        squares[region] += intensity * intensity
    # Low-texture portions of the template cannot identify a partly visible object.
    textured = squares * count - total**2 >= (MIN_CONTRAST * count.astype(np.int32))**2
    scores = np.full(shape, np.inf)
    np.divide(error, count, out=scores, where=(count >= SAMPLES * SAMPLES // 5) & textured)
    best_row, best_col = np.unravel_index(scores.argmin(), shape)
    row, col = int(best_row), int(best_col)
    best = float(scores[row, col])
    if best > MATCH_ERROR:
        return Observation(image, template, absent=ABSENT_ERROR <= best < float("inf"))
    # Neighbors within one local peak are the same association. Competing peaks veto it.
    radius_x, radius_y = template.width // 4, template.height // 4
    scores[max(0, row - radius_y):row + radius_y + 1, max(0, col - radius_x):col + radius_x + 1] = np.inf
    position = Position(col - offset_x, row - offset_y)
    if (float(scores.min()) <= best + AMBIGUITY_MARGIN
            or _original_still_plausible(image, template, position, anchor or template.origin)):
        return Observation(image, template)
    return Observation(image, template, position)


class RejectedTrack:
    """A witness within one uninterrupted acquisition path. The seed survives interruptions."""

    def __init__(self, seed: CandidateCapture):
        self.seed = seed
        self.template: Template | None = None
        self.last: Acquisition | None = None
        self.anchor: Position | None = None
        self._previous: Position | None = None
        self._backgrounds: dict[Edge, Pixels] = {}
        self._departure: Edge | None = None
        self._exit: BorderExit | None = None

    def interrupt(self) -> None:
        self.last = None
        self._forget_path()

    def _forget_path(self) -> None:
        self._previous = None
        self._backgrounds.clear()
        self._departure = None
        self._exit = None

    def _clear_border(self, observation: Observation, edge: Edge, previous: Position, template: Template) -> bool:
        baseline = self._backgrounds[edge]
        height, width = template.image_shape
        area = np.s_[max(0, previous.y):min(height, previous.y + template.height),
                     max(0, previous.x):min(width, previous.x + template.width)]
        delta = np.abs(observation.pixels[area] - baseline[area])
        return bool(delta.size and delta.mean() <= 8 and np.mean(delta > 24) <= 0.15)

    def accept(self, stamp: Acquisition, observation: Observation) -> bool:
        if self.last:
            if not stamp.same_stream(self.last):
                self.interrupt()
            elif (stamp.sequence <= self.last.sequence or stamp.source_us <= self.last.source_us
                  or stamp.frame_id == self.last.frame_id):
                return False
            elif stamp.sequence != self.last.sequence + 1 or stamp.source_us - self.last.source_us > MAX_GAP_US:
                # A gap cannot finish a crossing in either direction. An exit already witnessed
                # on this stream can precede a fresh, fully observed re-entry.
                witnessed_exit = self._exit
                self._forget_path()
                self._exit = witnessed_exit
        self.last = stamp
        self.template = template = observation.template
        if template is None:
            return False
        position, previous = observation.position, self._previous
        if position is None:
            if (observation.absent and self._departure and previous
                    and visible(previous, self._departure, template) <= TRAILING_FRACTION
                    and self._clear_border(observation, self._departure, previous, template)):
                self._exit = BorderExit(self._departure, previous)
                self._departure, self._previous = None, None
            elif not (observation.absent and self._exit and previous is None):
                self._forget_path()
            return False

        margins = position.margins(template)
        clipped = [edge for edge, margin in margins.items() if margin < 0]
        edge = clipped[0] if len(clipped) == 1 else None
        if previous and not position.nearby(previous, template):
            self._forget_path()
            previous = None
        if self._exit:
            reentry = self._exit.edge
            if previous and not clipped and visible(previous, reentry, template) > 0.5:
                return True
            if edge == reentry:
                coverage = visible(position, reentry, template)
                if ((previous is None and coverage <= TRAILING_FRACTION
                     and position.nearby(self._exit.last_visible, template))
                        or (previous and coverage >= visible(previous, reentry, template))):
                    self._previous = position
                    return False
            self._forget_path()
            previous = None

        if not clipped:
            # Start or recover at the rejected box or the last confidently associated full box.
            # A unique-looking box somewhere else has no observed link to the rejected one.
            if previous is None and not position.nearby(self.anchor or template.origin, template):
                return False
            self.anchor = position
            self._departure = None
            for side, margin in margins.items():
                if margin >= extent(side, template) * TRAILING_FRACTION:
                    self._backgrounds[side] = observation.pixels
        elif edge and previous and edge in self._backgrounds:
            before, after = visible(previous, edge, template), visible(position, edge, template)
            if (min(previous.margins(template).values()) >= 0 and after > 0.5
                    or self._departure == edge and after <= before):
                self._departure = edge
            else:
                self._forget_path()
        else:
            self._forget_path()
        self._previous = position
        return False


def extent(edge: Edge, template: Template) -> int:
    return template.width if edge in ("left", "right") else template.height


def visible(position: Position, edge: Edge, template: Template) -> float:
    return 1 + min(0, position.margins(template)[edge]) / extent(edge, template)
