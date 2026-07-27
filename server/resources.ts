import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ResourceAllocation,
  ResourceGroup,
  ResourcePool,
  ResourcePoolItem
} from "../src/shared/types.js";
import { BusinessError } from "./business-error.js";
import { db, nowIso, parseTags } from "./db.js";

const commonPoolFields = {
  name: z.string().trim().min(1).max(80),
  sharingMode: z
    .enum(["EXCLUSIVE", "SHARED"])
    .optional()
    .default("EXCLUSIVE"),
  unit: z.string().trim().min(1).max(20),
  description: z.string().max(2000).optional().default(""),
  sortOrder: z.number().int().min(0).max(10000).optional().default(0)
};

export const resourcePoolSchema = z.discriminatedUnion("kind", [
  z.object({
    ...commonPoolFields,
    kind: z.literal("INDEX_RANGE"),
    rangeStart: z.number().int().min(0),
    rangeEnd: z.number().int().min(0)
  }),
  z.object({
    ...commonPoolFields,
    kind: z.literal("ITEM_LIST"),
    items: z
      .array(
        z.object({
          id: z.string().uuid().optional(),
          key: z.string().trim().min(1).max(80),
          label: z.string().trim().min(1).max(120)
        })
      )
      .min(1)
      .max(500)
  }),
  z.object({
    ...commonPoolFields,
    kind: z.literal("CAPACITY"),
    capacity: z
      .number()
      .positive()
      .max(1_000_000_000)
      .refine(hasAtMostThreeDecimals, "容量最多保留三位小数")
  })
]);

const allocationSchema = z.discriminatedUnion("kind", [
  z.object({
    poolId: z.string().uuid(),
    kind: z.literal("INDEX_RANGE"),
    ranges: z
      .array(
        z.object({
          start: z.number().int().min(0),
          end: z.number().int().min(0),
          label: z.string().trim().max(80).optional().default("")
        })
      )
      .min(1)
      .max(100)
  }),
  z.object({
    poolId: z.string().uuid(),
    kind: z.literal("ITEM_LIST"),
    itemIds: z.array(z.string().uuid()).min(1).max(500)
  }),
  z.object({
    poolId: z.string().uuid(),
    kind: z.literal("CAPACITY"),
    quantity: z
      .number()
      .positive()
      .max(1_000_000_000)
      .refine(hasAtMostThreeDecimals, "容量最多保留三位小数")
  })
]);

export const resourceGroupSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional().default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional().default([]),
  sortOrder: z.number().int().min(0).max(10000).optional().default(0),
  allocations: z.array(allocationSchema).min(1).max(100),
  expectedVersion: z.number().int().min(1).optional()
});

const resourceConfigurationPoolCommon = {
  id: z.string().uuid(),
  expectedVersion: z.number().int().min(0),
  ...commonPoolFields
};

const resourceConfigurationPoolSchema = z.discriminatedUnion("kind", [
  z.object({
    ...resourceConfigurationPoolCommon,
    kind: z.literal("INDEX_RANGE"),
    rangeStart: z.number().int().min(0),
    rangeEnd: z.number().int().min(0)
  }),
  z.object({
    ...resourceConfigurationPoolCommon,
    kind: z.literal("ITEM_LIST"),
    items: z
      .array(
        z.object({
          id: z.string().uuid(),
          key: z.string().trim().min(1).max(80),
          label: z.string().trim().min(1).max(120)
        })
      )
      .min(1)
      .max(500)
  }),
  z.object({
    ...resourceConfigurationPoolCommon,
    kind: z.literal("CAPACITY"),
    capacity: z
      .number()
      .positive()
      .max(1_000_000_000)
      .refine(hasAtMostThreeDecimals, "容量最多保留三位小数")
  })
]);

const resourceConfigurationGroupSchema = resourceGroupSchema
  .omit({ expectedVersion: true })
  .extend({
    id: z.string().uuid(),
    expectedVersion: z.number().int().min(0)
  });

