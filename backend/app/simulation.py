"""Versioned fixture composition and bounded observations for the connected preview."""

import json
import math
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from secrets import token_urlsafe
from types import MappingProxyType
from typing import Literal, Protocol

from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
from PIL import Image

from .http import BODY_LIMIT, HttpError, json_fields, reject_nonfinite
from .motion import CommandSink, InputSample, InputScope, controller_intent, gesture_intent
from .registration_input import SAFE_INTEGER

FIXTURES = Path(__file__).with_name("preview_fixture")
PROFILE_NAME = "fixture-v1"
REVIEW_PROFILE_NAME = "fixture-review-v1"
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
class FixturePresence:
    scope: InputScope
    stream_epoch: str
    clock_epoch: str
    sequence: int
    association: str
    present: bool


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
    presence: FixturePresence | None = None

    def fixture_presence(self, scope: InputScope) -> FixturePresence | None:
        sample = self.presence
        if sample and (sample.scope, sample.stream_epoch, sample.clock_epoch, sample.sequence) == (
            scope, self.stream_epoch, self.clock_epoch, self.sequence,
        ):
            return sample
        return None


@dataclass(frozen=True)
class Observation:
    robot: Capture | None
    webcam: Capture | None
    command: bool
    controller: bool
    inference: bool
    controller_sample_at: float | None = None
    gesture_sample_at: float | None = None
    controller_input: InputSample | None = None
    gesture_input: InputSample | None = None
    proximity: "ProximitySample | None" = None


class PreviewAdapter(Protocol):
    def observe(self, now: float, scope: InputScope | None = None) -> Observation: ...


@dataclass(frozen=True)
class ProximitySample:
    source_epoch: str
    sequence: int
    observed_at: float
    distance_mm: int | None


class ProximityAdvisory:
    def __init__(self, profile: QualificationProfile):
        self.profile = profile
        self.latest: ProximitySample | None = None
        self.clear_count = 0
        self.payload: dict[str, object] = {
            "state": "Unknown", "warning_latched": False, "distance_mm": None,
            "sample_seq": None, "source_epoch": None, "observed_at_ms": None,
        }

    def observe(self, sample: ProximitySample | None, now: float, utc: int) -> None:
        if sample is None:
            self.expire(now)
            return
        previous = self.latest
        limit = self.profile.bound("proximity_sample_deadline_ms") / 1000
        if (previous and type(sample.sequence) is int and sample.source_epoch == previous.source_epoch
                and sample.sequence <= previous.sequence):
            self.expire(now)
            return
        if (not isinstance(sample.source_epoch, str) or not ID.fullmatch(sample.source_epoch) or type(sample.sequence) is not int
                or not 1 <= sample.sequence <= SAFE_INTEGER or not math.isfinite(sample.observed_at)
                or not 0 <= now - sample.observed_at < limit
                or (previous is not None and sample.observed_at <= previous.observed_at)):
            self.unknown()
            return
        if (previous is None or sample.source_epoch != previous.source_epoch
                or sample.sequence != previous.sequence + 1 or sample.observed_at - previous.observed_at >= limit):
            self.clear_count = 0
        self.latest = sample
        distance = sample.distance_mm
        state = "Unknown" if previous and sample.source_epoch != previous.source_epoch else self.payload["state"]
        latched = self.payload["warning_latched"]
        if type(distance) is not int or not 0 <= distance <= self.profile.bound("proximity_max_distance_mm"):
            self.unknown()
            return
        if distance <= self.profile.bound("proximity_warning_mm"):
            state, latched = "Warning", True
        if distance >= self.profile.bound("proximity_clear_mm"):
            count = self.profile.bound("proximity_clear_samples")
            self.clear_count = min(count, self.clear_count + 1)
            if self.clear_count == count:
                state, latched = "Clear", False
        else:
            self.clear_count = 0
        if latched:
            state = "Warning"
        self.payload = {
            "state": state, "warning_latched": latched, "distance_mm": distance,
            "sample_seq": sample.sequence, "source_epoch": sample.source_epoch,
            "observed_at_ms": max(0, utc - math.ceil((now - sample.observed_at) * 1000)),
        }

    def unknown(self) -> None:
        self.clear_count = 0
        self.payload = {**self.payload, "state": "Unknown", "distance_mm": None,
                        "sample_seq": None, "source_epoch": None, "observed_at_ms": None}

    def expire(self, now: float) -> None:
        if self.latest and now - self.latest.observed_at >= self.profile.bound("proximity_sample_deadline_ms") / 1000:
            self.unknown()


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
    def __init__(self, robot: Sample, webcam: Sample, *, review: bool = False):
        self._samples = (robot, webcam)
        self._epochs = (token_urlsafe(18), token_urlsafe(18))
        self._sequence = 0
        self._session: str | None = None
        self._scope_started = 0.0
        self._review = review

    def observe(self, now: float, scope: InputScope | None = None) -> Observation:
        self._sequence += 1
        robot, webcam = (
            Capture(epoch, epoch, self._sequence, int(now * 1_000_000), now, 1, sample.width, sample.height,
                    sample.jpeg)
            for epoch, sample in zip(self._epochs, self._samples, strict=True)
        )
        if scope and scope.session != self._session:
            self._session, self._scope_started = scope.session, now
        elapsed = now - self._scope_started
        if scope and self._review:
            presence = FixturePresence(scope, robot.stream_epoch, robot.clock_epoch, robot.sequence,
                                       "fixture-wallet", not 12.0 <= elapsed % 24.0 < 18.0)
            robot = replace(robot, presence=presence)
        held = 1.2 <= elapsed < 4.2
        return Observation(
            robot, webcam, command=True, controller=True, inference=True,
            controller_sample_at=now, gesture_sample_at=now,
            controller_input=InputSample(scope, now, controller_intent(("forward",) if held else ())) if scope else None,
            gesture_input=InputSample(scope, now, gesture_intent(1 if held else 0)) if scope else None,
            proximity=ProximitySample(self._epochs[0], self._sequence, now, 120 if held else 300) if scope else None,
        )


