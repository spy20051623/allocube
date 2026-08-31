import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addDays,
  calendarMonthDates,
  calendarMonthLabel,
  calendarWeekdayLabels,
  chinaDateDayOffset,
  chinaLocalToIso,
  clientUsesUtcPlus8,
  compactDurationText,
  compactHoursText,
  durationHoursText,
  durationText,
  formatBeijing,
  formatChina,
  formatChinaDate,
  formatChinaFullMinute,
  isoToChinaLocal,
  isBeijingTimeMode,
  isUtcPlus8Offset,
  setBeijingTimeMode,
  shiftCalendarMonth
} from "../src/date.js";
import i18n, { initializeI18n } from "../src/i18n/index.js";

describe("北京时间显示", () => {
  beforeEach(() => setBeijingTimeMode(true));
  afterEach(() => setBeijingTimeMode(false));

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
    expect(calendarWeekdayLabels()).toEqual(["一", "二", "三", "四", "五", "六", "日"]);
    expect(shiftCalendarMonth("2026-12-26", 1)).toBe("2027-01-01");
  });

  it("英文显示使用英文日期和正确的单复数，同时保持上海时区", async () => {
    await initializeI18n();
    await i18n.changeLanguage("en");
    try {
      expect(durationText(1)).toBe("1 minute");
      expect(durationText(61)).toBe("1 hour 1 minute");
      expect(compactDurationText(2)).toBe("2m");
      expect(compactDurationText(60)).toBe("1h");
      expect(compactDurationText(90)).toBe("1h 30m");
      expect(compactHoursText(396)).toBe("6.6h");
      expect(durationHoursText(120)).toBe("2.0 hours");
      expect(calendarMonthLabel("2026-07-26")).toBe("July 2026");
      expect(calendarWeekdayLabels()).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
      expect(formatChinaFullMinute("2026-07-25T15:08:42.000Z")).toContain("23:08");
    } finally {
      await i18n.changeLanguage("zh-CN");
    }
  });

  it("默认模式使用客户端系统时区，并可切换为北京时间", () => {
    setBeijingTimeMode(false);
    const localDate = new Date(2026, 6, 25, 23, 8, 0, 0);
    const instant = localDate.toISOString();
    expect(isBeijingTimeMode()).toBe(false);
    expect(isoToChinaLocal(instant)).toBe("2026-07-25T23:08");
    expect(chinaLocalToIso("2026-07-25T23:08")).toBe(instant);
    expect(clientUsesUtcPlus8(instant)).toBe(
      localDate.getTimezoneOffset() === -480
    );
    expect(isUtcPlus8Offset(-480)).toBe(true);
    expect(isUtcPlus8Offset(0)).toBe(false);
    expect(isUtcPlus8Offset(300)).toBe(false);

    setBeijingTimeMode(true);
    expect(isBeijingTimeMode()).toBe(true);
    expect(formatBeijing("2026-07-25T15:08:42.000Z", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })).toContain("23:08");
  });

  it("日期加减使用日历日而不是固定 24 小时", () => {
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });
});
