---
title: "Lost and Found — API Contracts"
status: "Approved v1 API contract; implementation and qualification require verification"
version: "1.0"
created: 2026-11-13
updated: 2026-11-13
sources: [PRD.md, TRD.md, ARCHITECTURE.md]
---

# Lost and Found — API Contracts

## 1. Authority and approval

This is the approved browser/backend API contract for the local Lost and Found application. [PRD v1.3](PRD.md) owns scope and acceptance; [Architecture v1.4](ARCHITECTURE.md) owns technical invariants; [TRD v1.3](TRD.md), sections 5–10, supplies domain and integration requirements.

On 2026-11-13, Alisa approved the recommendations in interview questions Q1–Q21 and Q22–Q37, then authorized their incorporation with the additional definitions needed for a complete contract. This revision approves the history routes, pagination, wire shapes, validation, errors and retry policies below. It resolves the wire decisions referenced by Architecture's backend contract-ownership section and supersedes the earlier extraction's unselected alternatives. An approved wire choice does not change upstream product scope or establish measured device performance.

The embedded JSON Schemas use draft 2020-12 and define concrete public models. Endpoint mapping, authorization, transactions and cross-resource constraints are normative alongside them. Implementers export compliant FastAPI OpenAPI and event/frame schemas and generate frontend types; these are implementation deliverables, not artifacts asserted to exist here. `docs/IMPLEMENTATION_GUIDE.md` is absent; no requirement is attributed to it.

### 1.1 Versioning and compatibility

HTTP uses `/api/v1`; event/frame metadata uses integer `protocol_version: 1`; sockets negotiate `laf.v1`. Editorial version `1.0` is independent of device protocols and database migrations.

Frontend and backend ship as one coordinated compatible release. There is no cross-release compatibility promise for the initial release. Within v1, preserve field meanings, required fields, enum values and resource revision scope. Breaking changes require a new major HTTP namespace and/or application subprotocol, release notes, generated types and a coordinated disarmed upgrade. No automatic future-version negotiation or interpretation is permitted. Unsupported application versions return `PROTOCOL_UNSUPPORTED`; do not confuse this with WebSocket transport-version negotiation.

Requests, client socket messages and frame metadata reject unknown fields/types. Consumers may ignore additional optional response fields, but unknown state/enum/event/protocol values invalidate the affected projection: discard control eligibility, stop renewals and resynchronize or report incompatibility. Incompatible device messages block their dependent connection.

## 2. Transport, identity, validation and time

### 2.1 Addresses and deployment

Default frontend: `http://127.0.0.1:3000`. Default backend: `http://127.0.0.1:8000/api/v1`; sockets use `ws://127.0.0.1:8000/api/v1`. Both services bind only to `127.0.0.1`. The launcher may change both configured ports and the backend's single exact frontend-origin allowlist together. Never silently fall back to another port. Occupied ports produce an actionable startup failure.

FastAPI is the sole state, storage and device authority; Next.js supplies presentation. Normal operation requires no internet/cloud service. All catalogue paths are relative to `/api/v1`.

### 2.2 Shared scalar rules

| Value | Contract |
| --- | --- |
| Domain/runtime IDs | Backend-issued opaque ASCII strings, 1–128 characters from `A–Z a–z 0–9 _ -`; never paths, ordered timestamps or client-chosen domain identities. |
| `action_id` / `request_id` | Frontend-generated canonical lowercase UUIDv4 strings, exactly 36 characters. Generate a new ID for new work; preserve it on identical retries. Neither is a credential. |
| Revisions / generations / sequences | Integers 1–9,007,199,254,740,991. Initialize at 1, advance without wrapping. On exhaustion, disarm affected control and fail with `COUNTER_EXHAUSTED` before overflow. |
| Persistent timestamps | Nonnegative UTC integer milliseconds, within the same safe-integer bound. Registration time is immutable and backend-owned. |
| Runtime clocks | Monotonic deadlines; source capture timestamps are nonnegative integer microseconds. Never compare independent clocks without bounded offset/uncertainty. |
| Tokens | 32 cryptographically random bytes encoded as unpadded base64url: 43 characters. Use for capabilities, private lease IDs, socket tickets and cursor tokens. |
| Names | Trim surrounding Unicode whitespace, normalize NFC, then require 1–120 Unicode code points and at least one nonwhitespace character. Preserve internal spacing and display capitalization. Duplicate names are valid. |
| Name search | Normalize query with the same trim/NFC rules; use Unicode casefolded literal substring matching with parameterized SQL and escaped SQL wildcards. Pin Unicode behavior with T1. Empty normalized query means no name filter. |

Use exact domain enum casing: objects `Lost/Found`; sessions `Searching/Paused/Ended`; modes `Gestures/Controller`; matches `Pending/Confirmed/Rejected/NotReviewed`. UI text “Not reviewed” maps to `NotReviewed`.

### 2.3 Request parsing and bounds

- Accept UTF-8 `application/json`, optionally with `charset=utf-8`; reject other charset declarations and content types with `415`. Do not infer JSON from an unrelated media type.
- Reject malformed UTF-8, duplicate JSON keys, nonfinite numbers, unknown fields, coercion between strings/numbers/booleans, and floats where an integer is required. JSON syntax failures use `400`; schema/semantic validation uses `422`.
- Ordinary JSON request bodies are at most 65,536 bytes. Registration bodies are at most 11,534,336 bytes (11 MiB), with combined non-image field payloads at most 65,536 bytes. Validate actual streamed bytes, not only Content-Length; reject compressed request bodies with `415`.
- Registration contains exactly one each of `action_id`, `name`, `reference_image` and `roi`. The ROI part is UTF-8 JSON text; action/name parts are UTF-8 text; no duplicate or extra parts. Malformed multipart uses `INVALID_MULTIPART`; well-formed invalid fields use `VALIDATION_FAILED`.
- A source reference is at most 10,485,760 encoded bytes and 20,000,000 decoded pixels, inclusive. Check dimensions and decoding bounds before allocating unbounded images. Multipart overhead does not count as image bytes.
- Reject unknown query parameters, repeated query keys and forbidden/inapplicable action fields. IDs duplicated in route/body must agree. Query names have the same 120-code-point bound; limits accept base-10 integers only.
- Request-header limits, client message limits, frame bounds and bounded delivery queues are enforced before dependent allocation; section 10 defines the required qualification profile.

### 2.4 Resource revisions and concurrency

Only one Searching or Paused session exists globally. Its object and mode are locked through Pause. Start checks the object revision; session/review actions check the session revision; retention changes check the settings revision. Registration has no previous resource revision.

Increment each changed object's/settings/session revision exactly once per committed transaction. Starting a session creates session revision 1 without modifying unchanged object facts. Confirm changes the object and session; Reject changes the session/review; Stop changes the session and any pending review. Session state, pause-cause and owned recovery acknowledgment/restoration changes advance that session's revision. Identical observations, no-op Pause/acknowledgment and a retention commit with unchanged settings do not advance unchanged resource revisions. Matches have no independently exposed revision; their session serializes review.

Runtime control generations are boot-scoped and change on rearm/revocation; they are independent of durable resource revisions. Proximity telemetry never advances a session revision or changes readiness. Serialize candidate/terminal actions: the first valid terminal commit wins. Events cannot substitute for expected-revision checks.

## 3. Local protection, client lifetime and caching

### 3.1 Host, Origin and capability

No accounts, roles, passwords or login screen exist. People using the same Windows account share its application data. Protection does not isolate against malicious software running as that Windows user.

1. Validate backend Host against the exact configured `127.0.0.1:<port>` authority; reject alternate hosts, duplicate Host and untrusted forwarded-host overrides.
2. Bootstrap and browser socket upgrades require the exact configured frontend Origin. Reject missing, `null` and foreign origins on those endpoints. Browser HTTP requests with an Origin must use that same exact origin.
3. Except bootstrap and valid preflight, all HTTP endpoints, including health, require `X-App-Capability`. Protected HTTP with a missing Origin is accepted only with a valid capability and Host, supporting authorized launcher/native clients. A literal `Origin: null` is rejected.
4. CORS preflight requires the allowed Origin, an existing route/method, and only approved headers: `Content-Type`, `X-App-Capability`, `X-App-Client-Id`, `X-Action-Created-At-Ms`. Return `204` with the exact allow-origin, allowed requested method/headers and `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers`; no credentialed or wildcard CORS and no long-lived preflight caching. Preflight obtains no data or movement rights.
5. Bootstrap returns a fresh `client_id` for each page load, `backend_boot_id`, `capability`, `server_time_ms` and nullable `qualification_profile` (the safe FrontendProfile summary). Cache it only in page memory. The summary supplies parser bounds and heartbeat/display timing before opening sockets, plus Fixture/Device labeling. Without it, use protected HTTP diagnostics and keep dependent sockets/control unavailable. Launcher already has the capability for health checks. Reload is a new client and requires explicit control acquisition.
6. Use `X-App-Client-Id` for client context on registration, snapshot, all three paginated list reads, retention preview and retention commit. Other routes identify the client in their body when specified. If both header/body provide identity they must agree. An ID alone does not authorize another client's lease.
7. Rotate capability, boot identity and all runtime tickets/leases on backend restart. Never place capabilities, tickets or lease secrets in URLs, logs, browser persistence, public assets or shared event payloads.

Client registrations last while their event connection/lease is live, or until 30 minutes without any authenticated client activity. Expired/unknown clients return `CLIENT_INVALID` and must bootstrap again; no implicit control transfer follows. Allow at most 64 live clients. Reclaim only inactive expired slots; capacity failure never evicts a healthy controller.

### 3.2 WebSocket tickets

`POST /websocket-tickets` accepts `{client_id, channel}` with channel `events`, `robot-video` or `webcam-video`. Return `{ticket, expires_at_ms}`; lifetime is 10 seconds, enforced by a backend monotonic deadline. Scope to boot/client/channel, store only bounded runtime state and atomically consume before upgrade.

Browser offers `Sec-WebSocket-Protocol: laf.v1, laf.ticket.<ticket>`. Require exactly one application-version offer and one ticket offer; select only `laf.v1`, never echo/select the ticket. Missing/wrong-channel/unknown ticket: `403 TICKET_INVALID`; known expired: `403 TICKET_EXPIRED`; known consumed: `403 TICKET_CONSUMED`. Remove expired runtime ticket knowledge after its original deadline; later requests may report invalid. Limit to 32 outstanding tickets per client; no ticket grants a lease.

One event connection is authoritative per client. Replacement disarms/revokes any lease held through that client's old connection before establishing the new connection. Robot/webcam video connections are independently ticketed; duplicate replacement invalidates affected display readiness. Closing a spectator's channel cannot revoke another client's lease. Controller mode does not require webcam availability; required robot-video or selected-mode input loss does revoke the controller.

### 3.3 Authorization matrix

| Operation | Additional checks |
| --- | --- |
| Reads / snapshot / media | Owner eligibility, expiry/grace, lifecycle/integrity; clients may spectate without a lease. |
| Lease acquire/release | Issued client, boot, runtime deduplication and current lease state; release proves lease ID and generation. Never evict a healthy owner. |
| New Start/session/review mutation | Issued client and live control lease, object/session/candidate/failure ownership, applicable revision, valid transition, eligibility, deduplication. Start/Resume also require current readiness and recovery gates. |
| Registration | Issued client and capability, submission-age rule, complete image/name/ROI, healthy storage; no control lease. Independent registration during another session is allowed. |
| Retention preview/change | Issued client and capability, no Searching/Paused session, storage health, settings revision; commit requires matching client-bound preview/confirmation. No control lease. |
| Emergency stop | Valid Host/Origin/capability. No current lease, revision, session or readiness prerequisite. |
| Existing committed durable retry | Local protection, current data eligibility, matching action fingerprint; return original result before stale revision or replaced lease/client rejection. This is receipt recovery, never new movement authorization. |

### 3.4 Privacy, expiry and media headers

All API JSON, binary media and HTTP error responses use `Cache-Control: no-store`. Do not persist evidence in browser storage, service-worker caches, Next.js image/data caches, public directories, logs or an independent backup. Protected media is fetched directly with the capability; revoke browser object URLs and discard decoded copies when the view clears/expires.

`expiry = registered_at_ms + retention_days × 86,400,000`. Retention is 1–30 whole days, initial 7. An existing Searching/Paused session alone grants owner grace until it ends; grace never permits another session. Every page/read/action rechecks current eligibility even when a cursor/receipt was previously valid. Recompute on settings changes, session end, wake and clock changes. Re-evaluate expiration before new registration admission; do not silently accept a wall-clock discontinuity that would make an already expired submission fresh again. A detected invalid clock state blocks new registration with `NOT_READY` until restored, without blocking Stop.

