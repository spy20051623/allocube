import { describe, expect, it } from "vitest";
import { calendarAnchoredPopoverPosition } from "../src/CalendarAnchoredPopover.js";

const viewport = { width: 1000, height: 700 };

describe("日历定位弹层", () => {
  it("右侧空间充足时显示在锚点右侧", () => {
    expect(
      calendarAnchoredPopoverPosition(
        { left: 100, right: 240, top: 160 },
        320,
        408,
        viewport
      )
    ).toEqual({ left: 248, top: 152 });
  });

  it("右侧空间不足时切换到锚点左侧", () => {
    expect(
      calendarAnchoredPopoverPosition(
        { left: 760, right: 900, top: 160 },
        320,
        408,
        viewport
      )
    ).toEqual({ left: 432, top: 152 });
  });

  it("始终保留上下视口边距", () => {
    expect(
      calendarAnchoredPopoverPosition(
        { left: 100, right: 240, top: 4 },
        320,
        408,
        viewport
      ).top
    ).toBe(12);
    expect(
      calendarAnchoredPopoverPosition(
        { left: 100, right: 240, top: 650 },
        320,
        408,
        viewport
      ).top
    ).toBe(280);
  });
});
