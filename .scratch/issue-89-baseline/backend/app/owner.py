import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class OwnerUnavailable(Exception):
    pass


@contextmanager
def own_data_root(root: Path) -> Iterator[None]:
    try:
        root.mkdir(parents=True, exist_ok=True)
        lock_path = root / ".owner.lock"
        if lock_path.is_symlink():
            raise OSError
        handle = lock_path.open("a+b")
    except OSError as exc:
        raise OwnerUnavailable("Cannot open the records data-root lock. Check LOCALAPPDATA permissions.") from exc

    with handle:
        try:
            if sys.platform == "win32":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise OwnerUnavailable("Cannot own the records data root. Close the other backend and retry.") from exc
        # Closing the handle releases OS ownership even when the process dies.
        yield
