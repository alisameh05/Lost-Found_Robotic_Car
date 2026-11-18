CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version >= 1),
    applied_at_ms INTEGER NOT NULL CHECK (applied_at_ms BETWEEN 0 AND 9007199254740991),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TABLE app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 30),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TRIGGER retain_settings BEFORE DELETE ON app_settings
BEGIN
    SELECT RAISE(ABORT, 'settings singleton is required');
END;

CREATE TABLE objects (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    name TEXT NOT NULL CHECK (
        length(name) BETWEEN 1 AND 120
        AND length(trim(name, char(9,10,11,12,13,32,133,160,5760,8192,8193,8194,8195,8196,8197,
            8198,8199,8200,8201,8202,8232,8233,8239,8287,12288))) > 0
    ),
    status TEXT NOT NULL CHECK (status IN ('Lost', 'Found')),
    registered_at_ms INTEGER NOT NULL CHECK (registered_at_ms BETWEEN 0 AND 9007199254740991),
    found_at_ms INTEGER CHECK (found_at_ms BETWEEN registered_at_ms AND 9007199254740991),
    roi_x INTEGER NOT NULL CHECK (roi_x >= 0),
    roi_y INTEGER NOT NULL CHECK (roi_y >= 0),
    roi_width INTEGER NOT NULL CHECK (roi_width > 0 AND roi_width <= reference_width - roi_x),
    roi_height INTEGER NOT NULL CHECK (roi_height > 0 AND roi_height <= reference_height - roi_y),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    deletion_pending INTEGER NOT NULL DEFAULT 0 CHECK (deletion_pending IN (0, 1)),
    reference_media_id TEXT NOT NULL,
    reference_width INTEGER NOT NULL,
    reference_height INTEGER NOT NULL,
    reference_role TEXT GENERATED ALWAYS AS ('Reference') VIRTUAL,
    reference_lifecycle TEXT GENERATED ALWAYS AS ('Ready') VIRTUAL,
    CHECK ((status = 'Found') = (found_at_ms IS NOT NULL)),
    FOREIGN KEY (reference_media_id, id, reference_role, reference_lifecycle, reference_width, reference_height)
        REFERENCES media (id, object_id, role, lifecycle, width, height) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE INDEX objects_by_registration ON objects (registered_at_ms DESC, id DESC);
CREATE INDEX objects_by_status ON objects (status, registered_at_ms DESC, id DESC);

CREATE TRIGGER preserve_registration BEFORE UPDATE ON objects
WHEN NEW.registered_at_ms <> OLD.registered_at_ms OR (OLD.status = 'Found' AND NEW.status <> 'Found')
BEGIN
    SELECT RAISE(ABORT, 'registration time and Found status are immutable');
END;

CREATE TABLE sessions (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    object_id TEXT NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    control_mode TEXT NOT NULL CHECK (control_mode IN ('Gestures', 'Controller')),
    state TEXT NOT NULL CHECK (state IN ('Searching', 'Paused', 'Ended')),
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms BETWEEN 0 AND 9007199254740991),
    ended_at_ms INTEGER CHECK (ended_at_ms BETWEEN started_at_ms AND 9007199254740991),
    end_reason TEXT CHECK (end_reason IN ('Confirmed', 'Stopped', 'Interrupted')),
    pause_causes TEXT NOT NULL DEFAULT '[]' CHECK (
        json_valid(pause_causes) AND json_type(pause_causes) = 'array'
        AND ((state = 'Paused') = (json_array_length(pause_causes) > 0))
    ),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
    CHECK ((state = 'Ended') = (ended_at_ms IS NOT NULL) AND (state = 'Ended') = (end_reason IS NOT NULL)),
    UNIQUE (id, object_id)
) STRICT;

CREATE UNIQUE INDEX one_active_session ON sessions ((1)) WHERE state IN ('Searching', 'Paused');
CREATE INDEX sessions_by_owner ON sessions (object_id, started_at_ms DESC, id DESC);

CREATE VIEW invalid_session_pause_causes AS
WITH causes AS (
    SELECT sessions.id, CASE entry.type WHEN 'object' THEN entry.value ELSE '{}' END AS item
    FROM sessions, json_each(sessions.pause_causes) AS entry
)
SELECT id FROM causes
WHERE json_type(item, '$.cause') IS NOT 'text'
   OR json_extract(item, '$.cause') NOT IN ('ManualPause', 'CandidateReview', 'ReviewRejected', 'RecoveryRequired')
   OR (SELECT COUNT(*) FROM json_each(item)) <> 2
   OR CASE json_extract(item, '$.cause')
        WHEN 'RecoveryRequired' THEN json_type(item, '$.failure_id') IS NOT 'text'
            OR length(json_extract(item, '$.failure_id')) NOT BETWEEN 1 AND 128
            OR json_extract(item, '$.failure_id') GLOB '*[^A-Za-z0-9_-]*'
        ELSE json_type(item, '$.failure_id') IS NOT 'null'
      END
