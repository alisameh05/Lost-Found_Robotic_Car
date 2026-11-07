---
title: "Lost and Found — Implementation Guide"
created: 2026-11-05
updated: 2026-11-07
status: plan-only
scope: Complete approved MVP, laptop application and robot
---

# Lost and Found — Implementation Guide

Build the complete system in **18 phases, 00–17**, progressing from software feasibility and external device handoff to the assessed demonstration. Each phase has a linked checklist, acceptance criteria and required evidence. Phase 00 is **In progress** while its baseline package is drafted; acceptance requires recorded team availability and a passing whole-package review. Assessment instructions and external device details may remain pending when their owners, affected gates and next actions are recorded. Phases 01–17 remain **Not started**: completed planning documents are not completed implementation.

This guide borrows the organization of a supplied Pravaha implementation plan, which is not included in this repository. That plan is a structural reference only. Its project instructions, technology choices, dates, completion claims, Git policies and expansion features do not govern Lost and Found.

## Source of truth

| Source | Owns |
| --- | --- |
| [PRD.md](PRD.md) | Approved scope, FR-1–FR-18, NFR-1–NFR-6 and acceptance metrics |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Adopted AD-1–AD-15; canonical technical decisions |
| [TRD.md](TRD.md) | Schema, interfaces, device/safety contracts, deployment and gates T1–T7 |
| [EXPERIENCE.md](../_bmad-output/planning-artifacts/ux-designs/ux-Robotics-2026-11-05/EXPERIENCE.md) and [DESIGN.md](../_bmad-output/planning-artifacts/ux-designs/ux-Robotics-2026-11-05/DESIGN.md) | User flows and visual guidance, with the later TRD decisions and remaining UX assumptions respected |
| This guide and phase checklists | Work order, deliverables, evidence and handoffs; no authority to alter approved requirements |

The selected stack stays **Next.js + React + TypeScript on a local Node server**, **FastAPI/Python**, **SQLite plus managed image files**, and local **OpenCV/MediaPipe/YOLOE/PyTorch/Pygame/pySerial** adapters. Commands use HC-05 → Uno; ESP32-CAM video uses local Wi-Fi. This plan selects no new versions, model checkpoint, electrical values or branding.

## Demonstration goal

The finished system must support this sequence from the operator's fixed desk:

1. Register a belonging using its name, a reference image and one selected target region.
2. Select a control mode and start only when all required capabilities are ready.
3. Drive through connected rooms using the live robot feed. Held input moves; release stops. During controlled integration, show the silent HC-SR04 warning and confirm it clears on the tested clear condition without changing motion/session state.
4. Receive a potential match: the robot stops and the session pauses with captured evidence.
5. Reject a candidate, remain Paused, then explicitly Resume; suppress the same continuously visible rejected candidate.
6. Confirm the intended candidate: save evidence, mark Found and end the session.
7. Restart the application and inspect unexpired history. Show that faults/reconnection cannot restart motion and retention deletes stored records and images correctly.

Demonstrate gestures and PS4 DualShock 4 control in **separate sessions**. An unsuccessful Ended/Lost session may reuse its registration in another mode; a Found object requires a new registration. Do not switch modes during Searching or Paused. This walkthrough organizes the build; every approved requirement still applies, including the separate twenty-minute endurance trial.

## Phases

Dependencies are completion gates. Work inside a phase may begin against shared simulators/fixtures when its checklist permits; do not mark the phase Done until its real dependencies and acceptance criteria pass.

