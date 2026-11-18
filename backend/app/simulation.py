"""Versioned fixture composition and bounded observations for the connected preview."""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from secrets import token_urlsafe
from types import MappingProxyType
from typing import Literal, Protocol

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from PIL import Image

from .http import BODY_LIMIT, HttpError, json_fields, reject_nonfinite
from .registration_input import SAFE_INTEGER

FIXTURES = Path(__file__).with_name("preview_fixture")
PROFILE_NAME = "fixture-v1"
PROFILE_FIELDS = Path(__file__).resolve().parents[1] / "contracts" / "v1" / "schemas.json"
Source = Literal["robot", "webcam"]
SOURCES: tuple[Source, ...] = ("robot", "webcam")
ID = re.compile(r"[A-Za-z0-9_-]{1,128}")


class IncompatibleProfile(ValueError):
    pass


def contract_definitions() -> dict[str, object]:
    definitions: dict[str, object] = json.loads(PROFILE_FIELDS.read_text(encoding="utf-8"))["$defs"]
    return definitions


@dataclass(frozen=True)
class QualificationProfile:
    values: Mapping[str, int | str]
    frontend: Mapping[str, int | str]

    def bound(self, key: str) -> int:
        return int(self.values[key])

    @classmethod
    def validate(cls, document: object, evidence: bytes, interfaces: bytes) -> "QualificationProfile":
        if isinstance(document, dict) and (
            document.get("protocol_version") != 1 or document.get("evidence_kind") != "Fixture"
        ):
            raise IncompatibleProfile("The simulation profile is incompatible.")
        definitions = contract_definitions()
        validator = Draft202012Validator({"$defs": definitions, "$ref": "#/$defs/QualificationProfile"})
        if not isinstance(document, dict) or not validator.is_valid(document):
            raise ValueError("The simulation profile is invalid.")
        # JSON Schema accepts integer-valued floats. The wire contract requires actual integers.
        if type(document["protocol_version"]) is not int or any(type(v) not in (int, str) for v in document.values()):
            raise ValueError("The simulation profile contains an invalid integer.")
        if document["evidence_manifest_sha256"] != sha256(evidence).hexdigest() or (
            document["device_protocol_manifest_sha256"] != sha256(interfaces).hexdigest()
        ):
            raise ValueError("The simulation manifests do not match the profile.")
        p = document
        if not ID.fullmatch(p["profile_id"]):
            raise ValueError("The simulation profile ID is invalid.")
        if not (
            max(p["max_frame_width"], p["max_frame_height"]) <= p["max_frame_pixels"]
            and p["max_header_bytes"] + 4 < p["max_frame_bytes"] <= 16 * 1024**2
            and p["max_frame_pixels"] <= 20_000_000
            and p["max_event_message_bytes"] <= p["event_queue_bytes"] <= 8 * 1024**2
            and p["max_client_message_bytes"] <= BODY_LIMIT
            and p["event_queue_messages"] <= 1024
            and p["heartbeat_interval_ms"] < p["heartbeat_deadline_ms"]
            and p["command_renewal_interval_ms"] < min(p["challenge_lifetime_ms"], p["firmware_expiry_ms"])
            and p["clock_uncertainty_limit_us"] <= p["camera_sync_max_rtt_us"]
            and p["clock_uncertainty_limit_us"] < p["capture_age_limit_ms"] * 1000
            and p["proximity_warning_mm"] < p["proximity_clear_mm"] <= p["proximity_max_distance_mm"]
        ):
            raise ValueError("The simulation profile bounds are inconsistent.")
        frontend_schema = definitions["FrontendProfile"]
        assert isinstance(frontend_schema, dict)
        frontend = {name: p[name] for name in frontend_schema["required"]}
        return cls(MappingProxyType(dict(p)), MappingProxyType(frontend))


@dataclass(frozen=True)
class Capture:
    stream_epoch: str
    clock_epoch: str
    sequence: int
    source_us: int
    observed_at: float
    age_ms: int
    width: int
    height: int
    jpeg: bytes


@dataclass(frozen=True)
class Observation:
    robot: Capture | None
    webcam: Capture | None
    command: bool
    controller: bool
    inference: bool


class PreviewAdapter(Protocol):
    def observe(self, now: float) -> Observation: ...


@dataclass(frozen=True)
class Sample:
    jpeg: bytes
    width: int
    height: int


def dimensions_allowed(profile: QualificationProfile, width: int, height: int) -> bool:
    return (0 < width <= profile.bound("max_frame_width") and 0 < height <= profile.bound("max_frame_height")
            and width * height <= profile.bound("max_frame_pixels"))


def read_sample(jpeg: bytes, profile: QualificationProfile, expected: tuple[int, int] | None = None) -> Sample:
    if len(jpeg) + 4 >= profile.bound("max_frame_bytes") or not jpeg.endswith(b"\xff\xd9"):
        raise ValueError("The fixture is not a bounded JPEG.")
    with Image.open(BytesIO(jpeg), formats=["JPEG"]) as image:
        width, height = image.size
        if not dimensions_allowed(profile, width, height) or (expected is not None and image.size != expected):
            raise ValueError("The fixture dimensions exceed the profile or do not match its metadata.")
        image.load()
        if image.size != (width, height):
            raise ValueError("The JPEG dimensions changed during decode.")
    return Sample(jpeg, width, height)


class StaticScene:
    def __init__(self, robot: Sample, webcam: Sample):
        self._samples = (robot, webcam)
        self._epochs = (token_urlsafe(18), token_urlsafe(18))
        self._sequence = 0

    def observe(self, now: float) -> Observation:
        self._sequence += 1
        robot, webcam = (
            Capture(epoch, epoch, self._sequence, int(now * 1_000_000), now, 1, sample.width, sample.height,
                    sample.jpeg)
            for epoch, sample in zip(self._epochs, self._samples, strict=True)
        )
        return Observation(robot, webcam, command=True, controller=True, inference=True)


@dataclass(frozen=True)
class Simulation:
    profile: QualificationProfile
    adapter: PreviewAdapter


def load_simulation(selection: str | None) -> Simulation | None:
    if selection is None:
        return None
    if selection != PROFILE_NAME:
        raise IncompatibleProfile("The simulation profile is incompatible.")
    manifests = tuple((FIXTURES / name).read_text(encoding="utf-8").encode("utf-8") for name in ("evidence.json", "interfaces.json"))
    evidence, interfaces = manifests
    try:
        document = json.loads((FIXTURES / "profile.json").read_text(encoding="utf-8"),
                              object_pairs_hook=json_fields, parse_constant=reject_nonfinite)
    except HttpError as exc:
        raise ValueError("The simulation profile contains invalid JSON.") from exc
    profile = QualificationProfile.validate(document, evidence, interfaces)
    hashes = json.loads(evidence)["frames"]
    samples = []
    for source in SOURCES:
        path = FIXTURES / f"{source}.jpg"
        with path.open("rb") as stream:
            jpeg = stream.read(profile.bound("max_frame_bytes"))
        if hashes[source] != sha256(jpeg).hexdigest():
            raise ValueError("The sample does not match the fixture evidence.")
        samples.append(read_sample(jpeg, profile))
    return Simulation(profile, StaticScene(*samples))


def capture_identity_valid(capture: Capture) -> bool:
    return (
        ID.fullmatch(capture.stream_epoch) is not None and ID.fullmatch(capture.clock_epoch) is not None
        and 1 <= capture.sequence <= SAFE_INTEGER and 0 <= capture.source_us <= SAFE_INTEGER
        and 0 <= capture.age_ms <= SAFE_INTEGER
    )
