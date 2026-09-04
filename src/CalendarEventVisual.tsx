import { CircleAlert, PowerOff, X } from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

type CalendarEventKind =
  | "GENERAL_RESERVATION"
  | "MACHINE_RESERVATION"
  | "MAINTENANCE"
  | "DISABLE_HISTORY";

export type CalendarEventModel = {
  key: string;
  kind: CalendarEventKind;
  stage: "COMMITTED" | "EDITING_HISTORY" | "DRAFT" | "DRAFT_PREVIEW";
  startAt: string;
  endAt: string;
  label: string;
  mine?: boolean;
  persistent?: boolean;
};

type CalendarDayEventModel = Omit<CalendarEventModel, "kind"> & {
  kind: CalendarEventKind | "ERASE_PREVIEW" | "CONFLICT_PREVIEW";
};

type CalendarRange = { from: string; to: string };

type CalendarDayEventBlockProps = {
  event: CalendarDayEventModel;
  range: CalendarRange;
  periodLabel?: string;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

type CalendarWeekEventProps =
  | {
      event: CalendarEventModel;
      variant: "track";
      range: CalendarRange;
    }
  | {
      event: CalendarEventModel;
      variant: "detail-marker";
    };

function isReservation(kind: CalendarDayEventModel["kind"]) {
  return kind === "GENERAL_RESERVATION" || kind === "MACHINE_RESERVATION";
}

function timelineClassName(event: CalendarDayEventModel) {
  if (event.kind === "ERASE_PREVIEW") return "drag-erase-bar";
  if (event.kind === "CONFLICT_PREVIEW") return "drag-blocked-bar";
  if (isReservation(event.kind)) {
    if (event.stage === "DRAFT" || event.stage === "DRAFT_PREVIEW") {
      return `draft-timeline-bar${
        event.stage === "DRAFT_PREVIEW" ? " preview" : ""
      }${event.kind === "MACHINE_RESERVATION" ? " machine-scope" : ""}`;
    }
    return `${event.mine ? "booking-bar mine" : "booking-bar"}${
      event.kind === "MACHINE_RESERVATION" ? " machine-scope" : ""
    }${event.stage === "EDITING_HISTORY" ? " editing-history" : ""}`;
  }
  return `unavailability-bar${
    event.kind === "DISABLE_HISTORY" ? " disable-history-bar" : ""
  }`;
}

function weekTrackClassName(event: CalendarEventModel) {
  if (event.kind === "MAINTENANCE") return "unavailable";
  if (event.kind === "DISABLE_HISTORY") return "unavailable disabled";
  return `${event.mine ? "mine" : ""}${
    event.kind === "MACHINE_RESERVATION" ? " machine-scope" : ""
  }`.trim();
}

function weekDetailMarkerClassName(event: CalendarEventModel) {
  if (event.kind === "MAINTENANCE") return "unavailable";
  if (event.kind === "DISABLE_HISTORY") return "disabled";
  return `${event.mine ? "mine" : "reservation"}${
    event.kind === "MACHINE_RESERVATION" ? " machine-scope" : ""
  }`;
}

function timelineRangeStyle(
  start: string,
  end: string,
  range: CalendarRange
): CSSProperties | null {
  const from = new Date(range.from).getTime();
  const to = new Date(range.to).getTime();
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    to <= from ||
    endTime <= startTime
  ) {
    return null;
  }
  const left = ((Math.max(from, startTime) - from) / (to - from)) * 100;
  const right = ((Math.min(to, endTime) - from) / (to - from)) * 100;
  return {
    left: `${left}%`,
    width: `${Math.max(0, right - left)}%`
  };
}

export function CalendarDayEventBlock({
  event,
  range,
  periodLabel,
  onClick
}: CalendarDayEventBlockProps) {
  const unavailable = !isReservation(event.kind);
  const leading =
    event.kind === "ERASE_PREVIEW" ? (
      <X size={12} />
    ) : event.kind === "CONFLICT_PREVIEW" ? (
      <CircleAlert size={12} />
    ) : unavailable ? (
      <PowerOff className="unavailability-icon" size={11} />
    ) : (
      <span className="booking-dot" />
    );
  return (
    <TimelineBar
      start={event.startAt}
      end={event.endAt}
      range={range}
      className={`calendar-day-event-block ${timelineClassName(event)}`}
      onClick={onClick}
    >
      {leading}
      <span className="booking-bar-copy">
        <span>{event.label}</span>
        {periodLabel && <small>{periodLabel}</small>}
      </span>
    </TimelineBar>
  );
}

export function CalendarWeekEvent(props: CalendarWeekEventProps) {
  const { event, variant } = props;
  if (variant === "detail-marker") {
    return <span className={weekDetailMarkerClassName(event)} />;
  }
  const style = timelineRangeStyle(event.startAt, event.endAt, props.range);
  return style ? <i className={weekTrackClassName(event)} style={style} /> : null;
}

function TimelineBar({
  start,
  end,
  range,
  className,
  children,
  onClick
}: {
  start: string;
  end: string;
  range: CalendarRange;
  className: string;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const style = timelineRangeStyle(start, end, range);
  if (!style) return null;
  const visual = (
    <span className={`timeline-bar-visual ${className}`}>
      <span className="timeline-bar-content">{children}</span>
    </span>
  );
  if (onClick) {
    return (
      <button
        type="button"
        className={`timeline-bar-anchor ${className}`}
        style={style}
        onClick={onClick}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {visual}
      </button>
    );
  }
  return (
    <div className={`timeline-bar-anchor passive ${className}`} style={style}>
      {visual}
    </div>
  );
}