Startup recovers storage and interrupted sessions and purges expired records before exposing history/search. Runtime expiry hides data immediately; deletion proceeds through the durable purge journal. Cleanup failure reports incomplete deletion and blocks new searches/data changes until repair; safety Stop/Pause and required recovery/cleanup remain available. Managed rows/files must actually be removed before reporting deletion complete. This does not delete the user's original chosen source file or promise forensic erasure.

Media responses use the validated `image/jpeg` or `image/png`, `X-Content-Type-Options: nosniff` and `Accept-Ranges: none`. Ignore a valid Range request and return the complete eligible image with `200`; no `206` or image validator cache contract is provided. No tokenized URLs, static media root, raw paths or checksum substitutes for evidence are exposed.

## 4. Endpoint catalogue

Resource reads return their model directly, without a generic data wrapper. List reads return `{items, next_cursor}`. Successful durable mutations return `MutationResponse`; runtime lease/emergency operations use their specific response. Plain HTTP failures use `Error` except the explicit emergency persistence result.

| Method and path | Request / query | Success |
| --- | --- | --- |
| `GET /bootstrap` | Exact Origin/Host; no query/body | `200 BootstrapResponse` |
| `POST /websocket-tickets` | `TicketRequest` | `200 TicketResponse` |
| `POST /control-lease` | `LeaseAcquire` | `200 LeaseResponse` |
| `POST /control-lease/release` | `LeaseRelease` | `200 LeaseResponse` after completed pause persistence; `202` while pending, represented in its snapshot |
| `GET /health` | Capability; no query/body | `200 Health`; `503 Health` during initialization/storage degradation |
| `GET /snapshot` | Capability + client header; no query/body | `200 Snapshot` |
| `GET /objects` | Optional `name`, `status`, `cursor`, `limit` | `200 ObjectPage` |
| `POST /objects` | Four multipart parts; client and submission-time headers | `201 MutationResponse` when committed; `202` when pending |
| `GET /objects/{id}` | Object ID | `200 Object` |
| `GET /objects/{id}/sessions` | Parent ID; optional `cursor`, `limit` | `200 SessionPage` |
| `POST /sessions` | `StartRequest` | `201 MutationResponse` when committed; `202` when pending |
| `GET /sessions/{id}` | Session ID, parent eligibility | `200 Session` |
| `GET /sessions/{id}/matches` | Parent ID; optional `cursor`, `limit` | `200 MatchPage` |
| `POST /sessions/{id}/actions` | `SessionAction`; route/body session IDs agree | `200 MutationResponse` when committed; `202` when pending |
| `POST /emergency-stop` | `EmergencyStopRequest` | `200/202 EmergencyStopResponse`; `503` for failed persistence with revocation reported |
| `GET /settings` | No query/body | `200 Settings` |
| `POST /settings/retention-preview` | Client header; `RetentionPreviewRequest` | `200 RetentionPreview`; no domain action ID |
| `PUT /settings/retention` | Client header; `RetentionChange` | `200 MutationResponse` when settings committed; `202` while settings persistence pending |
| `GET /media/{id}` | Generated media ID | `200` complete binary eligible image |
| `WS /events` | Client/channel ticket and `laf.v1` | Initial snapshot, then ordered events; workspace heartbeats inbound |
| `WS /video/robot` | Robot-video ticket and `laf.v1` | Bounded binary robot frames |
| `WS /video/webcam` | Webcam-video ticket and `laf.v1` | Bounded backend-owned webcam frames |

Creation responses include a relative `Location` for the new resource when committed. Committed durable retries preserve original status/body/Location, subject to current owner eligibility. Runtime lease retries preserve the historical lease outcome but attach a fresh eligible snapshot, so expired evidence is never retained or replayed. Lease release revokes immediately; its `snapshot.runtime.persistence_pending` and action-correlated operation distinguish unfinished saving. Failed release persistence returns `503 Error` with `permission_revoked: true`. Health's `503` body intentionally remains Health for startup diagnostics; invalid protection/other health request errors use Error.

No object update/delete, Found reopening, arbitrary filesystem import, public observation upload, direction endpoint, receipt lookup, full-video download, account or sharing route exists in v1. A Found belonging requires a fresh independent registration.

### 4.1 Session transitions and recovery

| Action | Required extra fields | Result |
| --- | --- | --- |
| `pause` | None | Immediate revocation/matching stop; Paused with `ManualPause`. A new action on an already Paused session is a committed no-op with unchanged revision/causes. |
| `resume` | None | Paused only; all required paths restored, owned failures restored and acknowledged, no pending review, current lease/display/workspace. Commit Searching; then require neutral and fresh input. |
| `stop` | None | Immediate stop; Ended/`Stopped`, object remains Lost. Pending candidate becomes `NotReviewed` with null review time. A new Stop on Ended conflicts. |
| `acknowledge` | Nonempty, unique `failure_ids`, at most 64 | Every occurrence belongs to the session. May acknowledge before restoration. Already acknowledged occurrences are no-ops; acknowledgment never Resumes. |
| `confirm` | `candidate_id` only | Pending owned candidate and available durable evidence; atomically Confirmed/review time + Found/time + Ended/`Confirmed` + receipt. |
| `reject` | `candidate_id` only | Rejected/review time, object Lost, session Paused/`ReviewRejected` until explicit Resume; retain continuity suppression. |

Reject action-inapplicable fields, unknown actions and cross-owner associations. New invalid transitions conflict; identical action-ID retries deduplicate. Confirmation and Stop cannot reverse another committed terminal outcome. Emergency revocation still applies during any race.

Paused cause entries are `{cause, failure_id}`. `RecoveryRequired` references a specific failure; other causes require null failure ID. Multiple distinct causes may coexist. Confirm/Stop clear pause causes. Resume clears the current restored/acknowledged pause/review causes atomically. A repeated user Pause never clears a recovery or pending review.

Every failure has its own `failure_id`, nullable `session_id`, typed `cause`, `observed_at_ms`, `restored` and `acknowledged`. Repeated observations of an outstanding occurrence reuse it; a failure after restoration is a new occurrence. Keep session-owned failures blocking Resume until both restored and acknowledged; then remove from the current unresolved set as part of reconciliation. Pre-session failures with null session ID are readiness diagnostics, settle on restoration, and do not require an acknowledgment action against a nonexistent session. New sessions still require readiness and initial neutral/reapply. Remove expired owner-scoped failure payloads; retain only non-identifying component diagnostics if a path remains unavailable. Ordinary healthy directional release is not a fault: Searching may remain active and rearm only after neutral then fresh hold. A held input never clears an emergency/recovery latch.

Candidate exposure follows revocation and durable evidence preparation. Reject suppression tracks session-level continuity, not permanent object identity. Uncertain continuity retains suppression without imposing an absent-view prerequisite on Resume. Backend restart ends every durable unfinished session as `Interrupted` and converts durably prepared pending evidence to `NotReviewed`; never reconstruct unsaved evidence.

### 4.2 Lease workflow

Views/readiness/previews do not acquire control. Bootstrap → event/video sockets → snapshot and decoded robot frames → explicit acquisition → valid current-generation heartbeat/display acknowledgment → Start/Resume readiness → neutral → fresh input. A pre-session heartbeat has `session_id: null`. An initial `displayed_robot_frame: null` cannot satisfy video readiness. Setup must present a usable focused operational workspace before Start is eligible.

Acquire names the current nullable active session. `takeover: false` is initial acquisition; `takeover: true` explicitly consents to acquisition/reacquisition of available ownership, including transfer following release/expiry, and is also accepted for an initially Unowned lease. Require true when restoring control to an existing active session or following previous ownership in this boot. It never evicts a live owner. A new acquire request while any lease is owned, including by the same client, fails `LEASE_OWNED`; only an identical request-ID retry returns that acquisition's result.

Acquisition also requires that client's live authoritative event connection and compatible active profile. Public `can_acquire` is false if either prerequisite is absent or ownership is live; an Unowned lease alone does not assert complete acquisition eligibility. Acquisition has no movement authority and may precede resolution of other device readiness failures.

Release proves `client_lease_id`, `control_generation` and current nullable `session_id`. Acquisition/revocation advances boot-scoped generation as needed; snapshots and readiness events publish the current generation. Never grant movement from a stale generation. The acquired private lease ID is returned only in that acquisition response/identical runtime retry, never shared snapshots or events; release responses set it null. Knowing public `owner_client_id` is insufficient to retrieve a lease secret.

### 4.3 Retention previews and commits

Preview request is exactly `{expected_revision, retention_days}` with client context in the header. It is a read-only calculation, requires no action ID, and is unavailable during an active session. Return `preview_id`, `settings_revision`, `retention_days`, `evaluated_at_ms`, `expires_at_ms` and `impact` counts (`objects`, `sessions`, `matches`, `managed_image_bytes`) for the records that become immediately ineligible under that change.

Bind a preview to boot/client/settings revision/proposed days and its affected-record identities, media membership and byte totals; hold it for 60 seconds using a monotonic deadline. At commit recompute impact against original registration times. New expiry crossings, changed affected membership or sizes, different client/days/revision and expired preview fail `PREVIEW_STALE`. An unrelated registration that leaves impact unchanged does not invalidate a preview. A valid no-op change may commit a receipt without advancing settings revision.

Commit uses `action_id, expected_revision, retention_days, preview_id, confirmed: true`. Receipt recovery precedes preview-expiry/client/revision rejection for an already committed identical request. Commit settings and receipt atomically, deny newly expired data immediately, then complete journaled deletion. `deletion.status` is `Pending`, `Complete` or `Failed`; never roll back committed settings or claim deletion complete because only the settings write succeeded.

## 5. Images, ROI, evidence and projections

Accept static 8-bit grayscale/RGB baseline or progressive JPEG, and static 8-bit grayscale/RGB/RGBA PNG. Indexed PNG is accepted only when its validated decoded output is 8-bit RGB/RGBA within the same limits. Reject animated PNG, CMYK JPEG, unsupported high-bit-depth inputs and corrupt/unusable files. Check signature and full decode, not filename/MIME alone.

Normalize orientation first; composite alpha onto white before ROI selection; copy to an application-owned normalized image and remove unnecessary metadata. The frontend displays the same normalized pixels on which the backend validates the ROI. The backend repeats every check. Replacing the reference clears the selection. Preserve accepted normalized JPEG references as JPEG and PNG references as PNG; pixel/ROI correspondence is to the normalized application image, not EXIF/display coordinates.

ROI/box use nested `{x,y,width,height}` in source/evidence pixels; x/y are nonnegative, dimensions positive, sums in bounds. Stored inference boxes round left/top down and right/bottom up, clamp to evidence dimensions and reject an empty result. Saved evidence is a full lossless PNG of the decoded candidate frame, without a painted box, with frame/stream identity preserved. UI draws the immutable saved box separately on that exact frame and labels it “Captured evidence.”

Every object has one reference; every candidate has one evidence media association. Match `id` is the `candidate_id` used by review actions. Media role/owner must match the containing object/candidate. Lists/details serialize the same models; histories are separate routes. Reference/evidence metadata availability is `Available`, `Missing` or `Corrupt`. Missing/corrupt committed media remains explicit metadata and `GET /media/{id}` returns `503 MEDIA_UNAVAILABLE`. Unknown media returns `404`; known expired media returns `410`. Later media corruption does not rewrite an earlier committed Found/review result.

For Found objects, `found_at_ms` is nonnull; Lost requires null. Ended sessions have nonnull end time/reason and no pause causes; other states have null end time/reason. Searching has no pause causes. Confirmed/Rejected matches have a review time; Pending/NotReviewed require null. Runtime effective session state is separately projected when the durable session has not caught up with an immediate safety transition.

## 6. Cursor pagination

All three list routes accept optional `cursor` and `limit`, default 25, range 1–100. Objects also accept optional `name` and `status=Lost|Found`. Newest first:

| Route | Keyset order |
| --- | --- |
| `/objects` | `registered_at_ms DESC, id DESC` |
| `/objects/{id}/sessions` | `started_at_ms DESC, id DESC` |
| `/sessions/{id}/matches` | `captured_at_ms DESC, id DESC` |

ID ties compare exact ASCII bytes using SQLite BINARY collation, with no case folding. Return `{items, next_cursor}`; null cursor means no further eligible entries. No total count.

Cursor tokens are unguessable server-side references, bound to version/boot/client/route/parent/normalized filters/limit/order/last emitted tuple. They contain no public object name, evidence, capability or filesystem path. Continuation excludes the last emitted tuple and must repeat the same filters/limit (omission is accepted only where it normalizes to the original defaults). Malformed, tampered or mismatched tokens return `400 CURSOR_INVALID`. Unknown well-formed tokens or known expired/reclaimed tokens return `400 CURSOR_EXPIRED`; clients restart page one.

