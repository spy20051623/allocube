import { db, nowIso } from "../db.js";
import { revokeApiTokensForUser } from "../api-tokens.js";
import { countRows } from "./records.js";

type ManageableUserRow = {
  id: string;
  display_name: string;
  status: string;
  role: string;
  version: number;
  updated_at: string;
  disabled_at: string | null;
  disable_reason: string;
};

export function getManageableUser(userId: string) {
  return db
    .prepare(
      `SELECT u.id, u.display_name, u.status, u.role, u.version,
        u.updated_at, u.disabled_at, u.disable_reason
       FROM users u
       WHERE u.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )`
    )
    .get(userId) as ManageableUserRow | undefined;
}

export function mapManageableUser(user: ManageableUserRow) {
  return {
    id: user.id,
    displayName: user.display_name,
    status: user.status,
    version: user.version,
    updatedAt: user.updated_at,
    disabledAt: user.disabled_at,
    disableReason: user.disable_reason
  };
}

export function userDisableImpact(userId: string, at = nowIso()) {
  return {
    activeReservations: countRows(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE user_id = ? AND status = 'CONFIRMED'
         AND start_at <= ? AND end_at > ?`,
      userId,
      at,
      at
    ),
    futureReservations: countRows(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE user_id = ? AND status = 'CONFIRMED' AND start_at > ?`,
      userId,
      at
    ),
    machineMemberships: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE user_id = ?",
      userId
    ),
    machineAdminRoles: countRows(
      "SELECT COUNT(*) AS count FROM machine_admins WHERE user_id = ?",
      userId
    ),
    pendingProfileChanges: countRows(
      `SELECT COUNT(*) AS count FROM profile_change_requests
       WHERE user_id = ? AND status = 'PENDING'`,
      userId
    )
  };
}

export function userDeleteImpact(userId: string) {
  return {
    machineMemberships: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE user_id = ?",
      userId
    ),
    machineAdminRoles: countRows(
      "SELECT COUNT(*) AS count FROM machine_admins WHERE user_id = ?",
      userId
    ),
    accessRequests: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_requests WHERE user_id = ?",
      userId
    ),
    reservations: countRows(
      "SELECT COUNT(*) AS count FROM reservations WHERE user_id = ?",
      userId
    ),
    notifications: countRows(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?",
      userId
    ),
    auditLogs: countRows(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE actor_user_id = ? OR (entity_type = 'user' AND entity_id = ?)`,
      userId,
      userId
    ),
    feedbackTickets: countRows(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE submitted_by = ?",
      userId
    ),
    feedbackActivities: countRows(
      "SELECT COUNT(*) AS count FROM feedback_activities WHERE actor_user_id = ?",
      userId
    )
  };
}

export function deleteUserRecords(
  userId: string,
  actorUserId: string,
  counts: ReturnType<typeof userDeleteImpact>
) {
  const now = nowIso();
  revokeApiTokensForUser(userId, "账号已删除", now);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_verification_challenges WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM username_history WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_history WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM employee_numbers WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM pending_registration_employee_numbers WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM registration_revisions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM profile_change_requests WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM machine_admins WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM machine_access_memberships WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM machine_access_requests WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_outbox WHERE user_id = ?").run(userId);
  db.prepare(
    "UPDATE feedback_tickets SET submitted_by_name = '用户已删除' WHERE submitted_by = ?"
  ).run(userId);
  db.prepare(
    "UPDATE feedback_activities SET actor_name = '用户已删除' WHERE actor_user_id = ?"
  ).run(userId);
  db.prepare(
    `UPDATE audit_logs
     SET before_json = NULL, after_json = NULL
     WHERE actor_user_id = ? OR (entity_type = 'user' AND entity_id = ?)`
  ).run(userId, userId);
  db.prepare(
    `UPDATE users
     SET username = ?, username_normalized = ?, email = NULL,
       display_name = '用户已删除', password_hash = ?,
       password_change_recommended = 0, username_changed_at = NULL,
       last_login_at = NULL, last_login_ip = '', auto_logout_minutes = 0,
       approved_at = NULL, approved_by = NULL,
       version = version + 1, disabled_at = NULL, disabled_by = NULL,
       disable_reason = '', updated_at = ?
     WHERE id = ?`
  ).run(
    `deleted-${userId}`,
    `deleted-${userId}`,
    `!deleted:${userId}`,
    now,
    userId
  );
  db.prepare(
    `INSERT INTO deleted_user_tombstones(
      user_id, deleted_at, deleted_by, cleanup_counts_json
    ) VALUES(?, ?, ?, ?)`
  ).run(userId, now, actorUserId, JSON.stringify(counts));
}
