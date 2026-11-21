"""Run the production Phase 06 app with replay at its device boundaries."""

import json
import shutil
import subprocess
import sys
from collections import deque
from contextlib import asynccontextmanager, contextmanager, nullcontext
from dataclasses import asdict, replace
from pathlib import Path
from queue import Empty, SimpleQueue
from threading import Event, Thread
from time import monotonic, perf_counter, sleep

import psutil  # type: ignore[import-untyped]

from backend.app import __main__ as entry
from backend.app import realtime, sessions
from backend.app.config import Config
from backend.app.continuity import RejectedTrack
from backend.app.controller import Controller
from backend.app.gestures import classify
from backend.app.main import create_app
from backend.app.motion import FixtureCommandSink
from backend.app.simulation import load_simulation, read_sample
from backend.app.storage import RecordsStorage
from backend.app.vision_worker import VisionProcess
from backend.app.webcam import Webcam, encode_preview, open_hand_landmarker
from backend.tests.test_controller import SERIAL, device, fresh_reports
from backend.tests.test_gestures import hand


def replay_app(config: Config, *, held_owner: bool = False):
    directory = Path(sys.argv[1])
    mode = sys.argv[2]
    simulation = load_simulation(config.simulation_profile, config.recorded_robot_jpeg)
    assert simulation is not None
    profile = simulation.profile
    sink = FixtureCommandSink(profile, monotonic)
    frames = {path.stem: read_sample(path.read_bytes(), profile) for path in directory.glob("*.jpg")}
    state_file = directory / "state.jsonl"
    trace: SimpleQueue[dict] = SimpleQueue()
    started = monotonic()
    done = Event()
    current = json.loads(state_file.read_bytes().rsplit(b"\n", 2)[-2])

    def mark(kind, **fields):
        trace.put({"kind": kind, "at": monotonic(), **fields})

    def state():
        return current

    def read_replay():
        nonlocal current
        while not done.is_set():
            try:
                sample = json.loads(state_file.read_bytes().rsplit(b"\n", 2)[-2])
            except PermissionError:
                # Windows can temporarily deny reads while the driver appends.
                pass
            else:
                if sample != current:
                    current = sample
                    mark("replay", state=sample)
            done.wait(0.012)

    class RecordedRobot:
        sequence = 0
        pending: deque[str] = deque()

        def observe(self, now, scope=None):
            observed = simulation.adapter.observe(now, scope)
            replay = state()
            if replay.get("sequence", 0) != self.sequence:
                self.sequence = replay["sequence"]
                self.pending = deque(replay["frames"])
            if self.pending:
                # Model a recorded source with enough processing headroom
                # for a contiguous crossing within the frozen 180 ms gap limit.
                sleep(0.025)
            scene = self.pending.popleft() if self.pending else replay["scene"]
            original = observed.robot
            if not scene or original is None:
                return replace(observed, robot=None)
            sample = frames[scene]
            mark("capture", frame=original.sequence, scene=scene)
            return replace(observed, robot=replace(original, jpeg=sample.jpeg, width=sample.width, height=sample.height))

    class MeasuredWorker(VisionProcess):
        def initialize(self):
            initial = super().initialize()
            mark("ready", elapsed=monotonic() - started)
            return initial

        def exchange(self, kind, fields=None, payload=None):
            if kind == "frame" and state().get("worker_stalled") == "exchange":
                mark("worker_stalled")
                wait_for_release("worker_stalled")
            begin = perf_counter()
            result = super().exchange(kind, fields, payload)
            if kind == "frame":
                mark("inference", frame=fields["sequence"], frame_id=fields["frame"], stream=fields["stream"], box=result,
                     elapsed=perf_counter() - begin, match=result is not None)
                if result is not None and state().get("worker_stalled") == "reply":
                    mark("worker_stalled")
                    wait_for_release("worker_stalled")
                    mark("worker_returned", frame_id=fields["frame"])
            return result

    class TracedTrack(RejectedTrack):
        def accept(self, stamp, observation):
            reentered = super().accept(stamp, observation)
            if state().get("sequence"):
                mark("continuity", frame=stamp.sequence, generation=stamp.scope.generation,
                     position=asdict(observation.position) if observation.position else None, reentered=reentered)
            return reentered

    def wait_for_release(key):
        until = monotonic() + 8
        while state().get(key) and monotonic() < until:
            sleep(0.015)
        blocked = bool(state().get(key))
        mark(f"{key}_released", timed_out=blocked)
        if blocked:
            raise OSError(f"The {key} replay barrier timed out.")

    def checkpoint(name):
        if name == "before_commit" and state().get("writer_stalled"):
            mark("writer_stalled")
            wait_for_release("writer_stalled")

    encode_evidence = sessions.encode_evidence

    def measured_evidence(capture):
        if state().get("evidence_stalled"):
            mark("evidence_stalled", frame=capture.sequence)
            wait_for_release("evidence_stalled")
        return encode_evidence(capture)

    def controller_poll():
        nonlocal last_buttons
        buttons = state().get("buttons")
        if buttons != last_buttons:
            mark("controller_input", buttons=buttons)
            last_buttons = buttons
        return fresh_reports([device(1, *buttons)]) if buttons is not None else ()

    def camera_read(interval=0.033):
        sleep(interval)
        mask = state().get("mask")
        if mask is None:
            raise OSError("Recorded camera disconnected.")
        mark("webcam_capture")
        return mask

    def recognize(mask):
        result = classify((hand(mask),), 640, 480)
        mark("gesture", mask=mask, count=result.count)
        return result

    def preview(_mask, label, bound):
        return encode_preview(black, label, bound)

    controller, webcam, last_buttons = None, None, None
    if mode == "controller":
        controller = Controller(SERIAL, simulation.controller_deadline_seconds, lambda: nullcontext(controller_poll))
    else:
        import numpy as np

        black = np.zeros((480, 640, 3), dtype=np.uint8)
        if mode == "native-landmarker":
            import cv2

            asset = config.gesture_assets
            assert asset is not None
            hand_image = cv2.imread(str(asset / "right_hands.jpg"))[:, :360]
            height, width = hand_image.shape[:2]
            scaled_width = round(width * 480 / height)
            left = (640 - scaled_width) // 2
            recording = black.copy()
            recording[:, left:left + scaled_width] = cv2.resize(hand_image, (scaled_width, 480))

            def native_camera_read():
                # Match the observed DirectShow cadence for the single-hand workload.
                camera_read(0.080)
                return recording

            @contextmanager
            def measured_landmarker():
                with open_hand_landmarker(asset) as read_pose:
                    def process(image):
                        begin = perf_counter()
                        pose = read_pose(image)
                        mark("gesture", elapsed=perf_counter() - begin, count=pose.count)
                        return pose

                    yield process

            webcam = Webcam(profile, lambda: nullcontext(native_camera_read), measured_landmarker, encode_preview)
        else:
            webcam = Webcam(profile, lambda: nullcontext(camera_read), lambda: nullcontext(recognize), preview)

    realtime.VisionProcess = MeasuredWorker
    realtime.RejectedTrack = TracedTrack
    sessions.encode_evidence = measured_evidence
    app = create_app(config, held_owner=held_owner, storage=RecordsStorage(config.data_root, checkpoint=checkpoint),
                     simulation=replace(simulation, adapter=RecordedRobot(), command_sink=sink),
                     controller=controller, webcam=webcam,
                     on_control_revoked=lambda revocation: mark("revocation", cause=revocation.reason))
    original_lifespan = app.router.lifespan_context
    def write_measurements():
        process = psutil.Process()
        psutil.cpu_percent()
        next_resources_at = 0.0
        nvidia_smi = shutil.which("nvidia-smi")
        last_command = None
        with (directory / "trace.jsonl").open("w", encoding="utf-8", buffering=1) as report:
            while not done.is_set():
                journal = sink.journal
                first_new = next((index + 1 for index, command in enumerate(journal) if command is last_command), 0)
                for command in journal[first_new:]:
                    report.write(json.dumps({"kind": "command", **asdict(command)}) + "\n")
                if journal:
                    last_command = journal[-1]
                while not trace.empty():
                    try:
                        observation = trace.get_nowait()
                    except Empty:
                        break
                    report.write(json.dumps(observation) + "\n")
                if monotonic() >= next_resources_at:
                    with process.oneshot():
                        rss = process.memory_info().rss
                    for child in process.children(recursive=True):
                        try:
                            rss += child.memory_info().rss
                        except psutil.NoSuchProcess:
                            pass
                    memory = psutil.virtual_memory()
                    resource = {"kind": "system", "at": monotonic(), "cpu": psutil.cpu_percent(),
                                "ram": memory.used, "backend_rss": rss}
                    if nvidia_smi:
                        try:
                            gpu = subprocess.run(
                                [nvidia_smi, "--query-gpu=utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                                capture_output=True, text=True, check=True, timeout=1,
                                creationflags=subprocess.CREATE_NO_WINDOW,
                            )
                            usage, vram = gpu.stdout.splitlines()[0].split(",")
                            resource.update(gpu=int(usage), vram_mib=int(vram))
                        except (OSError, subprocess.SubprocessError, ValueError, IndexError):
                            pass
                    report.write(json.dumps(resource) + "\n")
                    next_resources_at = monotonic() + 1
                done.wait(0.05)

    @asynccontextmanager
    async def lifespan(application):
        sink.start()
        reporter = Thread(target=write_measurements, name="phase06-replay-report", daemon=True)
        driver = Thread(target=read_replay, name="phase06-replay-input", daemon=True)
        driver.start()
        reporter.start()
        try:
            async with original_lifespan(application) as state:
                yield state
        finally:
            sink.close()
            done.set()
            driver.join(timeout=1)
            reporter.join(timeout=1)

    app.router.lifespan_context = lifespan
    return app


if __name__ == "__main__":
    def loopback_only(event, arguments):
        if event == "socket.connect":
            address = arguments[1]
            if isinstance(address, tuple) and address[0] not in {"127.0.0.1", "::1"}:
                raise OSError("Phase 06 replay denies non-loopback connections.")
        if event == "socket.getaddrinfo" and arguments[0] not in {None, "127.0.0.1", "::1", "localhost"}:
            raise OSError("Phase 06 replay denies external DNS.")

    sys.addaudithook(loopback_only)
    entry.create_app = replay_app
    raise SystemExit(entry.main())
