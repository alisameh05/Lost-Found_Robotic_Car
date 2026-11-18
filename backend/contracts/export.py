import argparse
import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from backend.app.http import APP_HEADERS, BODY_LIMIT, RECORDS_ROUTES

DIRECTORY = Path(__file__).with_name("v1")
PROTOCOL = "laf.v1"
CLIENT_HEADER = "X-App-Client-Id"
VERSION = "1.1"

# method, path, request definition, success definition, statuses, client header
HTTP = (
    ("get", "/bootstrap", None, "BootstrapResponse", (200,), False),
    ("post", "/websocket-tickets", "TicketRequest", "TicketResponse", (200,), False),
    ("post", "/control-lease", "LeaseAcquire", "LeaseResponse", (200,), False),
    ("post", "/control-lease/release", "LeaseRelease", "LeaseResponse", (200, 202), False),
    ("get", "/health", None, "Health", (200, 503), False),
    ("get", "/snapshot", None, "Snapshot", (200,), True),
    ("get", "/objects", None, "ObjectPage", (200,), True),
    ("post", "/objects", "RegistrationFields", "MutationResponse", (201, 202), True),
    ("get", "/objects/{id}", None, "Object", (200,), False),
    ("get", "/objects/{id}/sessions", None, "SessionPage", (200,), True),
    ("post", "/sessions", "StartRequest", "MutationResponse", (201, 202), False),
    ("get", "/sessions/{id}", None, "Session", (200,), False),
    ("get", "/sessions/{id}/matches", None, "MatchPage", (200,), True),
    ("post", "/sessions/{id}/actions", "SessionAction", "MutationResponse", (200, 202), False),
    ("post", "/emergency-stop", "EmergencyStopRequest", "EmergencyStopResponse", (200, 202, 503), False),
    ("get", "/settings", None, "Settings", (200,), False),
    ("post", "/settings/retention-preview", "RetentionPreviewRequest", "RetentionPreview", (200,), True),
    ("put", "/settings/retention", "RetentionChange", "MutationResponse", (200, 202), True),
    ("get", "/media/{id}", None, None, (200,), False),
)


def component(name: str) -> dict[str, str]:
    return {"$ref": f"#/components/schemas/{name}"}


def external(name: str) -> dict[str, str]:
    return {"$ref": f"./schemas.json#/$defs/{name}"}


def parameter(name: str, location: str, schema: Mapping[str, object], required: bool = False) -> dict[str, object]:
    return {"name": name, "in": location, "required": required, "schema": dict(schema)}


def json_content(name: str) -> dict[str, object]:
    return {"application/json": {"schema": component(name)}}


def responses(path: str, result: str | None, statuses: tuple[int, ...]) -> dict[str, object]:
    no_store = {"Cache-Control": {"schema": {"const": "no-store"}}}
    definitions: dict[str, object] = {"default": {
        "description": "API failure", "content": json_content("Error"), "headers": no_store,
    }}
    for status in statuses:
        content: dict[str, object]
        if result is None:
            content = {media: {"schema": {"type": "string", "format": "binary"}}
                       for media in ("image/png", "image/jpeg")}
        elif status == 503:
            content = {"application/json": {"schema": {"oneOf": [component(result), component("Error")]}}}
        else:
            content = json_content(result)
        response: dict[str, object] = {
            "description": {200: "Success", 201: "Created", 202: "Persistence pending", 503: "Diagnostics"}[status],
            "content": content, "headers": no_store,
        }
        if status == 201:
            response["headers"] = {
                **no_store, "Location": {"schema": {"type": "string"}},
            }
        if path == "/media/{id}":
            response["headers"] = {
                **no_store,
                "X-Content-Type-Options": {"schema": {"const": "nosniff"}},
                "Accept-Ranges": {"schema": {"const": "none"}},
            }
        definitions[str(status)] = response
    return definitions


