import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { addDays, calendarMonthDates, calendarMonthLabel, calendarWeekdayLabels, chinaLocalToIso, formatChina, shiftCalendarMonth } from "./date";
import { tr } from "./i18n";

export function CalendarDateButton({
  date,
  today,
  label,
  onSelect,
  allowUnbounded = false,
  ariaLabel
}: {
  date: string;
  today: string;
  label: string;
  onSelect: (date: string) => void;
  allowUnbounded?: boolean;
  ariaLabel?: string;
}) {
  const selectedDate = date || today;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => shiftCalendarMonth(selectedDate, 0));
  const [focusedDate, setFocusedDate] = useState(selectedDate);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dateButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const dates = calendarMonthDates(month);

  useLayoutEffect(() => {
    if (open) dateButtonRefs.current.get(focusedDate)?.focus();
  }, [open, focusedDate, month]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectedDate, open]);

  const selectDate = (nextDate: string) => {
    onSelect(nextDate);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const focusDate = (nextDate: string) => {
    setFocusedDate(nextDate);
    setMonth(nextDate.slice(0, 7) + "-01");
  };

  return (
    <div className="calendar-date-control" ref={rootRef}>
      <button
        type="button"
        className="date-button"
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (!open) { setMonth(shiftCalendarMonth(selectedDate, 0)); setFocusedDate(selectedDate); }
          setOpen(current => !current);
        }}
      >
        <CalendarDays size={16} />
        {label}
      </button>
      {open && (
        <div
          className="calendar-date-popover"
          role="dialog"
          aria-label={tr("选择日期")}
        >
          <div className="calendar-date-popover-head">
            <button
              type="button"
              aria-label={tr("上个月")}
              onClick={() =>
                setMonth((current) => shiftCalendarMonth(current, -1))
              }
            >
              <ChevronLeft size={16} />
            </button>
            <strong>{calendarMonthLabel(month)}</strong>
            <button
              type="button"
              aria-label={tr("下个月")}
              onClick={() =>
                setMonth((current) => shiftCalendarMonth(current, 1))
              }
            >
              <ChevronRight size={16} />
            </button>
          </div>
          <div className="calendar-date-weekdays" aria-hidden="true">
            {calendarWeekdayLabels().map((weekday) => (
              <span key={weekday}>{weekday}</span>
            ))}
          </div>
          <div className="calendar-date-grid">
            {dates.map((item) => {
              const outside = item.slice(0, 7) !== month.slice(0, 7);
              return (
                <button
                  type="button"
                  key={item}
                  data-date={item}
                  ref={(element) => {
                    if (element) dateButtonRefs.current.set(item, element);
                    else dateButtonRefs.current.delete(item);
                  }}
                  className={[
                    outside ? "outside" : "",
                    item === today ? "today" : "",
                    item === date ? "selected" : ""
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-current={item === today ? "date" : undefined}
                  aria-pressed={item === date}
                  aria-label={formatChina(
                    chinaLocalToIso(`${item}T00:00`),
                    {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                      weekday: "long"
                    }
                  )}
                  tabIndex={item === focusedDate ? 0 : -1}
                  onFocus={() => setFocusedDate(item)}
                  onKeyDown={(event) => {
                    const offsets: Partial<Record<string, number>> = {
                      ArrowLeft: -1,
                      ArrowRight: 1,
                      ArrowUp: -7,
                      ArrowDown: 7
                    };
                    const offset = offsets[event.key];
                    if (offset) {
                      event.preventDefault();
                      focusDate(addDays(item, offset));
                    } else if (event.key === "PageUp") {
                      event.preventDefault();
                      focusDate(shiftCalendarMonth(item, -1));
                    } else if (event.key === "PageDown") {
                      event.preventDefault();
                      focusDate(shiftCalendarMonth(item, 1));
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      selectDate(item);
                    }
                  }}
                  onClick={() => selectDate(item)}
                >
                  {Number(item.slice(-2))}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="calendar-date-today"
            onClick={() => selectDate(today)}
          >
            {tr("今天")}</button>
          {allowUnbounded && <button type="button" className="calendar-date-today" onClick={() => selectDate("")}>{tr("不限")}</button>}
        </div>
      )}
    </div>
  );
}
