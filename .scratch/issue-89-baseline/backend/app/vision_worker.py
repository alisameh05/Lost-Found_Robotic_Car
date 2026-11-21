"""Bounded, versioned request/reply transport for the local matcher."""

import asyncio
import json
import math
import multiprocessing
import os
import re
from collections.abc import Callable
from concurrent.futures import Future
from dataclasses import dataclass
from multiprocessing.connection import Connection, wait
from pathlib import Path
from threading import Thread
from time import sleep
from types import TracebackType
from typing import TYPE_CHECKING, Literal, cast
from uuid import uuid4

from .http import HttpError, json_fields, reject_nonfinite
from .reference_image import PIXEL_LIMIT
from .registration_input import SAFE_INTEGER, canonical_json

if TYPE_CHECKING:
    from multiprocessing.connection import PipeConnection

    LocalPipe = Connection | PipeConnection
else:
    LocalPipe = Connection

VERSION = 1
HEADER_LIMIT = 4096
REFERENCE_LIMIT = 100_000_000  # Managed reference byte limit, including normalized PNGs.
STARTUP_SECONDS = 90.0
PROGRESS_SECONDS = 2.5
PROBE_INTERVAL = 0.25
RESTART_INTERVAL = 2.0
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}")
Box = tuple[float, float, float, float]
RequestKind = Literal["probe", "prepare", "frame", "clear"]
BASE = {"kind", "boot", "worker", "request"}
IMAGE = {"width", "height", "size"}
FRAME = {"session", "generation", "stream", "clock", "sequence", "frame", "source_us"}


class WorkerFault(RuntimeError):
    def __init__(self, detail: str, cause: str = "NOT_READY"):
        super().__init__(detail)
        self.cause = cause


@dataclass(frozen=True)
class Prompt:
    id: str
    content_type: str
    width: int
    height: int
    roi: tuple[int, int, int, int]
    image: bytes

    def fields(self, session: str) -> dict[str, object]:
        return {"session": session, "prompt": self.id, "format": self.content_type, "width": self.width,
                "height": self.height, "roi": list(self.roi), "size": len(self.image)}


@dataclass(frozen=True)
class FrameLimits:
    bytes: int
    width: int
    height: int
    pixels: int


WorkerTarget = Callable[[LocalPipe, str, str, Path | None, Path, FrameLimits], None]


def send(pipe: LocalPipe, fields: dict[str, object]) -> None:
    data = canonical_json({"version": VERSION, **fields}).encode("utf-8")
    if len(data) > HEADER_LIMIT:
        raise WorkerFault("Worker header too large", "PROTOCOL_UNSUPPORTED")
    pipe.send_bytes(data)


def receive(pipe: LocalPipe) -> dict[str, object]:
    try:
        raw = json.loads(pipe.recv_bytes(HEADER_LIMIT).decode("utf-8"), object_pairs_hook=json_fields,
                         parse_constant=reject_nonfinite)
    except (EOFError, BrokenPipeError) as exc:
        raise WorkerFault("Local YOLOE worker exited") from exc
    except (OSError, ValueError, HttpError, RecursionError) as exc:
        raise WorkerFault("Worker header unreadable", "PROTOCOL_UNSUPPORTED") from exc
    if not isinstance(raw, dict) or type(raw.get("version")) is not int or raw.pop("version") != VERSION:
        raise WorkerFault("Worker version mismatch", "PROTOCOL_UNSUPPORTED")
    return raw


def valid_integer(value: object, minimum: int = 1, maximum: int = SAFE_INTEGER) -> bool:
    return type(value) is int and minimum <= value <= maximum


def request_fields(request: dict[str, object], kind: RequestKind, limits: FrameLimits) -> None:
    extra = {"prepare": {"prompt", *IMAGE, "roi", "format", "session"},
             "frame": {"prompt", *IMAGE, *FRAME}}.get(kind, set())
    if request.keys() != BASE | extra or not valid_integer(request["request"]):
        raise WorkerFault("Invalid worker request", "PROTOCOL_UNSUPPORTED")
    for key in extra & {"prompt", "session", "stream", "clock", "frame"}:
        value = request[key]
        if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
            raise WorkerFault("Invalid worker request identity", "PROTOCOL_UNSUPPORTED")
    if kind in ("probe", "clear"):
        return
    width, height, size = (request[key] for key in ("width", "height", "size"))
    bound = FrameLimits(REFERENCE_LIMIT, PIXEL_LIMIT, PIXEL_LIMIT, PIXEL_LIMIT) if kind == "prepare" else limits
    if (not valid_integer(width, maximum=bound.width) or not valid_integer(height, maximum=bound.height)
            or cast(int, width) * cast(int, height) > bound.pixels or not valid_integer(size, maximum=bound.bytes)):
        raise WorkerFault("Invalid worker image bounds", "PROTOCOL_UNSUPPORTED")
    if kind == "prepare":
        roi = request["roi"]
        if (request["format"] not in ("image/jpeg", "image/png") or not isinstance(roi, list) or len(roi) != 4
                or not all(valid_integer(value, minimum=0) for value in roi)):
            raise WorkerFault("Invalid worker reference", "PROTOCOL_UNSUPPORTED")
        x, y, w, h = roi
        if not (w > 0 and h > 0 and x + w <= cast(int, width) and y + h <= cast(int, height)):
            raise WorkerFault("Worker reference ROI outside source pixels", "PROTOCOL_UNSUPPORTED")
    elif (not valid_integer(request["sequence"]) or not valid_integer(request["generation"])
          or not valid_integer(request["source_us"], minimum=0)):
        raise WorkerFault("Invalid worker frame counters", "PROTOCOL_UNSUPPORTED")


