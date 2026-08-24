import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { firstPasswordError } from "../src/shared/identity-rules.js";
import { hashPassword } from "./password-hashing.js";
import type { BootstrapConfig } from "./config.js";
type Now = () => string;
type Allocation =
  | {
      poolId: string;
      poolName: string;
      kind: "INDEX_RANGE";
      sharingMode: "EXCLUSIVE" | "SHARED";
      unit: string;
      ranges: Array<{ start: number; end: number; label?: string }>;
    }
  | {
      poolId: string;
      poolName: string;
      kind: "ITEM_LIST";
      sharingMode: "EXCLUSIVE" | "SHARED";
      unit: string;
      items: Array<{ id: string; key: string; label: string }>;
    }
  | {
      poolId: string;
      poolName: string;
      kind: "CAPACITY";
      sharingMode: "EXCLUSIVE" | "SHARED";
      unit: string;
      quantity: number;
    };

export async function seedDatabase(
  db: Database.Database,
  bootstrap: BootstrapConfig,
  nowIso: Now
) {
  await seedAdministrator(db, bootstrap, nowIso);
  if (!bootstrap.seedDemoData) return;
  const count = db.prepare("SELECT COUNT(*) AS count FROM machines").get() as {
    count: number;
  };
  if (count.count) return;
  await seedDemoData(db, nowIso);
}

