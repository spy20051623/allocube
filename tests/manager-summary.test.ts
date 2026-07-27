import { describe, expect, it } from "vitest";
import { calculateVisibleManagerCount } from "../src/manager-summary.js";

describe("全部资源管理员摘要", () => {
  it("完整名单能放下时展示所有管理员", () => {
    expect(calculateVisibleManagerCount(240, [58, 72, 64], 48, 10)).toBe(3);
  });

  it("溢出时为总人数按钮预留空间并展示最大完整前缀", () => {
    expect(calculateVisibleManagerCount(200, [58, 72, 64], 48, 10)).toBe(2);
    expect(calculateVisibleManagerCount(145, [58, 72, 64], 48, 10)).toBe(1);
  });

  it("单个姓名过长时只展示总人数按钮，不截断管理员条目", () => {
    expect(calculateVisibleManagerCount(120, [180, 60], 48, 10)).toBe(0);
  });

  it("可用宽度变化时展示人数随之变化", () => {
    const widths = [70, 86, 62, 74];
    expect(calculateVisibleManagerCount(370, widths, 48, 10)).toBe(4);
    expect(calculateVisibleManagerCount(250, widths, 48, 10)).toBe(2);
    expect(calculateVisibleManagerCount(170, widths, 48, 10)).toBe(1);
  });

  it("没有管理员或尚未取得可用宽度时不展示条目", () => {
    expect(calculateVisibleManagerCount(200, [], 48, 10)).toBe(0);
    expect(calculateVisibleManagerCount(0, [60], 48, 10)).toBe(0);
  });
});