| # | Phase | Depends on | Produces | Status |
| --- | --- | --- | --- | --- |
| [00](phases/PHASE-00-project-baseline.md) | Project baseline and execution setup | — | Requirement/evidence index, owners, equipment/deadline questions | In progress — acceptance review pending |
| [01](phases/PHASE-01-hardware-readiness.md) | Device interfaces and external hardware handoff | 00 | Scoped supplied device configuration/access and Alisa's readiness statement; unknowns and restrictions remain explicit | Not started |
| [02](phases/PHASE-02-laptop-and-vision-spike.md) | Laptop environment and vision feasibility | 00 | Recorded laptop, compatible candidate environment, offline model spike | Not started |
| [03](phases/PHASE-03-application-foundation.md) | Application foundation and shared contracts | 02 | Next.js/FastAPI shell, contracts, protected local services, simulator interfaces | Not started |
| [04](phases/PHASE-04-registration-and-persistence.md) | Registration and persistent records | 03 | SQLite schema, managed media, image/ROI registration and initial history | Not started |
| [05](phases/PHASE-05-camera-and-video-freshness.md) | Camera streaming and video freshness | 03 for fixture development; relevant 01/T2 handoff also required for real-device acceptance | Actual camera → backend → browser video, timestamps/epochs/display acknowledgments | Not started |
| [06](phases/PHASE-06-firmware-and-command-expiry.md) | Command firmware and expiry stopping | 03 for fixture development; relevant 01/T2 handoff also required for real-device acceptance | Uno/HC-05 protocol, reset-disabled outputs, sensor telemetry and command-expiry bench evidence | Not started |
| [07](phases/PHASE-07-gesture-and-controller-input.md) | Gesture and controller input | 03 | Qualified sample mappings and fresh/neutral input adapters | Not started |
| [08](phases/PHASE-08-local-matching-worker.md) | Local matching and continuity worker | 02, 04, 05 | Separate inference worker, visual prompts, tagged candidates and suppression context | Not started |
| [09](phases/PHASE-09-session-and-safety-coordinator.md) | Session and safety orchestration | 04, 05, 06, 07, 08 | State machine, readiness, leases, latches and measured initial timing configuration | Not started |
| [10](phases/PHASE-10-review-and-history.md) | Match review, evidence and full history | 09 | Confirm/Reject/Not reviewed outcomes, consistent saves, searchable histories | Not started |
| [11](phases/PHASE-11-retention-and-crash-recovery.md) | Retention and crash recovery | 10 | Registration-based purge, active grace, failure recovery and restart reconciliation | Not started |
| [12](phases/PHASE-12-controlled-robot-integration.md) | Controlled physical integration | 09, 10, 11 | Guarded movement with the full application and both modes; initial physical timing | Not started |
| [13](phases/PHASE-13-ux-and-visual-handoff.md) | UX completion and visual handoff | 03, 10, 11 | Complete usable screens, Alisa's visual approval and operational layout checks | Not started |
| [14](phases/PHASE-14-offline-release.md) | Offline production release | 12, 13 | Production build, Windows launcher, dependency/firmware manifest and cold-start evidence | Not started |
| [15](phases/PHASE-15-multi-room-readiness.md) | Fixed-desk multi-room readiness | 14 | Stable actual route, integrated tuning and frozen qualification configuration | Not started |
| [16](phases/PHASE-16-system-qualification.md) | Whole-system qualification | 15 | Complete FR/NFR results, all five metrics and fault/security regression evidence | Not started |
| [17](phases/PHASE-17-report-and-demonstration.md) | Report, demonstration and handoff | 16 | Assessed report/demo package, release archive and honest limitations | Not started |

Phase 09 is the convergence point for persistence, video, firmware, input and matching. From there the main sequence is **09 → 10 → 11 → 12 → 14 → 15 → 16 → 17**, with Phase 14 also requiring Phase 13. Phases 01 and 02 can proceed independently after Phase 00 acceptance; Phase 02 does not wait for physical hardware. Phase 13 can overlap Phase 12 once its own dependencies are complete; operational safety/legibility cannot wait for final branding.

## Software development and hardware integration order

