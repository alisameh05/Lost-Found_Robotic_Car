"""Bounded, authenticated local HTTP transport and ESP32-CAM acquisition clock, v1."""

import asyncio
import math
import re
import socket
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from secrets import token_hex

from PIL import Image

from .registration_input import SAFE_INTEGER
from .simulation import Capture, QualificationProfile, dimensions_allowed, read_sample

VERSION = 1
CLOCK = "/laf/camera/v1/clock"
FRAME = "/laf/camera/v1/frame"
MAX_HEADER = 4096
MAX_JPEG = 64 * 1024
MAX_EPOCHS = 128
RELATIVE_DRIFT_PPM = 1000
HEX_ID = re.compile(r"[0-9a-f]{32}")
TOKEN = re.compile(r"[0-9a-f]{64}")
HEADER_NAME = re.compile(rb"[A-Za-z0-9-]+")


class CameraFault(ValueError):
    def __init__(self, detail: str, *, incompatible: bool = False, epoch_changed: bool = False,
                 discard: bool = False):
        super().__init__(detail)
        self.incompatible = incompatible
        self.epoch_changed = epoch_changed
        self.discard = discard


@dataclass(frozen=True)
class Reply:
    body: bytes
    received: float


ReadBody = Callable[[int, Mapping[str, str], int], int]
Exchange = Callable[[str, Mapping[str, str], ReadBody, float], Awaitable[Reply]]


def parse_headers(raw: bytes) -> tuple[int, dict[str, str]]:
    status, *lines = raw[:-4].split(b"\r\n")
    match = re.fullmatch(rb"HTTP/1\.[01] ([1-5][0-9]{2})(?: [ -~]*)?", status)
    if match is None:
        raise CameraFault("Invalid HTTP response")
    fields: dict[str, str] = {}
    for line in lines:
        name, separator, value = line.partition(b":")
        key = name.decode("ascii", errors="replace").lower()
        if (not HEADER_NAME.fullmatch(name) or key in fields or not separator
                or any(byte < 32 or byte > 126 for byte in value)):
            raise CameraFault("Invalid camera response header")
        fields[key] = value.decode("ascii").strip(" ")
    if "transfer-encoding" in fields or "content-encoding" in fields:
        raise CameraFault("Camera requires an unencoded, length-delimited response")
    return int(match[1]), fields


def open_http_exchange(address: str, port: int, token: str, header_limit: int,
                       monotonic: Callable[[], float]) -> Exchange:
    """Only the selected literal address is used. No redirects, DNS, proxies, or implicit credentials."""
    limit = min(MAX_HEADER, header_limit)

    async def exchange(path: str, headers: Mapping[str, str], read_body: ReadBody, timeout: float) -> Reply:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as peer:
                peer.setblocking(False)
                loop = asyncio.get_running_loop()
                async with asyncio.timeout(timeout):
                    await loop.sock_connect(peer, (address, port))
                    request = [f"GET {path} HTTP/1.1", f"Host: {address}:{port}", "Connection: close",
                               f"Authorization: Bearer {token}", *(f"{k}: {v}" for k, v in headers.items()), "", ""]
                    await loop.sock_sendall(peer, "\r\n".join(request).encode("ascii"))
                    buffered = bytearray()
                    while (separator := buffered.find(b"\r\n\r\n")) == -1:
                        if len(buffered) == limit:
                            raise CameraFault("Camera response header exceeds its bound")
                        chunk = await loop.sock_recv(peer, min(512, limit - len(buffered)))
                        if not chunk:
                            raise CameraFault("Camera response header is incomplete")
                        buffered.extend(chunk)
                    header_bytes = separator + 4
                    status, fields = parse_headers(bytes(buffered[:header_bytes]))
                    size = read_body(status, fields, header_bytes)
                    pending = len(buffered) - header_bytes
                    if pending > size:
                        raise CameraFault("Camera response exceeds its declared size")
                    body = bytearray(size)
                    body[:pending] = buffered[header_bytes:]
                    while pending < size:
                        count = await loop.sock_recv_into(peer, memoryview(body)[pending:])
                        if not count:
                            raise CameraFault("Camera response was incomplete")
                        pending += count
                    return Reply(bytes(body), monotonic())
        except (OSError, TimeoutError) as error:
            raise CameraFault("The selected camera response was unavailable or over budget") from error

    return exchange


