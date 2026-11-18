import hashlib
import os
import re
import stat
from pathlib import Path

from .http import DOMAIN_ID

GENERATED_ID = r"[0-9a-f]{32}"
STAGING_NAME = re.compile(rf"({GENERATED_ID})\.part")
MEDIA_NAME = re.compile(rf"({DOMAIN_ID})\.(jpg|png)")


def sync_directory(path: Path) -> None:
    if os.name != "nt":
        handle = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(handle)
        finally:
            os.close(handle)


def move_durable(source: Path, target: Path) -> None:
    if os.name == "nt":
        from ctypes import WinDLL, WinError, get_last_error, wintypes

        move = WinDLL("kernel32", use_last_error=True).MoveFileExW
        move.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
        move.restype = wintypes.BOOL
        if not move(str(source), str(target), 0x8):  # MOVEFILE_WRITE_THROUGH without replacement
            raise WinError(get_last_error())
    else:
        if target.exists():
            raise FileExistsError(target)
        os.rename(source, target)
        sync_directory(target.parent)
        sync_directory(source.parent)


def redirected(entry: os.stat_result) -> bool:
    return stat.S_ISLNK(entry.st_mode) or bool(
        getattr(entry, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT,
    )


class ManagedMedia:
    def __init__(self, root: Path):
        self.root = root.absolute()

    def directory(self, name: str, *, create: bool = False) -> Path:
        root = self.root
        root_entry = root.lstat()
        if not stat.S_ISDIR(root_entry.st_mode) or redirected(root_entry) or root.resolve() != root:
            raise OSError("Unsafe managed storage root")
        directory = root / name
        if create:
            directory.mkdir(exist_ok=True)
        entry = directory.lstat()
        if redirected(entry) or not stat.S_ISDIR(entry.st_mode) or not directory.resolve().is_relative_to(root):
            raise OSError("Unsafe managed storage directory")
        return directory

    def path(self, relative: str) -> Path:
        folder, separator, name = relative.partition("/")
        pattern = STAGING_NAME if folder == "staging" else MEDIA_NAME if folder == "media" else None
        if not separator or pattern is None or not pattern.fullmatch(name):
            raise OSError("Invalid managed relative path")
        path = self.directory(folder) / name
        try:
            entry = path.lstat()
        except FileNotFoundError:
            return path
        if redirected(entry) or not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
            raise OSError("Unsafe managed media file")
        return path

    def stage(self, relative: str, data: bytes) -> str:
        path = self.path(relative)
        checksum = hashlib.sha256(data).hexdigest()
        with path.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        sync_directory(path.parent)
        availability, _ = self.read(relative, len(data), checksum)
        if availability != "Available":
            raise OSError("Cannot verify staged reference")
        return checksum

    def promote(self, staging: str, final: str) -> None:
        move_durable(self.path(staging), self.path(final))

    def discard(self, relative: str) -> None:
        path = self.path(relative)
        path.unlink(missing_ok=True)
        sync_directory(path.parent)

    def read(
        self, relative: str, byte_length: int, checksum: str, *, metadata_only: bool = False,
    ) -> tuple[str, bytes | None]:
        try:
            with self.path(relative).open("rb") as handle:
                info = os.fstat(handle.fileno())
                if (redirected(info) or not stat.S_ISREG(info.st_mode)
                        or info.st_nlink != 1 or info.st_size != byte_length):
                    return "Corrupt", None
                # Registration re-encoding may exceed the upload limit, but cannot exceed this RGB bound.
                if byte_length > 100_000_000:
                    return "Corrupt", None
                if metadata_only:
                    digest = hashlib.file_digest(handle, "sha256").hexdigest()
                    return ("Available" if digest == checksum else "Corrupt"), None
                data = handle.read(byte_length + 1)
        except FileNotFoundError:
            return "Missing", None
        except OSError:
            return "Corrupt", None
        if len(data) != byte_length or hashlib.sha256(data).hexdigest() != checksum:
            return "Corrupt", None
        return "Available", data
