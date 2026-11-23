"""Synthetic Uno peer and input observations for protected browser journeys."""

import json
import sys
from binascii import crc_hqx
from contextlib import asynccontextmanager, nullcontext
from dataclasses import replace
from pathlib import Path
from queue import Empty, SimpleQueue
from struct import pack
from threading import Event, Thread
from time import perf_counter, sleep

from backend.app import __main__ as entry
from backend.app.config import Config
from backend.app.main import create_app
from backend.app.motion import InputSample, controller_intent, gesture_intent
from backend.app.serial_link import SerialCommandLink
from backend.app.simulation import load_simulation
from backend.app.storage import RecordsStorage
from backend.app.uno_wire import (
    ARM,
    ARMED,
    DISCARD_PARTIAL,
    DRIVE,
    HELLO,
    REPLY,
    STATUS,
    STOP,
    Packet,
    decode,
    encode,
)

BUILD = b"synthetic-uno-advisory-peer-v1".ljust(32, b"\0")


def advisory_frame(*, version=1, boot=7, credit=12, sequence=3, age_ms=8, distance=200, valid=1):
    body = pack("<BIIIHHB", version, boot, credit, sequence, age_ms, distance, valid)
    raw = body + crc_hqx(body, 0xFFFF).to_bytes(2, "little")
    return b"\x01" + b"".join(bytes((len(block) + 1,)) + block for block in raw.split(b"\0")) + b"\0"


class ReplayUno:
    def __init__(self, scenario, mark=None):
        self.scenario = scenario
        self.mark = mark
        self.boot = 7
        self.challenge = 0
        self.sequence = 0
        self.generation = 0
        self.delivered = 0
        self.pending = bytearray()

    def open(self):
        self.pending.clear()
        return nullcontext(self)

    def read(self, size):
        # Split both command and observation frames before they reach the adapter.
        size = min(size, 13)
        chunk = bytes(self.pending[:size])
        del self.pending[:size]
        return chunk

    def write(self, data):
        request = decode(data.removeprefix(DISCARD_PARTIAL))
        hello = request.op == HELLO
        if request.op == ARM:
            self.generation = request.generation
        self.challenge += 1
        reply = Packet(
            request.op | REPLY, self.boot, self.generation, request.sequence,
            self.sequence if hello else request.challenge, self.challenge, request.direction,
            ARMED if request.op in (ARM, DRIVE) else 0, BUILD if hello else b"",
        )
        if not hello:
            self.sequence = request.sequence
        self.pending.extend(encode(reply))
        if self.mark and request.op in (DRIVE, STOP):
            self.mark("drive" if request.op == DRIVE else "stop",
                      direction=request.direction, generation=self.generation, sequence=request.sequence)
        current = self.scenario()
        if request.op in (STATUS, DRIVE) and current.get("delivery", 0) > self.delivered:
            self.delivered = current["delivery"]
            params = {"credit": self.challenge, "boot": self.boot, **current["sample"]}
            observation = advisory_frame(**params)
            if current.get("unterminated"):
                observation = observation[:-1]
            if current.get("bad_route"):
                observation = b"\x0a" + observation[1:]
            self.pending.extend(observation)
        return len(data)


def replay_app(config: Config, *, held_owner: bool = False):
    source = Path(sys.argv[1])
    state: dict = {}
    trace = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    observations: SimpleQueue[dict] = SimpleQueue()
    finished = Event()

    def mark(kind, **fields):
        if trace is not None:
            observations.put({"kind": kind, "at": perf_counter(), **fields})

    def scenario():
        return state

    def read_replay():
        nonlocal state
        try:
            last = source.read_bytes().rsplit(b"\n", 2)[-2]
            state = json.loads(last)
        except (OSError, ValueError, IndexError):
            # Keep the last complete observation during overlapping Windows writes.
            pass

    def drive_replay():
        while not finished.is_set():
            read_replay()
            finished.wait(0.012)

    def write_trace(path):
        with path.open("a", encoding="utf-8", buffering=1) as report:
            while not finished.is_set() or not observations.empty():
                try:
                    item = observations.get(timeout=0.05)
                except Empty:
                    continue
                report.write(json.dumps(item) + "\n")

    def checkpoint(boundary):
        if boundary != "before_safety_pause_commit" or not scenario().get("input", {}).get("holdPause"):
            return
        mark("pause_writer_blocked")
        deadline = perf_counter() + 12
        while scenario().get("input", {}).get("holdPause"):
            if perf_counter() >= deadline:
                raise OSError("Search control replay did not release the pause writer.")
            sleep(0.015)
        mark("pause_writer_released")

    fixture = load_simulation("fixture-v1")
    assert fixture
    profile = replace(fixture.profile, values={
        **fixture.profile.values, "proximity_warning_mm": 200, "proximity_clear_mm": 300,
        "proximity_max_distance_mm": 750, "proximity_sample_deadline_ms": 900,
    })
    peer = ReplayUno(scenario, mark if trace is not None else None)
    link = SerialCommandLink(profile, BUILD, peer.open, perf_counter, proximity_minimum=15)

    class InputReplay:
        previous = None

        def observe(self, now, scope=None):
            observation = fixture.adapter.observe(now, scope)
            current = scenario()
            inputs = current.get("input")
            if inputs is None:
                direction = ("forward",) if current.get("holding") else ()
                return replace(observation, controller_input=InputSample(scope, now, controller_intent(direction))
                               if scope else None)
            if self.previous != inputs:
                mark("input", **inputs)
                self.previous = inputs
            pad_at = now if inputs["padAvailable"] else None
            gesture_at = now if inputs["gestureAvailable"] else None
            gesture = gesture_intent(inputs["fingers"], hands=inputs["hands"],
                                     certain=inputs["certain"], stable=inputs["stable"])
            pad = controller_intent(tuple(inputs["pad"]), circle=inputs["circle"])
            return replace(
                observation, webcam=observation.webcam if gesture_at is not None else None,
                controller_sample_at=pad_at, gesture_sample_at=gesture_at,
                controller_input=InputSample(scope, pad_at, pad) if scope and pad_at is not None else None,
                gesture_input=InputSample(scope, gesture_at, gesture) if scope and gesture_at is not None else None,
            )

    storage = RecordsStorage(config.data_root, monotonic=perf_counter, checkpoint=checkpoint)
    app = create_app(config, held_owner=held_owner, storage=storage,
                     simulation=replace(fixture, profile=profile, adapter=InputReplay(), command_sink=link),
                     on_control_revoked=lambda revocation: mark("lease_revoked", reason=revocation.reason))
    lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def run(app):
        read_replay()
        driver = Thread(target=drive_replay, name="search-replay-input", daemon=True)
        reporter = Thread(target=write_trace, args=(trace,), name="search-replay-trace", daemon=True) if trace else None
        driver.start()
        if reporter:
            reporter.start()
        link.start()
        try:
            async with lifespan(app):
                yield
        finally:
            link.close()
            finished.set()
            driver.join(timeout=1)
            if reporter:
                reporter.join(timeout=1)

    app.router.lifespan_context = run
    return app


if __name__ == "__main__":
    entry.create_app = replay_app
    raise SystemExit(entry.main())
