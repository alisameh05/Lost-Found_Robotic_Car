import hashlib
import json
import re
import unicodedata
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import NoReturn, TypedDict

from fastapi import Request
from starlette.requests import ClientDisconnect

from .http import BODY_LIMIT, HEADER_LIMIT, HttpError, body_length, header

MULTIPART_LIMIT = 11 * 1024**2
IMAGE_LIMIT = 10 * 1024**2
SAFE_INTEGER = 9_007_199_254_740_991
WHITE_SPACE = (
    "\t\n\v\f\r \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000"
)
FIELDS = {"action_id", "name", "reference_image", "roi"}
RECT_FIELDS = ("x", "y", "width", "height")
BOUNDARY = r"[0-9A-Za-z'()+_,./:=? -]{1,70}"
DISPOSITION = re.compile(
    rb'form-data[ \t]*;[ \t]*name="([a-z_]+)"'
    rb'(?:[ \t]*;[ \t]*filename="(?:[^"\\\x00-\x1f\x7f]|\\[\x20-\x7e])*")?[ \t]*',
    re.IGNORECASE,
)


def canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalize_name(value: str) -> str:
    return unicodedata.normalize("NFC", value.strip(WHITE_SPACE))


class Rect(TypedDict):
    x: int
    y: int
    width: int
    height: int


@dataclass(frozen=True)
class Registration:
    action_id: str
    submitted_at: int
    name: str
    roi: Rect
    image: bytes

    def fingerprint(self) -> str:
        intent = {
            "scope": "Object", "action_type": "register", "resource_id": None, "expected_revision": None,
            "payload": {
                "name": self.name, "roi": self.roi, "source_image_sha256": hashlib.sha256(self.image).hexdigest(),
                "submitted_at_ms": self.submitted_at,
            },
        }
        return hashlib.sha256(canonical_json(intent).encode()).hexdigest()


def invalid(field: str, message: str, code: str = "INVALID_VALUE") -> HttpError:
    return HttpError(422, "VALIDATION_FAILED", message, field=(field, code))


def malformed() -> HttpError:
    return HttpError(400, "INVALID_MULTIPART", "Send exactly one action ID, name, reference image and target.")


def oversized() -> HttpError:
    return HttpError(413, "PAYLOAD_TOO_LARGE", "The registration upload exceeds the supported size.")


class Multipart:
    """Read one bounded part at a time, retaining only possible split delimiters."""

    def __init__(self, chunks: AsyncIterator[bytes], boundary: bytes, expected: int | None):
        self.chunks = chunks
        self.delimiter = b"\r\n--" + boundary
        self.expected = expected
        self.total = 0
        self.buffer = bytearray(b"\r\n")

    async def pull(self) -> bool:
        chunk = await anext(self.chunks, b"")
        self.total += len(chunk)
        if self.total > MULTIPART_LIMIT:
            raise oversized()
        self.buffer.extend(chunk)
        return bool(chunk)

    async def fill(self, size: int) -> None:
        while len(self.buffer) < size:
            if not await self.pull():
                raise malformed()

    async def boundary(self) -> bool:
        size = len(self.delimiter) + 2
        await self.fill(size)
        if not self.buffer.startswith(self.delimiter):
            raise malformed()
        suffix = self.buffer[size - 2:size]
        del self.buffer[:size]
        if suffix == b"\r\n":
            return False
        if suffix != b"--":
            raise malformed()
        while len(self.buffer) <= 2 and await self.pull():
            pass
        if (self.buffer and self.buffer != b"\r\n") or (self.expected is not None and self.total != self.expected):
            raise malformed()
        return True

    async def part_name(self) -> str:
        while (end := self.buffer.find(b"\r\n\r\n")) < 0:
            if len(self.buffer) > HEADER_LIMIT or not await self.pull():
                raise malformed()
        if end > HEADER_LIMIT:
            raise malformed()
        headers: dict[bytes, bytes] = {}
        for line in bytes(self.buffer[:end]).split(b"\r\n"):
            key, colon, value = line.partition(b":")
            key = key.lower()
            if not colon or key in headers or key not in (b"content-disposition", b"content-type"):
                raise malformed()
            if re.search(rb"[\x00-\x08\x0a-\x1f\x7f]", value):
                raise malformed()
            headers[key] = value.strip()
        del self.buffer[:end + 4]
        value = headers.get(b"content-disposition", b"")
        match = DISPOSITION.fullmatch(value)
        if not match:
            raise malformed()
        name = match[1].decode("ascii")
        if name not in FIELDS or (name != "reference_image" and b";" in value[match.end(1):]):
            raise malformed()
        content_type = headers.get(b"content-type")
        if name != "reference_image" and content_type is not None and not re.fullmatch(
            rb'text/plain(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?', content_type, re.IGNORECASE,
        ):
            raise HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Registration text fields must use UTF-8.")
        return name

    async def part(self, limit: int) -> bytes:
        data = bytearray()
        tail = len(self.delimiter) + 3
        boundary = re.compile(re.escape(self.delimiter) + rb"(?=\r\n|--\r\n)")
        while True:
            match = boundary.search(self.buffer)
            end = match.start() if match else max(0, len(self.buffer) - tail)
            if len(data) + end > limit:
                raise oversized()
            data.extend(self.buffer[:end])
            del self.buffer[:end]
            if match:
                return bytes(data)
            if not await self.pull():
                closing = self.delimiter + b"--"
                if self.buffer.endswith(closing):
                    end = len(self.buffer) - len(closing)
                    if len(data) + end > limit:
                        raise oversized()
                    data.extend(self.buffer[:end])
                    del self.buffer[:end]
                    return bytes(data)
                if len(data) + len(self.buffer) > limit:
                    raise oversized()
                raise malformed()


