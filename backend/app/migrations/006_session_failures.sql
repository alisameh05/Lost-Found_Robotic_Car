ALTER TABLE session_emergencies RENAME TO session_failures;
ALTER TABLE session_failures ADD COLUMN cause TEXT NOT NULL DEFAULT 'EmergencyStop' CHECK (
    cause IN ('EmergencyStop', 'WorkspaceDisconnected', 'WorkspaceHidden', 'WorkspaceUnfocused',
        'WorkspaceUnusable', 'HeartbeatExpired', 'DisplayStale', 'RobotVideoUnavailable', 'CameraEpochChanged',
        'CommandUnavailable', 'CommandExpired', 'InputUnavailable', 'AIUnavailable', 'StorageFault', 'ProtocolMismatch')
);
ALTER TABLE session_failures ADD COLUMN restored INTEGER NOT NULL DEFAULT 0 CHECK (restored IN (0, 1));
ALTER TABLE session_failures ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1));