def result_box(raw: object) -> Box | None:
    if raw is None:
        return None
    if (isinstance(raw, list) and len(raw) == 4 and all(
            type(value) in (int, float) and abs(value) <= PIXEL_LIMIT and math.isfinite(value) for value in raw)):
        left, top, right, bottom = raw
        if left < right and top < bottom:
            return float(left), float(top), float(right), float(bottom)
    raise WorkerFault("Invalid worker box", "PROTOCOL_UNSUPPORTED")


def run_worker(
    pipe: LocalPipe, boot: str, worker: str, assets: Path | None, settings: Path, limits: FrameLimits,
) -> None:
    # Import here so only the spawned owner initializes the native runtime.
    from .vision_model import LocalModel

    parent = multiprocessing.parent_process()
    if parent is not None:
        def exit_with_owner() -> None:
            wait([parent.sentinel])
            os._exit(0)

        Thread(target=exit_with_owner, daemon=True, name="backend-owner-watch").start()

    tags: dict[str, object] = {"boot": boot, "worker": worker}
    with pipe:
        try:
            model = LocalModel(assets, settings)
            send(pipe, {"kind": "ready", **tags})
        except Exception as exc:
            cause = exc.cause if isinstance(exc, WorkerFault) else "NOT_READY"
            print(f"Local YOLOE startup failed: {exc}", flush=True)
            send(pipe, {"kind": "startup_failed", "cause": cause, **tags})
            return
        last_request = 0
        last_frame: tuple[str, str, int, int] | None = None
        try:
            while True:
                header = receive(pipe)
                kind = header.get("kind")
                if kind not in ("probe", "prepare", "frame", "clear") or any(
                    header.get(key) != value for key, value in tags.items()
                ):
                    raise WorkerFault("Invalid worker command", "PROTOCOL_UNSUPPORTED")
                request_fields(header, cast(RequestKind, kind), limits)
                counter = cast(int, header["request"])
                if counter != last_request + 1:
                    raise WorkerFault("Out-of-order worker command", "PROTOCOL_UNSUPPORTED")
                last_request = counter
                box = None
                if kind == "probe":
                    model.probe()
                elif kind == "clear":
                    model.clear()
                else:
                    size = cast(int, header["size"])
                    source = pipe.recv_bytes(size)
                    if len(source) != size:
                        raise WorkerFault("Worker image length mismatch", "PROTOCOL_UNSUPPORTED")
                    if kind == "prepare":
                        model.prepare(header, source)
                    else:
                        stream, clock = cast(str, header["stream"]), cast(str, header["clock"])
                        sequence, source_us = cast(int, header["sequence"]), cast(int, header["source_us"])
                        if (last_frame and last_frame[0] == stream and
                                (last_frame[1] != clock or last_frame[2] >= sequence or last_frame[3] >= source_us)):
                            raise WorkerFault("Replayed worker frame", "PROTOCOL_UNSUPPORTED")
                        box = model.infer(header, source)
                        last_frame = stream, clock, sequence, source_us
                send(pipe, {**header, "box": box})
        except (EOFError, BrokenPipeError):
            return
        except Exception as exc:
            print(f"Local YOLOE work failed: {exc}", flush=True)


