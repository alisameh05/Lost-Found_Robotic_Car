// Generated from docs/API.md v1.0 (SHA-256 944c12c922bd5109c83a30c80df0f7622e5bb03a0a11636ad2b29edf47348ee6). Do not edit.

/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Id".
 */
export type Id = string;
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Token".
 */
export type Token = string;
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "UtcMs".
 */
export type UtcMs = number;
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RequestId".
 */
export type RequestId = string;
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Counter".
 */
export type Counter = number;
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "PublicLease".
 */
export type PublicLease =
  | {
      state: "Unowned";
      owner_client_id: null;
      control_generation: Counter;
      can_acquire: boolean;
    }
  | {
      state: "Owned";
      owner_client_id: Id;
      control_generation: Counter;
      can_acquire: false;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Object".
 */
export type Object =
  | {
      id: Id;
      name: Name;
      status: "Lost";
      registered_at_ms: UtcMs;
      found_at_ms: null;
      revision: Counter;
      roi: Rect;
      reference_media: {
        id: Id;
        role: "Reference";
        content_type: "image/jpeg" | "image/png";
        width: number;
        height: number;
        byte_length: number;
        created_at_ms: UtcMs;
        availability: "Available" | "Missing" | "Corrupt";
      };
      expires_at_ms: UtcMs;
      retention_grace: boolean;
    }
  | {
      id: Id;
      name: Name;
      status: "Found";
      registered_at_ms: UtcMs;
      found_at_ms: UtcMs;
      revision: Counter;
      roi: Rect;
      reference_media: {
        id: Id;
        role: "Reference";
        content_type: "image/jpeg" | "image/png";
        width: number;
        height: number;
        byte_length: number;
        created_at_ms: UtcMs;
        availability: "Available" | "Missing" | "Corrupt";
      };
      expires_at_ms: UtcMs;
      retention_grace: boolean;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Name".
 */
export type Name = string;
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Session".
 */
export type Session =
  | {
      id: Id;
      object_id: Id;
      control_mode: ControlMode;
      state: "Searching";
      started_at_ms: UtcMs;
      ended_at_ms: null;
      end_reason: null;
      revision: Counter;
      /**
       * @minItems 0
       * @maxItems 0
       */
      pause_causes: [];
    }
  | {
      id: Id;
      object_id: Id;
      control_mode: ControlMode;
      state: "Paused";
      started_at_ms: UtcMs;
      ended_at_ms: null;
      end_reason: null;
      revision: Counter;
      pause_causes: PauseCause[];
    }
  | {
      id: Id;
      object_id: Id;
      control_mode: ControlMode;
      state: "Ended";
      started_at_ms: UtcMs;
      ended_at_ms: UtcMs;
      end_reason: EndReason;
      revision: Counter;
      /**
       * @minItems 0
       * @maxItems 0
       */
      pause_causes: [];
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "ControlMode".
 */
export type ControlMode = "Gestures" | "Controller";
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "PauseCause".
 */
export type PauseCause =
  | {
      cause: "ManualPause";
      failure_id: null;
    }
  | {
      cause: "CandidateReview";
      failure_id: null;
    }
  | {
      cause: "ReviewRejected";
      failure_id: null;
    }
  | {
      cause: "RecoveryRequired";
      failure_id: Id;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "EndReason".
 */
export type EndReason = "Confirmed" | "Stopped" | "Interrupted";
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Match".
 */
export type Match =
  | {
      id: Id;
      session_id: Id;
      object_id: Id;
      captured_at_ms: UtcMs;
      frame_id: Id;
      stream_epoch: Id;
      box: Rect;
      disposition: "Pending";
      reviewed_at_ms: null;
      evidence_media: {
        id: Id;
        role: "Evidence";
        content_type: "image/png";
        width: number;
        height: number;
        byte_length: number;
        created_at_ms: UtcMs;
        availability: "Available" | "Missing" | "Corrupt";
      };
    }
  | {
      id: Id;
      session_id: Id;
      object_id: Id;
      captured_at_ms: UtcMs;
      frame_id: Id;
      stream_epoch: Id;
      box: Rect;
      disposition: "Confirmed";
      reviewed_at_ms: UtcMs;
      evidence_media: {
        id: Id;
        role: "Evidence";
        content_type: "image/png";
        width: number;
        height: number;
        byte_length: number;
        created_at_ms: UtcMs;
        availability: "Available" | "Missing" | "Corrupt";
      };
    }
  | {
      id: Id;
      session_id: Id;
      object_id: Id;
      captured_at_ms: UtcMs;
      frame_id: Id;
      stream_epoch: Id;
      box: Rect;
      disposition: "Rejected";
      reviewed_at_ms: UtcMs;
      evidence_media: {
        id: Id;
        role: "Evidence";
        content_type: "image/png";
        width: number;
        height: number;
        byte_length: number;
        created_at_ms: UtcMs;
        availability: "Available" | "Missing" | "Corrupt";
      };
    }
  | {
      id: Id;
      session_id: Id;
      object_id: Id;
      captured_at_ms: UtcMs;
      frame_id: Id;
      stream_epoch: Id;
      box: Rect;
      disposition: "NotReviewed";
      reviewed_at_ms: null;
      evidence_media: {
        id: Id;
        role: "Evidence";
        content_type: "image/png";
        width: number;
        height: number;
        byte_length: number;
        created_at_ms: UtcMs;
        availability: "Available" | "Missing" | "Corrupt";
      };
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "DeletionProgress".
 */
export type DeletionProgress =
  | {
      status: "Pending";
      remaining_objects: number;
      remaining_files: number;
      error_code: null;
    }
  | {
      status: "Complete";
      remaining_objects: 0;
      remaining_files: 0;
      error_code: null;
    }
  | {
      status: "Failed";
      remaining_objects: number;
      remaining_files: number;
      error_code: ErrorCode;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Operation".
 */
export type Operation =
  | {
      action_id: RequestId;
      request_id: null;
      persistence: "Pending";
      result: null;
      error: null;
    }
  | {
      action_id: null;
      request_id: RequestId;
      persistence: "Pending";
      result: null;
      error: null;
    }
  | {
      action_id: RequestId;
      request_id: null;
      persistence: "Committed";
      result: MutationResult;
      error: null;
    }
  | {
      action_id: null;
      request_id: RequestId;
      persistence: "Committed";
      result: MutationResult;
      error: null;
    }
  | {
      action_id: RequestId;
      request_id: null;
      persistence: "Failed";
      result: null;
      error: Error;
    }
  | {
      action_id: null;
      request_id: RequestId;
      persistence: "Failed";
      result: null;
      error: Error;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "MutationResponse".
 */
export type MutationResponse =
  | {
      action_id: RequestId;
      persistence: "Pending";
      result: null;
      error: null;
    }
  | {
      action_id: RequestId;
      persistence: "Committed";
      result: MutationResult;
      error: null;
    }
  | {
      action_id: RequestId;
      persistence: "Failed";
      result: null;
      error: Error;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "EmergencyStopResponse".
 */
export type EmergencyStopResponse =
  | {
      request_id: RequestId;
      backend_boot_id: Id;
      permission_revoked: true;
      session_id: Id | null;
      failure_id: Id | null;
      persistence: "Pending";
      error: null;
    }
  | {
      request_id: RequestId;
      backend_boot_id: Id;
      permission_revoked: true;
      session_id: Id | null;
      failure_id: Id | null;
      persistence: "Committed";
      error: null;
    }
  | {
      request_id: RequestId;
      backend_boot_id: Id;
      permission_revoked: true;
      session_id: Id | null;
      failure_id: Id | null;
      persistence: "Failed";
      error: Error;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Channel".
 */
export type Channel = "events" | "robot-video" | "webcam-video";
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "SessionAction".
 */
export type SessionAction =
  | {
      action_id: RequestId;
      session_id: Id;
      expected_revision: Counter;
      action: "pause";
      client_id: Id;
      client_lease_id: Token;
      candidate_id?: never;
      failure_ids?: never;
    }
  | {
      action_id: RequestId;
      session_id: Id;
      expected_revision: Counter;
      action: "resume";
      client_id: Id;
      client_lease_id: Token;
      candidate_id?: never;
      failure_ids?: never;
    }
  | {
      action_id: RequestId;
      session_id: Id;
      expected_revision: Counter;
      action: "stop";
      client_id: Id;
      client_lease_id: Token;
      candidate_id?: never;
      failure_ids?: never;
    }
  | {
      action_id: RequestId;
      session_id: Id;
      expected_revision: Counter;
      action: "acknowledge";
      client_id: Id;
      client_lease_id: Token;
      candidate_id?: never;
      /**
       * @minItems 1
       * @maxItems 64
       */
      failure_ids: [Id, ...Id[]];
    }
  | {
      action_id: RequestId;
      session_id: Id;
      expected_revision: Counter;
      action: "confirm";
      client_id: Id;
      client_lease_id: Token;
      candidate_id: Id;
      failure_ids?: never;
    }
  | {
      action_id: RequestId;
      session_id: Id;
      expected_revision: Counter;
      action: "reject";
      client_id: Id;
      client_lease_id: Token;
      candidate_id: Id;
      failure_ids?: never;
    };
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "EventEnvelope".
 */
export type EventEnvelope =
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "snapshot";
      occurred_at_ms: UtcMs;
      payload: Snapshot;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "session_changed";
      occurred_at_ms: UtcMs;
      payload: SessionChanged;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "readiness_changed";
      occurred_at_ms: UtcMs;
      payload: ReadinessChanged;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "candidate_pending";
      occurred_at_ms: UtcMs;
      payload: CandidatePending;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "recovery_changed";
      occurred_at_ms: UtcMs;
      payload: RecoveryChanged;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "retention_changed";
      occurred_at_ms: UtcMs;
      payload: RetentionChanged;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "object_removed";
      occurred_at_ms: UtcMs;
      payload: ObjectRemoved;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "storage_fault";
      occurred_at_ms: UtcMs;
      payload: StorageFault;
    }
  | {
      protocol_version: 1;
      backend_boot_id: Id;
      event_seq: Counter;
      session_id: Id | null;
      session_revision: Counter | null;
      type: "proximity_warning_changed";
      occurred_at_ms: UtcMs;
      payload: ProximityWarningChanged;
    };

export interface HttpResponses {
  "GET /bootstrap": BootstrapResponse;
  "POST /websocket-tickets": TicketResponse;
  "POST /control-lease": LeaseResponse;
  "POST /control-lease/release": LeaseResponse;
  "GET /health": Health;
  "GET /snapshot": Snapshot;
  "GET /objects": ObjectPage;
  "POST /objects": MutationResponse;
  "GET /objects/{id}": Object;
  "GET /objects/{id}/sessions": SessionPage;
  "POST /sessions": MutationResponse;
  "GET /sessions/{id}": Session;
  "GET /sessions/{id}/matches": MatchPage;
  "POST /sessions/{id}/actions": MutationResponse;
  "POST /emergency-stop": EmergencyStopResponse;
  "GET /settings": Settings;
  "POST /settings/retention-preview": RetentionPreview;
  "PUT /settings/retention": MutationResponse;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "TicketResponse".
 */
export interface TicketResponse {
  ticket: Token;
  expires_at_ms: UtcMs;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "LeaseResponse".
 */
export interface LeaseResponse {
  request_id: RequestId;
  client_lease_id: Token | null;
  control_generation: Counter;
  lease: PublicLease;
  snapshot: Snapshot;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Rect".
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RuntimeState".
 */
export interface RuntimeState {
  effective_session_state: ("Searching" | "Paused" | "Ended") | null;
  motion_permission: "Disarmed" | "Arming" | "Armed";
  control_generation: Counter;
  persistence_pending: boolean;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Readiness".
 */
export interface Readiness {
  /**
   * @minItems 10
   * @maxItems 10
   */
  components: [
    Component,
    Component,
    Component,
    Component,
    Component,
    Component,
    Component,
    Component,
    Component,
    Component
  ];
  can_start: {
    Gestures: boolean;
    Controller: boolean;
  };
  can_resume: boolean;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Component".
 */
export interface Component {
  component: ComponentName;
  status: "Ready" | "Initializing" | "Unavailable";
  cause_codes: ErrorCode[];
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RetentionState".
 */
export interface RetentionState {
  settings: Settings;
  active_object_expires_at_ms: UtcMs | null;
  active_object_grace: boolean;
  deletion: DeletionProgress;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Settings".
 */
export interface Settings {
  retention_days: number;
  revision: Counter;
  updated_at_ms: UtcMs;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "Health".
 */
export interface Health {
  backend_boot_id: Id;
  process_status: "Healthy" | "Degraded";
  initialization: "Starting" | "Ready" | "Failed";
  storage_integrity: "Healthy" | "Reconciling" | "Unavailable";
  readiness: Readiness;
  active_session_state: ("Searching" | "Paused") | null;
  operational_state: "Idle" | "Searching" | "Paused" | "Reconciling" | "Faulted";
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "SessionPage".
 */
export interface SessionPage {
  /**
   * @maxItems 100
   */
  items: Session[];
  next_cursor: Token | null;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "MatchPage".
 */
export interface MatchPage {
  /**
   * @maxItems 100
   */
  items: Match[];
  next_cursor: Token | null;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RetentionPreview".
 */
export interface RetentionPreview {
  preview_id: Id;
  settings_revision: Counter;
  retention_days: number;
  evaluated_at_ms: UtcMs;
  expires_at_ms: UtcMs;
  impact: RetentionImpact;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RetentionImpact".
 */
export interface RetentionImpact {
  objects: number;
  sessions: number;
  matches: number;
  managed_image_bytes: number;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
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
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "TicketRequest".
 */
export interface TicketRequest {
  client_id: Id;
  channel: Channel;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "LeaseAcquire".
 */
export interface LeaseAcquire {
  request_id: RequestId;
  client_id: Id;
  session_id: Id | null;
  takeover: boolean;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "LeaseRelease".
 */
export interface LeaseRelease {
  request_id: RequestId;
  client_id: Id;
  client_lease_id: Token;
  control_generation: Counter;
  session_id: Id | null;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "StartRequest".
 */
export interface StartRequest {
  action_id: RequestId;
  object_id: Id;
  expected_revision: Counter;
  control_mode: ControlMode;
  client_id: Id;
  client_lease_id: Token;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RegistrationFields".
 */
export interface RegistrationFields {
  action_id: RequestId;
  name: Name;
  roi: Rect;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RetentionPreviewRequest".
 */
export interface RetentionPreviewRequest {
  expected_revision: Counter;
  retention_days: number;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RetentionChange".
 */
export interface RetentionChange {
  action_id: RequestId;
  expected_revision: Counter;
  retention_days: number;
  preview_id: Id;
  confirmed: true;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "EmergencyStopRequest".
 */
export interface EmergencyStopRequest {
  request_id: RequestId;
  client_id?: Id;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "DisplayedFrame".
 */
export interface DisplayedFrame {
  frame_id: Id;
  stream_epoch: Id;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "WorkspaceHeartbeat".
 */
export interface WorkspaceHeartbeat {
  type: "workspace_heartbeat";
  protocol_version: 1;
  backend_boot_id: Id;
  client_id: Id;
  client_lease_id: Token;
  session_id: Id | null;
  control_generation: Counter;
  heartbeat_seq: Counter;
  workspace_visible: boolean;
  workspace_focused: boolean;
  workspace_operational: boolean;
  displayed_robot_frame: DisplayedFrame | null;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "FrameMetadata".
 */
export interface FrameMetadata {
  protocol_version: 1;
  source: "robot" | "webcam";
  stream_epoch: Id;
  capture_seq: Counter;
  frame_id: Id;
  width: number;
  height: number;
  received_at_ms: UtcMs;
  capture_age_bound_ms: number;
  source_capture_us: number;
  source_clock_epoch: Id;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "SessionChanged".
 */
export interface SessionChanged {
  session: Session;
  runtime: RuntimeState;
  operation: Operation | null;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "ReadinessChanged".
 */
export interface ReadinessChanged {
  readiness: Readiness;
  runtime: RuntimeState;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "CandidatePending".
 */
export interface CandidatePending {
  match: Match;
  control_generation: Counter;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RecoveryChanged".
 */
export interface RecoveryChanged {
  failures: Failure[];
  runtime: RuntimeState;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "RetentionChanged".
 */
export interface RetentionChanged {
  retention: RetentionState;
  operation: Operation | null;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "ObjectRemoved".
 */
export interface ObjectRemoved {
  object_id: Id;
  reason: "Expired";
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "StorageFault".
 */
export interface StorageFault {
  code: ErrorCode;
  message: string;
  operation: Operation | null;
  blocked_capabilities: ("Register" | "Start" | "Resume" | "Review" | "RetentionChange")[];
  deletion: DeletionProgress;
  runtime: RuntimeState;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "ProximityWarningChanged".
 */
export interface ProximityWarningChanged {
  proximity: Proximity;
}
/**
 * This interface was referenced by `HttpResponses`'s JSON-Schema
 * via the `definition` "QualificationProfile".
 */
export interface QualificationProfile {
  profile_id: Id;
  protocol_version: 1;
  evidence_kind: "Fixture" | "Device";
  evidence_manifest_sha256: string;
  device_protocol_manifest_sha256: string;
  max_header_bytes: number;
  max_frame_bytes: number;
  max_frame_width: number;
  max_frame_height: number;
  max_frame_pixels: number;
  max_event_message_bytes: number;
  max_client_message_bytes: number;
  event_queue_messages: number;
  event_queue_bytes: number;
  heartbeat_interval_ms: number;
  heartbeat_deadline_ms: number;
  display_deadline_ms: number;
  capture_age_limit_ms: number;
  clock_uncertainty_limit_us: number;
  camera_sync_interval_ms: number;
  camera_sync_max_rtt_us: number;
  input_sample_deadline_ms: number;
  command_ack_deadline_ms: number;
  serial_max_packet_bytes: number;
  serial_baud: number;
  command_renewal_interval_ms: number;
  challenge_lifetime_ms: number;
  firmware_expiry_ms: number;
  proximity_sample_deadline_ms: number;
  proximity_warning_mm: number;
  proximity_clear_mm: number;
  proximity_clear_samples: number;
  proximity_max_distance_mm: number;
}

export interface HttpBodies {
  "POST /websocket-tickets": TicketRequest;
  "POST /control-lease": LeaseAcquire;
  "POST /control-lease/release": LeaseRelease;
  "POST /objects": RegistrationFields;
  "POST /sessions": StartRequest;
  "POST /sessions/{id}/actions": SessionAction;
  "POST /emergency-stop": EmergencyStopRequest;
  "POST /settings/retention-preview": RetentionPreviewRequest;
  "PUT /settings/retention": RetentionChange;
}

export const componentNames = ["Backend","Storage","Command","RobotVideo","DisplayedRobotVideo","Webcam","Controller","AI","Workspace","QualificationProfile"] as const;
