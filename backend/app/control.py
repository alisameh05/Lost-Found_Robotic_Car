"""Strict v1 input and boot-local state for the controlling workspace."""

import re
from dataclasses import dataclass
from hashlib import sha256

from fastapi import Request

from .http import DOMAIN_ID, REQUEST_ID, HttpError, header, read_json
from .registration_input import SAFE_INTEGER, canonical_json

TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
MAX_RUNTIME_RECEIPTS = 8192
MAX_ISSUED_FRAMES = 128


def domain_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(DOMAIN_ID, value) is not None


def token(value: object) -> bool:
    return isinstance(value, str) and TOKEN.fullmatch(value) is not None


def counter(value: object) -> bool:
    return type(value) is int and 1 <= value <= SAFE_INTEGER


@dataclass(frozen=True, repr=False)
class LeaseRequest:
    request_id: str
    client: str
    session: str | None
    takeover: bool = False
    secret: str | None = None
    generation: int | None = None

    def fingerprint(self) -> bytes:
        return sha256(canonical_json(
            [self.client, self.session, self.takeover, self.secret, self.generation]
        ).encode("utf-8")).digest()


async def parse_lease(request: Request, *, release: bool) -> LeaseRequest:
    data = await read_json(request)
    keys = {"request_id", "client_id", "session_id"}
    keys |= {"client_lease_id", "control_generation"} if release else {"takeover"}
    invalid = HttpError(422, "VALIDATION_FAILED", "Provide a valid control lease request.")
    if not isinstance(data, dict) or data.keys() != keys:
        raise invalid
    ident, client, session = data["request_id"], data["client_id"], data["session_id"]
    if (not isinstance(ident, str) or re.fullmatch(REQUEST_ID, ident) is None
            or not domain_id(client) or (session is not None and not domain_id(session))):
        raise invalid
    offered = header(request, "x-app-client-id", 403, "CLIENT_INVALID")
    if offered is not None and offered != client:
        raise HttpError(422, "VALIDATION_FAILED", "The header and body client IDs must match.")
    if release:
        secret, generation = data["client_lease_id"], data["control_generation"]
        if not token(secret) or not counter(generation):
            raise invalid
        return LeaseRequest(ident, client, session, secret=secret, generation=generation)
    if type(data["takeover"]) is not bool:
        raise invalid
    return LeaseRequest(ident, client, session, takeover=data["takeover"])


@dataclass(repr=False)
class Lease:
    client: str
    session: str | None
    secret: str
    heartbeat_deadline: float
    display_deadline: float
    heartbeat_seq: int = 0
    workspace: bool = False
    displayed: bool = False


@dataclass(frozen=True)
class Revocation:
    client: str
    session: str | None
    generation: int
    reason: str
    request_id: str | None


@dataclass(frozen=True, repr=False)
class LeaseReceipt:
    fingerprint: bytes
    generation: int
    owner: str | None
    secret: str | None
    can_acquire: bool = False

    def outcome(self, request_id: str, snapshot: dict[str, object]) -> dict[str, object]:
        return {
            "request_id": request_id, "client_lease_id": self.secret, "control_generation": self.generation,
            "lease": public_lease(self.owner, self.generation, self.can_acquire), "snapshot": snapshot,
        }


def public_lease(owner: str | None, generation: int, can_acquire: bool) -> dict[str, object]:
    return {"state": "Unowned" if owner is None else "Owned", "owner_client_id": owner,
            "control_generation": generation, "can_acquire": owner is None and can_acquire}


HEARTBEAT_FIELDS = {
    "type", "protocol_version", "backend_boot_id", "client_id", "client_lease_id", "session_id", "control_generation",
    "heartbeat_seq", "workspace_visible", "workspace_focused", "workspace_operational", "displayed_robot_frame",
}
WORKSPACE_FLAGS = ("workspace_visible", "workspace_focused", "workspace_operational")


class ReleaseCapacityReached(HttpError):
    """The authority was revoked even though the boot receipt store was full."""
