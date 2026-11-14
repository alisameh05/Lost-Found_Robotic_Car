import {
  componentNames, type BootstrapResponse, type Component, type ComponentName, type ErrorCode,
  type Failure, type FrontendProfile, type Health, type Match, type Media, type Object as LostObject,
  type Proximity, type Session, type Settings, type Snapshot,
} from "@/generated/api-v1";
import { imageHeight, imageWidth, sampleImage } from "./images";

export const sampleTime = Date.UTC(2026, 10, 13, 12);
export const day = 86_400_000;
export const bootId = "fixture-boot";
export const clientId = "fixture-client";
export const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
export const leaseId = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
export const actionId = "10000000-0000-4000-8000-000000000001";
export const requestId = "10000000-0000-4000-8000-000000000002";
export const settings: Settings = { retention_days: 7, revision: 1, updated_at_ms: sampleTime };

export const fixtureProfile: FrontendProfile = {
  profile_id: "fixture-profile",
  protocol_version: 1,
  evidence_kind: "Fixture",
  max_header_bytes: 1024,
  max_frame_bytes: 4096,
  max_frame_width: 64,
  max_frame_height: 48,
  max_frame_pixels: 3072,
  max_event_message_bytes: 32_768,
  max_client_message_bytes: 4096,
  heartbeat_interval_ms: 100,
  heartbeat_deadline_ms: 300,
  display_deadline_ms: 240,
  capture_age_limit_ms: 180,
};

export const bootstrapFacts: BootstrapResponse = {
  client_id: clientId, capability, backend_boot_id: bootId, server_time_ms: sampleTime, qualification_profile: null,
};

function media(id: string, role: Media["role"], availability: Media["availability"], created_at_ms: number): Media {
  const content_type = role === "Reference" ? "image/jpeg" : "image/png";
  return { id, role, availability, created_at_ms, content_type, width: imageWidth, height: imageHeight,
    byte_length: sampleImage(content_type).byteLength };
}

const registered = sampleTime - 3_600_000;
export const sampleObject: LostObject = {
  id: "sample-wallet", name: "Black wallet", status: "Lost", registered_at_ms: registered, found_at_ms: null,
  roi: { x: 7, y: 5, width: 18, height: 14 },
  reference_media: { ...media("sample-wallet-reference", "Reference", "Available", registered), role: "Reference" },
  revision: 1, expires_at_ms: registered + 7 * day, retention_grace: false,
};

export const foundObject: LostObject = {
  ...sampleObject, id: "sample-headphones", name: "Headphones", status: "Found",
  registered_at_ms: registered - day, expires_at_ms: registered + 6 * day, found_at_ms: sampleTime - 180_000, revision: 2,
  reference_media: { ...media("sample-headphones-reference", "Reference", "Corrupt", registered - day), role: "Reference" },
};
export const expiredObject: LostObject = {
  ...sampleObject, id: "sample-expired", name: "Sample expired object",
  registered_at_ms: sampleTime - 8 * day, expires_at_ms: sampleTime - day,
  reference_media: { ...media("sample-expired-reference", "Reference", "Available", sampleTime - 8 * day), role: "Reference" },
};
export const missingMedia = media("sample-missing-evidence", "Evidence", "Missing", sampleTime - 75_000);

export const sampleSession: Extract<Session, { state: "Ended" }> = {
  id: "sample-search", object_id: sampleObject.id, state: "Ended", end_reason: "Stopped", control_mode: "Controller",
  started_at_ms: sampleTime - 120_000, ended_at_ms: sampleTime - 60_000, revision: 4, pause_causes: [],
};
export const foundSession: Extract<Session, { state: "Ended" }> = {
  ...sampleSession, id: "sample-confirmed-search", object_id: foundObject.id, end_reason: "Confirmed",
  started_at_ms: sampleTime - 240_000, ended_at_ms: foundObject.found_at_ms,
};
export const searching: Extract<Session, { state: "Searching" }> = {
  ...sampleSession, state: "Searching", ended_at_ms: null, end_reason: null, revision: 1, pause_causes: [],
};
export const paused: Extract<Session, { state: "Paused" }> = {
  ...searching, state: "Paused", revision: 2, pause_causes: [{ cause: "ManualPause", failure_id: null }],
};

