import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  addAudit,
  bumpMachineAccessRevision,
  bumpScheduleRevision,
  currentMinuteIso,
  db,
  nowIso,
  withImmediateTransaction
} from "./db.js";
import { BusinessError } from "./business-error.js";
import { createNotification } from "./mailer.js";

export type MachineAccessSource = "APPLICATION" | "ADMIN_INVITE" | "SEED";

export function defaultAccessExpiry() {
  const offset = 8 * 3600_000;
  return new Date(Math.floor((Date.now() + offset) / 86400_000) * 86400_000 + 31 * 86400_000 - offset).toISOString();
}

export function accessExpiryDescription(value: string | null) {
  return value ? `${new Date(Date.parse(value) - 1 + 8 * 3600_000).toISOString().slice(0, 10)} 24:00（北京时间）` : "长期有效";
}

export function parseAccessExpiry(value: unknown, allowPermanent = true): string | null {
  if (value === undefined) return defaultAccessExpiry();
  if (value === null && allowPermanent) return null;
  const valid = z.iso.datetime({ offset: true }).safeParse(value);
  const timestamp = valid.success ? Date.parse(valid.data) : NaN;
  if (!Number.isFinite(timestamp) || (timestamp + 8 * 3600_000) % 86400_000 !== 0 || timestamp <= Date.now()) {
    throw new BusinessError("到期时间必须为北京时间次日零点，且晚于当前时间", 400, undefined, "MACHINE_ACCESS_EXPIRY_INVALID");
  }
  return new Date(timestamp).toISOString();
}

export function assertMachineAccessEnd(userId: string, machineId: string, endAt: string) {
  const membership = db.prepare("SELECT expires_at FROM machine_access_memberships WHERE machine_id=? AND user_id=?")
    .get(machineId, userId) as { expires_at: string | null } | undefined;
  if (membership?.expires_at && Date.parse(endAt) > Date.parse(membership.expires_at)) {
    throw new BusinessError("占用结束时间不能超过机器授权到期时间", 403, undefined, "MACHINE_ACCESS_EXPIRY_EXCEEDED");
  }
}

/** Runs in the caller's membership update transaction. */
export function trimMachineAccessReservations(machineId: string, userId: string, expiresAt: string, actorUserId: string) {
  const now = nowIso();
  const rows = db.prepare(`SELECT id,start_at,end_at FROM reservations WHERE machine_id=? AND user_id=?
    AND status='CONFIRMED' AND julianday(end_at)>julianday(?)`).all(machineId, userId, expiresAt) as Array<{ id: string; start_at: string; end_at: string }>;
  let cancelled = 0;
  let truncated = 0;
  for (const row of rows) {
    const cancel = Date.parse(row.start_at) >= Date.parse(expiresAt);
    if (cancel) {
      db.prepare(`UPDATE reservations SET status='CANCELLED',cancelled_at=?,cancelled_by=?,cancellation_reason=?,updated_at=? WHERE id=?`)
        .run(now, actorUserId, "机器授权期限缩短", now, row.id);
      cancelled++;
    } else {
      db.prepare("UPDATE reservations SET end_at=?,adjustment_type='TRIM_END',adjustment_reason=?,updated_at=? WHERE id=?")
        .run(expiresAt, "机器授权期限缩短", now, row.id);
      truncated++;
    }
    addAudit(actorUserId, "RESERVATION_ACCESS_EXPIRY", "reservation", row.id,
      { startAt: row.start_at, endAt: row.end_at },
      { machineId, userId, expiresAt, status: cancel ? "CANCELLED" : "CONFIRMED", endAt: cancel ? row.end_at : expiresAt });
  }
  return { cancelled, truncated };
}

/** Caller must hold an immediate transaction. Returning commits expiry even when approval is rejected. */
export function expireMachineAccessRequestsInTransaction() {
  const now = nowIso();
  const rows = db.prepare(`SELECT id,user_id,machine_id FROM machine_access_requests
    WHERE status='PENDING' AND expires_at IS NOT NULL AND expires_at<=?`).all(now) as Array<{ id: string; user_id: string; machine_id: string }>;
  for (const row of rows) {
    db.prepare(`UPDATE machine_access_requests SET status='REJECTED',reviewed_by=NULL,reviewed_at=?,
      review_reason=?,updated_at=?,version=version+1 WHERE id=? AND status='PENDING'`)
      .run(now, "申请使用期限已到，未完成审批", now, row.id);
    addAudit(null, "MACHINE_ACCESS_REQUEST_EXPIRE", "machine_access_request", row.id, { status: "PENDING" },
      { status: "REJECTED", source: "SYSTEM", machineId: row.machine_id, userId: row.user_id });
    // Notifications are database records in the same transaction, so retries cannot duplicate them.
    createNotification(row.user_id, "MACHINE_ACCESS_REJECTED", "机器使用权申请未通过", "申请使用期限已到，未完成审批。你可以重新申请。", "/resources");
  }
  if (rows.length) {
    bumpMachineAccessRevision();
    bumpScheduleRevision();
  }
  return rows.length;
}

export function expireMachineAccessRequests() {
  return withImmediateTransaction(expireMachineAccessRequestsInTransaction);
}

export function canAccessMachine(userId: string, role: string, machineId: string) {
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
      .prepare(
        `SELECT 1 FROM machine_access_memberships
         WHERE machine_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)`
      )
      .get(machineId, userId, nowIso())
  );
}

export function userCanAccessMachine(userId: string, machineId: string) {
  const user = db
    .prepare("SELECT role, status FROM users WHERE id = ?")
    .get(userId) as { role: string; status: string } | undefined;
  return Boolean(
    user &&
      user.status === "ACTIVE" &&
      canAccessMachine(userId, user.role, machineId)
  );
}

