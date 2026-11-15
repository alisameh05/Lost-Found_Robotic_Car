import type { BootstrapResponse, Error as ApiError, Health, Match, Object as LostObject, Session, Snapshot } from "@/generated/api-v1";
import {
  bootstrapFacts, clear, confirmed, earlierWalletMatches, earlierWalletSessions, expiredObject, expiredSession,
  fixtureProfile, foundObject, foundSession, foundWallet, healthFor, interruptedSession, libraryRecords, notReviewed, paused,
  pending, readiness, recoveryFailure, rejected, sampleObject, sampleSession, searching, snapshot, walletConfirmed,
  walletConfirmedSession, warning,
} from "./samples";

type Scenario = {
  bootstrap: BootstrapResponse;
  snapshot: Snapshot;
  health: Health;
  objects: readonly LostObject[];
  sessions: readonly Session[];
  matches: readonly Match[];
  snapshotError?: ApiError;
  snapshotErrorOnce?: boolean;
  recordsRecovery?: boolean;
  historyRecovery?: boolean;
  dashboardRecovery?: boolean;
  emergency: "Committed" | "Pending" | "Failed" | "network";
};

const history = [notReviewed, rejected, confirmed];
const initial: Scenario = {
  bootstrap: bootstrapFacts, snapshot, health: healthFor(snapshot, "Ready"), objects: libraryRecords,
  sessions: [sampleSession, interruptedSession, foundSession, expiredSession], matches: history, emergency: "Committed",
};

function withSnapshot(state: Snapshot, overrides: Partial<Scenario> = {}, initialization: Health["initialization"] = "Ready"): Scenario {
  return {
    ...initial, bootstrap: { ...bootstrapFacts, qualification_profile: state.qualification_profile },
    snapshot: state, health: healthFor(state, initialization), ...overrides,
  };
}

const compatible = { ...snapshot, qualification_profile: fixtureProfile, qualification_profile_id: fixtureProfile.profile_id };
const owned = { ...compatible, lease: { state: "Owned", owner_client_id: bootstrapFacts.client_id, control_generation: 1, can_acquire: false } } satisfies Snapshot;
const controllerReady = { Webcam: "Unavailable" } as const;
const gesturesReady = { Controller: "Unavailable" } as const;

function active(session: typeof searching | typeof paused, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    ...owned, active_object: sampleObject, active_session: session,
    runtime: { ...snapshot.runtime, effective_session_state: session.state },
    readiness: readiness(controllerReady, fixtureProfile, session, true),
    retention: { ...snapshot.retention, active_object_expires_at_ms: sampleObject.expires_at_ms },
    ...overrides,
  };
}

const searchingState = active(searching);
const pausedState = active(paused);
const snapshotReadFailure = {
  snapshotError: { code: "INTERNAL_ERROR", message: "Sample snapshot could not be read.", retryable: true },
  snapshotErrorOnce: true,
} satisfies Partial<Scenario>;
const graceObject = { ...expiredObject, retention_grace: true };
const graceSession = { ...paused, id: "sample-grace-search", object_id: graceObject.id };
const graceMatch: Match = {
  ...rejected, id: "sample-grace-match", session_id: graceSession.id, object_id: graceObject.id,
  frame_id: "sample-grace-frame", evidence_media: { ...rejected.evidence_media, id: "sample-grace-evidence" },
};
// Equal millisecond timestamps exercise the descending ASCII tie-breaker on both history routes.
const confirmationTieSessions = Array.from({ length: 5 }, (_, index): Session => ({
  ...foundSession, id: `sample-tied-session-${index}`, end_reason: "Stopped", ended_at_ms: foundSession.started_at_ms,
}));
const confirmationTieMatches = Array.from({ length: 5 }, (_, index): Match => ({
  ...rejected, id: `sample-tied-match-${index}`, frame_id: `sample-tied-frame-${index}`,
  session_id: foundSession.id, object_id: foundObject.id,
  captured_at_ms: confirmed.captured_at_ms, reviewed_at_ms: confirmed.captured_at_ms,
  evidence_media: { ...rejected.evidence_media, id: `sample-tied-evidence-${index}`, created_at_ms: confirmed.captured_at_ms },
}));
const candidateSession: typeof paused = { ...paused, pause_causes: [{ cause: "CandidateReview", failure_id: null }] };
const recoverySession: typeof paused = {
  ...paused, revision: 3, pause_causes: [{ cause: "RecoveryRequired", failure_id: recoveryFailure.failure_id }],
};
const dashboardTies = [
  { ...sampleSession, id: "sample-tied-search-a", object_id: libraryRecords[1].id },
  { ...sampleSession, id: "sample-tied-search-Z", object_id: foundObject.id },
];

