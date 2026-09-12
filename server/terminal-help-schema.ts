export const TERMINAL_HELP_SCHEMA_V26_SQL = `
CREATE TABLE terminal_help_requests (
  terminal_id TEXT NOT NULL REFERENCES machine_terminals(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  code TEXT NOT NULL,
  scope TEXT NOT NULL,
  outcome TEXT NOT NULL,
  log_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('OPEN','RESOLVED')),
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY(terminal_id,event_id)
);
CREATE INDEX terminal_help_active ON terminal_help_requests(terminal_id,status);
`;

export const TERMINAL_REPORT_MIGRATION_SQL = `
ALTER TABLE terminal_help_requests ADD COLUMN severity TEXT NOT NULL DEFAULT 'GENERAL' CHECK(severity IN ('GENERAL','URGENT'));
ALTER TABLE terminal_help_requests ADD COLUMN resolved_at TEXT;
ALTER TABLE terminal_help_requests ADD COLUMN resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE terminal_help_requests ADD COLUMN resolution_source TEXT CHECK(resolution_source IN ('MACHINE','ADMIN'));
UPDATE terminal_help_requests SET severity='URGENT' WHERE outcome='RECOVERY_REQUIRED';
UPDATE terminal_help_requests SET resolved_at=updated_at,resolution_source='MACHINE' WHERE status='RESOLVED';
`;
export const TERMINAL_HELP_SCHEMA_SQL = TERMINAL_HELP_SCHEMA_V26_SQL + TERMINAL_REPORT_MIGRATION_SQL;
