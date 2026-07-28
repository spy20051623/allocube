import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(testDirectory, "test.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "StrongTestPassword123!";

let dbModule: typeof import("../server/db.js");
let scheduling: typeof import("../server/scheduling.js");
let userId = "";
let machineId = "";
let poolId = "";
let firstGroupId = "";
let secondGroupId = "";

function futureIso(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  scheduling = await import("../server/scheduling.js");
  await dbModule.initializeDatabase();
  const admin = dbModule.db
    .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN'")
    .get() as { id: string };
  userId = admin.id;
  machineId = randomUUID();
  poolId = randomUUID();
  firstGroupId = randomUUID();
  secondGroupId = randomUUID();
  const now = dbModule.nowIso();
  dbModule.db
    .prepare(
      `INSERT INTO machines(
        id, name, created_at, updated_at
      ) VALUES(?, 'Test-Machine', ?, ?)`
    )
    .run(machineId, now, now);
  dbModule.db.prepare(
    `INSERT INTO resource_pools(
      id, machine_id, name, kind, unit, range_start, range_end, created_at, updated_at
    ) VALUES(?, ?, '逻辑核', 'INDEX_RANGE', '核', 0, 63, ?, ?)`
  ).run(poolId, machineId, now, now);
  const insertGroup = dbModule.db.prepare(
    `INSERT INTO resource_groups(
      id, machine_id, name, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?)`
  );
  insertGroup.run(firstGroupId, machineId, "Group-A", now, now);
  insertGroup.run(secondGroupId, machineId, "Group-B", now, now);
  const insertAllocation = dbModule.db.prepare(
    `INSERT INTO resource_group_allocations(
      id, resource_group_id, resource_pool_id, kind
    ) VALUES(?, ?, ?, 'INDEX_RANGE')`
  );
  const insertRange = dbModule.db.prepare(
    `INSERT INTO resource_group_allocation_ranges(
      id, allocation_id, range_start, range_end
    ) VALUES(?, ?, ?, ?)`
  );
  for (const [groupId, start, end] of [
    [firstGroupId, 0, 15],
    [secondGroupId, 16, 31]
  ] as const) {
    const allocationId = randomUUID();
    insertAllocation.run(allocationId, groupId, poolId);
    insertRange.run(randomUUID(), allocationId, start, end);
  }
});

