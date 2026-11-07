---
title: "Lost and Found — Product Requirements Document"
status: final
version: "1.2"
created: 2026-11-05
updated: 2026-11-07
---

# Lost and Found — Product Requirements Document

## 1. Purpose and vision

Lost and Found helps people locate belongings in offices and shared spaces using a manually operated camera robot and a laptop application. The operator supplies a reference image, drives the robot through connected rooms, and reviews AI-generated potential matches. A human decision establishes that a belonging has been found; visual similarity alone never changes its status to Found.

This PRD defines the complete system for a university project assessed through a report and demonstration: application behavior, device firmware, robot movement through software, connections, records, safety, and measurable acceptance. Physical assembly, wiring, power design, charging, component selection and electrical review are Alisa-owned external work; the software project consumes the relevant hardware handoff. It is an approved requirements baseline, not evidence of implemented or qualified performance. The approved copy is maintained at `docs/PRD.md`.

## 2. User and operating boundary

One person finding belongings in an office/shared space uses one Windows laptop, one robot, and one target per active search. The operator stays at a fixed desk while the robot searches multiple connected rooms on one floor.

Acceptance testing uses two adjacent furnished rooms with stationary obstacles and people kept clear of the robot's path. Targets are visible on the floor or low shelves within the camera's view. The operator steers around obstacles using live video. An HC-SR04 may provide a silent on-screen proximity warning; it does not stop, steer, or avoid obstacles.

Local Wi-Fi is available; internet access is not assumed after installation/setup. Wireless operation is preferred, while wired connections are acceptable for the demonstration. Either arrangement must still satisfy the fixed-desk, connected-room requirement.

### Example search

This illustrative walkthrough summarizes chosen rules, rather than reporting an observed user session: an office operator registers a belonging, selects its image target and a control mode, and starts from a fixed desk. The operator navigates connected rooms using live video. A potential match stops the robot and pauses the search session. After rejection, the object remains Lost and searching stays paused until Resume. Confirmation saves evidence, sets Found, and ends the session. History remains available after restart. Searching for a Found belonging again requires a new registration.

## 3. Terms and state rules

| Term | Meaning |
| --- | --- |
| Object record | A named registration with a reference image, selected target, status, registration time, and related history. |
| Target | The selected region inside the reference image; only one target is searched for at a time. |
| Potential match | A visually similar candidate shown with a bounding box; not proof of a unique object's identity. |
| Search session | One attempt to find a registered target, including its state, times, and match-review history. |
| Lost / Found | Object statuses. A new record is Lost; explicit confirmation changes it to Found. |
| Searching / Paused / Ended | Session states. Paused disables movement and AI matching; Ended cannot be resumed. |
| Control mode | Laptop-webcam gestures or PS4 DualShock 4 controller; only the selected mode commands movement. |
| Retention period | Configurable lifetime of an object record and its related data, measured from registration; default seven days. |

A stopped robot does not necessarily mean an ended session. Match review, Pause, and recoverable failures pause the session. Stop and confirmation end it. Rejection leaves the object Lost and the session Paused.

## 4. MVP features and functional requirements

Every feature below is required for the assessed MVP. Requirement IDs remain stable if sections are reorganized.

### 4.1 Object registration and target selection

**FR-1 — Register an object.** Require an object name, reference image, and target selection inside that image.

Acceptance: registration cannot complete without all three inputs. A completed record is Lost and retains the registration time/reference image. An unusable image produces a visible validation message instead of a completed registration.

**FR-2 — Select a search target.** Select one registered Lost object. Only one session may be active, including a paused session.

Acceptance: the active target is identified; another target/session cannot run concurrently. An ended unsuccessful session permits another session using the same Lost record.

### 4.2 Live view and manual navigation

**FR-3 — Show the search workspace.** Provide a split view: laptop webcam/gesture feedback on the left; live robot video and AI results on the right.

Acceptance: the operator can see the robot feed, target, active mode, session state, and match results. Connection indicators distinguish available and unavailable required connections.

**FR-4 — Provide exclusive control modes.** Support gestures and the PS4 DualShock 4 controller for forward, backward, left, right, and stop. Select the mode before starting; lock it until the session ends. PS5 controller support is removed with supervisor approval recorded on 2026-11-06.

Acceptance: demonstrate every action in each mode. The inactive mode cannot command movement. Pause does not unlock mode selection.

**FR-5 — Require held movement input.** Move only while a valid directional gesture/controller input is held. Release or loss of recognition stops movement.

