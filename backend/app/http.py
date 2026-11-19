from __future__ import annotations

import json
import re
from collections.abc import Collection
from dataclasses import dataclass
from secrets import compare_digest
from typing import TYPE_CHECKING, NoReturn
from urllib.parse import parse_qsl

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.requests import ClientDisconnect, HTTPConnection

from .config import Config

if TYPE_CHECKING:
    from .runtime import RecordsRuntime

API_PREFIX = "/api/v1"
BODY_LIMIT = 65_536
HEADER_LIMIT = 16_384
QUERY_LIMIT = 8_192
APP_HEADERS = ("content-type", "x-app-capability", "x-app-client-id", "x-action-created-at-ms")
RECORDS_ROUTES = {
    "/websocket-tickets": ("POST",),
    "/bootstrap": ("GET",), "/health": ("GET",), "/snapshot": ("GET",),
    "/objects": ("GET", "POST"), "/objects/{id}": ("GET",),
    "/objects/{id}/sessions": ("GET",), "/sessions/{id}": ("GET",), "/sessions/{id}/matches": ("GET",),
    "/media/{id}": ("GET",), "/settings": ("GET",),
    "/settings/retention-preview": ("POST",), "/settings/retention": ("PUT",),
}
PAGE_QUERY = frozenset({"cursor", "limit"})
LIST_QUERIES = {
    "/objects": PAGE_QUERY | {"name", "status"},
    "/objects/{id}/sessions": PAGE_QUERY,
    "/sessions/{id}/matches": PAGE_QUERY,
}
RETENTION_ROUTES = frozenset({"/settings/retention-preview", "/settings/retention"})
CLIENT_ROUTES = frozenset(LIST_QUERIES) | {"/snapshot"} | RETENTION_ROUTES
DOMAIN_ID = r"[A-Za-z0-9_-]{1,128}"
REQUEST_ID = r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"


@dataclass
class HttpError(Exception):
    status: int
    code: str
    message: str
    retryable: bool = False
    field: tuple[str, str] | None = None

    def response(self, **extra: object) -> JSONResponse:
        data: dict[str, object] = {"code": self.code, "message": self.message, "retryable": self.retryable, **extra}
        if self.field:
            path, code = self.field
            data["field_errors"] = [{"path": path, "code": code, "message": self.message}]
        return JSONResponse(data, status_code=self.status)


def header(request: HTTPConnection, name: str, status: int, code: str) -> str | None:
    values = request.headers.getlist(name)
    if len(values) > 1:
        raise HttpError(status, code, "The request contains an ambiguous header.")
    return values[0] if values else None


def route_path(request: Request) -> str:
    full_path: str = request.scope["path"]
    path = full_path.removeprefix(API_PREFIX)
    if full_path != path:
        if path in RECORDS_ROUTES:
            return path
        for route in RECORDS_ROUTES:
            if "{id}" in route and re.fullmatch(route.replace("{id}", DOMAIN_ID), path):
                return route
    return ""


def authorize_address(request: HTTPConnection, config: Config, origin_required: bool) -> None:
    host = header(request, "host", 403, "HOST_REJECTED")
    if host != config.host or "x-forwarded-host" in request.headers or "forwarded" in request.headers:
        raise HttpError(403, "HOST_REJECTED", "Use the configured local backend address.")
    origin = header(request, "origin", 403, "ORIGIN_REJECTED")
    if (origin_required or origin is not None) and origin != config.origin:
        raise HttpError(403, "ORIGIN_REJECTED", "Open the application at its configured local frontend address.")


def authorize_capability(request: Request, runtime: RecordsRuntime) -> None:
    capability = header(request, "x-app-capability", 403, "CAPABILITY_INVALID")
    if capability is None or not capability.isascii() or not compare_digest(capability, runtime.capability):
        raise HttpError(403, "CAPABILITY_INVALID", "Reconnect to the local backend to obtain current access.")


def authorize_client(request: Request, runtime: RecordsRuntime, *, required: bool) -> None:
    client = header(request, "x-app-client-id", 403, "CLIENT_INVALID")
    if (required or client is not None) and (client is None or not runtime.touch_client(client)):
        raise HttpError(403, "CLIENT_INVALID", "Reconnect to obtain a current page identity.")


