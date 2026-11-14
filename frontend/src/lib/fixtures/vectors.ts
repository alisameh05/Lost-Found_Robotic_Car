import type {
  EventEnvelope, FrameMetadata, FrontendProfile, QualificationProfile, Snapshot,
} from "@/generated/api-v1";
import { parseFrame } from "./frame";
import { imageHeight, imageWidth, sampleImage } from "./images";
import { clear, sampleTime, sampleSession, snapshot, recoveryFailure, pending, paused, searching, warning, fixtureProfile } from "./samples";

export const qualification: QualificationProfile = {
  ...fixtureProfile, evidence_manifest_sha256: "0".repeat(64), device_protocol_manifest_sha256: "1".repeat(64),
  event_queue_messages: 8, event_queue_bytes: 65_536, clock_uncertainty_limit_us: 1000,
  camera_sync_interval_ms: 500, camera_sync_max_rtt_us: 4000, input_sample_deadline_ms: 150,
  command_ack_deadline_ms: 120, serial_max_packet_bytes: 128, serial_baud: 115_200,
  command_renewal_interval_ms: 40, challenge_lifetime_ms: 120, firmware_expiry_ms: 160,
  proximity_sample_deadline_ms: 300, proximity_warning_mm: 200, proximity_clear_mm: 350,
  proximity_clear_samples: 3, proximity_max_distance_mm: 2000,
};

export function snapshotEvent(state: Snapshot): Extract<EventEnvelope, { type: "snapshot" }> {
  return {
    protocol_version: 1, backend_boot_id: state.backend_boot_id, event_seq: state.event_seq,
    session_id: state.active_session?.id ?? null, session_revision: state.active_session?.revision ?? null,
    occurred_at_ms: sampleTime, type: "snapshot", payload: state,
  };
}

const start = snapshotEvent(snapshot);
const forEvent = (seq: number, session: Snapshot["active_session"] = null) => ({
  protocol_version: start.protocol_version, backend_boot_id: start.backend_boot_id, event_seq: seq,
  session_id: session?.id ?? null, session_revision: session?.revision ?? null, occurred_at_ms: sampleTime + seq,
});
const { runtime, readiness, retention } = snapshot;
const candidateSession = { ...paused, pause_causes: [{ cause: "CandidateReview", failure_id: null }] } satisfies typeof paused;
export const eventVectors = [
  start,
  { ...forEvent(2, searching), type: "session_changed", payload: {
    session: searching, runtime: { ...runtime, effective_session_state: "Searching" }, operation: null,
  } },
  { ...forEvent(3, candidateSession), type: "candidate_pending", payload: { match: pending, control_generation: 2 } },
  { ...forEvent(4, candidateSession), type: "readiness_changed", payload: {
    runtime: { ...runtime, effective_session_state: "Paused", control_generation: 2 }, readiness,
  } },
  { ...forEvent(5, candidateSession), type: "proximity_warning_changed", payload: { proximity: warning } },
  { ...forEvent(6, candidateSession), type: "recovery_changed", payload: {
    runtime: { ...runtime, effective_session_state: "Paused", control_generation: 2 }, failures: [recoveryFailure],
  } },
  { ...forEvent(7, sampleSession), type: "session_changed", payload: { session: sampleSession, runtime, operation: null } },
  { ...forEvent(8), type: "retention_changed", payload: { retention, operation: null } },
  { ...forEvent(9), type: "object_removed", payload: { object_id: "sample-expired", reason: "Expired" } },
  { ...forEvent(10), type: "storage_fault", payload: {
    code: "STORAGE_UNAVAILABLE", message: "Sample storage write failed.", blocked_capabilities: ["Register", "Start", "Resume"],
    operation: null, deletion: { status: "Failed", remaining_objects: 1, remaining_files: 2, error_code: "STORAGE_UNAVAILABLE" }, runtime,
  } },
  { ...forEvent(11), type: "proximity_warning_changed", payload: { proximity: clear } },
] satisfies EventEnvelope[];

export const invalidEventVectors = {
  duplicate: { previous: eventVectors[1], next: eventVectors[1] },
  gap: { previous: eventVectors[1], next: eventVectors[3] },
  newBoot: { previous: eventVectors[1], next: { ...eventVectors[2], backend_boot_id: "fixture-other-boot" } },
  unknownVersion: { previous: eventVectors[1], next: { ...eventVectors[2], protocol_version: 2 } },
};

export function encodeFrame(metadata: unknown, jpeg: Uint8Array) {
  const header = new TextEncoder().encode(typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  const message = new Uint8Array(4 + header.length + jpeg.length);
  new DataView(message.buffer).setUint32(0, header.length);
  message.set(header, 4);
  message.set(jpeg, 4 + header.length);
  return message;
}

function metadataFor(source: FrameMetadata["source"]): FrameMetadata {
  return {
    protocol_version: 1, source, stream_epoch: `fixture-${source}-stream`, frame_id: `fixture-${source}-frame`, capture_seq: 1,
    width: imageWidth, height: imageHeight, received_at_ms: sampleTime, capture_age_bound_ms: 40,
    source_capture_us: source === "robot" ? 80_000 : 120_000,
    source_clock_epoch: source === "robot" ? "fixture-camera-clock" : "fixture-backend-clock",
  };
}
export function frameVector(source: FrameMetadata["source"], profile: FrontendProfile | null) {
  const message = encodeFrame(metadataFor(source), sampleImage("image/jpeg"));
  return parseFrame(message, profile, source) ? message : null;
}

export function invalidFrameVectors() {
  const metadata = metadataFor("robot");
  const jpeg = sampleImage("image/jpeg");
  const shortScan = Uint8Array.from([...jpeg.slice(0, -64), 0xff, 0xd9]);
  return {
    shortPrefix: new Uint8Array([0, 0, 1]),
    truncatedHeader: new Uint8Array([0, 0, 0, 16, 123]),
    truncatedJpeg: encodeFrame(metadata, jpeg.subarray(0, -4)),
    truncatedJpegWithEoi: encodeFrame(metadata, shortScan),
    oversizedHeader: encodeFrame(" ".repeat(fixtureProfile.max_header_bytes + 1), jpeg),
    oversizedMessage: new Uint8Array(fixtureProfile.max_frame_bytes + 1),
    malformedJson: encodeFrame("{", jpeg),
    duplicateKey: encodeFrame(JSON.stringify(metadata).replace("{", '{"width":1,'), jpeg),
    malformedUtf8: new Uint8Array([0, 0, 0, 1, 255, 0]),
    unsupportedVersion: encodeFrame({ ...metadata, protocol_version: 2 }, jpeg),
    mismatchedDimensions: encodeFrame({ ...metadata, width: metadata.width + 1 }, jpeg),
    oversizedDimensions: encodeFrame({ ...metadata, width: fixtureProfile.max_frame_width + 1 }, jpeg),
    corruptJpeg: encodeFrame(metadata, Uint8Array.of(255, 216, 0, 255, 217)),
  };
}
