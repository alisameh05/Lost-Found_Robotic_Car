CREATE UNIQUE INDEX one_confirmed_session_per_object ON sessions (object_id) WHERE end_reason = 'Confirmed';
CREATE UNIQUE INDEX one_confirmed_match_per_object ON match_events (object_id) WHERE disposition = 'Confirmed';

CREATE TRIGGER session_within_object_history BEFORE INSERT ON sessions
WHEN NOT EXISTS (
    SELECT 1 FROM objects
    WHERE id = NEW.object_id AND NEW.started_at_ms >= registered_at_ms
      AND (found_at_ms IS NULL OR NEW.started_at_ms <= found_at_ms)
)
BEGIN
    SELECT RAISE(ABORT, 'session start is outside the object history');
END;

CREATE TRIGGER preserve_session_outcome BEFORE UPDATE OF ended_at_ms, end_reason ON sessions
WHEN OLD.state = 'Ended' AND (NEW.ended_at_ms IS NOT OLD.ended_at_ms OR NEW.end_reason IS NOT OLD.end_reason)
BEGIN
    SELECT RAISE(ABORT, 'ended session outcome is immutable');
END;

CREATE TRIGGER session_state_respects_matches BEFORE UPDATE OF state, ended_at_ms ON sessions
WHEN EXISTS (
    SELECT 1 FROM match_events WHERE session_id = OLD.id
      AND ((NEW.state <> 'Paused' AND disposition = 'Pending')
           OR (NEW.state = 'Ended' AND COALESCE(reviewed_at_ms, captured_at_ms) > NEW.ended_at_ms)
           OR (NEW.state = 'Ended' AND NEW.end_reason <> 'Confirmed' AND disposition = 'Confirmed'))
)
BEGIN
    SELECT RAISE(ABORT, 'session state or end time conflicts with recorded matches');
END;

CREATE TRIGGER match_within_session BEFORE INSERT ON match_events
WHEN NOT EXISTS (
    SELECT 1 FROM sessions
    WHERE id = NEW.session_id AND object_id = NEW.object_id AND NEW.captured_at_ms >= started_at_ms
      AND (ended_at_ms IS NULL OR COALESCE(NEW.reviewed_at_ms, NEW.captured_at_ms) <= ended_at_ms)
      AND (NEW.disposition <> 'Pending' OR state = 'Paused')
      AND (NEW.disposition <> 'Confirmed' OR state <> 'Ended' OR end_reason = 'Confirmed')
)
BEGIN
    SELECT RAISE(ABORT, 'match is outside its session');
END;

CREATE TRIGGER preserve_review BEFORE UPDATE OF disposition, reviewed_at_ms ON match_events
WHEN (OLD.disposition <> 'Pending' AND (NEW.disposition <> OLD.disposition OR NEW.reviewed_at_ms IS NOT OLD.reviewed_at_ms))
   OR EXISTS (
        SELECT 1 FROM sessions WHERE id = NEW.session_id AND state = 'Ended'
          AND (NEW.reviewed_at_ms > ended_at_ms OR (NEW.disposition = 'Confirmed' AND end_reason <> 'Confirmed'))
   )
BEGIN
    SELECT RAISE(ABORT, 'review is immutable and must occur within its session');
END;

CREATE TRIGGER preserve_ready_evidence BEFORE UPDATE ON media
WHEN OLD.role = 'Evidence' AND OLD.lifecycle = 'Ready'
BEGIN
    SELECT RAISE(ABORT, 'ready evidence metadata is immutable');
END;

CREATE TRIGGER preserve_found_time BEFORE UPDATE OF found_at_ms ON objects
WHEN OLD.status = 'Found' AND NEW.found_at_ms IS NOT OLD.found_at_ms
BEGIN
    SELECT RAISE(ABORT, 'confirmation time is immutable');
END;