export const resourceConfigurationSchema = z.object({
  pools: z.array(resourceConfigurationPoolSchema).max(200),
  groups: z.array(resourceConfigurationGroupSchema).max(500),
  deletedPools: z
    .array(
      z.object({
        id: z.string().uuid(),
        expectedVersion: z.number().int().min(1)
      })
    )
    .max(200)
    .optional()
    .default([])
});

export type ResourcePoolInput = z.infer<typeof resourcePoolSchema>;
export type ResourceGroupInput = z.infer<typeof resourceGroupSchema>;
export type ResourceConfigurationInput = z.infer<
  typeof resourceConfigurationSchema
>;

type PoolRow = {
  id: string;
  machine_id: string;
  name: string;
  kind: "INDEX_RANGE" | "ITEM_LIST" | "CAPACITY";
  sharing_mode: "EXCLUSIVE" | "SHARED";
  unit: string;
  description: string;
  sort_order: number;
  version: number;
  range_start: number | null;
  range_end: number | null;
  capacity_milli: number | null;
};

function hasAtMostThreeDecimals(value: number) {
  const milli = value * 1000;
  return Math.abs(milli - Math.round(milli)) < 1e-7;
}

function poolItems(poolId: string): ResourcePoolItem[] {
  const rows = db
    .prepare(
      `SELECT id, item_key, label, sort_order
       FROM resource_pool_items
       WHERE pool_id = ?
       ORDER BY sort_order, item_key`
    )
    .all(poolId) as Array<{
    id: string;
    item_key: string;
    label: string;
    sort_order: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    key: row.item_key,
    label: row.label,
    sortOrder: row.sort_order
  }));
}

export function mapResourcePool(row: PoolRow): ResourcePool {
  const sharingSuffix = row.sharing_mode === "SHARED" ? " · 共享" : "";
  const base = {
    id: row.id,
    machineId: row.machine_id,
    name: row.name,
    sharingMode: row.sharing_mode,
    unit: row.unit,
    description: row.description,
    sortOrder: row.sort_order,
    version: row.version
  };
  if (row.kind === "INDEX_RANGE") {
    const rangeStart = Number(row.range_start);
    const rangeEnd = Number(row.range_end);
    return {
      ...base,
      kind: "INDEX_RANGE",
      rangeStart,
      rangeEnd,
      capacity: null,
      items: [],
      summary: `${rangeStart}–${rangeEnd} · ${rangeEnd - rangeStart + 1} ${row.unit}${sharingSuffix}`
    };
  }
  if (row.kind === "ITEM_LIST") {
    const items = poolItems(row.id);
    return {
      ...base,
      kind: "ITEM_LIST",
      rangeStart: null,
      rangeEnd: null,
      capacity: null,
      items,
      summary: `${items.length} ${row.unit}${sharingSuffix}`
    };
  }
  const capacity = Number(row.capacity_milli) / 1000;
  return {
    ...base,
    kind: "CAPACITY",
    rangeStart: null,
    rangeEnd: null,
    capacity,
    items: [],
    summary: `${formatQuantity(capacity)} ${row.unit}${sharingSuffix}`
  };
}

export function listResourcePools(machineId: string) {
  const rows = db
    .prepare(
      `SELECT * FROM resource_pools
       WHERE machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_pool_tombstones drpt
           WHERE drpt.resource_pool_id = resource_pools.id
         )
       ORDER BY sort_order, name`
    )
    .all(machineId) as PoolRow[];
  return rows.map(mapResourcePool);
}

export function getResourcePool(poolId: string) {
  const row = db.prepare(
    `SELECT * FROM resource_pools
     WHERE id = ?
       AND NOT EXISTS (
         SELECT 1 FROM deleted_resource_pool_tombstones drpt
         WHERE drpt.resource_pool_id = resource_pools.id
       )`
  ).get(poolId) as
    | PoolRow
    | undefined;
  return row ? mapResourcePool(row) : undefined;
}

