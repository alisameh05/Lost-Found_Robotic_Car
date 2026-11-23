"""Supervise the installed Windows app using only the local runtimes."""

import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
from pathlib import Path
from secrets import token_urlsafe
from threading import Event, Thread
from time import monotonic
from typing import Any, cast

from .app.config import LOOPBACK, Config

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
STARTUP_SECONDS = 45
SHUTDOWN_SECONDS = 30


class LaunchError(Exception):
    pass


def check_port(port: int, service: str) -> None:
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            listener.bind((LOOPBACK, port))
        except OSError as exc:
            raise LaunchError(f"{service} cannot bind {LOOPBACK}:{port}. Free that port or change its LAF port.") from exc


def check_models(config: Config) -> None:
    try:
        inventory = json.loads((ROOT / "experiments/vision/assets.json").read_text(encoding="utf-8"))
        if not isinstance(inventory, dict):
            raise ValueError("Expected a model inventory.")
    except (OSError, ValueError):
        print("Model inventory is missing or invalid. Restore experiments/vision/assets.json from this release.")
        return
    for name, directory, variable in (
        ("yoloe-26s-seg.pt", config.yoloe_assets, "LAF_YOLOE_ASSETS"),
        ("hand_landmarker.task", config.gesture_assets, "LAF_GESTURE_ASSETS"),
    ):
        entry = inventory.get(name)
        if not isinstance(entry, dict) or not isinstance(entry.get("sha256"), str):
            print(f"Model inventory entry is missing or invalid: {name}. Restore the release asset inventory.")
            continue
        valid = False
        if directory is not None:
            try:
                with (directory / name).open("rb") as stream:
                    valid = hashlib.file_digest(stream, "sha256").hexdigest() == entry["sha256"]
            except OSError:
                pass
        if not valid:
            print(f"Model missing, unreadable, or invalid: {name}. Run the asset setup or correct {variable}.")


def installed_node() -> str:
    node = shutil.which("node.exe")
    if not node:
        raise LaunchError("Node.js runtime is missing. Install the release's Node.js runtime and add it to PATH.")
    try:
        version = subprocess.check_output([node, "--version"], text=True, timeout=5).strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise LaunchError("Node.js did not report its version. Check the Node.js installation on PATH.") from exc
    supported = re.fullmatch(r"v24\.(\d+)\.\d+", version)
    if not supported or int(supported[1]) < 19:
        raise LaunchError(f"Unsupported Node.js {version}. Install Node.js 24.19.0 or newer in the 24.x line.")
    return node


def request(port: int, route: str, capability: str | None = None) -> tuple[int, dict[str, Any]]:
    # Connect directly to loopback, independently of system or environment proxy settings.
    connection = http.client.HTTPConnection(LOOPBACK, port, timeout=0.75)
    try:
        headers = {"X-App-Capability": capability} if capability else {}
        connection.request("GET", route, headers=headers)
        response = connection.getresponse()
        if capability and response.status in (200, 503):
            body = json.loads(response.read(64 * 1024))
            if isinstance(body, dict):
                return response.status, cast(dict[str, Any], body)
        return response.status, {}
    except (OSError, http.client.HTTPException, ValueError):
        return 0, {}
    finally:
        connection.close()


def check_process(process: subprocess.Popen[bytes], service: str) -> None:
    if (status := process.poll()) is not None:
        raise LaunchError(f"{service} exited (code {status}). Check its output above for the startup or runtime error.")


def wait_for_startup(
    frontend: subprocess.Popen[bytes], backend: subprocess.Popen[bytes], config: Config,
    capability: str, stop: Event, open_browser: bool,
) -> None:
    deadline = monotonic() + STARTUP_SECONDS
    frontend_ready = False
    backend_ready = False
    while not stop.is_set() and monotonic() < deadline:
        check_process(backend, "Backend")
        check_process(frontend, "Frontend")
        if not frontend_ready and request(config.frontend_port, "/")[0] == 200:
            frontend_ready = True
            print(f"Frontend available at {config.origin}")
            if open_browser:
                try:
                    os.startfile(config.origin)
                except OSError:
                    print(f"Could not open the default browser. Open {config.origin} manually.")
        status, health = request(config.backend_port, "/api/v1/health", capability)
        if not backend_ready and status in (200, 503) and health.get("backend_boot_id"):
            backend_ready = True
            print("Backend available. Checking records storage.")
        if health.get("initialization") == "Failed" or (
            health.get("initialization") == "Ready" and health.get("storage_integrity") == "Unavailable"
        ):
            _, detail = request(config.backend_port, "/api/v1/settings", capability)
            problem = detail.get("message", "Check local storage permissions and the saved database.")
            raise LaunchError(f"Records storage is unavailable. {problem}")
        if frontend_ready and status == 200 and health.get("storage_integrity") == "Healthy":
            print("Records storage ready.")
            if config.backend_mode == "device":
                profile = next((part for part in health["readiness"]["components"]
                                if part["component"] == "QualificationProfile"), None)
                if profile is None or profile["status"] != "Ready":
                    print("Device qualification is unavailable. Records are available with motion disarmed.")
            print("Open Devices to inspect readiness. Press Enter to shut down.")
            return
        stop.wait(0.2)
    if not stop.is_set():
        if not frontend_ready:
            raise LaunchError("Frontend did not become reachable. Check the Next.js build and port.")
        if not backend_ready:
            raise LaunchError("Backend did not respond to protected health. Check the Python runtime and backend port.")
        raise LaunchError("Records storage initialization timed out. Check local storage and the backend output.")


