import { db, nowIso, addAudit, bumpMachineAccessRevision, bumpScheduleRevision, parseTags, withImmediateTransaction } from "../db.js";
import { createNotification } from "../mailer.js";
import { expireMachineAccessRequests } from "../machine-access.js";

export function assignMachineManager(
  machineId: string,
  userId: string,
  actorUserId: string
) {
  expireMachineAccessRequests();
  return withImmediateTransaction(() => assignMachineManagerInTransaction(machineId, userId, actorUserId));
}

function assignMachineManagerInTransaction(machineId: string, userId: string, actorUserId: string) {
  const user = db
    .prepare(
      `SELECT u.status, mam.expires_at
       FROM users u
       JOIN machine_access_memberships mam
         ON mam.user_id = u.id AND mam.machine_id = ?
       WHERE u.id = ? AND u.role = 'USER'`
    )
    .get(machineId, userId) as { status: string; expires_at: string | null } | undefined;
  if (!user || user.status !== "ACTIVE") {
    return { ok: false, status: 400, message: "只能将这台机器已有的已启用用户设为管理员" } as const;
  }
  if (db.prepare("SELECT 1 FROM machine_access_requests WHERE machine_id=? AND user_id=? AND status='PENDING'").get(machineId, userId)) {
    return { ok: false, status: 409, message: "该用户已有待审批申请，请直接处理申请" } as const;
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO machine_admins(
        machine_id, user_id, assigned_by, created_at
      ) VALUES(?, ?, ?, ?)`
    )
    .run(machineId, userId, actorUserId, nowIso());
  if (!result.changes) {
    return { ok: false, status: 409, message: "该用户已经是这台机器的管理员" } as const;
  }
  addAudit(actorUserId, "MACHINE_ADMIN_ASSIGN", "machine", machineId, { userId, expiresAt: user.expires_at }, {
    userId, expiresAt: null
  });
  bumpMachineAccessRevision();
  bumpScheduleRevision();
  createNotification(
    userId,
    "MACHINE_ROLE_CHANGED",
    "你已成为机器管理员",
    "你现在可以在资源管理中维护该机器并处理使用权申请。",
    "/admin/machines"
  );
  return { ok: true, message: "已设为机器管理员" } as const;
}

export function machineAuditPayload(
  value: {
    name: string;
    address: string;
    hardwareNotes: string;
    connectionGuide: string;
    tags: string[];
  },
  managementNotesChanged: boolean
) {
  return {
    name: value.name,
    address: value.address,
    hardwareNotes: value.hardwareNotes,
    connectionGuide: value.connectionGuide,
    tags: value.tags,
    managementNotesChanged
  };
}

export function machineAuditPayloadFromRow(
  row: Record<string, unknown>,
  managementNotesChanged: boolean
) {
  return {
    name: row.name,
    address: row.address,
    hardwareNotes: row.hardware_notes,
    connectionGuide: row.connection_guide,
    tags: parseTags(String(row.tags_json)),
    managementNotesChanged
  };
}
