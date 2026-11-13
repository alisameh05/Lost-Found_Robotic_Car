---
title: "Lost and Found — API Contracts"
status: "Approved-source contract extraction; unresolved wire decisions remain open"
version: "0.1"
created: 2026-11-13
updated: 2026-11-13
sources: [PRD.md, TRD.md, ARCHITECTURE.md]
---

# Lost and Found — API Contracts

## 1. Authority, scope and contract status

This document derives the local application API from [PRD v1.3](PRD.md), [TRD v1.3](TRD.md), especially sections 5–10, and [Architecture v1.3](ARCHITECTURE.md), especially AD-2, AD-5–AD-13 and AD-15. The PRD owns product scope and acceptance; the architecture owns technical invariants; the TRD owns the initial API and data-model contracts. This document does not override them or claim any route is implemented or qualified.

On 2026-11-13, Alisa selected embedded JSON Schemas and examples, explicit implementation blockers for missing decisions, cursor pagination with its exact details proposed, and proposals for two paginated history routes. Those choices authorize the documentation treatment; they do not approve the proposed cursor encoding, limits, history wire shapes or other unresolved decisions.

Contract labels used throughout:

- **Required:** specified upstream or directly derived from an upstream invariant.
- **Proposed:** only the pagination details and two history routes explicitly requested for consideration. Approval is still required before freezing these details.
- **TBD / blocker:** no decision exists in the supplied approved sources. Do not select a framework default as an implicit contract.

The embedded schemas constrain known fields and relationships. They deliberately do not claim to be a complete executable OpenAPI specification. Unspecified response envelopes/projections, string bounds and conditional payload encodings remain blockers in section 12. Examples illustrate required facts; placeholders beginning `<TBD_` are not executable protocol values.

`docs/IMPLEMENTATION_GUIDE.md`, referenced by project guidance, was absent during this extraction. No contracts are attributed to it. Backend-generated OpenAPI and generated frontend/event types remain future implementation artifacts (TRD 9.1).

## 2. Transport, identity and shared rules

### 2.1 Service boundary and versioning

All paths below are relative to `http://127.0.0.1:<configured-backend-port>/api/v1`, or `ws://127.0.0.1:<configured-backend-port>/api/v1` for WebSockets. The backend port and the single exact frontend origin/port are deployment decisions, not assumed defaults. Next.js and FastAPI both bind only to `127.0.0.1`. FastAPI is the sole application-state, device and storage authority; Next.js supplies presentation. No runtime internet or cloud service is required.

The HTTP API namespace is **v1**. State events and frame metadata carry integer `protocol_version: 1`. WebSocket connections negotiate application subprotocol `laf.v1`. The document version `0.1` above is editorial and independent of these protocol versions. Device command/video/telemetry versions and database migration versions are separate version domains.

TBD: API compatibility/deprecation policy, unknown-field handling, unsupported-version error details and future-version negotiation. Until resolved, do not silently change field names, enum casing, revision scope or message types. Incompatible device messages block their dependent connection; they cannot be interpreted optimistically as v1.

### 2.2 Content, IDs and time

| Concern | Required contract |
| --- | --- |
| JSON | Ordinary structured actions, responses, errors and event messages use JSON. Registration is multipart; media and video are binary. Reject unsupported content types and oversized payloads. Exact JSON media-type strictness and non-image limits: TBD. |
| Domain IDs | Backend-issued opaque strings; do not assume UUID syntax, sorting, numeric meaning or filesystem paths. |
| `action_id` | Frontend-generated unique string for durable mutation retries; not a domain ID, credential or motion permission. Format/length: TBD. |
| `request_id` | Runtime request deduplication for lease operations within one backend boot; not a durable action receipt. |
| Revisions | Integer `expected_revision`, scoped to the resource being changed. Initial value/range/overflow policy: TBD. |
| Persistent time | UTC integer milliseconds, including registration, capture/review and end times. Registration time is backend-owned and immutable. |
| Runtime time | Monotonic clocks for deadlines; source monotonic camera timestamps are integer microseconds. Never compare unrelated clocks without an age/uncertainty bound. |
| Enum casing | Objects `Lost`, `Found`; sessions `Searching`, `Paused`, `Ended`; modes `Gestures`, `Controller`; match dispositions `Pending`, `Confirmed`, `Rejected`, `NotReviewed`. UI wording “Not reviewed” maps to `NotReviewed`. |
| Ownership | A session belongs to one object; a candidate belongs to that session/object; media belongs to the same object/candidate. Validate relationships server-side. |

### 2.3 Mutation concurrency and retry

Mutations carry `action_id`, applicable `session_id`, applicable `expected_revision` and their typed payload. Start checks the **object** revision; session/review actions check the **session** revision; retention commits check the **settings** revision. Registration has no previous revision. Only one `Searching` or `Paused` session exists globally. Target and mode remain locked throughout that session.

Check an existing durable action receipt and its request fingerprint **before** rejecting a stale revision. A retry with the same ID and identical scope/type/payload returns the original committed result. Reusing an ID for different work conflicts. Registration, session/review and settings receipts persist atomically with their mutations. Exact fingerprint canonicalization and action-result response representation are TBD. Receipt storage is internal; no receipt-lookup endpoint is approved. Recover a lost response through the same action ID and/or authoritative snapshot.

Serialize candidate and terminal actions. Only the first valid terminal commit wins. Confirmation commits the review, Found status/time, Ended session/time and receipt together against already durable evidence. A retry after retention deletion returns expired/missing and never recreates the record. Runtime lease deduplication expires with the backend boot; its lifetime must not be confused with durable receipts.

Stop/Pause remain available while another action is pending. Emergency stop revokes motion without waiting for an ordinary revision check, lease acquisition or disk write. An action response cannot grant indefinite movement. A successful response describes an established outcome; any unfinished save must be represented explicitly as pending. The pending envelope, completion correlation and success HTTP statuses are TBD.

## 3. Authentication, authorization and caching

### 3.1 Authentication and automatic local protection

There are no application accounts, passwords, roles, tenants or login gate. Anyone using the same Windows account can access that account's application data (FR-16, AD-12). The launcher issues a per-launch unguessable capability as automatic service protection, not user authentication.

1. An exact-origin/Host-checked, no-store `GET /bootstrap` automatically supplies `client_id` and the per-run capability to the allowed local frontend. No motion lease is granted.
2. Protected HTTP requests send `X-App-Capability: <per-launch-capability>`. Bootstrap is the exception because it obtains that capability. Exact health-endpoint exemption: TBD; implementers must resolve it explicitly.
3. Validate Host and the allowed browser Origin; reject foreign/null origins on browser bootstrap/control connections. No wildcard CORS. CORS is not authorization. Non-browser/missing-Origin policy and exact preflight handling are TBD.
4. To open a socket, an authorized HTTP call obtains a short-lived one-use ticket scoped to its channel and client. Offer the ticket through `Sec-WebSocket-Protocol` together with `laf.v1`. Consume/validate it before upgrade and select only `laf.v1`; never select/echo the ticket. Exact ticket-bearing subprotocol encoding and lifetime are TBD.
5. Capabilities/tickets never appear in URLs, logs, persistent browser storage or public build assets. Rotate capabilities and invalidate old leases on backend restart. A new capability never resumes motion.

