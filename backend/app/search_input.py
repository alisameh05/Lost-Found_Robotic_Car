"""Strict v1 search lifecycle requests and their durable business identity."""

import re
from dataclasses import dataclass
from hashlib import sha256
from typing import Literal, cast

from fastapi import Request

from .control import counter, domain_id, token
from .http import REQUEST_ID, HttpError, header, read_json
from .registration_input import canonical_json

Mode = Literal["Gestures", "Controller"]


@dataclass(frozen=True, repr=False)
class SearchRequest:
    action_id: str
    action: str
    resource_id: str
    revision: int
    client: str
    secret: str
    mode: Mode | None
    failure_ids: tuple[str, ...] = ()

    @property
    def safety_action(self) -> bool:
        return self.action in ("pause", "stop")

    def fingerprint(self) -> str:
        payload: dict[str, object] = {}
        if self.mode:
            payload["control_mode"] = self.mode
        if self.failure_ids:
            payload["failure_ids"] = self.failure_ids
        return sha256(canonical_json({
            "scope": "Object", "action_type": self.action, "resource_id": self.resource_id,
            "expected_revision": self.revision, "payload": payload,
        }).encode()).hexdigest()


def request_id(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(REQUEST_ID, value) is not None


def check_identity(request: Request, client: str | None) -> None:
    offered = header(request, "x-app-client-id", 403, "CLIENT_INVALID")
    if client is not None and offered is not None and offered != client:
        raise HttpError(422, "VALIDATION_FAILED", "The header and body client IDs must match.")


async def parse_search(request: Request, session: str | None) -> SearchRequest:
    data = await read_json(request)
    invalid = HttpError(422, "VALIDATION_FAILED", "Provide a valid search action and resource identity.")
    fields = {"action_id", "expected_revision", "client_id", "client_lease_id"}
    if not isinstance(data, dict):
        raise invalid
    mode: Mode | None = None
    failure_ids: tuple[str, ...] = ()
    if session is None:
        fields |= {"object_id", "control_mode"}
        resource = data.get("object_id")
        action = "start"
        mode = data.get("control_mode")
        if mode not in ("Gestures", "Controller"):
            raise invalid
    else:
        fields |= {"session_id", "action"}
        resource = data.get("session_id")
        action = data.get("action", "")
        if resource != session:
            raise invalid
        if action in ("confirm", "reject"):
            if not domain_id(data.get("candidate_id")):
                raise invalid
            fields.add("candidate_id")
        elif action == "acknowledge":
            ids = data.get("failure_ids")
            if (not isinstance(ids, list) or not 1 <= len(ids) <= 64
                    or not all(domain_id(item) for item in ids) or len(set(ids)) != len(ids)):
                raise invalid
            failure_ids = tuple(sorted(ids))
            fields.add("failure_ids")
        elif action not in ("pause", "stop", "resume"):
            raise invalid
    if (data.keys() != fields or not domain_id(resource) or not request_id(data.get("action_id"))
            or not counter(data.get("expected_revision")) or not domain_id(data.get("client_id"))
            or not token(data.get("client_lease_id"))):
        raise invalid
    check_identity(request, data["client_id"])
    if action in ("confirm", "reject"):
        raise HttpError(503, "NOT_READY", "This search action is unavailable in the simulation.")
    return SearchRequest(data["action_id"], action, cast(str, resource), data["expected_revision"],
                         data["client_id"], data["client_lease_id"], mode, failure_ids)


async def parse_emergency(request: Request) -> tuple[str, str | None]:
    data = await read_json(request)
    if (not isinstance(data, dict) or data.keys() - {"request_id", "client_id"}
            or not request_id(data.get("request_id"))
            or ("client_id" in data and not domain_id(data["client_id"]))):
        raise HttpError(422, "VALIDATION_FAILED", "Provide a valid Emergency Stop request.")
    client = data.get("client_id")
    check_identity(request, client)
    return data["request_id"], client
