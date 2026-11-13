# Design Brief — Lost and Found Application Screens

Create the screens for a **Next.js web application running locally on the user’s device and accessed through a laptop browser**.

The application lets one operator register a missing belonging, select its reference-image target, manually drive a camera robot using gestures or a PS4 controller, review potential matches, and inspect saved history.

## Navigation

Use a left sidebar with:

- Dashboard
- Objects / History
- Devices
- Control Guide
- Settings

Show a persistent **Return to Active Search** link whenever a session is Searching or Paused.

Registration, search setup, results, object details, and session details open through their related actions.

## 1. Dashboard

**Purpose:** Give the operator a starting point and overview.

**Content:**

- Recent object registrations.
- Recent search sessions and outcomes.
- Connection-readiness summary.
- Active-session summary showing target, control mode, and session state.

**Actions:**

- **Register Object** → registration step 1.
- **View Objects** → Objects / History.
- **View Devices** → Devices.
- **Return to Search** → active workspace.

**States:** First use with no objects, populated dashboard, active session, loading, and unavailable data.

## 2. Objects / History

**Purpose:** Browse and find registered belongings.

**Content:**

- Search by object name.
- All, Lost, and Found filters.
- Each record’s name, reference thumbnail, status, and registration time.

**Actions:**

- **Register Object**.
- Select a record → Object Details.
- **Start Search** for an eligible Lost record → Search Setup.

**States:** Empty library, populated library, no search results, loading, and retrieval failure.

An existing active session prevents starting another search.

## 3. Register Object — Step 1: Object Information

**Purpose:** Supply the object name and reference image.

**Content:**

- Required object-name field.
- Image upload through file selection or drag and drop.
- Selected-image preview.
- Accepted formats and limits: JPEG/PNG, up to 10 MiB and 20 megapixels.

**Actions:**

- **Replace Image**.
- **Remove Image**.
- **Next** → target selection.
- **Cancel** → Objects / History.

**States:** Empty form, image loading, image selected, missing name, unsupported format, oversized image, and unreadable image.

Preserve entered information when returning from step 2.

## 4. Register Object — Step 2: Select Target

**Purpose:** Identify the belonging inside the reference image.

**Content:**

- Reference-image editor.
- One adjustable rectangular selection.
- Keyboard-accessible position and size fields.
- Selected-region preview.
- Instructions explaining that only the selected region becomes the search target.

**Actions:**

- **Reset Selection**.
- **Back** → step 1.
- **Register Object** → save, then Object Details.

**States:** No selection, valid selection, invalid selection, saving, and save failure.

Registration requires a valid target rectangle. Replacing the reference image clears its previous selection.

## 5. Search Setup

**Purpose:** Prepare an eligible Lost object for searching.

**Content:**

- Object name, reference image, and target-region preview.
- Gesture or PS4 Controller mode selection.
- Instructions for the selected mode.
- Required connection and service readiness.
- Explanations for anything blocking Start.

**Actions:**

- **Start Search** → workspace after acceptance.
- **View Devices**.
- **Back** → Object Details.

**States:** Ready, required connection unavailable, matching service unavailable, active session already exists, starting, and start failure.

The selected mode and target remain fixed until the session ends.

## 6. Live Search Workspace

**Purpose:** Drive the robot and monitor the search.

**Content:**

- Left panel: laptop webcam and gesture feedback.
- Right panel: live robot video and AI results.
- Target name and reference thumbnail.
- Selected mode and session state.
- Current movement-input feedback.
- Connection readiness.
- Advisory proximity messages.
- Session activity and potential-match notification.

**Actions:**

- **Pause**.
- **Resume**, when eligible.
- **Stop Search**.
- **Emergency Stop**, always accessible during an active session.
- **Control Help**, opening a modeless guide.

In controller mode, label gesture control inactive. An unavailable webcam does not block controller operation.

### Match-review panel

Open a modeless panel when a potential match pauses the session.

Show:

- Reference target beside captured evidence.
- Bounding box on the captured evidence.
- Capture time.
- Explicit Paused state.
- **Confirm Match**, **Reject Match**, and **Stop Search**.

Label the screenshot **Captured evidence**.