Acceptance: each direction and its release satisfy SM-2. Paused/ended sessions ignore movement input.

**FR-6 — Provide emergency stop.** Emergency stop is available during operation, stops movement, and pauses an active session.

Acceptance: stop satisfies SM-2 and displays an explicit stopped state. Held input cannot clear the stop; recovery follows FR-17.

**FR-7 — Stop on required-input or video loss.** Stop movement and pause on command loss, disconnection of the active control device, or loss of live robot video.

Acceptance: independently interrupt each required path during movement. Each case satisfies SM-2, identifies the cause, and requires FR-17 recovery. A frozen/stale feed counts as video loss even if the last image remains visible; that image must not be represented as live.

### 4.3 Search and review

**FR-8 — Control the session.** Provide Start, Pause, Resume, and Stop. Pause stops movement and AI matching; Resume continues the same target/session. There is no automatic search-duration limit.

Acceptance: Stop saves and ends an unsuccessful session while retaining Lost status. Another session may reuse that Lost record. Start/Resume require the selected input and live robot feed to be available. Movement requires fresh input, not replay of the previous command.

**FR-9 — Suggest visually similar candidates.** Compare the reference target with robot-camera frames. Show a potential-match notification and bounding box; the operator decides whether it is the intended belonging.

Acceptance: satisfy SM-1 and SM-C1. Similar-looking objects are candidates, not guaranteed identity matches. AI results alone never set Found status.

**FR-10 — Pause for review.** A potential match stops movement and pauses matching for review of its screenshot and bounding box.

Acceptance: evidence remains available while paused; held input cannot continue movement. The operator confirms, rejects, or ends the session with Stop.

**FR-11 — Confirm a match.** Confirmation marks Found, saves the detection screenshot and confirmation time, and ends the session.

Acceptance: the Found record/evidence remain available after application restart until retention expiry. Confirmation ends movement/session without a separate Stop action.

**FR-12 — Reject a match.** Record rejection, retain Lost status, and remain paused until explicit Resume.

Acceptance: after Resume, suppress another alert for the rejected candidate while it remains continuously in view. It becomes eligible after leaving and re-entering view. This is session-level candidate suppression, not persistent identity recognition.

### 4.4 Local history and retention

**FR-13 — Preserve searchable history.** Provide a local Lost/Found feed with object name, reference image, status, registration time, every session, and confirmed/rejected matches with detection screenshots and review times.

Acceptance: unexpired data survive restart. Search the feed by object name and inspect related sessions/decisions. The feed does not publish records publicly.

**FR-14 — Register Found belongings again.** A Found record cannot be reopened as Lost. Another search for that belonging requires a new registration.

Acceptance: the old record retains Found status/evidence; the new record is independently Lost with its own registration time. Stop/rejection cannot reopen the Found record.

**FR-15 — Enforce configurable retention.** Default retention is seven days from registration. Expiry removes the object and its related sessions, decisions, reference image, and screenshots. An active session may finish before its expired data are removed.

Acceptance: while the application is open, remove a record when its retention expires unless its session is active. When the application has been closed, remove expired records at startup before displaying them or allowing searches. If expiry occurs during an active session, retain its data until that session ends, then remove it. A new search does not extend retention; changing settings does not reset registration time. Retention removes stored data, not only its feed entry.

**FR-16 — Use local access without login.** No account is required. Records are accessible to whoever uses the application on that laptop.

Acceptance: there is no login gate; searches/history work offline. Normal operation does not upload reference images, video, or evidence.

### 4.5 Recovery

**FR-17 — Require deliberate recovery.** After emergency stop or a required-connection failure, remain stopped until explicit acknowledgment, restored required connections, and Resume. Then require fresh movement input.

Acceptance: reconnection alone never restarts movement. Resume cannot bypass an unresolved failure. Previously held input must be released and applied again before the wheels restart.

### 4.6 Proximity warning

**FR-18 — Show an obstacle proximity warning.** During Searching, use the HC-SR04 to show a silent on-screen warning when an obstacle is within a calibrated warning distance. The warning is advisory only: it does not stop, pause, or steer the robot. Clear it after the sensor consistently reports a clear path.

Acceptance: the warning distance and clear condition are set through controlled testing before movement qualification; no arbitrary distance is assumed. Sensor data or warning faults never masquerade as a confirmed clear path.

## 5. Cross-cutting requirements

