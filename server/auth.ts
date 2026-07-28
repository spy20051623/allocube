import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db, nowIso } from "./db.js";
import type { AuthUser } from "../src/shared/types.js";
import {
  canAccessMachine as checkMachineAccess,
  getAccessibleMachineIds as accessibleMachineIds
} from "./machine-access.js";
export { checkPassword, hashPassword } from "./password-hashing.js";

export const SESSION_COOKIE = "resource_session";
const SESSION_DAYS = 7;
const MINUTE_IN_MS = 60_000;

export type UserRow = {
  id: string;
  username: string;
  email: string | null;
  display_name: string;
  password_hash: string;
  role: "SYSTEM_ADMIN" | "USER";
  status: AuthUser["status"];
  password_change_recommended: number;
  application_revision: number;
  username_changed_at: string | null;
  last_login_at: string | null;
  last_login_ip: string;
  auto_logout_minutes: AuthUser["autoLogoutMinutes"];
  email_reservation_updates: number;
  email_machine_access_updates: number;
  email_approval_updates: number;
  email_administration_updates: number;
  employee_number: string | null;
  pending_profile_change_id: string | null;
  pending_display_name: string | null;
  pending_employee_number: string | null;
  pending_profile_requested_at: string | null;
};

export function publicUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    employeeNumber: row.employee_number,
    role: row.role,
    status: row.status,
    passwordChangeRecommended: Boolean(row.password_change_recommended),
    lastLoginAt: row.last_login_at,
    lastLoginIp: row.last_login_ip,
    autoLogoutMinutes: row.auto_logout_minutes,
    emailPreferences: {
      reservationUpdates: Boolean(row.email_reservation_updates),
      machineAccessUpdates: Boolean(row.email_machine_access_updates),
      approvalUpdates: Boolean(row.email_approval_updates),
      administrationUpdates: Boolean(row.email_administration_updates)
    },
    pendingProfileChange:
      row.pending_profile_change_id &&
      row.pending_display_name &&
      row.pending_employee_number &&
      row.pending_profile_requested_at
        ? {
            id: row.pending_profile_change_id,
            displayName: row.pending_display_name,
            employeeNumber: row.pending_employee_number,
            requestedAt: row.pending_profile_requested_at
          }
        : null
  };
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export function createSession(userId: string, reply: FastifyReply) {
  const token = createOpaqueToken();
  const csrfToken = createOpaqueToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare(
    `INSERT INTO sessions(
      id, user_id, token_hash, csrf_token, expires_at, created_at, last_seen_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    userId,
    hashToken(token),
    csrfToken,
    expires.toISOString(),
    now.toISOString(),
    now.toISOString()
  );
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: reply.request.protocol === "https",
    sameSite: "lax",
    priority: "high",
    expires
  });
  return csrfToken;
}

export function destroySession(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    secure: request.protocol === "https",
    sameSite: "lax"
  });
}

const sessionUserSelect = `
  SELECT
    u.id, u.username, u.email, u.display_name, u.password_hash, u.role, u.status,
    u.password_change_recommended, u.application_revision, u.username_changed_at,
    u.last_login_at, u.last_login_ip, u.auto_logout_minutes,
    COALESCE((SELECT ep.reservation_updates FROM user_email_preferences ep
      WHERE ep.user_id = u.id), 1) AS email_reservation_updates,
    COALESCE((SELECT ep.machine_access_updates FROM user_email_preferences ep
      WHERE ep.user_id = u.id), 1) AS email_machine_access_updates,
    COALESCE((SELECT ep.approval_updates FROM user_email_preferences ep
      WHERE ep.user_id = u.id), 1) AS email_approval_updates,
    COALESCE((SELECT ep.administration_updates FROM user_email_preferences ep
      WHERE ep.user_id = u.id), 1) AS email_administration_updates,
    COALESCE(
      (SELECT en.employee_number FROM employee_numbers en
        WHERE en.user_id = u.id AND en.status = 'ACTIVE'
        LIMIT 1),
      (SELECT er.employee_number FROM pending_registration_employee_numbers er
        WHERE er.user_id = u.id
        LIMIT 1)
    ) AS employee_number,
    (SELECT pcr.id FROM profile_change_requests pcr
      WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
      LIMIT 1) AS pending_profile_change_id,
    (SELECT pcr.requested_display_name FROM profile_change_requests pcr
      WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
      LIMIT 1) AS pending_display_name,
    (SELECT pcr.requested_employee_number FROM profile_change_requests pcr
      WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
      LIMIT 1) AS pending_employee_number,
    (SELECT pcr.requested_at FROM profile_change_requests pcr
      WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
      LIMIT 1) AS pending_profile_requested_at,
    s.id AS session_id, s.csrf_token, s.expires_at, s.last_seen_at
  FROM sessions s
  JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = ?
    AND NOT EXISTS (
      SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
    )`;

export function getSessionAuth(request: FastifyRequest) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const row = db.prepare(sessionUserSelect).get(hashToken(token)) as
    | (UserRow & {
        session_id: string;
        csrf_token: string;
        expires_at: string;
        last_seen_at: string;
      })
    | undefined;
  const now = nowIso();
  const idleCutoff =
    row && row.auto_logout_minutes > 0
      ? new Date(
          Date.now() - row.auto_logout_minutes * MINUTE_IN_MS
        ).toISOString()
      : null;
  if (
    !row ||
    row.expires_at <= now ||
    row.status === "DISABLED" ||
    (idleCutoff !== null && row.last_seen_at <= idleCutoff)
  ) {
    if (row) db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }
  const refreshCutoff = new Date(Date.now() - MINUTE_IN_MS).toISOString();
  if (row.last_seen_at <= refreshCutoff) {
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(
      now,
      row.session_id
    );
  }
  return {
    user: publicUser(row),
    csrfToken: row.csrf_token,
    sessionId: row.session_id
  };
}

export function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const auth = getSessionAuth(request);
  if (!auth) {
    reply.code(401).send({ error: "请先登录" });
    return null;
  }
  return auth;
}

export function requireActiveUser(request: FastifyRequest, reply: FastifyReply) {
  const auth = requireSession(request, reply);
  if (!auth) return null;
  if (auth.user.status !== "ACTIVE") {
    reply.code(403).send({ error: "账号尚未启用，暂时不能访问此功能" });
    return null;
  }
  return auth;
}

// Existing business routes use requireAuth; keep it as the active-account guard.
export const requireAuth = requireActiveUser;

export function requireSystemAdmin(request: FastifyRequest, reply: FastifyReply) {
  const auth = requireActiveUser(request, reply);
  if (!auth) return null;
  if (auth.user.role !== "SYSTEM_ADMIN") {
    reply.code(403).send({ error: "需要系统管理员权限" });
    return null;
  }
  return auth;
}

export function canManageMachine(userId: string, role: string, machineId: string) {
  const machineExists = Boolean(
    db.prepare(
      `SELECT 1 FROM machines m
       WHERE m.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )`
    ).get(machineId)
  );
  if (!machineExists) return false;
  if (role === "SYSTEM_ADMIN") return true;
  return Boolean(
    db
      .prepare("SELECT 1 FROM machine_admins WHERE machine_id = ? AND user_id = ?")
      .get(machineId, userId)
  );
}

export function canAccessMachine(userId: string, role: string, machineId: string) {
  return checkMachineAccess(userId, role, machineId);
}

export function getAccessibleMachineIds(userId: string, role: string) {
  return accessibleMachineIds(userId, role);
}

export function getManagedMachineIds(userId: string, role: string): string[] {
  if (role === "SYSTEM_ADMIN") {
    return (db.prepare(
      `SELECT id FROM machines m
       WHERE NOT EXISTS (
         SELECT 1 FROM deleted_machine_tombstones dmt WHERE dmt.machine_id = m.id
       )`
    ).all() as Array<{ id: string }>).map(
      (row) => row.id
    );
  }
  return (
    db
      .prepare("SELECT machine_id AS id FROM machine_admins WHERE user_id = ?")
      .all(userId) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function assertCsrf(request: FastifyRequest, expected: string) {
  const supplied = request.headers["x-csrf-token"];
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAuthToken(userId: string, kind: "PASSWORD_RESET", minutes: number) {
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  db.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND kind = ?").run(
    userId,
    kind
  );
  db.prepare(
    `INSERT INTO auth_tokens(
      id, user_id, token_hash, kind, expires_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), userId, hashToken(token), kind, expiresAt, nowIso());
  return token;
}

export function consumeAuthToken(token: string, kind: "PASSWORD_RESET") {
  const row = db
    .prepare(
      `SELECT id, user_id FROM auth_tokens
       WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`
    )
    .get(hashToken(token), kind, nowIso()) as
    | { id: string; user_id: string }
    | undefined;
  if (!row) return null;
  db.prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
  return row.user_id;
}

export function findAuthTokenUserId(token: string, kind: "PASSWORD_RESET") {
  const row = db
    .prepare(
      `SELECT user_id FROM auth_tokens
       WHERE token_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?`
    )
    .get(hashToken(token), kind, nowIso()) as
    | { user_id: string }
    | undefined;
  return row?.user_id ?? null;
}
