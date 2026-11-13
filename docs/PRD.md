---
title: "Lost and Found — Product Requirements Document"
status: final
version: "1.3"
created: 2026-11-05
updated: 2026-11-13
---

# Lost and Found — Product Requirements Document

## 1. Purpose and vision

Lost and Found helps people locate belongings in offices and shared spaces using a manually operated camera robot and a laptop application. The operator supplies a reference image, drives the robot through connected rooms, and reviews AI-generated potential matches. A human decision establishes that a belonging has been found; visual similarity alone never changes its status to Found.

This PRD defines the software scope for a university project assessed through a report and demonstration: the application, AI, device firmware, motion commands, software integration, records, stopping/recovery behavior, and measurable acceptance. Physical wiring and assembly are handled externally by Alisa. This requirements baseline includes the authorized 2026-11-13 amendment in section 9; it is not evidence of implemented or qualified performance. The canonical copy is maintained at `docs/PRD.md`.

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

Acceptance: the warning distance and clear condition are calibrated and verified through controlled integration tests; no arbitrary distance is assumed. Sensor data or warning faults never masquerade as a confirmed clear path. Synthetic readings verify warning logic but do not establish real distance accuracy.

## 5. Cross-cutting requirements

| ID | Requirement | Verification |
| --- | --- | --- |
| NFR-1 | Complete searching, including AI, works without internet after setup; local Wi-Fi is available. | Disconnect internet and complete registration, gesture and PS4 control, match review, and history access. |
| NFR-2 | Preferred wireless operation or permitted wired demonstration still supports a fixed-desk operator and connected-room robot operation. | Qualify commands/video on the agreed room-to-room route. |
| NFR-3 | Support Windows on the team's laptop with a dedicated NVIDIA GPU. | Record exact laptop/GPU specifications; qualify on that laptop. |
| NFR-4 | Persist local records/evidence until registration-based retention expires; default seven days. | Restart and expiry checks under FR-13/FR-15. |
| NFR-5 | Furnished-room testing uses stationary obstacles, people clear of the path, and visible floor/low-shelf targets. | Record layout and object placements with acceptance evidence. |
| NFR-6 | Stop, video, detection, and application-stability targets require the evidence specified in section 7. Physical wheel stopping and battery endurance remain external product integration targets. | Record software verification separately from real-device measurements; isolated component or simulator results do not establish a complete-system pass. |

## 6. Scope and constraints

### In scope

Manual forward/backward/left/right/stop commands; laptop-webcam gestures; PS4 DualShock 4 control; live robot video; HC-SR04 proximity warning; reference-image target selection; similarity alerts/bounding boxes; screenshot review; confirmation/rejection; session controls; emergency stop/failure recovery; local searchable history; configurable retention; offline runtime.

### Non-goals

- Autonomous navigation, obstacle avoidance/steering, servo functions, GPS, and room mapping. The HC-SR04 is limited to the advisory warning in FR-18.
- Object pickup/retrieval and guaranteed unique-belonging recognition.
- Concurrent operators, robots, or targets; changing control mode within a session.
- Public/social sharing, cloud accounts, and operating systems beyond Windows.

### Delivery context and required software capabilities

As of 2026-11-06, Alisa reported a four-week completion window. The conditional planning target is 2026-12-04 if that window starts on 2026-11-06; the exact assessment date remains unconfirmed. The final result is demonstrated through supervised manual testing.

Software development can proceed with clearly labeled fixtures and simulators without devices. Real-device software integration checks selected endpoints, protocol versions and firmware compatibility at T2; it does not require a physical-work handoff.

| Software capability | Required interface behavior |
| --- | --- |
| Local application and AI runtime | Windows/NVIDIA compatibility, local models/assets and offline operation; exact environment verified at T1/T3. |
| Motion commands | Versioned command/response path to Uno firmware through HC-05 serial; logical direction/stop handling, disabled output state on boot/reset, independent command expiry and explicit recovery. |
| Camera frames | Fresh laptop-webcam frames for gestures and ESP32-CAM frames for search; capture identity, freshness metadata, clock-age exchange and visible stale-feed handling. |
| Controller input | Selected PS4 DualShock 4 identity/profile, D-pad/Circle mapping, fresh samples and disconnect handling; PS5 remains out of scope. |
| Proximity observations | Distance units, validity and freshness for HC-SR04 telemetry; calibrated warning/clear criteria for FR-18. |
| Connection status | Selected serial/video/input endpoints, compatibility errors and recovery state; command/video coverage is measured on the connected-room route. |

## 7. Success metrics and acceptance protocol

These are selected targets, not measured capabilities. All functional requirements must also pass. Label evidence as software/simulator verification or real-device integration measurement, with the selected laptop, endpoints, versions and conditions. Section 9 records the acceptance wording amendment; no simulator result establishes physical performance.

