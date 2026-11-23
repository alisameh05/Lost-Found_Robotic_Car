"""Exercise the same Uno parser/watchdog source over the backend command wire."""

import asyncio
import json
import os
import select
import shutil
import socket
import subprocess
from collections import deque
from contextlib import contextmanager, nullcontext
from dataclasses import replace
from functools import partial
from hashlib import sha256
from io import BytesIO
from multiprocessing import get_context
from pathlib import Path
from threading import Event, Lock, Thread
from time import monotonic, perf_counter, sleep
from uuid import uuid4

import httpx
import pytest
import uvicorn
from fastapi.testclient import TestClient
from PIL import Image

from backend.app import realtime
from backend.app.camera_link import CLOCK, Reply
from backend.app.config import Config
from backend.app.controller import Controller
from backend.app.device_startup import load_device_startup
from backend.app.main import create_app
from backend.app.motion import DIRECTIONS
from backend.app.proximity_wire import AdvisoryPacket, decode_advisory
from backend.app.serial_link import SerialCommandLink
from backend.app.simulation import load_simulation
from backend.app.storage import utc_ms
from backend.app.uno_wire import (
    ARM,
    ARMED,
    DISCARD_PARTIAL,
    DRIVE,
    HELLO,
    MAX_FRAME,
    REPLY,
    STATUS,
    STOP,
    Packet,
    decode,
    encode,
)
from backend.app.webcam import Webcam
from backend.tests.device_documents import device_documents, write_camera_documents, write_device_documents
from backend.tests.proximity_replay import BUILD as ADVISORY_BUILD
from backend.tests.proximity_replay import ReplayUno
from backend.tests.test_camera_link import BUILD as CAMERA_BUILD
from backend.tests.test_camera_link import TOKEN as CAMERA_TOKEN
from backend.tests.test_camera_link import clock_headers, frame_headers, jpeg_sample
from backend.tests.test_candidate_review import review
from backend.tests.test_controller import SERIAL, device, fresh_reports
from backend.tests.test_device_startup import component
from backend.tests.test_local_matching import await_file
from backend.tests.test_realtime import (
    API,
    Clock,
    Loopback,
    Observations,
    auth,
    driving_search,
    event,
    recover_workspace,
    search_action,
    service,
    wait_for,
)
from backend.tests.test_records import BASE, ORIGIN
from backend.tests.test_webcam import WebcamReplay
from backend.tests.vision_stub import controlled_worker, publish

BUILD = b"\x90" + bytes(31)


@pytest.fixture(scope="session")
def uno_peer_exe(tmp_path_factory: pytest.TempPathFactory) -> Path:
    compiler = os.environ.get("LAF_UNO_HOST_CXX") or shutil.which("c++") or shutil.which("g++")
    if not compiler:
        pytest.skip("C++ compiler required for the Uno parser/watchdog fixture")
    root = Path(__file__).resolve().parents[2]
    target = tmp_path_factory.mktemp("uno-peer") / "uno_peer.exe"
    subprocess.run(
        [compiler, "-std=c++11", "-O2", "-Wall", "-Wextra", "-Werror", "-static", "-Ifirmware/uno",
         "firmware/tests/command_peer.cpp", "firmware/uno/command.cpp", "-o", str(target)],
        cwd=root, check=True, timeout=30,
    )
    return target


class NativePeer:
    def __init__(self, process, clock=monotonic):
        self.process = process
        self.clock = clock
        self.zero = clock()
        self.lock = Lock()
        self.rx = bytearray()
        self.trace: deque[tuple[float, Packet]] = deque(maxlen=512)
        self.outputs: deque[tuple[float, int]] = deque([(self.zero, 0)], maxlen=512)
        self.fault = None
        self.connected = True

    def step(self, frame=b"", *, now=None):
        arrival = self.clock()
        timestamp = round((arrival - self.zero) * 1000) if now is None else now
        stimulus = frame.hex() if isinstance(frame, bytes) else frame
        stdin, stdout = self.process.stdin, self.process.stdout
        stdin.write(f"{timestamp} {stimulus}\n")
        stdin.flush()
        out, hex_reply = stdout.readline().rstrip("\r\n").split(" ", 1)
        direction = int(out)
        if self.outputs[-1][1] != direction:
            self.outputs.append((arrival, direction))
        return direction, bytes.fromhex(hex_reply)

    @property
    def output(self):
        with self.lock:
            return self.step()[0]

    def write(self, data):
        with self.lock:
            if not self.connected:
                raise OSError("fixture link unplugged")
            packet = decode(data.removeprefix(DISCARD_PARTIAL))
            self.trace.append((self.clock(), packet))
            _, reply = self.step(data)
            if packet.op == DRIVE and self.fault:
                if self.fault == "invalid":
                    reply = encode(replace(decode(reply), challenge=0))
                elif self.fault == "replayed":
                    reply = encode(replace(decode(reply), sequence=packet.sequence - 1))
                elif self.fault == "reset":
                    self.step("reset")
                    reply = encode(replace(decode(reply), boot=packet.boot + 1))
                elif self.fault == "late":
                    # The read side will release this correlated reply beyond the profile deadline.
                    self.delayed = (self.clock() + 0.12, reply)
                    reply = b""
                else:
                    reply = b""
                self.fault = None
            elif (packet.op, self.fault) in ((STATUS, "idle_missing"), (STOP, "stop_missing")):
                reply = b""
                self.fault = None
            self.rx.extend(reply)
            return len(data)

    delayed = None

    def read(self, size):
        with self.lock:
            if not self.connected:
                raise OSError("fixture link unplugged")
            if self.delayed and self.clock() >= self.delayed[0]:
                self.rx.extend(self.delayed[1])
                self.delayed = None
            chunk = bytes(self.rx[:size])
            del self.rx[:size]
            return chunk

    @contextmanager
    def open(self):
        with self.lock:
            self.rx.clear()
            self.delayed = None
        yield self