1. **Baseline — Phase 00.** Review ownership, availability, software equipment, acceptance routes and blockers. Hardware construction is external and does not have to finish for this software baseline to be accepted.
2. **Independent software — Phases 02–11 and 13.** Follow software prerequisites, using clearly labeled image/frame/input/serial fixtures where devices are unavailable. Phase 01 interface preparation and receipt of external hardware can proceed alongside this work. A missing handoff blocks only the dependent board-specific implementation or device test, not the independent laptop/application/AI/storage work.
3. **Real stationary subsystems — Phases 05/06.** After Phase 03 and the relevant scoped Phase 01/T2 handoff, program and exercise the supplied camera and command/sensor interfaces with motor outputs disabled. Camera acceptance may proceed while command hardware is pending. Fixture milestones are distinct from whole-phase Done, which still requires actual-device acceptance. Later phases may develop against agreed fixture interfaces while their listed completion prerequisites remain open.
4. **Controlled integration — Phase 12.** After Phases 09–11 acceptance and T2 movement readiness/T4/T6 entry gates, integrate the supplied robot through the full guarded application and measure direction, stopping, recovery and warning behavior. Hardware construction, wiring and electrical investigation remain with Alisa.
5. **Release, route, qualification and handoff — Phases 14–17.** Preserve the dependency table, real-device evidence and all complete-system targets.

## Device interface handoff

Use [Phase 01](phases/PHASE-01-hardware-readiness.md) and its [replacement specification](specs/PHASE-01-device-interface-handoff-spec.md) to receive exact device/configuration identities, supplied pin/output mapping and limits, programming access, serial/camera endpoints, sensor arrangement and scoped readiness from Alisa. Store credentials outside Git. Firmware consumes supplied configuration; missing values remain pending.

T2 is the external hardware handoff for the relevant activity, not a software-authored wiring/electrical package. Physical assembly, wiring, power design, charging, component selection and electrical review are Alisa-owned external work, including associated human approvals. No EasyCircuit/Fritzing artifact or installation is a software prerequisite. The [superseded archive](archive/software-scope-transition-2026-11-07/README.md) preserves prior plans without making them active tasks.

Receiving a handoff does not establish protocol compatibility or performance. Record handoff acceptance, simulator results, observed device tests and complete-system qualification separately. Reconcile configuration changes and rerun affected checks.

The [Phase 01 software-facing child-ticket index](phase-01/TICKET-INDEX.md) maps issues #4–#9 to their Markdown specifications and native dependencies under parent #3. These are new handoff/record/review tickets; they do not revive the 13 archived wiring drafts or claim hardware readiness.

## Milestones and scheduling

The PRD records a four-week completion window as of 2026-11-06, with 2026-12-04 as the planning target if that window starts on 2026-11-06. The final result will be demonstrated through supervised manual testing; the exact assessment date and staffing capacity remain unconfirmed. The following milestones define execution order. During Phase 00, assign people and dates using actual availability; reserve explicit time for failed trials, fixes and reruns.

| Milestone | Phases | Show this before progressing |
| --- | --- | --- |
| M1 — Software execution baseline | 00; Phase 01 handoff preparation may follow independently | Reviewed software ownership, equipment/dependency record, acceptance routes and pending external hardware handoff |
| M2 — Software feasibility and foundation | 02–04 | Compatible local inference spike; application shell; registration and persistence |
| M3 — Software and stationary subsystems | 05–11, 13 | Actual camera path, disabled-output command-expiry checks, both input families, local worker, guarded stationary flow, history/retention and usable UI |
| M4 — Safe integrated robot | 12 | Held-input movement and measured physical stops with all required services active |
| M5 — Release and route frozen | 14–15 | Offline production launch and fixed-desk multi-room operation on the recorded configuration |
| M6 — Qualification and assessment | 16–17 | Recorded complete-system passes, report, rehearsed demonstration and release archive |

**Discover expensive failures early:** benchmark model/runtime compatibility before full UI work, exercise parser/freshness/recovery with fixtures, then test each available supplied device separately. Probe room-to-room video/serial coverage with outputs disabled in Phases 05/06. Repeat the route with the actual moving application in Phase 15; an early bench probe is not final route qualification.

## Team split