describe("资源占用事务与拆分", () => {
  it("立即开始和已经到达的预约均以服务器当前分钟为准", () => {
    const serverMinute = dbModule.currentMinuteIso();
    const pastStart = new Date(
      new Date(serverMinute).getTime() - 5 * 60_000
    ).toISOString();
    const endAt = new Date(
      new Date(serverMinute).getTime() + 30 * 60_000
    ).toISOString();
    const preview = scheduling.previewSegments([
      {
        resourceGroupId: secondGroupId,
        startMode: "SCHEDULED",
        startAt: pastStart,
        endAt
      }
    ]);
    expect(preview[0].input).toMatchObject({
      startMode: "IMMEDIATE",
      startAt: serverMinute
    });

    const committed = scheduling.commitReservationBatch(userId, [
      {
        resourceGroupId: secondGroupId,
        startMode: "IMMEDIATE",
        startAt: pastStart,
        endAt
      }
    ]);
    expect(committed.reservations[0].startMode).toBe("IMMEDIATE");
    expect(committed.reservations[0].startAt >= serverMinute).toBe(true);
    expect(
      committed.reservations[0].startAt <= dbModule.currentMinuteIso()
    ).toBe(true);
    dbModule.db
      .prepare(
        "UPDATE reservations SET status = 'CANCELLED' WHERE id = ?"
      )
      .run(committed.reservations[0].id);
  });

  it("允许首尾相接，但拒绝真实重叠", () => {
    const startAt = futureIso(120);
    const endAt = futureIso(180);
    scheduling.commitReservationBatch(userId, [
      { resourceGroupId: firstGroupId, startAt, endAt }
    ]);

    const adjacent = scheduling.previewSegments([
      { resourceGroupId: firstGroupId, startAt: endAt, endAt: futureIso(240) }
    ]);
    expect(adjacent[0].available).toBe(true);

    const overlap = scheduling.previewSegments([
      { resourceGroupId: firstGroupId, startAt: futureIso(150), endAt: futureIso(210) }
    ]);
    expect(overlap[0].available).toBe(false);
    expect(overlap[0].conflicts[0].type).toBe("RESERVATION");
  });

  it("按最大连续空闲区间拆分且不落库", () => {
    const preview = scheduling.previewSegments([
      { resourceGroupId: firstGroupId, startAt: futureIso(90), endAt: futureIso(210) }
    ]);
    expect(preview[0].splitSegments).toHaveLength(2);
    expect(preview[0].splitSegments[0].endAt).toBe(futureIso(120));
    expect(preview[0].splitSegments[1].startAt).toBe(futureIso(180));
  });

  it("整机占用与机器内任意资源组双向互斥", () => {
    const machineStart = futureIso(500);
    const machineEnd = futureIso(560);
    const committed = scheduling.commitReservationBatch(userId, [
      {
        scope: "MACHINE",
        machineId,
        resourceGroupId: firstGroupId,
        startAt: machineStart,
        endAt: machineEnd
      }
    ]);
    expect(committed.reservations[0].scope).toBe("MACHINE");

    const otherGroup = scheduling.previewSegments([
      {
        resourceGroupId: secondGroupId,
        startAt: futureIso(520),
        endAt: futureIso(540)
      }
    ]);
    expect(otherGroup[0].available).toBe(false);

    scheduling.commitReservationBatch(userId, [
      {
        resourceGroupId: secondGroupId,
        startAt: futureIso(620),
        endAt: futureIso(680)
      }
    ]);
    const blockedMachine = scheduling.previewSegments([
      {
        scope: "MACHINE",
        machineId,
        resourceGroupId: firstGroupId,
        startAt: futureIso(600),
        endAt: futureIso(700)
      }
    ]);
    expect(blockedMachine[0].available).toBe(false);
    expect(blockedMachine[0].splitSegments).toHaveLength(2);
  });

  it("一次提交中任一时段冲突时全部不生效", () => {
    const before = (
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM reservations").get() as {
        count: number;
      }
    ).count;
    expect(() =>
      scheduling.commitReservationBatch(userId, [
        {
          resourceGroupId: secondGroupId,
          startAt: futureIso(300),
          endAt: futureIso(360)
        },
        {
          resourceGroupId: firstGroupId,
          startAt: futureIso(150),
          endAt: futureIso(160)
        }
      ])
    ).toThrow("资源可用情况已更新");
    const after = (
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM reservations").get() as {
        count: number;
      }
    ).count;
    expect(after).toBe(before);
  });

  it("拒绝同一次提交中同一资源组的内部重叠", () => {
    expect(() =>
      scheduling.commitReservationBatch(userId, [
        {
          resourceGroupId: secondGroupId,
          startAt: futureIso(400),
          endAt: futureIso(450)
        },
        {
          resourceGroupId: secondGroupId,
          startAt: futureIso(440),
          endAt: futureIso(470)
        }
      ])
    ).toThrow("同一资源组存在重叠的占用时段");
  });

  it("拒绝在同一次提交中混合整机与资源组占用", () => {
    expect(() =>
      scheduling.commitReservationBatch(userId, [
        {
          scope: "MACHINE",
          machineId,
          resourceGroupId: firstGroupId,
          startAt: futureIso(720),
          endAt: futureIso(760)
        },
        {
          scope: "RESOURCE_GROUP",
          machineId,
          resourceGroupId: secondGroupId,
          startAt: futureIso(780),
          endAt: futureIso(820)
        }
      ])
    ).toThrow("整机占用和资源组占用不能同时提交");
  });

  it("进行中的占用可以修改填写信息但不能修改时间", () => {
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const now = dbModule.nowIso();
    const startAtDate = new Date(Date.now() - 10 * 60_000);
    startAtDate.setUTCSeconds(0, 0);
    const startAt = startAtDate.toISOString();
    const endAt = futureIso(40);
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, userId, now);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, resource_group_id, machine_id, user_id, start_at, end_at,
          initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'Group-A', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        firstGroupId,
        machineId,
        userId,
        startAt,
        endAt,
        startAt,
        endAt,
        now,
        now
      );

    scheduling.updateReservation(reservationId, userId, {
      scope: "RESOURCE_GROUP",
      machineId,
      resourceGroupId: firstGroupId,
      startAt,
      endAt,
      title: "更新后的标题",
      purpose: "进行中补充用途",
      note: ""
    });
    expect(
      dbModule.db
        .prepare("SELECT title, purpose FROM reservations WHERE id = ?")
        .get(reservationId)
    ).toEqual({
      title: "更新后的标题",
      purpose: "进行中补充用途"
    });
    expect(() =>
      scheduling.updateReservation(reservationId, userId, {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: firstGroupId,
        startAt,
        endAt: futureIso(50)
      })
    ).toThrow("已经开始的占用不能修改时间");
  });

  it("进行中的占用可提前结束，且释放后触发完整时段订阅", () => {
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const now = dbModule.nowIso();
    const startAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const endAt = futureIso(30);
    dbModule.db
      .prepare("INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)")
      .run(batchId, userId, now);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, resource_group_id, machine_id, user_id, start_at, end_at,
          initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'Group-B', ?, 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        secondGroupId,
        machineId,
        userId,
        startAt,
        endAt,
        startAt,
        endAt,
        JSON.stringify([{
          poolId,
          poolName: "逻辑核",
          kind: "INDEX_RANGE",
          unit: "核",
          ranges: [{ start: 16, end: 31 }]
        }]),
        now,
        now
      );
    scheduling.endReservationEarly(reservationId, userId);

    const reservation = dbModule.db
      .prepare("SELECT initial_end_at, end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { initial_end_at: string; end_at: string };
    expect(reservation.initial_end_at).toBe(endAt);
    expect(new Date(reservation.end_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(new Date(reservation.end_at).getUTCSeconds()).toBe(0);
    expect(new Date(reservation.end_at).getUTCMilliseconds()).toBe(0);
  });

  it("开始不足一分钟时撤销占用记录并清理空批次", () => {
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const createdAt = dbModule.nowIso();
    const startAt = new Date(Date.now() - 10_000).toISOString();
    const endAt = futureIso(40);
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, userId, createdAt);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, resource_group_id, machine_id, user_id, start_at, end_at,
          initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'Group-A', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        firstGroupId,
        machineId,
        userId,
        startAt,
        endAt,
        startAt,
        endAt,
        createdAt,
        createdAt
      );

    expect(
      scheduling.endReservationEarly(reservationId, userId)
    ).toEqual({ removed: true });
    expect(
      dbModule.db
        .prepare("SELECT 1 FROM reservations WHERE id = ?")
        .get(reservationId)
    ).toBeUndefined();
    expect(
      dbModule.db
        .prepare("SELECT 1 FROM reservation_batches WHERE id = ?")
        .get(batchId)
    ).toBeUndefined();
    const audit = dbModule.db
      .prepare(
        `SELECT action, before_json, after_json
         FROM audit_logs
         WHERE entity_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(reservationId) as {
      action: string;
      before_json: string | null;
      after_json: string;
    };
    expect(audit.action).toBe("RESERVATION_WITHDRAW_FIRST_MINUTE");
    expect(audit.before_json).toBeNull();
    expect(JSON.parse(audit.after_json)).toMatchObject({
      machineId,
      resourceGroupId: firstGroupId,
      removedWithinFirstMinute: true
    });
  });

  it("rejects reservation boundaries that include seconds or milliseconds", () => {
    const startAt = new Date(futureIso(2_000));
    startAt.setUTCSeconds(30, 0);
    expect(() =>
      scheduling.previewSegments([
        {
          resourceGroupId: firstGroupId,
          startAt: startAt.toISOString(),
          endAt: futureIso(2_060)
        }
      ])
    ).toThrow();
  });

  it("atomically replaces a future reservation while the original remains the preview lock", () => {
    const original = scheduling.commitReservationBatch(userId, [
      {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: firstGroupId,
        startAt: futureIso(1000),
        endAt: futureIso(1060)
      }
    ]).reservations[0];
    const replacement = {
      scope: "RESOURCE_GROUP" as const,
      machineId,
      resourceGroupId: firstGroupId,
      startAt: futureIso(1010),
      endAt: futureIso(1080),
      title: "replacement"
    };

    expect(
      scheduling.previewReplacementSegments(userId, original.id, [replacement])[0]
        .available
    ).toBe(true);
    const result = scheduling.replaceReservationBatch(
      userId,
      original.id,
      [replacement]
    );

    const oldRow = dbModule.db
      .prepare("SELECT status FROM reservations WHERE id = ?")
      .get(original.id) as { status: string };
    expect(oldRow.status).toBe("CANCELLED");
    const newRow = dbModule.db
      .prepare(
        "SELECT parent_reservation_id, status FROM reservations WHERE id = ?"
      )
      .get(result.reservations[0].id) as {
      parent_reservation_id: string;
      status: string;
    };
    expect(newRow).toEqual({
      parent_reservation_id: original.id,
      status: "CONFIRMED"
    });
  });

  it("keeps the original reservation when a replacement conflicts", () => {
    const original = scheduling.commitReservationBatch(userId, [
      {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: firstGroupId,
        startAt: futureIso(1200),
        endAt: futureIso(1260)
      }
    ]).reservations[0];
    scheduling.commitReservationBatch(userId, [
      {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: secondGroupId,
        startAt: futureIso(1210),
        endAt: futureIso(1250)
      }
    ]);

    expect(() =>
      scheduling.replaceReservationBatch(userId, original.id, [
        {
          scope: "RESOURCE_GROUP",
          machineId,
          resourceGroupId: secondGroupId,
          startAt: futureIso(1215),
          endAt: futureIso(1245)
        }
      ])
    ).toThrow("原占用保持不变");
    const oldRow = dbModule.db
      .prepare("SELECT status FROM reservations WHERE id = ?")
      .get(original.id) as { status: string };
    expect(oldRow.status).toBe("CONFIRMED");
    const children = dbModule.db
      .prepare(
        "SELECT COUNT(*) AS count FROM reservations WHERE parent_reservation_id = ?"
      )
      .get(original.id) as { count: number };
    expect(children.count).toBe(0);
  });

  it("does not allow replacement drafts to change reservation scope", () => {
    const original = scheduling.commitReservationBatch(userId, [
      {
        scope: "MACHINE",
        machineId,
        resourceGroupId: firstGroupId,
        startAt: futureIso(1400),
        endAt: futureIso(1460)
      }
    ]).reservations[0];
    expect(() =>
      scheduling.previewReplacementSegments(userId, original.id, [
        {
          scope: "RESOURCE_GROUP",
          machineId,
          resourceGroupId: firstGroupId,
          startAt: futureIso(1400),
          endAt: futureIso(1460)
        }
      ])
    ).toThrow("整机占用只能继续按整机模式编辑");
  });

  it("preserves the elapsed portion when replacing an active reservation", () => {
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const createdAt = dbModule.nowIso();
    const startAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const originalEndAt = futureIso(60);
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, userId, createdAt);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, scope, resource_group_id, machine_id, user_id,
          start_at, end_at, initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, 'RESOURCE_GROUP', ?, ?, ?, ?, ?, ?, ?,
          'Group-A', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        secondGroupId,
        machineId,
        userId,
        startAt,
        originalEndAt,
        startAt,
        originalEndAt,
        createdAt,
        createdAt
      );

    const result = scheduling.replaceReservationBatch(userId, reservationId, [
      {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: secondGroupId,
        startAt: futureIso(1),
        endAt: futureIso(50)
      }
    ]);
    const oldRow = dbModule.db
      .prepare(
        "SELECT status, end_at, adjustment_type FROM reservations WHERE id = ?"
      )
      .get(reservationId) as {
      status: string;
      end_at: string;
      adjustment_type: string;
    };
    expect(oldRow.status).toBe("CONFIRMED");
    expect(oldRow.adjustment_type).toBe("USER_REPLACED");
    expect(new Date(oldRow.end_at).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const child = dbModule.db
      .prepare("SELECT parent_reservation_id FROM reservations WHERE id = ?")
      .get(result.reservations[0].id) as { parent_reservation_id: string };
    expect(child.parent_reservation_id).toBe(reservationId);
  });

  it("keeps an active reservation and its replacement exactly adjacent", () => {
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const isolatedGroupId = randomUUID();
    const isolatedAllocationId = randomUUID();
    const createdAt = dbModule.nowIso();
    const startAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const originalEndAt = futureIso(60);
    dbModule.db
      .prepare(
        `INSERT INTO resource_groups(
          id, machine_id, name, created_at, updated_at
        ) VALUES(?, ?, 'Group-Isolated', ?, ?)`
      )
      .run(isolatedGroupId, machineId, createdAt, createdAt);
    dbModule.db
      .prepare(
        `INSERT INTO resource_group_allocations(
          id, resource_group_id, resource_pool_id, kind
        ) VALUES(?, ?, ?, 'INDEX_RANGE')`
      )
      .run(isolatedAllocationId, isolatedGroupId, poolId);
    dbModule.db
      .prepare(
        `INSERT INTO resource_group_allocation_ranges(
          id, allocation_id, range_start, range_end
        ) VALUES(?, ?, 32, 47)`
      )
      .run(randomUUID(), isolatedAllocationId);
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, userId, createdAt);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, scope, resource_group_id, machine_id, user_id,
          start_at, end_at, initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, 'RESOURCE_GROUP', ?, ?, ?, ?, ?, ?, ?,
          'Group-A', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        isolatedGroupId,
        machineId,
        userId,
        startAt,
        originalEndAt,
        startAt,
        originalEndAt,
        createdAt,
        createdAt
      );

    const currentMinute = new Date(
      Math.floor(Date.now() / 60_000) * 60_000
    ).toISOString();
    const result = scheduling.replaceReservationBatch(userId, reservationId, [
      {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: isolatedGroupId,
        startAt: currentMinute,
        endAt: futureIso(50)
      }
    ]);
    const oldRow = dbModule.db
      .prepare("SELECT end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { end_at: string };
    const childRow = dbModule.db
      .prepare("SELECT start_at FROM reservations WHERE id = ?")
      .get(result.reservations[0].id) as { start_at: string };
    expect(childRow.start_at).toBe(oldRow.end_at);
  });

  it("creates future drafts as a new batch when the original ended during submission", () => {
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const createdAt = dbModule.nowIso();
    const startAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const endAt = new Date(Date.now() - 10 * 60_000).toISOString();
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, userId, createdAt);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, scope, resource_group_id, machine_id, user_id,
          start_at, end_at, initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, 'RESOURCE_GROUP', ?, ?, ?, ?, ?, ?, ?,
          'Group-B', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        secondGroupId,
        machineId,
        userId,
        startAt,
        endAt,
        startAt,
        endAt,
        createdAt,
        createdAt
      );

    const result = scheduling.replaceReservationBatch(userId, reservationId, [
      {
        scope: "RESOURCE_GROUP",
        machineId,
        resourceGroupId: secondGroupId,
        startAt: futureIso(70),
        endAt: futureIso(100)
      }
    ]);
    const oldRow = dbModule.db
      .prepare(
        "SELECT status, start_at, end_at, adjustment_type FROM reservations WHERE id = ?"
      )
      .get(reservationId) as {
      status: string;
      start_at: string;
      end_at: string;
      adjustment_type: string | null;
    };
    expect(oldRow).toEqual({
      status: "CONFIRMED",
      start_at: startAt,
      end_at: endAt,
      adjustment_type: null
    });
    const child = dbModule.db
      .prepare(
        "SELECT status, parent_reservation_id FROM reservations WHERE id = ?"
      )
      .get(result.reservations[0].id) as {
      status: string;
      parent_reservation_id: string;
    };
    expect(child).toEqual({
      status: "CONFIRMED",
      parent_reservation_id: reservationId
    });
  });
});