const scenarios = {
  idle: initial,
  initializing: withSnapshot({
    ...snapshot, readiness: readiness({
      Backend: "Initializing", Storage: "Initializing", Workspace: "Unavailable", Command: "Unavailable",
      RobotVideo: "Unavailable", DisplayedRobotVideo: "Unavailable", AI: "Unavailable", QualificationProfile: "Unavailable",
      Webcam: "Unavailable", Controller: "Unavailable",
    }, null, null, false),
  }, {}, "Starting"),
  searching: withSnapshot(searchingState, { sessions: [searching, foundSession], matches: [confirmed] }),
  paused: withSnapshot({ ...pausedState, proximity: warning }, { sessions: [paused, foundSession], matches: [confirmed] }),
  ended: withSnapshot({ ...compatible, proximity: clear }),
  failed: withSnapshot({
    ...snapshot, readiness: readiness({
      ...Object.fromEntries(snapshot.readiness.components.map(({ component, status }) => [component, status])),
      Storage: "Unavailable",
    }, null, null, false),
  }, { snapshotError: { code: "STORAGE_UNAVAILABLE", message: "Sample storage is unavailable.", retryable: true } }, "Failed"),
  empty: withSnapshot(snapshot, { objects: [], sessions: [], matches: [] }),
  "dashboard-recovery": withSnapshot(snapshot, {
    dashboardRecovery: true, sessions: [...initial.sessions, ...dashboardTies, ...earlierWalletSessions],
  }),
  "registration-recovery": initial,
  "records-recovery": withSnapshot(snapshot, {
    recordsRecovery: true,
    objects: libraryRecords.map((record) => ["sample-keys-a", "sample-keys-Z", "sample-usb"].includes(record.id)
      ? { ...record, reference_media: { ...record.reference_media, availability: "Available" } }
      : record),
  }),
  "history-recovery": withSnapshot(snapshot, {
    historyRecovery: true, sessions: [...initial.sessions, ...earlierWalletSessions],
    matches: [...history, ...earlierWalletMatches],
  }),
  "found-evidence": withSnapshot(snapshot, {
    objects: libraryRecords.map((object) => object.id === foundWallet.id ? foundWallet : object),
    sessions: [walletConfirmedSession, ...initial.sessions, ...earlierWalletSessions],
    matches: [...history, walletConfirmed],
  }),
  "missing-confirmation-media": withSnapshot(snapshot, {
    sessions: [...initial.sessions, ...confirmationTieSessions],
    matches: [
      ...history.filter(({ id }) => id !== confirmed.id), ...confirmationTieMatches,
      { ...confirmed, reviewed_at_ms: foundSession.ended_at_ms - 2, evidence_media: { ...confirmed.evidence_media, availability: "Missing" } },
    ],
  }),
  "controller-ready": withSnapshot({ ...owned, readiness: readiness(controllerReady, fixtureProfile, null, true) }),
  "gestures-ready": withSnapshot({ ...owned, readiness: readiness(gesturesReady, fixtureProfile, null, true) }),
  "camera-unavailable": withSnapshot({
    ...owned, readiness: readiness({
      ...gesturesReady, RobotVideo: "Unavailable", DisplayedRobotVideo: "Unavailable",
    }, fixtureProfile, null, true),
  }, snapshotReadFailure),
  "active-readiness-retry": withSnapshot(pausedState, { ...snapshotReadFailure, sessions: [paused, foundSession], matches: [confirmed] }),
  candidate: withSnapshot({ ...active(candidateSession), pending_candidate: pending }, {
    sessions: [candidateSession, foundSession], matches: [pending, rejected, confirmed],
  }),
  "pause-saving": withSnapshot({
    ...searchingState,
    runtime: { ...searchingState.runtime, effective_session_state: "Paused", persistence_pending: true },
  }, { sessions: [searching, foundSession], matches: [confirmed] }),
  recovery: withSnapshot({ ...active(recoverySession), failures: [recoveryFailure] }, {
    sessions: [recoverySession, foundSession], matches: [confirmed],
  }),
  restored: withSnapshot({ ...active(recoverySession), failures: [{ ...recoveryFailure, restored: true }] }, {
    sessions: [recoverySession, foundSession], matches: [confirmed],
  }),
  acknowledged: withSnapshot({
    ...active(recoverySession), failures: [{ ...recoveryFailure, restored: true, acknowledged: true }],
    readiness: readiness(controllerReady, fixtureProfile, recoverySession, true, true),
  }, { sessions: [recoverySession, foundSession], matches: [confirmed] }),
  "expiry-grace": withSnapshot(active(graceSession, {
    active_object: graceObject,
    retention: { ...snapshot.retention, active_object_expires_at_ms: graceObject.expires_at_ms, active_object_grace: true },
  }), {
    objects: [sampleObject, foundObject, graceObject], sessions: [graceSession, ...initial.sessions],
    matches: [...history, graceMatch],
  }),
  "deletion-failed": withSnapshot({
    ...snapshot,
    readiness: readiness(Object.fromEntries(snapshot.readiness.components.map(({ component, status }) =>
      [component, component === "Storage" ? "Unavailable" : status])), null, null, false),
    retention: { ...snapshot.retention,
      deletion: { status: "Failed", remaining_objects: 1, remaining_files: 2, error_code: "STORAGE_UNAVAILABLE" },
    },
  }, {}, "Failed"),
  "emergency-pending": withSnapshot(searchingState, { emergency: "Pending", sessions: [searching, foundSession], matches: [confirmed] }),
  "emergency-failed": withSnapshot(searchingState, { emergency: "Failed", sessions: [searching, foundSession], matches: [confirmed] }),
  "emergency-network": withSnapshot(searchingState, { emergency: "network", sessions: [searching, foundSession], matches: [confirmed] }),
} satisfies Record<string, Scenario>;

export type ScenarioId = keyof typeof scenarios;
export const scenarioIds = Object.keys(scenarios) as ScenarioId[];

export function readScenario(id: ScenarioId): Scenario {
  return structuredClone(scenarios[id]);
}
