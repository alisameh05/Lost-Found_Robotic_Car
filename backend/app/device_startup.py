"""Private, boot-scoped configuration for the selected Device workspace."""

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from hashlib import sha256
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path
from types import MappingProxyType
from typing import Annotated, Literal, NoReturn, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .controller import serial_key
from .simulation import IncompatibleProfile, QualificationProfile
from .uno_wire import DISCARD_PARTIAL, MAX_FRAME, REQUEST_FRAME, VERSION

DOCUMENT_LIMIT = 256 * 1024
RFC1918 = tuple(IPv4Network(block) for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
Digest = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
Identity = Annotated[str, StringConstraints(pattern=r"^[!-~][ -~]{0,511}$")]
Name = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_./:+-]{1,128}$")]
Pin = Annotated[str, StringConstraints(pattern=r"^([0-9]+(\.[0-9]+)+([-+][A-Za-z0-9.-]+)?|[a-f0-9]{40})$")]
Positive = Annotated[int, Field(ge=1, le=9_007_199_254_740_991)]
Cause = Literal["NOT_READY", "PROTOCOL_UNSUPPORTED"]
RobotPath = Literal["Command", "RobotVideo", "Proximity"]


class ManifestModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid", frozen=True)


class Build(ManifestModel):
    target: Name
    firmware_sha256: Digest
    tools: Annotated[dict[Name, Pin], Field(min_length=1)]
    cores: Annotated[dict[Name, Pin], Field(min_length=1)]
    libraries: dict[Name, Pin]


class Interface(ManifestModel):
    identity: Identity
    protocol_version: Positive
    contract_sha256: Digest


class CommandInterface(Interface):
    windows_port: Annotated[str, StringConstraints(pattern=r"^COM[1-9][0-9]{0,3}$")]
    serial_baud: Positive
    data_bits: Literal[5, 6, 7, 8]
    parity: Literal["none", "even", "odd", "mark", "space"]
    stop_bits_x2: Literal[2, 3, 4]
    flow_control: Literal["none", "rts_cts", "xon_xoff", "dsr_dtr"]
    uno: Build
    logical_output_sha256: Digest
    build_artifact_sha256: Digest | None = None


class CommandBuild(Build):
    version: Literal[1]
    kind: Literal["Device"]
    build_id: Digest
    logical_output_sha256: Digest
    reset_evidence_sha256: Digest
    serial_baud: Literal[9600, 19200, 38400]
    serial_rx_pin: Literal[2, 3]
    serial_tx_pin: Literal[2, 3]
    packet_ms: Annotated[int, Field(ge=1, le=500)]
    challenge_lifetime_ms: Annotated[int, Field(ge=1, le=500)]
    firmware_expiry_ms: Annotated[int, Field(ge=1, le=500)]
    hardware_watchdog_ms: Literal[15, 30, 60, 120, 250, 500]


@dataclass(frozen=True)
class SelectedCommand:
    interface: CommandInterface
    build_id: bytes


class CameraInterface(Interface):
    variant: Name
    address: Annotated[str, StringConstraints(pattern=r"^[0-9.]{7,15}$")]
    port: Annotated[int, Field(ge=1, le=65535)]
    esp32_cam: Build

    @model_validator(mode="after")
    def protected_address(self) -> Self:
        address = IPv4Address(self.address)
        if not any(address in network for network in RFC1918):
            raise ValueError("The selected camera address must be on a private IPv4 network.")
        return self


class ProximityInterface(Interface):
    source: Name
    transport: Name
    endpoint_id: Name
    unit: Literal["mm"]


class LocalInput(ManifestModel):
    identity: Identity
    profile_sha256: Digest


class InterfaceManifest(ManifestModel):
    version: Literal[1]
    kind: Literal["Device"]
    # Validate each optional selection separately so one missing link does not mask other observations.
    hc05_uno: object = None
    esp32_cam: object = None
    hcsr04: object = None
    windows_profile_sha256: object = None
    protected_network_sha256: object = None
    webcam: object = None
    controller: object = None


class Measurement(ManifestModel):
    value: Positive
    artifact_sha256: Digest


