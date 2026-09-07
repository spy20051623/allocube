export const AUDIT_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS audit_time_id_idx ON audit_logs(created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_actor_time_idx ON audit_logs(actor_user_id, created_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS audit_action_time_idx ON audit_logs(action, created_at DESC, id DESC);
`;
