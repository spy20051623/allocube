import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CalendarDayEventBlock, CalendarWeekEvent, type CalendarEventModel } from "../src/CalendarEventVisual";
import { timelineNearbyHitIndexes } from "../src/calendar-state";

const range = { from: "2026-09-08T00:00:00+08:00", to: "2026-09-09T00:00:00+08:00" };
function event(startAt: string, endAt: string): CalendarEventModel {
  return { key: "reservation", kind: "GENERAL_RESERVATION", stage: "COMMITTED", label: "Reservation", startAt, endAt };
}
const outside = [
  event("2026-09-07T12:00:00+08:00", range.from),
  event("2026-09-07T12:00:00+08:00", "2026-09-07T16:00:00Z"),
  event(range.to, "2026-09-09T12:00:00+08:00"),
  event("2026-09-06T00:00:00+08:00", "2026-09-07T00:00:00+08:00"),
  event("2026-09-10T00:00:00+08:00", "2026-09-11T00:00:00+08:00"),
  event(range.from, range.from),
  event(range.to, range.from),
  event("invalid", range.to)
];

describe("日历事件只呈现与视窗有正时长交集的部分", () => {
  it.each(outside)("不渲染范围外或无效事件 $startAt – $endAt", item => {
    expect(renderToStaticMarkup(<CalendarDayEventBlock event={item} range={range} onClick={() => {}} />)).toBe("");
    expect(renderToStaticMarkup(<CalendarWeekEvent event={item} variant="track" range={range} />)).toBe("");
    expect(timelineNearbyHitIndexes({ items: [item], rangeStart: range.from, rangeEnd: range.to, trackWidth: 1440, pointerX: 0 }))
      .toEqual({ directIndex: null, nearbyIndexes: [] });
  });

  it.each(["GENERAL_RESERVATION", "MACHINE_RESERVATION", "MAINTENANCE", "DISABLE_HISTORY"] as const)(
    "%s 跨过午夜时保留完整交集，边界结束时不产生空色块", kind => {
      const item = { ...event("2026-09-07T12:00:00+08:00", "2026-09-09T12:00:00+08:00"), kind };
      expect(renderToStaticMarkup(<CalendarDayEventBlock event={item} range={range} />)).toContain('left:0%;width:100%');
      expect(renderToStaticMarkup(<CalendarDayEventBlock event={{ ...item, endAt: range.from }} range={range} />)).toBe("");
    }
  );

  it("保留零点开始的一分钟有效占用及其点击目标", () => {
    const item = event(range.from, "2026-09-08T00:01:00+08:00");
    expect(renderToStaticMarkup(<CalendarDayEventBlock event={item} range={range} onClick={() => {}} />)).toContain("<button");
    expect(timelineNearbyHitIndexes({ items: [outside[0], item], rangeStart: range.from, rangeEnd: range.to, trackWidth: 1440, pointerX: 0 }))
      .toEqual({ directIndex: 1, nearbyIndexes: [1] });
  });
});