Assign names in Phase 00; these are responsibility groups, not assumed team members. One person can cover several groups. Alisa owns external physical work. Software/device acceptance follows its scoped handoff and phase gates even while independent software proceeds.

| Track | Owns | Coordination points |
| --- | --- | --- |
| Firmware/device software | Phase 01 interface record, 05 camera firmware, 06 command/sensor firmware and adapters | Alisa supplies external hardware/configuration/readiness; shared protocol from 03, safety with 09 and tests with 12/16 |
| Backend/vision | 02, 04, 05 ingestion, 07, 08, 09, 10/11 persistence | Sole session/data ownership; publish schemas before frontend integration |
| Frontend/experience | 03 UI, 04 registration, 05 display acknowledgments, 09/10 controls/review, 11 settings, 13 | Consume shared types; never duplicate backend state authority |
| Integration/evidence | 00 tracking, 12, 14–17 | Record results throughout; coordinate fixes with the owning track |

For a solo software build, follow the software dependency table while preparing Phase 01 interfaces and waiting only on the particular hardware activities that need Alisa's handoff. Keep motor outputs disabled during stationary work until Phase 12 entry gates pass. Maintain the report/evidence index from Phase 00 onward; Phase 17 assembles recorded results.

## Open-gate ownership

These implement TRD T1–T7; they do not replace them. A gate can have an early configuration checkpoint and a later measured exit.

| Gate | Work phases | Exit required |
| --- | --- | --- |
| T1 Runtime/dependency lock | 02 → 03/08 → 14 | Exact compatible packages/runtimes/GPU/assets and reproducible offline release manifest |
| T2 External hardware handoff | 01; scoped receipt at 05/06/12 | Supplied configuration, pin/output mapping/limits and access; Alisa's readiness statement for the relevant subsystem and activity; software/device acceptance remains separate |
| T3 Equipment/network/route | 00/02 inventory, 05/06 probes, 15 | Recorded actual devices/network and fixed-desk connected-room route |
| T4 Input/UI operating setup | 07/09; verify at 12/13 | Mappings, neutral/ambiguity rules, device profiles and usable operational layout before driving |
| T5 Matching/continuity | 02 spike, 08 integration, 15 freeze, 16 trials | Recorded checkpoint/settings/tracking criteria and agreed five-object test conditions |
| T6 Protocol/timing | 03 contracts, 05/06 implementation, 09 budgets, 12/15 integration, 16 qualification | Frozen exact parameters before moving tests; complete stop/video/endurance evidence before acceptance |
| T7 Visual/assessment | 00 date/roles, 13 visual approval, 17 delivery | Alisa's visual decisions, verified UI criteria and actual assessment instructions/date |

An open hardware or numeric configuration question blocks its dependent implementation/test, not all independent work. Use mocks only for clearly labeled development. Do not ship a mock as the actual device, silently disable required AI, select arbitrary watchdog values or buy extra components to bypass a gate.

## Definition of Done and evidence

Each phase is Done only when its checklist tasks, acceptance checks and applicable gate evidence are complete. Record **what changed, release/configuration identifiers, checks run, results, failures, evidence location and remaining issues**. “UI looks finished,” a library example or simulated success alone is insufficient.

Phase 00's draft acceptance index is maintained at [`docs/phase-00/ACCEPTANCE-INDEX.md`](phase-00/ACCEPTANCE-INDEX.md), with one row per FR/NFR/metric and links to relevant trials. Suggested working locations for later evidence are `evidence/phase-XX/` and `evidence/qualification/`; these names are organizational suggestions, not existing artifacts. Runtime media and secrets stay in their approved local storage/configuration locations, outside source control. Use the agreed assessment test objects for shared evidence.

Phase 16 must preserve these exact targets:

| Metric | Pass threshold |
| --- | --- |
| SM-1 | Five objects × ten clearly visible presentations; **at least 7/10 per object alert within three seconds** |
| SM-C1 | Ten separate ten-second scenes without a visually similar target; **at most one alerted scene** |
| SM-2 | **Wheels stop within 0.5 seconds**, including detection, after release, emergency stop or actual required-path loss |
| SM-3 | **Twenty minutes** without recharge, restart or crash while exercising the complete system |
| SM-4 | Camera event → laptop display **within 0.5 seconds** with control and AI active |

## Required-feature coverage

| Requirement | Implementation phases | Final verification |
| --- | --- | --- |
| FR-1 Registration/target region | 04 | 16 |
| FR-2 Single target/session | 09 | 16 |
| FR-3 Split workspace/live state | 03, 05, 09, 13 | 16 |
| FR-4 Exclusive gesture/controller modes | 07, 09, 12 | 16 |
| FR-5 Held movement/release | 06, 07, 09, 12 | 16 / SM-2 |
| FR-6 Emergency stop | 06, 09, 12, 13 | 16 / SM-2 |
| FR-7 Command/input/video loss | 05, 06, 07, 09, 12 | 16 / SM-2 |
| FR-8 Start/Pause/Resume/Stop | 09, 10, 12 | 16 |
| FR-9 Similarity alerts/boxes | 02, 08, 09 | 16 / SM-1, SM-C1 |
| FR-10 Automatic pause/review | 09, 10 | 16 |
| FR-11 Confirm/Found/evidence | 10 | 16 |
| FR-12 Reject/Paused/suppression | 08, 09, 10 | 16 |
| FR-13 Searchable persistent history | 04, 10, 11 | 16 |
| FR-14 New registration after Found | 04, 10 | 16 |
| FR-15 Configurable retention/real deletion | 04 storage primitives, 11 full lifecycle | 16 |
| FR-16 Local/no login/no normal upload | 03, 14 | 16 |
| FR-17 Deliberate recovery/fresh input | 06, 07, 09, 11, 12 | 16 |
| FR-18 Advisory proximity warning | 06, 09, 12; 01 supplies interface | 12, 16, 17 |
| NFR-1 Offline complete searching | 02, 03, 08, 14 | 16 |
| NFR-2 Fixed-desk multi-room operation | 05/06 early probes, 12, 15 | 16 |
| NFR-3 Windows/NVIDIA laptop | 02, 08, 14 | 16 |
| NFR-4 Durable local data/retention | 04, 10, 11 | 16 |
| NFR-5 Stated room/obstacle/target conditions | 00 planning, 12, 15 | 16 |
| NFR-6 Complete-system performance | 12, 14, 15 | 16 / all metrics |

## Scope control and working rules

- Keep all approved MVP features. If time is short, simplify optional decoration, development conveniences or report formatting; preserve usability, assessment content and mandatory checks.
- Never trade away either control family, safety/recovery, offline AI, evidence/history, real retention, multi-room scope or the measured targets without an explicit approved revision.
- Use short integration checkpoints and record blockers early. Do not import the reference's three-day schedule, arbitrary time limit or file-count rule.
- Agree shared schemas/protocols before parallel units diverge. Changes that affect an AD or PRD requirement need an explicit source revision; implementation convenience cannot silently change the architecture.
- Do not enable actual movement before Phase 12's entry gate. Firmware output/expiry benches in Phase 06 remain physically restrained/isolated under the applicable scoped handoff.
- Use development reload only with motors disabled. Ordinary release stops motion but may remain Searching; faults/emergency require the approved acknowledgment/restoration/Resume/fresh-input sequence.
- Test on the production offline release before claiming final qualification. A later change to a qualified component triggers affected regression/metric reruns.
- Freeze the final passing release for rehearsal/assessment. Record the real freeze date after the assessment date is known; do not invent one here.

## First action

Finish the pending Phase 00 software baseline review, then start Phase 02 laptop/vision feasibility. Prepare/receive Phase 01 device interfaces independently. No software phase requires agents to design wiring or complete physical assembly; real-device tests still require scoped handoff and actual results. Creating this guide completes no phase or qualification.
