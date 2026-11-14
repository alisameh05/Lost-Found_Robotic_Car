import type { BootstrapResponse, ComponentName, Object as LostObject, Session, Snapshot } from "@/generated/api-v1";

const sampleTime = Date.UTC(2026, 10, 13, 12);
const bootId = "fixture-boot";

// Use the null profile permitted by the contract so control remains unavailable.
export const bootstrapFacts: Omit<BootstrapResponse, "client_id" | "capability"> = {
  backend_boot_id: bootId,
  server_time_ms: sampleTime,
  qualification_profile: null,
};

export const sampleObject: LostObject = {
  id: "sample-wallet",
  name: "Black wallet",
  status: "Lost",
  registered_at_ms: sampleTime - 3_600_000,
  found_at_ms: null,
  roi: { x: 0, y: 0, width: 120, height: 80 },
  reference_media: {
    id: "sample-wallet-reference",
    role: "Reference",
    content_type: "image/jpeg",
    width: 120,
    height: 80,
    byte_length: 1024,
    created_at_ms: sampleTime - 3_600_000,
    availability: "Missing",
  },
  revision: 1,
  expires_at_ms: sampleTime - 3_600_000 + 7 * 86_400_000,
  retention_grace: false,
};

export const sampleSession: Session = {
  id: "sample-search",
  object_id: sampleObject.id,
  state: "Ended",
  end_reason: "Stopped",
  control_mode: "Controller",
  started_at_ms: sampleTime - 120_000,
  ended_at_ms: sampleTime - 60_000,
  revision: 2,
  pause_causes: [],
};

const componentStatuses: Record<ComponentName, Snapshot["readiness"]["components"][number]["status"]> = {
  Backend: "Ready",
  Storage: "Ready",
  Command: "Unavailable",
  RobotVideo: "Unavailable",
  DisplayedRobotVideo: "Unavailable",
  Webcam: "Unavailable",
  Controller: "Unavailable",
  AI: "Unavailable",
  Workspace: "Unavailable",
  QualificationProfile: "Unavailable",
};

export const snapshot: Snapshot = {
  protocol_version: 1,
  backend_boot_id: bootId,
  event_seq: 1,
  active_object: null,
  active_session: null,
  runtime: { effective_session_state: null, motion_permission: "Disarmed", control_generation: 1, persistence_pending: false },
  readiness: {
    components: (Object.keys(componentStatuses) as ComponentName[]).map((component) => ({
      component,
      status: componentStatuses[component],
      cause_codes: componentStatuses[component] === "Unavailable" ? ["NOT_READY"] : [],
    })),
    can_start: { Gestures: false, Controller: false },
    can_resume: false,
  },
  failures: [],
  pending_candidate: null,
  lease: { state: "Unowned", owner_client_id: null, control_generation: 1, can_acquire: false },
  proximity: { state: "Unknown", warning_latched: false, distance_mm: null, sample_seq: null, source_epoch: null, observed_at_ms: null },
  retention: {
    settings: { retention_days: 7, revision: 1, updated_at_ms: sampleTime },
    deletion: { status: "Complete", remaining_objects: 0, remaining_files: 0, error_code: null },
    active_object_expires_at_ms: null,
    active_object_grace: false,
  },
  operations: [],
  qualification_profile_id: null,
  qualification_profile: null,
};
