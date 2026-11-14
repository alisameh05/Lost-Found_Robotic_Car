import type { BootstrapResponse, Error as ApiError, Health, Match, Object as LostObject, Session, Snapshot } from "@/generated/api-v1";
import {
  bootstrapFacts, clear, expiredObject, fixtureProfile, foundObject, foundSession, healthFor, notReviewed, paused,
  pending, readiness, recoveryFailure, rejected, sampleObject, sampleSession, searching, snapshot, warning, confirmed,
} from "./samples";

type Scenario = {
  bootstrap: BootstrapResponse;
  snapshot: Snapshot;
  health: Health;
  objects: readonly LostObject[];
  sessions: readonly Session[];
  matches: readonly Match[];
  snapshotError?: ApiError;
  emergency: "Committed" | "Pending" | "Failed" | "network";
};

const records = [sampleObject, foundObject];
const history = [notReviewed, rejected, confirmed];
const initial: Scenario = {
  bootstrap: bootstrapFacts, snapshot, health: healthFor(snapshot, "Ready"), objects: records,
  sessions: [sampleSession, foundSession], matches: history, emergency: "Committed",
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
const graceObject = { ...expiredObject, retention_grace: true };
const graceSession = { ...paused, id: "sample-grace-search", object_id: graceObject.id };
const candidateSession: typeof paused = { ...paused, pause_causes: [{ cause: "CandidateReview", failure_id: null }] };
const recoverySession: typeof paused = {
  ...paused, revision: 3, pause_causes: [{ cause: "RecoveryRequired", failure_id: recoveryFailure.failure_id }],
};

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
  "controller-ready": withSnapshot({ ...owned, readiness: readiness(controllerReady, fixtureProfile, null, true) }),
  "gestures-ready": withSnapshot({ ...owned, readiness: readiness(gesturesReady, fixtureProfile, null, true) }),
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
  }), { objects: [sampleObject, foundObject, graceObject], sessions: [graceSession, sampleSession, foundSession] }),
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
