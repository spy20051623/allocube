import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-machine-access-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "machine-access.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "machine-access-test-session-secret-at-least-32";

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import("../server/db.js");
let scheduling: typeof import("../server/scheduling.js");
let adminCookie = "";
let managerCookie = "";
let memberCookie = "";
let machineId = "";
let poolId = "";
let groupId = "";
let managerId = "";
let applicantId = "";
let invitedId = "";

async function loginCookie(username: string, password = "ValidPassword123!") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifierType: "USERNAME", identifier: username, password }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}

function futureIso(minutes: number) {
  const date = new Date(Date.now() + minutes * 60_000);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  const authModule = await import("../server/auth.js");
  scheduling = await import("../server/scheduling.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerScheduleRoutes } = await import("../server/routes-schedule.js");
  const { registerAdminRoutes } = await import("../server/routes-admin.js");
  await dbModule.initializeDatabase();

  const admin = dbModule.db
    .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN'")
    .get() as { id: string };
  const passwordHash = await authModule.hashPassword("ValidPassword123!");
  const now = dbModule.nowIso();
  const people = [
    ["machine-manager", "机器管理员", "10004001"],
    ["access-applicant", "申请用户", "10004002"],
    ["invited-user", "受邀用户", "10004003"]
  ] as const;
  const insertUser = dbModule.db.prepare(
    `INSERT INTO users(
      id, username, username_normalized, email, display_name, password_hash,
      role, status, approved_at, approved_by, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'USER', 'ACTIVE', ?, ?, ?, ?)`
  );
  const insertNumber = dbModule.db.prepare(
    `INSERT INTO employee_numbers(
      id, user_id, employee_number, status, assigned_by, assigned_at, updated_at
    ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
  );
  const ids: string[] = [];
  for (const [username, displayName, employeeNumber] of people) {
    const id = randomUUID();
    ids.push(id);
    insertUser.run(
      id,
      username,
      username,
      `${username}@example.com`,
      displayName,
      passwordHash,
      now,
      admin.id,
      now,
      now
    );
    insertNumber.run(randomUUID(), id, employeeNumber, admin.id, now, now);
  }
  [managerId, applicantId, invitedId] = ids;

  machineId = randomUUID();
  poolId = randomUUID();
  groupId = randomUUID();
  dbModule.db
    .prepare(
      `INSERT INTO machines(
        id, name, address, management_notes,
        created_at, updated_at
      ) VALUES(?, 'Access-Test-Machine', '10.40.0.12',
        '仅管理员可见的运维信息', ?, ?)`
    )
    .run(machineId, now, now);
  dbModule.db.prepare(
    `INSERT INTO resource_pools(
      id, machine_id, name, kind, unit, range_start, range_end, created_at, updated_at
    ) VALUES(?, ?, '逻辑核', 'INDEX_RANGE', '核', 0, 31, ?, ?)`
  ).run(poolId, machineId, now, now);
  dbModule.db
    .prepare(
      `INSERT INTO resource_groups(
        id, machine_id, name, created_at, updated_at
      ) VALUES(?, ?, 'Access-Group', ?, ?)`
    )
    .run(groupId, machineId, now, now);
  const allocationId = randomUUID();
  dbModule.db.prepare(
    `INSERT INTO resource_group_allocations(
      id, resource_group_id, resource_pool_id, kind
    ) VALUES(?, ?, ?, 'INDEX_RANGE')`
  ).run(allocationId, groupId, poolId);
  dbModule.db.prepare(
    `INSERT INTO resource_group_allocation_ranges(
      id, allocation_id, range_start, range_end
    ) VALUES(?, ?, 0, 7)`
  ).run(randomUUID(), allocationId);
  dbModule.db
    .prepare(
      `INSERT INTO machine_access_memberships(
        id, machine_id, user_id, source, granted_by, created_at, updated_at
      ) VALUES(?, ?, ?, 'ADMIN_INVITE', ?, ?, ?)`
    )
    .run(randomUUID(), machineId, managerId, admin.id, now, now);
  dbModule.db
    .prepare(
      `INSERT INTO machine_admins(machine_id, user_id, assigned_by, created_at)
       VALUES(?, ?, ?, ?)`
    )
    .run(machineId, managerId, admin.id, now);

  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  registerAuthRoutes(app);
  registerScheduleRoutes(app, () => undefined);
  registerAdminRoutes(app, () => undefined);
  await app.ready();
  adminCookie = await loginCookie("Administrator", "Admin12#$");
  managerCookie = await loginCookie("machine-manager");
  memberCookie = await loginCookie("access-applicant");
});

describe("机器使用权与管理员专用信息", () => {
  it("无权限用户只能看机器目录，不能读取时间轴和管理备注", async () => {
    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/machines/catalog",
      headers: { cookie: memberCookie }
    });
    expect(catalog.statusCode).toBe(200);
    const machine = catalog.json().machines.find((item: any) => item.id === machineId);
    expect(machine).toMatchObject({
      name: "Access-Test-Machine",
      address: "10.40.0.12",
      availabilityStatus: "ACTIVE",
      resourceSummary: "逻辑核 · 32 核",
      hasAccess: false,
      managers: [
        {
          displayName: "机器管理员",
          employeeNumber: "10004001"
        }
      ]
    });
    expect(machine).not.toHaveProperty("managementNotes");
    expect(machine.managers[0]).not.toHaveProperty("id");
    expect(machine.managers[0]).not.toHaveProperty("email");

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?from=${encodeURIComponent(
        futureIso(60)
      )}&to=${encodeURIComponent(futureIso(180))}`,
      headers: { cookie: memberCookie }
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().machines).toEqual([]);

    const machineOptions = await app.inject({
      method: "GET",
      url: "/api/v1/timeline/machines",
      headers: { cookie: memberCookie }
    });
    expect(machineOptions.statusCode).toBe(200);
    expect(machineOptions.json().machines).toEqual([]);

    const managementList = await app.inject({
      method: "GET",
      url: "/api/v1/admin/machines",
      headers: { cookie: memberCookie }
    });
    expect(managementList.statusCode).toBe(200);
    expect(managementList.json().machines).toEqual([]);

    const notes = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: memberCookie }
    });
    expect(notes.statusCode).toBe(403);
  });

  it("申请只能审批一次，过期审批返回冲突", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/machines/${machineId}/access-requests`,
      headers: { cookie: memberCookie },
      payload: { reason: "需要进行编译验证" }
    });
    expect(created.statusCode).toBe(201);
    const access = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/access`,
      headers: { cookie: managerCookie }
    });
    const firstRequest = access
      .json()
      .requests.find((item: any) => item.userId === applicantId);
    expect(firstRequest.reason).toBe("需要进行编译验证");
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machine-access/requests/${firstRequest.id}/reject`,
      headers: { cookie: managerCookie },
      payload: { expectedVersion: firstRequest.expectedVersion }
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare(
          `SELECT body FROM notifications
           WHERE user_id = ? AND type = 'MACHINE_ACCESS_REJECTED'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(applicantId)
    ).toEqual({
      body: "机器使用权申请未通过。"
    });

    const recreated = await app.inject({
      method: "POST",
      url: `/api/v1/machines/${machineId}/access-requests`,
      headers: { cookie: memberCookie },
      payload: {}
    });
    expect(recreated.statusCode).toBe(201);
    const refreshedAccess = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/access`,
      headers: { cookie: managerCookie }
    });
    const request = refreshedAccess
      .json()
      .requests.find((item: any) => item.id === recreated.json().id);
    expect(request.reason).toBe("");
    const machineList = await app.inject({
      method: "GET",
      url: "/api/v1/admin/machines",
      headers: { cookie: managerCookie }
    });
    const machineSummary = machineList
      .json()
      .machines.find((item: any) => item.id === machineId);
    expect(machineSummary.pendingAccessRequestCount).toBe(1);
    expect(machineSummary).not.toHaveProperty("hardwareNotes");
    expect(machineSummary).not.toHaveProperty("connectionGuide");
    expect(machineSummary).not.toHaveProperty("managementNotes");

    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machine-access/requests/${request.id}/approve`,
      headers: { cookie: managerCookie },
      payload: { expectedVersion: request.expectedVersion }
    });
    expect(approved.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machine-access/requests/${request.id}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: request.expectedVersion }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED");
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, applicantId)
    ).toEqual({ count: 1 });

    const unavailabilityId = randomUUID();
    dbModule.db
      .prepare(
        `INSERT INTO resource_unavailability(
          id, machine_id, resource_group_id, kind, start_at, end_at,
          reason, created_by, created_at
        ) VALUES(?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?)`
      )
      .run(
        unavailabilityId,
        machineId,
        null,
        futureIso(75),
        futureIso(90),
        "普通用户可见的停用原因",
        managerId,
        dbModule.nowIso()
      );

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?from=${encodeURIComponent(
        futureIso(60)
      )}&to=${encodeURIComponent(futureIso(180))}`,
      headers: { cookie: memberCookie }
    });
    const visibleMachine = timeline
      .json()
      .machines.find((item: any) => item.id === machineId);
    expect(visibleMachine).toBeTruthy();
    expect(visibleMachine).not.toHaveProperty("managementNotes");
    expect(timeline.json().unavailability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unavailabilityId,
          reason: "普通用户可见的停用原因"
        })
      ])
    );
    const viewerUnavailability = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/unavailability`,
      headers: { cookie: memberCookie }
    });
    expect(viewerUnavailability.statusCode).toBe(200);
    expect(viewerUnavailability.json().unavailability).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unavailabilityId,
          resourceGroupId: null,
          reason: "普通用户可见的停用原因"
        })
      ])
    );
    dbModule.db
      .prepare(
        "UPDATE resource_unavailability SET status = 'CANCELLED' WHERE id = ?"
      )
      .run(unavailabilityId);

    const machineOptions = await app.inject({
      method: "GET",
      url: "/api/v1/timeline/machines",
      headers: { cookie: memberCookie }
    });
    expect(machineOptions.statusCode).toBe(200);
    const option = machineOptions
      .json()
      .machines.find((item: any) => item.id === machineId);
    expect(option).toMatchObject({
      name: "Access-Test-Machine",
      address: "10.40.0.12",
      resourceSummary: "逻辑核 · 32 核",
      isManager: false
    });
    expect(option).not.toHaveProperty("managementNotes");
    expect(option).not.toHaveProperty("connectionGuide");

    const managementMachines = await app.inject({
      method: "GET",
      url: "/api/v1/admin/machines",
      headers: { cookie: memberCookie }
    });
    expect(managementMachines.statusCode).toBe(200);
    const readonlySummary = managementMachines
      .json()
      .machines.find((item: { id: string }) => item.id === machineId);
    expect(readonlySummary).toMatchObject({
      name: "Access-Test-Machine",
      canManage: false
    });
    expect(readonlySummary).not.toHaveProperty("version");
    expect(readonlySummary).not.toHaveProperty("pendingAccessRequestCount");

    const readonlyMachine = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: memberCookie }
    });
    expect(readonlyMachine.statusCode).toBe(200);
    expect(readonlyMachine.json().machine).toMatchObject({
      id: machineId,
      canManage: false
    });
    expect(readonlyMachine.json().machine).not.toHaveProperty("managementNotes");
    expect(readonlyMachine.json().machine).not.toHaveProperty("version");

    const readonlyGroups = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/groups`,
      headers: { cookie: memberCookie }
    });
    expect(readonlyGroups.statusCode).toBe(200);
    expect(readonlyGroups.json().groups[0]).not.toHaveProperty("version");

    const readonlyAccess = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/access`,
      headers: { cookie: memberCookie }
    });
    expect(readonlyAccess.statusCode).toBe(200);
    expect(readonlyAccess.json().requests).toEqual([]);
    expect(readonlyAccess.json()).not.toHaveProperty("accessRevision");
    expect(readonlyAccess.json().members[0]).not.toHaveProperty("id");
    expect(readonlyAccess.json().members[0]).not.toHaveProperty("impact");

    const forbiddenEdit = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: memberCookie },
      payload: {
        name: "不应生效",
        address: "",
        hardwareNotes: "",
        connectionGuide: "",
        managementNotes: "",
        tags: [],
        expectedVersion: 1
      }
    });
    expect(forbiddenEdit.statusCode).toBe(403);
  });

  it("管理员邀请立即加入，不生成待接受邀请", async () => {
    const invited = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/members`,
      headers: { cookie: managerCookie },
      payload: { userId: invitedId }
    });
    expect(invited.statusCode).toBe(201);
    expect(
      dbModule.db
        .prepare(
          "SELECT source FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, invitedId)
    ).toEqual({ source: "ADMIN_INVITE" });
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM machine_access_requests WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, invitedId)
    ).toEqual({ count: 0 });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/members`,
      headers: { cookie: managerCookie },
      payload: { userId: invitedId }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("MACHINE_MEMBER_ALREADY_EXISTS");
  });

  it("管理备注只进入管理端响应，审计不保存正文", async () => {
    const managed = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: managerCookie }
    });
    expect(managed.statusCode).toBe(200);
    expect(managed.json().machine.managementNotes).toBe("仅管理员可见的运维信息");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: managerCookie },
      payload: {
        name: "Access-Test-Machine",
        address: "",
        hardwareNotes: "",
        connectionGuide: "",
        managementNotes: "新的管理员专用说明",
        tags: [],
        expectedVersion: managed.json().machine.version
      }
    });
    expect(updated.statusCode).toBe(200);
    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: managerCookie },
      payload: {
        name: "Access-Test-Machine",
        address: "",
        hardwareNotes: "",
        connectionGuide: "",
        managementNotes: "不应覆盖的新内容",
        tags: [],
        expectedVersion: managed.json().machine.version
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("MACHINE_SETTINGS_STALE");
    const audit = dbModule.db
      .prepare(
        `SELECT before_json, after_json FROM audit_logs
         WHERE action = 'MACHINE_UPDATE' AND entity_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(machineId) as { before_json: string; after_json: string };
    expect(audit.before_json).not.toContain("仅管理员可见");
    expect(audit.after_json).not.toContain("新的管理员专用说明");
    expect(JSON.parse(audit.after_json).managementNotesChanged).toBe(true);
  });

  it("机器管理员可以释放所管理机器上的未来和进行中占用", async () => {
    const future = scheduling.commitReservationBatch(applicantId, [
      {
        resourceGroupId: groupId,
        startAt: futureIso(360),
        endAt: futureIso(420)
      }
    ]).reservations[0];
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/reservations/${future.id}/cancel`,
      headers: { cookie: managerCookie },
      payload: {}
    });
    expect(cancelled.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare("SELECT status, cancelled_by FROM reservations WHERE id = ?")
        .get(future.id)
    ).toEqual({
      status: "CANCELLED",
      cancelled_by: managerId
    });

    const batchId = randomUUID();
    const reservationId = randomUUID();
    const createdAt = dbModule.nowIso();
    const start = new Date(Date.now() - 10 * 60_000);
    start.setUTCSeconds(0, 0);
    const startAt = start.toISOString();
    const endAt = futureIso(30);
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, applicantId, createdAt);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, resource_group_id, machine_id, user_id, start_at, end_at,
          initial_start_at, initial_end_at,
          snapshot_group_name, snapshot_resource_config_json,
          snapshot_group_version, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 'Access-Group', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        groupId,
        machineId,
        applicantId,
        startAt,
        endAt,
        startAt,
        endAt,
        createdAt,
        createdAt
      );

    const invitedCookie = await loginCookie("invited-user");
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/reservations/${reservationId}/end`,
      headers: { cookie: invitedCookie },
      payload: {}
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toBe("无权释放此占用");

    const ended = await app.inject({
      method: "POST",
      url: `/api/v1/reservations/${reservationId}/end`,
      headers: { cookie: managerCookie },
      payload: {}
    });
    expect(ended.statusCode).toBe(200);
    const endedReservation = dbModule.db
      .prepare("SELECT end_at FROM reservations WHERE id = ?")
      .get(reservationId) as { end_at: string };
    expect(new Date(endedReservation.end_at).getTime()).toBeLessThanOrEqual(
      Date.now()
    );
    expect(
      dbModule.db
        .prepare(
          `SELECT title, body FROM notifications
           WHERE user_id = ? AND type = 'RESERVATION_RELEASED_BY_MANAGER'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(applicantId)
    ).toEqual({
      title: "占用已被管理员释放",
      body: "机器管理员释放了你的资源占用。"
    });
  });

  it("取消管理员保留使用权，移除成员会释放占用", async () => {
    const promote = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${machineId}/managers/${applicantId}`,
      headers: { cookie: adminCookie },
      payload: {}
    });
    expect(promote.statusCode).toBe(200);
    const demote = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/machines/${machineId}/managers/${applicantId}`,
      headers: { cookie: adminCookie }
    });
    expect(demote.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare(
          "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, applicantId)
    ).toBeTruthy();

    const startAt = futureIso(240);
    const endAt = futureIso(300);
    scheduling.commitReservationBatch(applicantId, [
      { resourceGroupId: groupId, startAt, endAt }
    ]);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/machines/${machineId}/members/${applicantId}`,
      headers: { cookie: managerCookie }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().impact).toMatchObject({
      futureReservations: 1
    });
    expect(
      dbModule.db
        .prepare(
          "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, applicantId)
    ).toBeUndefined();
    expect(
      dbModule.db
        .prepare(
          "SELECT status FROM reservations WHERE machine_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 1"
        )
        .get(machineId, applicantId)
    ).toEqual({ status: "CANCELLED" });
  });

  it("机器管理员可以自行卸任并退出，系统管理员不能退出", async () => {
    const adminExit = await app.inject({
      method: "DELETE",
      url: `/api/v1/machines/${machineId}/membership`,
      headers: { cookie: adminCookie }
    });
    expect(adminExit.statusCode).toBe(400);
    expect(adminExit.json().error).toBe("系统管理员不能退出全局机器权限");

    scheduling.commitReservationBatch(managerId, [
      {
        resourceGroupId: groupId,
        startAt: futureIso(500),
        endAt: futureIso(560)
      }
    ]);
    const selfExit = await app.inject({
      method: "DELETE",
      url: `/api/v1/machines/${machineId}/membership`,
      headers: { cookie: managerCookie }
    });
    expect(selfExit.statusCode).toBe(200);
    expect(selfExit.json().impact).toMatchObject({
      futureReservations: 1
    });
    expect(
      dbModule.db
        .prepare(
          "SELECT 1 FROM machine_admins WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, managerId)
    ).toBeUndefined();
    expect(
      dbModule.db
        .prepare(
          "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(machineId, managerId)
    ).toBeUndefined();

    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/machines/catalog",
      headers: { cookie: managerCookie }
    });
    expect(
      catalog.json().machines.find((item: any) => item.id === machineId)
    ).toMatchObject({
      hasAccess: false,
      isManager: false
    });
    const managed = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: managerCookie }
    });
    expect(managed.statusCode).toBe(403);

    const auditActions = (
      dbModule.db
        .prepare(
          `SELECT action FROM audit_logs
           WHERE actor_user_id = ? AND entity_id = ?
             AND action IN ('MACHINE_ADMIN_REMOVE', 'MACHINE_MEMBER_REMOVE')
           ORDER BY created_at`
        )
        .all(managerId, machineId) as Array<{ action: string }>
    ).map((item) => item.action);
    expect(auditActions).toContain("MACHINE_ADMIN_REMOVE");
    expect(auditActions).toContain("MACHINE_MEMBER_REMOVE");
  });

  it("统一维护接口可以管理整机和资源组维护", async () => {
    const groupPreview = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/maintenance/preview`,
      headers: { cookie: adminCookie },
      payload: {
        resourceGroupId: groupId,
        startAt: futureIso(500),
        endAt: futureIso(520)
      }
    });
    expect(groupPreview.statusCode).toBe(200);
    const groupCreated = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/maintenance`,
      headers: { cookie: adminCookie },
      payload: {
        resourceGroupId: groupId,
        startAt: futureIso(500),
        endAt: futureIso(520),
        reason: "资源组维护测试",
        expectedRevision: groupPreview.json().revision
      }
    });
    expect(groupCreated.statusCode).toBe(201);

    const machinePreview = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/maintenance/preview`,
      headers: { cookie: adminCookie },
      payload: {
        resourceGroupId: null,
        startAt: futureIso(540),
        endAt: futureIso(560)
      }
    });
    expect(machinePreview.statusCode).toBe(200);
    const machineCreated = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/maintenance`,
      headers: { cookie: adminCookie },
      payload: {
        resourceGroupId: null,
        startAt: futureIso(540),
        endAt: futureIso(560),
        reason: "整机维护测试",
        expectedRevision: machinePreview.json().revision
      }
    });
    expect(machineCreated.statusCode).toBe(201);

    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/maintenance`,
      headers: { cookie: adminCookie }
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().maintenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: groupCreated.json().id,
          resourceGroupId: groupId,
          resourceGroupName: "Access-Group",
          reason: "资源组维护测试"
        }),
        expect.objectContaining({
          id: machineCreated.json().id,
          resourceGroupId: null,
          reason: "整机维护测试"
        })
      ])
    );

    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/maintenance/preview`,
      headers: { cookie: memberCookie },
      payload: {
        resourceGroupId: null,
        startAt: futureIso(600),
        endAt: futureIso(620)
      }
    });
    expect(forbidden.statusCode).toBe(403);

    for (const id of [groupCreated.json().id, machineCreated.json().id]) {
      const cancelled = await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/maintenance/${id}`,
        headers: { cookie: adminCookie }
      });
      expect(cancelled.statusCode).toBe(200);
    }
  });

  it("资源组长期停用后可以重新启用，删除必须单独执行", async () => {
    const lifecycleGroupId = randomUUID();
    const now = dbModule.nowIso();
    const admin = dbModule.db
      .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN'")
      .get() as { id: string };
    dbModule.db
      .prepare(
      `INSERT INTO resource_groups(
          id, machine_id, name, created_at, updated_at
        ) VALUES(?, ?, 'Lifecycle-Group', ?, ?)`
      )
      .run(lifecycleGroupId, machineId, now, now);
    const allocationId = randomUUID();
    dbModule.db.prepare(
      `INSERT INTO resource_group_allocations(
        id, resource_group_id, resource_pool_id, kind
      ) VALUES(?, ?, ?, 'INDEX_RANGE')`
    ).run(allocationId, lifecycleGroupId, poolId);
    dbModule.db.prepare(
      `INSERT INTO resource_group_allocation_ranges(
        id, allocation_id, range_start, range_end
      ) VALUES(?, ?, 8, 15)`
    ).run(randomUUID(), allocationId);
    scheduling.commitReservationBatch(admin.id, [{
      resourceGroupId: lifecycleGroupId,
      startAt: futureIso(1_000),
      endAt: futureIso(1_060)
    }]);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/admin/groups/${lifecycleGroupId}/disable`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: 1,
        expectedRevision: dbModule.getScheduleRevision()
      }
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json().status).toBe("DISABLED");
    expect(
      dbModule.db
        .prepare("SELECT status FROM resource_groups WHERE id = ?")
        .get(lifecycleGroupId)
    ).toEqual({ status: "DISABLED" });

    const enabled = await app.inject({
      method: "POST",
      url: `/api/v1/admin/groups/${lifecycleGroupId}/enable`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: 2 }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json().status).toBe("ACTIVE");

    await app.inject({
      method: "POST",
      url: `/api/v1/admin/groups/${lifecycleGroupId}/disable`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: 3,
        expectedRevision: dbModule.getScheduleRevision()
      }
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/groups/${lifecycleGroupId}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: 4 }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deleted).toBe(true);
    expect(
      dbModule.db
        .prepare(
          "SELECT resource_group_id FROM deleted_resource_group_tombstones WHERE resource_group_id = ?"
        )
        .get(lifecycleGroupId)
    ).toEqual({ resource_group_id: lifecycleGroupId });
    expect(
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM reservations WHERE resource_group_id = ?")
        .get(lifecycleGroupId)
    ).toEqual({ count: 1 });
    const history = await app.inject({
      method: "GET",
      url: "/api/v1/reservations/mine",
      headers: { cookie: adminCookie }
    });
    expect(history.statusCode).toBe(200);
    expect(
      history.json().reservations.find(
        (reservation: { resourceGroupId: string }) =>
          reservation.resourceGroupId === lifecycleGroupId
      )
    ).toMatchObject({
      resourceGroupName: "资源组已删除",
      snapshotGroupName: "资源组已删除",
      currentResourceSummary: "资源已删除",
      resourceGroupDeleted: true
    });

    const cannotRestoreDeleted = await app.inject({
      method: "POST",
      url: `/api/v1/admin/groups/${lifecycleGroupId}/enable`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: 5 }
    });
    expect(cannotRestoreDeleted.statusCode).toBe(404);
  });

  it("整机只有长期停用后才能由系统管理员永久删除", async () => {
    const activeMachine = dbModule.db
      .prepare("SELECT version FROM machines WHERE id = ?")
      .get(machineId) as { version: number };
    const managerDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: managerCookie },
      payload: { expectedVersion: activeMachine.version }
    });
    expect(managerDelete.statusCode).toBe(403);

    const activeDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: activeMachine.version }
    });
    expect(activeDelete.statusCode).toBe(409);

    const disabled = await app.inject({
      method: "POST",
      url: `/api/v1/admin/machines/${machineId}/disable`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: activeMachine.version,
        expectedRevision: dbModule.getScheduleRevision(),
        reason: ""
      }
    });
    expect(disabled.statusCode).toBe(200);

    const disabledTimelineMachines = await app.inject({
      method: "GET",
      url: "/api/v1/timeline/machines",
      headers: { cookie: adminCookie }
    });
    expect(disabledTimelineMachines.statusCode).toBe(200);
    expect(
      disabledTimelineMachines.json().machines.find(
        (machine: { id: string }) => machine.id === machineId
      )
    ).toMatchObject({
      id: machineId,
      status: "DISABLED"
    });

    const disabledTimeline = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?from=${encodeURIComponent(
        new Date(Date.now() - 60_000).toISOString()
      )}&to=${encodeURIComponent(
        new Date(Date.now() + 60 * 60_000).toISOString()
      )}`,
      headers: { cookie: adminCookie }
    });
    expect(disabledTimeline.statusCode).toBe(200);
    expect(
      disabledTimeline.json().machines.find(
        (machine: { id: string }) => machine.id === machineId
      )
    ).toMatchObject({
      id: machineId,
      status: "DISABLED"
    });
    expect(
      disabledTimeline.json().groups.some(
        (group: { machineId: string }) => group.machineId === machineId
      )
    ).toBe(true);

    const disabledMachine = dbModule.db
      .prepare("SELECT version FROM machines WHERE id = ?")
      .get(machineId) as { version: number };
    const impact = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/deletion-impact`,
      headers: { cookie: adminCookie }
    });
    expect(impact.statusCode).toBe(200);
    expect(impact.json().counts.resourceGroups).toBeGreaterThan(0);
    expect(impact.json().counts.members).toBeGreaterThan(0);

    const staleDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: disabledMachine.version - 1 }
    });
    expect(staleDelete.statusCode).toBe(409);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/machines/${machineId}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: disabledMachine.version }
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      dbModule.db.prepare("SELECT name FROM machines WHERE id = ?").get(machineId)
    ).toEqual({ name: `deleted-${machineId}` });
    expect(
      dbModule.db
        .prepare(
          "SELECT machine_id FROM deleted_machine_tombstones WHERE machine_id = ?"
        )
        .get(machineId)
    ).toEqual({ machine_id: machineId });
    expect(
      dbModule.db
        .prepare(
          `SELECT COUNT(*) AS count FROM resource_groups rg
           WHERE rg.machine_id = ?
             AND NOT EXISTS (
               SELECT 1 FROM deleted_resource_group_tombstones drgt
               WHERE drgt.resource_group_id = rg.id
             )`
        )
        .get(machineId)
    ).toEqual({ count: 0 });
    expect(
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM reservations WHERE machine_id = ?")
        .get(machineId)
    ).toEqual(expect.objectContaining({ count: expect.any(Number) }));
    expect(
      (
        dbModule.db
          .prepare("SELECT COUNT(*) AS count FROM reservations WHERE machine_id = ?")
          .get(machineId) as { count: number }
      ).count
    ).toBeGreaterThan(0);

    const currentMachines = await app.inject({
      method: "GET",
      url: "/api/v1/admin/machines",
      headers: { cookie: adminCookie }
    });
    expect(currentMachines.statusCode).toBe(200);
    expect(
      currentMachines.json().machines.some(
        (machine: { id: string }) => machine.id === machineId
      )
    ).toBe(false);

    const managerHistory = await app.inject({
      method: "GET",
      url: "/api/v1/reservations/mine",
      headers: { cookie: managerCookie }
    });
    expect(managerHistory.statusCode).toBe(200);
    expect(
      managerHistory.json().reservations.find(
        (reservation: { machineId: string }) => reservation.machineId === machineId
      )
    ).toMatchObject({
      machineName: "机器已删除",
      resourceGroupName: "资源组已删除",
      currentResourceSummary: "资源已删除",
      machineDeleted: true,
      resourceGroupDeleted: true
    });

    const audit = await app.inject({
      method: "GET",
      url: "/api/v1/admin/audit",
      headers: { cookie: adminCookie }
    });
    expect(audit.statusCode).toBe(200);
    expect(
      audit.json().logs.find(
        (log: { action: string; entityId: string }) =>
          log.action === "MACHINE_DELETE" && log.entityId === machineId
      )
    ).toMatchObject({
      entityName: "机器已删除",
      before: null,
      after: null
    });
    expect(
      dbModule.db
        .prepare("SELECT action FROM audit_logs WHERE entity_type = 'machine' AND entity_id = ?")
        .all(machineId)
    ).toEqual(expect.arrayContaining([{ action: "MACHINE_DELETE" }]));
    expect(dbModule.db.pragma("foreign_key_check")).toEqual([]);
  });
});