Apply protection to control and media channels. The browser WebSocket API cannot supply an arbitrary authorization header; the HTTP capability header is not the WebSocket handshake mechanism. This protection does not claim isolation from malicious software running as the same Windows user.

### 3.2 Authorization matrix

| Operation | Required backend checks beyond local protection |
| --- | --- |
| Read objects/history/media/snapshot/settings | Expiry, active-session grace, ownership relationships and storage lifecycle/integrity. A second tab can read but cannot silently control. |
| Acquire/release lease | Correct client, runtime request deduplication, boot/lease state; takeover only after previous lease expired/released. Never evict a healthy owner. |
| Start / ordinary session or review action | `client_id` and live `client_lease_id`, resource ownership/revision, valid transition, retention eligibility and action deduplication. Start/Resume also require readiness; acknowledgment names owned failure occurrences. |
| Register independent object | Validate complete registration and storage health. A separate registration is permitted while a session is active; it never changes that session's target. Lease requirement for non-control writes: TBD. |
| Retention change | No active session, current settings revision, valid impact preview and explicit confirmation, healthy storage. Lease requirement for settings writes: TBD. |
| Emergency stop | Valid local protection; permit revocation with absent/expired control lease and stale revision. This grants no movement rights. |
| Worker/device observations | Never authorize confirmation, direct object/session mutation or independent motor permission. No public observation-upload routes are approved. |

The session coordinator also enforces selected-input exclusivity, focused/visible operational workspace, displayed-video freshness, AI/storage/command readiness and deliberate recovery. Proximity warnings have no readiness, movement or session authority.

### 3.3 Media/privacy and retention

Bootstrap and managed media are no-store. Do not persist evidence in browser storage, Next.js image/data caches, public directories or logs. Fetch protected media directly with the capability header; temporary browser object URLs must be revoked when cleared. No tokenized media URLs or public static media root are allowed. Cache policy for other JSON endpoints is TBD; it must not retain expired data.

`expiry = registered_at_ms + retention_days × 86,400,000`. Retention is 1–30 whole days, default seven. Reads/actions deny expired data unless its existing `Searching`/`Paused` session grants grace. Grace ends with that session and never permits a new session. Recalculate from original registration on settings changes. Purge at startup before exposing history/search, and during runtime; cleanup failures hide expired data and block new searches/data changes until integrity is restored. Safety Stop/Pause and necessary repair/cleanup remain permitted. Do not claim physical deletion complete while managed rows/files remain.

## 4. Endpoint catalogue

All `{id}` segments are opaque identifiers, not paths. Route IDs and duplicated body IDs must agree. The request/response names refer to section 7 schemas or to explicitly unresolved wire shapes. Optional/nullability is stated where approved; unspecified fields are not silently declared optional.

### 4.1 Bootstrap, tickets and leases

| Method and path | Parameters / request | Response facts and behavior |
| --- | --- | --- |
| `GET /bootstrap` | No domain payload. Exact Host/Origin checks. | Backend `client_id` and per-run capability; no-store. Capability response key/envelope: TBD. No lease/session creation. |
| `POST /websocket-tickets` | Protected; client and channel: event, robot-video or webcam-video. Exact JSON field names/channel literals: TBD. | Short-lived, one-use client/channel-scoped ticket. Ticket field/envelope and expiry representation: TBD. No movement rights. |
| `POST /control-lease` | JSON `LeaseAcquire`: `request_id`, `client_id`, nullable active `session_id`, explicit `takeover`. | `client_lease_id`, `control_generation`, lease state. State encoding, generation type and timing fields: TBD. Reacquisition/transfer also returns a snapshot and cannot clear recovery or Resume. |
| `POST /control-lease/release` | JSON `LeaseReleaseKnownFields`: `request_id`, `client_id`; exact lease-identification payload: TBD. | Revocation and Paused active session; exact result schema: TBD. Always disarm before any later acquisition. |

Every control-changing HTTP action identifies its `client_id`/`client_lease_id`. The precise release-body layout and runtime no-active-session representation require a wire decision. Do not use an undefined lease field to weaken owner checks.

### 4.2 Health and synchronization

| Method and path | Parameters / request | Response facts and behavior |
| --- | --- | --- |
| `GET /health` | No defined query/body. Protection exemption unresolved. | Separately report process health, initialization, storage integrity, readiness and operational state. Exact component/status fields and HTTP status behavior: TBD. A healthy process is not ready-to-move permission. |
| `GET /snapshot` | Protected; no defined query/body. | Authoritative snapshot requirements in section 8. Exact envelope/field names: TBD. Use after reconnect/sequence gap before control eligibility. |

### 4.3 Objects and history

| Method and path | Parameters / request | Response facts and behavior |
| --- | --- | --- |
| `GET /objects` | Name/status filters required as capabilities; literal parameter names/lengths TBD. Proposed query/pagination details in section 6. | Retention-filtered local feed; object facts `ObjectFacts`. Response list envelope: proposed, not approved. |
| `POST /objects` | Multipart: `action_id`, nonblank `name`, reference bytes and `roi` (`Roi`). Exact image-part name and ROI part encoding: TBD. | New independent Lost record, committed reference media and registration time; `ObjectFacts`. Exact mutation envelope/status: TBD. No client timestamp/status/Found input. |
| `GET /objects/{id}` | Object ID; no approved additional query. | Eligible object/reference facts and history access. Full detail projection/history embedding: TBD. Never expose internal paths or deletion/staging rows. |
| **Proposed** `GET /objects/{id}/sessions` | Parent object ID; proposed `cursor`, `limit`. | Paginated sessions for that object only; `SessionFacts`. Subject to the same expiry/grace filtering. |
| `GET /sessions/{id}` | Session ID. | Durable `SessionFacts` and current revision; parent-object eligibility still applies. Full envelope: TBD. |
| **Proposed** `GET /sessions/{id}/matches` | Parent session ID; proposed `cursor`, `limit`. | Paginated candidate/review history belonging to that session/object; `MatchFacts`, including screenshots through media IDs. |

No update/delete-object, reopen-Found, arbitrary filesystem import, full-video download, account or public-sharing endpoint is approved. A Found belonging needs a new registration. Every session and confirmed/rejected review must be accessible for FR-13; the two proposed history routes supply a candidate retrieval design pending approval.

### 4.4 Start and session/review actions

