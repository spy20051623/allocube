export const MACHINE_ACCESS_EXPIRY_MIGRATION_SQL = `
ALTER TABLE machine_access_memberships ADD COLUMN expires_at TEXT;
ALTER TABLE machine_access_memberships ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE machine_access_requests ADD COLUMN expires_at TEXT;
UPDATE machine_access_requests SET expires_at = strftime('%Y-%m-%dT%H:%M:00.000Z', 'now', '+8 hours', '+31 days', 'start of day', '-8 hours') WHERE status = 'PENDING';
`;

export const MACHINE_ACCESS_EXPIRY_INDEX_SQL = `
CREATE INDEX machine_membership_expiry ON machine_access_memberships(expires_at);
CREATE INDEX machine_request_expiry ON machine_access_requests(expires_at) WHERE status = 'PENDING';
CREATE TRIGGER machine_manager_permanent AFTER INSERT ON machine_admins
BEGIN
  UPDATE machine_access_memberships SET expires_at=NULL, version=version+1 WHERE machine_id=NEW.machine_id AND user_id=NEW.user_id;
END;
CREATE TRIGGER machine_manager_expiry_guard BEFORE UPDATE OF expires_at ON machine_access_memberships
WHEN NEW.expires_at IS NOT NULL AND EXISTS(SELECT 1 FROM machine_admins WHERE machine_id=NEW.machine_id AND user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Machine administrators must have permanent access'); END;
CREATE TRIGGER terminal_invalidate_membership_expiry AFTER UPDATE OF expires_at ON machine_access_memberships
WHEN OLD.expires_at IS NOT NEW.expires_at
BEGIN DELETE FROM terminal_authorizations WHERE user_id=NEW.user_id
  AND terminal_id IN(SELECT id FROM machine_terminals WHERE machine_id=NEW.machine_id); END;
`;