const rejectedAt = sampleTime - 100_000;
export const rejected: Match = {
  id: "sample-rejected", session_id: sampleSession.id, object_id: sampleObject.id,
  captured_at_ms: rejectedAt, frame_id: "sample-rejected-frame", stream_epoch: "fixture-robot-stream",
  box: sampleObject.roi, disposition: "Rejected", reviewed_at_ms: rejectedAt + 1000,
  evidence_media: { ...media("sample-rejected-evidence", "Evidence", "Available", rejectedAt), role: "Evidence", content_type: "image/png" },
};
export const notReviewed: Match = {
  ...rejected, id: "sample-not-reviewed", captured_at_ms: missingMedia.created_at_ms, frame_id: "sample-unreviewed-frame",
  disposition: "NotReviewed", reviewed_at_ms: null,
  evidence_media: { ...missingMedia, role: "Evidence", content_type: "image/png" },
};
export const confirmed: Match = {
  ...rejected, id: "sample-confirmed", session_id: foundSession.id, object_id: foundObject.id,
  captured_at_ms: sampleTime - 181_000, frame_id: "sample-confirmed-frame",
  disposition: "Confirmed", reviewed_at_ms: foundObject.found_at_ms,
  evidence_media: { ...media("sample-confirmed-evidence", "Evidence", "Available", sampleTime - 181_000), role: "Evidence", content_type: "image/png" },
};
export const pending: Match = {
  ...notReviewed, id: "sample-candidate", frame_id: "sample-candidate-frame", disposition: "Pending",
  evidence_media: { ...media("sample-pending-evidence", "Evidence", "Available", notReviewed.captured_at_ms), role: "Evidence", content_type: "image/png" },
};

const sharedComponents: ComponentName[] = [
  "Backend", "Storage", "Command", "RobotVideo", "DisplayedRobotVideo", "AI", "Workspace", "QualificationProfile",
];

export function readiness(
  statuses: Partial<Record<ComponentName, Component["status"]>>,
  profile: FrontendProfile | null,
  session: Session | null,
  canControl: boolean,
  recoverySatisfied = false,
): Snapshot["readiness"] {
  const components = Object.fromEntries(componentNames.map((component) => {
    const status = statuses[component] ?? "Ready";
    const cause_codes: ErrorCode[] = status === "Ready" ? [] : [status === "Initializing" ? "INITIALIZING" : "NOT_READY"];
    return [component, { component, status, cause_codes }];
  })) as Record<ComponentName, Component>;
  const sharedReady = profile !== null && canControl && sharedComponents.every((name) => components[name].status === "Ready");
  const gesturesReady = sharedReady && components.Webcam.status === "Ready";
  const controllerReady = sharedReady && components.Controller.status === "Ready";
  return {
    components: [
      components.Backend, components.Storage, components.Command, components.RobotVideo, components.DisplayedRobotVideo,
      components.Webcam, components.Controller, components.AI, components.Workspace, components.QualificationProfile,
    ],
    can_start: { Gestures: !session && gesturesReady, Controller: !session && controllerReady },
    can_resume: !!session && session.state === "Paused" && recoverySatisfied &&
      (session.control_mode === "Gestures" ? gesturesReady : controllerReady),
  };
}

export const snapshot: Snapshot = {
  protocol_version: 1, backend_boot_id: bootId, event_seq: 1, active_object: null, active_session: null,
  runtime: { effective_session_state: null, motion_permission: "Disarmed", control_generation: 1, persistence_pending: false },
  readiness: readiness({
    Command: "Unavailable", RobotVideo: "Unavailable", DisplayedRobotVideo: "Unavailable", Webcam: "Unavailable",
    Controller: "Unavailable", AI: "Unavailable", Workspace: "Unavailable", QualificationProfile: "Unavailable",
  }, null, null, false),
  failures: [], pending_candidate: null,
  lease: { state: "Unowned", owner_client_id: null, control_generation: 1, can_acquire: false },
  proximity: { state: "Unknown", warning_latched: false, distance_mm: null, sample_seq: null, source_epoch: null, observed_at_ms: null },
  retention: {
    settings, deletion: { status: "Complete", remaining_objects: 0, remaining_files: 0, error_code: null },
    active_object_expires_at_ms: null, active_object_grace: false,
  },
  operations: [], qualification_profile_id: null, qualification_profile: null,
};

export const warning: Proximity = {
  state: "Warning", warning_latched: true, distance_mm: 150, source_epoch: "fixture-proximity", sample_seq: 1, observed_at_ms: sampleTime - 1,
};
export const clear: Proximity = { ...warning, state: "Clear", warning_latched: false, distance_mm: 500, sample_seq: 2, observed_at_ms: sampleTime };

export const recoveryFailure: Failure = {
  failure_id: "fixture-emergency-failure", session_id: sampleSession.id, cause: "EmergencyStop",
  observed_at_ms: sampleTime, restored: false, acknowledged: false,
};

export function healthFor(state: Snapshot, initialization: Health["initialization"]): Health {
  const effective = state.runtime.effective_session_state;
  const active_session_state = effective === "Ended" ? null : effective;
  return {
    backend_boot_id: bootId, process_status: initialization === "Ready" ? "Healthy" : "Degraded", initialization,
    storage_integrity: initialization === "Ready" ? "Healthy" : initialization === "Starting" ? "Reconciling" : "Unavailable",
    readiness: state.readiness, active_session_state,
    operational_state: initialization === "Failed" ? "Faulted" : initialization === "Starting" ? "Reconciling" : active_session_state ?? "Idle",
  };
}
