// Generated from docs/API.md v1.0 (SHA-256 944c12c922bd5109c83a30c80df0f7622e5bb03a0a11636ad2b29edf47348ee6). Do not edit.

/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Id".
 */
export type Id = string;
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Token".
 */
export type Token = string;
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "UtcMs".
 */
export type UtcMs = number;
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Counter".
 */
export type Counter = number;
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Name".
 */
export type Name = string;
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "ControlMode".
 */
export type ControlMode = "Gestures" | "Controller";
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "EndReason".
 */
export type EndReason = "Confirmed" | "Stopped" | "Interrupted";
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "ComponentName".
 */
export type ComponentName =
  | "Backend"
  | "Storage"
  | "Command"
  | "RobotVideo"
  | "DisplayedRobotVideo"
  | "Webcam"
  | "Controller"
  | "AI"
  | "Workspace"
  | "QualificationProfile";
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "ErrorCode".
 */
export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_MULTIPART"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "HOST_REJECTED"
  | "ORIGIN_REJECTED"
  | "CAPABILITY_INVALID"
  | "CLIENT_INVALID"
  | "LEASE_REQUIRED"
  | "LEASE_EXPIRED"
  | "LEASE_OWNED"
  | "REVISION_CONFLICT"
  | "ACTION_ID_CONFLICT"
  | "REQUEST_ID_CONFLICT"
  | "ACTION_EXPIRED"
  | "INVALID_TRANSITION"
  | "ACTIVE_SESSION_EXISTS"
  | "PENDING_REVIEW"
  | "RECOVERY_REQUIRED"
  | "OWNERSHIP_MISMATCH"
  | "PREVIEW_STALE"
  | "CURSOR_INVALID"
  | "CURSOR_EXPIRED"
  | "NOT_FOUND"
  | "EXPIRED"
  | "MEDIA_UNAVAILABLE"
  | "NOT_READY"
  | "STORAGE_UNAVAILABLE"
  | "INITIALIZING"
  | "PROTOCOL_UNSUPPORTED"
  | "TICKET_INVALID"
  | "TICKET_EXPIRED"
  | "TICKET_CONSUMED"
  | "CAPACITY_REACHED"
  | "COUNTER_EXHAUSTED"
  | "INTERNAL_ERROR";
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "FailureCause".
 */
export type FailureCause =
  | "EmergencyStop"
  | "WorkspaceDisconnected"
  | "WorkspaceHidden"
  | "WorkspaceUnfocused"
  | "WorkspaceUnusable"
  | "HeartbeatExpired"
  | "DisplayStale"
  | "RobotVideoUnavailable"
  | "CameraEpochChanged"
  | "CommandUnavailable"
  | "CommandExpired"
  | "InputUnavailable"
  | "AIUnavailable"
  | "StorageFault"
  | "ProtocolMismatch";
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "RequestId".
 */
export type RequestId = string;

