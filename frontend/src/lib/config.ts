export const LOCAL_YOLOE_PROFILE = "local-yoloe-v1";
export const LOCAL_GESTURES_PROFILE = "local-gestures-v1";
export const LOCAL_CONTROLLER_PROFILE = "local-controller-v1";
export const PHASE_06_PROFILE = "phase-06-v1";

export function localSearchPaths(profileId?: string) {
  const integrated = profileId === PHASE_06_PROFILE;
  return {
    integrated,
    localMatching: integrated || profileId === LOCAL_YOLOE_PROFILE,
    localGestures: integrated || profileId === LOCAL_GESTURES_PROFILE,
    localController: integrated || profileId === LOCAL_CONTROLLER_PROFILE,
  };
}

export function isFixtureMode() {
  return process.env.LAF_MODE === "fixture";
}

export function fixtureHarnessEnabled() {
  return isFixtureMode() && process.env.LAF_FIXTURE_HARNESS === "1";
}

export function readConfig() {
  const rawPort = process.env.LAF_BACKEND_PORT ?? "8000";
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("LAF_BACKEND_PORT must be an integer from 1 to 65535.");
  }
  return {
    fixtureEnabled: isFixtureMode(),
    recordsEnabled: process.env.LAF_MODE === "records",
    backendBaseUrl: `http://127.0.0.1:${port}/api/v1`,
  };
}
