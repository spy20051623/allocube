export type ResourcePoolDraftInput = {
  id: string;
  name: string;
  kind: "INDEX_RANGE" | "ITEM_LIST" | "CAPACITY";
  sharingMode?: "EXCLUSIVE" | "SHARED";
  unit: string;
  description: string;
  sortOrder: number;
  rangeStart: number;
  rangeEnd: number;
  capacity: number;
  items: Array<{ id: string; key: string; label: string }>;
};

export type ResourceAllocationDraftInput =
  | {
      poolId: string;
      kind: "INDEX_RANGE";
      ranges: Array<{ start: number; end: number; label?: string }>;
    }
  | { poolId: string; kind: "ITEM_LIST"; itemIds: string[] }
  | { poolId: string; kind: "CAPACITY"; quantity: number };

export type ResourceGroupDraftInput = {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tagInput?: string;
  sortOrder?: number;
  allocations: ResourceAllocationDraftInput[];
};

export type ResourceConfigurationIssue = {
  target: "POOL" | "GROUP" | "ALLOCATION";
  poolId?: string;
  groupId?: string;
  field: string;
  message: string;
};

export function reorderResourceDrafts<
  T extends { id: string; sortOrder: number }
>(
  pools: T[],
  sourceId: string,
  targetId: string,
  position: "BEFORE" | "AFTER"
) {
  const sourceIndex = pools.findIndex((pool) => pool.id === sourceId);
  if (
    sourceIndex < 0 ||
    !pools.some((pool) => pool.id === targetId) ||
    sourceId === targetId
  ) {
    return pools;
  }
  const reordered = [...pools];
  const [moved] = reordered.splice(sourceIndex, 1);
  const targetIndex = reordered.findIndex((pool) => pool.id === targetId);
  const insertionIndex = position === "BEFORE"
    ? targetIndex
    : targetIndex + 1;
  reordered.splice(insertionIndex, 0, moved);
  return reordered.map((pool, index) => ({ ...pool, sortOrder: index }));
}

export function resourceTagDraftIssue(tags: string[], input = "") {
  const normalizedTags = tags.map((tag) => tag.trim());
  const uniqueTags = new Set(
    normalizedTags.map((tag) => tag.toLocaleLowerCase())
  );
  if (
    normalizedTags.length > 30 ||
    normalizedTags.some((tag) => !tag || tag.length > 40)
  ) {
    return "标签最多 30 个，每个应为 1–40 个字符";
  }
  if (uniqueTags.size !== normalizedTags.length) {
    return "标签不能重复";
  }
  const pendingTag = input.trim();
  if (!pendingTag) return "";
  if (tags.length >= 30) return "标签最多 30 个";
  if (uniqueTags.has(pendingTag.toLocaleLowerCase())) {
    return "该标签已经存在";
  }
  if (pendingTag.length > 40) return "标签不能超过 40 个字符";
  return "按回车或点击添加当前标签";
}

function hasAtMostThreeDecimals(value: number) {
  return Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7;
}

