"""Browser test entry point that holds storage initialization until the test releases it."""

import sys
from pathlib import Path
from time import monotonic, sleep
from unittest.mock import patch

from backend.app.__main__ import main
from backend.app.storage import RecordsStorage


def run(gate: Path) -> int:
    initialize = RecordsStorage.initialize

    def wait_at_startup(storage: RecordsStorage) -> None:
        deadline = monotonic() + 45
        while not gate.exists():
            if monotonic() >= deadline:
                raise OSError("Browser test did not release storage initialization")
            sleep(0.025)
        initialize(storage)

    with patch.object(RecordsStorage, "initialize", wait_at_startup):
        return main()


if __name__ == "__main__":
    raise SystemExit(run(Path(sys.argv[1])))
