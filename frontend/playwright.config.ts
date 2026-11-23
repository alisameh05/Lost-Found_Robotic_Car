import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    browserName: "chromium",
    viewport: process.env.LAF_TEST_NATIVE_DISPLAY === "1" ? null : { width: 1366, height: 768 },
  },
  webServer: [
    { command: "npm run start", url: "http://127.0.0.1:3100", env: { LAF_FRONTEND_PORT: "3100", LAF_MODE: "fixture", LAF_FIXTURE_HARNESS: "1" } },
    { command: "npm run start", url: "http://127.0.0.1:3101", env: { LAF_FRONTEND_PORT: "3101", LAF_MODE: "disconnected", LAF_FIXTURE_HARNESS: "1" } },
    { command: "npm run start", url: "http://127.0.0.1:3102", env: { LAF_FRONTEND_PORT: "3102", LAF_MODE: "fixture", LAF_FIXTURE_HARNESS: "0" } },
    // Clear any inherited mode so the connected suite exercises normal startup.
    { command: "npm run start", url: "http://127.0.0.1:3103", env: { LAF_FRONTEND_PORT: "3103", LAF_MODE: "", LAF_BACKEND_PORT: "8110" } },
  ],
});