def finish_process(process: subprocess.Popen[bytes], service: str, grace: float) -> bool:
    try:
        return process.wait(timeout=grace) == 0
    except subprocess.TimeoutExpired:
        print(f"{service} did not exit in time. Ending its process tree. Check any unconfirmed saves after restart.")
        subprocess.run(
            ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10, check=False,
        )
        process.wait(timeout=5)
        return False


def launch(*, open_browser: bool) -> int:
    os.environ.setdefault("LAF_BACKEND_MODE", "device")
    for name in ("LAF_YOLOE_ASSETS", "LAF_GESTURE_ASSETS"):
        os.environ.setdefault(name, str(ROOT / ".local-runtime/assets"))
    config = Config.from_environment()
    node = installed_node()
    next_bin = FRONTEND / "node_modules/next/dist/bin/next"
    frontend_guard = FRONTEND / "scripts/exit-with-launcher.mjs"
    if not all(path.is_file() for path in (next_bin, FRONTEND / ".next/BUILD_ID", frontend_guard)):
        raise LaunchError("Next.js dependencies or the production build are missing. Run the frontend setup and build.")
    check_port(config.frontend_port, "Frontend")
    check_port(config.backend_port, "Backend")
    check_models(config)
    print(f"Lost & Found launcher (PID {os.getpid()})")

    stop = Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())

    def wait_for_enter() -> None:
        try:
            while key := os.read(sys.stdin.fileno(), 1):
                if key == b"\n":
                    stop.set()
                    break
        except OSError:
            pass

    Thread(target=wait_for_enter, daemon=True).start()
    capability = token_urlsafe(32)
    environment = {**os.environ, "LAF_MODE": "records", "NODE_ENV": "production", "NEXT_TELEMETRY_DISABLED": "1"}
    backend = subprocess.Popen(
        [sys.executable, "-u", "-m", "backend.app", "--supervised"],
        cwd=ROOT, stdin=subprocess.PIPE, env={**environment, "LAF_LAUNCH_CAPABILITY": capability},
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    frontend = None
    clean_exit = False
    try:
        frontend = subprocess.Popen(
            [node, "--import", frontend_guard.as_uri(), str(next_bin), "start",
             "--hostname", LOOPBACK, "--port", str(config.frontend_port)],
            cwd=FRONTEND, stdin=subprocess.PIPE, env=environment, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
        )
        wait_for_startup(frontend, backend, config, capability, stop, open_browser)
        while not stop.wait(0.25):
            check_process(backend, "Backend")
            check_process(frontend, "Frontend")
    finally:
        try:
            if backend.poll() is None:
                print("Stopping the backend first so it can disarm and drain pending saves.")
            assert backend.stdin is not None
            backend.stdin.close()
            clean_exit = finish_process(backend, "Backend", SHUTDOWN_SECONDS)
            if not clean_exit:
                print("Backend shutdown was incomplete. Check History or retry any unconfirmed saves after restart.")
        finally:
            if frontend is not None and frontend.stdin is not None:
                frontend.stdin.close()
                clean_exit = finish_process(frontend, "Frontend", 3) and clean_exit
    return 0 if clean_exit else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true", help="Leave browser navigation to the operator.")
    args = parser.parse_args()
    if sys.platform != "win32" or sys.version_info[:2] != (3, 11):
        print("Use the installed Windows Python 3.11 application runtime.", file=sys.stderr)
        return 1
    try:
        return launch(open_browser=not args.no_browser)
    except (LaunchError, OSError, ValueError, subprocess.SubprocessError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