| ID | Requirement | Verification |
| --- | --- | --- |
| NFR-1 | Complete searching, including AI, works without internet after setup; local Wi-Fi is available. | Disconnect internet and complete registration, gesture and PS4 control, match review, and history access. |
| NFR-2 | Preferred wireless operation or permitted wired demonstration still supports a fixed-desk operator and connected-room robot operation. | Qualify commands/video on the agreed room-to-room route. |
| NFR-3 | Support Windows on the team's laptop with a dedicated NVIDIA GPU. | Record exact laptop/GPU specifications; qualify on that laptop. |
| NFR-4 | Persist local records/evidence until registration-based retention expires; default seven days. | Restart and expiry checks under FR-13/FR-15. |
| NFR-5 | Furnished-room testing uses stationary obstacles, people clear of the path, and visible floor/low-shelf targets. | Record layout and object placements with acceptance evidence. |
| NFR-6 | Stop, video, detection, and endurance targets apply to the complete system. | Execute section 7; isolated component results do not establish a pass. |

## 6. Scope and constraints

### In scope

Four-wheel manual movement; laptop-webcam gestures; PS4 DualShock 4 control; live robot video; HC-SR04 proximity warning; reference-image target selection; similarity alerts/bounding boxes; screenshot review; confirmation/rejection; session controls; emergency stop/failure recovery; local searchable history; configurable retention; offline runtime.

### Non-goals

- Autonomous navigation, obstacle avoidance/steering, servo functions, GPS, and room mapping. The HC-SR04 is limited to the advisory warning in FR-18.
- Object pickup/retrieval and guaranteed unique-belonging recognition.
- Concurrent operators, robots, or targets; changing control mode within a session.
- Public/social sharing, cloud accounts, and operating systems beyond Windows.

### Delivery responsibilities and software-facing equipment

As of 2026-11-06, Alisa reported a four-week completion window. The conditional planning target is 2026-12-04 if that window starts on 2026-11-06; the exact assessment date remains unconfirmed. The final result is demonstrated through supervised manual testing.

On 2026-11-07, Alisa assigned all physical assembly, wiring, power design, charging, component selection and electrical review to herself outside the software execution backlog. Any associated human approvals remain her responsibility. This ownership statement does not assert that hardware is ready. Software development may use clearly labeled fixtures/simulators without waiting for hardware; real-device activities require the relevant T2 handoff.

| Software-facing dependency | Required capability / handoff |
| --- | --- |
| Windows laptop with NVIDIA GPU | Reported LOQ 15IRH8, Windows 11 Pro, RTX 4050, 16 GB RAM; record actual environment and measured compatibility at T1/T3. |
| Laptop webcam | Fresh gesture frames under backend ownership. |
| PS4 DualShock 4 | Actual CUH unit/profile, D-pad and Circle mapping, connection behavior; PS5 remains out of scope. |
| Arduino Uno, HC-05 and motor output interface | Versioned serial command/response path, supplied pin/output mapping and operating limits, disabled outputs on boot/reset and independent command expiry. |
| ESP32-CAM OV2640 | Programming access and local Wi-Fi endpoint; custom firmware supplies capture identity, freshness metadata and clock-age exchange. Exact variant comes from the handoff. |
| HC-SR04 | Supplied access/telemetry arrangement and validity information for FR-18; warning/clear criteria are calibrated, not inferred. |
| Supplied four-wheel robot and network | Identifiable hardware configuration and scoped readiness from Alisa; command/video coverage and physical performance require integrated measurement. |

The [Phase 01 handoff specification](specs/PHASE-01-device-interface-handoff-spec.md) defines the software-facing record. Firmware consumes supplied pin assignments rather than inventing wiring. Physical hardware details retained in the [superseded baseline archive](archive/software-scope-transition-2026-11-07/README.md) are historical references, not current ratings or software tasks.

## 7. Success metrics and acceptance protocol

These are selected targets, not measured capabilities. Use the prescribed hardware, selected laptop, and recorded connected-room route. All functional requirements must also pass.

| ID | Target and method | Supports |
| --- | --- | --- |
| SM-1 | Five agreed test objects, ten clearly visible presentations each. Per object, at least seven must produce an alert within three seconds of clear visibility in live view. Record misses/late alerts. | FR-1, FR-2, FR-9 |
| SM-C1 | Ten separate ten-second scenes with no visually similar target. At most one scene may produce any false alert; count an alerted scene once. | FR-9; counterbalances SM-1 |
| SM-2 | Wheels stop within 0.5 seconds of input release, emergency stop, or actual loss of a required command/input/video path, including loss-detection time. | FR-5, FR-6, FR-7, FR-17 |
| SM-3 | Complete system runs twenty minutes without recharge, restart, or crash, exercising movement, video, AI, review, and history. | FR-3–FR-13, NFR-6 |
| SM-4 | Camera events appear in laptop live view within 0.5 seconds while movement control and AI are active. | FR-3, FR-7 |