@contextmanager
def native_peer(exe: Path, packet=25, challenge=180, expiry=220):
    process = subprocess.Popen(
        [str(exe), str(packet), str(challenge), str(expiry)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
    )
    try:
        yield NativePeer(process)
    finally:
        process.stdin.close()
        process.wait(3)
        process.stdout.close()


def exchange(peer, packet, timestamp):
    state, wire = peer.step(encode(packet), now=timestamp)
    return state, decode(wire)


def armed(peer, start=0):
    state, hello = exchange(peer, Packet(HELLO, sequence=314), start)
    assert state == 0 and hello == Packet(HELLO | REPLY, boot=1, sequence=314, next_challenge=1, build=BUILD)
    state, arm = exchange(peer, Packet(ARM, 1, 1, 1, 1), start + 1)
    assert state == 0 and arm == Packet(ARM | REPLY, 1, 1, 1, 1, 2, flags=1)
    command = Packet(DRIVE, 1, 1, 2, 2, direction=1)
    state, drive = exchange(peer, command, start + 2)
    assert state == 1 and drive == Packet(DRIVE | REPLY, 1, 1, 2, 2, 3, 1, 1)
    return command


@pytest.mark.parametrize("bad", ["partial", "corrupt", "oversized", "framing", "boot", "generation", "sequence",
                                 "challenge", "range", "expired", "replay", "reset"])
def test_uno_rejects_invalid_or_expired_wire_and_requires_new_arm(uno_peer_exe: Path, bad: str) -> None:
    with native_peer(uno_peer_exe) as peer:
        replay = armed(peer)
        valid = Packet(DRIVE, 1, 1, 3, 3, direction=2)
        packet = encode(valid)
        if bad == "partial":
            assert peer.step(packet[:8], now=10) == (1, b"")
            bad_wire, timestamp = packet[8:], 35
        elif bad == "expired":
            bad_wire, timestamp = packet, 182
        elif bad == "reset":
            assert peer.step("reset", now=3) == (0, b"")
            bad_wire, timestamp = packet, 4
        else:
            bad_wire, timestamp = {
                "corrupt": packet[:-3] + bytes([packet[-3] ^ 1 or 2]) + packet[-2:],
                "oversized": bytes([3]) * 80 + b"\0", "framing": b"\xff\x09\0",
                "boot": encode(replace(valid, boot=2)), "generation": encode(replace(valid, generation=2)),
                "sequence": encode(replace(valid, sequence=2)), "challenge": encode(replace(valid, challenge=2)),
                "range": encode(replace(valid, direction=5)), "replay": encode(replay),
            }[bad], 20
        assert peer.step(bad_wire, now=timestamp) == (0, b"")
        assert peer.step(packet, now=timestamp + 1) == (0, b"")
        _, hello = exchange(peer, Packet(HELLO, sequence=12), timestamp + 2)
        if bad != "reset":
            old_arm = Packet(ARM, hello.boot, hello.generation, hello.challenge + 1, hello.next_challenge)
            assert peer.step(encode(old_arm), now=timestamp + 3) == (0, b"")


def test_uno_expiry_during_incomplete_and_continuous_input(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        armed(peer)
        assert peer.step(b"\x02", now=220) == (1, b"")
        assert peer.step(b"\x01", now=221) == (1, b"")
        assert peer.step(b"\x01", now=222) == (0, b"")
        assert peer.step(b"\x01" * 4096, now=223) == (0, b"")
        assert peer.step(encode(Packet(DRIVE, 1, 1, 3, 3, direction=1)), now=224) == (0, b"")


def test_uno_expiry_survives_monotonic_clock_wrap(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        armed(peer, start=2**32 - 4)
        assert peer.step(now=217) == (1, b"")
        assert peer.step(now=218) == (0, b"")


def test_uno_advisory_is_independent_of_the_drive_ack_and_watchdog(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        armed(peer)
        assert peer.step("sample 2 17 150", now=9) == (1, b"")
        output, reply = peer.step(encode(Packet(DRIVE, 1, 1, 3, 3, direction=1)), now=10)
        ack, advisory = reply.split(b"\0", 1)
        verified = decode(ack + b"\0")
        assert output == 1 and verified == Packet(DRIVE | REPLY, 1, 1, 3, 3, 4, 1, ARMED)
        assert decode_advisory(advisory) == AdvisoryPacket(1, 4, 2, 17, 150)
        assert peer.step(now=230) == (0, b"")


def test_proximity_wire_projects_advice_through_protected_workspace(tmp_path: Path) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    profile = replace(fixture.profile, values={**fixture.profile.values, "proximity_sample_deadline_ms": 900})
    scenario = {}
    peer = ReplayUno(lambda: scenario)
    link = SerialCommandLink(profile, ADVISORY_BUILD, peer.open, proximity_minimum=15)
    link.start()
    try:
        with service(tmp_path, live_command=link, qualification=profile) as laf, \
                driving_search(laf) as (headers, driver):
            assert wait_for(laf.http, "/snapshot", headers)["proximity"]["state"] == "Unknown"
            wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
            laf.observations.dpad = ("forward",)
            control = wait_for(laf.http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Armed")
            assert link.output == "forward"
            delivery = 0

            def send(sequence, distance, state, latched, *, unterminated=False, bad_route=False, **override):
                nonlocal delivery, scenario
                delivery += 1
                sample = {"sequence": sequence, "distance": distance, **override}
                scenario = {"delivery": delivery, "sample": sample, "unterminated": unterminated, "bad_route": bad_route}
                current = wait_for(laf.http, "/snapshot", headers, lambda s:
                                   s["proximity"]["state"] == state and (s["proximity"]["sample_seq"] == sequence
                                   if state != "Unknown" or delivery == 1 else s["proximity"]["distance_mm"] is None))
                assert current["proximity"]["warning_latched"] is latched
                assert current["runtime"] == control["runtime"]
                assert current["readiness"] == control["readiness"]
                assert current["active_session"] == control["active_session"]
                assert link.output == "forward"
                return current["proximity"]

            send(1, 230, "Unknown", False)  # Initial clear proof is incomplete.
            send(2, 150, "Warning", True)   # Equality latches Warning.
            send(3, 229, "Warning", True)   # Hysteresis.
            send(4, 230, "Warning", True)
            send(5, 0, "Unknown", True, valid=0)
            send(6, 230, "Warning", True)
            send(7, 230, "Unknown", True, age_ms=1500)
            send(8, 230, "Warning", True)
            send(8, 230, "Unknown", True)   # Replay during a clear run.
            send(9, 230, "Warning", True)
            send(10, 230, "Unknown", True, boot=6)
            send(11, 230, "Warning", True)
            send(12, 230, "Unknown", True, unterminated=True)
            send(13, 230, "Warning", True)
            send(14, 230, "Unknown", True, bad_route=True)
            send(15, 230, "Warning", True)
            send(16, 230, "Warning", True)
            cleared = send(17, 230, "Clear", False)
            spectator = auth(laf.bootstrap())
            with laf.open("/events", laf.ticket(spectator, "events")) as events:
                initial = event(events)
                assert initial["type"] == "snapshot"
                assert initial["payload"]["proximity"] == cleared
                assert initial["session_revision"] == driver.session["revision"]
            assert wait_for(laf.http, "/snapshot", headers, lambda s: s["proximity"]["state"] == "Unknown")[
                "runtime"
            ] == control["runtime"]
    finally:
        link.close()


def test_stop_preempts_partial_wire_and_invalidates_an_armed_generation(uno_peer_exe: Path) -> None:
    with native_peer(uno_peer_exe) as peer:
        _, hello = exchange(peer, Packet(HELLO, sequence=9), 0)
        _, arm = exchange(peer, Packet(ARM, hello.boot, 1, 1, hello.next_challenge), 1)
        queued = encode(Packet(DRIVE, 1, 1, 2, arm.next_challenge, direction=2))
        assert peer.step(queued[:-1], now=2) == (0, b"")
        assert peer.step(DISCARD_PARTIAL, now=3) == (0, b"")
        stop = encode(Packet(STOP, 1, 1, 3, arm.next_challenge))
        output, reply = peer.step(stop, now=4)
        assert output == 0 and decode(reply) == Packet(STOP | REPLY, 1, 1, 3, 2, 3)
        assert peer.step(queued, now=5) == (0, b"")


def wait_until(predicate, timeout=3):
    end = monotonic() + timeout
    while monotonic() < end:
        if predicate():
            return
        sleep(0.005)
    assert predicate()


@pytest.mark.parametrize("mode", ["Controller", "Gestures"])
def test_protected_workspace_drives_and_stops_over_the_uno_wire(
    tmp_path: Path, uno_peer_exe: Path, mode: str,
) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            with service(tmp_path, live_command=link) as laf:
                if mode == "Controller":
                    laf.observations.fingers = 4
                else:
                    laf.observations.dpad = ("right",)
                    laf.observations.circle = True
                with driving_search(laf, mode) as (headers, _):
                    for direction, name in enumerate(DIRECTIONS, 1):
                        wait_for(laf.http, "/snapshot", headers,
                                 lambda s: s["runtime"]["motion_permission"] == "Arming")
                        if mode == "Controller":
                            laf.observations.dpad = (name,)
                        else:
                            laf.observations.fingers = direction
                        wait_until(lambda: peer.output == direction)
                        if mode == "Controller":
                            laf.observations.dpad = ()
                        else:
                            laf.observations.fingers = 0
                        wait_until(lambda: peer.output == 0)
                        active = wait_for(laf.http, "/snapshot", headers)["active_session"]
                        assert active["state"] == "Searching" and active["pause_causes"] == []
                    wait_for(laf.http, "/snapshot", headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    if mode == "Controller":
                        laf.observations.dpad = ("forward",)
                    else:
                        laf.observations.fingers = 1
                    wait_until(lambda: peer.output == 1)
                    if mode == "Controller":
                        laf.observations.dpad = ("forward", "right")
                    else:
                        laf.observations.fingers, laf.observations.stable = 4, False
                    wait_until(lambda: peer.output == 0)
                    if mode == "Controller":
                        laf.observations.dpad = ("right",)
                    else:
                        laf.observations.stable = True
                    sleep(0.23)
                    assert peer.output == 0
                    if mode == "Controller":
                        laf.observations.dpad = ()
                    else:
                        laf.observations.fingers = 0
                    wait_for(laf.http, "/snapshot", headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    if mode == "Controller":
                        laf.observations.dpad = ("forward",)
                    else:
                        laf.observations.fingers = 1
                    wait_until(lambda: peer.output == 1)
                    stopped = laf.http.post(API + "/emergency-stop", headers=headers,
                                            json={"request_id": str(uuid4())})
                    assert stopped.is_success and stopped.json()["permission_revoked"]
                    wait_until(lambda: peer.output == 0)
                    wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
        finally:
            link.close()


@pytest.mark.parametrize("fault", ["missing", "late", "invalid", "replayed", "reset", "link"])
def test_serial_failure_drops_authority_and_reconnects_disarmed(uno_peer_exe: Path, fault: str) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            wait_until(link.probe)
            wait_until(lambda: link.pulse(1, "forward", monotonic() + 0.24) is None and link.output == "forward")
            if fault == "link":
                peer.connected = False
            else:
                peer.fault = fault
            until = monotonic() + 2
            while link.probe() and monotonic() < until:
                link.pulse(1, "forward", monotonic() + 0.24)
                sleep(0.005)
            assert not link.probe() and link.output is None
            wait_until(lambda: peer.output == 0)
            peer.connected = True
            # Successful diagnostic traffic cannot restore the previous generation.
            wait_until(lambda: sum(packet.op == HELLO for _, packet in peer.trace) >= 2)
            assert not link.probe()
            link.revoke(1, "InputReleased")
            assert not link.probe(), "healthy release cannot clear a serial fault"
            link.revoke(1, "CommandUnavailable")
            wait_until(link.probe)
            assert peer.output == 0
        finally:
            link.close()


@pytest.mark.parametrize("condition", [
    "matched", "matched_ble", "mixed_endpoint", "wrong_build", "changed_artifact", "fixture_artifact",
    "same_pin", "usb_identity",
])
def test_selected_command_is_independent_of_device_camera(
    tmp_path: Path, uno_peer_exe: Path, condition: str,
) -> None:
    profile, interfaces, evidence, recorded_result = device_documents()
    initialize_command_selection(profile, interfaces, evidence, condition)
    selected = interfaces["hc05_uno"]
    build = selected_command_build(profile, selected, condition)
    digest = selected["build_artifact_sha256"] = sha256(build).hexdigest()
    folder = write_device_documents(tmp_path, profile, interfaces, evidence, recorded_result)
    (folder / "artifacts" / digest).write_bytes(build if condition != "changed_artifact" else b"changed")
    with native_peer(uno_peer_exe, challenge=80, expiry=140) as peer:
        app = create_app(Config(tmp_path, backend_mode="device"), command_transport=lambda: nullcontext(peer))
        expected = [] if condition in ("matched", "matched_ble") else [
            "PROTOCOL_UNSUPPORTED" if condition in ("wrong_build", "usb_identity") else "NOT_READY",
        ]
        with TestClient(app, base_url=BASE) as client:
            headers = auth(client.get(API + "/bootstrap", headers=ORIGIN).json())
            view = wait_for(client, "/health", headers, lambda s: component(s, "Command")["cause_codes"] == expected)
            assert component(view, "RobotVideo")["status"] == "Unavailable"
            assert view["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            status = client.get(API + "/snapshot", headers=headers).json()
            assert status["runtime"]["motion_permission"] == "Disarmed"
            assert peer.output == 0
            if condition in ("changed_artifact", "fixture_artifact", "mixed_endpoint", "same_pin", "usb_identity"):
                assert not peer.trace
            elif condition in ("matched", "matched_ble"):
                assert any(packet.op == HELLO for _, packet in peer.trace)


def initialize_command_selection(profile: dict, interfaces: dict, evidence: dict, condition: str) -> None:
    profile["serial_max_packet_bytes"] = evidence["measurements"]["serial_max_packet_bytes"]["value"] = MAX_FRAME
    selected = interfaces["hc05_uno"]
    profile["serial_baud"] = evidence["measurements"]["serial_baud"]["value"] = selected["serial_baud"] = 38400
    selected["uno"]["target"] = "arduino:avr:uno"
    if condition == "usb_identity":
        selected["identity"] = "USB VID:PID=1A86:7523"
    if condition in ("matched_ble", "mixed_endpoint"):
        selected.update(transport="ble_gatt", identity=r"BTHLE\DEV_020102030405\7&synthetic", ble_address_type="public")
        if condition == "matched_ble":
            del selected["windows_port"]


def selected_command_build(profile: dict, selected: dict, condition: str) -> bytes:
    return json.dumps({
        **selected["uno"], "version": 1, "kind": "DisabledFixture" if condition == "fixture_artifact" else "Device",
        "build_id": (bytes(32) if condition == "wrong_build" else BUILD).hex(),
        "logical_output_sha256": selected["logical_output_sha256"], "serial_baud": profile["serial_baud"],
        "serial_rx_pin": 2, "serial_tx_pin": 2 if condition == "same_pin" else 3,
        "packet_ms": 25, "challenge_lifetime_ms": profile["challenge_lifetime_ms"],
        "firmware_expiry_ms": profile["firmware_expiry_ms"],
        "hardware_watchdog_ms": 120, "reset_evidence_sha256": selected["logical_output_sha256"],
    }).encode()


@pytest.mark.parametrize("condition", [
    "selected", "missing", "bounds", "artifact", "version", "endpoint", "build_proximity", "fixture_result",
])
def test_device_proximity_is_calibrated_independently_of_command(tmp_path: Path, condition: str) -> None:
    profile, interfaces, evidence, recorded_result = device_documents()
    initialize_command_selection(profile, interfaces, evidence, "matched_ble")
    selected = interfaces["hc05_uno"]
    build = json.dumps({
        **json.loads(selected_command_build(profile, selected, "matched_ble")),
        "build_id": ADVISORY_BUILD.hex(), "proximity_protocol_version": 1, "proximity_trigger_pin": 12,
        "proximity_echo_pin": 13, "proximity_sample_interval_ms": "unknown" if condition == "build_proximity" else 60,
    }).encode()
    build_digest = selected["build_artifact_sha256"] = sha256(build).hexdigest()
    specification = Path(__file__).resolve().parents[2] / "firmware" / "uno" / "proximity.v1.json"
    contract = specification.read_bytes()
    contract_digest = sha256(contract).hexdigest()
    bounds = {key: profile[key] for key in profile if key.startswith("proximity_")}
    result = json.dumps({
        "version": 1, "kind": "Fixture" if condition == "fixture_result" else "HcSr04DeviceResult",
        "source_identity": "test-proximity", "endpoint_id": selected["identity"], "transport": "ble_gatt",
        "uno_build_artifact_sha256": build_digest, "conditions": "Synthetic loader test. No connected hardware.",
        "readings": [
            {"target_mm": 100, "distance_mm": 100, "upper_age_ms": 85, "state": "Warning"},
            {"target_mm": 250, "distance_mm": 250, "upper_age_ms": 92, "state": "Clear"},
        ],
    }).encode()
    result_digest = sha256(result).hexdigest()
    calibration = json.dumps({
        "version": 1, "kind": "HcSr04Calibration", "profile_id": profile["profile_id"],
        "uno_build_artifact_sha256": build_digest, "procedure_id": "synthetic-proximity-test",
        "bounds": {**bounds, "proximity_min_distance_mm": 15, "proximity_sample_interval_ms": 60},
        "result_sha256": result_digest,
    }).encode()
    calibration_digest = sha256(calibration).hexdigest()
    interfaces["hcsr04"] = {
        "identity": "test-proximity", "source": "uno-r3", "transport": "uno-command",
        "unit": "mm", "protocol_version": 2 if condition == "version" else 1, "contract_sha256": contract_digest,
        "endpoint_id": "wrong-device" if condition == "endpoint" else selected["identity"],
        "uno_build_artifact_sha256": build_digest, "calibration_artifact_sha256": calibration_digest,
        "minimum_distance_mm": 15,
    }
    if condition == "missing":
        for key in bounds:
            del profile[key]
            del evidence["measurements"][key]
    if condition == "bounds":
        profile["proximity_clear_mm"] = 109
    artifacts = write_device_documents(tmp_path, profile, interfaces, evidence, recorded_result) / "artifacts"
    (artifacts / build_digest).write_bytes(build)
    (artifacts / contract_digest).write_bytes(contract)
    (artifacts / result_digest).write_bytes(result)
    if condition != "artifact":
        (artifacts / calibration_digest).write_bytes(calibration)

    scenario = {}
    peer = ReplayUno(lambda: scenario)
    app = create_app(Config(tmp_path, backend_mode="device"), command_transport=peer.open)
    with TestClient(app, base_url=BASE) as client:
        headers = auth(client.get(API + "/bootstrap", headers=ORIGIN).json())
        view = wait_for(client, "/snapshot", headers, lambda s: component(s, "Command")["status"] == "Ready")
        assert view["proximity"]["state"] == "Unknown"
        assert view["runtime"]["motion_permission"] == "Disarmed"
        scenario = {"delivery": 1, "sample": {"sequence": 1, "distance": 110}}
        if condition == "selected":
            warning = wait_for(client, "/snapshot", headers, lambda s: s["proximity"]["state"] == "Warning")
            assert warning["proximity"]["distance_mm"] == 110
        else:
            wait_until(lambda: peer.delivered == 1)
            wait_until(lambda: peer.challenge > 6)
            after = wait_for(client, "/snapshot", headers)
            assert after["proximity"] == view["proximity"]
            assert after["readiness"] == view["readiness"]


@pytest.mark.parametrize("mode", ["Controller", "Gestures"])
def test_device_search_drives_and_reviews_the_displayed_camera_acquisition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, uno_peer_exe: Path, mode: str,
) -> None:
    monkeypatch.setattr(realtime, "VisionProcess", partial(realtime.VisionProcess, target=controlled_worker))

    documents = device_documents()
    profile, interfaces, evidence, result = documents
    initialize_command_selection(profile, interfaces, evidence, "matched_ble")
    # Leave scheduling room for real sockets and the subprocess. These are synthetic test bounds.
    for name, value in {"clock_uncertainty_limit_us": 10_000, "camera_sync_max_rtt_us": 20_000,
                        "heartbeat_deadline_ms": 170, "display_deadline_ms": 180,
                        "capture_age_limit_ms": 200, "input_sample_deadline_ms": 160,
                        "command_ack_deadline_ms": 48, "challenge_lifetime_ms": 105, "firmware_expiry_ms": 150}.items():
        profile[name] = evidence["measurements"][name]["value"] = value
    evidence["stop_budget"] = {"software_ms": 460, "mechanical_margin_ms": 40}
    command = interfaces["hc05_uno"]
    build = selected_command_build(profile, command, "matched_ble")
    digest = command["build_artifact_sha256"] = sha256(build).hexdigest()
    interfaces["controller"] = {"identity": SERIAL, "profile_sha256": sha256(result).hexdigest()}
    interfaces["webcam"] = {"identity": "synthetic-directshow", "profile_sha256": sha256(result).hexdigest()}
    folder = write_camera_documents(tmp_path, CAMERA_BUILD, CAMERA_TOKEN, documents=documents)
    (folder / "artifacts" / digest).write_bytes(build)
    qualification = load_device_startup(tmp_path, {}).profile
    assert qualification is not None
    jpeg = jpeg_sample()
    camera_jpeg = jpeg
    sequence = 0

    async def camera(path, headers, read_body, timeout):
        nonlocal sequence
        if path == CLOCK:
            stamp = int(perf_counter() * 1_000_000)
            fields = clock_headers(headers, rx=stamp, tx=stamp)
            payload = b""
        else:
            await asyncio.sleep(0.045)
            sequence += 1
            payload = camera_jpeg
            fields = frame_headers(len(payload), sequence, int(perf_counter() * 1_000_000))
        size = read_body(200, fields, 256)
        return Reply(payload if size else b"", perf_counter(), utc_ms())

    # Start with both inputs held. Keep the unselected input held throughout the search.
    buttons = (13,) if mode == "Gestures" else (11,)
    replay = WebcamReplay()
    replay.pose(1 if mode == "Gestures" else 15)

    def select_direction(direction: int) -> None:
        nonlocal buttons
        if mode == "Gestures":
            replay.pose((0, 1, 3, 7, 15)[direction])
        else:
            buttons = ((), (11,), (12,), (13,), (14,))[direction]

    with native_peer(uno_peer_exe, challenge=qualification.bound("challenge_lifetime_ms"),
                     expiry=qualification.bound("firmware_expiry_ms")) as peer:
        def app_factory(port):
            controller = Controller(
                SERIAL, qualification.bound("input_sample_deadline_ms") / 1000,
                lambda: nullcontext(lambda: fresh_reports([device(1, *buttons)])), clock=perf_counter,
            )
            webcam = Webcam(qualification, replay.camera, replay.recognizer, replay.encode, perf_counter)
            return create_app(Config(tmp_path, backend_port=port, backend_mode="device", yoloe_assets=tmp_path),
                              controller=controller, webcam=webcam, command_transport=peer.open, camera_exchange=camera)

        def hold_after_neutral(laf, headers, direction):
            select_direction(0)
            wait_for(laf.http, "/snapshot", headers,
                     lambda s: s["runtime"]["motion_permission"] == "Arming")
            select_direction(direction)
            wait_until(lambda: peer.output == direction)

        def assert_held_input_stays_disarmed(laf, headers, driver):
            # Several fresh frame acknowledgments allow either input adapter to settle.
            after = sequence + 5
            snapshot = wait_for(laf.http, "/snapshot", headers,
                                lambda _: driver.latest and driver.latest["capture_seq"] > after)
            assert snapshot["runtime"]["motion_permission"] == "Disarmed"
            assert peer.output == 0

        with service(tmp_path, app_factory=app_factory) as laf:
            with driving_search(laf, mode) as (headers, driver):
                assert_held_input_stays_disarmed(laf, headers, driver)
                assert not any(direction for _, direction in peer.outputs)
                for direction in range(1, 5):
                    hold_after_neutral(laf, headers, direction)
                    select_direction(0)
                    wait_until(lambda: peer.output == 0)
                    active = wait_for(laf.http, "/snapshot", headers)["active_session"]
                    assert active["state"] == "Searching" and active["pause_causes"] == []
                assert [output for _, output in peer.outputs if output] == [1, 2, 3, 4]

                hold_after_neutral(laf, headers, 1)
                driver.freeze = True
                failed = wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Paused")
                paused = failed["active_session"]
                failure = next(entry for entry in failed["failures"] if entry["cause"] == "DisplayStale")
                assert component(failed, "RobotVideo")["status"] == "Ready"
                assert driver.latest is not None
                assert driver.received_frames[-1]["capture_seq"] > driver.latest["capture_seq"]
                assert failed["runtime"]["motion_permission"] == "Disarmed"
                wait_until(lambda: peer.output == 0)

            with recover_workspace(laf, paused) as (headers, driver):
                restored = wait_for(laf.http, "/snapshot", headers, lambda s: any(
                    entry["failure_id"] == failure["failure_id"] and entry["restored"] for entry in s["failures"]
                ))
                assert peer.output == 0
                revision = restored["active_session"]["revision"]
                blocked = search_action(laf, headers, driver, "resume", revision)
                assert blocked.json()["code"] == "RECOVERY_REQUIRED"
                acknowledged = search_action(laf, headers, driver, "acknowledge", revision,
                                              failure_ids=[failure["failure_id"]])
                assert acknowledged.is_success, acknowledged.text
                ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_resume"])
                resumed = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
                assert resumed.is_success, resumed.text
                wait_for(laf.http, "/snapshot", headers, lambda s: s["active_session"]["state"] == "Searching")
                assert_held_input_stays_disarmed(laf, headers, driver)
                assert [output for _, output in peer.outputs if output] == [1, 2, 3, 4, 1]
                hold_after_neutral(laf, headers, 1)

                worker = tmp_path / "vision"
                await_file(worker / "prompt.json")
                publish(worker / "request", "candidate")
                try:
                    await_file(worker / "frame.json")
                    frame = json.loads((worker / "frame.json").read_text(encoding="utf-8"))
                    replacement = BytesIO()
                    Image.new("RGB", (320, 240), "orange").save(replacement, "JPEG")
                    camera_jpeg = replacement.getvalue()
                    replaced_after = sequence
                    wait_for(laf.http, "/snapshot", headers,
                             lambda _: driver.latest and driver.latest["capture_seq"] > replaced_after)
                    assert peer.output == 1
                finally:
                    (worker / "release").touch()
                match, session = review(laf, headers)
                wait_until(lambda: peer.output == 0)
                display = next(item for item in tuple(driver.received_frames) if item["frame_id"] == match["frame_id"])
                assert (match["frame_id"], match["stream_epoch"]) == (frame["frame"], frame["stream"])
                assert (display["capture_seq"], display["source_capture_us"], display["source_clock_epoch"]) == (
                    frame["sequence"], frame["source_us"], frame["clock"],
                )
                assert match["captured_at_ms"] == display["received_at_ms"] - display["capture_age_bound_ms"]
                assert match["box"] == {"x": 2, "y": 3, "width": 5, "height": 7}
                confirmed = search_action(laf, headers, driver, "confirm", session["revision"], candidate_id=match["id"])
                assert confirmed.is_success, confirmed.text

        with service(tmp_path, app_factory=app_factory) as laf:
            headers = auth(laf.bootstrap())
            target = wait_for(laf.http, f"/objects/{session['object_id']}", headers)
            assert target["status"] == "Found"
            history = wait_for(laf.http, f"/sessions/{session['id']}/matches", headers)
            saved = history["items"][0]
            assert saved["id"] == match["id"] and saved["disposition"] == "Confirmed"
            assert (saved["frame_id"], saved["stream_epoch"], saved["box"]) == (
                match["frame_id"], match["stream_epoch"], match["box"],
            )
            assert wait_for(laf.http, "/snapshot", headers)["runtime"]["motion_permission"] == "Disarmed"
            assert peer.output == 0
            response = laf.http.get(f"{API}/media/{saved['evidence_media']['id']}", headers=headers)
            assert response.status_code == 200 and response.headers["content-type"] == "image/png"
            with Image.open(BytesIO(jpeg)) as original, Image.open(BytesIO(response.content)) as captured:
                assert original.convert("RGB").tobytes() == captured.tobytes()


def test_serial_shutdown_waits_for_late_open_without_transmitting(uno_peer_exe: Path) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    entered, release, closed = Event(), Event(), Event()
    with native_peer(uno_peer_exe) as peer:
        @contextmanager
        def slow_open():
            entered.set()
            assert release.wait(3)
            try:
                yield peer
            finally:
                closed.set()

        link = SerialCommandLink(fixture.profile, BUILD, slow_open)
        link.start()
        closer = Thread(target=link.close, daemon=True)
        assert entered.wait(2)
        closer.start()
        try:
            closer.join(0.75)
            assert closer.is_alive() and not closed.is_set()
        finally:
            release.set()
            closer.join(3)
        assert closed.is_set() and not closer.is_alive()
        assert not peer.trace


def test_neutral_search_pauses_on_lost_status_ack_and_recovers_diagnostics(
    tmp_path: Path, uno_peer_exe: Path,
) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            with service(tmp_path, live_command=link) as laf, driving_search(laf) as (headers, _):
                assert peer.output == 0
                peer.fault = "idle_missing"
                snapshot = wait_for(laf.http, "/snapshot", headers, lambda s: (
                    s["active_session"]["state"] == "Paused"
                    and any(f["cause"] == "CommandUnavailable" and f["restored"] for f in s["failures"])
                ))
                assert snapshot["runtime"]["motion_permission"] == "Disarmed"
                assert not any(packet.op == DRIVE for _, packet in peer.trace)
        finally:
            link.close()


@pytest.mark.parametrize("fault", ["idle_missing", "stop_missing"])
def test_reconnect_keeps_unobserved_disarmed_command_fault(uno_peer_exe: Path, fault: str) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            wait_until(link.probe)
            if fault == "stop_missing":
                wait_until(lambda: link.pulse(1, "forward", monotonic() + 0.24) is None and link.output == "forward")
            peer.fault = fault
            if fault == "stop_missing":
                link.revoke(1, "InputReleased")
            wait_until(lambda: sum(packet.op == HELLO for _, packet in peer.trace) >= 2)
            assert link.latched_failure == "CommandUnavailable" and not link.probe()
            assert peer.output == 0
            link.revoke(1, "CommandUnavailable")
            wait_until(link.probe)
        finally:
            link.close()


class SocketTransport:
    def __init__(self, channel: socket.socket):
        self.channel = channel
        channel.settimeout(0.05)

    def write(self, data: bytes) -> int:
        self.channel.sendall(data)
        return len(data)

    def read(self, size: int) -> bytes:
        if not select.select([self.channel], [], [], 0)[0]:
            return b""
        data = self.channel.recv(size)
        if not data:
            raise OSError("Command fixture link closed")
        return data


def serve_search(root: Path, listener: socket.socket, channel: socket.socket, held) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    observation = Observations(fixture)
    class Adapter:
        def observe(self, now, scope):
            observation.dpad = ("forward",) if held.is_set() else ()
            return observation.observe(now, scope)

    transport = SocketTransport(channel)
    link = SerialCommandLink(fixture.profile, BUILD, lambda: nullcontext(transport))
    link.start()
    try:
        port = listener.getsockname()[1]
        app = create_app(Config(root, backend_port=port),
                         simulation=replace(fixture, adapter=Adapter(), command_sink=link))
        server = uvicorn.Server(uvicorn.Config(
            app, host="127.0.0.1", port=port, proxy_headers=False, access_log=False, ws="websockets",
            ws_max_size=app.state.socket_message_limit, ws_max_queue=1, ws_per_message_deflate=False,
            log_level="error",
        ))
        server.run(sockets=[listener])
    finally:
        link.close()


def test_killed_backend_leaves_one_queued_frame_then_firmware_expires(
    tmp_path: Path, uno_peer_exe: Path,
) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    context = get_context("spawn")
    with native_peer(uno_peer_exe) as peer, socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        host, child = socket.socketpair()
        held, queued, release, closed = context.Event(), Event(), Event(), Event()
        deferred = []

        def broker():
            pending = bytearray()
            attached = True
            while not closed.is_set():
                peer.output  # Drive the board clock even when nothing arrives from the backend.
                if deferred and release.is_set():
                    peer.write(deferred.pop())
                    release.clear()
                if not attached:
                    closed.wait(0.003)
                    continue
                if not select.select([host], [], [], 0.003)[0]:
                    continue
                try:
                    data = host.recv(256)
                except ConnectionResetError:
                    data = b""
                if not data:
                    attached = False
                    continue
                pending.extend(data)
                while (index := pending.find(0)) >= 0:
                    frame = bytes(pending[:index + 1])
                    del pending[:index + 1]
                    if len(frame) == 1:
                        continue
                    if frame == DISCARD_PARTIAL:
                        with peer.lock:
                            assert peer.step(frame)[0] == 0
                        continue
                    command = decode(frame)
                    if command.op == DRIVE and peer.output == 1 and not queued.is_set():
                        deferred.append(frame)
                        queued.set()
                        continue
                    peer.write(frame)
                    host.sendall(peer.read(MAX_FRAME))

        worker = Thread(target=broker, daemon=True)
        worker.start()
        backend = context.Process(target=serve_search, args=(tmp_path, listener, child, held))
        backend.start()
        child.close()
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=0.5, trust_env=False) as http:
                def serving():
                    try:
                        return http.get(API + "/bootstrap", headers=ORIGIN).is_success
                    except httpx.TransportError:
                        return False

                wait_until(serving, 8)
                laf = Loopback(http, port, Clock(), Observations(fixture), [], None)
                with driving_search(laf) as (headers, driver):
                    wait_for(http, "/snapshot", headers, lambda s: s["runtime"]["motion_permission"] == "Arming")
                    held.set()
                    assert queued.wait(3)
                    killed = monotonic()
                    backend.kill()
                    release.set()
                    backend.join(3)
                    assert backend.exitcode
                    wait_until(lambda: any(at >= killed and p.op == DRIVE for at, p in peer.trace))
                    wait_until(lambda: peer.output == 0)
                    [(delivered, command)] = [(at, p) for at, p in peer.trace if at >= killed and p.op == DRIVE]
                    disabled, _ = peer.outputs[-1]
                    assert 0.215 <= disabled - delivered <= 0.27
                    assert not any(p.op == STOP for _, p in peer.trace)
                    print(f"Fixture backend kill to queued delivery {(delivered - killed) * 1000:.1f} ms, "
                          f"to logical disable {(disabled - killed) * 1000:.1f} ms")
                    with peer.lock:
                        assert peer.step(encode(command))[0] == 0
                    session_id = driver.session["id"]
        finally:
            closed.set()
            if backend.is_alive():
                backend.kill()
            backend.join(3)
            backend.close()
            worker.join(3)
            host.close()
        with service(tmp_path) as laf:
            new_headers = auth(laf.bootstrap())
            session = wait_for(laf.http, f"/sessions/{session_id}", new_headers)
            assert session["state"] == "Ended" and session["end_reason"] == "Interrupted"
            assert wait_for(laf.http, "/snapshot", new_headers)["runtime"]["motion_permission"] == "Disarmed"


def test_command_reset_pauses_search_through_deliberate_recovery(tmp_path: Path, uno_peer_exe: Path) -> None:
    fixture = load_simulation("fixture-v1")
    assert fixture
    with native_peer(uno_peer_exe) as peer:
        link = SerialCommandLink(fixture.profile, BUILD, peer.open)
        link.start()
        try:
            with service(tmp_path, live_command=link) as laf:
                with driving_search(laf) as (old_headers, _):
                    wait_for(laf.http, "/snapshot", old_headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    laf.observations.dpad = ("forward",)
                    wait_until(lambda: peer.output == 1)
                    peer.fault = "reset"
                    state = wait_for(laf.http, "/snapshot", old_headers, lambda s:
                                     s["active_session"]["state"] == "Paused")
                    failure = next(f for f in state["failures"] if f["cause"] == "CommandUnavailable")
                    paused = state["active_session"]
                    assert {"cause": "RecoveryRequired", "failure_id": failure["failure_id"]} in paused["pause_causes"]
                    wait_until(link.probe)
                    assert peer.output == 0
                with recover_workspace(laf, paused) as (headers, driver):
                    restored = wait_for(laf.http, "/snapshot", headers, lambda state: any(
                        fault["cause"] == "CommandUnavailable" and fault["restored"] for fault in state["failures"]
                    ))
                    failure = next(f for f in restored["failures"] if f["cause"] == "CommandUnavailable")
                    revision = restored["active_session"]["revision"]
                    reply = search_action(laf, headers, driver, "resume", revision)
                    assert reply.json()["code"] == "RECOVERY_REQUIRED"
                    reply = search_action(laf, headers, driver, "acknowledge", revision,
                                          failure_ids=[failure["failure_id"]])
                    assert reply.is_success, reply.text
                    ready = wait_for(laf.http, "/snapshot", headers, lambda s: s["readiness"]["can_resume"])
                    reply = search_action(laf, headers, driver, "resume", ready["active_session"]["revision"])
                    assert reply.is_success, reply.text
                    sleep(0.25)
                    assert peer.output == 0
                    laf.observations.dpad = ()
                    wait_for(laf.http, "/snapshot", headers,
                             lambda s: s["runtime"]["motion_permission"] == "Arming")
                    laf.observations.dpad = ("left",)
                    wait_until(lambda: peer.output == 3)
                    laf.observations.circle = True
                    wait_until(lambda: peer.output == 0)
                    stopped = wait_for(laf.http, "/snapshot", headers, lambda s:
                                       s["active_session"]["state"] == "Paused")
                    assert any(f["cause"] == "EmergencyStop" for f in stopped["failures"])
        finally:
            link.close()