class StopAllowance(ManifestModel):
    software_ms: Positive
    mechanical_margin_ms: Positive


class StopBudget(StopAllowance):
    artifact_sha256: Digest


class MeasurementArtifact(ManifestModel):
    version: Literal[1]
    kind: Literal["DeviceMeasurement"]
    profile_id: Name
    interfaces_sha256: Digest
    procedure_id: Name
    result_sha256: Digest
    bounds: dict[str, Positive]
    stop_allowance: StopAllowance | None = None


class EvidenceManifest(ManifestModel):
    version: Literal[1]
    kind: Literal["Measured"]
    profile_id: Name
    interfaces_sha256: Digest
    measurements: dict[str, Measurement]
    stop_budget: StopBudget


@dataclass(frozen=True)
class PeerIdentity:
    identity: str
    protocol_version: int
    firmware_sha256: str | None = None


@dataclass(frozen=True)
class DeviceProbe:
    """A bounded, read-only compatibility observation. It supplies no readiness or motion authority."""

    protocol_version: int
    observe: Callable[[Interface], PeerIdentity | None]


@dataclass(frozen=True)
class DeviceStartup:
    profile: QualificationProfile | None = None
    profile_cause: Cause = "NOT_READY"
    causes: Mapping[str, Cause] = field(default_factory=lambda: MappingProxyType({}))
    webcam_identity: str | None = None
    controller_identity: str | None = None
    command: SelectedCommand | None = None


def read_local_file(root: Path, path: Path) -> bytes:
    resolved = (root / path).resolve(strict=True)
    if not resolved.is_relative_to(root) or not resolved.is_file():
        raise ValueError("Device configuration must use local files inside the app data directory.")
    with resolved.open("rb") as stream:
        data = stream.read(DOCUMENT_LIMIT + 1)
    if not data or len(data) > DOCUMENT_LIMIT:
        raise ValueError("A device manifest or evidence file exceeds its supported bounds.")
    return data


def decode(data: bytes) -> object:
    def unique_fields(pairs: list[tuple[str, object]]) -> dict[str, object]:
        fields = dict(pairs)
        if len(fields) != len(pairs):
            raise ValueError("Device configuration contains a duplicate key.")
        return fields

    def reject_nonfinite(_: str) -> NoReturn:
        raise ValueError("Device configuration contains a non-finite number.")

    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=unique_fields, parse_constant=reject_nonfinite)
    except RecursionError as exc:
        raise ValueError("Device configuration is nested too deeply.") from exc


def artifact_digest(value: object) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) else None


def read_artifact(root: Path, digest: str) -> bytes:
    data = read_local_file(root, Path("device", "artifacts", digest))
    if sha256(data).hexdigest() != digest:
        raise ValueError("A device evidence artifact does not match its reference.")
    return data


def verify_artifacts(root: Path, references: set[str]) -> None:
    for digest in references:
        read_artifact(root, digest)