UNION
SELECT id FROM causes
GROUP BY id, json_extract(item, '$.cause'), json_extract(item, '$.failure_id')
HAVING COUNT(*) > 1;

CREATE TRIGGER validate_new_pause_causes AFTER INSERT ON sessions
WHEN EXISTS (SELECT 1 FROM invalid_session_pause_causes WHERE id = NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'invalid pause causes');
END;

CREATE TRIGGER validate_changed_pause_causes AFTER UPDATE OF pause_causes ON sessions
WHEN EXISTS (SELECT 1 FROM invalid_session_pause_causes WHERE id = NEW.id)
BEGIN
    SELECT RAISE(ABORT, 'invalid pause causes');
END;

CREATE TRIGGER active_session_requires_lost_object BEFORE INSERT ON sessions
WHEN NEW.state <> 'Ended' AND NOT EXISTS (
    SELECT 1 FROM objects WHERE id = NEW.object_id AND status = 'Lost' AND deletion_pending = 0
)
BEGIN
    SELECT RAISE(ABORT, 'an active session requires a Lost object');
END;

CREATE TRIGGER preserve_session_identity BEFORE UPDATE ON sessions
WHEN NEW.object_id <> OLD.object_id OR NEW.control_mode <> OLD.control_mode
    OR NEW.started_at_ms <> OLD.started_at_ms OR (OLD.state = 'Ended' AND NEW.state <> 'Ended')
BEGIN
    SELECT RAISE(ABORT, 'session identity and terminal state are immutable');
END;

CREATE TABLE match_events (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    session_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL CHECK (captured_at_ms BETWEEN 0 AND 9007199254740991),
    frame_id TEXT NOT NULL CHECK (length(frame_id) BETWEEN 1 AND 128 AND frame_id NOT GLOB '*[^A-Za-z0-9_-]*'),
    stream_epoch TEXT NOT NULL CHECK (length(stream_epoch) BETWEEN 1 AND 128 AND stream_epoch NOT GLOB '*[^A-Za-z0-9_-]*'),
    box_x INTEGER NOT NULL CHECK (box_x >= 0),
    box_y INTEGER NOT NULL CHECK (box_y >= 0),
    box_width INTEGER NOT NULL CHECK (box_width > 0 AND box_width <= evidence_width - box_x),
    box_height INTEGER NOT NULL CHECK (box_height > 0 AND box_height <= evidence_height - box_y),
    disposition TEXT NOT NULL CHECK (disposition IN ('Pending', 'Confirmed', 'Rejected', 'NotReviewed')),
    reviewed_at_ms INTEGER CHECK (reviewed_at_ms BETWEEN captured_at_ms AND 9007199254740991),
    evidence_media_id TEXT NOT NULL,
    evidence_width INTEGER NOT NULL,
    evidence_height INTEGER NOT NULL,
    evidence_role TEXT GENERATED ALWAYS AS ('Evidence') VIRTUAL,
    evidence_lifecycle TEXT GENERATED ALWAYS AS ('Ready') VIRTUAL,
    CHECK ((disposition IN ('Confirmed', 'Rejected')) = (reviewed_at_ms IS NOT NULL)),
    UNIQUE (id, object_id),
    FOREIGN KEY (session_id, object_id) REFERENCES sessions (id, object_id) ON DELETE CASCADE,
    FOREIGN KEY (
        evidence_media_id, object_id, id, evidence_role, evidence_lifecycle, evidence_width, evidence_height
    ) REFERENCES media (id, object_id, match_event_id, role, lifecycle, width, height) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE UNIQUE INDEX one_pending_candidate ON match_events (session_id) WHERE disposition = 'Pending';
CREATE INDEX matches_by_session ON match_events (session_id, captured_at_ms DESC, id DESC);

CREATE TRIGGER preserve_capture BEFORE UPDATE ON match_events
WHEN NEW.session_id <> OLD.session_id OR NEW.object_id <> OLD.object_id
    OR NEW.captured_at_ms <> OLD.captured_at_ms OR NEW.frame_id <> OLD.frame_id OR NEW.stream_epoch <> OLD.stream_epoch
    OR NEW.box_x <> OLD.box_x OR NEW.box_y <> OLD.box_y OR NEW.box_width <> OLD.box_width OR NEW.box_height <> OLD.box_height
    OR NEW.evidence_media_id <> OLD.evidence_media_id
    OR NEW.evidence_width <> OLD.evidence_width OR NEW.evidence_height <> OLD.evidence_height
BEGIN
    SELECT RAISE(ABORT, 'captured evidence is immutable');
END;

CREATE TABLE media (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    object_id TEXT NOT NULL REFERENCES objects (id) ON DELETE CASCADE,
    match_event_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('Reference', 'Evidence')),
    relative_path TEXT NOT NULL UNIQUE,
    format TEXT NOT NULL CHECK (format IN ('image/jpeg', 'image/png')),
    width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 9007199254740991),
    height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 9007199254740991),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 9007199254740991),
    checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('Staging', 'Ready')),
    CHECK ((role = 'Evidence') = (match_event_id IS NOT NULL)),
    CHECK (role <> 'Evidence' OR format = 'image/png'),
    CHECK (relative_path = 'media/' || id || CASE format WHEN 'image/jpeg' THEN '.jpg' ELSE '.png' END),
    UNIQUE (id, object_id, role, lifecycle, width, height),
    UNIQUE (id, object_id, match_event_id, role, lifecycle, width, height),
    FOREIGN KEY (match_event_id, object_id) REFERENCES match_events (id, object_id) ON DELETE CASCADE
) STRICT;

