import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-model-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "resources.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "resource-model-test-session-secret-at-least-32";

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import("../server/db.js");
let cookieHeader = "";
let machineId = "";
let rangePoolId = "";
let itemPoolId = "";
let capacityPoolId = "";
let groupId = "";
let reusedGroupId = "";

async function post(pathname: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url: `/api/v1${pathname}`,
    headers: { cookie: cookieHeader },
    payload
  });
}

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerScheduleRoutes } = await import("../server/routes-schedule.js");
  const { registerAdminRoutes } = await import("../server/routes-admin.js");
  await dbModule.initializeDatabase();
  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  registerAuthRoutes(app);
  registerScheduleRoutes(app, () => undefined);
  registerAdminRoutes(app, () => undefined);
  await app.ready();

  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      identifierType: "USERNAME",
      identifier: "Administrator",
      password: "Admin12#$"
    }
  });
  expect(login.statusCode).toBe(200);
  cookieHeader = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

  machineId = randomUUID();
  const now = dbModule.nowIso();
  dbModule.db.prepare(
    `INSERT INTO machines(id, name, created_at, updated_at)
     VALUES(?, '通用资源测试机', ?, ?)`
  ).run(machineId, now, now);
});

describe("通用资源配置", () => {
  it("资源组摘要使用分段格式并保留资源配置顺序", async () => {
    const { resourceAllocationSummary } = await import("../server/resources.js");
    expect(resourceAllocationSummary([
      {
        poolId: "memory",
        poolName: "内存",
        kind: "CAPACITY",
        sharingMode: "SHARED",
        unit: "GiB",
        quantity: 512
      },
      {
        poolId: "cpu",
        poolName: "逻辑核",
        kind: "INDEX_RANGE",
        sharingMode: "EXCLUSIVE",
        unit: "核",
        ranges: [
          { start: 0, end: 31, label: "NUMA 0" },
          { start: 64, end: 79, label: "NUMA 1" }
        ]
      }
    ])).toBe(
      "共享 · 内存 · 512 GiB ｜ 逻辑核 · 0–31 NUMA 0 · 64–79 NUMA 1"
    );
  });

  it("创建编号、设备和容量资源项", async () => {
    const range = await post(`/admin/machines/${machineId}/resource-pools`, {
      name: "逻辑核",
      kind: "INDEX_RANGE",
      unit: "核",
      description: "",
      sortOrder: 1,
      rangeStart: 0,
      rangeEnd: 63
    });
    expect(range.statusCode).toBe(201);
    rangePoolId = range.json().id;

    const items = await post(`/admin/machines/${machineId}/resource-pools`, {
      name: "GPU",
      kind: "ITEM_LIST",
      unit: "张",
      description: "",
      sortOrder: 2,
      items: [
        { key: "GPU 0", label: "NVIDIA A100 0" },
        { key: "GPU 1", label: "NVIDIA A100 1" }
      ]
    });
    expect(items.statusCode).toBe(201);
    itemPoolId = items.json().id;

    const capacity = await post(`/admin/machines/${machineId}/resource-pools`, {
      name: "显存",
      kind: "CAPACITY",
      unit: "GiB",
      description: "",
      sortOrder: 3,
      capacity: 10.125
    });
    expect(capacity.statusCode).toBe(201);
    capacityPoolId = capacity.json().id;

    const result = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machineId}/resource-pools`,
      headers: { cookie: cookieHeader }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().pools.map((pool: { kind: string }) => pool.kind)).toEqual([
      "INDEX_RANGE",
      "ITEM_LIST",
      "CAPACITY"
    ]);
    expect(result.json().pools[2].capacity).toBe(10.125);
    expect(result.json().pools.every(
      (pool: { sharingMode: string }) => pool.sharingMode === "EXCLUSIVE"
    )).toBe(true);
  });

  it("共享容量可以被多个资源组同时引用并展示共享标记", async () => {
    const sharedMachineId = randomUUID();
    const sharedRangePoolId = randomUUID();
    const sharedItemPoolId = randomUUID();
    const sharedItemId = randomUUID();
    const sharedPoolId = randomUUID();
    const firstGroupId = randomUUID();
    const secondGroupId = randomUUID();
    const now = dbModule.nowIso();
    dbModule.db.prepare(
      `INSERT INTO machines(id, name, created_at, updated_at)
       VALUES(?, '共享资源测试机', ?, ?)`
    ).run(sharedMachineId, now, now);

    const response = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${sharedMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: {
        pools: [
          {
            id: sharedRangePoolId,
            expectedVersion: 0,
            name: "共享编号",
            kind: "INDEX_RANGE",
            sharingMode: "SHARED",
            unit: "号",
            description: "",
            sortOrder: 0,
            rangeStart: 0,
            rangeEnd: 7
          },
          {
            id: sharedItemPoolId,
            expectedVersion: 0,
            name: "共享设备",
            kind: "ITEM_LIST",
            sharingMode: "SHARED",
            unit: "台",
            description: "",
            sortOrder: 1,
            items: [{
              id: sharedItemId,
              key: "设备 0",
              label: "共享设备"
            }]
          },
          {
            id: sharedPoolId,
            expectedVersion: 0,
            name: "内存",
            kind: "CAPACITY",
            sharingMode: "SHARED",
            unit: "GiB",
            description: "",
            sortOrder: 2,
            capacity: 512
          }
        ],
        groups: [
          {
            id: firstGroupId,
            expectedVersion: 0,
            name: "共享组 A",
            description: "",
            tags: [],
            sortOrder: 1,
            allocations: [
              {
                poolId: sharedRangePoolId,
                kind: "INDEX_RANGE",
                ranges: [{ start: 0, end: 3 }]
              },
              {
                poolId: sharedItemPoolId,
                kind: "ITEM_LIST",
                itemIds: [sharedItemId]
              },
              {
                poolId: sharedPoolId,
                kind: "CAPACITY",
                quantity: 512
              }
            ]
          },
          {
            id: secondGroupId,
            expectedVersion: 0,
            name: "共享组 B",
            description: "",
            tags: [],
            sortOrder: 0,
            allocations: [
              {
                poolId: sharedRangePoolId,
                kind: "INDEX_RANGE",
                ranges: [{ start: 0, end: 3 }]
              },
              {
                poolId: sharedItemPoolId,
                kind: "ITEM_LIST",
                itemIds: [sharedItemId]
              },
              {
                poolId: sharedPoolId,
                kind: "CAPACITY",
                quantity: 512
              }
            ]
          }
        ]
      }
    });
    expect(response.statusCode).toBe(200);

    const groups = (
      await app.inject({
        method: "GET",
        url: `/api/v1/admin/machines/${sharedMachineId}/groups`,
        headers: { cookie: cookieHeader }
      })
    ).json().groups;
    expect(groups).toHaveLength(2);
    expect(groups.map((group: { name: string }) => group.name)).toEqual([
      "共享组 B",
      "共享组 A"
    ]);
    expect(groups.every(
      (group: { resourceSummary: string }) =>
        group.resourceSummary.includes("共享 · 内存 · 512 GiB") &&
        group.resourceSummary.includes("共享 · 共享编号 · 0–3") &&
        group.resourceSummary.includes("共享 · 共享设备 · 设备 0")
    )).toBe(true);
    expect(groups.every(
      (group: { allocations: Array<{ sharingMode: string }> }) =>
        group.allocations.every(
          (allocation) => allocation.sharingMode === "SHARED"
        )
    )).toBe(true);
  });

  it("整批保存资源配置，并在最终提交时统一检查冲突", async () => {
    const batchMachineId = randomUUID();
    const batchPoolId = randomUUID();
    const firstGroupId = randomUUID();
    const secondGroupId = randomUUID();
    const now = dbModule.nowIso();
    dbModule.db.prepare(
      `INSERT INTO machines(id, name, created_at, updated_at)
       VALUES(?, '整批配置测试机', ?, ?)`
    ).run(batchMachineId, now, now);

    const initialPayload = {
      pools: [{
        id: batchPoolId,
        expectedVersion: 0,
        name: "逻辑核",
        kind: "INDEX_RANGE",
        unit: "核",
        description: "",
        sortOrder: 0,
        rangeStart: 0,
        rangeEnd: 7
      }],
      groups: [
        {
          id: firstGroupId,
          expectedVersion: 0,
          name: "资源组 A",
          description: "",
          tags: [],
          allocations: [{
            poolId: batchPoolId,
            kind: "INDEX_RANGE",
            ranges: [{ start: 0, end: 3 }]
          }]
        },
        {
          id: secondGroupId,
          expectedVersion: 0,
          name: "资源组 B",
          description: "",
          tags: [],
          allocations: [{
            poolId: batchPoolId,
            kind: "INDEX_RANGE",
            ranges: [{ start: 4, end: 7 }]
          }]
        }
      ]
    };
    const created = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${batchMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: initialPayload
    });
    expect(created.statusCode).toBe(200);

    const readConfiguration = async () => {
      const [poolResponse, groupResponse] = await Promise.all([
        app.inject({
          method: "GET",
          url: `/api/v1/admin/machines/${batchMachineId}/resource-pools`,
          headers: { cookie: cookieHeader }
        }),
        app.inject({
          method: "GET",
          url: `/api/v1/admin/machines/${batchMachineId}/groups`,
          headers: { cookie: cookieHeader }
        })
      ]);
      return {
        pools: poolResponse.json().pools,
        groups: groupResponse.json().groups
      };
    };
    const beforeConflict = await readConfiguration();
    const pool = beforeConflict.pools[0];
    const firstGroup = beforeConflict.groups.find(
      (group: { id: string }) => group.id === firstGroupId
    );
    const secondGroup = beforeConflict.groups.find(
      (group: { id: string }) => group.id === secondGroupId
    );

    const conflicting = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${batchMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: {
        pools: [{
          id: pool.id,
          expectedVersion: pool.version,
          name: pool.name,
          kind: pool.kind,
          unit: pool.unit,
          description: pool.description,
          sortOrder: pool.sortOrder,
          rangeStart: pool.rangeStart,
          rangeEnd: pool.rangeEnd
        }],
        groups: [
          {
            id: firstGroup.id,
            expectedVersion: firstGroup.version,
            name: firstGroup.name,
            description: firstGroup.description,
            tags: firstGroup.tags,
            allocations: [{
              poolId: batchPoolId,
              kind: "INDEX_RANGE",
              ranges: [{ start: 0, end: 4 }]
            }]
          },
          {
            id: secondGroup.id,
            expectedVersion: secondGroup.version,
            name: secondGroup.name,
            description: secondGroup.description,
            tags: secondGroup.tags,
            allocations: [{
              poolId: batchPoolId,
              kind: "INDEX_RANGE",
              ranges: [{ start: 4, end: 7 }]
            }]
          }
        ]
      }
    });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json().error).toContain("重叠");

    const afterConflict = await readConfiguration();
    expect(afterConflict.pools[0].version).toBe(pool.version);
    expect(
      afterConflict.groups.find(
        (group: { id: string }) => group.id === firstGroupId
      ).allocations[0].ranges
    ).toEqual([{ start: 0, end: 3 }]);

    const swappedPayload = {
      pools: [{
        id: pool.id,
        expectedVersion: pool.version,
        name: pool.name,
        kind: pool.kind,
        unit: pool.unit,
        description: pool.description,
        sortOrder: pool.sortOrder,
        rangeStart: pool.rangeStart,
        rangeEnd: pool.rangeEnd
      }],
      groups: [
        {
          id: firstGroup.id,
          expectedVersion: firstGroup.version,
          name: firstGroup.name,
          description: firstGroup.description,
          tags: firstGroup.tags,
          allocations: [{
            poolId: batchPoolId,
            kind: "INDEX_RANGE",
            ranges: [{ start: 4, end: 7 }]
          }]
        },
        {
          id: secondGroup.id,
          expectedVersion: secondGroup.version,
          name: secondGroup.name,
          description: secondGroup.description,
          tags: secondGroup.tags,
          allocations: [{
            poolId: batchPoolId,
            kind: "INDEX_RANGE",
            ranges: [{ start: 0, end: 3 }]
          }]
        }
      ]
    };
    const swapped = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${batchMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: swappedPayload
    });
    expect(swapped.statusCode).toBe(200);

    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${batchMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: swappedPayload
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("RESOURCE_CONFIGURATION_STALE");
  });

  it("资源项删除作为编辑草稿随整批保存生效", async () => {
    const deleteMachineId = randomUUID();
    const deletePoolId = randomUUID();
    const now = dbModule.nowIso();
    dbModule.db.prepare(
      `INSERT INTO machines(id, name, created_at, updated_at)
       VALUES(?, '资源项删除测试机', ?, ?)`
    ).run(deleteMachineId, now, now);

    const created = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${deleteMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: {
        pools: [{
          id: deletePoolId,
          expectedVersion: 0,
          name: "临时容量",
          kind: "CAPACITY",
          unit: "GiB",
          description: "",
          sortOrder: 0,
          capacity: 64
        }],
        groups: []
      }
    });
    expect(created.statusCode).toBe(200);

    const deleted = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/machines/${deleteMachineId}/resource-configuration`,
      headers: { cookie: cookieHeader },
      payload: {
        pools: [],
        groups: [],
        deletedPools: [{ id: deletePoolId, expectedVersion: 1 }]
      }
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare("SELECT name FROM resource_pools WHERE id = ?")
        .get(deletePoolId)
    ).toEqual({ name: `deleted-${deletePoolId}` });
    expect(
      dbModule.db
        .prepare(
          "SELECT resource_pool_id FROM deleted_resource_pool_tombstones WHERE resource_pool_id = ?"
        )
        .get(deletePoolId)
    ).toEqual({ resource_pool_id: deletePoolId });
    const currentPools = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${deleteMachineId}/resource-pools`,
      headers: { cookie: cookieHeader }
    });
    expect(currentPools.statusCode).toBe(200);
    expect(
      currentPools.json().pools.some((pool: { id: string }) => pool.id === deletePoolId)
    ).toBe(false);
  });

  it("一个资源组可以组合多区间、设备和容量", async () => {
    const pools = (
      await app.inject({
        method: "GET",
        url: `/api/v1/admin/machines/${machineId}/resource-pools`,
        headers: { cookie: cookieHeader }
      })
    ).json().pools;
    const gpu0 = pools.find((pool: { id: string }) => pool.id === itemPoolId).items[0];
    const created = await post(`/admin/machines/${machineId}/groups`, {
      name: "混合资源组",
      description: "",
      tags: ["混合"],
      allocations: [
        {
          poolId: rangePoolId,
          kind: "INDEX_RANGE",
          ranges: [
            { start: 0, end: 7, label: "节点 0" },
            { start: 16, end: 23, label: "节点 1" }
          ]
        },
        { poolId: itemPoolId, kind: "ITEM_LIST", itemIds: [gpu0.id] },
        { poolId: capacityPoolId, kind: "CAPACITY", quantity: 6.125 }
      ]
    });
    expect(created.statusCode).toBe(201);
    groupId = created.json().id;

    const groups = (
      await app.inject({
        method: "GET",
        url: `/api/v1/admin/machines/${machineId}/groups`,
        headers: { cookie: cookieHeader }
      })
    ).json().groups;
    const group = groups.find((item: { id: string }) => item.id === groupId);
    expect(group.allocations).toHaveLength(3);
    expect(group.resourceSummary).toContain("节点 0");
    expect(group.resourceSummary).toContain("GPU 0");
    expect(group.resourceSummary).toContain("6.125 GiB");
  });

  it("拒绝跨资源组的编号、设备和容量冲突", async () => {
    const pools = (
      await app.inject({
        method: "GET",
        url: `/api/v1/admin/machines/${machineId}/resource-pools`,
        headers: { cookie: cookieHeader }
      })
    ).json().pools;
    const gpu0 = pools.find((pool: { id: string }) => pool.id === itemPoolId).items[0];
    const cases = [
      {
        name: "编号冲突",
        allocations: [{
          poolId: rangePoolId,
          kind: "INDEX_RANGE",
          ranges: [{ start: 7, end: 8 }]
        }]
      },
      {
        name: "设备冲突",
        allocations: [{
          poolId: itemPoolId,
          kind: "ITEM_LIST",
          itemIds: [gpu0.id]
        }]
      },
      {
        name: "容量超限",
        allocations: [{
          poolId: capacityPoolId,
          kind: "CAPACITY",
          quantity: 4.001
        }]
      }
    ];
    for (const candidate of cases) {
      const response = await post(`/admin/machines/${machineId}/groups`, {
        ...candidate,
        description: "",
        tags: []
      });
      expect(response.statusCode).toBe(409);
    }
  });

  it("安全扩容成功，破坏性缩容和旧版本更新被阻止", async () => {
    const expanded = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/resource-pools/${rangePoolId}`,
      headers: { cookie: cookieHeader },
      payload: {
        name: "逻辑核",
        kind: "INDEX_RANGE",
        unit: "核",
        description: "",
        sortOrder: 1,
        rangeStart: 0,
        rangeEnd: 127,
        expectedVersion: 1
      }
    });
    expect(expanded.statusCode).toBe(200);

    const stale = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/resource-pools/${rangePoolId}`,
      headers: { cookie: cookieHeader },
      payload: {
        name: "逻辑核",
        kind: "INDEX_RANGE",
        unit: "核",
        description: "",
        sortOrder: 1,
        rangeStart: 0,
        rangeEnd: 127,
        expectedVersion: 1
      }
    });
    expect(stale.statusCode).toBe(409);

    const shrink = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/resource-pools/${rangePoolId}`,
      headers: { cookie: cookieHeader },
      payload: {
        name: "逻辑核",
        kind: "INDEX_RANGE",
        unit: "核",
        description: "",
        sortOrder: 1,
        rangeStart: 0,
        rangeEnd: 15,
        expectedVersion: 2
      }
    });
    expect(shrink.statusCode).toBe(409);
    expect(shrink.json().error).toContain("混合资源组");
  });

  it("长期停用保留资源，重新启用可用，彻底删除后释放资源", async () => {
    const disabled = await post(`/admin/groups/${groupId}/disable`, {
      expectedVersion: 1,
      expectedRevision: dbModule.getScheduleRevision()
    });
    expect(disabled.statusCode).toBe(200);

    const conflictWhileDisabled = await post(`/admin/machines/${machineId}/groups`, {
      name: "停用仍占用",
      description: "",
      tags: [],
      allocations: [{
        poolId: rangePoolId,
        kind: "INDEX_RANGE",
        ranges: [{ start: 0, end: 1 }]
      }]
    });
    expect(conflictWhileDisabled.statusCode).toBe(409);

    const enabled = await post(`/admin/groups/${groupId}/enable`, {
      expectedVersion: 2
    });
    expect(enabled.statusCode).toBe(200);
    expect(
      (await post(`/admin/groups/${groupId}/disable`, {
        expectedVersion: 3,
        expectedRevision: dbModule.getScheduleRevision()
      }))
        .statusCode
    ).toBe(200);
    expect(
      (await app.inject({
        method: "DELETE",
        url: `/api/v1/admin/groups/${groupId}`,
        headers: { cookie: cookieHeader },
        payload: { expectedVersion: 4 }
      }))
        .statusCode
    ).toBe(200);

    const reused = await post(`/admin/machines/${machineId}/groups`, {
      name: "删除后复用",
      description: "",
      tags: [],
      allocations: [{
        poolId: rangePoolId,
        kind: "INDEX_RANGE",
        ranges: [{ start: 0, end: 1 }]
      }]
    });
    expect(reused.statusCode).toBe(201);
    reusedGroupId = reused.json().id;
  });

  it("公开目录不泄露设备编号，授权时间轴返回完整组成", async () => {
    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/machines/catalog",
      headers: { cookie: cookieHeader }
    });
    const machine = catalog.json().machines.find((item: { id: string }) => item.id === machineId);
    expect(JSON.stringify(machine)).not.toContain("GPU 0");
    expect(machine.resourceSummary).toContain("GPU · 2 张");
    expect(machine.resourceSummary).not.toMatch(/\d+–\d+/);

    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`,
      headers: { cookie: cookieHeader }
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json().groups[0]).not.toHaveProperty("version");
    expect(timeline.json().groups[0]).toHaveProperty("allocations");
  });

  it("报表和 CSV 使用资源组分钟与通用资源摘要", async () => {
    const admin = dbModule.db
      .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN'")
      .get() as { id: string };
    const { commitReservationBatch } = await import("../server/scheduling.js");
    const reservationBase = Math.floor(Date.now() / 60_000) * 60_000;
    const startAt = new Date(reservationBase + 60_000).toISOString();
    const endAt = new Date(reservationBase + 61 * 60_000).toISOString();
    commitReservationBatch(admin.id, [{
      resourceGroupId: reusedGroupId,
      startAt,
      endAt
    }]);
    const query = `from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * 3_600_000).toISOString())}&machineId=${machineId}`;
    const report = await app.inject({
      method: "GET",
      url: `/api/v1/admin/report?${query}`,
      headers: { cookie: cookieHeader }
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().summary.reservedMinutes).toBe(60);
    expect(report.json().groups[0].resourceSummary).toContain("逻辑核 · 0–1");
    expect(report.json().users[0]).not.toHaveProperty("coreMinutes");

    const csv = await app.inject({
      method: "GET",
      url: `/api/v1/admin/report.csv?${query}`,
      headers: { cookie: cookieHeader }
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("资源组成");
    expect(csv.body).not.toContain("核时");
    expect(csv.body).not.toContain("核段");
  });

  it("未引用的资源项可以永久删除，被引用时返回资源组名单", async () => {
    const inUse = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/resource-pools/${rangePoolId}`,
      headers: { cookie: cookieHeader },
      payload: { expectedVersion: 2 }
    });
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json().code).toBe("RESOURCE_POOL_IN_USE");
    expect(inUse.json().details.resourceGroups).toContain("删除后复用");

    const unused = await post(`/admin/machines/${machineId}/resource-pools`, {
      name: "临时容量",
      kind: "CAPACITY",
      unit: "GiB",
      description: "",
      sortOrder: 99,
      capacity: 64
    });
    expect(unused.statusCode).toBe(201);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/resource-pools/${unused.json().id}`,
      headers: { cookie: cookieHeader },
      payload: { expectedVersion: 1 }
    });
    expect(deleted.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare("SELECT name FROM resource_pools WHERE id = ?")
        .get(unused.json().id)
    ).toEqual({ name: `deleted-${unused.json().id}` });
    expect(
      dbModule.db
        .prepare(
          "SELECT resource_pool_id FROM deleted_resource_pool_tombstones WHERE resource_pool_id = ?"
        )
        .get(unused.json().id)
    ).toEqual({ resource_pool_id: unused.json().id });
  });
});
