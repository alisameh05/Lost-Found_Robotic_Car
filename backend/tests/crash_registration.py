"""Process test entry point that exits at a registration persistence boundary."""
import os
import sys
from pathlib import Path
from time import monotonic, sleep

from backend.app import __main__ as entry
from backend.app.config import Config
from backend.app.main import create_app
from backend.app.storage import RecordsStorage


def crash_at_checkpoint(name: str) -> None:
    if name != sys.argv[1]:
        return
    if len(sys.argv) == 2:
        os._exit(84)
    gate = Path(sys.argv[2])
    deadline = monotonic() + 15
    while not gate.exists():
        if monotonic() >= deadline:
            raise OSError("Registration test gate was not released")
        sleep(0.02)


def test_app(config: Config, *, held_owner: bool = False):
    return create_app(config, held_owner=held_owner, storage=RecordsStorage(
        config.data_root, checkpoint=crash_at_checkpoint,
    ))


if __name__ == "__main__":
    entry.create_app = test_app
    raise SystemExit(entry.main())
