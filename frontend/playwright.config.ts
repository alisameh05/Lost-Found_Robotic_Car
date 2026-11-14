import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: { browserName: "chromium", viewport: { width: 1366, height: 768 } },
  webServer: [
    { command: "npm run start", url: "http://127.0.0.1:3100", env: { LAF_FRONTEND_PORT: "3100", LAF_MODE: "fixture", LAF_FIXTURE_HARNESS: "1" } },
    { command: "npm run start", url: "http://127.0.0.1:3101", env: { LAF_FRONTEND_PORT: "3101", LAF_MODE: "disconnected", LAF_FIXTURE_HARNESS: "1" } },
  ],
});
