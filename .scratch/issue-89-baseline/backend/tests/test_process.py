import os
import socket
import subprocess
import sys
import time
from contextlib import closing
from pathlib import Path

import httpx

ORIGIN = {"Origin": "http://127.0.0.1:3000"}


def free_port() -> int:
    with closing(socket.socket()) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def launch(root: Path, port: int, entry: tuple[str, ...] = ("backend.app",)) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", *entry],
        env={**os.environ, "LOCALAPPDATA": str(root.parent), "LAF_DATA_ROOT": str(root),
             "LAF_FRONTEND_PORT": "3000", "LAF_BACKEND_PORT": str(port)},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )


def connect(process: subprocess.Popen[str], port: int) -> dict:
    deadline = time.monotonic() + 15
    with httpx.Client(base_url=f"http://127.0.0.1:{port}", trust_env=False, timeout=1) as http:
        while time.monotonic() < deadline and process.poll() is None:
            try:
                response = http.get("/api/v1/bootstrap", headers=ORIGIN)
                assert response.status_code == 200, response.text
                context = response.json()
                headers = {"X-App-Capability": context["capability"]}
                for _ in range(50):
                    health = http.get("/api/v1/health", headers=headers)
                    if health.status_code == 200:
                        return context
                    assert health.json()["initialization"] == "Starting", health.json()
                    time.sleep(0.05)
            except (httpx.ConnectError, httpx.ConnectTimeout):
                time.sleep(0.1)
    output = process.stdout.read() if process.poll() is not None and process.stdout else ""
    raise AssertionError(f"Backend process did not become healthy. {output}")


def raw_http(port: int, data: bytes) -> tuple[str, bytes]:
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(data)
        with sock.makefile("rb") as reader:
            headers, body = reader.read().split(b"\r\n\r\n", 1)
    return headers.decode("ascii"), body


def test_actual_process_excludes_other_owners_and_reacquires_after_death(tmp_path: Path) -> None:
    root = tmp_path / "records"
    port = free_port()
    process = launch(root, port)
    try:
        first = connect(process, port)
        collision = launch(tmp_path / "different", port)
        output, _ = collision.communicate(timeout=10)
        assert collision.returncode == 1 and "cannot bind" in output
        assert not (tmp_path / "different").exists()

        competitor = launch(root, free_port())
        output, _ = competitor.communicate(timeout=10)
        assert competitor.returncode == 1 and "Cannot own the records data root" in output

        host = f"127.0.0.1:{port}".encode()
        prefix = b"GET /api/v1/health HTTP/1.1\r\nConnection: close\r\nHost: " + host
        headers, body = raw_http(port, prefix + b"\r\nHost: " + host + b"\r\n\r\n")
        assert "403 Forbidden" in headers and b"HOST_REJECTED" in body

        capability = first["capability"].encode()
        chunked = prefix + b"\r\nX-App-Capability: " + capability + b"\r\nTransfer-Encoding: chunked\r\n\r\n"
        headers, body = raw_http(port, chunked + b"10001\r\n" + b"a" * 65_537 + b"\r\n0\r\n\r\n")
        assert "413" in headers and b"PAYLOAD_TOO_LARGE" in body
    finally:
        process.kill()
        process.communicate(timeout=10)

    replacement_port = free_port()
    replacement = launch(root, replacement_port)
    try:
        second = connect(replacement, replacement_port)
        assert second["backend_boot_id"] != first["backend_boot_id"]
        assert second["capability"] != first["capability"]
        with httpx.Client(base_url=f"http://127.0.0.1:{replacement_port}", trust_env=False) as http:
            result = http.get("/api/v1/settings", headers={"X-App-Capability": second["capability"]})
            assert result.json()["retention_days"] == 7
    finally:
        replacement.kill()
        replacement.communicate(timeout=10)
