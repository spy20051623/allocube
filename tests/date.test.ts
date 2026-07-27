import { describe, expect, it } from "vitest";
import {
  calendarMonthDates,
  calendarMonthLabel,
  chinaDateDayOffset,
  durationHoursText,
  formatChina,
  formatChinaDate,
  formatChinaFullMinute,
  isoToChinaLocal,
  shiftCalendarMonth
} from "../src/date.js";

describe("北京时间显示", () => {
  it("完整显示年月日时分", () => {
    expect(durationHoursText(30)).toBe("0.5 小时");
    expect(durationHoursText(120)).toBe("2.0 小时");
    expect(formatChinaDate("2026-07-25T15:08:42.000Z")).toBe("2026/07/25");
    expect(
      chinaDateDayOffset(
        "2026-07-25T15:08:42.000Z",
        "2026-07-25T18:08:42.000Z"
      )
    ).toBe(1);
    expect(
      chinaDateDayOffset(
        "2026-07-25T01:08:42.000Z",
        "2026-07-25T02:08:42.000Z"
      )
    ).toBe(0);
    expect(formatChinaFullMinute("2026-07-25T15:08:42.000Z")).toBe(
      "2026/07/25 23:08"
    );
  });

  it("未完成或无效的时间值不会造成页面错误", () => {
    expect(isoToChinaLocal("")).toBe("");
    expect(isoToChinaLocal("2026-07-26T21:4")).toBe("");
    expect(formatChina("")).toBe("");
    expect(formatChina("not-a-date")).toBe("");
  });

  it("生成从周一开始的完整月历并支持跨年切换", () => {
    const dates = calendarMonthDates("2026-07-26");
    expect(dates).toHaveLength(42);
    expect(dates[0]).toBe("2026-06-29");
    expect(dates.at(-1)).toBe("2026-08-09");
    expect(calendarMonthLabel("2026-07-26")).toBe("2026年7月");
    expect(shiftCalendarMonth("2026-12-26", 1)).toBe("2027-01-01");
  });
});