def preflight(request: Request, path: str) -> Response:
    method = header(request, "access-control-request-method", 422, "VALIDATION_FAILED")
    if method is None or method not in RECORDS_ROUTES.get(path, ()):
        raise HttpError(404, "NOT_FOUND", "The requested operation is unavailable.")
    requested = header(request, "access-control-request-headers", 422, "VALIDATION_FAILED")
    names = [name.strip().lower() for name in requested.split(",")] if requested is not None else []
    if len(set(names)) != len(names) or set(names).difference(APP_HEADERS):
        raise HttpError(422, "VALIDATION_FAILED", "The preflight requested unsupported headers.")
    return Response(status_code=204, headers={
        "Access-Control-Allow-Methods": method,
        **({"Access-Control-Allow-Headers": ", ".join(names)} if names else {}),
    })


def invalid_query(code: str, path: str = "/query") -> HttpError:
    return HttpError(422, "VALIDATION_FAILED", "Use supported query fields and values.", field=(path, code))


def parse_query(raw: bytes, allowed: Collection[str]) -> dict[str, str]:
    if len(raw) > QUERY_LIMIT:
        raise HttpError(413, "PAYLOAD_TOO_LARGE", "The request query exceeds the supported size.")
    try:
        text = raw.decode("ascii")
        if re.search(r"%(?![0-9A-Fa-f]{2})", text):
            raise ValueError
        pairs = parse_qsl(text, keep_blank_values=True, strict_parsing=True, errors="strict")
    except (UnicodeError, ValueError) as exc:
        raise invalid_query("INVALID_VALUE") from exc
    parsed: dict[str, str] = {}
    for key, value in pairs:
        if key not in allowed:
            raise invalid_query("UNKNOWN_FIELD")
        if key in parsed:
            raise invalid_query("DUPLICATE_FIELD", f"/query/{key}")
        parsed[key] = value
    return parsed


def body_length(request: Request, limit: int) -> int | None:
    encoding = header(request, "content-encoding", 415, "UNSUPPORTED_MEDIA_TYPE")
    if encoding is not None and encoding.lower() != "identity":
        raise HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Compressed request bodies are unsupported.")
    length = header(request, "content-length", 422, "VALIDATION_FAILED")
    if length is not None:
        if re.fullmatch("[0-9]+", length) is None:
            raise HttpError(422, "VALIDATION_FAILED", "Use a valid request content length.")
        digits = length.lstrip("0")
        if len(digits) > len(str(limit)) or (digits and int(digits) > limit):
            raise HttpError(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the supported size.")
        return int(digits or "0")
    return None


def bad_json() -> HttpError:
    return HttpError(400, "INVALID_JSON", "Use a valid UTF-8 JSON request.")


def json_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise HttpError(422, "VALIDATION_FAILED", "Duplicate JSON fields are unsupported.",
                            field=("/", "DUPLICATE_FIELD"))
        result[key] = value
    return result


def reject_nonfinite(_: str) -> NoReturn:
    raise bad_json()


async def read_json(request: Request) -> object:
    length = body_length(request, BODY_LIMIT)
    content = header(request, "content-type", 415, "UNSUPPORTED_MEDIA_TYPE") or ""
    if not re.fullmatch(r'application/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*',
                        content, re.IGNORECASE):
        raise HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json with UTF-8 encoding.")
    raw = bytearray()
    try:
        async for chunk in request.stream():
            if len(raw) + len(chunk) > BODY_LIMIT:
                raise HttpError(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the supported size.")
            raw.extend(chunk)
        if length is not None and length != len(raw):
            raise bad_json()
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=json_fields, parse_constant=reject_nonfinite,
                          parse_int=lambda value: int(value) if len(value) <= 17 else 2**53)
        return data
    except (ValueError, RecursionError, ClientDisconnect) as exc:
        raise bad_json() from exc

async def require_empty_body(request: Request) -> None:
    length = body_length(request, BODY_LIMIT)
    size = 0
    try:
        async for chunk in request.stream():
            size += len(chunk)
            if size > BODY_LIMIT:
                raise HttpError(413, "PAYLOAD_TOO_LARGE", "The request body exceeds the supported size.")
    except ClientDisconnect as exc:
        raise HttpError(422, "VALIDATION_FAILED", "The request body was interrupted.") from exc
    if size or length:
        raise HttpError(422, "VALIDATION_FAILED", "This operation does not accept a request body.")