CREATE UNIQUE INDEX one_reference ON media (object_id) WHERE role = 'Reference';
CREATE UNIQUE INDEX one_evidence ON media (match_event_id) WHERE role = 'Evidence';

CREATE TABLE action_receipts (
    action_id TEXT PRIMARY KEY CHECK (
        length(action_id) = 36 AND lower(action_id) = action_id
        AND substr(action_id, 9, 1) = '-' AND substr(action_id, 14, 2) = '-4'
        AND substr(action_id, 19, 1) = '-' AND substr(action_id, 20, 1) IN ('8','9','a','b')
        AND substr(action_id, 24, 1) = '-' AND length(replace(action_id, '-', '')) = 32
        AND replace(action_id, '-', '') NOT GLOB '*[^0-9a-f]*'
    ),
    scope TEXT NOT NULL CHECK (scope IN ('Object', 'Settings')),
    object_id TEXT REFERENCES objects (id) ON DELETE CASCADE,
    settings_id INTEGER REFERENCES app_settings (id),
    session_id TEXT,
    action_type TEXT NOT NULL CHECK (
        action_type IN ('register', 'start', 'pause', 'resume', 'stop', 'acknowledge', 'confirm', 'reject', 'retention')
    ),
    request_fingerprint TEXT NOT NULL CHECK (
        length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
    ),
    result_revision INTEGER NOT NULL CHECK (result_revision BETWEEN 1 AND 9007199254740991),
    committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms BETWEEN 0 AND 9007199254740991),
    response_status INTEGER NOT NULL CHECK (response_status IN (200, 201)),
    response_body TEXT NOT NULL CHECK (json_valid(response_body) AND json_type(response_body) = 'object'),
    response_location TEXT,
    CHECK ((response_status = 201) = (response_location IS NOT NULL)),
    CHECK (
        (scope = 'Object' AND object_id IS NOT NULL AND settings_id IS NULL AND action_type <> 'retention')
        OR (scope = 'Settings' AND settings_id = 1 AND settings_id IS NOT NULL AND object_id IS NULL
            AND session_id IS NULL AND action_type = 'retention')
    ),
    FOREIGN KEY (session_id, object_id) REFERENCES sessions (id, object_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE storage_operations (
    id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'),
    kind TEXT NOT NULL CHECK (kind IN ('Prepare', 'Purge')),
    owner_object_id TEXT CHECK (
        length(owner_object_id) BETWEEN 1 AND 128 AND owner_object_id NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    generated_paths TEXT NOT NULL CHECK (json_valid(generated_paths) AND json_type(generated_paths) = 'array'),
    phase TEXT NOT NULL CHECK (phase IN ('Pending', 'Failed')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
    last_error_code TEXT CHECK (last_error_code IN ('STORAGE_UNAVAILABLE', 'MEDIA_UNAVAILABLE', 'INTERNAL_ERROR')),
    CHECK ((phase = 'Failed') = (last_error_code IS NOT NULL))
) STRICT;

INSERT INTO app_settings (id, retention_days, revision, updated_at_ms)
VALUES (1, 7, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER));
