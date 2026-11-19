"""Run the backend against an independently hosted fixture command watchdog."""

import socket
from dataclasses import replace
from multiprocessing import get_context
from multiprocessing.connection import Connection
from pathlib import Path
from threading import Thread
from time import monotonic, sleep

import httpx
import uvicorn

from backend.app.config import Config
from backend.app.main import create_app
from backend.app.motion import Challenge, Command, Direction, InputScope
from backend.app.simulation import load_simulation
from backend.tests.test_realtime import (
    Clock,
    CommandDevice,
    Loopback,
    Observations,
    driving_search,
    wait_output,
)


class ConnectedFixtureSink:
    """Private inherited test pipe. The device and its clock outlive the backend."""

    def __init__(self, pipe: Connection):
        self.pipe = pipe

    def call(self, method: str, *args):
        self.pipe.send((method, args))
        return self.pipe.recv()

    @property
    def output(self) -> Direction | None:
        return self.call("output")

    def challenge(self, scope: InputScope, generation: int) -> Challenge:
        return self.call("challenge", scope, generation)

    def renew(self, command: Command) -> Command | None:
        return self.call("renew", command)

    def revoke(self, generation: int, cause: str) -> None:
        self.call("revoke", generation, cause)


def run_backend(root: Path, listener: socket.socket, pipe: Connection) -> None:
    simulation = load_simulation("fixture-v1")
    assert simulation is not None
    port = listener.getsockname()[1]
    app = create_app(Config(root, backend_port=port), simulation=replace(
        simulation, command_sink=ConnectedFixtureSink(pipe),
    ))
    uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, proxy_headers=False, access_log=False, ws="websockets",
        ws_max_size=app.state.socket_message_limit, ws_max_queue=1, ws_per_message_deflate=False,
        log_level="error",
    )).run(sockets=[listener])


def serve_device(pipe: Connection, device: CommandDevice) -> None:
    try:
        while True:
            method, args = pipe.recv()
            value = device.output if method == "output" else getattr(device, method)(*args)
            pipe.send(value)
    except (EOFError, OSError):
        # A missing backend supplies neither renewals nor STOP.
        pass


def test_killed_backend_cannot_keep_remote_logical_permission_alive(tmp_path: Path) -> None:
    simulation = load_simulation("fixture-v1")
    assert simulation is not None
    context = get_context("spawn")
    device = CommandDevice(simulation.profile)
    device.start()
    host, remote = context.Pipe()
    worker = Thread(target=serve_device, args=(host, device), daemon=True)
    worker.start()
    try:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
            backend = context.Process(target=run_backend, args=(tmp_path, listener, remote))
            backend.start()
            remote.close()
            try:
                with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=0.5, trust_env=False) as http:
                    started = monotonic() + 8
                    while monotonic() < started:
                        try:
                            if http.get("/api/v1/bootstrap", headers={"Origin": "http://127.0.0.1:3000"}).is_success:
                                break
                        except httpx.TransportError:
                            sleep(0.02)
                    laf = Loopback(http, port, Clock(), Observations(simulation), [], None, device)
                    with driving_search(laf):
                        wait_output(laf, "forward")
                        backend.kill()
                        backend.join(3)
                        wait_output(laf, None)
                        expiry = device.journal[-1]
                        assert expiry.event == "expired" and expiry.output is None
                        last_renewal = device.journal[-2]
                        assert last_renewal.event == "renewed"
                        assert expiry.deadline == last_renewal.deadline
                        assert expiry.at >= expiry.deadline
                        assert 0.219 <= expiry.deadline - last_renewal.at <= 0.221
                        assert not any(event.event in ("revoked", "stop") for event in device.journal)
            finally:
                if backend.is_alive():
                    backend.kill()
                backend.join(3)
                backend.close()
    finally:
        remote.close()
        host.close()
        device.close()
        worker.join(3)
