import { describe, expect, it } from "vitest";
import {
  reorderResourceDrafts,
  validateResourceConfigurationDraft,
  type ResourceGroupDraftInput,
  type ResourcePoolDraftInput
} from "../src/resource-config-validation.js";

const pools: ResourcePoolDraftInput[] = [
  {
    id: "range",
    name: "逻辑核",
    kind: "INDEX_RANGE",
    unit: "核",
    description: "",
    sortOrder: 0,
    rangeStart: 0,
    rangeEnd: 31,
    capacity: 1,
    items: []
  },
  {
    id: "gpu",
    name: "GPU",
    kind: "ITEM_LIST",
    unit: "张",
    description: "",
    sortOrder: 1,
    rangeStart: 0,
    rangeEnd: 0,
    capacity: 1,
    items: [
      { id: "gpu-0", key: "GPU 0", label: "H100 0" },
      { id: "gpu-1", key: "GPU 1", label: "H100 1" }
    ]
  },
  {
    id: "memory",
    name: "内存",
    kind: "CAPACITY",
    unit: "GiB",
    description: "",
    sortOrder: 2,
    rangeStart: 0,
    rangeEnd: 0,
    capacity: 128,
    items: []
  }
];

function group(
  id: string,
  name: string,
  allocations: ResourceGroupDraftInput["allocations"]
): ResourceGroupDraftInput {
  return {
    id,
    name,
    description: "",
    tags: [],
    tagInput: "",
    allocations
  };
}

