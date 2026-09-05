export const REPORT_SCHEMA_SQL = `
CREATE TABLE report_versions (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE report_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  active_version TEXT NOT NULL REFERENCES report_versions(id),
  earliest_date TEXT NOT NULL
);
CREATE TABLE report_days (
  version_id TEXT NOT NULL REFERENCES report_versions(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  PRIMARY KEY(version_id, day)
);
CREATE TABLE report_group_days (
  version_id TEXT NOT NULL,
  day TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  reserved_ms REAL NOT NULL,
  available_ms REAL NOT NULL,
  PRIMARY KEY(version_id, day, group_id),
  FOREIGN KEY(version_id, day) REFERENCES report_days(version_id, day) ON DELETE CASCADE
);
CREATE INDEX report_group_machine_idx ON report_group_days(version_id, machine_id, day);
CREATE TABLE report_reservation_days (
  version_id TEXT NOT NULL,
  day TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reserved_ms REAL NOT NULL,
  PRIMARY KEY(version_id, day, reservation_id),
  FOREIGN KEY(version_id, day) REFERENCES report_days(version_id, day) ON DELETE CASCADE
);
CREATE INDEX report_reservation_machine_idx ON report_reservation_days(version_id, machine_id, day);
CREATE TABLE report_jobs (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  completed_days INTEGER NOT NULL DEFAULT 0,
  total_days INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE UNIQUE INDEX report_one_running_job ON report_jobs((1)) WHERE status IN ('QUEUED','RUNNING');
`;
