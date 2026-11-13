---
title: "Lost and Found — Implementation Plan"
status: approved
version: "1.0"
created: 2026-11-13
updated: 2026-11-13
implementation_status: not started
sources: [PRD.md, ARCHITECTURE.md, TRD.md, API.md, design-brief.md]
---

# Implementation Plan — Lost and Found

**Three-week software build · Eight phases · Frontend first**

## 1. Goal, scope, and delivery approach

Build the complete local Windows application described by the [PRD](PRD.md), [architecture](ARCHITECTURE.md), [TRD](TRD.md), [API contract](API.md), and [screen brief](design-brief.md). Implement the existing `pen design/Robot.pen` designs and final-screen exports.

The completed demonstration follows this sequence:

> Register a belonging and select its target region → choose Gestures or PS4 control → manually navigate using live robot video → receive a potential match → review the captured evidence → confirm Found or reject and explicitly resume → inspect saved history after restart.

The frontend must first support this entire journey using clearly labeled fixtures. Backend development then replaces those fixtures with authoritative persistence, session management, local AI, and device connections.

**Software scope includes** the frontend, backend, database, computer vision, gesture recognition, PS4 input, device adapters, Uno and ESP32-CAM firmware, offline packaging, tests, and demonstration documentation.

**Physical wiring and assembly are excluded from every phase.** Request device-specific information when the affected software phase starts. Missing information blocks that connection, while independent work continues with fixtures.

The latest approved API contract governs wire details, including decisions that older architecture wording still describes as unresolved. No new product features or API redesign are planned.

### Time budget

Three weeks at 3–4 hours daily provides **63–84 hours**. This plan allocates **75 focused hours**, including phase specification, implementation, review, and verification.

That requires averaging approximately **3.6 hours daily**. The schedule is ambitious, particularly for GPU compatibility and firmware integration; these are working allocations, not measured completion estimates. At three hours daily, the planned workload exceeds available time by approximately twelve hours.

## 2. Phases and schedule

All eight phases are **Not started**. Relative Day 1 begins when phase execution starts, not when this roadmap is saved. An exit gate is passed only when its required evidence exists.

| # | Phase | Days | Depends on | Produces | Budget |
|---|---|---|---|---|---|
| 01 | Frontend foundation and contract fixtures | 1–2 | — | Application shell, shared components, typed fixture transport | 7 h |
| 02 | Registration, records, and supporting screens | 3–5 | 01 | Nine functional screen surfaces, including both registration steps | 10 h |
| 03 | Search setup, workspace, and results | 6–7 | 02 | Complete frontend journey and operational states | 7 h |
| 04 | Backend foundation, storage, and records API | 8–10 | 03 | Local FastAPI service, durable records/media, history, retention | 11 h |
| 05 | Session orchestration, realtime transport, and recovery | 11–13 | 04 | Authoritative search lifecycle and safety behavior using simulated devices | 11 h |
| 06 | Local AI, computer vision, and operator inputs | 14–16 | 05 | YOLOE matching, MediaPipe gestures, PS4 input, candidate continuity | 11 h |
| 07 | Device adapters, firmware, and connected integration | 17–19 | 06 | Compatible Uno/ESP32 software, real video/control, proximity telemetry | 11 h |
| 08 | Qualification, offline release, and demonstration | 20–21 | 07 | Verified release, launcher, evidence, report/demo materials | 7 h |

These are **eight phase-sized specifications**, not eight individual coding tickets. Each phase can later contain a small dependency graph of implementation tickets.

### Phase 01 — Frontend foundation and contract fixtures

**Days 1–2 · 7 hours**

**Purpose:** Establish the application structure and reusable interface before building individual workflows.

**Work:**

