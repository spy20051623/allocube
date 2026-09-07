import { db, nowIso } from "../db.js";
import { createNotification } from "../mailer.js";
import { countRows } from "./records.js";

export function resourceGroupDeleteImpact(groupId: string) {
  return {
    allocations: countRows(
      "SELECT COUNT(*) AS count FROM resource_group_allocations WHERE resource_group_id = ?",
      groupId
    ),
    reservations: countRows(
      "SELECT COUNT(*) AS count FROM reservations WHERE resource_group_id = ?",
      groupId
    ),
    unavailability: countRows(
      "SELECT COUNT(*) AS count FROM resource_unavailability WHERE resource_group_id = ?",
      groupId
    ),
    revisions: countRows(
      "SELECT COUNT(*) AS count FROM resource_group_revisions WHERE resource_group_id = ?",
      groupId
    )
  };
}

export function machineDeleteImpact(machineId: string) {
  return {
    resourcePools: countRows(
      `SELECT COUNT(*) AS count FROM resource_pools rp
       WHERE rp.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_pool_tombstones drpt
           WHERE drpt.resource_pool_id = rp.id
         )`,
      machineId
    ),
    resourceGroups: countRows(
      `SELECT COUNT(*) AS count FROM resource_groups rg
       WHERE rg.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = rg.id
         )`,
      machineId
    ),
    resourceItems: countRows(
      `SELECT COUNT(*) AS count FROM resource_pool_items
       WHERE pool_id IN (
         SELECT rp.id FROM resource_pools rp
         WHERE rp.machine_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deleted_resource_pool_tombstones drpt
             WHERE drpt.resource_pool_id = rp.id
           )
       )`,
      machineId
    ),
    members: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE machine_id = ?",
      machineId
    ),
    managers: countRows(
      "SELECT COUNT(*) AS count FROM machine_admins WHERE machine_id = ?",
      machineId
    ),
    accessRequests: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_requests WHERE machine_id = ?",
      machineId
    ),
    reservations: countRows(
      "SELECT COUNT(*) AS count FROM reservations WHERE machine_id = ?",
      machineId
    ),
    unavailability: countRows(
      "SELECT COUNT(*) AS count FROM resource_unavailability WHERE machine_id = ?",
      machineId
    )
  };
}

export function notifyDeletedResourceGroupUsers(groupId: string, groupName: string) {
  const users = db
    .prepare(
      `SELECT user_id FROM machine_access_memberships
       WHERE machine_id = (
         SELECT machine_id FROM resource_groups WHERE id = ?
       )
       UNION
       SELECT user_id FROM machine_admins
       WHERE machine_id = (
         SELECT machine_id FROM resource_groups WHERE id = ?
       )
       UNION
       SELECT user_id FROM machine_access_requests
       WHERE machine_id = (
         SELECT machine_id FROM resource_groups WHERE id = ?
       ) AND status = 'PENDING'
       UNION
       SELECT DISTINCT user_id FROM reservations WHERE resource_group_id = ?`
    )
    .all(groupId, groupId, groupId, groupId) as Array<{ user_id: string }>;
  for (const user of users) {
    const hasActiveReservation = Boolean(
      db.prepare(
        `SELECT 1 FROM reservations
         WHERE user_id = ? AND resource_group_id = ?
           AND status = 'CONFIRMED' AND end_at > ?
         LIMIT 1`
      ).get(user.user_id, groupId, nowIso())
    );
    createNotification(
      user.user_id,
      "RESOURCE_GROUP_DELETED",
      "资源组已删除",
      `${groupName}已被永久删除，历史占用记录将显示为“资源组已删除”。`,
      "",
      hasActiveReservation ? { emailPolicy: "RESERVATION_IMPACT" } : {}
    );
  }
}

export function notifyDeletedMachineUsers(machineId: string, machineName: string) {
  const users = db
    .prepare(
      `SELECT user_id FROM machine_access_memberships WHERE machine_id = ?
       UNION
       SELECT user_id FROM machine_admins WHERE machine_id = ?
       UNION
       SELECT user_id FROM machine_access_requests
       WHERE machine_id = ? AND status = 'PENDING'
       UNION
       SELECT user_id FROM reservations WHERE machine_id = ?`
    )
    .all(machineId, machineId, machineId, machineId) as Array<{
      user_id: string;
    }>;
  for (const user of users) {
    const hasActiveReservation = Boolean(
      db.prepare(
        `SELECT 1 FROM reservations
         WHERE user_id = ? AND machine_id = ?
           AND status = 'CONFIRMED' AND end_at > ?
         LIMIT 1`
      ).get(user.user_id, machineId, nowIso())
    );
    createNotification(
      user.user_id,
      "MACHINE_DELETED",
      "机器已删除",
      `${machineName}已被永久删除，历史占用记录将显示为“机器已删除”。`,
      "",
      hasActiveReservation ? { emailPolicy: "RESERVATION_IMPACT" } : {}
    );
  }
}

