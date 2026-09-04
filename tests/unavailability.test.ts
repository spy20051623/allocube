import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-unavailability-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "unavailability.sqlite");
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "unavailability-test-session-secret-at-least-32";

let dbModule: typeof import("../server/db.js");
let unavailability: typeof import("../server/unavailability.js");
let scheduling: typeof import("../server/scheduling.js");
let adminId = "";
let userId = "";
let machineId = "";
const groupIds: string[] = [];
let cancelledGroupId = "";
let plannedStartAt = "";
let plannedEndAt = "";

function futureIso(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function insertGroup(name: string) {
  const id = randomUUID();
  const now = dbModule.nowIso();
  dbModule.db
    .prepare(
      `INSERT INTO resource_groups(id, machine_id, name, created_at, updated_at)
       VALUES(?, ?, ?, ?, ?)`
    )
    .run(id, machineId, name, now, now);
  groupIds.push(id);
  return id;
}

function insertReservation(
  groupId: string,
  startAt: string,
  endAt: string,
  batchId = randomUUID()
) {
  const id = randomUUID();
  const now = dbModule.nowIso();
  dbModule.db
    .prepare(
      `INSERT OR IGNORE INTO reservation_batches(id, user_id, created_at)
       VALUES(?, ?, ?)`
    )
    .run(batchId, userId, now);
  dbModule.db
    .prepare(
      `INSERT INTO reservations(
        id, batch_id, resource_group_id, machine_id, user_id,
        start_at, end_at, initial_start_at, initial_end_at,
        snapshot_group_name, snapshot_resource_config_json,
        snapshot_group_version, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '测试资源组', '[]', 1, ?, ?)`
    )
    .run(
      id,
      batchId,
      groupId,
      machineId,
      userId,
      startAt,
      endAt,
      startAt,
      endAt,
      now,
      now
    );
  return { id, batchId };
}

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  unavailability = await import("../server/unavailability.js");
  scheduling = await import("../server/scheduling.js");
  const authModule = await import("../server/auth.js");
  await dbModule.initializeDatabase();

  adminId = (
    dbModule.db
      .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN'")
      .get() as { id: string }
  ).id;
  userId = randomUUID();
  const now = dbModule.nowIso();
  dbModule.db
    .prepare(
      `INSERT INTO users(
        id, username, username_normalized, email, display_name, password_hash,
        role, status, approved_at, approved_by, created_at, updated_at
      ) VALUES(?, 'availability-user', 'availability-user',
        'availability@example.com', '占用用户', ?, 'USER', 'ACTIVE', ?, ?, ?, ?)`
    )
    .run(
      userId,
      await authModule.hashPassword("ValidPassword123!"),
      now,
      adminId,
      now,
      now
    );
  machineId = randomUUID();
  dbModule.db
    .prepare(
      `INSERT INTO machines(id, name, created_at, updated_at)
       VALUES(?, '停用测试机器', ?, ?)`
    )
    .run(machineId, now, now);
});