describe("资源配置草稿静态检查", () => {
  it("拖动资源项后同步重建展示顺序", () => {
    const reordered = reorderResourceDrafts(
      [
        { id: "cpu", sortOrder: 8 },
        { id: "gpu", sortOrder: 12 },
        { id: "memory", sortOrder: 20 }
      ],
      "memory",
      "cpu",
      "BEFORE"
    );
    expect(reordered.map((pool) => pool.id)).toEqual([
      "memory",
      "cpu",
      "gpu"
    ]);
    expect(reordered.map((pool) => pool.sortOrder)).toEqual([0, 1, 2]);

    const movedToEnd = reorderResourceDrafts(
      reordered,
      "memory",
      "gpu",
      "AFTER"
    );
    expect(movedToEnd.map((pool) => pool.id)).toEqual([
      "cpu",
      "gpu",
      "memory"
    ]);

    const reorderedGroups = reorderResourceDrafts(
      [
        { id: "group-a", sortOrder: 0 },
        { id: "group-b", sortOrder: 1 },
        { id: "group-c", sortOrder: 2 }
      ],
      "group-c",
      "group-a",
      "BEFORE"
    );
    expect(reorderedGroups.map((group) => group.id)).toEqual([
      "group-c",
      "group-a",
      "group-b"
    ]);
    expect(reorderedGroups.map((group) => group.sortOrder)).toEqual([
      0,
      1,
      2
    ]);
  });

  it("合法配置没有问题", () => {
    const issues = validateResourceConfigurationDraft(pools, [
      group("group-a", "资源组 A", [
        {
          poolId: "range",
          kind: "INDEX_RANGE",
          ranges: [{ start: 0, end: 7 }]
        },
        {
          poolId: "gpu",
          kind: "ITEM_LIST",
          itemIds: ["gpu-0"]
        },
        {
          poolId: "memory",
          kind: "CAPACITY",
          quantity: 64
        }
      ]),
      group("group-b", "资源组 B", [
        {
          poolId: "range",
          kind: "INDEX_RANGE",
          ranges: [{ start: 8, end: 15 }]
        },
        {
          poolId: "gpu",
          kind: "ITEM_LIST",
          itemIds: ["gpu-1"]
        },
        {
          poolId: "memory",
          kind: "CAPACITY",
          quantity: 64
        }
      ])
    ]);
    expect(issues).toEqual([]);
  });

  it("重叠区间会同时标记两个资源组", () => {
    const issues = validateResourceConfigurationDraft(pools, [
      group("group-a", "资源组 A", [{
        poolId: "range",
        kind: "INDEX_RANGE",
        ranges: [{ start: 0, end: 7 }]
      }]),
      group("group-b", "资源组 B", [{
        poolId: "range",
        kind: "INDEX_RANGE",
        ranges: [{ start: 7, end: 15 }]
      }])
    ]);
    expect(
      new Set(
        issues
          .filter((issue) => issue.field === "ranges")
          .map((issue) => issue.groupId)
      )
    ).toEqual(new Set(["group-a", "group-b"]));
    expect(issues.some((issue) => issue.message.includes("重叠"))).toBe(true);
  });

  it("重复设备和容量超限会标记所有受影响的分配", () => {
    const issues = validateResourceConfigurationDraft(pools, [
      group("group-a", "资源组 A", [
        { poolId: "gpu", kind: "ITEM_LIST", itemIds: ["gpu-0"] },
        { poolId: "memory", kind: "CAPACITY", quantity: 80 }
      ]),
      group("group-b", "资源组 B", [
        { poolId: "gpu", kind: "ITEM_LIST", itemIds: ["gpu-0"] },
        { poolId: "memory", kind: "CAPACITY", quantity: 64 }
      ])
    ]);
    expect(
      issues.filter((issue) => issue.field === "items")
    ).toHaveLength(2);
    expect(
      issues.filter((issue) => issue.field === "capacity")
    ).toHaveLength(2);
  });

  it("共享资源允许不同资源组引用相同的编号、设备和容量", () => {
    const sharedPools = pools.map((pool) => ({
      ...pool,
      sharingMode: "SHARED" as const
    }));
    const issues = validateResourceConfigurationDraft(sharedPools, [
      group("group-a", "资源组 A", [
        {
          poolId: "range",
          kind: "INDEX_RANGE",
          ranges: [{ start: 0, end: 7 }]
        },
        { poolId: "gpu", kind: "ITEM_LIST", itemIds: ["gpu-0"] },
        { poolId: "memory", kind: "CAPACITY", quantity: 128 }
      ]),
      group("group-b", "资源组 B", [
        {
          poolId: "range",
          kind: "INDEX_RANGE",
          ranges: [{ start: 0, end: 7 }]
        },
        { poolId: "gpu", kind: "ITEM_LIST", itemIds: ["gpu-0"] },
        { poolId: "memory", kind: "CAPACITY", quantity: 128 }
      ])
    ]);
    expect(issues).toEqual([]);
  });

  it("新增空白资源和空资源组会立即产生定位信息", () => {
    const issues = validateResourceConfigurationDraft(
      [{
        id: "new-pool",
        name: "",
        kind: "INDEX_RANGE",
        unit: "",
        description: "",
        sortOrder: 0,
        rangeStart: 5,
        rangeEnd: 1,
        capacity: 1,
        items: []
      }],
      [group("new-group", "", [])]
    );
    expect(
      issues.some(
        (issue) => issue.poolId === "new-pool" && issue.field === "name"
      )
    ).toBe(true);
    expect(
      issues.some(
        (issue) => issue.groupId === "new-group" &&
          issue.field === "allocations"
      )
    ).toBe(true);
  });

  it("未按回车提交和重复的标签会阻止保存", () => {
    const pending = group("group-a", "资源组 A", [{
      poolId: "range",
      kind: "INDEX_RANGE",
      ranges: [{ start: 0, end: 7 }]
    }]);
    pending.tags = ["训练"];
    pending.tagInput = "高优先级";
    expect(
      validateResourceConfigurationDraft(pools, [pending]).some(
        (issue) => issue.message === "按回车或点击添加当前标签"
      )
    ).toBe(true);

    pending.tags = ["训练", "训练"];
    pending.tagInput = "";
    expect(
      validateResourceConfigurationDraft(pools, [pending]).some(
        (issue) => issue.message === "标签不能重复"
      )
    ).toBe(true);
  });
});