def unsigned(value: str, *, minimum: int = 0, maximum: int = SAFE_INTEGER) -> int:
    if not re.fullmatch(r"0|[1-9][0-9]{0,15}", value) or not minimum <= int(value) <= maximum:
        raise CameraFault("Invalid camera integer")
    return int(value)


def protocol_fields(status: int, headers: Mapping[str, str], field: str, count: int) -> list[str]:
    if status != 200:
        raise CameraFault("Camera request failed", incompatible=status in (401, 403, 404, 405))
    values = headers.get(field, "").split(" ")
    if len(values) != count or values[0] != str(VERSION):
        raise CameraFault("Camera protocol version or response shape is unsupported", incompatible=True)
    return values[1:]


def drift_us(interval: int) -> int:
    return (interval * RELATIVE_DRIFT_PPM + 999_999) // 1_000_000 + 2


@dataclass(frozen=True)
class ClockEstimate:
    received_us: int
    camera_rx_us: int
    camera_tx_us: int
    offset_low_us: int
    offset_high_us: int

    def age_ms(self, source_us: int, observed_us: int, profile: QualificationProfile) -> int:
        if not 0 <= observed_us - self.received_us < profile.bound("camera_sync_interval_ms") * 1000:
            raise CameraFault("Camera clock synchronization expired")
        drift = drift_us(max(abs(source_us - self.camera_rx_us), abs(source_us - self.camera_tx_us)))
        low, high = self.offset_low_us - drift, self.offset_high_us + drift
        age = observed_us - (source_us + low)
        if high - low > profile.bound("clock_uncertainty_limit_us") or age < 0:
            raise CameraFault("Camera capture time cannot be bounded")
        age_ms = (age + 999) // 1000
        if age_ms >= profile.bound("capture_age_limit_ms"):
            raise CameraFault("Camera acquisition is too old")
        return age_ms


