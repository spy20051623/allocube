export const SSH_KEY_SCHEMA_SQL = `
CREATE TABLE user_ssh_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, fingerprint)
);
CREATE INDEX user_ssh_keys_user ON user_ssh_keys(user_id);
`;

export const SSH_KEY_ACTIVATION_SCHEMA_SQL = `
CREATE UNIQUE INDEX user_ssh_keys_identity ON user_ssh_keys(id,user_id);
CREATE TABLE machine_ssh_keys (
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(machine_id,key_id),
  FOREIGN KEY(key_id,user_id) REFERENCES user_ssh_keys(id,user_id) ON DELETE CASCADE
);
CREATE INDEX machine_ssh_keys_user ON machine_ssh_keys(user_id,machine_id);
CREATE TABLE ssh_key_challenges (
  challenge_id TEXT PRIMARY KEY REFERENCES email_verification_challenges(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  operation_hash TEXT NOT NULL,
  credential_stamp TEXT NOT NULL
);
`;