Confirmation opens the Found result only after saving succeeds. Rejection keeps the object Lost and the session Paused until explicit Resume. Stopping during review records the candidate as Not reviewed.

### Recovery panel

Show:

- Each unresolved failure.
- Whether its required connection has been restored.
- Acknowledgment controls.
- Explanation of why Resume is unavailable.
- Resume when all required conditions are satisfied.

Reconnection alone never resumes operation. After recovery, explain that movement input must be released and applied again.

## 7. Search Result

**Purpose:** Explain the completed session’s outcome.

### Found outcome

- Object name.
- Confirmed evidence.
- Confirmation time.
- Session summary.
- **View Object Details**, **View Session Details**, and **Return to Dashboard**.

### Ended without confirmation

- Object name and Lost status.
- Session summary and end reason.
- **Search Again** → Search Setup.
- **View Session Details**.
- **Return to Dashboard**.

A Found record cannot be reopened as Lost. Another search requires a new registration.

If retention has removed the record after session end, explain its removal without displaying expired evidence.

## 8. Object Details

**Purpose:** Inspect a belonging and all related searches.

**Content:**

- Object name and Lost/Found status.
- Reference image and selected target.
- Registration time and expiry.
- Confirmation time and evidence, when Found.
- All related sessions with mode, timestamps, state, and outcome.

**Actions:**

- **Start Search** for an eligible Lost object.
- Open a session → Session Details.
- **Register Another Object**.
- **Back to Objects**.

**States:** Lost, Found, active-session expiry grace, unavailable media, expired record, and loading failure.

## 9. Session Details

**Purpose:** Inspect one search attempt.

**Content:**

- Related object.
- Control mode.
- Start/end times.
- Searching, Paused, or Ended state.
- End reason where applicable.
- Activity timeline.
- Match screenshots, bounding boxes, capture times, and review times.
- Confirmed, Rejected, and Not reviewed outcomes.

**Actions:**

- **View Object**.
- **Return to Active Search**, when applicable.
- Open evidence for closer inspection.

**States:** No matches, reviewed matches, interrupted session, and unavailable evidence.

Historical sessions are read-only.

## 10. Devices

**Purpose:** Explain connection availability and search readiness.

**Content:**

- Robot camera.
- Robot command connection.
- Laptop webcam.
- PS4 controller.
- Local matching service.
- Proximity-sensor availability.
- Explanations and troubleshooting guidance.

Distinguish required devices for the selected mode from inactive or advisory devices.

**Actions:**

- **Open Control Guide**.
- **Return to Search Setup** or **Return to Active Search**, when applicable.

## 11. Control Guide

**Purpose:** Explain operation and recovery.

Include:

- Gesture directions and stopping gestures.
- PS4 D-pad movement and Circle emergency stop.
- Held-input movement and release-to-stop behavior.
- Pause versus Stop Search versus Emergency Stop.
- Match confirmation and rejection.
- Connection-failure recovery.
- Fresh-input requirement after recovery.

Provide a standalone page and modeless workspace help panel using the same content.

## 12. Settings

**Purpose:** Manage record retention.

**Content:**

- Retention period: 1–30 whole days, default seven.
- Explanation that expiry is measured from registration.
- Current setting.
- Preview of records affected by a proposed change.
- Explicit confirmation before applying it.

**Actions:**

- **Preview Change**.
- **Confirm and Apply**.
- **Cancel Change**.

**States:** Unchanged, invalid value, preview loading, confirmation, saving, saved, save failure, and outdated preview.

Disable retention changes during Searching or Paused sessions and explain why.

## Additional Screen States

Include workspace variants for gesture control, PS4 control, ordinary pause, match review, rejected match, emergency stop, required-connection failure, and proximity warning.

Also cover:

- Startup initialization and interrupted-session recovery.
- Stale or disconnected video, with a persistent **Not live** label.
- Save pending and storage failure.
- Navigation away from an active workspace: pause before leaving and distinguish leaving paused from explicitly ending the session.
- Expiry during an active session, with temporary access until that session ends.
- Expired-data removal and incomplete-deletion feedback.

Keep emergency stop accessible throughout active-session panels and pending actions. Never present a pending save as a completed outcome.