export function validateResourceConfigurationDraft(
  pools: ResourcePoolDraftInput[],
  groups: ResourceGroupDraftInput[]
) {
  const issues: ResourceConfigurationIssue[] = [];
  const issueKeys = new Set<string>();
  const push = (issue: ResourceConfigurationIssue) => {
    const key = [
      issue.target,
      issue.poolId ?? "",
      issue.groupId ?? "",
      issue.field,
      issue.message
    ].join("|");
    if (issueKeys.has(key)) return;
    issueKeys.add(key);
    issues.push(issue);
  };

  const poolById = new Map(pools.map((pool) => [pool.id, pool]));
  const poolNames = new Map<string, ResourcePoolDraftInput[]>();
  const allItemIds = new Map<string, string>();

  for (const pool of pools) {
    const name = pool.name.trim();
    if (!name || name.length > 80) {
      push({
        target: "POOL",
        poolId: pool.id,
        field: "name",
        message: "资源项名称应为 1–80 个字符"
      });
    } else {
      const normalized = name.toLocaleLowerCase();
      poolNames.set(normalized, [...(poolNames.get(normalized) ?? []), pool]);
    }
    const unit = pool.unit.trim();
    if (!unit || unit.length > 20) {
      push({
        target: "POOL",
        poolId: pool.id,
        field: "unit",
        message: "单位应为 1–20 个字符"
      });
    }
    if (pool.description.length > 2000) {
      push({
        target: "POOL",
        poolId: pool.id,
        field: "description",
        message: "说明不能超过 2000 个字符"
      });
    }
    if (
      !Number.isInteger(pool.sortOrder) ||
      pool.sortOrder < 0 ||
      pool.sortOrder > 10000
    ) {
      push({
        target: "POOL",
        poolId: pool.id,
        field: "sortOrder",
        message: "排序应为 0–10000 的整数"
      });
    }

    if (pool.kind === "INDEX_RANGE") {
      if (
        !Number.isInteger(pool.rangeStart) ||
        !Number.isInteger(pool.rangeEnd) ||
        pool.rangeStart < 0 ||
        pool.rangeEnd < pool.rangeStart
      ) {
        push({
          target: "POOL",
          poolId: pool.id,
          field: "range",
          message: "编号范围必须是非负整数，且结束编号不能小于起始编号"
        });
      }
    } else if (pool.kind === "CAPACITY") {
      if (
        !Number.isFinite(pool.capacity) ||
        pool.capacity <= 0 ||
        pool.capacity > 1_000_000_000 ||
        !hasAtMostThreeDecimals(pool.capacity)
      ) {
        push({
          target: "POOL",
          poolId: pool.id,
          field: "capacity",
          message: "容量必须大于 0，并且最多保留三位小数"
        });
      }
    } else {
      if (!pool.items.length) {
        push({
          target: "POOL",
          poolId: pool.id,
          field: "items",
          message: "设备列表至少需要一项设备"
        });
      }
      const itemKeys = new Map<string, number>();
      for (const item of pool.items) {
        const key = item.key.trim();
        const label = item.label.trim();
        if (!key || key.length > 80 || !label || label.length > 120) {
          push({
            target: "POOL",
            poolId: pool.id,
            field: "items",
            message: "每项设备都需要合法的标识和名称"
          });
        }
        const normalizedKey = key.toLocaleLowerCase();
        itemKeys.set(normalizedKey, (itemKeys.get(normalizedKey) ?? 0) + 1);
        const otherPoolId = allItemIds.get(item.id);
        if (otherPoolId && otherPoolId !== pool.id) {
          push({
            target: "POOL",
            poolId: pool.id,
            field: "items",
            message: "设备内部标识重复，请删除后重新添加"
          });
        }
        allItemIds.set(item.id, pool.id);
      }
      if ([...itemKeys.values()].some((count) => count > 1)) {
        push({
          target: "POOL",
          poolId: pool.id,
          field: "items",
          message: "同一资源项中的设备标识不能重复"
        });
      }
    }
  }

  for (const sameNamePools of poolNames.values()) {
    if (sameNamePools.length < 2) continue;
    for (const pool of sameNamePools) {
      push({
        target: "POOL",
        poolId: pool.id,
        field: "name",
        message: "资源项名称不能重复"
      });
    }
  }

  const groupNames = new Map<string, ResourceGroupDraftInput[]>();
  const rangeClaims = new Map<
    string,
    Array<{
      groupId: string;
      groupName: string;
      start: number;
      end: number;
    }>
  >();
  const itemClaims = new Map<
    string,
    { groupId: string; groupName: string; poolId: string }
  >();
  const capacityClaims = new Map<
    string,
    Array<{ groupId: string; quantity: number }>
  >();

  for (const group of groups) {
    const name = group.name.trim();
    if (!name || name.length > 80) {
      push({
        target: "GROUP",
        groupId: group.id,
        field: "name",
        message: "资源组名称应为 1–80 个字符"
      });
    } else {
      const normalized = name.toLocaleLowerCase();
      groupNames.set(normalized, [...(groupNames.get(normalized) ?? []), group]);
    }
    if (group.description.length > 2000) {
      push({
        target: "GROUP",
        groupId: group.id,
        field: "description",
        message: "说明不能超过 2000 个字符"
      });
    }
    if (
      group.sortOrder !== undefined &&
      (
        !Number.isInteger(group.sortOrder) ||
        group.sortOrder < 0 ||
        group.sortOrder > 10000
      )
    ) {
      push({
        target: "GROUP",
        groupId: group.id,
        field: "sortOrder",
        message: "排序应为 0–10000 的整数"
      });
    }
    const tagIssue = resourceTagDraftIssue(
      group.tags,
      group.tagInput
    );
    if (tagIssue) {
      push({
        target: "GROUP",
        groupId: group.id,
        field: "tags",
        message: tagIssue
      });
    }
    if (!group.allocations.length) {
      push({
        target: "GROUP",
        groupId: group.id,
        field: "allocations",
        message: "资源组至少需要分配一项资源"
      });
    }

    const allocatedPoolIds = new Set<string>();
    for (const allocation of group.allocations) {
      const allocationIssue = (
        field: string,
        message: string,
        targetGroupId = group.id
      ) =>
        push({
          target: "ALLOCATION",
          poolId: allocation.poolId,
          groupId: targetGroupId,
          field,
          message
        });
      if (allocatedPoolIds.has(allocation.poolId)) {
        allocationIssue("allocation", "同一资源组不能重复分配同一资源项");
      }
      allocatedPoolIds.add(allocation.poolId);
      const pool = poolById.get(allocation.poolId);
      if (!pool) {
        allocationIssue("allocation", "该资源项已经不存在");
        continue;
      }
      if (pool.kind !== allocation.kind) {
        allocationIssue("allocation", "资源项的分配方式不匹配");
        continue;
      }

      if (allocation.kind === "INDEX_RANGE" && pool.kind === "INDEX_RANGE") {
        if (!allocation.ranges.length) {
          allocationIssue("ranges", "至少需要一个编号区间");
          continue;
        }
        const ranges = [...allocation.ranges].sort(
          (left, right) => left.start - right.start || left.end - right.end
        );
        for (let index = 0; index < ranges.length; index += 1) {
          const range = ranges[index];
          if (
            !Number.isInteger(range.start) ||
            !Number.isInteger(range.end) ||
            range.start < pool.rangeStart ||
            range.end > pool.rangeEnd ||
            range.end < range.start
          ) {
            allocationIssue(
              "ranges",
              `${pool.name} 的编号必须位于 ${pool.rangeStart}–${pool.rangeEnd}`
            );
            continue;
          }
          if (index > 0 && ranges[index - 1].end >= range.start) {
            allocationIssue("ranges", "同一资源组内存在重叠的编号区间");
          }
          const claims = rangeClaims.get(pool.id) ?? [];
          if (pool.sharingMode !== "SHARED") {
            for (const claim of claims) {
              if (claim.groupId === group.id) continue;
              if (claim.start <= range.end && claim.end >= range.start) {
                allocationIssue(
                  "ranges",
                  `与 ${claim.groupName} 的 ${claim.start}–${claim.end} 重叠`
                );
                push({
                  target: "ALLOCATION",
                  poolId: pool.id,
                  groupId: claim.groupId,
                  field: "ranges",
                  message: `与 ${group.name || "未命名资源组"} 的 ${range.start}–${range.end} 重叠`
                });
              }
            }
          }
          claims.push({
            groupId: group.id,
            groupName: group.name || "未命名资源组",
            start: range.start,
            end: range.end
          });
          rangeClaims.set(pool.id, claims);
        }
      } else if (
        allocation.kind === "ITEM_LIST" &&
        pool.kind === "ITEM_LIST"
      ) {
        if (!allocation.itemIds.length) {
          allocationIssue("items", "至少需要选择一项设备");
        }
        if (new Set(allocation.itemIds).size !== allocation.itemIds.length) {
          allocationIssue("items", "同一设备不能重复选择");
        }
        for (const itemId of allocation.itemIds) {
          const item = pool.items.find((candidate) => candidate.id === itemId);
          if (!item) {
            allocationIssue("items", "包含已经不存在的设备");
            continue;
          }
          const claim = itemClaims.get(itemId);
          if (
            pool.sharingMode !== "SHARED" &&
            claim &&
            claim.groupId !== group.id
          ) {
            allocationIssue(
              "items",
              `${item.key} 已分配给 ${claim.groupName}`
            );
            push({
              target: "ALLOCATION",
              poolId: claim.poolId,
              groupId: claim.groupId,
              field: "items",
              message: `${item.key} 同时分配给了 ${group.name || "未命名资源组"}`
            });
          } else if (pool.sharingMode !== "SHARED") {
            itemClaims.set(itemId, {
              groupId: group.id,
              groupName: group.name || "未命名资源组",
              poolId: pool.id
            });
          }
        }
      } else if (
        allocation.kind === "CAPACITY" &&
        pool.kind === "CAPACITY"
      ) {
        if (
          pool.sharingMode !== "SHARED" &&
          (
            !Number.isFinite(allocation.quantity) ||
            allocation.quantity <= 0 ||
            !hasAtMostThreeDecimals(allocation.quantity)
          )
        ) {
          allocationIssue(
            "capacity",
            "分配数量必须大于 0，并且最多保留三位小数"
          );
        }
        if (pool.sharingMode !== "SHARED") {
          capacityClaims.set(pool.id, [
            ...(capacityClaims.get(pool.id) ?? []),
            { groupId: group.id, quantity: allocation.quantity }
          ]);
        }
      }
    }
  }

  for (const sameNameGroups of groupNames.values()) {
    if (sameNameGroups.length < 2) continue;
    for (const group of sameNameGroups) {
      push({
        target: "GROUP",
        groupId: group.id,
        field: "name",
        message: "资源组名称不能重复"
      });
    }
  }

  for (const [poolId, claims] of capacityClaims) {
    const pool = poolById.get(poolId);
    if (
      !pool ||
      pool.kind !== "CAPACITY" ||
      pool.sharingMode === "SHARED"
    ) continue;
    const total = claims.reduce((sum, claim) => sum + claim.quantity, 0);
    if (!Number.isFinite(total) || total <= pool.capacity) continue;
    for (const claim of claims) {
      push({
        target: "ALLOCATION",
        poolId,
        groupId: claim.groupId,
        field: "capacity",
        message: `分配总量 ${total} ${pool.unit} 超过可用容量 ${pool.capacity} ${pool.unit}`
      });
    }
  }

  return issues;
}
