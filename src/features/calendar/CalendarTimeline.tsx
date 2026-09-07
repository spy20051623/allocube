import { tr } from "../../i18n/index";
import { type CalendarEventModel, CalendarWeekEvent } from "../../CalendarEventVisual";
import { useId, useRef, useState, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { minuteDifference, formatChina, isoToChinaLocal, addDays, chinaLocalToIso } from "../../date";
import { mergeTimeRanges, type CalendarView, clampDayWindowStartMinutes } from "../../calendar-state";
import type { TimelineReservation, UnavailabilityWindow } from "../../shared/types";
import { reservationCalendarEvent } from "./reservation-events";

export function CalendarWeekDayCell({
  day,
  today,
  dayStart,
  dayEnd,
  groupName,
  reservations,
  unavailable,
  onSelect
}: {
  day: string;
  today: string;
  dayStart: string;
  dayEnd: string;
  groupName: string;
  reservations: TimelineReservation[];
  unavailable: UnavailabilityWindow[];
  onSelect: () => void;
}) {
  const tooltipId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState({
    left: 0,
    top: 0,
    placement: "below" as "above" | "below"
  });
  const from = new Date(dayStart).getTime();
  const to = new Date(dayEnd).getTime();
  const occupiedRanges = mergeTimeRanges(
    reservations.map((item) => ({
      startAt:
        new Date(item.startAt).getTime() < from ? dayStart : item.startAt,
      endAt: new Date(item.endAt).getTime() > to ? dayEnd : item.endAt
    }))
  );
  const occupiedMinutes = occupiedRanges.reduce(
    (sum, item) => sum + minuteDifference(item.startAt, item.endAt),
    0
  );
  const machineReservationCount = reservations.filter(
    (item) => item.scope === "MACHINE"
  ).length;
  const summary = occupiedMinutes
    ? tr("{{v0}}小时 · {{v1}}段", { v0: (occupiedMinutes / 60).toFixed(1), v1: reservations.length })
    : unavailable.length
      ? tr("不可用")
      : tr("空闲");
  const reservationEvents = reservations.map(reservationCalendarEvent);
  const unavailableEvents: CalendarEventModel[] = unavailable.map(
    (item) => ({
      key: `unavailable-${item.id}`,
      kind: item.kind === "LONG_TERM" ? "DISABLE_HISTORY" : "MAINTENANCE",
      stage: "COMMITTED",
      startAt: item.startAt,
      endAt: item.endAt,
      persistent: item.kind === "LONG_TERM" && item.endAt >= dayEnd,
      label:
        item.reason || (item.kind === "LONG_TERM" ? tr("停用") : tr("维护"))
    })
  );
  const trackEvents = [...unavailableEvents, ...reservationEvents];
  const details = [...reservationEvents, ...unavailableEvents].sort((left, right) =>
    left.startAt.localeCompare(right.startAt)
  );

  const updatePopoverPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const containerRect =
      button.closest(".timeline-scroll-shell")?.getBoundingClientRect() ??
      new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const width = 280;
    const estimatedHeight = Math.min(280, 48 + details.length * 29);
    const placement =
      rect.bottom + estimatedHeight + 10 > window.innerHeight &&
        rect.top > estimatedHeight + 10
        ? "above"
        : "below";
    setPopoverPosition({
      left: Math.min(
        containerRect.right - width - 8,
        Math.max(containerRect.left + 8, rect.left + rect.width / 2 - width / 2)
      ),
      top:
        placement === "above"
          ? Math.max(10, rect.top - estimatedHeight - 8)
          : Math.min(
            window.innerHeight - estimatedHeight - 10,
            rect.bottom + 8
          ),
      placement
    });
  }, [details.length]);

  useLayoutEffect(() => {
    if (!popoverOpen) return;
    updatePopoverPosition();
    window.addEventListener("resize", updatePopoverPosition);
    window.addEventListener("scroll", updatePopoverPosition, true);
    return () => {
      window.removeEventListener("resize", updatePopoverPosition);
      window.removeEventListener("scroll", updatePopoverPosition, true);
    };
  }, [popoverOpen, updatePopoverPosition]);

  return (
    <>
      <div
        className="week-day-cell"
        onMouseEnter={() => details.length && setPopoverOpen(true)}
        onMouseLeave={() => setPopoverOpen(false)}
      >
        <button
          ref={buttonRef}
          type="button"
          className={`${day === today ? "today" : ""}${occupiedMinutes ? " occupied" : ""
            }${unavailable.length ? " unavailable" : ""}`}
          aria-label={tr("{{v0}} {{v1}}，{{v2}}{{v3}}，点击查看日视图", {
            v0: day, v1: groupName, v2: summary, v3: machineReservationCount
              ? tr("，其中{{v0}}段整机占用", { v0: machineReservationCount })
              : ""
          })}
          aria-describedby={
            popoverOpen && details.length ? tooltipId : undefined
          }
          onFocus={() => details.length && setPopoverOpen(true)}
          onBlur={() => setPopoverOpen(false)}
          onClick={onSelect}
        >
          <span className="week-day-summary">{summary}</span>
          <span className="week-mini-track" aria-hidden="true">
            {trackEvents.map((event) => (
              <CalendarWeekEvent
                key={event.key}
                event={event}
                variant="track"
                range={{ from: dayStart, to: dayEnd }}
              />
            ))}
          </span>
        </button>
      </div>
      {popoverOpen &&
        !!details.length &&
        createPortal(
          <div
            id={tooltipId}
            className={`week-day-popover ${popoverPosition.placement}`}
            role="tooltip"
            style={{
              left: popoverPosition.left,
              top: popoverPosition.top
            }}
          >
            <strong>{day} · {groupName}</strong>
            {details.map((item) => (
              <div key={item.key}>
                <CalendarWeekEvent
                  event={item}
                  variant="detail-marker"
                />
                <time>
                  {formatWeekDayDetailPeriod({
                    startAt: item.startAt,
                    endAt: item.endAt,
                    dayStart,
                    dayEnd,
                    persistent: Boolean(item.persistent)
                  })}
                </time>
                <em>{item.label}</em>
              </div>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}

function formatWeekDayDetailPeriod({
  startAt,
  endAt,
  dayStart,
  dayEnd,
  persistent
}: {
  startAt: string;
  endAt: string;
  dayStart: string;
  dayEnd: string;
  persistent: boolean;
}) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const from = new Date(dayStart).getTime();
  const to = new Date(dayEnd).getTime();
  const time = (value: number) =>
    formatChina(new Date(value).toISOString(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

  if (persistent) {
    return start <= from ? tr("全天停用") : `${time(Math.max(start, from))}–24:00`;
  }

  const startLabel = start <= from ? "00:00" : time(Math.max(start, from));
  const endLabel = end >= to ? "24:00" : time(Math.min(end, to));
  return `${startLabel}–${endLabel}`;
}

export function TimelineScale({
  range,
  view,
  visibleHours,
  windowStartMinutes,
  currentTime,
  onSelectDay
}: {
  range: { from: string; to: string; startDate: string; days: number };
  view: CalendarView;
  visibleHours: number;
  windowStartMinutes: number;
  currentTime: number;
  onSelectDay?: (date: string) => void;
}) {
  const today = isoToChinaLocal(new Date(currentTime).toISOString()).slice(
    0,
    10
  );
  const marks =
    view === "day"
      ? (() => {
        const start = clampDayWindowStartMinutes(
          windowStartMinutes,
          visibleHours
        );
        const end = start + visibleHours * 60;
        const step =
          visibleHours === 6 ? 30 : visibleHours === 12 ? 60 : 120;
        const minutes = [start];
        for (
          let minute = Math.ceil(start / step) * step;
          minute < end;
          minute += step
        ) {
          if (minute - start >= 30 && end - minute >= 30) {
            minutes.push(minute);
          }
        }
        minutes.push(end);
        return Array.from(new Set(minutes)).map((minute, index) => ({
          key: `${minute}-${index}`,
          label: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(
            minute % 60
          ).padStart(2, "0")}`,
          left: (minute / (24 * 60)) * 100,
          date: null
        }));
      })()
      : Array.from({ length: 7 }, (_, index) => {
        const date = addDays(range.startDate, index);
        return {
          key: index,
          label: formatChina(chinaLocalToIso(`${date}T00:00`), { month: "numeric", day: "numeric", weekday: "short" }),
          left: ((index + 0.5) / 7) * 100,
          date
        };
      });
  return (
    <div className={`scale-head ${view}`}>
      {marks.map((mark) =>
        mark.date ? (
          <button
            type="button"
            key={mark.key}
            className={mark.date === today ? "today" : ""}
            style={{ left: `${mark.left}%` }}
            onClick={() => onSelectDay?.(mark.date!)}
            aria-label={tr("查看 {{v0}} 的日视图", { v0: mark.label })}
          >
            {mark.label}
          </button>
        ) : (
          <span key={mark.key} style={{ left: `${mark.left}%` }}>
            {mark.label}
          </span>
        )
      )}
      {view === "day" && (
        <CurrentTimeLine
          range={range}
          currentTime={currentTime}
          showLabel
        />
      )}
    </div>
  );
}

export function CurrentTimeLine({
  range,
  currentTime,
  showLabel = false
}: {
  range: { from: string; to: string };
  currentTime: number;
  showLabel?: boolean;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (currentTime < from || currentTime >= to || to <= from) return null;
  const left = ((currentTime - from) / (to - from)) * 100;
  return (
    <div
      className={`current-time-line${showLabel ? " with-label" : ""}`}
      style={{ left: `${left}%` }}
      aria-hidden={!showLabel}
    >
      {showLabel && (
        <span>
          {formatChina(new Date(currentTime).toISOString(), {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false
          })}
        </span>
      )}
    </div>
  );
}

export function PastTimeShade({
  range,
  currentTime
}: {
  range: { from: string; to: string };
  currentTime: number;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  if (currentTime <= from) return null;
  const width =
    currentTime >= to ? 100 : ((currentTime - from) / (to - from)) * 100;
  return (
    <div
      className="past-time-shade"
      style={{ width: `${Math.max(0, Math.min(100, width))}%` }}
      aria-hidden="true"
    />
  );
}

export function TimelineHoverGuide({
  range,
  at,
  label
}: {
  range: { from: string; to: string };
  at: string;
  label: string;
}) {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const time = new Date(at).getTime();
  if (!Number.isFinite(time) || time < from || time > to || to <= from) {
    return null;
  }
  const left = ((time - from) / (to - from)) * 100;
  return (
    <div
      className="timeline-hover-guide"
      style={{ left: `${left}%` }}
      aria-hidden="true"
    >
      <span>{label}</span>
    </div>
  );
}

export function TrackGrid({
  view,
  visibleHours
}: {
  view: "day" | "week";
  visibleHours: number;
}) {
  const intervalMinutes =
    visibleHours === 6 ? 30 : visibleHours === 12 ? 60 : 120;
  const count = view === "day" ? (24 * 60) / intervalMinutes : 7;
  return <>{Array.from({ length: count + 1 }, (_, index) => <i key={index} style={{ left: `${(index / count) * 100}%` }} />)}</>;
}

export function formatTimelineDayPeriod(
  startAt: string,
  endAt: string,
  range: { from: string; to: string }
) {
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const time = (value: number) =>
    formatChina(new Date(value).toISOString(), {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  const startLabel = start <= from ? "00:00" : time(start);
  const endLabel = end >= to ? "24:00" : time(end);
  return `${startLabel}–${endLabel}`;
}
