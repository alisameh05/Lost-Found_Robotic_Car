import hashlib
import os
import re
import stat
import struct
import zlib
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import BinaryIO

from PIL import Image

from .http import DOMAIN_ID, HttpError
from .reference_image import inspect_png

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


def redirected(entry: os.stat_result) -> bool:
    return stat.S_ISLNK(entry.st_mode) or bool(
        getattr(entry, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT,
    )


def close_windows_handle(handle: int) -> None:
    from ctypes import WinDLL, wintypes

    close = WinDLL("kernel32", use_last_error=True).CloseHandle
    close.argtypes = (wintypes.HANDLE,)
    close.restype = wintypes.BOOL
    close(handle)


def open_windows_entry(path: Path, *, directory: bool, deleting: bool = False) -> int:
    from ctypes import WinDLL, WinError, create_unicode_buffer, get_last_error, sizeof, wintypes

    kernel = WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                       wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    create.restype = wintypes.HANDLE
    # Keep directory entries pinned by denying write/delete sharing. Open the entry itself,
    # rather than letting a junction or symbolic link select the target of the operation.
    access = 0x80 if directory else 0x80000000  # FILE_READ_ATTRIBUTES / GENERIC_READ
    if deleting:
        access = 0x10080  # DELETE | FILE_READ_ATTRIBUTES
    flags = 0x00200000 | (0x02000000 if directory else 0)  # OPEN_REPARSE_POINT / BACKUP_SEMANTICS
    handle = create(str(path), access, 1, None, 3, flags, None)  # FILE_SHARE_READ / OPEN_EXISTING
    if handle is None or handle == wintypes.HANDLE(-1).value:
        raise WinError(get_last_error())
    attributes = (wintypes.DWORD * 2)()
    inspect = kernel.GetFileInformationByHandleEx
    inspect.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD)
    inspect.restype = wintypes.BOOL
    if not inspect(handle, 9, attributes, sizeof(attributes)):  # FileAttributeTagInfo
        error = WinError(get_last_error())
        close_windows_handle(handle)
        raise error
    if attributes[0] & stat.FILE_ATTRIBUTE_REPARSE_POINT or bool(attributes[0] & 0x10) != directory:
        close_windows_handle(handle)
        raise OSError("Invalid managed filesystem entry")
    resolve = kernel.GetFinalPathNameByHandleW
    resolve.argtypes = (wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD)
    resolve.restype = wintypes.DWORD
    actual_name = create_unicode_buffer(32768)
    length = resolve(handle, actual_name, len(actual_name), 0)
    if not length or length >= len(actual_name):
        error = WinError(get_last_error())
        close_windows_handle(handle)
        raise error
    if Path(actual_name.value.removeprefix("\\\\?\\")) != path:
        close_windows_handle(handle)
        raise OSError("Managed filesystem entry resolves outside its configured path")
    return int(handle)


@dataclass(frozen=True)
class ManagedEntry:
    path: Path
    parent_fd: int | None

    def stat(self) -> os.stat_result:
        if self.parent_fd is None:
            return self.path.lstat()
        return os.stat(self.path.name, dir_fd=self.parent_fd, follow_symlinks=False)

    def sync_parent(self) -> None:
        if self.parent_fd is not None:
            os.fsync(self.parent_fd)

    def check(self) -> None:
        try:
            entry = self.stat()
        except FileNotFoundError:
            return
        if redirected(entry) or not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
            raise OSError("Unsafe managed media file")

    def open_read(self) -> BinaryIO:
        if self.parent_fd is None:
            from msvcrt import open_osfhandle

            handle = open_windows_entry(self.path, directory=False)
            try:
                fd = open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            except BaseException:
                close_windows_handle(handle)
                raise
        else:
            fd = os.open(self.path.name, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0), dir_fd=self.parent_fd)
        return os.fdopen(fd, "rb")

    def open_stage(self) -> BinaryIO:
        if self.parent_fd is None:
            return self.path.open("xb")
        fd = os.open(self.path.name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600, dir_fd=self.parent_fd)
        return os.fdopen(fd, "wb")

    def discard(self) -> None:
        try:
            if self.parent_fd is None:
                from ctypes import WinDLL, WinError, byref, get_last_error, sizeof, wintypes

                handle = open_windows_entry(self.path, directory=False, deleting=True)
                try:
                    self.check()
                    mark = WinDLL("kernel32", use_last_error=True).SetFileInformationByHandle
                    mark.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD)
                    mark.restype = wintypes.BOOL
                    delete = wintypes.BOOL(True)
                    if not mark(handle, 4, byref(delete), sizeof(delete)):  # FileDispositionInfo
                        raise WinError(get_last_error())
                finally:
                    close_windows_handle(handle)
            else:
                os.unlink(self.path.name, dir_fd=self.parent_fd)
        except FileNotFoundError:
            pass
        self.sync_parent()