export function getAccessibleMachineIds(userId: string, role: string): string[] {
  if (role === "SYSTEM_ADMIN") {
    return (db.prepare(
      `SELECT id FROM machines m
       WHERE NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )`
    ).all() as Array<{
      id: string;
    }>).map((row) => row.id);
  }
  return (
    db
      .prepare(
        `SELECT mam.machine_id AS id
         FROM machine_access_memberships mam
         JOIN machines m ON m.id = mam.machine_id
         WHERE mam.user_id = ?
           AND (mam.expires_at IS NULL OR mam.expires_at > ?)
           AND NOT EXISTS (
             SELECT 1 FROM deleted_machine_tombstones dmt
             WHERE dmt.machine_id = m.id
           )`
      )
      .all(userId, nowIso()) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function grantMachineAccess(
  machineId: string,
  userId: string,
  source: MachineAccessSource,
  actorUserId: string | null,
  expiresAt: string | null = null
) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO machine_access_memberships(
      id, machine_id, user_id, source, granted_by, created_at, updated_at, expires_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine_id, user_id) DO UPDATE SET source=excluded.source,
      granted_by=excluded.granted_by, expires_at=excluded.expires_at,
      updated_at=excluded.updated_at, version=machine_access_memberships.version+1`
  ).run(randomUUID(), machineId, userId, source, actorUserId, now, now, expiresAt);
  bumpMachineAccessRevision();
  bumpScheduleRevision();
}

export function releaseMachineResources(
  machineId: string,
  userId: string,
  actorUserId: string,
  reason: string
) {
  const now = nowIso();
  const currentMinute = currentMinuteIso();
  const current = db
    .prepare(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE machine_id = ? AND user_id = ? AND status = 'CONFIRMED'
         AND start_at <= ? AND end_at > ?`
    )
    .get(machineId, userId, now, now) as { count: number };
  const future = db
    .prepare(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE machine_id = ? AND user_id = ? AND status = 'CONFIRMED'
         AND start_at > ?`
    )
    .get(machineId, userId, now) as { count: number };
  const justStarted = db
    .prepare(
      `SELECT id, batch_id, resource_group_id, scope, start_at
       FROM reservations
       WHERE machine_id = ? AND user_id = ? AND status = 'CONFIRMED'
         AND start_at >= ? AND start_at <= ? AND end_at > ?`
    )
    .all(machineId, userId, currentMinute, now, now) as Array<{
    id: string;
    batch_id: string;
    resource_group_id: string;
    scope: string;
    start_at: string;
  }>;
  for (const reservation of justStarted) {
    addAudit(
      actorUserId,
      "RESERVATION_WITHDRAW_FIRST_MINUTE",
      "reservation",
      reservation.id,
      undefined,
      {
        machineId,
        resourceGroupId: reservation.resource_group_id,
        scope: reservation.scope,
        startedAt: reservation.start_at,
        removedWithinFirstMinute: true,
        source: "MACHINE_ACCESS_RELEASE"
      }
    );
    db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
    db.prepare(
      `DELETE FROM reservation_batches
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM reservations WHERE batch_id = ?
         )`
    ).run(reservation.batch_id, reservation.batch_id);
  }
  db.prepare(
    `UPDATE reservations SET
      end_at = ?, updated_at = ?
     WHERE machine_id = ? AND user_id = ? AND status = 'CONFIRMED'
       AND start_at < ? AND end_at > ?`
  ).run(currentMinute, now, machineId, userId, currentMinute, now);
  db.prepare(
    `UPDATE reservations SET
      status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
      cancellation_reason = ?, updated_at = ?
     WHERE machine_id = ? AND user_id = ? AND status = 'CONFIRMED'
       AND start_at > ?`
  ).run(now, actorUserId, reason, now, machineId, userId, now);
  return {
    activeReservations: current.count,
    futureReservations: future.count
  };
}

export function removeMachineMembership(
  machineId: string,
  userId: string,
  actorUserId: string,
  reason: string
) {
  const impact = releaseMachineResources(machineId, userId, actorUserId, reason);
  const removedManager = db
    .prepare("DELETE FROM machine_admins WHERE machine_id = ? AND user_id = ?")
    .run(machineId, userId);
  const removed = db
    .prepare(
      "DELETE FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
    )
    .run(machineId, userId);
  if (removed.changes) {
    const renewalRequests = db.prepare("SELECT id FROM machine_access_requests WHERE machine_id=? AND user_id=? AND status='PENDING' AND previous_expires_at IS NOT NULL").all(machineId, userId) as Array<{ id: string }>;
    for (const request of renewalRequests) {
      db.prepare("UPDATE machine_access_requests SET status='REJECTED',reviewed_by=?,reviewed_at=?,review_reason=?,updated_at=?,version=version+1 WHERE id=? AND status='PENDING'")
        .run(actorUserId, nowIso(), "使用权已移除，延期申请已结束", nowIso(), request.id);
      addAudit(actorUserId, "MACHINE_ACCESS_REQUEST_REJECT", "machine_access_request", request.id, { status: "PENDING" }, { status: "REJECTED", reason: "使用权已移除，延期申请已结束" });
      createNotification(userId, "MACHINE_ACCESS_REJECTED", "机器使用权申请未通过", "使用权已移除，延期申请已结束", "/resources");
    }
    if (removedManager.changes) {
      addAudit(
        actorUserId,
        "MACHINE_ADMIN_REMOVE",
        "machine",
        machineId,
        { userId },
        { reason }
      );
    }
    addAudit(
      actorUserId,
      "MACHINE_MEMBER_REMOVE",
      "machine",
      machineId,
      { userId },
      impact
    );
    bumpMachineAccessRevision();
    bumpScheduleRevision();
  }
  return { removed: Boolean(removed.changes), ...impact };
}
