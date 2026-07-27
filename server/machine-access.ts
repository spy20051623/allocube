import { randomUUID } from "node:crypto";
import {
  addAudit,
  bumpMachineAccessRevision,
  bumpScheduleRevision,
  currentMinuteIso,
  db,
  nowIso
} from "./db.js";

export type MachineAccessSource = "APPLICATION" | "ADMIN_INVITE" | "SEED";

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
         WHERE machine_id = ? AND user_id = ?`
      )
      .get(machineId, userId)
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
       WHERE status = 'ACTIVE'
         AND NOT EXISTS (
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
         WHERE mam.user_id = ? AND m.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM deleted_machine_tombstones dmt
             WHERE dmt.machine_id = m.id
           )`
      )
      .all(userId) as Array<{ id: string }>
  ).map((row) => row.id);
}

export function grantMachineAccess(
  machineId: string,
  userId: string,
  source: MachineAccessSource,
  actorUserId: string | null
) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO machine_access_memberships(
      id, machine_id, user_id, source, granted_by, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), machineId, userId, source, actorUserId, now, now);
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