async function seedAdministrator(
  db: Database.Database,
  bootstrap: BootstrapConfig,
  nowIso: Now
) {
  if (
    db.prepare("SELECT 1 FROM users WHERE role = 'SYSTEM_ADMIN' LIMIT 1").get() ||
    !bootstrap.adminPassword
  ) return;
  const passwordError = firstPasswordError(bootstrap.adminPassword, {
    username: "Administrator"
  });
  if (passwordError) {
    throw new Error(`Administrator 初始化密码不符合要求：${passwordError}`);
  }
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users(
      id, username, username_normalized, email, display_name, password_hash,
      role, status, password_change_recommended, auto_logout_minutes,
      approved_at, created_at, updated_at
    ) VALUES(?, 'Administrator', 'administrator', NULL, ?, ?,
      'SYSTEM_ADMIN', 'ACTIVE', 1, 0, ?, ?, ?)`
  ).run(
    id,
    bootstrap.adminName,
    await hashPassword(bootstrap.adminPassword),
    now,
    now,
    now
  );
}

async function seedDemoData(db: Database.Database, nowIso: Now) {
  const admin = db
    .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN' LIMIT 1")
    .get() as { id: string };
  const now = nowIso();
  const passwordHash = await hashPassword("DemoAccount123!");
  const users = [
    ["linchen", "林澈", "lin.chen@example.com", "10000001"],
    ["zhouning", "周宁", "zhou.ning@example.com", "10000002"],
    ["chenmo", "陈墨", "chen.mo@example.com", "10000003"]
  ].map(([username, name, email, employeeNumber]) => ({
    id: randomUUID(),
    username,
    name,
    email,
    employeeNumber
  }));
  const insertUser = db.prepare(
    `INSERT INTO users(
      id, username, username_normalized, email, display_name, password_hash,
      role, status, auto_logout_minutes, approved_at, approved_by, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'USER', 'ACTIVE', 0, ?, ?, ?, ?)`
  );
  const insertEmployeeNumber = db.prepare(
    `INSERT INTO employee_numbers(
      id, user_id, employee_number, status, assigned_by, assigned_at, updated_at
    ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
  );
  for (const user of users) {
    insertUser.run(
      user.id,
      user.username,
      user.username.toLowerCase(),
      user.email,
      user.name,
      passwordHash,
      now,
      admin.id,
      now,
      now
    );
    insertEmployeeNumber.run(
      randomUUID(),
      user.id,
      user.employeeNumber,
      admin.id,
      now,
      now
    );
  }

  const atlas = insertMachine(
    db,
    "Atlas-01",
    "192.0.2.21",
    "2 × AMD EPYC 9554 · 4 × NVIDIA H100 · 512 GiB 内存",
    ["GPU", "高内存", "通用计算"],
    now
  );
  const kunpeng = insertMachine(
    db,
    "Kunpeng-02",
    "192.0.2.38",
    "鲲鹏处理器服务器",
    ["ARM64", "编译"],
    now
  );
  const nova = insertMachine(
    db,
    "Nova-03",
    "192.0.2.52",
    "通用验证服务器",
    ["验证"],
    now
  );

  grantMachine(db, atlas, users[0].id, admin.id, true, now);
  grantMachine(db, atlas, users[1].id, admin.id, false, now);
  grantMachine(db, kunpeng, users[2].id, admin.id, true, now);
  grantMachine(db, nova, users[1].id, admin.id, true, now);

  const atlasCpu = insertRangePool(db, atlas, "逻辑核", "核", 0, 127, "2 × AMD EPYC 9554", 0, admin.id, now);
  const atlasGpu = insertItemPool(
    db,
    atlas,
    "GPU",
    "张",
    ["GPU 0", "GPU 1", "GPU 2", "GPU 3"],
    "NVIDIA H100 80GB",
    1,
    admin.id,
    now
  );
  const atlasMemory = insertCapacityPool(
    db,
    atlas,
    "内存",
    "GiB",
    512,
    "共享内存容量",
    2,
    admin.id,
    now,
    "SHARED"
  );
  const kunpengCpu = insertRangePool(db, kunpeng, "逻辑核", "核", 0, 95, "鲲鹏逻辑核", 0, admin.id, now);
  const novaCpu = insertRangePool(db, nova, "逻辑核", "核", 0, 63, "通用逻辑核", 0, admin.id, now);

  const gpuA = insertGroup(db, atlas, "GPU 训练组 A", [
    rangeAllocation(atlasCpu, [{ start: 0, end: 31, label: "NUMA 0" }]),
    itemAllocation(atlasGpu, [0]),
    capacityAllocation(atlasMemory, 512)
  ], "GPU 训练与推理", ["GPU", "共享内存"], admin.id, now);
  const gpuB = insertGroup(db, atlas, "GPU 训练组 B", [
    rangeAllocation(atlasCpu, [{ start: 32, end: 63, label: "NUMA 0" }]),
    itemAllocation(atlasGpu, [1]),
    capacityAllocation(atlasMemory, 512)
  ], "另一组独立 GPU 资源", ["GPU", "共享内存"], admin.id, now);
  insertGroup(db, atlas, "CPU 长任务组", [
    rangeAllocation(atlasCpu, [
      { start: 64, end: 79, label: "NUMA 1" },
      { start: 96, end: 111, label: "NUMA 1" }
    ]),
    capacityAllocation(atlasMemory, 512)
  ], "展示多个连续编号区间", ["32 核", "共享内存"], admin.id, now);
  const arm = insertGroup(db, kunpeng, "ARM 编译组", [
    rangeAllocation(kunpengCpu, [{ start: 0, end: 23, label: "NUMA 0" }])
  ], "ARM64 编译验证", ["ARM64"], admin.id, now);
  const quick = insertGroup(db, nova, "快速验证", [
    rangeAllocation(novaCpu, [{ start: 0, end: 15 }])
  ], "短时验证任务", ["验证"], admin.id, now);

  const bookingDay = new Date();
  bookingDay.setHours(0, 0, 0, 0);
  insertReservation(db, users[0].id, atlas, gpuA, atHour(bookingDay, 9), atHour(bookingDay, 11, 30), "训练实验", now);
  insertReservation(db, users[1].id, atlas, gpuB, atHour(bookingDay, 13), atHour(bookingDay, 17), "推理验证", now);
  insertReservation(db, users[2].id, kunpeng, arm, atHour(bookingDay, 10, 30), atHour(bookingDay, 15), "编译验证", now);
  insertReservation(db, users[1].id, nova, quick, atHour(bookingDay, 15), atHour(bookingDay, 18), "快速测试", now);
}

function insertMachine(
  db: Database.Database,
  name: string,
  address: string,
  hardwareNotes: string,
  tags: string[],
  now: string
) {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO machines(
      id, name, address, hardware_notes, connection_guide, tags_json,
      created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    name,
    address,
    hardwareNotes,
    "使用个人账号登录；按资源组中登记的资源范围运行任务。",
    JSON.stringify(tags),
    now,
    now
  );
  return id;
}

function grantMachine(
  db: Database.Database,
  machineId: string,
  userId: string,
  adminId: string,
  manager: boolean,
  now: string
) {
  db.prepare(
    `INSERT INTO machine_access_memberships(
      id, machine_id, user_id, source, granted_by, created_at, updated_at
    ) VALUES(?, ?, ?, 'SEED', ?, ?, ?)`
  ).run(randomUUID(), machineId, userId, adminId, now, now);
  if (manager) {
    db.prepare(
      `INSERT INTO machine_admins(machine_id, user_id, assigned_by, created_at)
       VALUES(?, ?, ?, ?)`
    ).run(machineId, userId, adminId, now);
  }
}