- Create the Next.js, React, and TypeScript frontend using the approved feature-based App Router organization.
- Implement the sidebar, page shell, active-search link, shared controls, feedback states, and emergency-stop presentation.
- Extract reusable colors, typography, spacing, and component styles from the existing designs. Bundle fonts and icons locally.
- Introduce a replaceable transport interface with deterministic fixtures matching the approved API models, errors, events, and frame envelope.
- Derive initial contract types from the approved documentation; replace their generation source with backend-owned exports in Phase 04, checking parity.
- Keep fixture state inside the development/test adapter. Production presentation must not acquire database or device authority.
- Establish frontend build, type, lint, component-test, and browser-test commands.

**Exit gate:** The application runs locally, navigation works, shared components match the design baseline, and fixture mode is visibly identified.

**Primary verification seam:** Browser routes and shared component behavior.

### Phase 02 — Registration, records, and supporting screens

**Days 3–5 · 10 hours**

**Purpose:** Complete the records workflow and non-operational screens against fixtures.

**Screens:**

Dashboard; Objects / History; Registration Step 1; Registration Step 2; Object Details; Session Details; Devices; Control Guide; Settings.

**Work:**

- Implement object-name search, Lost/Found filters, paginated histories, object/session details, and protected-media presentation.
- Build two-step registration with JPEG/PNG validation, image normalization, preview, and rectangular target selection.
- Support both drag selection and keyboard position/size fields using normalized source-image coordinates.
- Preserve the draft when moving backward; clear the target selection when replacing the image.
- Present device readiness according to the selected mode, distinguishing required, inactive, and advisory components.
- Implement retention impact preview, explicit confirmation, stale-preview handling, and the active-session restriction.
- Include loading, empty, validation, missing/corrupt media, expired-record, pending-save, and failure states.
- Compose dashboard summaries from approved resources without inventing a global history endpoint.

**Exit gate:** An operator can register a valid Lost object, find it, inspect its history, read operating guidance, and exercise the settings workflow using fixtures.

**Primary verification seam:** Browser registration, record browsing, and retention workflows.

### Phase 03 — Search setup, workspace, and results

**Days 6–7 · 7 hours**

**Purpose:** Finish the entire frontend before backend implementation begins.

**Work:**

- Implement Search Setup, Live Search Workspace, and Search Result.
- Provide the prescribed left webcam/gesture panel and right robot-video/AI panel. Label gesture control inactive in PS4 mode.
- Include pre-session robot preview and workspace observations so displayed-video readiness can be satisfied before Start.
- Implement lease acquisition, pending actions, ordered-event projection, snapshot resynchronization, and frame/display acknowledgments against fixtures.
- Cover ordinary pause, candidate review, rejection, emergency stop, connection failure, recovery, and advisory proximity states.
- Keep review, recovery, and help modeless; emergency stop remains accessible during pending operations and errors.
- Handle navigation, hidden/unfocused workspace, stale video, event gaps, backend restart, and active-session expiry grace.
- Show Found or saved terminal outcomes only after a committed response. Rejection remains Paused until explicit Resume.
- Complete keyboard, scaling, and operational-layout checks against the existing designs.

**Exit gate — frontend complete:** All twelve screen surfaces and required operational variants support the full demonstration journey. Backend work can begin without unresolved screen implementation.

**Primary verification seam:** Playwright journeys through both mode displays, review, recovery, and retention.

### Phase 04 — Backend foundation, storage, and records API

**Days 8–10 · 11 hours**

**Purpose:** Establish the production backend and durable records.

**Work:**

- Begin with the agreed laptop/GPU feasibility check: verify the Windows environment and a compatible local Python, PyTorch/YOLOE, MediaPipe, and supporting-library combination.
- Record dependency locks, asset hashes, licenses, and benchmark limitations. Do not introduce cloud inference as a fallback.
- Create the single-worker FastAPI application, dependency composition, owner lock, configuration, and disarmed lifecycle.
- Implement local Host/Origin/capability protection, bootstrap, structured errors, and initialization diagnostics.
- Export backend-owned HTTP/event/frame contracts, generate frontend types, and check them against the frontend fixtures.
- Implement SQLite migrations, constraints, serialized writes, durable action receipts, and managed image preparation/recovery.
- Implement registration, object search/details, session/match history reads, and protected media access.
- Implement retention preview/confirmation, registration-based expiry, grace policy, startup cleanup, and journaled deletion.
- Connect the completed records screens to the real backend.