Cursors expire after 30 minutes from issuance and on backend restart. Maintain at most 32 outstanding cursors per client and 1,024 globally; reclaim expired entries first, then the oldest inactive cursor. Reclamation never changes data eligibility. No cross-page snapshot guarantee: refresh to see new entries above the boundary, status changes may alter membership, and expiry may produce an empty final page. An expired parent fails its history read regardless of cursor validity.

## 7. JSON Schemas

All properties listed as required must be present; nullable is explicit. Public outputs are the closed v1 models below; compatible future optional fields may be ignored by consumers under section 1.1. `RegistrationFields` describes the three text-decoded fields; the required binary `reference_image` part and submission header are additionally enforced by section 2/8.

Cross-field dimensions, ownership, unique components/causes, monotonic sequence progression, expiry, journal durability, action-specific result selection and permission/recovery constraints require backend checks beyond JSON Schema. `Error.snapshot` is an optional shallow reconciliation aid: retain every operation's required result/error fields, but omit the optional `snapshot` inside nested operation errors so error/snapshot references do not produce recursive payloads.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Lost and Found API v1 approved contracts",
  "$comment": "Select a definition by fragment; endpoint and cross-resource rules are normative in this document.",
  "$defs": {
    "Id": {"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"},
    "RequestId": {"type":"string","pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"},
    "Counter": {"type":"integer","minimum":1,"maximum":9007199254740991},
    "UtcMs": {"type":"integer","minimum":0,"maximum":9007199254740991},
    "Name": {"type":"string","minLength":1,"maxLength":120,"pattern":"\\S"},
    "Token": {"type":"string","pattern":"^[A-Za-z0-9_-]{43}$"},
    "FrontendProfile": {"type":"object","additionalProperties":false,"required":["profile_id","protocol_version","evidence_kind","max_header_bytes","max_frame_bytes","max_frame_width","max_frame_height","max_frame_pixels","max_event_message_bytes","max_client_message_bytes","heartbeat_interval_ms","heartbeat_deadline_ms","display_deadline_ms","capture_age_limit_ms"],"properties":{"profile_id":{"$ref":"#/$defs/Id"},"protocol_version":{"const":1},"evidence_kind":{"enum":["Fixture","Device"]},"max_header_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_width":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_height":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_pixels":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_event_message_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_client_message_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"heartbeat_interval_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"heartbeat_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"display_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"capture_age_limit_ms":{"type":"integer","minimum":1,"maximum":9007199254740991}}},
    "ControlMode": {"enum":["Gestures","Controller"]},
    "Channel": {"enum":["events","robot-video","webcam-video"]},
    "Rect": {"type":"object","additionalProperties":false,"required":["x","y","width","height"],"properties":{"x":{"type":"integer","minimum":0,"maximum":9007199254740991},"y":{"type":"integer","minimum":0,"maximum":9007199254740991},"width":{"type":"integer","minimum":1,"maximum":9007199254740991},"height":{"type":"integer","minimum":1,"maximum":9007199254740991}}},
    "EndReason": {"enum":["Confirmed","Stopped","Interrupted"]},
    "FailureCause": {"enum":["EmergencyStop","WorkspaceDisconnected","WorkspaceHidden","WorkspaceUnfocused","WorkspaceUnusable","HeartbeatExpired","DisplayStale","RobotVideoUnavailable","CameraEpochChanged","CommandUnavailable","CommandExpired","InputUnavailable","AIUnavailable","StorageFault","ProtocolMismatch"]},
    "PauseCause": {"type":"object","additionalProperties":false,"required":["cause","failure_id"],"properties":{"cause":{"enum":["ManualPause","CandidateReview","ReviewRejected","RecoveryRequired"]},"failure_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]}},"allOf":[{"if":{"properties":{"cause":{"const":"RecoveryRequired"}}},"then":{"properties":{"failure_id":{"$ref":"#/$defs/Id"}}},"else":{"properties":{"failure_id":{"type":"null"}}}}]},
    "Failure": {"type":"object","additionalProperties":false,"required":["failure_id","session_id","cause","observed_at_ms","restored","acknowledged"],"properties":{"failure_id":{"$ref":"#/$defs/Id"},"session_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"cause":{"$ref":"#/$defs/FailureCause"},"observed_at_ms":{"$ref":"#/$defs/UtcMs"},"restored":{"type":"boolean"},"acknowledged":{"type":"boolean"}}},
    "Media": {"type":"object","additionalProperties":false,"required":["id","role","content_type","width","height","byte_length","created_at_ms","availability"],"properties":{"id":{"$ref":"#/$defs/Id"},"role":{"enum":["Reference","Evidence"]},"content_type":{"enum":["image/jpeg","image/png"]},"width":{"type":"integer","minimum":1,"maximum":9007199254740991},"height":{"type":"integer","minimum":1,"maximum":9007199254740991},"byte_length":{"type":"integer","minimum":1,"maximum":9007199254740991},"created_at_ms":{"$ref":"#/$defs/UtcMs"},"availability":{"enum":["Available","Missing","Corrupt"]}}},
    "Object": {"type":"object","additionalProperties":false,"required":["id","name","status","registered_at_ms","found_at_ms","revision","roi","reference_media","expires_at_ms","retention_grace"],"properties":{"id":{"$ref":"#/$defs/Id"},"name":{"$ref":"#/$defs/Name"},"status":{"enum":["Lost","Found"]},"registered_at_ms":{"$ref":"#/$defs/UtcMs"},"found_at_ms":{"anyOf":[{"$ref":"#/$defs/UtcMs"},{"type":"null"}]},"revision":{"$ref":"#/$defs/Counter"},"roi":{"$ref":"#/$defs/Rect"},"reference_media":{"$ref":"#/$defs/Media"},"expires_at_ms":{"$ref":"#/$defs/UtcMs"},"retention_grace":{"type":"boolean"}},"allOf":[{"if":{"properties":{"status":{"const":"Found"}}},"then":{"properties":{"found_at_ms":{"$ref":"#/$defs/UtcMs"}}},"else":{"properties":{"found_at_ms":{"type":"null"}}}},{"properties":{"reference_media":{"properties":{"role":{"const":"Reference"}}}}}]},
    "Session": {"type":"object","additionalProperties":false,"required":["id","object_id","control_mode","state","started_at_ms","ended_at_ms","end_reason","revision","pause_causes"],"properties":{"id":{"$ref":"#/$defs/Id"},"object_id":{"$ref":"#/$defs/Id"},"control_mode":{"$ref":"#/$defs/ControlMode"},"state":{"enum":["Searching","Paused","Ended"]},"started_at_ms":{"$ref":"#/$defs/UtcMs"},"ended_at_ms":{"anyOf":[{"$ref":"#/$defs/UtcMs"},{"type":"null"}]},"end_reason":{"anyOf":[{"$ref":"#/$defs/EndReason"},{"type":"null"}]},"revision":{"$ref":"#/$defs/Counter"},"pause_causes":{"type":"array","items":{"$ref":"#/$defs/PauseCause"},"uniqueItems":true}},"allOf":[{"if":{"properties":{"state":{"const":"Ended"}}},"then":{"properties":{"ended_at_ms":{"$ref":"#/$defs/UtcMs"},"end_reason":{"$ref":"#/$defs/EndReason"},"pause_causes":{"maxItems":0}}},"else":{"properties":{"ended_at_ms":{"type":"null"},"end_reason":{"type":"null"}}}},{"if":{"properties":{"state":{"const":"Searching"}}},"then":{"properties":{"pause_causes":{"maxItems":0}}}},{"if":{"properties":{"state":{"const":"Paused"}}},"then":{"properties":{"pause_causes":{"minItems":1}}}}]},
    "Match": {"type":"object","additionalProperties":false,"required":["id","session_id","object_id","captured_at_ms","frame_id","stream_epoch","box","disposition","reviewed_at_ms","evidence_media"],"properties":{"id":{"$ref":"#/$defs/Id"},"session_id":{"$ref":"#/$defs/Id"},"object_id":{"$ref":"#/$defs/Id"},"captured_at_ms":{"$ref":"#/$defs/UtcMs"},"frame_id":{"$ref":"#/$defs/Id"},"stream_epoch":{"$ref":"#/$defs/Id"},"box":{"$ref":"#/$defs/Rect"},"disposition":{"enum":["Pending","Confirmed","Rejected","NotReviewed"]},"reviewed_at_ms":{"anyOf":[{"$ref":"#/$defs/UtcMs"},{"type":"null"}]},"evidence_media":{"$ref":"#/$defs/Media"}},"allOf":[{"if":{"properties":{"disposition":{"enum":["Confirmed","Rejected"]}}},"then":{"properties":{"reviewed_at_ms":{"$ref":"#/$defs/UtcMs"}}},"else":{"properties":{"reviewed_at_ms":{"type":"null"}}}},{"properties":{"evidence_media":{"properties":{"role":{"const":"Evidence"},"content_type":{"const":"image/png"}}}}}]},
    "Settings": {"type":"object","additionalProperties":false,"required":["retention_days","revision","updated_at_ms"],"properties":{"retention_days":{"type":"integer","minimum":1,"maximum":30},"revision":{"$ref":"#/$defs/Counter"},"updated_at_ms":{"$ref":"#/$defs/UtcMs"}}},
    "ErrorCode": {"enum":["INVALID_JSON","INVALID_MULTIPART","VALIDATION_FAILED","PAYLOAD_TOO_LARGE","UNSUPPORTED_MEDIA_TYPE","HOST_REJECTED","ORIGIN_REJECTED","CAPABILITY_INVALID","CLIENT_INVALID","LEASE_REQUIRED","LEASE_EXPIRED","LEASE_OWNED","REVISION_CONFLICT","ACTION_ID_CONFLICT","REQUEST_ID_CONFLICT","ACTION_EXPIRED","INVALID_TRANSITION","ACTIVE_SESSION_EXISTS","PENDING_REVIEW","RECOVERY_REQUIRED","OWNERSHIP_MISMATCH","PREVIEW_STALE","CURSOR_INVALID","CURSOR_EXPIRED","NOT_FOUND","EXPIRED","MEDIA_UNAVAILABLE","NOT_READY","STORAGE_UNAVAILABLE","INITIALIZING","PROTOCOL_UNSUPPORTED","TICKET_INVALID","TICKET_EXPIRED","TICKET_CONSUMED","CAPACITY_REACHED","COUNTER_EXHAUSTED","INTERNAL_ERROR"]},
    "FieldError": {"type":"object","additionalProperties":false,"required":["path","code","message"],"properties":{"path":{"type":"string","minLength":1,"maxLength":256},"code":{"enum":["REQUIRED","UNKNOWN_FIELD","INVALID_TYPE","INVALID_VALUE","OUT_OF_RANGE","DUPLICATE_FIELD","DUPLICATE_VALUE"]},"message":{"type":"string","minLength":1,"maxLength":512}}},
    "Error": {"type":"object","additionalProperties":false,"required":["code","message","retryable"],"properties":{"code":{"$ref":"#/$defs/ErrorCode"},"message":{"type":"string","minLength":1,"maxLength":1024},"retryable":{"type":"boolean"},"revision":{"$ref":"#/$defs/Counter"},"snapshot":{"$ref":"#/$defs/Snapshot"},"field_errors":{"type":"array","items":{"$ref":"#/$defs/FieldError"},"maxItems":64},"action_id":{"$ref":"#/$defs/RequestId"},"permission_revoked":{"type":"boolean"}}},
    "DeletionProgress": {"type":"object","additionalProperties":false,"required":["status","remaining_objects","remaining_files","error_code"],"properties":{"status":{"enum":["Pending","Complete","Failed"]},"remaining_objects":{"type":"integer","minimum":0,"maximum":9007199254740991},"remaining_files":{"type":"integer","minimum":0,"maximum":9007199254740991},"error_code":{"anyOf":[{"$ref":"#/$defs/ErrorCode"},{"type":"null"}]}},"allOf":[{"if":{"properties":{"status":{"const":"Complete"}}},"then":{"properties":{"remaining_objects":{"const":0},"remaining_files":{"const":0},"error_code":{"type":"null"}}}},{"if":{"properties":{"status":{"const":"Failed"}}},"then":{"properties":{"error_code":{"$ref":"#/$defs/ErrorCode"}}},"else":{"properties":{"error_code":{"type":"null"}}}}]},
    "MutationResult": {"type":"object","additionalProperties":false,"required":["object","session","match","settings","deletion"],"properties":{"object":{"anyOf":[{"$ref":"#/$defs/Object"},{"type":"null"}]},"session":{"anyOf":[{"$ref":"#/$defs/Session"},{"type":"null"}]},"match":{"anyOf":[{"$ref":"#/$defs/Match"},{"type":"null"}]},"settings":{"anyOf":[{"$ref":"#/$defs/Settings"},{"type":"null"}]},"deletion":{"anyOf":[{"$ref":"#/$defs/DeletionProgress"},{"type":"null"}]}}},
    "MutationResponse": {"type":"object","additionalProperties":false,"required":["action_id","persistence","result","error"],"properties":{"action_id":{"$ref":"#/$defs/RequestId"},"persistence":{"enum":["Pending","Committed","Failed"]},"result":{"anyOf":[{"$ref":"#/$defs/MutationResult"},{"type":"null"}]},"error":{"anyOf":[{"$ref":"#/$defs/Error"},{"type":"null"}]}},"allOf":[{"if":{"properties":{"persistence":{"const":"Committed"}}},"then":{"properties":{"result":{"$ref":"#/$defs/MutationResult"},"error":{"type":"null"}}}},{"if":{"properties":{"persistence":{"const":"Pending"}}},"then":{"properties":{"result":{"type":"null"},"error":{"type":"null"}}}},{"if":{"properties":{"persistence":{"const":"Failed"}}},"then":{"properties":{"result":{"type":"null"},"error":{"$ref":"#/$defs/Error"}}}}]},
    "Operation": {"type":"object","additionalProperties":false,"required":["action_id","request_id","persistence","result","error"],"properties":{"action_id":{"anyOf":[{"$ref":"#/$defs/RequestId"},{"type":"null"}]},"request_id":{"anyOf":[{"$ref":"#/$defs/RequestId"},{"type":"null"}]},"persistence":{"enum":["Pending","Committed","Failed"]},"result":{"anyOf":[{"$ref":"#/$defs/MutationResult"},{"type":"null"}]},"error":{"anyOf":[{"$ref":"#/$defs/Error"},{"type":"null"}]}},"oneOf":[{"properties":{"action_id":{"$ref":"#/$defs/RequestId"},"request_id":{"type":"null"}}},{"properties":{"action_id":{"type":"null"},"request_id":{"$ref":"#/$defs/RequestId"}}}],"allOf":[{"if":{"properties":{"persistence":{"const":"Pending"}}},"then":{"properties":{"result":{"type":"null"},"error":{"type":"null"}}}},{"if":{"properties":{"persistence":{"const":"Committed"}}},"then":{"properties":{"result":{"$ref":"#/$defs/MutationResult"},"error":{"type":"null"}}}},{"if":{"properties":{"persistence":{"const":"Failed"}}},"then":{"properties":{"result":{"type":"null"},"error":{"$ref":"#/$defs/Error"}}}}]},
    "ComponentName": {"enum":["Backend","Storage","Command","RobotVideo","DisplayedRobotVideo","Webcam","Controller","AI","Workspace","QualificationProfile"]},
    "Component": {"type":"object","additionalProperties":false,"required":["component","status","cause_codes"],"properties":{"component":{"$ref":"#/$defs/ComponentName"},"status":{"enum":["Ready","Initializing","Unavailable"]},"cause_codes":{"type":"array","items":{"$ref":"#/$defs/ErrorCode"},"uniqueItems":true}}},
    "Readiness": {"type":"object","additionalProperties":false,"required":["components","can_start","can_resume"],"properties":{"components":{"type":"array","items":{"$ref":"#/$defs/Component"},"minItems":10,"maxItems":10},"can_start":{"type":"object","additionalProperties":false,"required":["Gestures","Controller"],"properties":{"Gestures":{"type":"boolean"},"Controller":{"type":"boolean"}}},"can_resume":{"type":"boolean"}}},
    "RuntimeState": {"type":"object","additionalProperties":false,"required":["effective_session_state","motion_permission","control_generation","persistence_pending"],"properties":{"effective_session_state":{"anyOf":[{"enum":["Searching","Paused","Ended"]},{"type":"null"}]},"motion_permission":{"enum":["Disarmed","Arming","Armed"]},"control_generation":{"$ref":"#/$defs/Counter"},"persistence_pending":{"type":"boolean"}}},
    "PublicLease": {"type":"object","additionalProperties":false,"required":["state","owner_client_id","control_generation","can_acquire"],"properties":{"state":{"enum":["Unowned","Owned"]},"owner_client_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"control_generation":{"$ref":"#/$defs/Counter"},"can_acquire":{"type":"boolean"}},"allOf":[{"if":{"properties":{"state":{"const":"Unowned"}}},"then":{"properties":{"owner_client_id":{"type":"null"}}},"else":{"properties":{"owner_client_id":{"$ref":"#/$defs/Id"},"can_acquire":{"const":false}}}}]},
    "Proximity": {"type":"object","additionalProperties":false,"required":["state","warning_latched","distance_mm","sample_seq","source_epoch","observed_at_ms"],"properties":{"state":{"enum":["Unknown","Warning","Clear"]},"warning_latched":{"type":"boolean"},"distance_mm":{"anyOf":[{"type":"integer","minimum":0,"maximum":9007199254740991},{"type":"null"}]},"sample_seq":{"anyOf":[{"$ref":"#/$defs/Counter"},{"type":"null"}]},"source_epoch":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"observed_at_ms":{"anyOf":[{"$ref":"#/$defs/UtcMs"},{"type":"null"}]}}},
    "RetentionState": {"type":"object","additionalProperties":false,"required":["settings","active_object_expires_at_ms","active_object_grace","deletion"],"properties":{"settings":{"$ref":"#/$defs/Settings"},"active_object_expires_at_ms":{"anyOf":[{"$ref":"#/$defs/UtcMs"},{"type":"null"}]},"active_object_grace":{"type":"boolean"},"deletion":{"$ref":"#/$defs/DeletionProgress"}}},
    "Snapshot": {"type":"object","additionalProperties":false,"required":["protocol_version","backend_boot_id","event_seq","active_object","active_session","runtime","readiness","failures","pending_candidate","lease","proximity","retention","operations","qualification_profile_id","qualification_profile"],"properties":{"protocol_version":{"const":1},"backend_boot_id":{"$ref":"#/$defs/Id"},"event_seq":{"$ref":"#/$defs/Counter"},"active_object":{"anyOf":[{"$ref":"#/$defs/Object"},{"type":"null"}]},"active_session":{"anyOf":[{"$ref":"#/$defs/Session"},{"type":"null"}]},"runtime":{"$ref":"#/$defs/RuntimeState"},"readiness":{"$ref":"#/$defs/Readiness"},"failures":{"type":"array","items":{"$ref":"#/$defs/Failure"}},"pending_candidate":{"anyOf":[{"$ref":"#/$defs/Match"},{"type":"null"}]},"lease":{"$ref":"#/$defs/PublicLease"},"proximity":{"$ref":"#/$defs/Proximity"},"retention":{"$ref":"#/$defs/RetentionState"},"operations":{"type":"array","items":{"$ref":"#/$defs/Operation"},"maxItems":128},"qualification_profile_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"qualification_profile":{"anyOf":[{"$ref":"#/$defs/FrontendProfile"},{"type":"null"}]}}},
    "Health": {"type":"object","additionalProperties":false,"required":["backend_boot_id","process_status","initialization","storage_integrity","readiness","active_session_state","operational_state"],"properties":{"backend_boot_id":{"$ref":"#/$defs/Id"},"process_status":{"enum":["Healthy","Degraded"]},"initialization":{"enum":["Starting","Ready","Failed"]},"storage_integrity":{"enum":["Healthy","Reconciling","Unavailable"]},"readiness":{"$ref":"#/$defs/Readiness"},"active_session_state":{"anyOf":[{"enum":["Searching","Paused"]},{"type":"null"}]},"operational_state":{"enum":["Idle","Searching","Paused","Reconciling","Faulted"]}}},
    "BootstrapResponse": {"type":"object","additionalProperties":false,"required":["client_id","backend_boot_id","capability","server_time_ms","qualification_profile"],"properties":{"client_id":{"$ref":"#/$defs/Id"},"backend_boot_id":{"$ref":"#/$defs/Id"},"capability":{"$ref":"#/$defs/Token"},"server_time_ms":{"$ref":"#/$defs/UtcMs"},"qualification_profile":{"anyOf":[{"$ref":"#/$defs/FrontendProfile"},{"type":"null"}]}}},
    "TicketRequest": {"type":"object","additionalProperties":false,"required":["client_id","channel"],"properties":{"client_id":{"$ref":"#/$defs/Id"},"channel":{"$ref":"#/$defs/Channel"}}},
    "TicketResponse": {"type":"object","additionalProperties":false,"required":["ticket","expires_at_ms"],"properties":{"ticket":{"$ref":"#/$defs/Token"},"expires_at_ms":{"$ref":"#/$defs/UtcMs"}}},
    "LeaseAcquire": {"type":"object","additionalProperties":false,"required":["request_id","client_id","session_id","takeover"],"properties":{"request_id":{"$ref":"#/$defs/RequestId"},"client_id":{"$ref":"#/$defs/Id"},"session_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"takeover":{"type":"boolean"}}},
    "LeaseRelease": {"type":"object","additionalProperties":false,"required":["request_id","client_id","client_lease_id","control_generation","session_id"],"properties":{"request_id":{"$ref":"#/$defs/RequestId"},"client_id":{"$ref":"#/$defs/Id"},"client_lease_id":{"$ref":"#/$defs/Token"},"control_generation":{"$ref":"#/$defs/Counter"},"session_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]}}},
    "LeaseResponse": {"type":"object","additionalProperties":false,"required":["request_id","client_lease_id","control_generation","lease","snapshot"],"properties":{"request_id":{"$ref":"#/$defs/RequestId"},"client_lease_id":{"anyOf":[{"$ref":"#/$defs/Token"},{"type":"null"}]},"control_generation":{"$ref":"#/$defs/Counter"},"lease":{"$ref":"#/$defs/PublicLease"},"snapshot":{"$ref":"#/$defs/Snapshot"}}},
    "StartRequest": {"type":"object","additionalProperties":false,"required":["action_id","object_id","expected_revision","control_mode","client_id","client_lease_id"],"properties":{"action_id":{"$ref":"#/$defs/RequestId"},"object_id":{"$ref":"#/$defs/Id"},"expected_revision":{"$ref":"#/$defs/Counter"},"control_mode":{"$ref":"#/$defs/ControlMode"},"client_id":{"$ref":"#/$defs/Id"},"client_lease_id":{"$ref":"#/$defs/Token"}}},
    "SessionAction": {"type":"object","additionalProperties":false,"required":["action_id","session_id","expected_revision","action","client_id","client_lease_id"],"properties":{"action_id":{"$ref":"#/$defs/RequestId"},"session_id":{"$ref":"#/$defs/Id"},"expected_revision":{"$ref":"#/$defs/Counter"},"action":{"enum":["pause","resume","stop","acknowledge","confirm","reject"]},"client_id":{"$ref":"#/$defs/Id"},"client_lease_id":{"$ref":"#/$defs/Token"},"candidate_id":{"$ref":"#/$defs/Id"},"failure_ids":{"type":"array","items":{"$ref":"#/$defs/Id"},"minItems":1,"maxItems":64,"uniqueItems":true}},"allOf":[{"if":{"properties":{"action":{"enum":["confirm","reject"]}}},"then":{"required":["candidate_id"]},"else":{"not":{"required":["candidate_id"]}}},{"if":{"properties":{"action":{"const":"acknowledge"}}},"then":{"required":["failure_ids"]},"else":{"not":{"required":["failure_ids"]}}}]},
    "RegistrationFields": {"type":"object","additionalProperties":false,"required":["action_id","name","roi"],"properties":{"action_id":{"$ref":"#/$defs/RequestId"},"name":{"$ref":"#/$defs/Name"},"roi":{"$ref":"#/$defs/Rect"}}},
    "RetentionPreviewRequest": {"type":"object","additionalProperties":false,"required":["expected_revision","retention_days"],"properties":{"expected_revision":{"$ref":"#/$defs/Counter"},"retention_days":{"type":"integer","minimum":1,"maximum":30}}},
    "RetentionImpact": {"type":"object","additionalProperties":false,"required":["objects","sessions","matches","managed_image_bytes"],"properties":{"objects":{"type":"integer","minimum":0,"maximum":9007199254740991},"sessions":{"type":"integer","minimum":0,"maximum":9007199254740991},"matches":{"type":"integer","minimum":0,"maximum":9007199254740991},"managed_image_bytes":{"type":"integer","minimum":0,"maximum":9007199254740991}}},
    "RetentionPreview": {"type":"object","additionalProperties":false,"required":["preview_id","settings_revision","retention_days","evaluated_at_ms","expires_at_ms","impact"],"properties":{"preview_id":{"$ref":"#/$defs/Id"},"settings_revision":{"$ref":"#/$defs/Counter"},"retention_days":{"type":"integer","minimum":1,"maximum":30},"evaluated_at_ms":{"$ref":"#/$defs/UtcMs"},"expires_at_ms":{"$ref":"#/$defs/UtcMs"},"impact":{"$ref":"#/$defs/RetentionImpact"}}},
    "RetentionChange": {"type":"object","additionalProperties":false,"required":["action_id","expected_revision","retention_days","preview_id","confirmed"],"properties":{"action_id":{"$ref":"#/$defs/RequestId"},"expected_revision":{"$ref":"#/$defs/Counter"},"retention_days":{"type":"integer","minimum":1,"maximum":30},"preview_id":{"$ref":"#/$defs/Id"},"confirmed":{"const":true}}},
    "EmergencyStopRequest": {"type":"object","additionalProperties":false,"required":["request_id"],"properties":{"request_id":{"$ref":"#/$defs/RequestId"},"client_id":{"$ref":"#/$defs/Id"}}},
    "EmergencyStopResponse": {"type":"object","additionalProperties":false,"required":["request_id","backend_boot_id","permission_revoked","session_id","failure_id","persistence","error"],"properties":{"request_id":{"$ref":"#/$defs/RequestId"},"backend_boot_id":{"$ref":"#/$defs/Id"},"permission_revoked":{"const":true},"session_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"failure_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"persistence":{"enum":["Pending","Committed","Failed"]},"error":{"anyOf":[{"$ref":"#/$defs/Error"},{"type":"null"}]}},"allOf":[{"if":{"properties":{"persistence":{"const":"Failed"}}},"then":{"properties":{"error":{"$ref":"#/$defs/Error"}}},"else":{"properties":{"error":{"type":"null"}}}}]},
    "ObjectPage": {"type":"object","additionalProperties":false,"required":["items","next_cursor"],"properties":{"items":{"type":"array","items":{"$ref":"#/$defs/Object"},"maxItems":100},"next_cursor":{"anyOf":[{"$ref":"#/$defs/Token"},{"type":"null"}]}}},
    "SessionPage": {"type":"object","additionalProperties":false,"required":["items","next_cursor"],"properties":{"items":{"type":"array","items":{"$ref":"#/$defs/Session"},"maxItems":100},"next_cursor":{"anyOf":[{"$ref":"#/$defs/Token"},{"type":"null"}]}}},
    "MatchPage": {"type":"object","additionalProperties":false,"required":["items","next_cursor"],"properties":{"items":{"type":"array","items":{"$ref":"#/$defs/Match"},"maxItems":100},"next_cursor":{"anyOf":[{"$ref":"#/$defs/Token"},{"type":"null"}]}}},
    "DisplayedFrame": {"type":"object","additionalProperties":false,"required":["frame_id","stream_epoch"],"properties":{"frame_id":{"$ref":"#/$defs/Id"},"stream_epoch":{"$ref":"#/$defs/Id"}}},
    "WorkspaceHeartbeat": {"type":"object","additionalProperties":false,"required":["type","protocol_version","backend_boot_id","client_id","client_lease_id","session_id","control_generation","heartbeat_seq","workspace_visible","workspace_focused","workspace_operational","displayed_robot_frame"],"properties":{"type":{"const":"workspace_heartbeat"},"protocol_version":{"const":1},"backend_boot_id":{"$ref":"#/$defs/Id"},"client_id":{"$ref":"#/$defs/Id"},"client_lease_id":{"$ref":"#/$defs/Token"},"session_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"control_generation":{"$ref":"#/$defs/Counter"},"heartbeat_seq":{"$ref":"#/$defs/Counter"},"workspace_visible":{"type":"boolean"},"workspace_focused":{"type":"boolean"},"workspace_operational":{"type":"boolean"},"displayed_robot_frame":{"anyOf":[{"$ref":"#/$defs/DisplayedFrame"},{"type":"null"}]}}},
    "FrameMetadata": {"type":"object","additionalProperties":false,"required":["protocol_version","source","stream_epoch","capture_seq","frame_id","width","height","received_at_ms","capture_age_bound_ms","source_capture_us","source_clock_epoch"],"properties":{"protocol_version":{"const":1},"source":{"enum":["robot","webcam"]},"stream_epoch":{"$ref":"#/$defs/Id"},"capture_seq":{"$ref":"#/$defs/Counter"},"frame_id":{"$ref":"#/$defs/Id"},"width":{"type":"integer","minimum":1,"maximum":9007199254740991},"height":{"type":"integer","minimum":1,"maximum":9007199254740991},"received_at_ms":{"$ref":"#/$defs/UtcMs"},"capture_age_bound_ms":{"type":"integer","minimum":0,"maximum":9007199254740991},"source_capture_us":{"type":"integer","minimum":0,"maximum":9007199254740991},"source_clock_epoch":{"$ref":"#/$defs/Id"}}},
    "SessionChanged": {"type":"object","additionalProperties":false,"required":["session","runtime","operation"],"properties":{"session":{"$ref":"#/$defs/Session"},"runtime":{"$ref":"#/$defs/RuntimeState"},"operation":{"anyOf":[{"$ref":"#/$defs/Operation"},{"type":"null"}]}}},
    "ReadinessChanged": {"type":"object","additionalProperties":false,"required":["readiness","runtime"],"properties":{"readiness":{"$ref":"#/$defs/Readiness"},"runtime":{"$ref":"#/$defs/RuntimeState"}}},
    "CandidatePending": {"type":"object","additionalProperties":false,"required":["match","control_generation"],"properties":{"match":{"$ref":"#/$defs/Match"},"control_generation":{"$ref":"#/$defs/Counter"}}},
    "RecoveryChanged": {"type":"object","additionalProperties":false,"required":["failures","runtime"],"properties":{"failures":{"type":"array","items":{"$ref":"#/$defs/Failure"}},"runtime":{"$ref":"#/$defs/RuntimeState"}}},
    "RetentionChanged": {"type":"object","additionalProperties":false,"required":["retention","operation"],"properties":{"retention":{"$ref":"#/$defs/RetentionState"},"operation":{"anyOf":[{"$ref":"#/$defs/Operation"},{"type":"null"}]}}},
    "ObjectRemoved": {"type":"object","additionalProperties":false,"required":["object_id","reason"],"properties":{"object_id":{"$ref":"#/$defs/Id"},"reason":{"const":"Expired"}}},
    "StorageFault": {"type":"object","additionalProperties":false,"required":["code","message","operation","blocked_capabilities","deletion","runtime"],"properties":{"code":{"$ref":"#/$defs/ErrorCode"},"message":{"type":"string","minLength":1,"maxLength":1024},"operation":{"anyOf":[{"$ref":"#/$defs/Operation"},{"type":"null"}]},"blocked_capabilities":{"type":"array","items":{"enum":["Register","Start","Resume","Review","RetentionChange"]},"uniqueItems":true},"deletion":{"$ref":"#/$defs/DeletionProgress"},"runtime":{"$ref":"#/$defs/RuntimeState"}}},
    "ProximityWarningChanged": {"type":"object","additionalProperties":false,"required":["proximity"],"properties":{"proximity":{"$ref":"#/$defs/Proximity"}}},
    "EventEnvelope": {"type":"object","additionalProperties":false,"required":["protocol_version","backend_boot_id","event_seq","session_id","session_revision","type","occurred_at_ms","payload"],"properties":{"protocol_version":{"const":1},"backend_boot_id":{"$ref":"#/$defs/Id"},"event_seq":{"$ref":"#/$defs/Counter"},"session_id":{"anyOf":[{"$ref":"#/$defs/Id"},{"type":"null"}]},"session_revision":{"anyOf":[{"$ref":"#/$defs/Counter"},{"type":"null"}]},"type":{"enum":["snapshot","session_changed","readiness_changed","candidate_pending","recovery_changed","retention_changed","object_removed","storage_fault","proximity_warning_changed"]},"occurred_at_ms":{"$ref":"#/$defs/UtcMs"},"payload":{}},"allOf":[{"if":{"properties":{"type":{"const":"snapshot"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/Snapshot"}}}},{"if":{"properties":{"type":{"const":"session_changed"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/SessionChanged"}}}},{"if":{"properties":{"type":{"const":"readiness_changed"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/ReadinessChanged"}}}},{"if":{"properties":{"type":{"const":"candidate_pending"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/CandidatePending"}}}},{"if":{"properties":{"type":{"const":"recovery_changed"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/RecoveryChanged"}}}},{"if":{"properties":{"type":{"const":"retention_changed"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/RetentionChanged"}}}},{"if":{"properties":{"type":{"const":"object_removed"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/ObjectRemoved"}}}},{"if":{"properties":{"type":{"const":"storage_fault"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/StorageFault"}}}},{"if":{"properties":{"type":{"const":"proximity_warning_changed"}}},"then":{"properties":{"payload":{"$ref":"#/$defs/ProximityWarningChanged"}}}}]},
    "QualificationProfile": {"type":"object","additionalProperties":false,"required":["profile_id","protocol_version","evidence_kind","evidence_manifest_sha256","device_protocol_manifest_sha256","max_header_bytes","max_frame_bytes","max_frame_width","max_frame_height","max_frame_pixels","max_event_message_bytes","max_client_message_bytes","event_queue_messages","event_queue_bytes","heartbeat_interval_ms","heartbeat_deadline_ms","display_deadline_ms","capture_age_limit_ms","clock_uncertainty_limit_us","camera_sync_interval_ms","camera_sync_max_rtt_us","input_sample_deadline_ms","command_ack_deadline_ms","serial_max_packet_bytes","serial_baud","command_renewal_interval_ms","challenge_lifetime_ms","firmware_expiry_ms","proximity_sample_deadline_ms","proximity_warning_mm","proximity_clear_mm","proximity_clear_samples","proximity_max_distance_mm"],"properties":{"profile_id":{"$ref":"#/$defs/Id"},"protocol_version":{"const":1},"evidence_kind":{"enum":["Fixture","Device"]},"evidence_manifest_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"device_protocol_manifest_sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"},"max_header_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_width":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_height":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_frame_pixels":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_event_message_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"max_client_message_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"event_queue_messages":{"type":"integer","minimum":1,"maximum":9007199254740991},"event_queue_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"heartbeat_interval_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"heartbeat_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"display_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"capture_age_limit_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"clock_uncertainty_limit_us":{"type":"integer","minimum":1,"maximum":9007199254740991},"camera_sync_interval_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"camera_sync_max_rtt_us":{"type":"integer","minimum":1,"maximum":9007199254740991},"input_sample_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"command_ack_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"serial_max_packet_bytes":{"type":"integer","minimum":1,"maximum":9007199254740991},"serial_baud":{"type":"integer","minimum":1,"maximum":9007199254740991},"command_renewal_interval_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"challenge_lifetime_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"firmware_expiry_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"proximity_sample_deadline_ms":{"type":"integer","minimum":1,"maximum":9007199254740991},"proximity_warning_mm":{"type":"integer","minimum":1,"maximum":9007199254740991},"proximity_clear_mm":{"type":"integer","minimum":1,"maximum":9007199254740991},"proximity_clear_samples":{"type":"integer","minimum":1,"maximum":9007199254740991},"proximity_max_distance_mm":{"type":"integer","minimum":1,"maximum":9007199254740991}}}
  }
}
```


### 7.1 Complete request and result examples

All identifiers and tokens below are synthetic examples, not credentials or measured device settings. Examples are independent situations, not a complete sequential execution trace. Registration has separate binary image bytes; never send an actual filesystem path:

```text
POST /api/v1/objects
X-App-Capability: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
X-App-Client-Id: client_demo
X-Action-Created-At-Ms: 1794560400000
Content-Type: multipart/form-data; boundary=generated-by-client

action_id: 11111111-1111-4111-8111-111111111111
name: Keys
reference_image: binary PNG bytes
roi: {"x":120,"y":80,"width":240,"height":160}
```

Bootstrap:

```json BootstrapResponse
{"client_id":"client_demo","backend_boot_id":"boot_demo","capability":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","server_time_ms":1794560400000,"qualification_profile":null}
```

Ticket request and response:

```json TicketRequest
{"client_id":"client_demo","channel":"events"}
```

```json TicketResponse
{"ticket":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA","expires_at_ms":1794560410000}
```

Committed registration, HTTP 201:

```json MutationResponse
{"action_id":"11111111-1111-4111-8111-111111111111","persistence":"Committed","result":{"object":{"id":"object_demo","name":"Keys","status":"Lost","registered_at_ms":1794560400000,"found_at_ms":null,"revision":1,"roi":{"x":120,"y":80,"width":240,"height":160},"reference_media":{"id":"reference_demo","role":"Reference","content_type":"image/png","width":1280,"height":720,"byte_length":100000,"created_at_ms":1794560400000,"availability":"Available"},"expires_at_ms":1795165200000,"retention_grace":false},"session":null,"match":null,"settings":null,"deletion":null},"error":null}
```

Acquire before Start:

```json LeaseAcquire
{"request_id":"22222222-2222-4222-8222-222222222222","client_id":"client_demo","session_id":null,"takeover":false}
```

Start:

```json StartRequest
{"action_id":"33333333-3333-4333-8333-333333333333","object_id":"object_demo","expected_revision":1,"control_mode":"Controller","client_id":"client_demo","client_lease_id":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"}
```

Committed Start, HTTP 201; the initial motion gate remains disarmed:

```json MutationResponse
{"action_id":"33333333-3333-4333-8333-333333333333","persistence":"Committed","result":{"object":null,"session":{"id":"session_demo","object_id":"object_demo","control_mode":"Controller","state":"Searching","started_at_ms":1794560460000,"ended_at_ms":null,"end_reason":null,"revision":1,"pause_causes":[]},"match":null,"settings":null,"deletion":null},"error":null}
```

Pause and correlated pending save:

```json SessionAction
{"action_id":"44444444-4444-4444-8444-444444444444","session_id":"session_demo","expected_revision":1,"action":"pause","client_id":"client_demo","client_lease_id":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"}
```

```json MutationResponse
{"action_id":"44444444-4444-4444-8444-444444444444","persistence":"Pending","result":null,"error":null}
```

Candidate-pending event after durable preparation/revocation:

```json EventEnvelope
{"protocol_version":1,"backend_boot_id":"boot_demo","event_seq":12,"session_id":"session_demo","session_revision":3,"type":"candidate_pending","occurred_at_ms":1794560500000,"payload":{"match":{"id":"candidate_demo","session_id":"session_demo","object_id":"object_demo","captured_at_ms":1794560500000,"frame_id":"frame_demo","stream_epoch":"stream_demo","box":{"x":80,"y":40,"width":200,"height":120},"disposition":"Pending","reviewed_at_ms":null,"evidence_media":{"id":"evidence_demo","role":"Evidence","content_type":"image/png","width":1280,"height":720,"byte_length":120000,"created_at_ms":1794560500000,"availability":"Available"}},"control_generation":3}}
```

Confirm, or use reject with a distinct new action ID for a different decision:

```json SessionAction
{"action_id":"55555555-5555-4555-8555-555555555555","session_id":"session_demo","expected_revision":3,"action":"confirm","candidate_id":"candidate_demo","client_id":"client_demo","client_lease_id":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"}
```

Acknowledgment never Resumes:

```json SessionAction
{"action_id":"66666666-6666-4666-8666-666666666666","session_id":"session_demo","expected_revision":5,"action":"acknowledge","failure_ids":["failure_demo"],"client_id":"client_demo","client_lease_id":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA"}
```

Retention preview and its client-bound response:

```json RetentionPreviewRequest
{"expected_revision":1,"retention_days":5}
```

```json RetentionPreview
{"preview_id":"preview_demo","settings_revision":1,"retention_days":5,"evaluated_at_ms":1794560600000,"expires_at_ms":1794560660000,"impact":{"objects":2,"sessions":3,"matches":4,"managed_image_bytes":2500000}}
```

```json RetentionChange
{"action_id":"77777777-7777-4777-8777-777777777777","expected_revision":1,"retention_days":5,"preview_id":"preview_demo","confirmed":true}
```

Heartbeat after an actually displayed robot frame:

```json WorkspaceHeartbeat
{"type":"workspace_heartbeat","protocol_version":1,"backend_boot_id":"boot_demo","client_id":"client_demo","client_lease_id":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA","session_id":"session_demo","control_generation":3,"heartbeat_seq":1,"workspace_visible":true,"workspace_focused":true,"workspace_operational":true,"displayed_robot_frame":{"frame_id":"frame_demo","stream_epoch":"stream_demo"}}
```

Emergency stop with pending persistence:

```json EmergencyStopRequest
{"request_id":"88888888-8888-4888-8888-888888888888","client_id":"client_demo"}
```

```json EmergencyStopResponse
{"request_id":"88888888-8888-4888-8888-888888888888","backend_boot_id":"boot_demo","permission_revoked":true,"session_id":"session_demo","failure_id":"failure_demo","persistence":"Pending","error":null}
```

Structured conflict:

```json Error
{"code":"REVISION_CONFLICT","message":"The session changed. Refresh its state before submitting a new action.","retryable":false,"revision":6}
```

Unavailable storage:

```json Error
{"code":"STORAGE_UNAVAILABLE","message":"Saving is unavailable. Movement remains stopped while storage is restored.","retryable":true}
```

Startup diagnostics with healthy storage but no active qualification profile (HTTP diagnostics remain available; control is unavailable):

```json Health
{"backend_boot_id":"boot_demo","process_status":"Healthy","initialization":"Ready","storage_integrity":"Healthy","readiness":{"components":[{"component":"Backend","status":"Ready","cause_codes":[]},{"component":"Storage","status":"Ready","cause_codes":[]},{"component":"Command","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"RobotVideo","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"DisplayedRobotVideo","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"Webcam","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"Controller","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"AI","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"Workspace","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"QualificationProfile","status":"Unavailable","cause_codes":["NOT_READY"]}],"can_start":{"Gestures":false,"Controller":false},"can_resume":false},"active_session_state":null,"operational_state":"Idle"}
```

```json Snapshot
{"protocol_version":1,"backend_boot_id":"boot_demo","event_seq":1,"active_object":null,"active_session":null,"runtime":{"effective_session_state":null,"motion_permission":"Disarmed","control_generation":1,"persistence_pending":false},"readiness":{"components":[{"component":"Backend","status":"Ready","cause_codes":[]},{"component":"Storage","status":"Ready","cause_codes":[]},{"component":"Command","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"RobotVideo","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"DisplayedRobotVideo","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"Webcam","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"Controller","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"AI","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"Workspace","status":"Unavailable","cause_codes":["NOT_READY"]},{"component":"QualificationProfile","status":"Unavailable","cause_codes":["NOT_READY"]}],"can_start":{"Gestures":false,"Controller":false},"can_resume":false},"failures":[],"pending_candidate":null,"lease":{"state":"Unowned","owner_client_id":null,"control_generation":1,"can_acquire":false},"proximity":{"state":"Unknown","warning_latched":false,"distance_mm":null,"sample_seq":null,"source_epoch":null,"observed_at_ms":null},"retention":{"settings":{"retention_days":7,"revision":1,"updated_at_ms":1794560400000},"active_object_expires_at_ms":null,"active_object_grace":false,"deletion":{"status":"Complete","remaining_objects":0,"remaining_files":0,"error_code":null}},"operations":[],"qualification_profile_id":null,"qualification_profile":null}
```

Owner lease-release request in an independent qualified setup:

```json LeaseRelease
{"request_id":"99999999-9999-4999-8999-999999999999","client_id":"client_demo","client_lease_id":"CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA","control_generation":3,"session_id":"session_demo"}
```

An empty eligible feed:

```json ObjectPage
{"items":[],"next_cursor":null}
```

Frame metadata describes one synthetic acquisition; these values are not a qualified timing profile:

```json FrameMetadata
{"protocol_version":1,"source":"robot","stream_epoch":"stream_demo","capture_seq":1,"frame_id":"frame_demo","width":1280,"height":720,"received_at_ms":1794560500000,"capture_age_bound_ms":7,"source_capture_us":1024000,"source_clock_epoch":"camera_clock_demo"}
```


## 8. Durable mutations, runtime retries and saving

### 8.1 Canonical fingerprints

Validate and normalize before fingerprinting. Canonical input is `{scope, action_type, resource_id, expected_revision, payload}` with explicit null for inapplicable resource/revision. Scope is `Object` or `Settings`. Start names its object; session/review actions name their session and typed payload. Preserve candidate IDs, ROI, mode, proposed retention days, preview ID and confirmation. Registration includes normalized name/ROI, source image SHA-256 and the immutable submission-time header. Acknowledgment failure IDs sort by exact ASCII bytes; duplicate input IDs are rejected rather than silently removed.

Use UTF-8 JSON with lexicographically sorted ASCII property keys, no insignificant whitespace, unescaped Unicode characters, lowercase JSON literals and base-10 integers without leading zeros. Canonical payloads contain no floating-point values. SHA-256 of those bytes is the request fingerprint; image digest uses original uploaded bytes. JSON key order, multipart boundary, filename and transport capability/replaceable client/lease identity do not change business intent. The backend still verifies current protection/eligibility before receipt recovery and current authorization before admitting new work.

### 8.2 Registration admission and expiry

`POST /objects` requires `X-Action-Created-At-Ms`: a canonical decimal UTC-millisecond submission time, generated once for that action. Frontend uses bootstrap `server_time_ms` plus monotonic elapsed time rather than relying on a separate browser wall clock. It is transport admission metadata, never registration time. Include it in the fingerprint and preserve it on every retry.

After protection/validation/current data eligibility, look up the same action ID in pending operations and durable receipts. A matching eligible committed receipt returns its original result before enforcing submission age; a mismatched retained fingerprint conflicts. If no operation/receipt exists, require `0 <= backend_now_ms - submitted_at_ms <= 600,000`. A future or too-old unseen submission returns `410 ACTION_EXPIRED`. This 10-minute admission window is shorter than the minimum one-day retention: an unchanged request whose object/receipt has already expired cannot create a replacement. Recovered in-progress journals are reconciled before accepting new work.

Never refresh a submission header on an uncertain retry. A deliberately new registration gets a new action ID/time. Once receipt/owner data is purged, no permanent action tombstone is retained; retired action IDs must never be repurposed. A detected backward clock discontinuity that invalidates this admission/retention ordering blocks new registrations until clock integrity is restored.

### 8.3 Pending, committed and failed outcomes

`MutationResponse` contains `action_id`, `persistence`, `result` and `error`. Pending has null result/error; committed has a typed result and null error; failed has null result and a safe Error. A normal rejected admission returns plain Error. A failure of an admitted correlated operation may return Failed MutationResponse with the appropriate non-2xx status. Results contain fixed keys `object, session, match, settings, deletion`, using null for unchanged/inapplicable resources:

| Mutation | Result fields |
| --- | --- |
| Registration | New object |
| Start | New session |
| Pause/Resume/acknowledge | Session, including unchanged session for a no-op |
| Confirm | Object, session and match |
| Reject | Session and match |
| Stop | Session and pending match if converted to NotReviewed |
| Retention commit | Settings and deletion progress |

If a terminal commit ends an already expired object's grace, acknowledge Committed with all five result fields null, emit `object_removed`, and clear that object's views immediately. Do not broadcast or return expired object/session/evidence projections merely to describe the terminal outcome. The action ID and Committed status acknowledge the accepted request; subsequent owner reads/retries use normal expiry/missing handling. Owner-derived pending/completion caches are purged with eligibility loss.

Before exposing Pending, reserve one action identity and serialize duplicate attempts against it. Admission to memory is not a durability claim. Persist operation/journal intent where storage permits; committed domain facts and their receipt/result are atomic. Evidence preparation and flush precede committed registration/candidate visibility; Confirm references already durable evidence. Never leave a successful receipt for a rolled-back mutation.

Persist the original committed status/body/Location with the durable action result until the owning data expires. A matching committed retry returns that original result, even after later revisions; it is historical action output, not current movement permission or a promise of current media availability. Apply current retention first. Fetch a fresh snapshot to reconcile newer state. An identical pending retry returns the same Pending operation or its eventual terminal result. A definitive precommit failure can be retried with the same ID/payload after repair; never run two unresolved attempts concurrently.

Snapshots include all currently tracked pending operations plus the most recent 64 terminal completions in this boot. Track at most 64 pending operations total: 62 ordinary slots, one reserved for safety Pause/Stop/release persistence, and one for emergency persistence. Repeated identical requests join the tracked operation; repeated emergency requests for the same occurrence may alias its primary request ID. If a reserved slot is occupied by different work, perform immediate permitted revocation and report capacity/persistence failure without admitting another tracked operation. `Operation` uses exactly one of `action_id` or `request_id`; the other is null. Runtime request operations in this list are emergency/release persistence only, never lease-acquire receipts or private lease IDs. Retention removes owner-derived operation results along with the owner's data; do not keep expired payloads in runtime completion caches.

Appropriate existing session/retention/storage events carry `operation` correlation. Registration has no additional event type: refresh snapshot while Pending or repeat the identical multipart request. Evicted terminal completion is recovered by durable retry, not inferred from an unrelated current resource state. Polling is deliberate, capped/backed off, never a retry of motion permission.

On restart reconcile durable journal/receipts first. Do not automatically replay incomplete Start/Resume or reconstruct a volatile pending operation. Absence from a post-restart snapshot means “status not known from this snapshot,” not committed. An identical retry recovers a receipt, encounters the reconciled conflict/expiry, or is validated as new admission against current boot/lease/revision. Missing resource actions return missing/expired; no record is recreated by retry.

### 8.4 Runtime deduplication

Lease/emergency requests use `request_id` and a fingerprint of operation/client/applicable session/lease/generation/payload. Scope to `backend_boot_id` and keep accepted runtime request outcomes for the entire boot, including failures after admission. Preserve a lease acquisition's original private lease ID, generation and ownership outcome even if it later expires; never issue renewed ownership from the retry. Do not store its embedded evidence-bearing snapshot in boot-long receipt state: attach a newly computed eligible snapshot on every runtime retry. Historical top-level outcome and the current snapshot are deliberately distinct. A reused ID for a different request returns `409 REQUEST_ID_CONFLICT`.

Runtime request receipts are bounded to 8,192 per boot and are never evicted to admit more ordinary requests. At capacity return `503 CAPACITY_REACHED` and require a deliberate disarmed restart before new lease admissions. Emergency revocation and a valid owner's safety Stop/Pause must still execute their immediate safety effect under capacity/storage pressure; report any unrecorded/pending persistence explicitly.

### 8.5 Emergency stop

Validate Host/Origin/capability, then revoke immediately, without waiting for an ordinary action queue, body parsing, revision, lease, inference or disk I/O. A malformed body can return an Error with `permission_revoked: true` after that protected revocation; it never delays revocation merely to obtain correlation.

A well-formed request requires UUIDv4 `request_id` and optional `client_id`. Return `request_id, backend_boot_id, permission_revoked: true, session_id, failure_id, persistence, error`. Use `200` when persistence is complete, `202` while pending, `503` with Failed/error when saving fails. Every valid retry revokes again before deduplication/conflict reporting. One outstanding emergency occurrence retains its failure ID; new request IDs do not multiply the same un-restored occurrence.

With an active session, apply runtime Paused immediately and persist the failure/pause when possible. A completed Found result cannot be undone by a later emergency. Without an active session, stay disarmed, use null session/failure IDs, and create no domain record just to record the stop. “Permission revoked” describes logical authorization, never measured wheel stopping.

## 9. Events, synchronization, frames and readiness

### 9.1 Event sequencing and snapshots

`EventEnvelope` has `protocol_version, backend_boot_id, event_seq, session_id, session_revision, type, occurred_at_ms, payload`. Session/revision identify the affected session or are both null for a global event. Payload is selected by the event type, never an arbitrary string or untyped map.

Start each boot sequence at 1. Global ordered state events increment it; every connected client receives the sequence, with secrets excluded from all payloads. Creating a client-specific snapshot does not consume an otherwise invisible global event number: its `event_seq` is the current consistent watermark. Snapshot envelopes carry the same watermark in their payload. Atomically take the projection and subscribe after that boundary, buffering bounded subsequent events so synchronization cannot miss a state change. A fresh snapshot replaces local state and is allowed to repeat the current watermark.

After synchronization require consecutive event sequence numbers. Discard duplicates; a gap, unknown type/version, impossible revision regression or new boot invalidates the projection/control eligibility. Stop lease renewal, clear old frame/generation associations, and reconnect for a full snapshot before deliberate reacquisition/recovery. No historical event replay is provided. A disconnected spectator causes no controller revocation; losing the owner event channel does.

| Type | Payload definition |
| --- | --- |
| `snapshot` | `Snapshot` |
| `session_changed` | `SessionChanged`: durable session, effective runtime state, nullable correlated operation |
| `readiness_changed` | `ReadinessChanged`: complete readiness and runtime/generation projection |
| `candidate_pending` | `CandidatePending`: durable match/evidence and current generation |
| `recovery_changed` | `RecoveryChanged`: current unresolved failures and runtime state |
| `retention_changed` | `RetentionChanged`: complete retention/deletion state and nullable operation |
| `object_removed` | `ObjectRemoved`: object ID and `Expired` reason; discard its browser copies |
| `storage_fault` | `StorageFault`: safe code/message, nullable operation, blocked capabilities, deletion/runtime state |
| `proximity_warning_changed` | `ProximityWarningChanged`: complete advisory projection |

`Snapshot` includes current eligible object/session, runtime state, all ten component statuses, settings revision/deadline/grace/deletion state, failures, candidate, public lease, advisory proximity, bounded operations, active qualification profile ID and matching nullable FrontendProfile summary. In idle state active object/session/candidate are null. A session that ends may appear in its terminal event/receipt, while the next idle snapshot has no active session.

The public lease never contains a private lease ID. Operation errors may omit optional embedded snapshot to avoid recursive payloads. If a snapshot cannot fit the configured bounded transport, fail explicitly and disarm the affected controller rather than truncate authority-bearing fields.

### 9.2 Readiness and health

Readiness contains each ComponentName exactly once: Backend, Storage, Command, RobotVideo, DisplayedRobotVideo, Webcam, Controller, AI, Workspace, QualificationProfile. Each status is Ready/Initializing/Unavailable, with safe cause codes. Missing selected requirements make mode readiness false; inactive-mode input availability is diagnostic only.

`can_start.Gestures` requires all shared paths plus webcam/gesture input; `can_start.Controller` requires all shared paths plus controller input, not webcam. Both also enforce eligible target/no-active-session and a valid controlling setup. `can_resume` applies only to the active Paused session with current owner, all recovery requirements satisfied and no pending review. These booleans describe current eligibility, not a durable grant.

Runtime has effective session state, motion permission Disarmed/Arming/Armed, current control generation and persistence-pending flag. If storage fails before Paused is committed, show effective Paused/Disarmed and persistence pending while preserving the last committed session separately. Armed denotes backend logical permission, not wheel feedback.

Health reports process status, initialization, storage integrity, readiness, nullable active session state and operational state. Initialization/storage reconciliation/failure returns `503 Health`. A functional diagnostic process with unavailable robot devices returns `200` and readiness false. A healthy HTTP process never independently permits movement.

### 9.3 Workspace heartbeat and displayed frame

Client `WorkspaceHeartbeat` is the only inbound application event message in v1:

`type, protocol_version, backend_boot_id, client_id, client_lease_id, session_id, control_generation, heartbeat_seq, workspace_visible, workspace_focused, workspace_operational, displayed_robot_frame`.

`displayed_robot_frame` is null before successful robot decode/draw, otherwise `{frame_id, stream_epoch}`. Heartbeat sequence starts at 1 per acquired lease and strictly increases. Verify current boot, owner/lease, event connection, session, generation and the backend-issued frame identity. Null/no-frame can preserve a stopped setup only; it cannot satisfy live displayed-video readiness or permit Start/Resume/movement.

Record acknowledgment only after decode/display. Repeating an old frame ID does not refresh its acquisition time. Reject stale/replayed generations/sequences and never rearm from them. Requiring fresh frame acknowledgments is separate from merely receiving heartbeats. Browser wall-clock claims never establish freshness.

Use backend monotonic elapsed time through acknowledgment receipt to bound acquisition-to-display age. Any hidden/unfocused/nonoperational workspace, missed deadline, stale display or required-path failure revokes/pauses. Returning focus, reconnecting, a new capability or restored paths never automatically Resume. Ordinary selected-device samples remain backend-owned; no heartbeat or video channel accepts directions.

### 9.4 Binary frame v1 and capture clocks

One complete binary WebSocket message:

```text
[4-byte unsigned big-endian metadata byte count N]
[N bytes UTF-8 JSON FrameMetadata]
[remaining bytes JPEG image]
```

Validate bounds before allocation/decode, then version/keys/dimensions and exact JPEG decode dimensions. Enforce independent header/frame/dimension/pixel limits from the active profile. Metadata is strict JSON and includes `source_capture_us` and `source_clock_epoch` for both sources; webcam uses the backend's capture clock/epoch, robot preserves the camera's original acquisition clock/epoch. Stream epoch, capture sequence and frame ID survive AI/evidence processing.

`capture_age_bound_ms` is a nonnegative safe integer rounded upward from a conservative bound including clock uncertainty, capture/transport/queue time. Update with elapsed backend time and display acknowledgment receipt; an old bound cannot be reused as if observed now. Unknown/unbounded age means reject the frame as eligible, mark video unavailable and recover; never encode Infinity/null as a live bound.

The T6 device protocol manifest defines the camera round-trip clock exchange, request identity/boot echo, camera receive/transmit timestamps, integer units, parser bounds and uncertainty computation. Reject mismatched epochs, negative/impossible timing intervals and round trips beyond the configured bound. Camera epoch changes invalidate prior clock estimates and cause recovery. No direct subtraction of unrelated monotonic clocks is permitted.

Video delivery and AI each have one waiting latest frame per consumer plus the current in-flight frame; discard superseded waiting work. Enforce total frame size before enqueue. Slow video cannot block immediate revocation or event delivery. State events are ordered, not latest-only: overflow closes that client for snapshot recovery. A static scene with fresh acquisition metadata remains valid; duplicated acquisition sequence/epoch cannot certify liveness.

Label stale last frames “Not live,” even if displayed; evidence stays “Captured evidence.” Proximity availability never certifies a clear path or motion readiness.

### 9.5 Advisory proximity

`Proximity` uses state Unknown/Warning/Clear, `warning_latched`, nullable nonnegative integer `distance_mm`, nullable sample sequence/source epoch/time. Before samples, use Unknown, false and null sample fields. Invalid/stale/missing readings mean Unknown and null distance; retain any previously latched warning until the qualified fresh clear condition is met.

Fresh valid readings at/below the warning threshold set Warning/latched. Clear requires fresh samples meeting the profile's distinct clear distance and consecutive-clear count; between thresholds retain the previous latch. Without a proven initial clear condition, remain Unknown. This is silent visual advice only and never changes session, readiness or movement.

## 10. Qualification profiles and device boundaries

### 10.1 Required configuration, not fallback timers

Safety-dependent numeric configuration is a required versioned `QualificationProfile`, not a framework default. Device/fixture profiles include an ID, protocol version, evidence kind and SHA-256 references to the evidence/device-interface manifests. Every positive numeric field in that schema must be supplied and validated before its dependent path is enabled. Missing/invalid/incompatible profile state reports `NOT_READY` or `PROTOCOL_UNSUPPORTED` and blocks that dependent path; health/bootstrap and immediate stop remain available. Bootstrap and snapshots expose the safe FrontendProfile subset required for bounded browser parsing and heartbeat/display timing. Its ID must match `qualification_profile_id`; both are null without an active profile. Label Fixture mode visibly. Profile changes require a coordinated disarmed restart, never an unannounced in-boot timer change.

| Profile fields | Meaning / acceptance |
| --- | --- |
| `max_header_bytes, max_frame_bytes, max_frame_width, max_frame_height, max_frame_pixels` | Hard preallocation/decoder bounds, with metadata plus JPEG fitting the total frame bound. |
| `max_event_message_bytes, max_client_message_bytes, event_queue_messages, event_queue_bytes` | Bounded socket parser/output queues. Client JSON limit must not exceed 65,536 bytes; each event must fit both message and queue-byte bounds. |
| `heartbeat_interval_ms, heartbeat_deadline_ms, display_deadline_ms, capture_age_limit_ms` | Qualified workspace/acquisition/display budgets. Heartbeat interval is strictly below its deadline; deadlines include detection and scheduling. |
| `clock_uncertainty_limit_us, camera_sync_interval_ms, camera_sync_max_rtt_us` | Qualified offset-exchange limits, refreshed per source clock epoch. |
| `input_sample_deadline_ms, command_ack_deadline_ms, command_renewal_interval_ms` | Selected input/command freshness and renewal limits. |
| `serial_max_packet_bytes, serial_baud, challenge_lifetime_ms, firmware_expiry_ms` | Versioned firmware parser/rate/permission limits; renewal must precede expiry and conservative remaining challenge validity. |
| `proximity_sample_deadline_ms, proximity_warning_mm, proximity_clear_mm, proximity_clear_samples, proximity_max_distance_mm` | Advisory sample bounds; clear distance exceeds warning distance and does not exceed sensor range. |

The software team supplies fixture values with fixture evidence; integration/firmware owners supply device values with measured evidence. Fixtures do not qualify actual devices. Do not copy demonstration/example timer numbers into a Device profile or assign each component the full external 0.5-second stop allowance. Validate the combined component budget with positive mechanical stopping margin against SM-2; SM-4 requires measured camera-to-display latency.

### 10.2 Other bounded runtime resources

Preview storage allows 32 live previews per client / 1,024 globally, expiring after 60 seconds; reclaim expired then oldest unused previews. A reclaimed preview becomes stale. Other explicit bounds: 64 live clients, 32 outstanding tickets per client, 32 cursors per client / 1,024 globally, 64 tracked pending operations total (62 ordinary plus two reserved safety slots) / 64 recent terminal completions, and 8,192 retained runtime request results per boot. Cursor lifetime is 30 minutes, inactive client lifetime 30 minutes, socket tickets 10 seconds and registration admission 10 minutes.

Capacity errors return `503 CAPACITY_REACHED` without silently evicting active ownership or accepted boot-long runtime receipts. Reclaimable preview/cursor data are only temporary navigation/confirmation aids. Runtime operation/ticket/cursor state never becomes an independent retained copy of expired object evidence.

### 10.3 Device and worker contracts

| Boundary | Mandatory separate versioned artifact and validation |
| --- | --- |
| HC-05 / Uno | T2 identity/build manifest and T6 serial schema: bounded framing, integrity/ranges, boot/generation, increasing sequence, direction, device-issued expiring challenge, acknowledgment and logical output state. Stop/expiry invalidates the armed generation. Partial/oversized/replayed packets never refresh watchdogs. |
| ESP32-CAM | T2 endpoint/build identity and T6 acquisition/clock-exchange schema: source epoch/sequence/us timestamp, bounded JPEG, protocol compatibility and uncertainty evidence. |
| HC-SR04 | T2 observation identity/version and T4/T6 bounded mm/sample epoch/sequence/validity/freshness/calibrated warning-clear profile. Unknown is never clear. |
| Webcam / PS4 | Backend-owned selected device/profile, connection generation and fresh samples; T4 measured gesture orientation/ambiguity/neutral and actual DualShock 4 mapping. Held D-pad controls directions; Circle stops. |
| AI worker | T5 versioned model/checkpoint/assets/threshold/continuity manifest and T6 bounded IPC schema. Observations carry session/generation/frame identity, never record or motor authority. |

These are firmware/worker interface deliverables outside the public browser API. This document defines their required artifact contents and fail-closed integration behavior; it supplies no fabricated board configuration, thresholds, installed versions or test results. Independent software continues with clearly labeled fixtures.

## 11. Errors, retry policy and socket closure

Use safe `code, message, retryable`; optional `revision, snapshot, field_errors, action_id, permission_revoked`. Field errors contain `path, code, message` only, at most 64 entries; paths use JSON Pointer (for example `/roi/width`), never raw values or filesystem paths. Field codes are `REQUIRED, UNKNOWN_FIELD, INVALID_TYPE, INVALID_VALUE, OUT_OF_RANGE, DUPLICATE_FIELD, DUPLICATE_VALUE`. No tracebacks, credentials, absolute paths, object-name dumps or false wheel telemetry.

| HTTP | Machine codes / meaning |
| --- | --- |
| `400` | `INVALID_JSON, INVALID_MULTIPART, CURSOR_INVALID, CURSOR_EXPIRED`: malformed encoding or invalid pagination state. |
| `422` | `VALIDATION_FAILED`: schema/field/action-specific validation, ROI/image/name/range errors and route/body mismatch. |
| `413` | `PAYLOAD_TOO_LARGE`: streamed/request/image or configured transport bound exceeded. |
| `415` | `UNSUPPORTED_MEDIA_TYPE`: HTTP content type/charset/encoding; image variants with an accepted HTTP multipart container fail `422` if unusable. |
| `403` | `HOST_REJECTED, ORIGIN_REJECTED, CAPABILITY_INVALID, CLIENT_INVALID, LEASE_REQUIRED, LEASE_EXPIRED, LEASE_OWNED, TICKET_INVALID, TICKET_EXPIRED, TICKET_CONSUMED`. |
| `409` | `REVISION_CONFLICT, ACTION_ID_CONFLICT, REQUEST_ID_CONFLICT, INVALID_TRANSITION, ACTIVE_SESSION_EXISTS, PENDING_REVIEW, RECOVERY_REQUIRED, OWNERSHIP_MISMATCH, PREVIEW_STALE`. |
| `404` | `NOT_FOUND`: unknown/purged resource. Unsupported unrelated route also uses this structured response. |
| `410` | `EXPIRED` while current rows/journal establish expiry; `ACTION_EXPIRED` for an unseen registration outside its immutable submission window. No permanent tombstone or permanent distinction from `404`. |
| `503` | `MEDIA_UNAVAILABLE, NOT_READY, STORAGE_UNAVAILABLE, INITIALIZING, CAPACITY_REACHED, COUNTER_EXHAUSTED, PROTOCOL_UNSUPPORTED`: unavailable dependent service/profile/integrity/version. |
| `500` | `INTERNAL_ERROR`: unexpected failure; report safely and preserve current stop/recovery state. |

An existing candidate/failure associated with the wrong session gives `409 OWNERSHIP_MISMATCH`; an unknown referenced record gives `404`. Resource eligibility precedes exposing owner details. Existing committed receipt recovery precedes stale revisions; generic conflicts must not hide an actual committed result or existing stop latch.

`retryable` describes whether the unchanged request can reasonably be retried after recovery, not permission to bypass control/review. Set false for malformed/invalid input, authorization/conflict/expiry and incompatible protocol; a repaired outage/capacity/media condition can be true. Media corruption requiring external repair is not claimed to heal automatically. Include `Retry-After` only when the server has a meaningful recovery estimate; use integer seconds. Omit fabricated estimates. Never automatically acquire, Start or Resume because a retry delay elapsed.

Socket handshake errors use the corresponding HTTP Error before upgrade when supported by the implementation; a browser may expose only connection failure, so the UI then refreshes protected health/snapshot rather than assuming a precise close cause. Validate tickets and selected application version before accepting data.

| Socket close | Use |
| --- | --- |
| `1000` | Normal deliberate close/release/shutdown. |
| `1002` | WebSocket protocol violation. |
| `1003` | Unsupported application data kind (text on a binary-only video channel, binary on the event channel). |
| `1007` | Invalid UTF-8/text JSON encoding. |
| `1008` | Application policy/schema/version/replay violation or bounded consumer-queue policy overflow. |
| `1009` | Message exceeds its configured size bound. |
| `1011` | Unexpected server failure. |

Never transmit reserved `1006` as a close frame. Losing an owner channel stops regardless of whether a close frame arrives. Read-channel reconnect uses jittered exponential delay beginning at 250 ms, capped at 5 seconds; obtain a fresh one-use ticket per attempt. A fresh snapshot is mandatory; reconnect does not restore ownership or movement.

Standards references: [HTTP statuses and 202](https://www.rfc-editor.org/rfc/rfc9110.html#section-15), [Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3), [WebSocket closing codes](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4.1). Project-specific limits and error literals above are Alisa's approved contract, not requirements imposed by those standards.

## 12. Approval coverage and qualification evidence

### 12.1 Resolved API decisions

| ID | Approved resolution |
| --- | --- |
| API-01 | Configured 3000/8000 loopback defaults, exact Host/Origin, explicit missing-Origin/preflight rules, protected health (sections 2–3). |
| API-02 | Concrete bootstrap/ticket keys, client lifetime, 10-second one-use channel tickets and `laf.ticket.` subprotocol encoding (section 3). |
| API-03 | Four multipart parts, ROI JSON text, immutable submission header, strict parsing, names/normalization/bounds/image formats (sections 2, 5, 8). |
| API-04 | Concrete resource/list/mutation/health/snapshot/preview models and statuses; pending correlation distinct from committed facts (sections 4, 7–9). |
| API-05 | Approved history routes, descending keysets/BINARY collation, 25/1–100 pages, bound opaque runtime cursors and consistency policy (section 6). |
| API-06 | Safe integer boot generations, lease acquisition/release models, public/private separation, retry lifetime, nullable pre-session display and startup workflow (sections 4, 8–9). |
| API-07 | Client-bound 60-second preview, recomputed impact, explicit confirmation/revision, no lease for registration/settings and separate deletion progress (sections 3–4). |
| API-08 | Closed pause/end/failure vocabularies, no-op/repeat policies, strict action fields/failure IDs and deterministic evidence box rounding (sections 4–5, 7). |
| API-09 | Complete error/status/field-error/socket-close catalogue, contextual retry semantics and truthful retry headers (section 11). |
| API-10 | Nine typed event payloads, complete snapshot, heartbeat discriminator/keys, watermark synchronization and revision rules (sections 7, 9). |
| API-11 | Source clock/timestamp keys, integer upward-rounded age, required profile/manifest bounds and latest-frame versus ordered-event queue rules (sections 9–10). |
| API-12 | Runtime emergency request/result, unconditional protected revocation before persistence, pending/failed correlation and no-session behavior (section 8). |
| API-13 | PNG evidence, explicit availability/media projection, image variants/pixel boundary, white alpha compositing, no-store and complete-image range behavior (sections 3, 5). |
| API-14 | Coordinated release/major versions, safe counters, UUIDv4 retries, canonical hashes, original results and bounded registration admission after receipt expiry (sections 1–2, 8). |

### 12.2 Qualification deliverables

The API choices above are approved. The following are concrete evidence deliverables, not claims of completed measurement. Their owning requirements remain [TRD section 13](TRD.md#13-open-gates-owners-and-exit-evidence).

| Gate | Required artifact / owner / acceptance condition |
| --- | --- |
| T1 | Software team: compatible exact Windows/browser/Node/Python/packages/SQLite/GPU/toolchain lock; asset hashes/licenses; reproducible setup and durable SQLite configuration; early benchmark before baselining acceptance. |
| T2 | Software/integration team: selected device endpoint/identity/build/hash/protocol manifest and compatibility/parser checks before accepting each affected device connection. |
| T3 | Team: verified actual laptop/profile/network manifest and fixed-desk command/video evidence across two adjacent rooms; reported hardware is not qualification. |
| T4 | Input/frontend/integration team: measured gesture/controller/neutral mapping, calibrated advisory warning/clear profile and usable layout/scaling/stop accessibility before driving tests. |
| T5 | Vision team with supervisor: checkpoint/assets/threshold/continuity settings, five approved objects/references/lighting/placements and recognition/false-candidate trial evidence. |
| T6 | Integration/firmware team: complete versioned QualificationProfile, serial/camera/telemetry/IPC manifests, measured expiry/revocation/latency/component-budget and stability evidence before accepting dependent behavior. |
| T7 | Alisa/team with supervisor: approved visual assets/implemented accessibility evidence, confirmed assessment date and final report/demo plan before visual/assessment sign-off. |

Missing evidence keeps the corresponding qualification unpassed and its dependent connection/control capability unavailable. Fixture development and independent modules continue. No dates, model confidence values, firmware PWM settings, sensor calibration distances or device timing values are invented to claim closure.

External SM-2 remains actual event-to-wheel-stop ≤0.5 seconds including detection and mechanics. Software revocation/output traces alone cannot close it. SM-4 requires measured camera-to-display latency. SM-3's twenty-minute application stability run does not prove battery endurance. Room coverage and recognition targets require their stated actual-environment evidence.

### 12.3 Traceability and conformance

| PRD coverage | Contract |
| --- | --- |
| FR-1–FR-2 | Validated registration/reference/ROI, submission/durable retries, Start revision and one active session. |
| FR-3–FR-5 | Split backend video channels, exclusive mode, held selected input, focused usable workspace and bounded displayed freshness. |
| FR-6–FR-8, FR-17 | Lease-independent emergency revocation, Pause/Resume/Stop, recovery occurrences, neutral/reapply and no duration cap. |
| FR-9–FR-12 | Durable immutable candidate/evidence, human-only atomic Confirm/Reject, continuity suppression and terminal serialization. |
| FR-13–FR-14 | Filtered local feed, approved paginated histories, protected media and independent re-registration for Found belongings. |
| FR-15 | Original-registration retention, preview/confirm, active grace, eligibility filtering, journaled actual deletion and browser disposal. |
| FR-16 | Offline local shared-Windows-account access, exact Host/Origin/capability/ticket controls and no login/cloud/public sharing. |
| FR-18 | Silent advisory proximity with explicit Unknown, calibrated clear condition and no movement/readiness authority. |
| NFR/SM | Required reproducible interface/profile evidence and separate software, device and external product measurement. |

Before implementation acceptance, export and validate all HTTP/event/frame definitions; generate frontend types and check drift. Exercise boundary validation, image orientation/alpha/ROI, all transitions, receipt-before-revision recovery, pending/restart/expiry retries, concurrent terminal actions, origin/capability/ticket/lease rejection, spectator isolation, event gaps, stale generations/frames, media corruption and retention deletion failures. These checks establish software conformance only; a completed document is not a qualified robot.