type SeedPool = {
  id: string;
  name: string;
  unit: string;
  kind: "INDEX_RANGE" | "ITEM_LIST" | "CAPACITY";
  sharingMode: "EXCLUSIVE" | "SHARED";
  items: Array<{ id: string; key: string; label: string }>;
};

function insertRangePool(
  db: Database.Database,
  machineId: string,
  name: string,
  unit: string,
  start: number,
  end: number,
  description: string,
  sortOrder: number,
  actorId: string,
  now: string
): SeedPool {
  return insertPool(db, machineId, {
    name, unit, kind: "INDEX_RANGE", description, sortOrder,
    sharingMode: "EXCLUSIVE",
    rangeStart: start, rangeEnd: end, capacityMilli: null, itemLabels: []
  }, actorId, now);
}

function insertItemPool(
  db: Database.Database,
  machineId: string,
  name: string,
  unit: string,
  itemLabels: string[],
  description: string,
  sortOrder: number,
  actorId: string,
  now: string
): SeedPool {
  return insertPool(db, machineId, {
    name, unit, kind: "ITEM_LIST", description, sortOrder,
    sharingMode: "EXCLUSIVE",
    rangeStart: null, rangeEnd: null, capacityMilli: null, itemLabels
  }, actorId, now);
}

function insertCapacityPool(
  db: Database.Database,
  machineId: string,
  name: string,
  unit: string,
  capacity: number,
  description: string,
  sortOrder: number,
  actorId: string,
  now: string,
  sharingMode: "EXCLUSIVE" | "SHARED" = "EXCLUSIVE"
): SeedPool {
  return insertPool(db, machineId, {
    name, unit, kind: "CAPACITY", description, sortOrder,
    sharingMode,
    rangeStart: null, rangeEnd: null, capacityMilli: capacity * 1000, itemLabels: []
  }, actorId, now);
}

function insertPool(
  db: Database.Database,
  machineId: string,
  input: {
    name: string;
    unit: string;
    kind: SeedPool["kind"];
    sharingMode: SeedPool["sharingMode"];
    description: string;
    sortOrder: number;
    rangeStart: number | null;
    rangeEnd: number | null;
    capacityMilli: number | null;
    itemLabels: string[];
  },
  actorId: string,
  now: string
): SeedPool {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO resource_pools(
      id, machine_id, name, kind, sharing_mode, unit, description, sort_order,
      range_start, range_end, capacity_milli, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, machineId, input.name, input.kind, input.sharingMode, input.unit, input.description,
    input.sortOrder, input.rangeStart, input.rangeEnd, input.capacityMilli, now, now
  );
  const items = input.itemLabels.map((key, index) => {
    const item = { id: randomUUID(), key, label: `NVIDIA H100 ${index}` };
    db.prepare(
      `INSERT INTO resource_pool_items(
        id, pool_id, item_key, label, sort_order, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?)`
    ).run(item.id, id, item.key, item.label, index, now, now);
    return item;
  });
  const configuration = {
    name: input.name,
    kind: input.kind,
    sharingMode: input.sharingMode,
    unit: input.unit,
    description: input.description,
    sortOrder: input.sortOrder,
    ...(input.kind === "INDEX_RANGE" ? {
      rangeStart: input.rangeStart,
      rangeEnd: input.rangeEnd
    } : {}),
    ...(input.kind === "ITEM_LIST" ? { items } : {}),
    ...(input.kind === "CAPACITY" ? {
      capacity: Number(input.capacityMilli) / 1000
    } : {})
  };
  db.prepare(
    `INSERT INTO resource_pool_revisions(
      id, resource_pool_id, version, configuration_json, changed_by, created_at
    ) VALUES(?, ?, 1, ?, ?, ?)`
  ).run(randomUUID(), id, JSON.stringify(configuration), actorId, now);
  return {
    id,
    name: input.name,
    unit: input.unit,
    kind: input.kind,
    sharingMode: input.sharingMode,
    items
  };
}

function rangeAllocation(
  pool: SeedPool,
  ranges: Array<{ start: number; end: number; label?: string }>
): Allocation {
  return {
    poolId: pool.id,
    poolName: pool.name,
    kind: "INDEX_RANGE",
    sharingMode: pool.sharingMode,
    unit: pool.unit,
    ranges
  };
}