**Exit gate:** Registration and history survive restart; retention removes managed rows/files correctly; failed saves and incomplete deletion remain explicit.

**Primary verification seam:** Protected HTTP requests with real temporary SQLite databases and managed media directories.

### Phase 05 — Session orchestration, realtime transport, and recovery

**Days 11–13 · 11 hours**

**Purpose:** Make the backend authoritative for operation before connecting real motion hardware.

**Work:**

- Implement Start, Pause, Resume, Stop, acknowledgment, Confirm, and Reject with the approved state/revision rules.
- Enforce one active session, immutable target/mode, human-only Found confirmation, and atomic review transactions.
- Implement controlling-client leases, generations, ordered events, snapshots, one-use socket tickets, and bounded video channels.
- Validate workspace heartbeats and displayed-frame identity; stale or unavailable required paths revoke permission.
- Implement immediate emergency revocation independently of ordinary actions, inference, storage, and subscriber delivery.
- Implement deliberate recovery: restoration, acknowledgment, explicit Resume, then neutral input and a fresh hold.
- Reconcile interrupted sessions and pending evidence at startup.
- Connect search screens to the real backend using explicit simulated device and inference adapters.
- Exercise duplicate retries, terminal-action races, slow consumers, storage failure, and backend/browser loss.

**Exit gate:** The full application works with real persistence and backend authority while simulated devices expose the required stopping and recovery behavior.

**Primary verification seam:** Backend HTTP/WebSocket workflows with injected device observations and clocks.

### Phase 06 — Local AI, computer vision, and operator inputs

**Days 14–16 · 11 hours**

**Purpose:** Replace simulated recognition and input observations with local processing.

**Work:**

- Implement a Windows spawn-safe inference worker with bounded latest-frame processing and explicit failure reporting.
- Prepare YOLOE visual prompts from the selected reference region and preserve session, generation, and frame identity through results.
- Pause before exposing a candidate and preserve its exact frame as durable PNG evidence with a separately rendered bounding box.
- Implement rejection suppression through candidate continuity and observed exit/re-entry, including continuity loss during pause or recovery.
- Implement backend-owned webcam capture and MediaPipe pointing recognition in mirrored display coordinates.
- Implement selected PS4 identity/profile, held D-pad directions, Circle emergency stop, release/conflict handling, and disconnection.
- Request actual webcam/controller details when needed; use recorded or synthetic frames for independent matching work.
- Freeze the initial model, recognition, input, and continuity configuration before formal trials.

**Exit gate:** Local AI can suggest reviewable candidates; both required input modes produce correct normalized observations; stale worker results cannot change another session.

**Primary verification seam:** Recorded/synthetic input sequences through real adapters and the session coordinator, followed by selected-device checks.

### Phase 07 — Device adapters, firmware, and connected integration

**Days 17–19 · 11 hours**

**Purpose:** Connect the working application to the selected robot interfaces.

**Work:**

- Obtain the selected serial identity, camera endpoint, board/build targets, logical output mapping, and proximity observation source from Alisa.
- Preserve the existing motor-test sketch as reference; develop dedicated production firmware rather than assuming that sketch meets the contract.
- Implement the versioned Uno command/response protocol, bounded nonblocking parser, expiring challenges, sequence/generation checks, acknowledgment, and disabled boot/reset output.
- Implement ESP32-CAM acquisition identity, bounded frames, epoch/sequence timestamps, and clock-age exchange.
- Integrate pySerial and camera adapters, including compatibility errors, disconnects, stale data, and recovery.
- Integrate proximity validity/freshness and calibrated warning/clear behavior. It remains advisory.
- Record versioned device manifests and measured configuration; do not copy fixture timers into device profiles.
- Verify replay/queued-command rejection, independent expiry after backend loss, frame/display freshness, and both control modes.