class VisionProcess:
    """One native process and one exchange. Call the pipe methods off the event loop."""

    def __init__(self, boot: str, assets: Path | None, settings: Path, limits: FrameLimits,
                 *, target: WorkerTarget = run_worker):
        self.boot = boot
        self.instance = uuid4().hex
        self.limits = limits
        self._request = 0
        context = multiprocessing.get_context("spawn")
        self._pipe, self._child_pipe = context.Pipe()
        self.process = context.Process(
            name="local-yoloe", target=target, daemon=True,
            args=(self._child_pipe, boot, self.instance, assets, settings, limits),
        )

    def __enter__(self) -> "VisionProcess":
        self.start()
        return self

    def start(self) -> None:
        try:
            self.process.start()
        except BaseException:
            self._pipe.close()
            raise
        finally:
            self._child_pipe.close()

    def __exit__(self, kind: type[BaseException] | None, error: BaseException | None,
                 trace: TracebackType | None) -> None:
        if not self.close() and error is None:
            raise WorkerFault("Local YOLOE worker has not exited")

    def close(self) -> bool:
        try:
            if self.process.is_alive():
                self.process.terminate()
        except OSError:
            # The process may exit between the liveness check and termination.
            pass
        finally:
            self._pipe.close()
        self.process.join(0.5)
        if self.process.is_alive():
            return False
        self.process.close()
        return True

    def initialize(self) -> None:
        tags = {"boot": self.boot, "worker": self.instance}
        result = receive(self._pipe)
        if result == {"kind": "ready", **tags}:
            return
        cause = result.get("cause")
        if isinstance(cause, str) and cause in ("NOT_READY", "PROTOCOL_UNSUPPORTED", "MEDIA_UNAVAILABLE"):
            if result == {"kind": "startup_failed", "cause": cause, **tags}:
                raise WorkerFault("Local YOLOE startup failed", cause)
        raise WorkerFault("Invalid worker startup identity", "PROTOCOL_UNSUPPORTED")

    def exchange(self, kind: RequestKind, fields: dict[str, object] | None = None,
                 image: bytes | None = None) -> Box | None:
        self._request += 1
        header = {"kind": kind, "boot": self.boot, "worker": self.instance, "request": self._request,
                  **(fields or {})}
        request_fields(header, kind, self.limits)
        if (len(image) if image is not None else None) != header.get("size"):
            raise WorkerFault("Backend image length mismatch")
        send(self._pipe, header)
        if image is not None:
            self._pipe.send_bytes(image)
        reply = receive(self._pipe)
        if "box" not in reply:
            raise WorkerFault("Missing worker result", "PROTOCOL_UNSUPPORTED")
        raw = reply.pop("box")
        # Canonical byte comparison also rejects type coercions (True/1, 1.0/1).
        if canonical_json(reply) != canonical_json(header) or (kind != "frame" and raw is not None):
            raise WorkerFault("Wrong worker result identity", "PROTOCOL_UNSUPPORTED")
        box = result_box(raw)
        if box is not None:
            left, top, right, bottom = box
            if not (0 <= left < right <= cast(int, header["width"])
                    and 0 <= top < bottom <= cast(int, header["height"])):
                raise WorkerFault("Worker box exceeds the original frame", "PROTOCOL_UNSUPPORTED")
        return box


async def bounded_call(operation: Callable[[], Box | None], timeout: float) -> Box | None:
    # Cancelling the await frees the coordinator immediately. Closing the isolated process
    # closes its end of the pipe, which releases the executor call without waiting for CUDA.
    async with asyncio.timeout(timeout):
        return await asyncio.to_thread(operation)


def reap_after_shutdown(worker: VisionProcess) -> None:
    def reap() -> None:
        while not worker.close():
            sleep(RESTART_INTERVAL)

    Thread(target=reap, daemon=True, name="local-yoloe-reap").start()


async def close_process(worker: VisionProcess) -> bool:
    closing = asyncio.create_task(asyncio.to_thread(worker.close))
    try:
        return await asyncio.shield(closing)
    except asyncio.CancelledError:
        if not await closing:
            reap_after_shutdown(worker)
        raise


async def launch_process(
    factory: Callable[[], VisionProcess], timeout: float, overdue: Callable[[], None],
) -> VisionProcess:
    pending: Future[VisionProcess] = Future()
    pending.set_running_or_notify_cancel()

    def start() -> None:
        try:
            worker = factory()
            worker.start()
        except BaseException as exc:
            pending.set_exception(exc)
        else:
            pending.set_result(worker)

    def close_abandoned(launch: Future[VisionProcess]) -> None:
        if launch.exception() is None:
            reap_after_shutdown(launch.result())

    # OS launch can block in CreateProcess or the spawn pipe. A daemon thread keeps
    # the control loop and executor shutdown independent of that call.
    Thread(target=start, daemon=True, name="local-yoloe-launch").start()
    available = asyncio.wrap_future(pending)
    try:
        done, _ = await asyncio.wait((available,), timeout=timeout)
        if not done:
            overdue()
        # Keep ownership of a late launch until it exits, so no second worker can start.
        return await asyncio.shield(available)
    except asyncio.CancelledError:
        if not available.cancel() and not available.cancelled():
            available.exception()
        pending.add_done_callback(close_abandoned)
        raise
