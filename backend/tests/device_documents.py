"""Synthetic manifests for testing the Device loader. These values are not qualification evidence."""

import json
from hashlib import sha256
from pathlib import Path
from typing import Any

BOUNDS = {
    "max_header_bytes": 1500,
    "max_frame_bytes": 100000,
    "max_frame_width": 640,
    "max_frame_height": 480,
    "max_frame_pixels": 307200,
    "max_event_message_bytes": 50000,
    "max_client_message_bytes": 2048,
    "event_queue_messages": 12,
    "event_queue_bytes": 150000,
    "heartbeat_interval_ms": 30,
    "heartbeat_deadline_ms": 90,
    "display_deadline_ms": 100,
    "capture_age_limit_ms": 160,
    "clock_uncertainty_limit_us": 1250,
    "camera_sync_interval_ms": 250,
    "camera_sync_max_rtt_us": 7000,
    "input_sample_deadline_ms": 100,
    "command_ack_deadline_ms": 30,
    "serial_max_packet_bytes": 64,
    "serial_baud": 57600,
    "command_renewal_interval_ms": 25,
    "challenge_lifetime_ms": 80,
    "firmware_expiry_ms": 140,
    "proximity_sample_deadline_ms": 150,
    "proximity_warning_mm": 110,
    "proximity_clear_mm": 220,
    "proximity_clear_samples": 4,
    "proximity_max_distance_mm": 1200,
}
PAIRED_ID = r"BTHENUM\synthetic-command-identity"
BUILD_HASH = "a" * 64


def device_documents() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], bytes]:
    artifact = b"Synthetic adapter-boundary fixture. No connected-device measurements."
    digest = sha256(artifact).hexdigest()
    build = {"target": "test:fixture:board", "firmware_sha256": BUILD_HASH,
             "tools": {"test-cli": "1.2.3"}, "cores": {"test-core": "4.5.6"}, "libraries": {}}
    interfaces = {
        "kind": "Device", "version": 1,
        "hc05_uno": {
            "identity": PAIRED_ID, "protocol_version": 1, "contract_sha256": digest,
            "windows_port": "COM18", "serial_baud": BOUNDS["serial_baud"], "data_bits": 8, "parity": "none",
            "stop_bits_x2": 2, "flow_control": "none", "uno": build, "logical_output_sha256": digest,
        },
        "esp32_cam": {
            "identity": "synthetic-camera", "protocol_version": 1, "contract_sha256": digest,
            "variant": "fixture-board", "address": "192.168.4.123", "port": 3210, "esp32_cam": build,
        },
        "hcsr04": None,
        "windows_profile_sha256": digest, "protected_network_sha256": digest,
        "webcam": None, "controller": None,
    }
    profile = {"profile_id": "test-device-v1", "protocol_version": 1, "evidence_kind": "Device", **BOUNDS}
    evidence = {"version": 1, "kind": "Measured", "profile_id": profile["profile_id"],
                "measurements": {key: {"value": value} for key, value in BOUNDS.items()},
                "stop_budget": {"software_ms": 400, "mechanical_margin_ms": 100}}
    return profile, interfaces, evidence, artifact


def write_device_documents(
    root: Path, profile: dict[str, Any], interfaces: dict[str, Any], evidence: dict[str, Any], artifact: bytes,
    *, measurement_overrides: dict[str, object] | None = None,
) -> Path:
    folder = root / "device"
    artifacts = folder / "artifacts"
    artifacts.mkdir(parents=True, exist_ok=True)
    (artifacts / sha256(artifact).hexdigest()).write_bytes(artifact)
    interfaces_data = json.dumps(interfaces).encode()
    interfaces_hash = sha256(interfaces_data).hexdigest()
    measurement = json.dumps({
        "version": 1, "kind": "DeviceMeasurement", "profile_id": profile["profile_id"],
        "interfaces_sha256": interfaces_hash, "procedure_id": "synthetic-test-procedure",
        "result_sha256": sha256(artifact).hexdigest(),
        "bounds": {key: entry["value"] for key, entry in evidence["measurements"].items()},
        "stop_allowance": {key: evidence["stop_budget"][key] for key in ("software_ms", "mechanical_margin_ms")},
        **(measurement_overrides or {}),
    }).encode()
    measurement_hash = sha256(measurement).hexdigest()
    (artifacts / measurement_hash).write_bytes(measurement)
    evidence_data = json.dumps({
        "interfaces_sha256": interfaces_hash,
        **evidence,
        "measurements": {key: {**entry, "artifact_sha256": measurement_hash}
                         for key, entry in evidence["measurements"].items()},
        "stop_budget": {**evidence["stop_budget"], "artifact_sha256": measurement_hash},
    }).encode()
    (folder / "interfaces.json").write_bytes(interfaces_data)
    (folder / "evidence.json").write_bytes(evidence_data)
    (folder / "profile.json").write_text(json.dumps({
        "device_protocol_manifest_sha256": interfaces_hash, "evidence_manifest_sha256": sha256(evidence_data).hexdigest(),
        **profile,
    }), encoding="utf-8")
    return folder


def write_camera_documents(root: Path, build_id: str, token: str) -> None:
    profile, interfaces, evidence, artifact = device_documents()
    camera = interfaces["esp32_cam"]
    build = json.dumps({**camera["esp32_cam"], "version": 1, "variant": camera["variant"], "build_id": build_id}).encode()
    reference = sha256(build).hexdigest()
    camera["build_artifact_sha256"] = reference
    folder = write_device_documents(root, profile, interfaces, evidence, artifact)
    (folder / "artifacts" / reference).write_bytes(build)
    (folder / "camera.token").write_text(token, encoding="ascii")
