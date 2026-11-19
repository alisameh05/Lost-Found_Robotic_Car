"""Shared persistence outcomes for the bounded records writer."""

import json
from dataclasses import dataclass

from .http import HttpError
from .registration_input import canonical_json
from .storage import Receipt

MAX_ORDINARY_PENDING = 62
MAX_TERMINAL = 64


@dataclass(frozen=True)
class Operation:
    fingerprint: str
    response: Receipt
    owner: str | None = None
    retention_client: str | None = None
    request_id: str | None = None
    slot: str = "ordinary"

    def payload(self) -> dict[str, object]:
        data: dict[str, object] = json.loads(self.response.body)
        return {**data, "request_id": self.request_id, "action_id": None if self.request_id else data["action_id"]}


def mutation(action_id: str, persistence: str, status: int, error: HttpError | None = None) -> Receipt:
    return Receipt(canonical_json({
        "action_id": action_id, "persistence": persistence, "result": None,
        "error": json.loads(bytes(error.response().body)) if error else None,
    }), status, None)
