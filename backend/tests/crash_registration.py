"""Records process test controls for persistence boundaries, cleanup failures and clock changes."""
import os
import sys
from dataclasses import replace
from pathlib import Path
from time import monotonic, sleep

from backend.app import __main__ as entry
from backend.app.config import Config
from backend.app.main import create_app
from backend.app.simulation import load_simulation
from backend.app.storage import RecordsStorage, utc_ms


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
    if sys.argv[1] == "clock":
        source = Path(sys.argv[2])
        offset = int(source.read_text())

        def clock() -> int:
            nonlocal offset
            try:
                offset = int(source.read_text())
            except ValueError:
                # The harness can sample while the browser is rewriting the file.
                pass
            return utc_ms() + offset

        def crash_with_clock(boundary: str) -> None:
            if len(sys.argv) > 3 and boundary == sys.argv[3]:
                os._exit(84)

        storage = RecordsStorage(config.data_root, clock=clock, checkpoint=crash_with_clock)
        if len(sys.argv) == 5 and sys.argv[3] == "deny-purge":
            blocked = Path(sys.argv[4])
            discard = storage.files.discard

            def deny_media_deletion(relative: str) -> None:
                if relative.startswith("media/") and blocked.exists():
                    raise PermissionError("Test repair gate blocks managed media deletion")
                discard(relative)

            storage.files.discard = deny_media_deletion
    else:
        storage = RecordsStorage(config.data_root, checkpoint=crash_at_checkpoint)
    if os.environ.get("LAF_TEST_NO_WEBCAM") == "1":
        simulation = load_simulation(config.simulation_profile)
        assert simulation is not None

        class WithoutWebcam:
            def observe(self, now, scope=None):
                sample = simulation.adapter.observe(now, scope)
                return replace(sample, webcam=None, gesture_input=None, gesture_sample_at=None)

        return create_app(config, held_owner=held_owner, storage=storage,
                          simulation=replace(simulation, adapter=WithoutWebcam()))
    return create_app(config, held_owner=held_owner, storage=storage)


if __name__ == "__main__":
    entry.create_app = test_app
    raise SystemExit(entry.main())
