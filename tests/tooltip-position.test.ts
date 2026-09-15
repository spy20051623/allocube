import { describe, expect, it } from "vitest";
import { tooltipPosition } from "../src/tooltip-position";

describe("悬浮信息定位", () => {
  const viewport = { width: 1000, height: 800 };
  const bottomAnchor = { left: 400, right: 500, top: 700, bottom: 757 };

  it.each([60, 130, 280])("向上显示实际高度 %i 的内容时，底边距锚点始终为 8px", height => {
    const result = tooltipPosition(bottomAnchor, { width: 280, height }, viewport, { align: "center" });
    expect(result.placement).toBe("above");
    expect(bottomAnchor.top - result.top - height).toBe(8);
    expect(result.left).toBe(310);
  });

  it("下方足够容纳实际内容时不提前翻转", () => {
    const anchor = { ...bottomAnchor, top: 600, bottom: 657 };
    const result = tooltipPosition(anchor, { width: 280, height: 60 }, viewport);
    expect(result).toMatchObject({ placement: "below", top: 665 });
  });

  it("下方空间不足时资源摘要同样向上显示", () => {
    const result = tooltipPosition(bottomAnchor, { width: 320, height: 85 }, viewport, { gap: 7 });
    expect(result).toMatchObject({ placement: "above", top: 608, left: 400 });
  });

  it("窄容器和横向滚动不会把浮层推到视口之外", () => {
    const result = tooltipPosition({ left: -40, right: 30, top: 600, bottom: 657 },
      { width: 280, height: 80 }, { width: 320, height: 800 },
      { align: "center", bounds: { left: -200, right: 160 } });
    expect(result.left).toBe(12);
    expect(result.left + 280).toBeLessThanOrEqual(308);
  });

  it("靠近右边缘时保留视口边距", () => {
    const result = tooltipPosition({ ...bottomAnchor, left: 980, right: 1000 }, { width: 280, height: 80 }, viewport);
    expect(result.left).toBe(708);
  });

  it("上下都放不下时保持浮层在视口内", () => {
    const result = tooltipPosition({ left: 100, right: 200, top: 140, bottom: 197 },
      { width: 280, height: 276 }, { width: 390, height: 300 });
    expect(result.top).toBe(12);
    expect(result.top + 276).toBe(288);
  });
});
