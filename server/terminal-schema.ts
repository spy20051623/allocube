export const TERMINAL_SCHEMA_SQL = `
CREATE TABLE machine_terminals (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL UNIQUE REFERENCES machines(id) ON DELETE CASCADE,
  callback_url TEXT NOT NULL,
  public_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  certificate_expires_at TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE terminal_credentials (
  token_hash TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES machine_terminals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('ENROLL','MACHINE','REPLAY')),
  expires_at TEXT NOT NULL
);
CREATE INDEX terminal_credentials_expiry ON terminal_credentials(expires_at);
CREATE TABLE terminal_authorizations (
  id TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL REFERENCES machine_terminals(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  challenge TEXT NOT NULL,
  browser_hash TEXT,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  credential_stamp TEXT,
  email_challenge_id TEXT,
  phase TEXT NOT NULL DEFAULT 'PASSWORD' CHECK(phase IN ('PASSWORD','EMAIL','BIND_EMAIL','DENIED','CODE','GRANTED')),
  code_hash TEXT UNIQUE,
  code_expires_at TEXT,
  grant_hash TEXT UNIQUE,
  expires_at TEXT NOT NULL
);
CREATE INDEX terminal_authorizations_expiry ON terminal_authorizations(expires_at);
CREATE TABLE terminal_audit_receipts (
  terminal_id TEXT NOT NULL REFERENCES machine_terminals(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(terminal_id, operation_id)
);
CREATE TRIGGER terminal_invalidate_credentials AFTER UPDATE OF password_hash,email,status ON users
WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.email IS NOT NEW.email OR OLD.status IS NOT NEW.status
BEGIN DELETE FROM terminal_authorizations WHERE user_id=NEW.id; END;
CREATE TRIGGER terminal_invalidate_employee_update AFTER UPDATE ON employee_numbers
BEGIN DELETE FROM terminal_authorizations WHERE user_id=OLD.user_id OR user_id=NEW.user_id; END;
CREATE TRIGGER terminal_invalidate_employee_delete AFTER DELETE ON employee_numbers
BEGIN DELETE FROM terminal_authorizations WHERE user_id=OLD.user_id; END;
CREATE TRIGGER terminal_invalidate_employee_insert AFTER INSERT ON employee_numbers
BEGIN DELETE FROM terminal_authorizations WHERE user_id=NEW.user_id; END;
CREATE TRIGGER terminal_invalidate_membership AFTER DELETE ON machine_access_memberships
BEGIN DELETE FROM terminal_authorizations WHERE user_id=OLD.user_id
  AND terminal_id IN(SELECT id FROM machine_terminals WHERE machine_id=OLD.machine_id); END;
CREATE TRIGGER terminal_invalidate_email_policy AFTER UPDATE OF enabled ON smtp_settings
WHEN OLD.enabled IS NOT NEW.enabled
BEGIN DELETE FROM terminal_authorizations; END;
`;

export const TERMINAL_EMAIL_MIGRATION_SQL = `
ALTER TABLE email_verification_challenges RENAME TO email_verification_challenges_v22;
DROP INDEX email_challenge_lookup_idx;
CREATE TABLE email_verification_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  purpose TEXT NOT NULL CHECK(purpose IN ('REGISTER','EMAIL_CHANGE','EMAIL_OLD','TERMINAL')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  last_sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO email_verification_challenges SELECT * FROM email_verification_challenges_v22;
DROP TABLE email_verification_challenges_v22;
CREATE INDEX email_challenge_lookup_idx ON email_verification_challenges(email,purpose,created_at DESC);
`;
