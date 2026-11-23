import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path
from secrets import token_urlsafe
from time import monotonic, sleep

import httpx
import pytest
from PIL import Image

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows launcher")


ROOT = Path(__file__).resolve().parents[2]


def launch(data_parent: Path, release: Path = ROOT, **settings: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["pwsh", "-NoProfile", "-File", str(release / "launch.ps1"), "--no-browser"],
        cwd=release, env={
            **{key: value for key, value in os.environ.items() if not key.startswith("LAF_")},
            "LOCALAPPDATA": str(data_parent), "LAF_PYTHON": sys.executable, **settings,
        }, input="", capture_output=True, text=True, timeout=20,
    )


def test_launcher_reports_missing_python(tmp_path: Path) -> None:
    result = launch(tmp_path, LAF_PYTHON=str(tmp_path / "missing-python.exe"))
    assert result.returncode != 0
    assert "Python runtime is missing" in result.stdout + result.stderr


def test_launcher_rejects_conflicting_ports_before_touching_records(tmp_path: Path) -> None:
    result = launch(tmp_path, LAF_FRONTEND_PORT="16000", LAF_BACKEND_PORT="16000")
    assert result.returncode != 0
    assert "LAF_FRONTEND_PORT and LAF_BACKEND_PORT must be different" in result.stdout + result.stderr
    assert not (tmp_path / "LostAndFound").exists()


def test_launcher_reports_missing_production_build(tmp_path: Path) -> None:
    release = tmp_path / "release"
    for name in ("launch.ps1", "backend/launcher.py", "backend/app/config.py"):
        destination = release / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
    result = launch(tmp_path, release)
    assert result.returncode != 0
    assert "Next.js dependencies or the production build are missing" in result.stdout + result.stderr


@pytest.mark.parametrize("service", ["Frontend", "Backend"])
def test_launcher_reports_occupied_port(service: str, tmp_path: Path) -> None:
    if not (ROOT / "frontend/.next/BUILD_ID").is_file():
        pytest.skip("Build the production frontend to check launcher port diagnostics.")
    with socket.socket() as listener, socket.socket() as spare:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        spare.bind(("127.0.0.1", 0))
        occupied = listener.getsockname()[1]
        free = spare.getsockname()[1]
        spare.close()
        ports = (occupied, free) if service == "Frontend" else (free, occupied)
        result = launch(tmp_path, LAF_FRONTEND_PORT=str(ports[0]), LAF_BACKEND_PORT=str(ports[1]))
        assert result.returncode != 0
        assert f"{service} cannot bind 127.0.0.1:{occupied}" in result.stdout + result.stderr
        assert not (tmp_path / "LostAndFound").exists()


def test_supervised_backend_can_start_its_native_worker_with_stdin_open(tmp_path: Path) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    recording = tmp_path / "recording.jpg"
    Image.new("RGB", (640, 360), (45, 45, 45)).save(recording)
    capability = token_urlsafe(32)
    env = {**{key: value for key, value in os.environ.items() if not key.startswith("LAF_")},
           "LOCALAPPDATA": str(tmp_path), "LAF_DATA_ROOT": str(tmp_path / "records"),
           "LAF_LAUNCH_CAPABILITY": capability, "LAF_BACKEND_PORT": str(port),
           "LAF_BACKEND_MODE": "fixture", "LAF_SIMULATION_PROFILE": "phase-06-v1",
           "LAF_RECORDED_ROBOT_JPEG": str(recording), "LAF_YOLOE_ASSETS": str(tmp_path / "missing-assets")}
    with subprocess.Popen(
        [sys.executable, "-m", "backend.app", "--supervised"], cwd=ROOT, env=env, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    ) as backend:
        assert backend.stdin is not None
        ai = None
        try:
            deadline = monotonic() + 12
            with httpx.Client(timeout=0.5, trust_env=False) as client:
                while monotonic() < deadline and backend.poll() is None:
                    try:
                        response = client.get(f"http://127.0.0.1:{port}/api/v1/health",
                                              headers={"X-App-Capability": capability})
                    except httpx.RequestError:
                        sleep(0.05)
                        continue
                    if response.status_code == 200:
                        ai = next(path for path in response.json()["readiness"]["components"]
                                  if path["component"] == "AI")
                        if ai["cause_codes"] == ["MEDIA_UNAVAILABLE"]:
                            break
                    sleep(0.05)
        finally:
            backend.stdin.close()
            try:
                backend.wait(timeout=8)
            except subprocess.TimeoutExpired:
                backend.kill()
                backend.wait(timeout=5)
        assert ai == {"component": "AI", "status": "Unavailable", "cause_codes": ["MEDIA_UNAVAILABLE"]}
        assert backend.returncode == 0