describe("统一停用时段", () => {
  it("一次计划停用同时取消、裁切并拆分重叠占用", () => {
    const blockedStart = futureIso(120);
    const blockedEnd = futureIso(240);
    plannedStartAt = blockedStart;
    plannedEndAt = blockedEnd;
    cancelledGroupId = insertGroup("完全覆盖");
    const full = insertReservation(
      cancelledGroupId,
      futureIso(150),
      futureIso(180)
    );
    const trimEnd = insertReservation(
      insertGroup("尾部重叠"),
      futureIso(60),
      futureIso(150)
    );
    const trimStart = insertReservation(
      insertGroup("头部重叠"),
      futureIso(210),
      futureIso(300)
    );
    const split = insertReservation(
      insertGroup("中间拆分"),
      futureIso(60),
      futureIso(300)
    );

    const preview = unavailability.previewUnavailability(
      "MACHINE",
      machineId,
      blockedStart,
      blockedEnd
    );
    expect(preview.summary).toEqual({
      total: 4,
      cancelled: 1,
      trimmed: 2,
      split: 1
    });

    const created = unavailability.createPlannedUnavailability({
      type: "MACHINE",
      id: machineId,
      startAt: blockedStart,
      endAt: blockedEnd,
      reason: "例行停用",
      expectedRevision: preview.revision,
      actorUserId: adminId
    });
    expect(created.impact).toEqual(preview.summary);

    const blockedPreview = scheduling.previewSegments([
      {
        resourceGroupId: cancelledGroupId,
        startAt: futureIso(60),
        endAt: futureIso(300)
      }
    ])[0];
    expect(blockedPreview.available).toBe(false);
    expect(blockedPreview.conflicts.some((item) => item.type === "UNAVAILABILITY")).toBe(true);
    expect(blockedPreview.splitSegments.map((item) => [item.startAt, item.endAt])).toEqual([
      [futureIso(60), blockedStart],
      [blockedEnd, futureIso(300)]
    ]);

    const cancelled = dbModule.db
      .prepare("SELECT status, adjustment_type FROM reservations WHERE id = ?")
      .get(full.id);
    expect(cancelled).toEqual({
      status: "CANCELLED_UNAVAILABILITY",
      adjustment_type: "CANCEL"
    });

    const endTrimmed = dbModule.db
      .prepare(
        `SELECT start_at, end_at, initial_start_at, initial_end_at, adjustment_type
         FROM reservations WHERE id = ?`
      )
      .get(trimEnd.id) as Record<string, string>;
    expect(endTrimmed.end_at).toBe(blockedStart);
    expect(endTrimmed.initial_end_at).toBe(futureIso(150));
    expect(endTrimmed.adjustment_type).toBe("TRIM_END");

    const startTrimmed = dbModule.db
      .prepare("SELECT start_at, adjustment_type FROM reservations WHERE id = ?")
      .get(trimStart.id) as Record<string, string>;
    expect(startTrimmed.start_at).toBe(blockedEnd);
    expect(startTrimmed.adjustment_type).toBe("TRIM_START");

    const splitRows = dbModule.db
      .prepare(
        `SELECT id, parent_reservation_id, start_at, end_at, initial_start_at,
                initial_end_at, adjustment_type
         FROM reservations WHERE id = ? OR parent_reservation_id = ?
         ORDER BY start_at`
      )
      .all(split.id, split.id) as Array<Record<string, string | null>>;
    expect(splitRows).toHaveLength(2);
    expect(splitRows.map((row) => [row.start_at, row.end_at])).toEqual([
      [futureIso(60), blockedStart],
      [blockedEnd, futureIso(300)]
    ]);
    expect(splitRows.every((row) => row.initial_start_at === futureIso(60))).toBe(true);
    expect(splitRows.every((row) => row.initial_end_at === futureIso(300))).toBe(true);
    expect(splitRows[1].parent_reservation_id).toBe(split.id);
    const splitAudit = dbModule.db
      .prepare(
        `SELECT action, before_json AS beforeJson, after_json AS afterJson
         FROM audit_logs WHERE entity_id = ? AND action = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(
        splitRows[1].id,
        "RESERVATION_SPLIT_UNAVAILABILITY"
      ) as {
      action: string;
      beforeJson: string | null;
      afterJson: string;
    };
    expect(splitAudit.action).toBe("RESERVATION_SPLIT_UNAVAILABILITY");
    expect(splitAudit.beforeJson).toBeNull();
    expect(JSON.parse(splitAudit.afterJson)).toMatchObject({
      parentReservationId: split.id,
      startAt: blockedEnd,
      endAt: futureIso(300)
    });
  });

  it("取消计划停用不会恢复已经调整的占用", () => {
    const window = dbModule.db
      .prepare(
        `SELECT id FROM resource_unavailability
         WHERE machine_id = ? AND kind = 'PLANNED' AND status = 'ACTIVE'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(machineId) as { id: string };
    const before = dbModule.db
      .prepare(
        `SELECT id, start_at, end_at, status FROM reservations
         WHERE adjusted_by_unavailability_id = ? ORDER BY id`
      )
      .all(window.id);
    unavailability.cancelUnavailability(window.id, adminId);
    const after = dbModule.db
      .prepare(
        `SELECT id, start_at, end_at, status FROM reservations
         WHERE adjusted_by_unavailability_id = ? ORDER BY id`
      )
      .all(window.id);
    expect(after).toEqual(before);
    const releasedPreview = scheduling.previewSegments([
      {
        resourceGroupId: cancelledGroupId,
        startAt: plannedStartAt,
        endAt: plannedEndAt
      }
    ])[0];
    expect(releasedPreview.available).toBe(true);
  });

  it("同一对象拒绝重叠时段，允许首尾相接，并阻止过期预览", () => {
    const groupId = insertGroup("相邻时段");
    const firstStart = futureIso(420);
    const firstEnd = futureIso(480);
    const firstPreview = unavailability.previewUnavailability(
      "RESOURCE_GROUP",
      groupId,
      firstStart,
      firstEnd
    );
    unavailability.createPlannedUnavailability({
      type: "RESOURCE_GROUP",
      id: groupId,
      startAt: firstStart,
      endAt: firstEnd,
      expectedRevision: firstPreview.revision,
      actorUserId: adminId
    });

    const staleRevision = firstPreview.revision;
    expect(() =>
      unavailability.createPlannedUnavailability({
        type: "RESOURCE_GROUP",
        id: groupId,
        startAt: firstEnd,
        endAt: futureIso(540),
        expectedRevision: staleRevision,
        actorUserId: adminId
      })
    ).toThrow("占用情况已变化");

    const adjacentPreview = unavailability.previewUnavailability(
      "RESOURCE_GROUP",
      groupId,
      firstEnd,
      futureIso(540)
    );
    expect(() =>
      unavailability.createPlannedUnavailability({
        type: "RESOURCE_GROUP",
        id: groupId,
        startAt: firstEnd,
        endAt: futureIso(540),
        expectedRevision: adjacentPreview.revision,
        actorUserId: adminId
      })
    ).not.toThrow();

    const overlapPreview = unavailability.previewUnavailability(
      "RESOURCE_GROUP",
      groupId,
      futureIso(450),
      futureIso(510)
    );
    expect(() =>
      unavailability.createPlannedUnavailability({
        type: "RESOURCE_GROUP",
        id: groupId,
        startAt: futureIso(450),
        endAt: futureIso(510),
        expectedRevision: overlapPreview.revision,
        actorUserId: adminId
      })
    ).toThrow("重叠");
  });

  it("维护开始时间已经过去时按服务器当前分钟立即开始", () => {
    const groupId = insertGroup("立即维护组");
    const requestedStart = futureIso(-10);
    const endAt = futureIso(30);
    const beforePreview = Math.floor(Date.now() / 60_000) * 60_000;
    const preview = unavailability.previewUnavailability(
      "RESOURCE_GROUP",
      groupId,
      requestedStart,
      endAt
    );
    expect(new Date(preview.startAt).getTime()).toBeGreaterThanOrEqual(
      beforePreview
    );
    expect(preview.endAt).toBe(endAt);

    const created = unavailability.createPlannedUnavailability({
      type: "RESOURCE_GROUP",
      id: groupId,
      startAt: requestedStart,
      endAt,
      expectedRevision: preview.revision,
      actorUserId: adminId
    });
    const stored = dbModule.db
      .prepare(
        `SELECT start_at AS startAt, end_at AS endAt
         FROM resource_unavailability WHERE id = ?`
      )
      .get(created.id) as { startAt: string; endAt: string };
    expect(stored).toEqual({
      startAt: created.startAt,
      endAt
    });
    expect(new Date(stored.startAt).getTime()).toBeGreaterThanOrEqual(
      new Date(preview.startAt).getTime()
    );
  });

  it("资源组长期停用只处理本组，重新启用不恢复占用", () => {
    const disabledGroup = insertGroup("长期停用组");
    const unaffectedGroup = insertGroup("不受影响组");
    const ongoingMaintenanceId = randomUUID();
    const ongoingMaintenanceStart = futureIso(-30);
    const ongoingMaintenanceOriginalEnd = futureIso(30);
    dbModule.db
      .prepare(
        `INSERT INTO resource_unavailability(
          id, machine_id, resource_group_id, kind, start_at, end_at,
          reason, created_by, created_at
        ) VALUES(?, ?, ?, 'PLANNED', ?, ?, '正在进行的维护', ?, ?)`
      )
      .run(
        ongoingMaintenanceId,
        machineId,
        disabledGroup,
        ongoingMaintenanceStart,
        ongoingMaintenanceOriginalEnd,
        adminId,
        dbModule.nowIso()
      );
    const disabledReservation = insertReservation(
      disabledGroup,
      futureIso(600),
      futureIso(660)
    );
    const unaffectedReservation = insertReservation(
      unaffectedGroup,
      futureIso(600),
      futureIso(660)
    );
    const preview = unavailability.previewLongTermDisable(
      "RESOURCE_GROUP",
      disabledGroup
    );
    const result = unavailability.disableLongTerm({
      type: "RESOURCE_GROUP",
      id: disabledGroup,
      expectedVersion: 1,
      expectedRevision: preview.revision,
      actorUserId: adminId
    });
    expect(result.status).toBe("DISABLED");
    const interruptedMaintenance = dbModule.db
      .prepare(
        `SELECT end_at AS endAt, status, cancelled_at AS cancelledAt
         FROM resource_unavailability WHERE id = ?`
      )
      .get(ongoingMaintenanceId) as {
        endAt: string;
        status: string;
        cancelledAt: string | null;
      };
    expect(interruptedMaintenance.status).toBe("ACTIVE");
    expect(interruptedMaintenance.cancelledAt).toBeNull();
    expect(new Date(interruptedMaintenance.endAt).getTime()).toBeLessThan(
      new Date(ongoingMaintenanceOriginalEnd).getTime()
    );
    expect(
      Math.abs(
        new Date(interruptedMaintenance.endAt).getTime() -
          Math.floor(Date.now() / 60_000) * 60_000
      )
    ).toBeLessThan(60_000);
    const interruptedAudit = dbModule.db
      .prepare(
        `SELECT action, before_json AS beforeJson, after_json AS afterJson
         FROM audit_logs WHERE entity_id = ? AND action = ?`
      )
      .get(
        ongoingMaintenanceId,
        "UNAVAILABILITY_INTERRUPT_DISABLE"
      ) as {
      action: string;
      beforeJson: string;
      afterJson: string;
    };
    expect(interruptedAudit.action).toBe("UNAVAILABILITY_INTERRUPT_DISABLE");
    expect(JSON.parse(interruptedAudit.beforeJson)).toMatchObject({
      startAt: ongoingMaintenanceStart,
      endAt: ongoingMaintenanceOriginalEnd
    });
    expect(JSON.parse(interruptedAudit.afterJson)).toMatchObject({
      endAt: interruptedMaintenance.endAt,
      disabledTargetType: "RESOURCE_GROUP",
      disabledTargetId: disabledGroup
    });
    expect(
      dbModule.db
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(disabledReservation.id)
    ).toEqual({ status: "CANCELLED_UNAVAILABILITY" });
    expect(
      dbModule.db
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(unaffectedReservation.id)
    ).toEqual({ status: "CONFIRMED" });

    const disableWindow = dbModule.db
      .prepare(
        `SELECT id FROM resource_unavailability
         WHERE resource_group_id = ? AND kind = 'LONG_TERM'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(disabledGroup) as { id: string };
    expect(
      dbModule.db
        .prepare(
          `SELECT action FROM audit_logs
           WHERE entity_id = ? AND action = 'RESOURCE_DISABLE_WINDOW_CREATE'`
        )
        .get(disableWindow.id)
    ).toEqual({ action: "RESOURCE_DISABLE_WINDOW_CREATE" });

    unavailability.enableTarget({
      type: "RESOURCE_GROUP",
      id: disabledGroup,
      expectedVersion: 2,
      actorUserId: adminId
    });
    expect(
      dbModule.db
        .prepare("SELECT status FROM reservations WHERE id = ?")
        .get(disabledReservation.id)
    ).toEqual({ status: "CANCELLED_UNAVAILABILITY" });
    expect(
      dbModule.db
        .prepare("SELECT status FROM resource_groups WHERE id = ?")
        .get(disabledGroup)
    ).toEqual({ status: "ACTIVE" });
    expect(
      dbModule.db
        .prepare(
          `SELECT status FROM resource_unavailability
           WHERE resource_group_id = ? AND kind = 'LONG_TERM'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(disabledGroup)
    ).toEqual({ status: "CANCELLED" });
    const disableWindowAudits = dbModule.db
      .prepare(
        `SELECT action FROM audit_logs WHERE entity_id = ?
         ORDER BY rowid`
      )
      .all(disableWindow.id) as Array<{ action: string }>;
    expect(disableWindowAudits.map((item) => item.action)).toEqual([
      "RESOURCE_DISABLE_WINDOW_CREATE",
      "RESOURCE_DISABLE_WINDOW_END"
    ]);
  });

  it("整机长期停用结束或取消全部未完成维护，但保留资源组停用记录", () => {
    const plannedGroup = insertGroup("整机停用前的计划组");
    const retainedDisabledGroup = insertGroup("保留长期停用记录组");

    const machinePlannedPreview = unavailability.previewUnavailability(
      "MACHINE",
      machineId,
      futureIso(720),
      futureIso(780)
    );
    const machinePlanned = unavailability.createPlannedUnavailability({
      type: "MACHINE",
      id: machineId,
      startAt: futureIso(720),
      endAt: futureIso(780),
      expectedRevision: machinePlannedPreview.revision,
      actorUserId: adminId
    });

    const groupPlannedPreview = unavailability.previewUnavailability(
      "RESOURCE_GROUP",
      plannedGroup,
      futureIso(750),
      futureIso(810)
    );
    const groupPlanned = unavailability.createPlannedUnavailability({
      type: "RESOURCE_GROUP",
      id: plannedGroup,
      startAt: futureIso(750),
      endAt: futureIso(810),
      expectedRevision: groupPlannedPreview.revision,
      actorUserId: adminId
    });

    const groupLongTermPreview = unavailability.previewLongTermDisable(
      "RESOURCE_GROUP",
      retainedDisabledGroup
    );
    unavailability.disableLongTerm({
      type: "RESOURCE_GROUP",
      id: retainedDisabledGroup,
      expectedVersion: 1,
      expectedRevision: groupLongTermPreview.revision,
      actorUserId: adminId
    });
    const retainedLongTerm = dbModule.db
      .prepare(
        `SELECT id FROM resource_unavailability
         WHERE resource_group_id = ? AND kind = 'LONG_TERM' AND status = 'ACTIVE'`
      )
      .get(retainedDisabledGroup) as { id: string };

    const machineLongTermPreview = unavailability.previewLongTermDisable(
      "MACHINE",
      machineId
    );
    unavailability.disableLongTerm({
      type: "MACHINE",
      id: machineId,
      expectedVersion: 1,
      expectedRevision: machineLongTermPreview.revision,
      actorUserId: adminId
    });

    expect(
      dbModule.db
        .prepare(
          "SELECT id, status FROM resource_unavailability WHERE id IN (?, ?) ORDER BY id"
        )
        .all(machinePlanned.id, groupPlanned.id)
    ).toEqual(
      [machinePlanned.id, groupPlanned.id]
        .sort()
        .map((id) => ({ id, status: "CANCELLED" }))
    );
    for (const id of [machinePlanned.id, groupPlanned.id]) {
      expect(
        dbModule.db
          .prepare(
            `SELECT action FROM audit_logs
             WHERE entity_id = ? AND action = 'UNAVAILABILITY_CANCEL_DISABLE'`
          )
          .get(id)
      ).toEqual({ action: "UNAVAILABILITY_CANCEL_DISABLE" });
    }
    expect(
      dbModule.db
        .prepare(
          `SELECT COUNT(*) AS count FROM resource_unavailability
           WHERE machine_id = ? AND kind = 'PLANNED'
             AND status = 'ACTIVE' AND end_at > ?`
        )
        .get(machineId, dbModule.nowIso())
    ).toEqual({ count: 0 });
    expect(
      dbModule.db
        .prepare("SELECT status FROM resource_unavailability WHERE id = ?")
        .get(retainedLongTerm.id)
    ).toEqual({ status: "ACTIVE" });
  });
});
