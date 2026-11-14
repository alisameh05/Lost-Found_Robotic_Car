export function readConfig() {
  const rawPort = process.env.LAF_BACKEND_PORT ?? "8000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("LAF_BACKEND_PORT must be an integer from 1 to 65535.");
  }
  return {
    fixtureEnabled: process.env.LAF_MODE === "fixture",
    backendBaseUrl: `http://127.0.0.1:${port}/api/v1`,
  };
}