def move_durable(source: ManagedEntry, target: ManagedEntry) -> None:
    if os.name == "nt":
        from ctypes import WinDLL, WinError, get_last_error, wintypes

        move = WinDLL("kernel32", use_last_error=True).MoveFileExW
        move.argtypes = (wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD)
        move.restype = wintypes.BOOL
        if not move(str(source.path), str(target.path), 0x8):  # MOVEFILE_WRITE_THROUGH without replacement
            raise WinError(get_last_error())
    else:
        try:
            target.stat()
        except FileNotFoundError:
            os.rename(source.path.name, target.path.name, src_dir_fd=source.parent_fd, dst_dir_fd=target.parent_fd)
        else:
            raise FileExistsError(target.path)
        target.sync_parent()
        source.sync_parent()


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

    @contextmanager
    def entry(self, relative: str) -> Iterator[ManagedEntry]:
        folder, separator, name = relative.partition("/")
        pattern = STAGING_NAME if folder == "staging" else MEDIA_NAME if folder == "media" else None
        if not separator or pattern is None or not pattern.fullmatch(name):
            raise OSError("Invalid managed relative path")
        parent = self.root / folder
        with ExitStack() as directories:
            parent_fd = None
            if os.name == "nt":
                for directory in (self.root, parent):
                    handle = open_windows_entry(directory, directory=True)
                    directories.callback(close_windows_handle, handle)
            else:
                flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
                for directory_name in parent.parts:
                    parent_fd = os.open(directory_name, flags, dir_fd=parent_fd)
                    directories.callback(os.close, parent_fd)
            entry = ManagedEntry(parent / name, parent_fd)
            entry.check()
            yield entry

    def stage(self, relative: str, data: bytes) -> str:
        checksum = hashlib.sha256(data).hexdigest()
        with self.entry(relative) as entry:
            with entry.open_stage() as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            entry.sync_parent()
        availability, _ = self.read(relative, len(data), checksum)
        if availability != "Available":
            raise OSError("Cannot verify staged reference")
        return checksum

    def promote(self, staging: str, final: str) -> None:
        with self.entry(staging) as source, self.entry(final) as target:
            move_durable(source, target)

    def discard(self, relative: str) -> None:
        with self.entry(relative) as entry:
            entry.discard()

    def exists(self, relative: str) -> bool:
        with self.entry(relative) as entry:
            try:
                entry.stat()
            except FileNotFoundError:
                return False
            return True

    def read(
        self, relative: str, byte_length: int, checksum: str, *,
        metadata_only: bool = False, byte_limit: int = 100_000_000,
    ) -> tuple[str, bytes | None]:
        try:
            with self.entry(relative) as entry, entry.open_read() as handle:
                info = os.fstat(handle.fileno())
                if (redirected(info) or not stat.S_ISREG(info.st_mode)
                        or info.st_nlink != 1 or info.st_size != byte_length):
                    return "Corrupt", None
                if byte_length > byte_limit:
                    return "Corrupt", None
                if metadata_only:
                    digest = hashlib.sha256()
                    for chunk in iter(lambda: handle.read(128 * 1024), b""):
                        digest.update(chunk)
                    return ("Available" if digest.hexdigest() == checksum else "Corrupt"), None
                data = handle.read(byte_length + 1)
        except FileNotFoundError:
            return "Missing", None
        except OSError:
            return "Corrupt", None
        if len(data) != byte_length or hashlib.sha256(data).hexdigest() != checksum:
            return "Corrupt", None
        return "Available", data

    def read_evidence(
        self, relative: str, byte_length: int, checksum: str, width: int, height: int,
    ) -> tuple[str, bytes | None]:
        # Allow a full 16-bit RGBA raster, per-row filters, and PNG compression/chunk overhead.
        raster_bytes = (8 * width + 1) * height
        byte_limit = raster_bytes + raster_bytes // 8 + 1024**2
        if Image.MAX_IMAGE_PIXELS is not None and width * height > 2 * Image.MAX_IMAGE_PIXELS:
            byte_limit = 0
        availability, data = self.read(relative, byte_length, checksum, byte_limit=byte_limit)
        if data is None:
            return availability, None
        try:
            checked, palette = inspect_png(data, expected_size=(width, height))
            with Image.open(BytesIO(checked), formats=["PNG"]) as image:
                image.load()
                if image.getexif().get(274, 1) != 1:
                    return "Corrupt", None
                if palette:
                    extrema = image.getextrema()
                    if not extrema or not isinstance(extrema[1], int) or extrema[1] >= palette:
                        return "Corrupt", None
        except (OSError, ValueError, SyntaxError, struct.error, zlib.error, HttpError, Image.DecompressionBombError):
            return "Corrupt", None
        return "Available", data
