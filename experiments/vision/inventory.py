"""Fresh machine/package measurements, independent of historical TRD inputs."""

import importlib.metadata
import platform
import shutil
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def command(args: list[str]) -> str:
    result = subprocess.run(args, capture_output=True, text=True, check=False)
    return (result.stdout + result.stderr).strip()


def memory() -> dict:
    import psutil

    vm = psutil.virtual_memory()
    process = psutil.Process()
    return {
        "system_available_bytes": vm.available,
        "system_total_bytes": vm.total,
        "process_rss_bytes": process.memory_info().rss,
    }


def collect() -> dict:
    windows = None
    if sys.platform == "win32":
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
        ) as key:
            windows = {}
            for name in ("ProductName", "DisplayVersion", "CurrentBuild", "UBR"):
                windows[name] = winreg.QueryValueEx(key, name)[0]
    return {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "platform": platform.platform(),
        "windows_registry": windows,
        "python": sys.version,
        "sqlite": sqlite3.sqlite_version,
        "memory": memory(),
        "disk": {
            drive: shutil.disk_usage(drive)._asdict() for drive in ("C:/", "D:/") if Path(drive).exists()
        },
        "gpu": command(
            ["nvidia-smi", "--query-gpu=name,driver_version,memory.total,memory.free", "--format=csv"]
        ),
        "node": command(["node", "--version"]),
        "packages": dict(sorted((d.metadata["Name"], d.version) for d in importlib.metadata.distributions())),
    }
