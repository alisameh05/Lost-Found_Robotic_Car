import os
from dataclasses import dataclass
from pathlib import Path

LOOPBACK = "127.0.0.1"


def read_port(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    if not raw.isascii() or not raw.isdecimal() or len(raw) > 5 or not 1 <= int(raw) <= 65535:
        raise ValueError(f"{name} must be an integer from 1 to 65535.")
    return int(raw)


@dataclass(frozen=True)
class Config:
    data_root: Path
    frontend_port: int = 3000
    backend_port: int = 8000
    simulation_profile: str | None = None

    @property
    def host(self) -> str:
        return f"{LOOPBACK}:{self.backend_port}"

    @property
    def origin(self) -> str:
        return f"http://{LOOPBACK}:{self.frontend_port}"

    @classmethod
    def from_environment(cls) -> "Config":
        local = os.environ.get("LOCALAPPDATA")
        if not local:
            raise ValueError("Set LOCALAPPDATA to the Windows user's local application data directory.")
        local_root = Path(local).resolve()
        root = Path(os.environ.get("LAF_DATA_ROOT", str(local_root / "LostAndFound")))
        if not root.is_absolute():
            raise ValueError("LAF_DATA_ROOT must be an absolute path inside LOCALAPPDATA.")
        root = root.resolve()
        repo = Path(__file__).resolve().parents[2]
        cloud_roots = [
            Path(value).resolve()
            for variable in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial")
            if (value := os.environ.get(variable))
        ]
        if root == local_root or not root.is_relative_to(local_root) or any(
            root.is_relative_to(path) or path.is_relative_to(root) for path in [repo, *cloud_roots]
        ):
            raise ValueError("Use an application-specific LOCALAPPDATA directory outside source and synced folders.")
        frontend = read_port("LAF_FRONTEND_PORT", 3000)
        backend = read_port("LAF_BACKEND_PORT", 8000)
        if frontend == backend:
            raise ValueError("LAF_FRONTEND_PORT and LAF_BACKEND_PORT must be different.")
        return cls(root, frontend, backend, os.environ.get("LAF_SIMULATION_PROFILE"))
