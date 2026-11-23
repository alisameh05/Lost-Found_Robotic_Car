// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useRuntimeView } from "@/features/runtime";
import type { Component, FrontendProfile, Snapshot } from "@/generated/api-v1";
import { LiveSearchScreen } from "./live-search";
import styles from "./session.module.css";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/features/runtime", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/features/runtime")>(),
  useRuntimeView: vi.fn(),
}));

afterEach(cleanup);

const time = 1_800_000_000_000;
const profile: FrontendProfile = {
  profile_id: "device-test", protocol_version: 1, evidence_kind: "Device",
  max_header_bytes: 1024, max_frame_bytes: 4096, max_frame_width: 64, max_frame_height: 48, max_frame_pixels: 3072,
  max_event_message_bytes: 32_768, max_client_message_bytes: 4096,
  heartbeat_interval_ms: 100, heartbeat_deadline_ms: 300, display_deadline_ms: 240, capture_age_limit_ms: 180,
};
const ready = (component: Component["component"]): Component => ({ component, status: "Ready", cause_codes: [] });
const active = {
  protocol_version: 1, backend_boot_id: "boot", event_seq: 1,
  qualification_profile_id: profile.profile_id, qualification_profile: profile,
  active_session: { id: "search", object_id: "target", state: "Searching", control_mode: "Gestures",
    started_at_ms: time, revision: 1, ended_at_ms: null, end_reason: null, pause_causes: [] },
  active_object: { id: "target", name: "Saved target", status: "Lost", revision: 1, found_at_ms: null,
    registered_at_ms: time, expires_at_ms: time + 604_800_000, retention_grace: false,
    roi: { x: 0, y: 0, width: 8, height: 8 },
    reference_media: { id: "reference", role: "Reference", availability: "Missing", content_type: "image/jpeg",
      created_at_ms: time, width: 8, height: 8, byte_length: 64 } },
  runtime: { effective_session_state: "Searching", motion_permission: "Arming", control_generation: 1, persistence_pending: false },
  readiness: { components: [ready("Backend"), ready("Storage"), ready("Command"), ready("RobotVideo"),
    ready("DisplayedRobotVideo"), ready("Webcam"), ready("Controller"), ready("AI"), ready("Workspace"),
    ready("QualificationProfile")], can_resume: false, can_start: { Gestures: false, Controller: false } },
  failures: [], pending_candidate: null, operations: [],
  lease: { state: "Owned", owner_client_id: "client", control_generation: 1, can_acquire: false },
  proximity: { state: "Unknown", warning_latched: false, distance_mm: null, sample_seq: null, source_epoch: null, observed_at_ms: null },
  retention: { settings: { retention_days: 7, revision: 1, updated_at_ms: time },
    deletion: { status: "Complete", remaining_objects: 0, remaining_files: 0, error_code: null },
    active_object_expires_at_ms: time + 604_800_000, active_object_grace: false },
} satisfies Snapshot;

test.each([
  ["Gestures", "Live • Mirrored", "Gesture feedback", "Recognition shown on the mirrored preview"],
  ["Controller", "Inactive", "Controller feedback", "Selected USB DualShock 4 ready"],
] as const)("shows Device input feedback for %s", (mode, webcamStatus, feedback, input) => {
  vi.mocked(useRuntimeView).mockReturnValue({
    loading: false, recordsMode: true, profile,
    snapshot: { ...active, active_session: { ...active.active_session, control_mode: mode } },
    workspace: { eventsLive: true, previewLive: true, webcamLive: true, controlling: true, usable: true, acquiring: false },
  });

  render(<LiveSearchScreen sessionId="search" />);

  const webcam = screen.getByRole("region", { name: "Laptop webcam" });
  expect(within(webcam).getByText(webcamStatus, { exact: true })).toBeTruthy();
  expect(webcam.querySelector("[data-live]")?.classList.contains(styles.mirrored)).toBe(false);
  const selectedInput = screen.getByRole("region", { name: feedback });
  expect(within(selectedInput).getByText(input, { exact: true })).toBeTruthy();
  expect(selectedInput.textContent).not.toMatch(/simulated/i);
});
