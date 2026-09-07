import type { FastifyReply } from "fastify";
import { db, nowIso, addAudit, bumpMachineAccessRevision, bumpScheduleRevision, parseTags } from "../db.js";
import { createNotification } from "../mailer.js";

export function assignMachineManager(
  reply: FastifyReply,
  machineId: string,
  userId: string,
  actorUserId: string
) {
  const user = db
    .prepare(
      `SELECT u.status
       FROM users u
       JOIN machine_access_memberships mam
         ON mam.user_id = u.id AND mam.machine_id = ?
       WHERE u.id = ? AND u.role = 'USER'`
    )
    .get(machineId, userId) as { status: string } | undefined;
  if (!user || user.status !== "ACTIVE") {
    reply.code(400).send({ error: "只能将这台机器已有的已启用用户设为管理员" });
    return null;
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO machine_admins(
        machine_id, user_id, assigned_by, created_at
      ) VALUES(?, ?, ?, ?)`
    )
    .run(machineId, userId, actorUserId, nowIso());
  if (!result.changes) {
    reply.code(409).send({ error: "该用户已经是这台机器的管理员" });
    return null;
  }
  addAudit(actorUserId, "MACHINE_ADMIN_ASSIGN", "machine", machineId, undefined, {
    userId
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
  return { message: "已设为机器管理员" };
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