| Method and path | Request | Required result / guards |
| --- | --- | --- |
| `POST /sessions` | JSON `StartRequest` plus controlling client/lease. | Atomically Start the selected Lost/unexpired object if no active session and required readiness is healthy. Return new `SessionFacts`, initially Searching but motion disarmed pending neutral then fresh input. Mode/target remain fixed. |
| `POST /sessions/{id}/actions` | JSON `SessionAction`; body `session_id` agrees with route; controlling client/lease. | Validate action-specific transition and return authoritative committed facts/revision. Review also affects candidate/object; exact multi-resource result envelope: TBD. |
| `POST /emergency-stop` | Capability protected. Exact request/retry envelope: TBD; no ordinary revision or lease prerequisite may block revocation. | Revoke motion immediately; latch/publish/persist cause afterward. Pause an active session. With no active session stay disarmed without creating one. Exact response/pending shape: TBD. |

Allowed session actions are exactly:

| `action` | Extra parameters | Validation and outcome |
| --- | --- | --- |
| `pause` | None required upstream. | Stop motion and matching; Paused, same mode/target. Repeated independent Pause transition policy: TBD; identical action-ID retries deduplicate. |
| `resume` | None required upstream. | Paused session only; required connections/capabilities restored, all current failures acknowledged, no pending review, valid controlling workspace/video. Searching; require release/neutral and fresh hold. Never resume Ended. |
| `stop` | None required upstream. | Stop immediately; commit Ended unsuccessful session with Lost object. Pending evidence becomes `NotReviewed`, not Rejected. Terminal conflicts cannot undo an already committed confirmation. |
| `acknowledge` | `failure_ids`: string array. | Verify each occurrence belongs to the session. Acknowledgment does not prove restoration or Resume. Empty/duplicate-array policy: TBD. |
| `confirm` | `candidate_id`. | Candidate belongs to session/object and is pending; durable evidence required. Atomically Confirmed/review time + Found/time + Ended/time + receipt. No AI/firmware confirmation. |
| `reject` | `candidate_id`. | Save Rejected/review time; Lost and Paused until explicit Resume. Maintain continuity-based suppression until observed exit/re-entry. |

Unknown actions are rejected. Cross-session candidates and failure IDs are rejected. Exact closed pause-cause/end-reason vocabularies and race-specific error codes are TBD; restart end reason `Interrupted` is explicitly specified. A held input cannot clear a stop latch. Resume cannot require an absent-view condition for a rejected candidate; uncertain continuity retains suppression without blocking otherwise valid recovery/Resume.

### 4.5 Settings and protected images

| Method and path | Parameters / request | Response facts and behavior |
| --- | --- | --- |
| `GET /settings` | Protected; no defined query/body. | Singleton `SettingsFacts`, current revision and effective retention days. |
| `POST /settings/retention-preview` | Protected; proposed days and current settings revision must be represented. Exact payload/action-ID policy: TBD. | Impact of applying days to original registrations, plus `preview_id` for later commit. Impact fields, validity duration and expiry races: TBD. No settings mutation yet. |
| `PUT /settings/retention` | JSON `RetentionChange`: `action_id`, settings `expected_revision`, integer `retention_days`, `preview_id`, `confirmed: true`. | Validate preview against current eligible records; no active Searching/Paused session; reject stale/changed preview. Commit settings/receipt and re-evaluate retention immediately. Deletion completion is separate from settings commit. |
| `GET /media/{id}` | Protected; generated media ID only. | Binary Ready media with a safe validated content type and no-store. Enforce owner expiry/grace. Never return raw path/checksum as a substitute for available evidence. Missing/corrupt evidence is explicitly unavailable. |

Reference formats are JPEG/PNG. Live video frames are JPEG. Saved detection screenshot format, image response headers beyond no-store/content type, range support and exact unavailable-media error details are TBD. This route does not expose staging media or filesystem directory listings.

## 5. Validation and model invariants

| Data / operation | Required validation |
| --- | --- |
| Object name | Nonblank; duplicate names allowed; parameterized local substring search. Max length, whitespace normalization and case/Unicode search rules: TBD. User SQL wildcard characters cannot become executable query syntax. |
| Reference image | JPEG/PNG only; at most 10 MiB encoded (10,485,760 bytes), at most 20 megapixels decoded. Normalize orientation and repeat validation in backend. Corrupt/unusable image fails registration. Exact decoded-pixel boundary convention and accepted JPEG/PNG variants: TBD. Multipart overhead limit is separate from encoded image limit. |
| Target ROI | Integer x/y/width/height in normalized-orientation source pixels. x/y ≥ 0, width/height > 0; x + width ≤ normalized width, y + height ≤ normalized height. A replaced reference clears selection. No scaled-display coordinates. |
| Object facts | Lost/Found only; Found iff confirmation time is present. Registration time immutable. A Found record cannot be reused/reopened as Lost. |
| Session facts | Searching/Paused/Ended only; one active including Paused. Consistent end time/reason. Mode only Gestures/Controller and locked through Pause. No automatic duration cap. |
| Candidate/evidence | At most one pending candidate per session; immutable saved frame/box. Box is a nonzero in-bounds rectangle in evidence pixels. Preserve `frame_id`/`stream_epoch`; never draw a box onto a different frame. Confirmed/Rejected require review time. Exact conversion of fractional inference coordinates to stored pixels: TBD. |
| Retention | Integer days 1–30, default 7. Preview/confirmation/current revision; changes unavailable while Searching/Paused. No registration-time reset. |
| IDs and revisions | Opaque nonempty identity; correct ownership, applicable revision and action fingerprint. Do not accept client-authored storage paths or trust client readiness/status assertions. |
| Inputs and channels | Backend owns webcam, controller, serial and AI. Inactive-mode samples never drive motion. Heartbeats/video acknowledgments do not carry directions or replace fresh device samples. |
| Storage | Durable image preparation precedes registration/candidate exposure and decision commit. Storage failures cannot be represented as successful saves. Internal staging/deletion flags are not new domain states. |

Exact non-image JSON/multipart limits, field/string bounds, runtime rates and strict unknown-field policy are blockers. Enforce the approved image limits now in a conforming implementation; do not use absent limits to justify unbounded allocations.

## 6. Cursor pagination — selected approach, proposed wire details

Alisa selected cursor pagination. Everything in the following wire design remains **proposed**, including parameter names, bounds, directions and envelope. No upstream document selects these exact values.

