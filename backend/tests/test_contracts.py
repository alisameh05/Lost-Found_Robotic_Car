import json
import re
from pathlib import Path

from jsonschema import Draft202012Validator

from backend.app.config import Config
from backend.app.main import create_app
from backend.contracts.export import DIRECTORY

APPROVED = Path(__file__).resolve().parents[2] / "docs" / "API.md"


def read_contract(name: str) -> dict:
    return json.loads((DIRECTORY / name).read_text(encoding="utf-8"))


def definition_of(ref: dict) -> str:
    return ref["$ref"].rsplit("/", 1)[1]


def test_approved_models_and_route_catalogue_match_the_backend_exports(tmp_path: Path) -> None:
    document = APPROVED.read_text(encoding="utf-8")
    schema = re.search(r"## 7\. JSON Schemas\n.*?```json\n(.*?)\n```", document, re.S)
    assert schema
    definitions = read_contract("schemas.json")
    Draft202012Validator.check_schema(definitions)
    assert definitions["$defs"] == json.loads(schema[1])["$defs"]

    approved_http = {}
    approved_sockets = set()
    for method, path, request, response in re.findall(
        r"^\| `(GET|POST|PUT|WS) (\S+)` \| (.*?) \| (.*?) \|$", document, re.M
    ):
        if method == "WS":
            approved_sockets.add(path)
        else:
            approved_http[(method.lower(), path)] = (request, response)
    openapi = read_contract("openapi.json")
    version = re.search(r'^version: "([^"]+)"', document, re.M)
    assert version and openapi["info"]["version"] == version[1]
    assert set(openapi["components"]["schemas"]) == set(definitions["$defs"])
    assert all(definition_of(ref) == name for name, ref in openapi["components"]["schemas"].items())
    protection = openapi["x-laf-local-protection"]
    assert protection["preflight"] == {
        "status": 204, "credentials": False,
        "request_headers": ["content-type", "x-app-capability", "x-app-client-id", "x-action-created-at-ms"],
        "vary": ["Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers"],
    }
    assert protection["body_limits_bytes"] == {
        "json": 65_536, "multipart": 11_534_336, "multipart_text": 65_536, "reference_image": 10_485_760,
    }
    operations = {(method, path): operation for path, methods in openapi["paths"].items()
                  for method, operation in methods.items()}
    assert operations.keys() == approved_http.keys()
    for key, (request, response) in approved_http.items():
        operation = operations[key]
        statuses = set(re.findall(r"\b20[012]\b", response))
        statuses.update(code for piece in re.findall(r"`(20[012]/20[012]) ", response) for code in piece.split("/"))
        if "503" in response:
            statuses.add("503")
        assert operation["responses"].keys() == statuses | {"default"}
        successes = [operation["responses"][status]["content"] for status in statuses if status.startswith("2")]
        if key[1] == "/media/{id}":
            assert all(set(content) == {"image/png", "image/jpeg"} for content in successes)
        else:
            result = re.search(r"`20[012](?:/20[012])? (\w+)`", response)
            assert result
            assert all(definition_of(content["application/json"]["schema"]) == result[1] for content in successes)
        if key == ("post", "/objects"):
            parts = operation["requestBody"]["content"]["multipart/form-data"]["schema"]
            assert set(parts["required"]) == {"action_id", "name", "reference_image", "roi"}
        elif key[0] != "get":
            request_type = re.search(r"`(\w+)`", request)
            assert request_type
            assert definition_of(operation["requestBody"]["content"]["application/json"]["schema"]) == request_type[1]
        else:
            assert "requestBody" not in operation
        assert bool(operation["security"]) == (key[1] != "/bootstrap")
        parameters = {(item["in"], item["name"]): item for item in operation["parameters"]}
        required = {(item["in"], item["name"]) for item in parameters.values() if item["required"]}
        expected = set()
        if "{id}" in key[1]:
            expected.add(("path", "id"))
        if key[1] == "/bootstrap":
            expected.add(("header", "Origin"))
        if key == ("post", "/objects"):
            expected.add(("header", "X-Action-Created-At-Ms"))
        if key in {
            ("post", "/objects"), ("get", "/snapshot"), ("get", "/objects"),
            ("get", "/objects/{id}/sessions"), ("get", "/sessions/{id}/matches"),
            ("post", "/settings/retention-preview"), ("put", "/settings/retention"),
        }:
            expected.add(("header", "X-App-Client-Id"))
        assert required == expected
        query_names = {name for kind, name in parameters if kind == "query"}
        if key in {("get", "/objects"), ("get", "/objects/{id}/sessions"), ("get", "/sessions/{id}/matches")}:
            assert query_names == ({"limit", "cursor", "name", "status"} if key[1] == "/objects" else {"limit", "cursor"})
            assert parameters["query", "limit"]["schema"] == {
                "type": "integer", "minimum": 1, "maximum": 100, "default": 25,
            }
        else:
            assert not query_names
        assert all(value["headers"]["Cache-Control"]["schema"] == {"const": "no-store"}
                   for value in operation["responses"].values())

    health_error = operations["get", "/health"]["responses"]["503"]["content"]["application/json"]["schema"]["oneOf"]
    assert [definition_of(ref) for ref in health_error] == ["Health", "Error"]
    actual_routes = {(method.lower(), route.path.removeprefix("/api/v1"))
                     for route in create_app(Config(tmp_path)).routes for method in route.methods}
    assert actual_routes == {key for key, operation in operations.items() if operation["x-laf-records-runtime"]}
    events = read_contract("events.json")
    frames = read_contract("frames.json")
    event_socket = events["x-laf-websocket"]
    frame_socket = frames["x-laf-websocket"]
    assert approved_sockets == {event_socket["path"], *frame_socket["paths"]}
    assert event_socket["protocol"] == frame_socket["protocol"] == "laf.v1"
    assert event_socket["ticket_offer_prefix"] == frame_socket["ticket_offer_prefix"] == "laf.ticket."
    assert event_socket["initial_message_type"] == "snapshot"
    assert definition_of(events) == "EventEnvelope"
    assert definition_of(event_socket["incoming"]) == "WorkspaceHeartbeat"
    assert definition_of(frames) == "FrameMetadata"
    assert frame_socket["binary_envelope"] == [
        {"name": "metadata_length", "encoding": "uint32", "byte_order": "big-endian", "bytes": 4},
        {"name": "metadata", "encoding": "UTF-8 JSON", "length_from": "metadata_length"},
        {"name": "image", "encoding": "JPEG", "length_from": "remaining_message_bytes"},
    ]