def text_field(parts: dict[str, bytes], name: str) -> str:
    try:
        return parts[name].decode("utf-8")
    except UnicodeError as exc:
        raise invalid(f"/{name}", "Use valid UTF-8 text.") from exc


def parse_roi(raw: str) -> Rect:
    def fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in pairs:
            if key in result:
                raise invalid("/roi", "Target coordinates must occur once.", "DUPLICATE_FIELD")
            result[key] = value
        return result

    def nonfinite(_: str) -> NoReturn:
        raise invalid("/roi", "Use finite integer target coordinates.", "INVALID_TYPE")

    def integer(value: str) -> int:
        return int(value) if len(value) <= 17 else SAFE_INTEGER + 1

    try:
        data = json.loads(raw, object_pairs_hook=fields, parse_constant=nonfinite, parse_int=integer)
    except (ValueError, RecursionError) as exc:
        raise HttpError(400, "INVALID_JSON", "The target rectangle must be valid JSON.") from exc
    if not isinstance(data, dict):
        raise invalid("/roi", "Use an object with four target coordinates.", "INVALID_TYPE")
    if data.keys() - set(RECT_FIELDS):
        raise invalid("/roi", "Use only supported target coordinates.", "UNKNOWN_FIELD")
    checked: dict[str, int] = {}
    for key in RECT_FIELDS:
        if key not in data:
            raise invalid(f"/roi/{key}", "Enter this target coordinate.", "REQUIRED")
        value = data[key]
        if type(value) is not int:
            raise invalid(f"/roi/{key}", "Use a whole number of pixels.", "INVALID_TYPE")
        if not int(key in ("width", "height")) <= value <= SAFE_INTEGER:
            raise invalid(f"/roi/{key}", "The target coordinate is outside the supported range.", "OUT_OF_RANGE")
        checked[key] = value
    return Rect(x=checked["x"], y=checked["y"], width=checked["width"], height=checked["height"])


async def parse_registration(request: Request) -> Registration:
    length = body_length(request, MULTIPART_LIMIT)
    content = header(request, "content-type", 415, "UNSUPPORTED_MEDIA_TYPE") or ""
    if content.partition(";")[0].strip().lower() != "multipart/form-data":
        raise HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use multipart form data to register an object.")
    match = re.fullmatch(rf'multipart/form-data[ \t]*;[ \t]*boundary=(?:"({BOUNDARY})"|({BOUNDARY}))[ \t]*',
                         content, re.IGNORECASE)
    boundary = (match[1] or match[2]) if match else ""
    if not boundary or boundary.endswith(" ") or (match and not match[1] and " " in boundary):
        raise malformed()
    parser = Multipart(request.stream(), boundary.encode("ascii"), length)
    parts: dict[str, bytes] = {}
    text_size = 0
    try:
        while not await parser.boundary():
            name = await parser.part_name()
            if name in parts:
                raise malformed()
            parts[name] = await parser.part(IMAGE_LIMIT if name == "reference_image" else BODY_LIMIT - text_size)
            if name != "reference_image":
                text_size += len(parts[name])
    except ClientDisconnect as exc:
        raise malformed() from exc
    if parts.keys() != FIELDS:
        raise malformed()
    action_id = text_field(parts, "action_id")
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", action_id):
        raise invalid("/action_id", "Use a lowercase UUIDv4 action ID.")
    name = normalize_name(text_field(parts, "name"))
    if not 1 <= len(name) <= 120 or "\0" in name:
        raise invalid("/name", "Enter an object name with 1 to 120 characters.", "OUT_OF_RANGE")
    submitted = header(request, "x-action-created-at-ms", 422, "VALIDATION_FAILED") or ""
    if not re.fullmatch(r"0|[1-9][0-9]{0,15}", submitted) or int(submitted) > SAFE_INTEGER:
        raise invalid("/headers/x-action-created-at-ms", "Use a canonical submission time in milliseconds.")
    return Registration(action_id, int(submitted), name, parse_roi(text_field(parts, "roi")), parts["reference_image"])