| ID | Target and method | Supports |
| --- | --- | --- |
| SM-1 | Five agreed test objects, ten clearly visible presentations each. Per object, at least seven must produce an alert within three seconds of clear visibility in live view. Record misses/late alerts. | FR-1, FR-2, FR-9 |
| SM-C1 | Ten separate ten-second scenes with no visually similar target. At most one scene may produce any false alert; count an alerted scene once. | FR-9; counterbalances SM-1 |
| SM-2 | External product integration target: wheels stop within 0.5 seconds of input release, emergency stop, or actual loss of a required command/input/video path, including loss-detection time. Software verification separately measures permission revocation, command expiry and logical stop output; it does not prove wheel stopping. | FR-5, FR-6, FR-7, FR-17 |
| SM-3 | Software acceptance: the application runs twenty minutes without restart or crash, exercising movement commands, video, AI, review and history. Record whether inputs are simulated or device-connected. The original twenty-minute operation without recharge remains an external battery-endurance target, outside software implementation and separately measured. | FR-3–FR-13, NFR-6 |
| SM-4 | Camera events appear in laptop live view within 0.5 seconds while movement control and AI are active. | FR-3, FR-7 |

Before SM-1/SM-C1, freeze the objects, reference images, placements, lighting, and matching settings. Negative scenes must not contain similar candidates the product is intended to suggest. Use fresh presentations/sessions as needed so rejection suppression does not contaminate counts. Record every trial, including failures.

For SM-2 software verification, test every direction in both modes, emergency stop in both modes, active-input disconnection, command loss, and disconnected/frozen video. Record detection, revocation, transport/expiry and logical output timestamps, including queued/replayed commands and backend failure. Reconnection must also pass FR-17. The 0.5-second target is not reassigned as a software-only limit: external integration measurement must include observable event-to-wheel-stop timing and mechanical stopping. Software traces alone cannot close SM-2.

For SM-3, record application interruptions and the input source during the twenty-minute software run. A simulator run verifies stability only under its recorded load; it cannot prove device coverage, video latency or battery endurance. For SM-4, record an observable camera event and laptop display together under the specified load. Identify equipment/conditions with all results.

The room-to-room demonstration must keep the operator at the fixed desk, maintain video/control along the route, and search in more than one room. A same-room demonstration alone does not establish NFR-2. Record route dimensions and connection arrangement before qualification.

Verify FR-18 during controlled integration: the warning is visible, silent, self-clearing after the calibrated clear condition, and never changes movement/session state. Record the warning and clear thresholds.

## 8. Dependencies, risks, and deferred decisions

| Item | Owner and revisit condition | Effect |
| --- | --- | --- |
| Exact assessment date and any additional submission instructions | Team; confirm with supervisor. | Four-week planning window and supervised manual demonstration are recorded; calendar assessment date remains pending. |
| Exact laptop/GPU/Windows and controller unit | Team; establish before qualification. | LOQ 15IRH8, Windows 11 Pro, RTX 4050, 16 GB RAM and PS4 DualShock 4 are reported; support/performance remain unqualified until measured. |
| Device interface configuration and compatibility | Software/firmware team; T2 before accepting the affected device connection, with T1/T6 runtime and protocol locks. | Record selected endpoints/device identities, firmware build targets, protocol versions and validation/errors. Unknown or incompatible configuration blocks the dependent software connection; independent development continues with labeled simulators. Logical output reports do not prove wheel movement or stopping. |
| Fixed-desk two-room coverage, 0.5-second stops/video, twenty-minute stability | Team; controlled software and integration trials with evidence separated as in section 7. | Two adjacent rooms and local Wi-Fi are reported; coverage, latency and wheel stopping remain unqualified. Battery endurance is an external measurement. |
| Obstacle-warning distance and clear threshold | Software/integration team; T4/T6 controlled integration tests. | Validate distance units, validity/freshness and separate warning/clearing criteria. Silent visual advice only; invalid readings are unknown, never clear. |
| Five objects, references, route, lighting/placements | Team with doctor; freeze before qualification. | Defines the conditions where detection results apply. |
| Input calibration, actual controller profile, UI layout and matching settings | Team; measure/verify before functional testing. | Direction/button mappings and image-format limits are already adopted in the architecture/TRD; remaining thresholds and equipment behavior need qualification. |

AI failure, backend restart and unreviewed Stop outcomes are resolved by AD-6/TRD section 5; they are not deferred product decisions. Robotics-lab visual direction and the proposed accessibility targets were accepted during the 2026-11-06 interview; detailed visual choices and implemented accessibility evidence remain pending.

T2 now checks software interface configuration and compatibility. T1–T7 and integration measurements remain open where unverified. Alisa reports motors and Bluetooth working; that report does not establish camera freshness, watchdog/recovery behavior, connected-room coverage or any full product acceptance pass.

## 9. Approval

Version 1.0 was approved by Alisa on 2026-11-05. Version 1.1 records the 2026-11-06 decisions for PS4-only support (supervisor-approved) and the advisory HC-SR04 warning. Version 1.2 records Alisa's 2026-11-07 approval of the complete software scope and external ownership of physical work. Those approvals apply to their dated baselines.

Version 1.3 implements Alisa's approved cleanup plan on 2026-11-13. It removes physical-work procedures and handoff dependencies from the three core documents and replaces T2 with software interface configuration/compatibility. FR-1–FR-18, NFR-1–NFR-6 and metric IDs are retained. NFR-6 and SM-2/SM-3 now explicitly distinguish software verification from external measurements: the 0.5-second wheel-stop target remains an external integration target; the twenty-minute application stability criterion is separate from the original no-recharge battery-endurance target. This is a current acceptance wording amendment, not a claim that the new wording was approved in earlier versions or that physical targets have passed. Warning calibration, integration measurements and other unverified gates remain pending.