function itemAllocation(pool: SeedPool, indexes: number[]): Allocation {
  return {
    poolId: pool.id,
    poolName: pool.name,
    kind: "ITEM_LIST",
    sharingMode: pool.sharingMode,
    unit: pool.unit,
    items: indexes.map((index) => pool.items[index])
  };
}

function capacityAllocation(pool: SeedPool, quantity: number): Allocation {
  return {
    poolId: pool.id,
    poolName: pool.name,
    kind: "CAPACITY",
    sharingMode: pool.sharingMode,
    unit: pool.unit,
    quantity
  };
}

function insertGroup(
  db: Database.Database,
  machineId: string,
  name: string,
  allocations: Allocation[],
  description: string,
  tags: string[],
  actorId: string,
  now: string
) {
  const id = randomUUID();
  const sortOrder = Number(
    (
      db.prepare(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
         FROM resource_groups WHERE machine_id = ?`
      ).get(machineId) as { next: number }
    ).next
  );
  db.prepare(
    `INSERT INTO resource_groups(
      id, machine_id, name, description, tags_json, sort_order,
      created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    machineId,
    name,
    description,
    JSON.stringify(tags),
    sortOrder,
    now,
    now
  );
  for (const allocation of allocations) {
    const allocationId = randomUUID();
    db.prepare(
      `INSERT INTO resource_group_allocations(
        id, resource_group_id, resource_pool_id, kind, quantity_milli
      ) VALUES(?, ?, ?, ?, ?)`
    ).run(
      allocationId,
      id,
      allocation.poolId,
      allocation.kind,
      allocation.kind === "CAPACITY" ? allocation.quantity * 1000 : null
    );
    if (allocation.kind === "INDEX_RANGE") {
      for (const range of allocation.ranges) {
        db.prepare(
          `INSERT INTO resource_group_allocation_ranges(
            id, allocation_id, range_start, range_end, label
          ) VALUES(?, ?, ?, ?, ?)`
        ).run(randomUUID(), allocationId, range.start, range.end, range.label ?? "");
      }
    }
    if (allocation.kind === "ITEM_LIST") {
      for (const item of allocation.items) {
        db.prepare(
          `INSERT INTO resource_group_allocation_items(allocation_id, item_id)
           VALUES(?, ?)`
        ).run(allocationId, item.id);
      }
    }
  }
  const resourceSummary = allocationSummary(allocations);
  db.prepare(
    `INSERT INTO resource_group_revisions(
      id, resource_group_id, version, configuration_json, changed_by, created_at
    ) VALUES(?, ?, 1, ?, ?, ?)`
  ).run(
    randomUUID(),
    id,
    JSON.stringify({
      name,
      description,
      tags,
      sortOrder,
      allocations,
      resourceSummary
    }),
    actorId,
    now
  );
  return { id, name, allocations, resourceSummary };
}

function allocationSummary(allocations: Allocation[]) {
  const allocationText = (allocation: Allocation) => {
    let details = "";
    if (allocation.kind === "INDEX_RANGE") {
      details = allocation.ranges
        .map((range) => `${range.start}–${range.end}${range.label ? ` ${range.label}` : ""}`)
        .join(" · ");
    } else if (allocation.kind === "ITEM_LIST") {
      details = allocation.items.map((item) => item.key).join("、");
    } else {
      details = `${allocation.quantity} ${allocation.unit}`;
    }
    return allocation.sharingMode === "SHARED"
      ? `共享 · ${allocation.poolName} · ${details}`
      : `${allocation.poolName} · ${details}`;
  };
  return allocations.map(allocationText).join(" ｜ ");
}

function insertReservation(
  db: Database.Database,
  userId: string,
  machineId: string,
  group: { id: string; name: string; allocations: Allocation[] },
  startAt: string,
  endAt: string,
  title: string,
  now: string
) {
  const batchId = randomUUID();
  db.prepare(
    "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
  ).run(batchId, userId, now);
  db.prepare(
    `INSERT INTO reservations(
      id, batch_id, resource_group_id, machine_id, user_id, start_at, end_at,
      initial_start_at, initial_end_at,
      title, snapshot_group_name, snapshot_resource_config_json,
      snapshot_group_version, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(
    randomUUID(),
    batchId,
    group.id,
    machineId,
    userId,
    startAt,
    endAt,
    startAt,
    endAt,
    title,
    group.name,
    JSON.stringify(group.allocations),
    now,
    now
  );
}

function atHour(day: Date, hour: number, minute = 0) {
  const date = new Date(day);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}
