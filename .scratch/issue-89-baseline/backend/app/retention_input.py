import hashlib
import re
from dataclasses import dataclass

from fastapi import Request

from .http import DOMAIN_ID, REQUEST_ID, HttpError, read_json
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


def invalid(path: str, code: str) -> HttpError:
    return HttpError(422, "VALIDATION_FAILED", "Use the required retention request fields and values.",
                     field=(path, code))


async def parse_retention(request: Request, *, commit: bool) -> tuple[RetentionProposal, RetentionChange | None]:
    data = await read_json(request)

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