def validate_evidence(root: Path, profile: QualificationProfile, evidence: EvidenceManifest) -> None:
    if (evidence.profile_id != profile.values["profile_id"]
            or evidence.interfaces_sha256 != profile.values["device_protocol_manifest_sha256"]):
        raise ValueError("Measured evidence must identify this profile and interface manifest.")
    bounds = {name: value for name, value in profile.values.items()
              if type(value) is int and name != "protocol_version"}
    if {name: entry.value for name, entry in evidence.measurements.items()} != bounds:
        raise ValueError("Each Device bound needs matching measured provenance.")
    p = profile.bound
    stop = evidence.stop_budget
    detection = max(p("heartbeat_deadline_ms"), p("display_deadline_ms"), p("capture_age_limit_ms"),
                    p("input_sample_deadline_ms"), p("command_ack_deadline_ms"))
    if not (
        p("heartbeat_interval_ms") < p("display_deadline_ms") <= p("capture_age_limit_ms")
        and p("camera_sync_max_rtt_us") <= p("camera_sync_interval_ms") * 1000
        and p("camera_sync_max_rtt_us") + p("clock_uncertainty_limit_us") < p("capture_age_limit_ms") * 1000
        and p("command_renewal_interval_ms") + p("command_ack_deadline_ms")
        < min(p("challenge_lifetime_ms"), p("firmware_expiry_ms"))
        and detection + p("challenge_lifetime_ms") + p("firmware_expiry_ms") <= stop.software_ms
        and stop.software_ms + stop.mechanical_margin_ms <= 500
    ):
        raise ValueError("Measured Device timing exceeds the qualified bounds.")
    references = {entry.artifact_sha256 for entry in evidence.measurements.values()} | {stop.artifact_sha256}
    artifacts = {digest: MeasurementArtifact.model_validate(decode(read_artifact(root, digest)))
                 for digest in references}
    if any(
        (artifact.profile_id, artifact.interfaces_sha256) != (evidence.profile_id, evidence.interfaces_sha256)
        for artifact in artifacts.values()
    ) or any(
        artifacts[entry.artifact_sha256].bounds.get(name) != entry.value
        for name, entry in evidence.measurements.items()
    ):
        raise ValueError("A measurement artifact does not support the selected profile and bound.")
    allowance = artifacts[stop.artifact_sha256].stop_allowance
    if allowance is None or (allowance.software_ms, allowance.mechanical_margin_ms) != (
        stop.software_ms, stop.mechanical_margin_ms,
    ):
        raise ValueError("A measurement artifact must support the selected stop allocation.")
    verify_artifacts(root, {artifact.result_sha256 for artifact in artifacts.values()})


def endpoint_cause(
    root: Path, profile: QualificationProfile, selection: Interface, probe: DeviceProbe | None,
    network: str | None,
) -> Cause:
    artifacts = {selection.contract_sha256}
    firmware = None
    if isinstance(selection, CommandInterface):
        if selection.serial_baud != profile.bound("serial_baud"):
            return "NOT_READY"
        # Start bit + data + optional parity + stop, calculated in half-bit units.
        bits_x2 = 2 + 2 * (selection.data_bits + (selection.parity != "none")) + selection.stop_bits_x2
        tx_ms = (profile.bound("serial_max_packet_bytes") * bits_x2 * 500 + selection.serial_baud - 1) // selection.serial_baud
        if profile.bound("command_renewal_interval_ms") + profile.bound("command_ack_deadline_ms") + tx_ms >= min(
            profile.bound("challenge_lifetime_ms"), profile.bound("firmware_expiry_ms"),
        ):
            return "NOT_READY"
        artifacts.add(selection.logical_output_sha256)
        firmware = selection.uno.firmware_sha256
    if isinstance(selection, CameraInterface):
        if network is None:
            return "NOT_READY"
        artifacts.add(network)
        firmware = selection.esp32_cam.firmware_sha256
    verify_artifacts(root, artifacts)
    if probe is None or probe.protocol_version != selection.protocol_version:
        return "PROTOCOL_UNSUPPORTED"
    peer = probe.observe(selection)
    if peer is not None and peer.identity == selection.identity and peer.firmware_sha256 == firmware:
        if type(peer.protocol_version) is not int or peer.protocol_version != selection.protocol_version:
            return "PROTOCOL_UNSUPPORTED"
    # A compatibility observation alone does not establish live command, video or advisory readiness.
    return "NOT_READY"


