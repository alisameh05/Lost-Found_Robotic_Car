import hashlib
import json
import re
from dataclasses import dataclass
from typing import NoReturn

from fastapi import Request
from starlette.requests import ClientDisconnect

from .http import BODY_LIMIT, DOMAIN_ID, REQUEST_ID, HttpError, body_length, header
from .registration_input import SAFE_INTEGER, canonical_json


@dataclass(frozen=True)
class RetentionProposal:
    expected_revision: int
    retention_days: int


@dataclass(frozen=True)
class RetentionChange:
    proposal: RetentionProposal
    action_id: str
    preview_id: str

    def canonical_request(self) -> str:
        return canonical_json({
            "scope": "Settings", "action_type": "retention", "resource_id": None,
            "expected_revision": self.proposal.expected_revision,
            "payload": {"retention_days": self.proposal.retention_days, "preview_id": self.preview_id, "confirmed": True},
        })

    def fingerprint(self) -> str:
        return hashlib.sha256(self.canonical_request().encode()).hexdigest()


def bad_json() -> HttpError:
    return HttpError(400, "INVALID_JSON", "Use a valid UTF-8 JSON request.")


def invalid(path: str, code: str) -> HttpError:
    return HttpError(422, "VALIDATION_FAILED", "Use the required retention request fields and values.",
                     field=(path, code))


def fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise invalid("/", "DUPLICATE_FIELD")
        result[key] = value
    return result


def reject_nonfinite(_: str) -> NoReturn:
    raise bad_json()


async def parse_retention(request: Request, *, commit: bool) -> tuple[RetentionProposal, RetentionChange | None]:
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
        data = json.loads(raw.decode("utf-8"), object_pairs_hook=fields, parse_constant=reject_nonfinite,
                          parse_int=lambda value: int(value) if len(value) <= 17 else SAFE_INTEGER + 1)
    except (ValueError, RecursionError, ClientDisconnect) as exc:
        raise bad_json() from exc

    required = {"expected_revision", "retention_days"}
    if commit:
        required |= {"action_id", "preview_id", "confirmed"}
    if not isinstance(data, dict):
        raise invalid("/", "INVALID_TYPE")
    if data.keys() - required:
        raise invalid("/", "UNKNOWN_FIELD")
    if required - data.keys():
        raise invalid("/" + min(required - data.keys()), "REQUIRED")
    revision, days = data["expected_revision"], data["retention_days"]
    for name, value, upper in (("expected_revision", revision, SAFE_INTEGER), ("retention_days", days, 30)):
        if type(value) is not int:
            raise invalid("/" + name, "INVALID_TYPE")
        if not 1 <= value <= upper:
            raise invalid("/" + name, "OUT_OF_RANGE")
    proposal = RetentionProposal(revision, days)
    if not commit:
        return proposal, None
    action, preview = data["action_id"], data["preview_id"]
    for name, value, pattern in (("action_id", action, REQUEST_ID), ("preview_id", preview, DOMAIN_ID)):
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise invalid("/" + name, "INVALID_VALUE")
    if data["confirmed"] is not True:
        raise invalid("/confirmed", "INVALID_VALUE")
    return proposal, RetentionChange(proposal, action, preview)
