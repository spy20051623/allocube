import { db } from "../db.js";

export function countRows(sql: string, ...params: unknown[]) {
  const row = db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

export function getCurrentMachineRow(machineId: string) {
  return db
    .prepare(
      `SELECT * FROM machines m
       WHERE m.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )`
    )
    .get(machineId) as Record<string, any> | undefined;
}

export function getCurrentResourceGroupRow(groupId: string) {
  return db
    .prepare(
      `SELECT * FROM resource_groups
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = resource_groups.id
         )`
    )
    .get(groupId) as Record<string, any> | undefined;
}
