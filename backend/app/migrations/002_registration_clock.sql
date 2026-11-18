CREATE TABLE registration_clock (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT;

INSERT INTO registration_clock VALUES (1, 0);