class CameraLink:
    def __init__(self, profile: QualificationProfile, build_id: str, exchange: Exchange,
                 monotonic: Callable[[], float]):
        self.profile = profile
        self.build_id = build_id
        self.exchange = exchange
        self.monotonic = monotonic
        self.estimate: ClockEstimate | None = None
        self.epoch: tuple[str, str] | None = None
        self.retired: set[tuple[str, str]] = set()
        self.last_sequence = 0
        self.last_source_us = -1

    def check_identity(self, build: str, boot: str, stream: str) -> tuple[str, str]:
        if build != self.build_id or not all(HEX_ID.fullmatch(value) for value in (boot, stream)):
            raise CameraFault("Camera build or epoch does not match the contract", incompatible=True)
        return (boot, stream)

    def sync_due(self) -> bool:
        return self.monotonic() >= self.clock_deadline - self.profile.bound("camera_sync_interval_ms") / 2000

    @property
    def clock_deadline(self) -> float:
        if self.estimate is None:
            return -math.inf
        return (self.estimate.received_us + self.profile.bound("camera_sync_interval_ms") * 1000) / 1_000_000

    async def synchronize(self) -> bool:
        request = token_hex(16)
        expected_epoch = "".join(self.epoch) if self.epoch is not None else "0"
        limit = self.profile.bound("camera_sync_max_rtt_us")
        clock: tuple[tuple[str, str], int, int] | None = None

        def read_body(status: int, headers: Mapping[str, str], _: int) -> int:
            nonlocal clock
            echo, echo_epoch, build, boot, stream, camera_rx, camera_tx = protocol_fields(status, headers, "x-laf-clock", 8)
            if echo != request or echo_epoch != expected_epoch or headers.get("content-length") != "0":
                raise CameraFault("Camera clock response does not match its request")
            clock = (self.check_identity(build, boot, stream), unsigned(camera_rx), unsigned(camera_tx))
            return 0

        sent_us = math.floor(self.monotonic() * 1_000_000)
        try:
            reply = await self.exchange(CLOCK, {"X-LAF-Request": request, "X-LAF-Epoch": expected_epoch},
                                        read_body, limit / 1_000_000)
        except CameraFault:
            self.estimate = None
            raise
        if clock is None:
            self.estimate = None
            raise CameraFault("Camera clock response is absent")
        epoch, rx_us, tx_us = clock
        received_us = math.ceil(reply.received * 1_000_000)
        rtt = received_us - sent_us
        processing = tx_us - rx_us
        guard = drift_us(rtt)
        low, high = sent_us - rx_us - guard, received_us - tx_us + guard
        if (not 0 < rtt <= limit or not 0 <= processing <= rtt + guard or high < low
                or high - low > self.profile.bound("clock_uncertainty_limit_us")):
            self.estimate = None
            raise CameraFault("Camera clock round trip or uncertainty exceeds its bound")
        changed = self.epoch is not None and self.epoch != epoch
        if epoch in self.retired or (changed and len(self.retired) >= MAX_EPOCHS):
            self.estimate = None
            raise CameraFault("Camera epoch is retired or epoch capacity was reached")
        if self.epoch is not None and changed:
            self.retired.add(self.epoch)
            self.last_sequence, self.last_source_us = 0, -1
        self.epoch = epoch
        self.estimate = ClockEstimate(received_us, rx_us, tx_us, low, high)
        return changed

    async def capture(self) -> Capture:
        estimate, epoch = self.estimate, self.epoch
        if estimate is None or epoch is None:
            raise CameraFault("Camera clock is not synchronized")
        age_limit = self.profile.bound("capture_age_limit_ms")
        metadata: tuple[int, int, int, int] | None = None

        def read_body(status: int, headers: Mapping[str, str], header_bytes: int) -> int:
            nonlocal metadata
            build, boot, stream, seq, ts, width, height = protocol_fields(status, headers, "x-laf-frame", 8)
            received_epoch = self.check_identity(build, boot, stream)
            if received_epoch != epoch:
                if received_epoch in self.retired:
                    raise CameraFault("Camera frame belongs to a retired epoch", discard=True)
                self.estimate = None
                raise CameraFault("Camera epoch changed", epoch_changed=True)
            sequence, source_us, w, h = unsigned(seq, minimum=1), unsigned(ts), unsigned(width), unsigned(height)
            if sequence <= self.last_sequence or source_us <= self.last_source_us:
                raise CameraFault("Camera acquisition did not advance", discard=True)
            size = unsigned(headers.get("content-length", ""), minimum=1, maximum=MAX_JPEG)
            if (headers.get("content-type") != "image/jpeg" or not dimensions_allowed(self.profile, w, h)
                    or size + header_bytes > self.profile.bound("max_frame_bytes")):
                raise CameraFault("Camera JPEG exceeds its declared bounds")
            metadata = (sequence, source_us, w, h)
            return size

        reply = await self.exchange(FRAME, {}, read_body, age_limit / 1000)
        if metadata is None:
            raise CameraFault("Camera frame response is absent")
        sequence, source_us, w, h = metadata
        age = estimate.age_ms(source_us, math.ceil(reply.received * 1_000_000), self.profile)
        try:
            await asyncio.to_thread(read_sample, reply.body, self.profile, (w, h))
        except (OSError, ValueError, Image.DecompressionBombError) as error:
            raise CameraFault("Invalid camera JPEG") from error
        if self.monotonic() >= self.clock_deadline:
            raise CameraFault("Camera clock synchronization expired during decode")
        self.last_sequence, self.last_source_us = sequence, source_us
        return Capture(epoch[1], epoch[0], sequence, source_us, reply.received, age, w, h, reply.body)
