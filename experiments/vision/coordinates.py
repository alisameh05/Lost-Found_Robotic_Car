"""Boxes are half-open xyxy in orientation-normalized source pixels.

Ultralytics Results.boxes.xyxy already uses original image pixels. Only raw
model-space boxes go through unletterbox; applying it to Results is incorrect.
"""

import math


def clamp_box(box: tuple, size: tuple[int, int]) -> tuple[float, ...]:
    width, height = size
    if width <= 0 or height <= 0 or len(box) != 4:
        raise ValueError("Invalid image size or box")
    if not all(math.isfinite(v) for v in box):
        raise ValueError("Nonfinite box")
    x1, y1, x2, y2 = box
    clipped = (
        max(0, min(width, x1)),
        max(0, min(height, y1)),
        max(0, min(width, x2)),
        max(0, min(height, y2)),
    )
    if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
        raise ValueError("Empty box")
    return clipped


def roi_xyxy(roi: tuple, size: tuple[int, int]) -> tuple[float, ...]:
    x, y, width, height = roi
    if width <= 0 or height <= 0:
        raise ValueError("Empty ROI")
    return clamp_box((x, y, x + width, y + height), size)


def unletterbox(box: tuple, size: tuple[int, int], gain: tuple, padding: tuple) -> tuple[float, ...]:
    """Invert a recorded model-input transform, never an Ultralytics Result."""
    gx, gy = gain
    px, py = padding
    if not all(math.isfinite(v) for v in (gx, gy, px, py)) or min(gx, gy) <= 0:
        raise ValueError("Invalid transform")
    x1, y1, x2, y2 = box
    return clamp_box(((x1 - px) / gx, (y1 - py) / gy, (x2 - px) / gx, (y2 - py) / gy), size)