| Item | Proposed detail |
| --- | --- |
| List routes | `/objects`, proposed `/objects/{id}/sessions`, proposed `/sessions/{id}/matches`. |
| Query | Optional opaque `cursor`; optional integer `limit`, default 25, range 1–100. `/objects` additionally accepts `name` literal substring and `status=Lost|Found`. |
| Order | Objects: `(registered_at_ms DESC, id DESC)`; sessions: `(started_at_ms DESC, id DESC)`; matches: `(captured_at_ms DESC, id DESC)`. TRD requires time-then-ID ordering; descending direction is proposed. ID comparison/collation must be frozen. |
| Cursor | Backend-generated opaque, integrity-protected encoding of version, route/parent, filters, ordering and last emitted time/ID. No capability, path, object name or image data should be exposed in its public representation. Exact encoding/key lifecycle: TBD proposal detail. |
| Envelope | `{ "items": [...], "next_cursor": "opaque-value-or-null" }`; null means no further eligible entries. No total count proposed. |
| Continuation | Same route/parent/filter binding; incompatible/tampered/malformed cursor fails as invalid input. Keyset boundary excludes the last emitted tuple. Re-evaluate retention on every page. |
| Concurrent changes | No cross-page snapshot guarantee proposed. New registrations before the boundary appear on a refreshed first page; expiry may remove entries. Status changes may alter membership. Empty final pages are allowed. Never serve expired data to preserve pagination consistency. |

Proposed example (not an approved response envelope):

```json
{"items":[{"id":"obj_illustrative","name":"Keys","status":"Lost","registered_at_ms":1794560400000,"found_at_ms":null,"revision":1}],"next_cursor":null}
```

Approval must also resolve cursor lifetime/stale-cursor responses, consistency guarantees under membership changes and default sort direction. An expired parent still fails its history read even if its cursor was valid earlier. Pagination does not extend retention or grant control.

## 7. Embedded JSON Schemas and HTTP examples

### 7.1 Schema interpretation

The following JSON Schema draft 2020-12 document has reusable `$defs`. References in this document use `#/$defs/<name>`. Schemas express **known constraints**, not approval of an exact response projection or every property of a request. Properties without an approved spelling/layout are omitted and recorded in section 12. Additional properties are deliberately not closed until unknown-field policy is decided. Required runtime identity fields on Start/session actions are included from TRD 9.3.