Before SM-1/SM-C1, freeze the objects, reference images, placements, lighting, and matching settings. Negative scenes must not contain similar candidates the product is intended to suggest. Use fresh presentations/sessions as needed so rejection suppression does not contaminate counts. Record every trial, including failures.

For SM-2, test every direction in both modes, emergency stop in both modes, active-input disconnection, command loss, and disconnected/frozen video. Measure observable event/wheel timing; reconnection must also pass FR-17. For SM-4, record an observable camera event and laptop display together. Identify equipment/conditions with all results.

The room-to-room demonstration must keep the operator at the fixed desk, maintain video/control along the route, and search in more than one room. A same-room demonstration alone does not establish NFR-2. Record route dimensions and connection arrangement before qualification.

Verify FR-18 during controlled integration: the warning is visible, silent, self-clearing after the calibrated clear condition, and never changes movement/session state. Record the warning and clear thresholds.

## 8. Dependencies, risks, and deferred decisions

| Item | Owner and revisit condition | Effect |
| --- | --- | --- |
| Exact assessment date and any additional submission instructions | Team; confirm with supervisor. | Four-week planning window and supervised manual demonstration are recorded; calendar assessment date remains pending. |
| Exact laptop/GPU/Windows and controller unit | Team; establish before qualification. | LOQ 15IRH8, Windows 11 Pro, RTX 4050, 16 GB RAM and PS4 DualShock 4 are reported; support/performance remain unqualified until measured. |
| External hardware readiness | Alisa; scoped T2 handoff before each relevant real-device activity. | Physical construction, wiring, power, charging, component decisions and electrical review are externally owned. Record configuration identity, supplied interface details, programming access, permitted activity and unresolved restrictions. Missing hardware does not block independent software development. |
| Firmware/output interface compatibility | Software/firmware team with supplied configuration from Alisa; T1/T6 before device acceptance. | Pin assignments, direction/disabled behavior and operating limits must be supplied. Unknown values block the affected board-specific work; logical output reports do not prove physical wheel movement or stopping. |
| Fixed-desk two-room coverage, 0.5-second stops/video, twenty-minute endurance | Team; conduct controlled integration trials. | Two adjacent rooms and local Wi-Fi are reported; coverage and performance remain unqualified. |
| Obstacle-warning distance and clear threshold | Software/integration team; T4/T6 controlled tests before movement qualification. | Consume the supplied forward-facing HC-SR04 arrangement. Calibrate separate warning/clearing distances at the selected indoor speed. Silent visual advice only; invalid readings are unknown, never clear. |
| Five objects, references, route, lighting/placements | Team with doctor; freeze before qualification. | Defines the conditions where detection results apply. |
| Input calibration, actual controller profile, UI layout and matching settings | Team; measure/verify before functional testing. | Direction/button mappings and image-format limits are already adopted in the architecture/TRD; remaining thresholds and equipment behavior need qualification. |

AI failure, backend restart and unreviewed Stop outcomes are resolved by AD-6/TRD section 5; they are not deferred product decisions. Robotics-lab visual direction and the proposed accessibility targets were accepted during the 2026-11-06 interview; detailed visual choices and implemented accessibility evidence remain pending.

The 2026-11-07 responsibility change supersedes earlier hardware-first scheduling and electrical-design tasks. T2 is an external handoff, not a software-authored electrical review. T1/T3–T7 and all complete-system measurements remain open where unverified. Hardware ownership, a successful connection or a supplied configuration does not establish a product acceptance pass.

## 9. Approval

Version 1.0 was approved by Alisa on 2026-11-05. Version 1.1 records Alisa's 2026-11-06 scope and inventory decisions: PS4-only controller support (supervisor-approved), the purchased hardware, and the advisory HC-SR04 warning. This amendment does not close T2 or establish measured performance. The former electrical-work allocation is superseded by v1.2; warning calibration and measured performance remain pending.


Version 1.2 records Alisa's explicit 2026-11-07 approval of the complete software scope and external hardware ownership. It supersedes the earlier wiring/procurement work allocation and hardware-first scheduling. FR-1–FR-18, NFR-1–NFR-6 and all five metric targets remain required; no readiness or performance pass is claimed.
