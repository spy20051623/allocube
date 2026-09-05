import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { initializeI18n, changeLocale } from "../src/i18n";
import { setBeijingTimeMode } from "../src/date";
import {
  emptyReservationFilters, reservationPhase, reservationQuery, ReservationRequestGate,
  selectReservationPage, selectionIsCurrent
} from "../src/my-reservations-state";
import { ReservationIdentity, ReservationPeriod, ReservationStatus } from "../src/ReservationPresentation";
import type { OwnReservation, OwnReservationPage } from "../src/shared/my-reservations";
import { loadAllReservationPages } from "../src/useMyReservations";
import { ApiError } from "../src/api";

const now = Date.parse("2026-09-05T10:00:00.000Z");
function row(id = "one"): OwnReservation {
  return {
    id, scope: "RESOURCE_GROUP", machineId: "machine", machineName: "Atlas", resourceGroupId: "group", resourceGroupName: "CPU 0–31",
    currentResourceSummary: "CPU 0–31", snapshotGroupName: "CPU 0–31", snapshotResourceSummary: "CPU 0–31", changedSinceBooking: false,
    machineDeleted: false, resourceGroupDeleted: false, startAt: "2026-09-05T11:00:00.000Z", endAt: "2026-09-05T12:00:00.000Z",
    initialStartAt: "2026-09-05T11:00:00.000Z", initialEndAt: "2026-09-05T12:00:00.000Z",
    adjustmentType: null, adjustmentReason: "", cancellationReason: "", title: "", purpose: "", note: "", status: "CONFIRMED", stateToken: "original",
    canEdit: true, canViewCalendar: true
  };
}
beforeAll(async () => { await initializeI18n(); });
afterEach(async () => { setBeijingTimeMode(false); await changeLocale("zh-CN"); });

describe("个人占用页面状态", () => {
  const pageFor = (items: OwnReservation[], nextCursor: string | null): OwnReservationPage => ({
    reservations: items, nextCursor, total: 205, counts: { ACTIVE: 205, UPCOMING: 0, HISTORY: 0 },
    machineOptions: [], resourceGroupOptions: [], serverNow: new Date(now).toISOString(), nextBoundary: null, revision: 1
  });
  it("滚动概览合并全部服务端分页，超过 200 条也不截断", async () => {
    const items = Array.from({ length: 205 }, (_, i) => row(String(i)));
    const cursors: Array<string | null> = [];
    const page = await loadAllReservationPages(async (cursor) => {
      cursors.push(cursor);
      const offset = Number(cursor ?? 0);
      return pageFor(items.slice(offset, offset + 100), offset + 100 < items.length ? String(offset + 100) : null);
    }, new AbortController().signal);
    expect(cursors).toEqual([null, "100", "200"]);
    expect(page.reservations.map(r => r.id)).toEqual(items.map(r => r.id));
  });
  it("概览加载途中游标失效时重读，不混合两个版本的记录", async () => {
    let calls = 0;
    const page = await loadAllReservationPages(async () => {
      calls++;
      if (calls === 1) return pageFor([row("old")], "next");
      if (calls === 2) throw new ApiError("Changed", 409, undefined, "STALE_CURSOR");
      return pageFor([row("new")], null);
    }, new AbortController().signal);
    expect(page.reservations.map(r => r.id)).toEqual(["new"]);
    expect(calls).toBe(3);
  });
  it("取消加载时不再请求后续页，后续页失败不返回不完整的概览", async () => {
    const controller = new AbortController();
    await expect(loadAllReservationPages(async () => {
      controller.abort();
      return pageFor([row()], "next");
    }, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    await expect(loadAllReservationPages(async (cursor) => {
      if (cursor) throw new Error("Offline");
      return pageFor([row()], "next");
    }, new AbortController().signal)).rejects.toThrow("Offline");
  });
  it("按时间自动跨越开始和结束边界，不依赖翻译文字分类", () => {
    const item=row();
    expect(reservationPhase(item,now)).toBe("UPCOMING");
    expect(reservationPhase(item,Date.parse(item.startAt))).toBe("ACTIVE");
    expect(reservationPhase(item,Date.parse(item.endAt))).toBe("ENDED");
    expect(reservationPhase({...item,status:"CANCELLED_UNAVAILABILITY"},now)).toBe("CANCELLED");
  });
  it("筛选使用北京时间的完整日期区间，概览独立于列表筛选", () => {
    setBeijingTimeMode(true);
    const filters={...emptyReservationFilters,from:"2026-09-05",to:"2026-09-05",machineId:"m"};
    const params=new URLSearchParams(reservationQuery("UPCOMING",filters)!);
    expect(params.get("from")).toBe("2026-09-04T16:00:00.000Z");
    expect(params.get("to")).toBe("2026-09-05T16:00:00.000Z");
    expect(reservationQuery("ACTIVE",filters)).toBe("category=ACTIVE&limit=6");
    expect(reservationQuery("HISTORY",{...filters,to:"2026-09-04"})).toBeNull();
  });
  it("本地时区日期范围使用本地午夜，结束日期包含当天", () => {
    setBeijingTimeMode(false);
    const params=new URLSearchParams(reservationQuery("HISTORY",{...emptyReservationFilters,from:"2026-09-05",to:"2026-09-06"})!);
    expect(params.get("from")).toBe(new Date(2026,8,5).toISOString());
    expect(params.get("to")).toBe(new Date(2026,8,7).toISOString());
  });
  it("当前页全选可跨页保留，但不能悄悄更新已选择记录的确认快照", () => {
    const first=row("first"),second=row("second");
    let selected=selectReservationPage(new Map(),[first],true,now);
    selected=selectReservationPage(selected,[{...first,stateToken:"new"},second],true,now);
    expect(selected.size).toBe(2); expect(selected.get(first.id)).toBe(first);
    selected=selectReservationPage(selected,[second],false,now);
    expect([...selected.keys()]).toEqual([first.id]);
    expect(selectionIsCurrent([...selected.values()],[{...first,stateToken:"new"}],now)).toBe(false);
    expect(selectionIsCurrent([...selected.values()],[],now)).toBe(false);
    expect(selectionIsCurrent([...selected.values()],[first],Date.parse(first.startAt))).toBe(false);
  });
  it("只选未来有效记录并限制总数为 100", () => {
    const selected=selectReservationPage(new Map(),[...Array.from({length:101},(_,i)=>row(String(i))),{...row("cancelled"),status:"CANCELLED"}],true,now);
    expect(selected.size).toBe(100); expect(selected.has("cancelled")).toBe(false);
  });
  it("晚返回的请求和取消后的请求无法覆盖当前结果", () => {
    const gate=new ReservationRequestGate(); const old=gate.start(); const fresh=gate.start();
    expect(old.signal.aborted).toBe(true); expect(old.current()).toBe(false); expect(fresh.current()).toBe(true);
    gate.cancel(); expect(fresh.current()).toBe(false);
  });
  it.each(["zh-CN","en"] as const)("%s 下所有说明为空时仍能识别机器、范围、时间和状态",async(locale)=>{
    await changeLocale(locale); setBeijingTimeMode(true);
    const item=row(); const html=renderToStaticMarkup(<><ReservationIdentity item={item}/><ReservationPeriod item={item}/><ReservationStatus item={item} now={now}/></>);
    expect(html).toContain("Atlas"); expect(html).toContain("CPU 0–31"); expect(html).toContain("2026");
    expect(html).not.toMatch(/未填写|Untitled|No title/); expect(html).toContain(locale==="en" ? "Not started" : "未开始");
  });
});