def operation(
    method: str, path: str, body: str | None, result: str | None, statuses: tuple[int, ...],
    client_header: bool, definitions: dict[str, Any],
) -> dict[str, object]:
    identifier = {key: definitions["Id"][key] for key in ("type", "minLength", "maxLength", "pattern")}
    parameters = [parameter("Origin", "header", {"type": "string"}, required=path == "/bootstrap")]
    if "{id}" in path:
        parameters.append(parameter("id", "path", identifier, True))
    if client_header:
        parameters.append(parameter(CLIENT_HEADER, "header", identifier, True))
    if result in ("ObjectPage", "SessionPage", "MatchPage"):
        parameters.extend([
            parameter("limit", "query", {"type": "integer", "minimum": 1, "maximum": 100, "default": 25}),
            parameter("cursor", "query", {"type": "string", "pattern": definitions["Token"]["pattern"]}),
        ])
    if result == "ObjectPage":
        parameters.extend([
            parameter("name", "query", {
                "type": "string",
                "description": "At most 120 code points after trimming Unicode whitespace and normalizing to NFC.",
            }),
            parameter("status", "query", {"enum": ["Lost", "Found"]}),
        ])

    item: dict[str, object] = {
        "parameters": parameters, "responses": responses(path, result, statuses),
        "security": [] if path == "/bootstrap" else [{"Capability": []}],
        "x-laf-records-runtime": method.upper() in RECORDS_ROUTES.get(path, ()),
    }
    if body == "RegistrationFields":
        parameters.append(parameter("X-Action-Created-At-Ms", "header", component("UtcMs"), True))
        item["requestBody"] = {"required": True, "content": {
            "multipart/form-data": {
                "schema": {
                    "type": "object", "additionalProperties": False,
                    "required": [*definitions[body]["required"], "reference_image"],
                    "properties": {
                        "action_id": component("RequestId"), "name": component("Name"),
                        "roi": {
                            "type": "string", "contentMediaType": "application/json", "contentSchema": component("Rect"),
                        },
                        "reference_image": {"type": "string", "format": "binary"},
                    },
                },
                "encoding": {"roi": {"contentType": "text/plain; charset=utf-8"}},
            },
        }}
    elif body:
        item["requestBody"] = {"required": True, "content": json_content(body)}
    return item


def exports() -> dict[str, object]:
    document = json.loads((DIRECTORY / "schemas.json").read_text(encoding="utf-8"))
    definitions = document["$defs"]
    paths: dict[str, dict[str, object]] = {}
    for method, path, body, result, statuses, client_header in HTTP:
        paths.setdefault(path, {})[method] = operation(method, path, body, result, statuses, client_header, definitions)
    openapi = {
        "openapi": "3.1.1", "info": {"title": "Lost and Found API", "version": VERSION},
        "servers": [{"url": "http://127.0.0.1:8000/api/v1"}], "paths": paths,
        "components": {
            "schemas": {name: external(name) for name in definitions},
            "securitySchemes": {"Capability": {"type": "apiKey", "in": "header", "name": "X-App-Capability"}},
        },
        "x-laf-local-protection": {
            "default_frontend_origin": "http://127.0.0.1:3000",
            "no_origin_requires_capability": True,
            "preflight": {
                "status": 204, "credentials": False, "request_headers": list(APP_HEADERS),
                "vary": ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"],
            },
            "body_limits_bytes": {"json": BODY_LIMIT, "multipart": 11_534_336,
                                  "multipart_text": 65_536, "reference_image": 10_485_760},
        },
    }
    events = {
        "$schema": document["$schema"], "title": "Lost and Found event envelope v1",
        **external("EventEnvelope"),
        "x-laf-websocket": {
            "path": "/events", "protocol": PROTOCOL, "ticket_offer_prefix": "laf.ticket.",
            "initial_message_type": "snapshot", "incoming": external("WorkspaceHeartbeat"),
        },
    }
    frames = {
        "$schema": document["$schema"], "title": "Lost and Found frame metadata v1",
        **external("FrameMetadata"),
        "x-laf-websocket": {
            "paths": ["/video/robot", "/video/webcam"], "protocol": PROTOCOL, "ticket_offer_prefix": "laf.ticket.",
            "binary_envelope": [
                {"name": "metadata_length", "encoding": "uint32", "byte_order": "big-endian", "bytes": 4},
                {"name": "metadata", "encoding": "UTF-8 JSON", "length_from": "metadata_length"},
                {"name": "image", "encoding": "JPEG", "length_from": "remaining_message_bytes"},
            ],
            "bounds": external("FrontendProfile"),
        },
    }
    return {"openapi.json": openapi, "events.json": events, "frames.json": frames}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    stale = []
    for name, document in exports().items():
        path = DIRECTORY / name
        payload = json.dumps(document, indent=2, ensure_ascii=False) + "\n"
        if args.check:
            if not path.is_file() or path.read_text(encoding="utf-8") != payload:
                stale.append(name)
        else:
            path.write_text(payload, encoding="utf-8", newline="\n")
    if stale:
        print(f"Contract exports are stale: {', '.join(stale)}. Run python -m backend.contracts.export.")
    return int(bool(stale))


if __name__ == "__main__":
    raise SystemExit(main())
