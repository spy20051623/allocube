import { useEffect, useRef, useState } from "react";
import { CalendarSearch } from "lucide-react";
import { tr as t, translateServerMessage } from "./i18n";
import { Modal } from "./Modal";
import { SelectControl } from "./SelectControl";
import { useAllReservations, useReservationPage, useReservationRefresh } from "./useMyReservations";
import { ReservationIdentity, ReservationPeriod, ReservationStatus } from "./ReservationPresentation";
import { useServerClock } from "./ServerClock";
import type { OwnReservation, OwnReservationPage, ReservationCategory } from "./shared/my-reservations";
import "./my-reservations.css";

export function CalendarMyReservations({ onClose, onLocate }: {
  onClose: () => void; onLocate: (item: OwnReservation) => void;
}) {
  const [machineId, setMachineId] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [options, setOptions] = useState<Pick<OwnReservationPage, "machineOptions" | "resourceGroupOptions">>({ machineOptions: [], resourceGroupOptions: [] });
  const [boundary, setBoundary] = useState<string | null>(null);
  const { epoch } = useReservationRefresh(boundary);
  const group = options.resourceGroupOptions.find(item => item.id === resourceId && item.machineId === machineId);
  const query = (category: ReservationCategory) => {
    const params = new URLSearchParams({ category, limit: category === "HISTORY" ? "50" : "100" });
    if (machineId) params.set("machineId", machineId);
    if (group?.scope === "MACHINE") { params.set("scope", "MACHINE"); params.set("machineId", group.machineId); }
    else if (machineId && resourceId) params.set("resourceGroupId", resourceId);
    return params.toString();
  };
  const active = useAllReservations(query("ACTIVE"), epoch);
  const upcoming = useAllReservations(query("UPCOMING"), epoch);
  const historyQuery = query("HISTORY");
  const history = useReservationPage(historyQuery, epoch);
  const resultsRef = useRef<HTMLDivElement>(null);
  const pendingHistoryScroll = useRef<{ query: string; data: OwnReservationPage | null } | null>(null);
  const turnHistoryPage = (turn: () => void) => {
    pendingHistoryScroll.current = { query: historyQuery, data: history.data };
    turn();
  };
  useEffect(() => {
    const pending = pendingHistoryScroll.current;
    if (!pending) return;
    if (pending.query !== historyQuery) { pendingHistoryScroll.current = null; return; }
    if (history.loading || history.error || !history.data || history.data === pending.data) return;
    const results = resultsRef.current;
    const heading = results?.querySelector('[data-reservation-category="HISTORY"] .calendar-own-section-heading');
    if (results && heading) {
      results.scrollTo({ top: results.scrollTop + heading.getBoundingClientRect().top - results.getBoundingClientRect().top, behavior: "instant" });
    }
    pendingHistoryScroll.current = null;
  }, [historyQuery, history.data, history.loading, history.error]);
  const { currentTime } = useServerClock();
  useEffect(() => {
    const pages = [active.data, upcoming.data, history.data].filter(item => item !== null);
    const latest = pages.sort((a, b) => b.revision - a.revision || b.serverNow.localeCompare(a.serverNow))[0];
    if (latest) setOptions({ machineOptions: latest.machineOptions, resourceGroupOptions: latest.resourceGroupOptions });
    setBoundary(pages.map(item => item.nextBoundary).filter((item): item is string => !!item).sort()[0] ?? null);
  }, [active.data, upcoming.data, history.data]);
  const sections = [
    { key: "ACTIVE", title: t("进行中"), page: active },
    { key: "UPCOMING", title: t("未开始"), page: upcoming },
    { key: "HISTORY", title: t("已结束"), page: history }
  ];
  return <Modal title={t("我的占用")} onClose={onClose} wide className="own-dialog calendar-own-dialog">
    <div className="own-filters calendar-own-filters">
      <label><span>{t("机器")}</span><SelectControl value={machineId} ariaLabel={t("筛选机器")}
        onChange={value => { setMachineId(value); setResourceId(""); }}
        options={[{ value: "", label: t("全部机器") }, ...options.machineOptions.map(machine => ({ value: machine.id, label: translateServerMessage(machine.name) }))]} /></label>
      <label><span>{t("资源组")}</span><SelectControl value={resourceId} ariaLabel={t("筛选资源组")}
        onChange={setResourceId}
        options={[{ value: "", label: t("全部资源组") }, ...options.resourceGroupOptions.filter(item => machineId && item.machineId === machineId).map(item => ({
          value: item.id, label: translateServerMessage(item.name)
        }))]} /></label>
      <button className="secondary-button" onClick={() => { setMachineId(""); setResourceId(""); }}>{t("清除筛选")}</button>
    </div>
    <div ref={resultsRef} className="calendar-own-results">{sections.map(({ key, title, page }) => <section key={key} data-reservation-category={key}>
      <h3 className="calendar-own-section-heading">{title}{page.data && <span>{page.data.total}</span>}</h3>
      {page.error && <p className="own-alert" role="alert">{page.error.message}<button onClick={page.retry}>{t("重新加载")}</button></p>}
      {page.loading && <p role="status">{t("正在载入")}</p>}
      {page.data?.reservations.map(item => <article key={item.id} className="calendar-own-record">
        <ReservationIdentity item={item} />
        <ReservationPeriod item={item} />
        <ReservationStatus item={item} now={currentTime} />
        {item.status === "CONFIRMED" && item.canViewCalendar && <button type="button" className="icon-button tiny" title={t("定位到日历")} aria-label={t("定位到日历")} onClick={() => onLocate(item)}><CalendarSearch size={16} aria-hidden="true" /></button>}
      </article>)}
      {page.data?.total === 0 && <p className="own-empty">{t("没有符合条件的占用记录")}</p>}
      {key === "HISTORY" && history.data && history.data.total > 50 && <footer className="own-pagination">
        <div>
          <button className="secondary-button" disabled={history.loading || history.page <= 1} onClick={() => turnHistoryPage(history.previous)}>{t("上一页")}</button>
          <span>{t("第 {{page}} 页 / 共 {{pages}} 页", { page: history.page, pages: Math.ceil(history.data.total / 50) })}</span>
          <button className="secondary-button" disabled={history.loading || !history.data.nextCursor} onClick={() => turnHistoryPage(history.next)}>{t("下一页")}</button>
        </div>
      </footer>}
    </section>)}</div>
  </Modal>;
}
