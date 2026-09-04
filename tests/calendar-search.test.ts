import { describe, expect, it } from "vitest";
import { searchCalendarResources } from "../src/calendar-search.js";
import type { Machine, ResourceGroup } from "../src/shared/types.js";

const machines: Machine[] = [
  {
    id: "machine-b",
    name: "GPU-02",
    address: "10.2.3.42",
    hardwareNotes: "not searchable hardware note",
    connectionGuide: "not searchable connection guide",
    tags: ["Inference", "A100"],
    resourceSummary: "A100 × 4 · 512 GB RAM",
    status: "ACTIVE",
    isManager: false
  },
  {
    id: "machine-a",
    name: "GPU-01",
    address: "10.2.3.41",
    hardwareNotes: "",
    connectionGuide: "",
    tags: ["训练"],
    resourceSummary: "A100 × 8 · 1 TB 内存",
    status: "ACTIVE",
    isManager: false
  },
  {
    id: "machine-c",
    name: "CPU-17",
    address: "10.2.4.17",
    hardwareNotes: "",
    connectionGuide: "",
    tags: ["编译"],
    resourceSummary: "鲲鹏 920 · 256 核",
    status: "ACTIVE",
    isManager: false
  }
];

const groups: ResourceGroup[] = [
  {
    id: "group-train",
    machineId: "machine-a",
    name: "训练组 A",
    allocations: [
      {
        poolId: "pool-gpu",
        poolName: "GPU 卡",
        kind: "INDEX_RANGE",
        sharingMode: "EXCLUSIVE",
        unit: "card",
        ranges: [{ start: 0, end: 3, label: "high memory" }]
      }
    ],
    resourceSummary: "GPU 0–3 · CPU 0–63",
    description: "模型训练",
    tags: ["高显存"],
    sortOrder: 0,
    status: "ACTIVE",
    version: 1
  },
  {
    id: "group-infer",
    machineId: "machine-b",
    name: "Inference",
    allocations: [
      {
        poolId: "pool-device",
        poolName: "Accelerators",
        kind: "ITEM_LIST",
        sharingMode: "EXCLUSIVE",
        unit: "device",
        items: [{ id: "item-1", key: "npu0", label: "NPU Zero" }]
      }
    ],
    resourceSummary: "NPU 0",
    description: "online service",
    tags: ["serving"],
    sortOrder: 0,
    status: "ACTIVE",
    version: 1
  },
  {
    id: "group-compile",
    machineId: "machine-c",
    name: "编译组",
    allocations: [
      {
        poolId: "pool-memory",
        poolName: "Memory",
        kind: "CAPACITY",
        sharingMode: "SHARED",
        unit: "GB",
        quantity: 256
      }
    ],
    resourceSummary: "CPU 0–127 · 256 GB 内存",
    description: "",
    tags: [],
    sortOrder: 0,
    status: "ACTIVE",
    version: 1
  }
];

describe("日历资源搜索", () => {
  it("空查询不显示常驻机器列表", () => {
    expect(searchCalendarResources(machines, groups, "  ")).toEqual([]);
  });

  it("名称匹配忽略大小写和全半角差异", () => {
    const result = searchCalendarResources(machines, groups, "ｇｐｕ－０１");
    expect(result.map((item) => item.machine.id)).toEqual(["machine-a"]);
    expect(result[0]?.machineMatched).toBe(true);
  });

  it("所有语言的名称都允许查询字符按顺序匹配", () => {
    const matchingMachines: Machine[] = [
      {
        ...machines[0],
        id: "machine-disabled",
        name: "测试停用节点"
      },
      {
        ...machines[1],
        id: "machine-maintenance",
        name: "测试维护节点"
      }
    ];
    const result = searchCalendarResources(
      matchingMachines,
      matchingMachines.map((machine, index) => ({
        ...groups[0],
        id: `group-match-${index}`,
        machineId: machine.id,
        name: "默认资源组"
      })),
      "测试节点"
    );
    expect(result.map((item) => item.machine.name)).toEqual([
      "测试停用节点",
      "测试维护节点"
    ]);

    const latinMachine: Machine = {
      ...machines[0],
      id: "machine-test",
      name: "test"
    };
    expect(
      searchCalendarResources(
        [latinMachine],
        [{ ...groups[0], id: "group-test", machineId: latinMachine.id }],
        "tst"
      )[0]?.machine.name
    ).toBe("test");
    expect(searchCalendarResources(machines, groups, "ifc")[0]?.groups[0]?.name).toBe(
      "Inference"
    );
  });

  it("不返回没有可见资源组、因而无法在日历中定位的机器", () => {
    const machineWithoutGroups: Machine = {
      ...machines[0],
      id: "machine-without-groups",
      name: "孤立测试机"
    };
    expect(
      searchCalendarResources(
        [...machines, machineWithoutGroups],
        groups,
        "孤立测试机"
      )
    ).toEqual([]);
  });

  it("多个关键词可以分布在机器的地址、标签和资源摘要中", () => {
    const result = searchCalendarResources(machines, groups, "10.2.3.42 a100 inference");
    expect(result.map((item) => item.machine.id)).toEqual(["machine-b"]);
  });

  it("机器结果优先于资源组名称和资源详情结果", () => {
    const competingGroup: ResourceGroup = {
      ...groups[2],
      id: "group-inference-name",
      machineId: "machine-c",
      name: "Inference"
    };
    const result = searchCalendarResources(
      machines,
      [...groups, competingGroup],
      "Inference"
    );
    expect(result.map((item) => item.machine.id)).toEqual([
      "machine-b",
      "machine-c"
    ]);
    expect(result[0]?.machineMatched).toBe(true);
    expect(result[0]?.groups.map((group) => group.id)).toEqual(["group-infer"]);
    expect(result[1]?.machineMatched).toBe(false);
    expect(result[1]?.groups.map((group) => group.id)).toEqual([
      "group-inference-name"
    ]);
  });

  it("资源组可以通过描述、标签、池名称、条目标识和范围定位", () => {
    expect(searchCalendarResources(machines, groups, "模型 高显存")[0]?.groups[0]?.id).toBe("group-train");
    expect(searchCalendarResources(machines, groups, "GPU 卡 0-3")[0]?.groups[0]?.id).toBe("group-train");
    expect(searchCalendarResources(machines, groups, "accelerators npu0")[0]?.groups[0]?.id).toBe("group-infer");
    expect(searchCalendarResources(machines, groups, "memory 256 gb")[0]?.groups[0]?.id).toBe("group-compile");
  });

  it("不搜索机器硬件备注、连接说明或占用内容", () => {
    expect(searchCalendarResources(machines, groups, "not searchable")).toEqual([]);
    expect(searchCalendarResources(machines, groups, "reservation title")).toEqual([]);
  });
});