`ObjectFacts`, `SessionFacts`, `MatchFacts`, `MediaFacts` and `SettingsFacts` describe logical facts from TRD 7 for use in responses. Whether they are nested or flat, and which facts a list versus detail serializes, is TBD. They never authorize exposing internal `relative_path`, storage journal, request fingerprints or lifecycle flags. An `id` in `MatchFacts` is the candidate identity supplied as `candidate_id` on review actions; this mapping must remain consistent.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Lost and Found v1 known API constraints",
  "$defs": {
    "Id": {"type":"string","minLength":1},
    "Revision": {"type":"integer"},
    "UtcMs": {"type":"integer"},
    "NullableUtcMs": {"type":["integer","null"]},
    "Roi": {
      "type":"object","required":["x","y","width","height"],
      "properties": {
        "x":{"type":"integer","minimum":0},"y":{"type":"integer","minimum":0},
        "width":{"type":"integer","minimum":1},"height":{"type":"integer","minimum":1}
      },
      "$comment":"Backend also validates sums against orientation-normalized source dimensions."
    },
    "RegistrationFields": {
      "type":"object","required":["action_id","name","roi"],
      "properties": {
        "action_id":{"$ref":"#/$defs/Id"},
        "name":{"type":"string","pattern":"\\S"},"roi":{"$ref":"#/$defs/Roi"}
      },
      "$comment":"Multipart reference bytes are additionally required; part name and ROI encoding are TBD."
    },
    "StartRequest": {
      "type":"object",
      "required":["action_id","object_id","expected_revision","control_mode","client_id","client_lease_id"],
      "properties": {
        "action_id":{"$ref":"#/$defs/Id"},"object_id":{"$ref":"#/$defs/Id"},
        "expected_revision":{"$ref":"#/$defs/Revision"},
        "control_mode":{"enum":["Gestures","Controller"]},
        "client_id":{"$ref":"#/$defs/Id"},"client_lease_id":{"$ref":"#/$defs/Id"}
      }
    },
    "SessionAction": {
      "type":"object",
      "required":["action_id","session_id","expected_revision","action","client_id","client_lease_id"],
      "properties": {
        "action_id":{"$ref":"#/$defs/Id"},"session_id":{"$ref":"#/$defs/Id"},
        "expected_revision":{"$ref":"#/$defs/Revision"},
        "action":{"enum":["pause","resume","stop","acknowledge","confirm","reject"]},
        "candidate_id":{"$ref":"#/$defs/Id"},
        "failure_ids":{"type":"array","items":{"$ref":"#/$defs/Id"}},
        "client_id":{"$ref":"#/$defs/Id"},"client_lease_id":{"$ref":"#/$defs/Id"}
      },
      "allOf":[
        {"if":{"properties":{"action":{"enum":["confirm","reject"]}},"required":["action"]},"then":{"required":["candidate_id"]}},
        {"if":{"properties":{"action":{"const":"acknowledge"}},"required":["action"]},"then":{"required":["failure_ids"]}}
      ],
      "$comment":"Action-inapplicable field rejection policy is TBD; ownership and transition validation are mandatory."
    },
    "RetentionChange": {
      "type":"object","required":["action_id","expected_revision","retention_days","preview_id","confirmed"],
      "properties": {
        "action_id":{"$ref":"#/$defs/Id"},"expected_revision":{"$ref":"#/$defs/Revision"},
        "retention_days":{"type":"integer","minimum":1,"maximum":30},
        "preview_id":{"$ref":"#/$defs/Id"},"confirmed":{"const":true}
      }
    },
    "LeaseAcquire": {
      "type":"object","required":["request_id","client_id","session_id","takeover"],
      "properties": {
        "request_id":{"$ref":"#/$defs/Id"},"client_id":{"$ref":"#/$defs/Id"},
        "session_id":{"type":["string","null"]},"takeover":{"type":"boolean"}
      }
    },
    "LeaseReleaseKnownFields": {
      "type":"object","required":["request_id","client_id"],
      "properties":{"request_id":{"$ref":"#/$defs/Id"},"client_id":{"$ref":"#/$defs/Id"}},
      "$comment":"Incomplete until exact owner/lease identification is frozen; not sufficient alone for authorization."
    },
    "ObjectFacts": {
      "type":"object","required":["id","name","status","registered_at_ms","found_at_ms","revision"],
      "properties": {
        "id":{"$ref":"#/$defs/Id"},"name":{"type":"string","pattern":"\\S"},
        "status":{"enum":["Lost","Found"]},"registered_at_ms":{"$ref":"#/$defs/UtcMs"},
        "found_at_ms":{"$ref":"#/$defs/NullableUtcMs"},"revision":{"$ref":"#/$defs/Revision"},
        "roi_x":{"type":"integer","minimum":0},"roi_y":{"type":"integer","minimum":0},
        "roi_width":{"type":"integer","minimum":1},"roi_height":{"type":"integer","minimum":1}
      },
      "allOf":[
        {"if":{"properties":{"status":{"const":"Found"}}},"then":{"properties":{"found_at_ms":{"type":"integer"}}},"else":{"properties":{"found_at_ms":{"type":"null"}}}}
      ],
      "$comment":"ROI response nesting and reference-media association serialization are TBD."
    },
    "SessionFacts": {
      "type":"object","required":["id","object_id","control_mode","state","started_at_ms","ended_at_ms","end_reason","revision"],
      "properties": {
        "id":{"$ref":"#/$defs/Id"},"object_id":{"$ref":"#/$defs/Id"},
        "control_mode":{"enum":["Gestures","Controller"]},"state":{"enum":["Searching","Paused","Ended"]},
        "started_at_ms":{"$ref":"#/$defs/UtcMs"},"ended_at_ms":{"$ref":"#/$defs/NullableUtcMs"},
        "end_reason":{"type":["string","null"]},"revision":{"$ref":"#/$defs/Revision"}
      },
      "allOf":[
        {"if":{"properties":{"state":{"const":"Ended"}}},"then":{"properties":{"ended_at_ms":{"type":"integer"},"end_reason":{"type":"string","minLength":1}}},"else":{"properties":{"ended_at_ms":{"type":"null"},"end_reason":{"type":"null"}}}}
      ],
      "$comment":"pause_causes is required domain information; its exact JSON structure/vocabulary is TBD."
    },
    "MatchFacts": {
      "type":"object","required":["id","session_id","object_id","captured_at_ms","frame_id","stream_epoch","disposition","reviewed_at_ms"],
      "properties": {
        "id":{"$ref":"#/$defs/Id"},"session_id":{"$ref":"#/$defs/Id"},"object_id":{"$ref":"#/$defs/Id"},
        "captured_at_ms":{"$ref":"#/$defs/UtcMs"},"frame_id":{"$ref":"#/$defs/Id"},"stream_epoch":{"$ref":"#/$defs/Id"},
        "box_x":{"type":"integer","minimum":0},"box_y":{"type":"integer","minimum":0},
        "box_width":{"type":"integer","minimum":1},"box_height":{"type":"integer","minimum":1},
        "disposition":{"enum":["Pending","Confirmed","Rejected","NotReviewed"]},
        "reviewed_at_ms":{"$ref":"#/$defs/NullableUtcMs"}
      },
      "allOf":[
        {"if":{"properties":{"disposition":{"enum":["Confirmed","Rejected"]}}},"then":{"properties":{"reviewed_at_ms":{"type":"integer"}}}}
      ],
      "$comment":"Stored evidence box dimensions are integers; response box/media association shape is TBD."
    },
    "MediaFacts": {
      "type":"object","properties": {
        "id":{"$ref":"#/$defs/Id"},"object_id":{"$ref":"#/$defs/Id"},
        "match_event_id":{"type":["string","null"]},"role":{"enum":["Reference","Evidence"]},
        "format":{"type":"string"},"width":{"type":"integer","minimum":1},
        "height":{"type":"integer","minimum":1},"byte_length":{"type":"integer","minimum":1},
        "created_at_ms":{"$ref":"#/$defs/UtcMs"}
      },
      "$comment":"Metadata projection, format literals and parent embedding TBD; GET /media/{id} returns bytes."
    },
    "SettingsFacts": {
      "type":"object","required":["retention_days","revision","updated_at_ms"],
      "properties": {
        "retention_days":{"type":"integer","minimum":1,"maximum":30},
        "revision":{"$ref":"#/$defs/Revision"},"updated_at_ms":{"$ref":"#/$defs/UtcMs"}
      }
    },
    "Error": {
      "type":"object","required":["code","message","retryable"],
      "properties": {
        "code":{"type":"string","minLength":1},"message":{"type":"string"},
        "retryable":{"type":"boolean"},"revision":{"$ref":"#/$defs/Revision"}
      },
      "$comment":"Optional authoritative snapshot is allowed; its exact property name/schema is TBD. Code vocabulary is TBD."
    },
    "EventEnvelope": {
      "type":"object","required":["protocol_version","backend_boot_id","event_seq","session_id","session_revision","type","occurred_at_ms","payload"],
      "properties": {
        "protocol_version":{"const":1},"backend_boot_id":{"$ref":"#/$defs/Id"},
        "event_seq":{"type":"integer"},"session_id":{"type":["string","null"]},
        "session_revision":{"type":["integer","null"]},
        "type":{"enum":["snapshot","session_changed","readiness_changed","candidate_pending","recovery_changed","retention_changed","object_removed","storage_fault","proximity_warning_changed"]},
        "occurred_at_ms":{"$ref":"#/$defs/UtcMs"},"payload":{}
      },
      "$comment":"Typed per-event payload schemas are blockers, not arbitrary-payload permission."
    },
    "FailureFacts": {
      "type":"object","required":["failure_id","observed_at_ms","restored","acknowledged"],
      "properties": {
        "failure_id":{"$ref":"#/$defs/Id"},"observed_at_ms":{"$ref":"#/$defs/UtcMs"},
        "restored":{"type":"boolean"},"acknowledged":{"type":"boolean"}
      },
      "$comment":"Also requires nullable owning session and typed cause; their exact JSON keys/type vocabulary are TBD."
    },
    "FrameMetadataKnownFields": {
      "type":"object","required":["protocol_version","source","stream_epoch","capture_seq","frame_id","width","height","received_at_ms","capture_age_bound_ms"],
      "properties": {
        "protocol_version":{"const":1},"source":{"enum":["robot","webcam"]},
        "stream_epoch":{"$ref":"#/$defs/Id"},"capture_seq":{"type":"integer"},
        "frame_id":{"$ref":"#/$defs/Id"},"width":{"type":"integer","minimum":1},
        "height":{"type":"integer","minimum":1},"received_at_ms":{"$ref":"#/$defs/UtcMs"},
        "capture_age_bound_ms":{"type":"number","minimum":0}
      },
      "$comment":"Age-bound numeric representation needs freezing. Robot frames additionally require source monotonic timestamp/clock epoch; exact keys TBD."
    },
    "HeartbeatKnownFields": {
      "type":"object","required":["client_lease_id","session_id","control_generation","heartbeat_seq","workspace_visible","workspace_focused"],
      "properties": {
        "client_lease_id":{"$ref":"#/$defs/Id"},"session_id":{"type":["string","null"]},
        "control_generation":{},"heartbeat_seq":{"type":"integer"},
        "workspace_visible":{"type":"boolean"},"workspace_focused":{"type":"boolean"}
      },
      "$comment":"Generation type, message discriminator and last-displayed frame ID/epoch keys/nullable bootstrap behavior are TBD."
    }
  }
}
```

Cross-field image bounds, ownership, readiness, increasing counters, expiry, one-active-session enforcement and durable transaction behavior require backend validation beyond these schemas. Integer counter ranges and epoch formats are not silently selected here.

### 7.2 Request and result examples

These examples use illustrative opaque IDs, revisions and timestamps, not installed-device values. JSON result snippets show facts, not approval of missing response envelopes or success status codes.

Registration field values (multipart image bytes must also be supplied under the TBD part name):

```json
{"action_id":"action_register_1","name":"Keys","roi":{"x":120,"y":80,"width":240,"height":160}}
```

For an orientation-normalized 1280×720 valid reference, this rectangle is in bounds. The registration result contains new Lost facts and a reference association; the following is only the known fact subset:

```json
{"id":"obj_illustrative","name":"Keys","status":"Lost","registered_at_ms":1794560400000,"found_at_ms":null,"revision":1,"roi_x":120,"roi_y":80,"roi_width":240,"roi_height":160}
```

Acquire before Start (`POST /control-lease`):

```json
{"request_id":"request_acquire_1","client_id":"client_illustrative","session_id":null,"takeover":false}
```

The result includes `client_lease_id`, `control_generation` and lease state; generation/state JSON types must be resolved before a concrete result can be validly shown. Bootstrap likewise returns a client ID and capability, but the capability key is TBD. Neither response starts a session.

Start (`POST /sessions`, header `X-App-Capability: <per-launch-capability>`):

```json
{"action_id":"action_start_1","object_id":"obj_illustrative","expected_revision":1,"control_mode":"Controller","client_id":"client_illustrative","client_lease_id":"lease_illustrative"}
```

Known session result facts:

```json
{"id":"session_illustrative","object_id":"obj_illustrative","control_mode":"Controller","state":"Searching","started_at_ms":1794560460000,"ended_at_ms":null,"end_reason":null,"revision":1}
```

This does not authorize motion before fresh input and all qualified gates. The full session response must also represent pause causes where applicable once their shape is frozen.

Pause, Resume and Stop use the same action shape (substitute the desired allowed `action`, a new action ID and the latest session revision):

```json
{"action_id":"action_pause_1","session_id":"session_illustrative","expected_revision":1,"action":"pause","client_id":"client_illustrative","client_lease_id":"lease_illustrative"}
```

Known Pause result facts, conditional on that mutation winning:

```json
{"id":"session_illustrative","object_id":"obj_illustrative","control_mode":"Controller","state":"Paused","started_at_ms":1794560460000,"ended_at_ms":null,"end_reason":null,"revision":2}
```

Confirm/reject example (`POST /sessions/session_illustrative/actions`):

```json
{"action_id":"action_confirm_1","session_id":"session_illustrative","expected_revision":4,"action":"confirm","candidate_id":"candidate_illustrative","client_id":"client_illustrative","client_lease_id":"lease_illustrative"}
```

A successful confirmation's object facts include:

```json
{"id":"obj_illustrative","name":"Keys","status":"Found","registered_at_ms":1794560400000,"found_at_ms":1794560520000,"revision":2}
```

The same transaction also commits candidate `Confirmed`/review time and session `Ended`/end time. Exact response envelope, end-reason literal and revision advancement rules beyond changed-resource consistency are TBD. For rejection use `action: "reject"`; outcome remains Lost/Paused with candidate `Rejected`. Do not infer Resume from its HTTP success.

Example candidate fact subset, suitable for review/history once the response projection is frozen:

```json
{"id":"candidate_illustrative","session_id":"session_illustrative","object_id":"obj_illustrative","captured_at_ms":1794560500000,"frame_id":"frame_illustrative","stream_epoch":"stream_illustrative","box_x":80,"box_y":40,"box_width":200,"box_height":120,"disposition":"Pending","reviewed_at_ms":null}
```

Acknowledge a specific recovery occurrence; this never resumes by itself:

```json
{"action_id":"action_ack_1","session_id":"session_illustrative","expected_revision":5,"action":"acknowledge","failure_ids":["failure_illustrative"],"client_id":"client_illustrative","client_lease_id":"lease_illustrative"}
```

Settings read result fact subset:

```json
{"retention_days":7,"revision":1,"updated_at_ms":1794560400000}
```

After a separately obtained valid preview, commit retention (`PUT /settings/retention`):

```json
{"action_id":"action_retention_1","expected_revision":1,"retention_days":5,"preview_id":"preview_illustrative","confirmed":true}
```

Example settings result facts after commit:

```json
{"retention_days":5,"revision":2,"updated_at_ms":1794560600000}
```

Preview response, ticket response, health/snapshot responses, emergency-stop request/result and lease-release result examples cannot be made executable until their wire blockers are resolved. Their required semantics are documented in sections 4 and 8. Media success is the image body, for example validated `Content-Type: image/jpeg` with `Cache-Control: no-store`, not a JSON filesystem path.

## 8. WebSocket events, frames and readiness

### 8.1 Routes and event delivery

| Route | Direction and contract |
| --- | --- |
| `WS /events` | Server sends initial snapshot then ordered typed events. Client sends protected workspace heartbeats and displayed-frame acknowledgments. Client message discriminator/envelope and acknowledgment field spellings are TBD. |
| `WS /video/robot` | Server sends bounded metadata+JPEG frames with preserved robot capture metadata. No motor commands accepted. |
| `WS /video/webcam` | Separate backend-owned preview using the same frame envelope; not browser webcam upload. No motor commands accepted. |

Every channel requires its own client/channel-scoped ticket. Each state event conforms to `EventEnvelope`; `event_seq` increases within `backend_boot_id`. Reconnect or sequence gap requires a full snapshot before control eligibility. Event order never replaces resource revision checks. Socket closure/heartbeat loss revokes the workspace lease, stops and pauses. Slow video consumers cannot block stop/state delivery; independent bounded queues are required. Exact queue/drop limits, replay/buffering policy and WebSocket close codes are TBD/T6.

Snapshot and typed event payload requirements (exact field layouts are blockers):

| Type | Required meaning / facts |
| --- | --- |
| `snapshot` | Active session/object, resource revisions, required-path readiness, unresolved failure occurrences, pending candidate, lease owner/eligibility, proximity state and effective retention deadline/grace. Also sufficient boot/stream/control identity to discard old state. |
| `session_changed` | Authoritative state and applicable session revision; retain mode/target lock and end/pause facts. |
| `readiness_changed` | Required-path/capability availability and actionable causes. Acquisition and displayed freshness must both gate video readiness. |
| `candidate_pending` | Correct session/generation/frame candidate and immutable screenshot/box for review, after revocation and durable evidence preparation. |
| `recovery_changed` | Current failure occurrences, restored/acknowledged state; new occurrences cannot reuse a previously acknowledged ID. |
| `retention_changed` | Effective retention configuration/revision and resulting deadline/grace information. |
| `object_removed` | Identity needed to clear inaccessible object/history/media views. Clear browser copies when expiry takes effect. |
| `storage_fault` | Safe fault/integrity information, incomplete deletion/save and blocked capabilities; never claim unsaved success. |
| `proximity_warning_changed` | Silent calibrated advisory warning or unknown reading state; never changes session, motion or readiness. Exact warning enum/telemetry projection: TBD. |

Event-envelope example with deliberately unresolved payload:

```json
{"protocol_version":1,"backend_boot_id":"boot_illustrative","event_seq":12,"session_id":"session_illustrative","session_revision":3,"type":"session_changed","occurred_at_ms":1794560500000,"payload":"<TBD_TYPED_SESSION_CHANGED_PAYLOAD>"}
```

The placeholder is not an implementable typed payload. Freeze each event schema and generated TypeScript type before frontend/backend work diverges.

### 8.2 Workspace heartbeat, acknowledgments and recovery

Heartbeats contain `client_lease_id`, current `session_id`, `control_generation`, strictly increasing `heartbeat_seq`, `workspace_visible`, `workspace_focused` and last displayed robot frame ID/epoch. Validate boot, active lease, session, generation and displayed frame identity; a counter alone cannot renew readiness. The exact client-message shape, last-frame key names, initial no-frame representation, intervals/deadlines and generation types are TBD.

The browser acknowledges after decode/display. Backend receipt time contributes to a conservative capture-age bound; browser-clock claims do not establish freshness. Old frames, heartbeats or replayed sequences cannot rearm. Hidden tab, focus loss, unusable operational layout, missing display acknowledgment or loss of a required path revokes motion/pauses. Returning or reconnecting does not Resume.

Every recovery occurrence has a unique `failure_id`, nullable owning session, typed cause, `observed_at_ms`, `restored` and `acknowledged`. Repeated observations of the same outstanding occurrence retain its ID; a new failure after restoration gets a new ID. Resume checks all current occurrences, readiness and pending review. Explicit acknowledgment + restoration + Resume + neutral/reapply are required. Exact failure cause enum and fields for its ownership/cause are TBD.

### 8.3 Binary frame v1

Each frame is **one binary WebSocket message**:

```text
[4 bytes: unsigned big-endian metadata byte count N]
[N bytes: UTF-8 JSON metadata]
[remaining bytes: JPEG image]
```

Metadata known fields are in `FrameMetadataKnownFields`. Robot frames additionally require source capture timestamp/clock epoch. Source timestamps use integer monotonic microseconds; backend receive time is UTC milliseconds. Preserve source epoch/sequence through AI/evidence. Exact source-field spellings and clock-age exchange encoding are TBD/T6. Validate lengths, version, metadata and decoded dimensions before use; negotiate/enforce maximum header/frame/image dimensions before allocation/decode at T6. JSON duplicate-key/nonfinite-number/unknown-field policy also needs freezing.

Fresh captures of a static scene are valid; repeated acquisition metadata, unbounded age uncertainty or stalled display are not live. New camera epochs invalidate timing estimates and require recovery. Show “Not live” on stale video, even if the last image remains displayed. Review shows “Captured evidence”; boxes remain tied to their own detection frame. Proximity measurements never certify a clear path merely because a frame is available.

## 9. Errors and HTTP outcomes

TRD 9.1–9.2 specifies the `Error` shape and these HTTP classes. Exact machine-readable `code` strings are **TBD**; the categories below are descriptive, not invented approved code literals. Always use a safe explanatory message and `retryable`; optional revision/current snapshot aids reconciliation. Do not expose tracebacks, secrets, object-name dumps or absolute paths. Generic errors must not hide an existing stop latch.

| HTTP status | Required category / examples | Recovery contract |
| --- | --- | --- |
| `400` / `422` | Invalid input: malformed payload, unknown action, invalid ROI/image/name, retention range, route/body mismatch; exact split TBD. Proposed invalid cursor belongs here. | Correct input. No partial registration/decision. Exact field-level validation detail shape TBD. |
| `403` | Local request protection or lease rejection: foreign origin/Host, missing/invalid capability, absent/expired ordinary control lease, healthy-owner takeover attempt. Exact category-to-status details TBD. | Valid bootstrap/lease acquisition as applicable; never automatically resume. Emergency revocation remains lease-independent. |
| `409` | Revision/state/action-ID conflict; active-session uniqueness, locked mode/target, terminal conflict, pending review, stale preview, wrong candidate/failure ownership where represented as state conflict. | Read authoritative state, resolve cause and use a new action ID only for genuinely new work. Do not change an existing retry fingerprint. Ownership-specific status split TBD. |
| `404` / `410` | Missing/expired object, session or media; after expiry do not recreate by retry. Exact distinction/duration of expiry knowledge TBD. | Refresh UI and clear inaccessible evidence. No guaranteed permanent tombstone is implied. |
| `503` | Required service/readiness/storage unavailable, incomplete startup/reconciliation or unhealthy persistence. Exact service/readiness split TBD. | Restore/repair and retry deliberately while stopped. Honor recovery latches and existing committed facts. |

Success codes for creation, commands, previews, reads and emergency pending persistence have not been selected. Unsupported media/body-size status mapping, unexpected-server-error handling, WebSocket rejection/close codes and retry timing/headers are also TBD. Do not silently replace structured errors with FastAPI's default validation response. Error `retryable` is contextual and never authorizes replaying motion, bypassing review or clearing a failure.

Illustrative revision-conflict response body (HTTP `409`):

```json
{"code":"<TBD_REVISION_CONFLICT_CODE>","message":"The session changed. Refresh its state before submitting a new action.","retryable":false,"revision":6}
```

Illustrative unavailable-storage response body (HTTP `503`):

```json
{"code":"<TBD_STORAGE_UNAVAILABLE_CODE>","message":"Saving is unavailable. Movement remains stopped while storage is restored.","retryable":true}
```

An identical committed action-ID retry is resolved before stale-revision rejection; it is not the conflict shown above. An emergency-stop response must distinguish immediate revocation from any still-pending/failed persistence once that response shape is defined.

## 10. Device and worker contracts outside the public API

The browser API has no direct movement-direction endpoint and no external-cloud integration. Backend adapters observe selected input, AI, camera and firmware; the coordinator decides eligibility. The Uno independently expires movement commands. HTTP success, a warning state or a healthy WebSocket is not proof of wheel stopping.

| Boundary | Required interface facts | Deferred decision |
| --- | --- | --- |
| HC-05 / Uno | Versioned bounded serial framing; boot/control generation, increasing sequence, direction, device-issued expiring challenge; integrity/range checks and independent expiry. Stop invalidates armed generation; queued/replayed movement cannot rearm. | T2 identity/build compatibility; T6 encoding/rate/packet limits, acknowledgment, watchdog/challenge durations, logical output/PWM configuration. |
| ESP32-CAM | Acquisition epoch/sequence/timestamp, bounded frames and clock-age exchange; independent from command path. | T2 endpoint/protocol compatibility; T6 exact firmware envelope and clock uncertainty. |
| HC-SR04 | Distance units/range, validity/sample identity/freshness; invalid/stale/missing means unknown. Advisory only. | T2 observation endpoint/version; T4 calibrated warning/clear distances and consistency condition; T6 telemetry schema. |
| Webcam / PS4 | Backend-owned selected device/profile, generation and sample freshness; gesture orientation and held D-pad mapping per AD-10. Circle emergency stop; inactive mode cannot command. | T4 qualified mapping/recognition thresholds; T6 timing. |
| AI worker | Separate process; tagged session/generation/frame observations, bounded latest-frame queues; no record or motor authority. | T5 model/threshold/continuity contract; T6 exact IPC schemas and limits. |

These require separate versioned interface definitions; this document does not fabricate packet bytes or thresholds. Independent implementation may use labeled fixtures while gates are open. External SM-2 remains actual event-to-wheel-stop ≤0.5 seconds including detection and mechanics; software traces alone cannot close it. The SM-3 twenty-minute software stability run does not prove battery endurance. Do not derive individual heartbeat/watchdog timers by assigning each the full 0.5-second allowance.

## 11. Requirement coverage

| PRD requirement | API / schema coverage |
| --- | --- |
| FR-1, FR-2 | Registration, validated reference/ROI, Start ownership/revision and one-active-session guard. |
| FR-3–FR-5 | Snapshot/readiness, backend video/webcam channels, locked mode, workspace heartbeat and fresh selected input. |
| FR-6, FR-7, FR-17 | Lease-independent protected emergency stop, failure occurrences, acknowledgment/Resume and neutral/reapply gates. |
| FR-8 | Start and Pause/Resume/Stop; no automatic duration limit; Ended cannot Resume. |
| FR-9–FR-12 | Candidate events/evidence, typed confirm/reject, atomic human confirmation and continuity-based suppression. |
| FR-13, FR-14 | Local feed/detail, proposed session/match lists, media and independent new registration for Found belongings. |
| FR-15 | Retention preview/commit, expiry/grace filtering, startup/runtime purge and client evidence clearing. |
| FR-16 | No login/accounts, loopback Host/Origin/capability protection and shared Windows-account data. |
| FR-18 | Advisory-only proximity event; invalid readings unknown; calibrated thresholds remain open. |
| NFR-1–NFR-6 / SM metrics | Offline local service boundary; versioned interfaces and qualification gates remain separate from API conformance or physical performance. |

## 12. Missing decisions and implementation blockers

“Blocked” below applies to freezing/implementing the affected wire contract, not to all independent software development. Proposals in section 6 must be accepted or revised explicitly. Do not invent routes, fields, error codes or timing values to fill this register.

| ID | Missing decision | Affected work / owner |
| --- | --- | --- |
| API-01 | Exact local ports/frontend origin, missing-Origin/non-browser policy, preflight rules and health protection exemption. | Launcher/API security; software team, deployment and T1/T3. |
| API-02 | Bootstrap capability key/envelope; ticket request field/channel literals, ticket response, subprotocol encoding, lifetime/consumption errors and client lifetime. | Browser/launcher/socket interoperability; API/security team with T6. |
| API-03 | Registration multipart image part name, ROI encoding, non-image limits, name/string bounds/normalization, strict unknown fields and content-type/error handling. | Upload/client validation; frontend/backend team under AD-11. |
| API-04 | Exact response envelopes/projections and required list/detail fields, reference/evidence associations, health/snapshot/preview layouts; success status codes and pending/completion representation. | OpenAPI generation and frontend type sharing; backend/frontend team. |
| API-05 | Cursor encoding/lifetime, ID collation, limits, descending direction, filters/envelope, consistency/stale behavior; approval of proposed history routes. | Feed/history retrieval; Alisa/API team. Cursor approach selected, section 6 details proposed. |
| API-06 | Generation types/ranges, lease-state representation, acquire/release response/body, runtime retry fingerprint/lifetime, no-frame heartbeat state, re-acquisition snapshot layout and initial lease/video readiness sequence. | Control/event interoperability; backend/frontend team and T6. No default timer selected. |
| API-07 | Preview payload and ID/revision binding, impact fields/lifetime, confirmation semantics if time advances/records change, retry policy and any required lease on non-control writes. | Retention/settings workflow; backend/frontend team under AD-9. |
| API-08 | Full pause/end/failure cause vocabularies, per-action repeat/invalid-field semantics, empty/duplicate failure-ID policy and candidate box rounding. | Domain schemas/actions; backend/vision team. `Interrupted` and approved state enums are already fixed. |
| API-09 | Exact machine-readable error codes, 400/422 and 404/410 split, ownership/status mapping, field-error shape, body-size/content-type/server errors, retry headers and socket close codes. | Error contract; API team. Section 9 classes are already required. |
| API-10 | Exact typed payload for each of the nine event types; client heartbeat/ack discriminator/keys; event buffering/resync, revision advancement rules, stale boot handling and complete snapshot schema. | Shared event types before separate frontend/backend work; API team with T6. |
| API-11 | Robot timestamp/clock-epoch keys, frame/header/dimension bounds, age representation, clock-age exchange, heartbeat/display deadlines and queue policies. | Freshness/security/interoperability; firmware/API team, T2/T6. |
| API-12 | Emergency-stop request/runtime retry envelope and immediate-revocation versus pending/failed persistence result. Ordinary lease/revision prerequisites cannot be added. | Safety API and UI; backend/frontend team under AD-5/AD-6. |
| API-13 | Saved screenshot format/media projection, unavailable-media details, JSON cache rules, range policy and exact decoded-image pixel/format boundary rules. | Evidence delivery/retention; backend/frontend team. Protected/no-store managed media and adopted image limits remain binding. |
| API-14 | API compatibility/deprecation policy, counter bounds, action fingerprint canonicalization, original-result representation and durable retry behavior when pending versus committed. | Versioning and generated contract; backend team under AD-7/AD-13. |
| T1–T7 | Exact dependencies/assets; device interface compatibility; real environment/route; input/proximity calibration; AI settings/continuity; firmware/timing; final visual/assessment evidence. | Owners and exit evidence in TRD 13. This API document closes none of those qualification gates. |

Resolve these in the owning approved document or an explicitly approved contract revision, then freeze FastAPI OpenAPI and versioned event/frame schemas and generate frontend types. Validate conformance against those definitions. A conforming implementation must still pass retention, concurrency, evidence/retry, origin/capability/lease and failure-recovery checks; documentation alone is not acceptance evidence.