export function tombstoneResourcePool(
  poolId: string,
  machineId: string,
  actorUserId: string
) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO deleted_resource_pool_tombstones(
      resource_pool_id, machine_id, deleted_at, deleted_by
    ) VALUES(?, ?, ?, ?)`
  ).run(poolId, machineId, now, actorUserId);
  db.prepare(
    `UPDATE resource_pools
     SET name = ?, description = '', sort_order = 0,
       version = version + 1, updated_at = ?
     WHERE id = ?`
  ).run(`deleted-${poolId}`, now, poolId);
}

export function deleteResourceGroupRecords(
  groupId: string,
  actorUserId: string,
  counts: ReturnType<typeof resourceGroupDeleteImpact>
) {
  const group = db
    .prepare("SELECT machine_id FROM resource_groups WHERE id = ?")
    .get(groupId) as { machine_id: string };
  const now = nowIso();
  db.prepare(
    `UPDATE resource_unavailability
     SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
     WHERE resource_group_id = ? AND status = 'ACTIVE'`
  ).run(actorUserId, now, groupId);
  db.prepare("DELETE FROM resource_group_allocations WHERE resource_group_id = ?").run(groupId);
  db.prepare(
    `INSERT INTO deleted_resource_group_tombstones(
      resource_group_id, machine_id, deleted_at, deleted_by,
      cleanup_counts_json
    ) VALUES(?, ?, ?, ?, ?)`
  ).run(groupId, group.machine_id, now, actorUserId, JSON.stringify(counts));
  db.prepare(
    `UPDATE resource_groups
     SET name = ?, description = '', tags_json = '[]',
       status = 'DISABLED', disabled_at = NULL, disabled_by = NULL,
       disable_reason = '', sort_order = 0, version = version + 1,
       updated_at = ?
     WHERE id = ?`
  ).run(`deleted-${groupId}`, now, groupId);
}

export function deleteMachineRecords(
  machineId: string,
  actorUserId: string,
  counts: ReturnType<typeof machineDeleteImpact>
) {
  const now = nowIso();
  const groups = db
    .prepare(
      `SELECT rg.id FROM resource_groups rg
       WHERE rg.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = rg.id
         )`
    )
    .all(machineId) as Array<{ id: string }>;
  const groupCounts = new Map(
    groups.map((group) => [group.id, resourceGroupDeleteImpact(group.id)])
  );
  const pools = db
    .prepare(
      `SELECT rp.id FROM resource_pools rp
       WHERE rp.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_pool_tombstones drpt
           WHERE drpt.resource_pool_id = rp.id
         )`
    )
    .all(machineId) as Array<{ id: string }>;
  db.prepare("DELETE FROM machine_admins WHERE machine_id = ?").run(machineId);
  db.prepare("DELETE FROM machine_access_memberships WHERE machine_id = ?").run(machineId);
  db.prepare(
    `UPDATE machine_access_requests
     SET status = 'REJECTED', version = version + 1,
       reviewed_by = ?, review_reason = '机器已删除',
       reviewed_at = ?, updated_at = ?
     WHERE machine_id = ? AND status = 'PENDING'`
  ).run(actorUserId, now, now, machineId);
  db.prepare(
    `UPDATE resource_unavailability
     SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
     WHERE machine_id = ? AND status = 'ACTIVE'`
  ).run(actorUserId, now, machineId);
  db.prepare(
    `DELETE FROM resource_group_allocations
     WHERE resource_group_id IN (
       SELECT id FROM resource_groups WHERE machine_id = ?
     )`
  ).run(machineId);
  for (const group of groups) {
    db.prepare(
      `INSERT INTO deleted_resource_group_tombstones(
        resource_group_id, machine_id, deleted_at, deleted_by,
        cleanup_counts_json
      ) VALUES(?, ?, ?, ?, ?)`
    ).run(
      group.id,
      machineId,
      now,
      actorUserId,
      JSON.stringify(groupCounts.get(group.id))
    );
    db.prepare(
      `UPDATE resource_groups
       SET name = ?, description = '', tags_json = '[]',
         status = 'DISABLED', disabled_at = NULL, disabled_by = NULL,
         disable_reason = '', sort_order = 0, version = version + 1,
         updated_at = ?
       WHERE id = ?`
    ).run(`deleted-${group.id}`, now, group.id);
  }
  for (const pool of pools) {
    tombstoneResourcePool(pool.id, machineId, actorUserId);
  }
  db.prepare(
    `INSERT INTO deleted_machine_tombstones(
      machine_id, deleted_at, deleted_by, cleanup_counts_json
    ) VALUES(?, ?, ?, ?)`
  ).run(machineId, now, actorUserId, JSON.stringify(counts));
  db.prepare(
    `UPDATE machines
     SET name = ?, address = '', hardware_notes = '',
       connection_guide = '', management_notes = '', tags_json = '[]',
       status = 'DISABLED', disabled_at = NULL, disabled_by = NULL,
       disable_reason = '', version = version + 1, updated_at = ?
     WHERE id = ?`
  ).run(`deleted-${machineId}`, now, machineId);
}