@dataclass(frozen=True)
class InferenceSample:
    scope: InputScope | None
    frame_id: str | None
    capture: Capture | None


@dataclass(frozen=True)
class CandidateObservation:
    scope: InputScope
    frame_id: str
    stream_epoch: str
    clock_epoch: str
    capture_sequence: int
    box: tuple[float, float, float, float]
    association: str | None = None


Inference = Callable[[InferenceSample], bool | CandidateObservation]


class FixtureInference:
    """Report the wallet region in the verified robot fixture after a short search."""

    def __init__(self) -> None:
        self.session: str | None = None
        self.started = 0.0

    def __call__(self, sample: InferenceSample) -> bool | CandidateObservation:
        scope, capture = sample.scope, sample.capture
        if scope is None or capture is None or sample.frame_id is None:
            return True
        if scope.session != self.session:
            self.session, self.started = scope.session, capture.observed_at
        if capture.observed_at - self.started < 2.0:
            return True
        presence = capture.fixture_presence(scope)
        if capture.presence is not None and (presence is None or not presence.present):
            return True
        return CandidateObservation(
            scope, sample.frame_id, capture.stream_epoch, capture.clock_epoch, capture.sequence,
            (303.5, 203.5, 82.0, 40.0), presence.association if presence else None,
        )


@dataclass(frozen=True)
class Simulation:
    profile: QualificationProfile
    adapter: PreviewAdapter
    command_sink: CommandSink | None = None
    inference: Inference | None = None


def load_simulation(selection: str | None) -> Simulation | None:
    if selection is None:
        return None
    if selection not in (PROFILE_NAME, REVIEW_PROFILE_NAME):
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
    review = selection == REVIEW_PROFILE_NAME
    return Simulation(profile, StaticScene(*samples, review=review), inference=FixtureInference() if review else None)


def capture_identity_valid(capture: Capture) -> bool:
    return (
        ID.fullmatch(capture.stream_epoch) is not None and ID.fullmatch(capture.clock_epoch) is not None
        and type(capture.sequence) is int and 1 <= capture.sequence <= SAFE_INTEGER
        and type(capture.source_us) is int and 0 <= capture.source_us <= SAFE_INTEGER
        and type(capture.age_ms) is int and 0 <= capture.age_ms <= SAFE_INTEGER
    )
