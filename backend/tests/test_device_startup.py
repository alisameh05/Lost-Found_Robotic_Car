from contextlib import nullcontext
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from backend.app.config import Config
from backend.app.controller import Controller
from backend.app.device_startup import DeviceProbe, Interface, PeerIdentity
from backend.app.main import create_app
from backend.tests.device_documents import BUILD_HASH, PAIRED_ID, device_documents, write_device_documents
from backend.tests.test_controller import SERIAL, device, fresh_reports
from backend.tests.test_realtime import auth, validate, wait_for
from backend.tests.test_records import BASE, ORIGIN, wait_for_health

API = "/api/v1"


def test_explicit_device_without_profile_never_uses_configured_fixture(tmp_path: Path) -> None:
    config = Config(tmp_path, simulation_profile="phase-06-v1", backend_mode="device")
    with TestClient(create_app(config), base_url=BASE) as client:
        boot = client.get(API + "/bootstrap", headers=ORIGIN).json()
        assert boot["qualification_profile"] is None
        headers = auth(boot)
        wait_for_health(client, headers)
        health = client.get(API + "/health", headers=headers).json()
        assert health["backend_boot_id"] == boot["backend_boot_id"]
        assert client.get(API + "/objects", headers=headers).status_code == 200
        assert client.get(API + "/health").status_code == 403
        snapshot = client.get(API + "/snapshot", headers=headers).json()
        assert snapshot["qualification_profile_id"] is None
        assert snapshot["runtime"]["motion_permission"] == "Disarmed"
        assert snapshot["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
        assert snapshot["proximity"]["state"] == "Unknown"
        statuses = {row["component"]: row for row in snapshot["readiness"]["components"]}
        for name in ("Command", "RobotVideo", "Webcam", "Controller", "AI", "QualificationProfile"):
            assert statuses[name]["cause_codes"] == ["NOT_READY"]
        stop = client.post(API + "/emergency-stop", headers=headers, json={"request_id": str(uuid4())})
        assert stop.status_code == 200 and stop.json()["permission_revoked"] is True


def component(view: dict, name: str) -> dict:
    return next(row for row in view["readiness"]["components"] if row["component"] == name)


@pytest.mark.parametrize("case, expected, probe_count", [
    ("absent_selection", "NOT_READY", 0),
    ("wrong_identity", "NOT_READY", 1),
    ("absent_peer", "NOT_READY", 1),
    ("wrong_build", "NOT_READY", 1),
    ("wrong_version", "PROTOCOL_UNSUPPORTED", 1),
    ("unsupported_selection", "PROTOCOL_UNSUPPORTED", 0),
    ("wrong_baud", "NOT_READY", 0),
    ("matching_peer", "NOT_READY", 1),
])
def test_device_connection_diagnostics_are_independent_and_disarmed(
    tmp_path: Path, case: str, expected: str, probe_count: int,
) -> None:
    profile, interfaces, evidence, artifact = device_documents()
    selection = interfaces["hc05_uno"]
    if case == "absent_selection":
        interfaces["hc05_uno"] = None
    elif case == "unsupported_selection":
        selection["protocol_version"] = 2
    elif case == "wrong_baud":
        selection["serial_baud"] = 115200
    interfaces["controller"] = {"identity": SERIAL, "profile_sha256": sha256(artifact).hexdigest()}
    write_device_documents(tmp_path, profile, interfaces, evidence, artifact)
    observed: list[str] = []

    def probe(endpoint: Interface) -> PeerIdentity | None:
        observed.append(endpoint.identity)
        if case == "absent_peer":
            return None
        return PeerIdentity("unselected" if case == "wrong_identity" else PAIRED_ID,
                            2 if case == "wrong_version" else 1,
                            "b" * 64 if case == "wrong_build" else BUILD_HASH)

    controller = Controller(SERIAL, 0.1, lambda: nullcontext(lambda: fresh_reports([device(1)])))
    app = create_app(Config(tmp_path, backend_mode="device"), controller=controller,
                     device_probes={"Command": DeviceProbe(1, probe)})
    with TestClient(app, base_url=BASE) as client:
        boot = client.get(API + "/bootstrap", headers=ORIGIN).json()
        headers = auth(boot)
        validate("BootstrapResponse", boot)
        assert boot["qualification_profile"]["evidence_kind"] == "Device"
        assert boot["qualification_profile"]["profile_id"] == "test-device-v1"
        assert "serial_baud" not in boot["qualification_profile"]
        health = wait_for(client, "/health", headers, lambda data: component(data, "Controller")["status"] == "Ready")
        snapshot = client.get(API + "/snapshot", headers=headers).json()
        validate("Health", health)
        validate("Snapshot", snapshot)
        for data in (health, snapshot):
            assert component(data, "QualificationProfile")["status"] == "Ready"
            assert component(data, "Storage")["status"] == "Ready"
            assert component(data, "Command")["cause_codes"] == [expected]
            assert component(data, "RobotVideo")["cause_codes"] == ["PROTOCOL_UNSUPPORTED"]
            assert component(data, "Webcam")["cause_codes"] == ["NOT_READY"]
            assert component(data, "Controller")["status"] == "Ready"
            assert data["readiness"]["can_start"] == {"Gestures": False, "Controller": False}
            assert PAIRED_ID not in str(data) and BUILD_HASH not in str(data)
        assert snapshot["runtime"]["motion_permission"] == "Disarmed"
        assert snapshot["qualification_profile"] == boot["qualification_profile"]
        assert snapshot["qualification_profile_id"] == "test-device-v1"
        assert not snapshot["lease"]["can_acquire"]
        assert snapshot["proximity"]["state"] == "Unknown"
        assert observed == [PAIRED_ID] * probe_count


@pytest.mark.parametrize("case, cause", [
    ("invalid_id", "NOT_READY"), ("unsupported_version", "PROTOCOL_UNSUPPORTED"),
    ("wrong_kind", "PROTOCOL_UNSUPPORTED"), ("unsupported_manifest", "PROTOCOL_UNSUPPORTED"),
    ("zero_limit", "NOT_READY"), ("frame_header", "NOT_READY"), ("event_queue", "NOT_READY"),
    ("heartbeat", "NOT_READY"), ("display_age", "NOT_READY"), ("capture_clock", "NOT_READY"),
    ("camera_rtt", "NOT_READY"), ("renewal_ack", "NOT_READY"), ("expiry", "NOT_READY"),
    ("proximity", "NOT_READY"), ("no_margin", "NOT_READY"), ("wrong_value", "NOT_READY"),
    ("fixture_evidence", "NOT_READY"), ("changed_evidence", "NOT_READY"),
])
def test_invalid_device_profile_never_reaches_adapter_boundary(tmp_path: Path, case: str, cause: str) -> None:
    profile, interfaces, evidence, artifact = device_documents()
    invalid = {
        "invalid_id": ("profile_id", "../../../bad"), "unsupported_version": ("protocol_version", 999),
        "wrong_kind": ("evidence_kind", "Fixture"), "zero_limit": ("event_queue_messages", 0),
        "frame_header": ("max_header_bytes", 100_000), "event_queue": ("event_queue_bytes", 49_999),
        "heartbeat": ("heartbeat_deadline_ms", 30), "display_age": ("display_deadline_ms", 161),
        "capture_clock": ("clock_uncertainty_limit_us", 7001), "camera_rtt": ("camera_sync_interval_ms", 1),
        "renewal_ack": ("command_ack_deadline_ms", 55), "expiry": ("firmware_expiry_ms", 20),
        "proximity": ("proximity_clear_mm", 100),
    }.get(case)
    if invalid:
        key, value = invalid
        profile[key] = value
        if key in evidence["measurements"]:
            evidence["measurements"][key]["value"] = value
    elif case == "unsupported_manifest":
        interfaces["version"] = 2
    elif case == "no_margin":
        evidence["stop_budget"]["mechanical_margin_ms"] = 0
    elif case == "wrong_value":
        evidence["measurements"]["serial_baud"]["value"] = 4
    elif case == "fixture_evidence":
        evidence["kind"] = "Fixture"
    folder = write_device_documents(tmp_path, profile, interfaces, evidence, artifact)
    if case == "changed_evidence":
        (folder / "artifacts" / sha256(artifact).hexdigest()).write_bytes(b"changed artifact")

    def unexpected_probe(_: Interface) -> PeerIdentity:
        pytest.fail("Invalid profiles must never invoke adapters.")

    app = create_app(Config(tmp_path, backend_mode="device"),
                     device_probes={"Command": DeviceProbe(1, unexpected_probe)})
    with TestClient(app, base_url=BASE) as client:
        boot = client.get(API + "/bootstrap", headers=ORIGIN).json()
        headers = auth(boot)
        wait_for_health(client, headers)
        snapshot = client.get(API + "/snapshot", headers=headers).json()
        assert component(snapshot, "QualificationProfile")["cause_codes"] == [cause]
        assert snapshot["runtime"]["motion_permission"] == "Disarmed"
        assert snapshot["qualification_profile_id"] is boot["qualification_profile"] is None
        assert client.get(API + "/objects", headers=headers).status_code == 200


def test_manifest_changes_take_effect_only_on_disarmed_restart(tmp_path: Path) -> None:
    config = Config(tmp_path, backend_mode="device")
    profile, interfaces, evidence, artifact = device_documents()
    folder = write_device_documents(tmp_path, profile, interfaces, evidence, artifact)
    with TestClient(create_app(config), base_url=BASE) as client:
        boot = client.get(API + "/bootstrap", headers=ORIGIN).json()
        wait_for_health(client, auth(boot))
        with (folder / "interfaces.json").open("ab") as manifest:
            manifest.write(b"\n")
        assert client.get(API + "/bootstrap", headers=ORIGIN).json()["qualification_profile"] == boot["qualification_profile"]
        before = client.get(API + "/snapshot", headers=auth(boot)).json()
        assert before["qualification_profile_id"] == "test-device-v1"
        assert before["runtime"]["motion_permission"] == "Disarmed"

    with TestClient(create_app(config), base_url=BASE) as client:
        assert client.get(API + "/health", headers=auth(boot)).json()["code"] == "CAPABILITY_INVALID"
        restarted = client.get(API + "/bootstrap", headers=ORIGIN).json()
        wait_for_health(client, auth(restarted))
        after = client.get(API + "/snapshot", headers=auth(restarted)).json()
        assert restarted["backend_boot_id"] == after["backend_boot_id"] != boot["backend_boot_id"]
        assert restarted["qualification_profile"] is after["qualification_profile_id"] is None
        assert component(after, "QualificationProfile")["cause_codes"] == ["NOT_READY"]
        assert not after["lease"]["can_acquire"]
        assert after["runtime"]["motion_permission"] == "Disarmed"
