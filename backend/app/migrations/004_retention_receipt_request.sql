ALTER TABLE action_receipts ADD COLUMN canonical_request TEXT
    CHECK (canonical_request IS NULL OR (json_valid(canonical_request) AND json_type(canonical_request) = 'object'));