**Exit gate:** Available selected devices operate through compatible software interfaces. Missing details or failed measurements remain named blockers for those connections.

**Primary verification seam:** Protocol fixtures followed by controlled tests on the configured devices. No wiring tasks are added.

### Phase 08 — Qualification, offline release, and demonstration

**Days 20–21 · 7 hours**

**Purpose:** Verify the complete build and prepare a reproducible local release.

**Work:**

- Run accumulated automated checks and repair remaining integration defects.
- Complete the PRD recognition trials: five objects, ten presentations each, plus ten negative scenes.
- Measure camera-to-display latency under active control and AI load; run the twenty-minute application stability exercise.
- Verify offline registration, both input modes, review, history, restart, and retention.
- Finish the Windows launcher, production frontend build, local runtime/assets, startup diagnostics, and disarmed shutdown.
- Record release versions, model/firmware hashes, configuration, test conditions, and unresolved qualification results.
- Prepare setup instructions, operator guidance, report evidence, and the demonstration script.

**Exit gate:** A reproducible release and truthful acceptance report exist. A failed or unperformed metric remains open.

Software traces do not establish physical wheel stopping or battery endurance. External measurements may be attached when available without adding physical-work procedures to the plan.

## 3. Weekly gates and acceptance

| Checkpoint | Required outcome |
|---|---|
| End of Week 1 | Complete frontend, all twelve screens, both mode displays, and operational variants using labeled fixtures |
| End of Week 2 | Durable backend and session orchestration connected to the UI; AI feasibility established and implementation underway |
| End of Day 19 | Local AI and available selected devices integrated; feature freeze |
| End of Week 3 | Offline release, qualification results, reproducible setup, and demonstration materials |

Testing happens within every phase. The final two days verify the assembled system rather than introducing its first meaningful tests.

Use Vitest and React Testing Library for meaningful UI/logic checks, Playwright for operator journeys, and pytest for backend/protocol integration checks. Prioritize externally observable behavior:

- Correct image normalization and ROI coordinates.
- One active session and exclusive selected-mode input.
- Pending versus committed saves and atomic confirmation.
- Emergency revocation despite blocked AI/storage.
- Required-path failure, replay rejection, and deliberate recovery.
- Exact candidate frame/box association and rejection suppression.
- Restart durability, interrupted-session reconciliation, expiry grace, and actual deletion.
- Local request protection, spectator isolation, and offline operation.

## 4. Phase-to-spec workflow and delivery rules

This roadmap is maintained at **`docs/IMPLEMENTATION_PLAN.md`**. Saving the approved roadmap does not execute its phases, create phase specifications, publish issues, or establish qualification.

For each phase:

1. Read its section, owning requirements, and current implementation.
2. Use Matt’s `/to-spec` workflow to produce one phase specification covering the problem, solution, user stories, implementation decisions, testing decisions, and exclusions.
3. Confirm the proposed testing seams as required by that skill before publishing the spec.
4. Use `/to-tickets` to create a small set of independently verifiable slices with explicit blocking relationships. During frontend phases, slices terminate at the fixture boundary; later slices connect the completed UI through the real backend.
5. Publish approved specs/tickets to `alisameh05/Lost-Found_Robotic_Car` using the configured tracker conventions.
6. Implement and verify the phase, then record evidence and update roadmap status.

Phase specs, issues, and application implementation follow separately from creation of this roadmap.

**Schedule rules:**

- Preserve the frontend-first order; the GPU feasibility check starts Phase 04.
- Use relative days until an actual start date is chosen.
- Ask for device details when the affected phase starts.
- Keep fixtures explicitly labeled and separate from device qualification.
- Reduce cosmetic polish, animation, and duplicate documentation first if time slips.
- Do not silently cut required control modes, matching/review, recovery, retention, offline operation, or protocol safeguards.
- If a weekly gate slips, report the remaining work and revise the forecast; retain the complete required scope.
- Avoid unrelated refactoring and new product features during these three weeks.