export interface GetResponses {
  "/bootstrap": BootstrapResponse;
  "/snapshot": Snapshot;
  "/objects": ObjectPage;
  "/objects/{id}": Object;
  "/objects/{id}/sessions": SessionPage;
  "/sessions/{id}": Session;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "BootstrapResponse".
 */
export interface BootstrapResponse {
  client_id: Id;
  backend_boot_id: Id;
  capability: Token;
  server_time_ms: UtcMs;
  qualification_profile: FrontendProfile | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "FrontendProfile".
 */
export interface FrontendProfile {
  profile_id: Id;
  protocol_version: 1;
  evidence_kind: "Fixture" | "Device";
  max_header_bytes: number;
  max_frame_bytes: number;
  max_frame_width: number;
  max_frame_height: number;
  max_frame_pixels: number;
  max_event_message_bytes: number;
  max_client_message_bytes: number;
  heartbeat_interval_ms: number;
  heartbeat_deadline_ms: number;
  display_deadline_ms: number;
  capture_age_limit_ms: number;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Snapshot".
 */
export interface Snapshot {
  protocol_version: 1;
  backend_boot_id: Id;
  event_seq: Counter;
  active_object: Object | null;
  active_session: Session | null;
  runtime: RuntimeState;
  readiness: Readiness;
  failures: Failure[];
  pending_candidate: Match | null;
  lease: PublicLease;
  proximity: Proximity;
  retention: RetentionState;
  /**
   * @maxItems 128
   */
  operations: Operation[];
  qualification_profile_id: Id | null;
  qualification_profile: FrontendProfile | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Object".
 */
export interface Object {
  id: Id;
  name: Name;
  status: "Lost" | "Found";
  registered_at_ms: UtcMs;
  found_at_ms: UtcMs | null;
  revision: Counter;
  roi: Rect;
  reference_media: Media;
  expires_at_ms: UtcMs;
  retention_grace: boolean;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Rect".
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Media".
 */
export interface Media {
  id: Id;
  role: "Reference" | "Evidence";
  content_type: "image/jpeg" | "image/png";
  width: number;
  height: number;
  byte_length: number;
  created_at_ms: UtcMs;
  availability: "Available" | "Missing" | "Corrupt";
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Session".
 */
export interface Session {
  id: Id;
  object_id: Id;
  control_mode: ControlMode;
  state: "Searching" | "Paused" | "Ended";
  started_at_ms: UtcMs;
  ended_at_ms: UtcMs | null;
  end_reason: EndReason | null;
  revision: Counter;
  pause_causes: PauseCause[];
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "PauseCause".
 */
export interface PauseCause {
  cause: "ManualPause" | "CandidateReview" | "ReviewRejected" | "RecoveryRequired";
  failure_id: Id | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "RuntimeState".
 */
export interface RuntimeState {
  effective_session_state: ("Searching" | "Paused" | "Ended") | null;
  motion_permission: "Disarmed" | "Arming" | "Armed";
  control_generation: Counter;
  persistence_pending: boolean;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Readiness".
 */
export interface Readiness {
  /**
   * @minItems 10
   * @maxItems 10
   */
  components: Component[];
  can_start: {
    Gestures: boolean;
    Controller: boolean;
  };
  can_resume: boolean;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Component".
 */
export interface Component {
  component: ComponentName;
  status: "Ready" | "Initializing" | "Unavailable";
  cause_codes: ErrorCode[];
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Failure".
 */
export interface Failure {
  failure_id: Id;
  session_id: Id | null;
  cause: FailureCause;
  observed_at_ms: UtcMs;
  restored: boolean;
  acknowledged: boolean;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Match".
 */
export interface Match {
  id: Id;
  session_id: Id;
  object_id: Id;
  captured_at_ms: UtcMs;
  frame_id: Id;
  stream_epoch: Id;
  box: Rect;
  disposition: "Pending" | "Confirmed" | "Rejected" | "NotReviewed";
  reviewed_at_ms: UtcMs | null;
  evidence_media: Media;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "PublicLease".
 */
export interface PublicLease {
  state: "Unowned" | "Owned";
  owner_client_id: Id | null;
  control_generation: Counter;
  can_acquire: boolean;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Proximity".
 */
export interface Proximity {
  state: "Unknown" | "Warning" | "Clear";
  warning_latched: boolean;
  distance_mm: number | null;
  sample_seq: Counter | null;
  source_epoch: Id | null;
  observed_at_ms: UtcMs | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "RetentionState".
 */
export interface RetentionState {
  settings: Settings;
  active_object_expires_at_ms: UtcMs | null;
  active_object_grace: boolean;
  deletion: DeletionProgress;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Settings".
 */
export interface Settings {
  retention_days: number;
  revision: Counter;
  updated_at_ms: UtcMs;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "DeletionProgress".
 */
export interface DeletionProgress {
  status: "Pending" | "Complete" | "Failed";
  remaining_objects: number;
  remaining_files: number;
  error_code: ErrorCode | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Operation".
 */
export interface Operation {
  action_id: RequestId | null;
  request_id: RequestId | null;
  persistence: "Pending" | "Committed" | "Failed";
  result: MutationResult | null;
  error: Error | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "MutationResult".
 */
export interface MutationResult {
  object: Object | null;
  session: Session | null;
  match: Match | null;
  settings: Settings | null;
  deletion: DeletionProgress | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "Error".
 */
export interface Error {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  revision?: Counter;
  snapshot?: Snapshot;
  /**
   * @maxItems 64
   */
  field_errors?: FieldError[];
  action_id?: RequestId;
  permission_revoked?: boolean;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "FieldError".
 */
export interface FieldError {
  path: string;
  code:
    | "REQUIRED"
    | "UNKNOWN_FIELD"
    | "INVALID_TYPE"
    | "INVALID_VALUE"
    | "OUT_OF_RANGE"
    | "DUPLICATE_FIELD"
    | "DUPLICATE_VALUE";
  message: string;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "ObjectPage".
 */
export interface ObjectPage {
  /**
   * @maxItems 100
   */
  items: Object[];
  next_cursor: Token | null;
}
/**
 * This interface was referenced by `GetResponses`'s JSON-Schema
 * via the `definition` "SessionPage".
 */
export interface SessionPage {
  /**
   * @maxItems 100
   */
  items: Session[];
  next_cursor: Token | null;
}