export function resourcePoolConfiguration(pool: ResourcePool) {
  return {
    name: pool.name,
    kind: pool.kind,
    sharingMode: pool.sharingMode,
    unit: pool.unit,
    description: pool.description,
    sortOrder: pool.sortOrder,
    ...(pool.kind === "INDEX_RANGE"
      ? { rangeStart: pool.rangeStart, rangeEnd: pool.rangeEnd }
      : {}),
    ...(pool.kind === "ITEM_LIST"
      ? {
          items: pool.items.map((item) => ({
            id: item.id,
            key: item.key,
            label: item.label,
            sortOrder: item.sortOrder
          }))
        }
      : {}),
    ...(pool.kind === "CAPACITY" ? { capacity: pool.capacity } : {})
  };
}

export function loadGroupAllocations(groupId: string): ResourceAllocation[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.kind, a.quantity_milli,
              p.id AS pool_id, p.name AS pool_name, p.unit, p.sharing_mode
       FROM resource_group_allocations a
       JOIN resource_pools p ON p.id = a.resource_pool_id
       WHERE a.resource_group_id = ?
       ORDER BY p.sort_order, p.name`
    )
    .all(groupId) as Array<{
    id: string;
    kind: "INDEX_RANGE" | "ITEM_LIST" | "CAPACITY";
    quantity_milli: number | null;
    pool_id: string;
    pool_name: string;
    unit: string;
    sharing_mode: "EXCLUSIVE" | "SHARED";
  }>;
  return rows.map((row) => {
    if (row.kind === "INDEX_RANGE") {
      const ranges = db
        .prepare(
          `SELECT range_start, range_end, label
           FROM resource_group_allocation_ranges
           WHERE allocation_id = ? ORDER BY range_start, range_end`
        )
        .all(row.id) as Array<{
        range_start: number;
        range_end: number;
        label: string;
      }>;
      return {
        poolId: row.pool_id,
        poolName: row.pool_name,
        kind: "INDEX_RANGE" as const,
        sharingMode: row.sharing_mode,
        unit: row.unit,
        ranges: ranges.map((range) => ({
          start: range.range_start,
          end: range.range_end,
          ...(range.label ? { label: range.label } : {})
        }))
      };
    }
    if (row.kind === "ITEM_LIST") {
      const items = db
        .prepare(
          `SELECT i.id, i.item_key, i.label
           FROM resource_group_allocation_items ai
           JOIN resource_pool_items i ON i.id = ai.item_id
           WHERE ai.allocation_id = ?
           ORDER BY i.sort_order, i.item_key`
        )
        .all(row.id) as Array<{ id: string; item_key: string; label: string }>;
      return {
        poolId: row.pool_id,
        poolName: row.pool_name,
        kind: "ITEM_LIST" as const,
        sharingMode: row.sharing_mode,
        unit: row.unit,
        items: items.map((item) => ({
          id: item.id,
          key: item.item_key,
          label: item.label
        }))
      };
    }
    return {
      poolId: row.pool_id,
      poolName: row.pool_name,
      kind: "CAPACITY" as const,
      sharingMode: row.sharing_mode,
      unit: row.unit,
      quantity: Number(row.quantity_milli) / 1000
    };
  });
}

export function loadGroupAllocationsBatch(groupIds: string[]) {
  const result = new Map<string, ResourceAllocation[]>(
    groupIds.map((groupId) => [groupId, []])
  );
  if (!groupIds.length) return result;
  const groupPlaceholders = groupIds.map(() => "?").join(",");
  const allocations = db
    .prepare(
      `SELECT a.id, a.resource_group_id, a.kind, a.quantity_milli,
              p.id AS pool_id, p.name AS pool_name, p.unit, p.sharing_mode
       FROM resource_group_allocations a
       JOIN resource_pools p ON p.id = a.resource_pool_id
       WHERE a.resource_group_id IN (${groupPlaceholders})
       ORDER BY a.resource_group_id, p.sort_order, p.name`
    )
    .all(...groupIds) as Array<{
    id: string;
    resource_group_id: string;
    kind: "INDEX_RANGE" | "ITEM_LIST" | "CAPACITY";
    quantity_milli: number | null;
    pool_id: string;
    pool_name: string;
    unit: string;
    sharing_mode: "EXCLUSIVE" | "SHARED";
  }>;
  if (!allocations.length) return result;

  const allocationIds = allocations.map((allocation) => allocation.id);
  const allocationPlaceholders = allocationIds.map(() => "?").join(",");
  const ranges = db
    .prepare(
      `SELECT allocation_id, range_start, range_end, label
       FROM resource_group_allocation_ranges
       WHERE allocation_id IN (${allocationPlaceholders})
       ORDER BY allocation_id, range_start, range_end`
    )
    .all(...allocationIds) as Array<{
    allocation_id: string;
    range_start: number;
    range_end: number;
    label: string;
  }>;
  const items = db
    .prepare(
      `SELECT ai.allocation_id, i.id, i.item_key, i.label
       FROM resource_group_allocation_items ai
       JOIN resource_pool_items i ON i.id = ai.item_id
       WHERE ai.allocation_id IN (${allocationPlaceholders})
       ORDER BY ai.allocation_id, i.sort_order, i.item_key`
    )
    .all(...allocationIds) as Array<{
    allocation_id: string;
    id: string;
    item_key: string;
    label: string;
  }>;
  const rangesByAllocation = new Map<string, typeof ranges>();
  for (const range of ranges) {
    const list = rangesByAllocation.get(range.allocation_id) ?? [];
    list.push(range);
    rangesByAllocation.set(range.allocation_id, list);
  }
  const itemsByAllocation = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByAllocation.get(item.allocation_id) ?? [];
    list.push(item);
    itemsByAllocation.set(item.allocation_id, list);
  }

  for (const row of allocations) {
    const groupAllocations = result.get(row.resource_group_id) ?? [];
    if (row.kind === "INDEX_RANGE") {
      groupAllocations.push({
        poolId: row.pool_id,
        poolName: row.pool_name,
        kind: "INDEX_RANGE",
        sharingMode: row.sharing_mode,
        unit: row.unit,
        ranges: (rangesByAllocation.get(row.id) ?? []).map((range) => ({
          start: range.range_start,
          end: range.range_end,
          ...(range.label ? { label: range.label } : {})
        }))
      });
    } else if (row.kind === "ITEM_LIST") {
      groupAllocations.push({
        poolId: row.pool_id,
        poolName: row.pool_name,
        kind: "ITEM_LIST",
        sharingMode: row.sharing_mode,
        unit: row.unit,
        items: (itemsByAllocation.get(row.id) ?? []).map((item) => ({
          id: item.id,
          key: item.item_key,
          label: item.label
        }))
      });
    } else {
      groupAllocations.push({
        poolId: row.pool_id,
        poolName: row.pool_name,
        kind: "CAPACITY",
        sharingMode: row.sharing_mode,
        unit: row.unit,
        quantity: Number(row.quantity_milli) / 1000
      });
    }
    result.set(row.resource_group_id, groupAllocations);
  }
  return result;
}

export function resourceAllocationSummary(allocations: ResourceAllocation[]) {
  const allocationText = (allocation: ResourceAllocation) => {
      let details = "";
      if (allocation.kind === "INDEX_RANGE") {
        details = allocation.ranges
          .map(
            (range) =>
              `${range.start}–${range.end}${range.label ? ` ${range.label}` : ""}`
          )
          .join(" · ");
      } else if (allocation.kind === "ITEM_LIST") {
        details = allocation.items
          .map((item) => item.key)
          .join("、");
      } else {
        details = `${formatQuantity(allocation.quantity)} ${allocation.unit}`;
      }
      return allocation.sharingMode === "SHARED"
        ? `共享 · ${allocation.poolName} · ${details}`
        : `${allocation.poolName} · ${details}`;
    };
  return allocations.map(allocationText).join(" ｜ ");
}

function mapResourceGroupRow(
  row: Record<string, unknown>,
  allocations: ResourceAllocation[]
): ResourceGroup {
  return {
    id: String(row.id),
    machineId: String(row.machine_id),
    name: String(row.name),
    allocations,
    resourceSummary: resourceAllocationSummary(allocations),
    description: String(row.description ?? ""),
    tags: parseTags(String(row.tags_json)),
    sortOrder: Number(row.sort_order ?? 0),
    status: row.status as ResourceGroup["status"],
    version: Number(row.version)
  };
}

export function mapResourceGroup(row: Record<string, unknown>): ResourceGroup {
  return mapResourceGroupRow(
    row,
    loadGroupAllocations(String(row.id))
  );
}

export function mapResourceGroups(rows: Array<Record<string, unknown>>) {
  const allocationsByGroup = loadGroupAllocationsBatch(
    rows.map((row) => String(row.id))
  );
  return rows.map((row) =>
    mapResourceGroupRow(
      row,
      allocationsByGroup.get(String(row.id)) ?? []
    )
  );
}

export function groupConfiguration(
  name: string,
  description: string,
  tags: string[],
  allocations: ResourceAllocation[],
  sortOrder = 0
) {
  return {
    name,
    description,
    tags,
    sortOrder,
    allocations,
    resourceSummary: resourceAllocationSummary(allocations)
  };
}

export function validateAndResolveGroupAllocations(
  machineId: string,
  input: ResourceGroupInput["allocations"],
  excludeGroupId?: string
): ResourceAllocation[] {
  const poolIds = input.map((allocation) => allocation.poolId);
  if (new Set(poolIds).size !== poolIds.length) {
    throw new BusinessError("同一资源项不能在资源组中重复配置");
  }
  const resolved: ResourceAllocation[] = [];
  for (const allocation of input) {
    const pool = getResourcePool(allocation.poolId);
    if (!pool || pool.machineId !== machineId) {
      throw new BusinessError("资源项不存在或不属于这台机器", 409);
    }
    if (pool.kind !== allocation.kind) {
      throw new BusinessError(`${pool.name} 的分配方式已经变化，请刷新后重试`, 409);
    }
    if (allocation.kind === "INDEX_RANGE" && pool.kind === "INDEX_RANGE") {
      const ranges = [...allocation.ranges].sort(
        (left, right) => left.start - right.start || left.end - right.end
      );
      for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        if (range.end < range.start) {
          throw new BusinessError(`${pool.name} 的结束编号不能小于起始编号`);
        }
        if (range.start < pool.rangeStart || range.end > pool.rangeEnd) {
          throw new BusinessError(
            `${pool.name} 的编号必须位于 ${pool.rangeStart}–${pool.rangeEnd}`
          );
        }
        if (index > 0 && ranges[index - 1].end >= range.start) {
          throw new BusinessError(`${pool.name} 中存在重叠的编号区间`);
        }
        if (pool.sharingMode === "EXCLUSIVE") {
          const overlap = db
            .prepare(
              `SELECT g.name, r.range_start, r.range_end
               FROM resource_group_allocation_ranges r
               JOIN resource_group_allocations a ON a.id = r.allocation_id
               JOIN resource_groups g ON g.id = a.resource_group_id
               WHERE a.resource_pool_id = ?
                 AND (? IS NULL OR g.id != ?)
                 AND r.range_start <= ? AND r.range_end >= ?
               LIMIT 1`
            )
            .get(
              pool.id,
              excludeGroupId ?? null,
              excludeGroupId ?? null,
              range.end,
              range.start
            ) as
            | { name: string; range_start: number; range_end: number }
            | undefined;
          if (overlap) {
            throw new BusinessError(
              `${pool.name} ${range.start}–${range.end} 与 ${overlap.name} 的 ${overlap.range_start}–${overlap.range_end} 重叠`,
              409
            );
          }
        }
      }
      resolved.push({
        poolId: pool.id,
        poolName: pool.name,
        kind: "INDEX_RANGE",
        sharingMode: pool.sharingMode,
        unit: pool.unit,
        ranges: ranges.map((range) => ({
          start: range.start,
          end: range.end,
          ...(range.label ? { label: range.label } : {})
        }))
      });
      continue;
    }
    if (allocation.kind === "ITEM_LIST" && pool.kind === "ITEM_LIST") {
      const uniqueIds = [...new Set(allocation.itemIds)];
      if (uniqueIds.length !== allocation.itemIds.length) {
        throw new BusinessError(`${pool.name} 中存在重复设备`);
      }
      const selected = pool.items.filter((item) => uniqueIds.includes(item.id));
      if (selected.length !== uniqueIds.length) {
        throw new BusinessError(`${pool.name} 中包含不存在的设备`, 409);
      }
      if (pool.sharingMode === "EXCLUSIVE") {
        const placeholders = uniqueIds.map(() => "?").join(",");
        const overlap = db
          .prepare(
            `SELECT g.name, i.item_key
             FROM resource_group_allocation_items ai
             JOIN resource_group_allocations a ON a.id = ai.allocation_id
             JOIN resource_groups g ON g.id = a.resource_group_id
             JOIN resource_pool_items i ON i.id = ai.item_id
             WHERE ai.item_id IN (${placeholders})
               AND (? IS NULL OR g.id != ?)
             LIMIT 1`
          )
          .get(...uniqueIds, excludeGroupId ?? null, excludeGroupId ?? null) as
          | { name: string; item_key: string }
          | undefined;
        if (overlap) {
          throw new BusinessError(
            `${pool.name} ${overlap.item_key} 已分配给 ${overlap.name}`,
            409
          );
        }
      }
      resolved.push({
        poolId: pool.id,
        poolName: pool.name,
        kind: "ITEM_LIST",
        sharingMode: pool.sharingMode,
        unit: pool.unit,
        items: selected.map((item) => ({
          id: item.id,
          key: item.key,
          label: item.label
        }))
      });
      continue;
    }
    if (allocation.kind === "CAPACITY" && pool.kind === "CAPACITY") {
      const quantity =
        pool.sharingMode === "SHARED" ? pool.capacity : allocation.quantity;
      if (pool.sharingMode === "EXCLUSIVE") {
        const quantityMilli = Math.round(quantity * 1000);
        const allocated = db
          .prepare(
            `SELECT COALESCE(SUM(a.quantity_milli), 0) AS total
             FROM resource_group_allocations a
             JOIN resource_groups g ON g.id = a.resource_group_id
             WHERE a.resource_pool_id = ?
               AND (? IS NULL OR g.id != ?)`
          )
          .get(pool.id, excludeGroupId ?? null, excludeGroupId ?? null) as {
          total: number;
        };
        if (Number(allocated.total) + quantityMilli > pool.capacity * 1000) {
          throw new BusinessError(`${pool.name} 的可分配容量不足`, 409);
        }
      }
      resolved.push({
        poolId: pool.id,
        poolName: pool.name,
        kind: "CAPACITY",
        sharingMode: pool.sharingMode,
        unit: pool.unit,
        quantity
      });
    }
  }
  return resolved;
}

export function validateResourceConfiguration(
  input: ResourceConfigurationInput
) {
  const poolNames = new Set<string>();
  const poolIds = new Set<string>();
  const itemIds = new Set<string>();
  const pools = new Map(
    input.pools.map((pool) => {
      if (poolIds.has(pool.id)) {
        throw new BusinessError("资源配置中存在重复的资源项");
      }
      poolIds.add(pool.id);
      const normalizedName = pool.name.toLocaleLowerCase();
      if (poolNames.has(normalizedName)) {
        throw new BusinessError(`资源项名称“${pool.name}”重复`);
      }
      poolNames.add(normalizedName);
      if (pool.kind === "INDEX_RANGE" && pool.rangeEnd < pool.rangeStart) {
        throw new BusinessError(`${pool.name} 的结束编号不能小于起始编号`);
      }
      if (pool.kind === "ITEM_LIST") {
        const keys = new Set<string>();
        for (const item of pool.items) {
          if (itemIds.has(item.id)) {
            throw new BusinessError("资源配置中存在重复的设备");
          }
          itemIds.add(item.id);
          const normalizedKey = item.key.toLocaleLowerCase();
          if (keys.has(normalizedKey)) {
            throw new BusinessError(`${pool.name} 中的设备标识不能重复`);
          }
          keys.add(normalizedKey);
        }
      }
      return [pool.id, pool] as const;
    })
  );

  const groupNames = new Set<string>();
  const groupIds = new Set<string>();
  const rangeClaims = new Map<
    string,
    Array<{ start: number; end: number; groupName: string }>
  >();
  const itemClaims = new Map<string, string>();
  const capacityClaims = new Map<string, number>();
  const resolved = new Map<string, ResourceAllocation[]>();

  for (const group of input.groups) {
    if (groupIds.has(group.id)) {
      throw new BusinessError("资源配置中存在重复的资源组");
    }
    groupIds.add(group.id);
    const normalizedName = group.name.toLocaleLowerCase();
    if (groupNames.has(normalizedName)) {
      throw new BusinessError(`资源组名称“${group.name}”重复`);
    }
    groupNames.add(normalizedName);

    const allocationPoolIds = new Set<string>();
    const groupAllocations: ResourceAllocation[] = [];
    for (const allocation of group.allocations) {
      if (allocationPoolIds.has(allocation.poolId)) {
        throw new BusinessError(
          `${group.name} 中不能重复配置同一资源项`
        );
      }
      allocationPoolIds.add(allocation.poolId);
      const pool = pools.get(allocation.poolId);
      if (!pool) {
        throw new BusinessError(`${group.name} 使用了不存在的资源项`);
      }
      if (pool.kind !== allocation.kind) {
        throw new BusinessError(
          `${group.name} 中 ${pool.name} 的分配方式不正确`
        );
      }

      if (allocation.kind === "INDEX_RANGE" && pool.kind === "INDEX_RANGE") {
        const ranges = [...allocation.ranges].sort(
          (left, right) => left.start - right.start || left.end - right.end
        );
        for (let index = 0; index < ranges.length; index += 1) {
          const range = ranges[index];
          if (range.end < range.start) {
            throw new BusinessError(
              `${group.name} 中 ${pool.name} 的结束编号不能小于起始编号`
            );
          }
          if (range.start < pool.rangeStart || range.end > pool.rangeEnd) {
            throw new BusinessError(
              `${group.name} 中 ${pool.name} 的编号必须位于 ${pool.rangeStart}–${pool.rangeEnd}`
            );
          }
          if (index > 0 && ranges[index - 1].end >= range.start) {
            throw new BusinessError(
              `${group.name} 中 ${pool.name} 存在重叠的编号区间`
            );
          }
          const claims = rangeClaims.get(pool.id) ?? [];
          if (pool.sharingMode === "EXCLUSIVE") {
            const overlap = claims.find(
              (claim) => claim.start <= range.end && claim.end >= range.start
            );
            if (overlap) {
              throw new BusinessError(
                `${pool.name} ${range.start}–${range.end} 与 ${overlap.groupName} 的 ${overlap.start}–${overlap.end} 重叠`,
                409
              );
            }
          }
          claims.push({
            start: range.start,
            end: range.end,
            groupName: group.name
          });
          rangeClaims.set(pool.id, claims);
        }
        groupAllocations.push({
          poolId: pool.id,
          poolName: pool.name,
          kind: "INDEX_RANGE",
          sharingMode: pool.sharingMode,
          unit: pool.unit,
          ranges: ranges.map((range) => ({
            start: range.start,
            end: range.end,
            ...(range.label ? { label: range.label } : {})
          }))
        });
        continue;
      }

      if (allocation.kind === "ITEM_LIST" && pool.kind === "ITEM_LIST") {
        const selectedIds = new Set(allocation.itemIds);
        if (selectedIds.size !== allocation.itemIds.length) {
          throw new BusinessError(
            `${group.name} 中 ${pool.name} 存在重复设备`
          );
        }
        const selected = allocation.itemIds.map((itemId) => {
          const item = pool.items.find((candidate) => candidate.id === itemId);
          if (!item) {
            throw new BusinessError(
              `${group.name} 中 ${pool.name} 包含不存在的设备`
            );
          }
          const claimedBy = itemClaims.get(itemId);
          if (pool.sharingMode === "EXCLUSIVE" && claimedBy) {
              throw new BusinessError(
                `${pool.name} ${item.key} 同时分配给了 ${claimedBy} 和 ${group.name}`,
                409
              );
          }
          if (pool.sharingMode === "EXCLUSIVE") {
            itemClaims.set(itemId, group.name);
          }
          return item;
        });
        groupAllocations.push({
          poolId: pool.id,
          poolName: pool.name,
          kind: "ITEM_LIST",
          sharingMode: pool.sharingMode,
          unit: pool.unit,
          items: selected.map((item) => ({
            id: item.id,
            key: item.key,
            label: item.label
          }))
        });
        continue;
      }

      if (allocation.kind === "CAPACITY" && pool.kind === "CAPACITY") {
        const quantity =
          pool.sharingMode === "SHARED" ? pool.capacity : allocation.quantity;
        if (pool.sharingMode === "EXCLUSIVE") {
          const nextTotal =
            (capacityClaims.get(pool.id) ?? 0) + quantity;
          if (nextTotal > pool.capacity) {
            throw new BusinessError(
              `${pool.name} 的分配总量 ${nextTotal} ${pool.unit} 超过可用容量 ${pool.capacity} ${pool.unit}`,
              409
            );
          }
          capacityClaims.set(pool.id, nextTotal);
        }
        groupAllocations.push({
          poolId: pool.id,
          poolName: pool.name,
          kind: "CAPACITY",
          sharingMode: pool.sharingMode,
          unit: pool.unit,
          quantity
        });
      }
    }
    resolved.set(group.id, groupAllocations);
  }
  return resolved;
}

export function replaceGroupAllocations(
  groupId: string,
  allocations: ResourceAllocation[]
) {
  db.prepare(
    "DELETE FROM resource_group_allocations WHERE resource_group_id = ?"
  ).run(groupId);
  const insertAllocation = db.prepare(
    `INSERT INTO resource_group_allocations(
      id, resource_group_id, resource_pool_id, kind, quantity_milli
    ) VALUES(?, ?, ?, ?, ?)`
  );
  const insertRange = db.prepare(
    `INSERT INTO resource_group_allocation_ranges(
      id, allocation_id, range_start, range_end, label
    ) VALUES(?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare(
    `INSERT INTO resource_group_allocation_items(allocation_id, item_id)
     VALUES(?, ?)`
  );
  for (const allocation of allocations) {
    const allocationId = randomUUID();
    insertAllocation.run(
      allocationId,
      groupId,
      allocation.poolId,
      allocation.kind,
      allocation.kind === "CAPACITY"
        ? Math.round(allocation.quantity * 1000)
        : null
    );
    if (allocation.kind === "INDEX_RANGE") {
      for (const range of allocation.ranges) {
        insertRange.run(
          randomUUID(),
          allocationId,
          range.start,
          range.end,
          range.label ?? ""
        );
      }
    }
    if (allocation.kind === "ITEM_LIST") {
      for (const item of allocation.items) {
        insertItem.run(allocationId, item.id);
      }
    }
  }
}

export function insertGroupRevision(
  groupId: string,
  version: number,
  configuration: unknown,
  actorUserId: string
) {
  db.prepare(
    `INSERT INTO resource_group_revisions(
      id, resource_group_id, version, configuration_json, changed_by, created_at
    ) VALUES(?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    groupId,
    version,
    JSON.stringify(configuration),
    actorUserId,
    nowIso()
  );
}

export function insertPoolRevision(
  poolId: string,
  version: number,
  configuration: unknown,
  actorUserId: string
) {
  db.prepare(
    `INSERT INTO resource_pool_revisions(
      id, resource_pool_id, version, configuration_json, changed_by, created_at
    ) VALUES(?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    poolId,
    version,
    JSON.stringify(configuration),
    actorUserId,
    nowIso()
  );
}

export function machineResourceSummary(machineId: string) {
  return listResourcePools(machineId)
    .map((pool) => {
      const total =
        pool.kind === "INDEX_RANGE"
          ? `${pool.rangeEnd - pool.rangeStart + 1} ${pool.unit}`
          : pool.kind === "ITEM_LIST"
            ? `${pool.items.length} ${pool.unit}`
            : `${formatQuantity(pool.capacity)} ${pool.unit}`;
      return pool.sharingMode === "SHARED"
        ? `共享 · ${pool.name} · ${total}`
        : `${pool.name} · ${total}`;
    })
    .join(" ｜ ");
}

export function formatQuantity(value: number) {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
