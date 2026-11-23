"""Explicit synthetic Uno peer for protected advisory journeys."""

import json
import sys
from binascii import crc_hqx
from contextlib import asynccontextmanager, nullcontext
from dataclasses import replace
from pathlib import Path
from struct import pack
from time import perf_counter

from backend.app import __main__ as entry
from backend.app.config import Config
from backend.app.main import create_app
from backend.app.motion import InputSample, controller_intent
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
    def __init__(self, scenario):
        self.scenario = scenario
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
    state = {}

    def scenario():
        nonlocal state
        try:
            last = source.read_bytes().rsplit(b"\n", 2)[-2]
            state = json.loads(last)
        except (OSError, ValueError, IndexError):
            pass
        return state

    fixture = load_simulation("fixture-v1")
    assert fixture
    profile = replace(fixture.profile, values={
        **fixture.profile.values, "proximity_warning_mm": 200, "proximity_clear_mm": 300,
        "proximity_max_distance_mm": 750, "proximity_sample_deadline_ms": 900,
    })
    peer = ReplayUno(scenario)
    link = SerialCommandLink(profile, BUILD, peer.open, perf_counter, proximity_minimum=15)

    class InputReplay:
        def observe(self, now, scope=None):
            observation = fixture.adapter.observe(now, scope)
            direction = ("forward",) if scenario().get("holding") else ()
            return replace(observation, controller_input=InputSample(scope, now, controller_intent(direction))
                           if scope else None)

    app = create_app(config, held_owner=held_owner, storage=RecordsStorage(config.data_root, monotonic=perf_counter),
                     simulation=replace(fixture, profile=profile, adapter=InputReplay(), command_sink=link))
    lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def run(app):
        link.start()
        try:
            async with lifespan(app):
                yield
        finally:
            link.close()

    app.router.lifespan_context = run
    return app


if __name__ == "__main__":
    entry.create_app = replay_app
    raise SystemExit(entry.main())