def command_selection(root: Path, profile: QualificationProfile, selection: CommandInterface) -> SelectedCommand:
    reference = selection.build_artifact_sha256
    if reference is None:
        raise ValueError("No selected Uno build artifact")
    if (selection.protocol_version != VERSION or selection.uno.target != "arduino:avr:uno"
            or not selection.identity.upper().startswith("BTHENUM\\")
            or (selection.data_bits, selection.parity, selection.stop_bits_x2, selection.flow_control)
            != (8, "none", 2, "none")
            or profile.bound("serial_max_packet_bytes") != MAX_FRAME):
        raise IncompatibleProfile("Unsupported Uno command profile")
    build = CommandBuild.model_validate(decode(read_artifact(root, reference)))
    verify_artifacts(root, {selection.contract_sha256, selection.logical_output_sha256, build.reset_evidence_sha256})
    wire_ms = (MAX_FRAME * 10_000 + build.serial_baud - 1) // build.serial_baud
    stop_bits = (len(DISCARD_PARTIAL) + 2 * REQUEST_FRAME) * 10
    ack = profile.bound("command_ack_deadline_ms")
    if (selection.uno.model_dump() != build.model_dump(include=set(Build.model_fields))
            or selection.logical_output_sha256 != build.logical_output_sha256
            or selection.serial_baud != build.serial_baud
            or build.serial_rx_pin == build.serial_tx_pin
            or profile.bound("serial_baud") != build.serial_baud
            or profile.bound("challenge_lifetime_ms") != build.challenge_lifetime_ms
            or profile.bound("firmware_expiry_ms") != build.firmware_expiry_ms
            or build.hardware_watchdog_ms > build.firmware_expiry_ms
            or ack * build.serial_baud <= stop_bits * 1000
            or profile.bound("command_renewal_interval_ms") + ack + wire_ms
            >= min(build.challenge_lifetime_ms, build.firmware_expiry_ms)
            or not (270_000 + build.serial_baud - 1) // build.serial_baud < build.packet_ms
            < min(build.challenge_lifetime_ms, build.firmware_expiry_ms)):
        raise ValueError("Uno build does not match the measured selection")
    return SelectedCommand(selection, bytes.fromhex(build.build_id))


def local_identity(root: Path, value: object, windows: str | None, *, controller: bool = False) -> str | None:
    if windows is None:
        return None
    try:
        selected = LocalInput.model_validate(value)
        verify_artifacts(root, {windows, selected.profile_sha256})
    except (OSError, RuntimeError, ValueError):
        return None
    return serial_key(selected.identity) if controller else selected.identity


def load_device_startup(root: Path, probes: Mapping[RobotPath, DeviceProbe]) -> DeviceStartup:
    root = root.resolve()
    try:
        profile_data = decode(read_local_file(root, Path("device", "profile.json")))
        interfaces_data = read_local_file(root, Path("device", "interfaces.json"))
        evidence_data = read_local_file(root, Path("device", "evidence.json"))
        profile = QualificationProfile.validate(profile_data, evidence_data, interfaces_data, kind="Device")
        interfaces_json = decode(interfaces_data)
        evidence_json = decode(evidence_data)
        for manifest in (interfaces_json, evidence_json):
            if isinstance(manifest, dict) and "version" in manifest and (
                type(manifest["version"]) is not int or manifest["version"] != 1
            ):
                raise IncompatibleProfile("The Device manifest version is unsupported.")
        interfaces = InterfaceManifest.model_validate(interfaces_json)
        validate_evidence(root, profile, EvidenceManifest.model_validate(evidence_json))
    except IncompatibleProfile:
        return DeviceStartup(profile_cause="PROTOCOL_UNSUPPORTED")
    except (OSError, RuntimeError, ValueError):
        return DeviceStartup()

    selections: tuple[tuple[RobotPath, type[Interface], object], ...] = (
        ("Command", CommandInterface, interfaces.hc05_uno),
        ("RobotVideo", CameraInterface, interfaces.esp32_cam),
        ("Proximity", ProximityInterface, interfaces.hcsr04),
    )
    windows = artifact_digest(interfaces.windows_profile_sha256)
    network = artifact_digest(interfaces.protected_network_sha256)
    causes: dict[str, Cause] = {}
    command = None
    for name, model, selection in selections:
        try:
            selected = model.model_validate(selection)
            if isinstance(selected, CommandInterface) and selected.build_artifact_sha256 is not None:
                command = command_selection(root, profile, selected)
                # A selected build still needs a current correlated acknowledgment.
                causes[name] = "NOT_READY"
            else:
                causes[name] = endpoint_cause(root, profile, selected, probes.get(name), network)
        except IncompatibleProfile:
            causes[name] = "PROTOCOL_UNSUPPORTED"
        except (OSError, RuntimeError, ValueError):
            causes[name] = "NOT_READY"
    return DeviceStartup(profile, causes=MappingProxyType(causes),
                         webcam_identity=local_identity(root, interfaces.webcam, windows),
                         controller_identity=local_identity(root, interfaces.controller, windows, controller=True),
                         command=command)
