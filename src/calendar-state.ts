import { tr } from "./i18n/index";
import { isBeijingTimeMode } from "./date";
import { intersectCalendarInterval } from "./calendar-interval";
import type {
  ReservationPreviewItem,
  ReservationSegmentInput
} from "./shared/types";

export type CalendarView = "day" | "week";

export type CalendarQueryState = {
  date: string;
  view: CalendarView;
  machineId: string;
};

export type CalendarDraft = ReservationSegmentInput & {
  id: string;
  startMode?: "IMMEDIATE" | "SCHEDULED";
};

export type CalendarMetadata = {
  title: string;
  purpose: string;
  note: string;
};

export type CalendarTimeRange = {
  startAt: string;
  endAt: string;
};

export type TimelineNearbyHitResult = {
  directIndex: number | null;
  nearbyIndexes: number[];
};

export type CalendarBookingRules = {
  advanceDays: number;
};

export type CalendarDraftFieldIssues = {
  startAt?: string;
  endAt?: string;
};

export const DAY_ZOOM_LEVELS = [6, 12, 24] as const;
export const DEFAULT_DAY_VISIBLE_HOURS = 24;

export function timelineNearbyHitIndexes({
  items,
  rangeStart,
  rangeEnd,
  trackWidth,
  pointerX,
  smallItemWidth = 5,
  nearbyDistance = 12
}: {
  items: CalendarTimeRange[];
  rangeStart: string;
  rangeEnd: string;
  trackWidth: number;
  pointerX: number;
  smallItemWidth?: number;
  nearbyDistance?: number;
}): TimelineNearbyHitResult {
  const from = new Date(rangeStart).getTime();
  const to = new Date(rangeEnd).getTime();
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    !Number.isFinite(trackWidth) ||
    trackWidth <= 0 ||
    !Number.isFinite(pointerX) ||
    pointerX < 0 ||
    pointerX > trackWidth ||
    !Number.isFinite(smallItemWidth) ||
    smallItemWidth <= 0 ||
    !Number.isFinite(nearbyDistance) ||
    nearbyDistance < 0
  ) {
    return { directIndex: null, nearbyIndexes: [] };
  }

  const projected = items.flatMap((item, index) => {
    const visible = intersectCalendarInterval(item, { from: rangeStart, to: rangeEnd });
    if (!visible) return [];
    const { start, end } = visible;
    const left = ((start - from) / (to - from)) * trackWidth;
    const right = ((end - from) / (to - from)) * trackWidth;
    return [{ index, left, right, width: right - left }];
  });
  const nearbyIndexes = projected
    .filter((item) => {
      const exact = pointerX >= item.left && pointerX <= item.right;
      if (exact) return true;
      const distance =
        pointerX < item.left
          ? item.left - pointerX
          : pointerX - item.right;
      return item.width < smallItemWidth && distance <= nearbyDistance;
    })
    .map((item) => item.index);
  const directIndex =
    nearbyIndexes.length === 1 ? nearbyIndexes[0] : null;
  return { directIndex, nearbyIndexes };
}

export function calendarDragAction(input: {
  button: number;
  ctrlKey: boolean;
}): "ADD" | "ERASE" | null {
  if (input.button === 2 || (input.button === 0 && input.ctrlKey)) {
    return "ERASE";
  }
  return input.button === 0 ? "ADD" : null;
}

export function timelineDragAutoScrollDelta({
  pointer,
  viewportStart,
  viewportEnd,
  edgeSize = 72,
  maxStep = 12
}: {
  pointer: number;
  viewportStart: number;
  viewportEnd: number;
  edgeSize?: number;
  maxStep?: number;
}) {
  if (
    !Number.isFinite(pointer) ||
    !Number.isFinite(viewportStart) ||
    !Number.isFinite(viewportEnd) ||
    viewportEnd <= viewportStart ||
    edgeSize <= 0 ||
    maxStep <= 0
  ) {
    return 0;
  }
  const normalizedStep = (distance: number) => {
    const strength = Math.max(0, Math.min(1, distance / edgeSize));
    return strength === 0
      ? 0
      : Math.max(1, Math.round(maxStep * strength * strength));
  };
  const leftDistance = viewportStart + edgeSize - pointer;
  if (leftDistance > 0) {
    return -normalizedStep(leftDistance);
  }
  const rightDistance = pointer - (viewportEnd - edgeSize);
  return rightDistance > 0 ? normalizedStep(rightDistance) : 0;
}

export function timelineWheelAction(input: {
  altKey: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
}):
  | { kind: "VERTICAL" }
  | { kind: "HORIZONTAL"; delta: number }
  | { kind: "ZOOM_IN" }
  | { kind: "ZOOM_OUT" }
  | null {
  const delta =
    Math.abs(input.deltaY) >= Math.abs(input.deltaX)
      ? input.deltaY
      : input.deltaX;
  if (input.altKey) {
    if (delta === 0) return null;
    return { kind: delta < 0 ? "ZOOM_IN" : "ZOOM_OUT" };
  }
  if (input.shiftKey) {
    return delta === 0 ? null : { kind: "HORIZONTAL", delta };
  }
  return { kind: "VERTICAL" };
}

export function clampDayWindowStartMinutes(
  startMinutes: number,
  visibleHours: number
) {
  const maximum = Math.max(0, 24 * 60 - visibleHours * 60);
  return Math.max(0, Math.min(maximum, startMinutes));
}

export function defaultDayWindowStartMinutes(
  now: number,
  visibleHours: number = DEFAULT_DAY_VISIBLE_HOURS
) {
  const hourPart = new Intl.DateTimeFormat("en-US", {
    ...(isBeijingTimeMode() ? { timeZone: "Asia/Shanghai" } : {}),
    hour: "2-digit",
    hourCycle: "h23"
  })
    .formatToParts(new Date(now))
    .find((part) => part.type === "hour");
  const currentHour = Number(hourPart?.value ?? 0);
  const defaultStartHour = currentHour < 14 ? 9 : 12;
  const defaultCenterMinutes = (defaultStartHour + 6) * 60;
  return clampDayWindowStartMinutes(
    defaultCenterMinutes - (visibleHours * 60) / 2,
    visibleHours
  );
}

export function currentMinuteStart(now: number) {
  return new Date(Math.floor(now / 60_000) * 60_000).toISOString();
}

export type ServerClockAnchor = {
  serverTime: number;
  monotonicTime: number;
};

export function createServerClockAnchor(
  serverNow: string,
  requestStartedAt: number,
  responseReceivedAt: number
): ServerClockAnchor | null {
  const serverTime = new Date(serverNow).getTime();
  if (
    !Number.isFinite(serverTime) ||
    !Number.isFinite(requestStartedAt) ||
    !Number.isFinite(responseReceivedAt) ||
    responseReceivedAt < requestStartedAt
  ) {
    return null;
  }
  return {
    serverTime: serverTime + (responseReceivedAt - requestStartedAt) / 2,
    monotonicTime: responseReceivedAt
  };
}

export function serverTimeFromAnchor(
  anchor: ServerClockAnchor,
  monotonicTime: number
) {
  return anchor.serverTime + Math.max(0, monotonicTime - anchor.monotonicTime);
}

export function parseCalendarQuery(
  search: string,
  fallbackDate: string
): CalendarQueryState {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const date = params.get("date") ?? "";
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : fallbackDate,
    view: params.get("view") === "week" ? "week" : "day",
    machineId: params.get("machine")?.trim() ?? ""
  };
}

export function calendarQueryUrl(state: CalendarQueryState) {
  const params = new URLSearchParams();
  params.set("date", state.date);
  if (state.view === "week") params.set("view", "week");
  if (state.machineId) params.set("machine", state.machineId);
  const query = params.toString();
  return query ? `/calendar?${query}` : "/calendar";
}

export function calendarEditUrl(input: {
  reservationId: string;
  date: string;
  machineId: string;
}) {
  const params = new URLSearchParams({
    date: input.date,
    machine: input.machineId,
    edit: input.reservationId
  });
  return `/calendar?${params.toString()}`;
}

export type CalendarEditRoute =
  | { kind: "NONE" }
  | { kind: "INVALID" }
  | { kind: "EDIT"; reservationId: string };

export function parseCalendarEditRoute(search: string): CalendarEditRoute {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  if (!params.has("edit")) return { kind: "NONE" };
  const value = params.get("edit")?.trim() ?? "";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    return { kind: "INVALID" };
  }
  return { kind: "EDIT", reservationId: value };
}

export function parseCalendarEditReservationId(search: string) {
  const route = parseCalendarEditRoute(search);
  return route.kind === "EDIT" ? route.reservationId : "";
}

export function calendarUrlWithoutEditRequest(search: string) {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  params.delete("edit");
  const query = params.toString();
  return query ? `/calendar?${query}` : "/calendar";
}

export function calendarUrlWithEditRequest(
  search: string,
  reservationId: string
) {
  const params = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search
  );
  params.set("edit", reservationId);
  return `/calendar?${params.toString()}`;
}

export function reservationTargetKey(
  input: Pick<
    ReservationSegmentInput,
    "scope" | "machineId" | "resourceGroupId"
  >
) {
  return input.scope === "MACHINE"
    ? `MACHINE:${input.machineId ?? input.resourceGroupId}`
    : `GROUP:${input.resourceGroupId}`;
}

export function draggedTimeRange({
  rangeStart,
  days,
  trackLeft,
  trackWidth,
  pointerStart,
  pointerEnd,
  anchorAt,
  snapMinutes = 15
}: {
  rangeStart: string;
  days: number;
  trackLeft: number;
  trackWidth: number;
  pointerStart: number;
  pointerEnd: number;
  anchorAt?: string;
  snapMinutes?: number;
}) {
  if (trackWidth <= 0 || Math.abs(pointerEnd - pointerStart) < 4) return null;
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const second = clamp((pointerEnd - trackLeft) / trackWidth);
  const totalMinutes = days * 24 * 60;
  const snap = (fraction: number) =>
    Math.round((fraction * totalMinutes) / snapMinutes) * snapMinutes;
  const rangeStartTime = new Date(rangeStart).getTime();
  const anchorTime = anchorAt ? new Date(anchorAt).getTime() : Number.NaN;
  const firstMinutes = anchorAt
    ? Math.round((anchorTime - rangeStartTime) / 60_000 / snapMinutes) *
      snapMinutes
    : snap(clamp((pointerStart - trackLeft) / trackWidth));
  if (!Number.isFinite(firstMinutes)) return null;
  const clampedFirstMinutes = Math.max(
    0,
    Math.min(totalMinutes, firstMinutes)
  );
  const secondMinutes = snap(second);
  const startMinutes = Math.min(clampedFirstMinutes, secondMinutes);
  const endMinutes = Math.max(
    startMinutes + snapMinutes,
    Math.max(clampedFirstMinutes, secondMinutes)
  );
  return {
    startAt: new Date(rangeStartTime + startMinutes * 60_000).toISOString(),
    endAt: new Date(
      rangeStartTime + Math.min(totalMinutes, endMinutes) * 60_000
    ).toISOString()
  };
}

export function snappedTimelineInstant({
  rangeStart,
  days,
  trackLeft,
  trackWidth,
  pointer,
  snapMinutes = 15
}: {
  rangeStart: string;
  days: number;
  trackLeft: number;
  trackWidth: number;
  pointer: number;
  snapMinutes?: number;
}) {
  if (trackWidth <= 0) return null;
  const fraction = Math.max(
    0,
    Math.min(1, (pointer - trackLeft) / trackWidth)
  );
  const totalMinutes = days * 24 * 60;
  const minutes = Math.max(
    0,
    Math.min(
      totalMinutes,
      Math.round((fraction * totalMinutes) / snapMinutes) * snapMinutes
    )
  );
  return new Date(
    new Date(rangeStart).getTime() + minutes * 60_000
  ).toISOString();
}

export function subtractBusyTimeRanges(
  requested: CalendarTimeRange,
  busyRanges: CalendarTimeRange[]
) {
  const requestedStart = new Date(requested.startAt).getTime();
  const requestedEnd = new Date(requested.endAt).getTime();
  if (
    !Number.isFinite(requestedStart) ||
    !Number.isFinite(requestedEnd) ||
    requestedEnd <= requestedStart
  ) {
    return [];
  }
  const busy = busyRanges
    .map((range) => ({
      start: Math.max(requestedStart, new Date(range.startAt).getTime()),
      end: Math.min(requestedEnd, new Date(range.endAt).getTime())
    }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.start < range.end
    )
    .sort((a, b) => a.start - b.start);
  const mergedBusy: Array<{ start: number; end: number }> = [];
  for (const range of busy) {
    const previous = mergedBusy.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      mergedBusy.push({ ...range });
    }
  }
  const available: CalendarTimeRange[] = [];
  let cursor = requestedStart;
  for (const range of mergedBusy) {
    if (range.start > cursor) {
      available.push({
        startAt: new Date(cursor).toISOString(),
        endAt: new Date(range.start).toISOString()
      });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (requestedEnd > cursor) {
    available.push({
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(requestedEnd).toISOString()
    });
  }
  return available;
}

export function mergeTimeRanges(ranges: CalendarTimeRange[]) {
  const normalized = ranges
    .map((range) => ({
      start: new Date(range.startAt).getTime(),
      end: new Date(range.endAt).getTime()
    }))
    .filter(
      (range) =>
        Number.isFinite(range.start) &&
        Number.isFinite(range.end) &&
        range.start < range.end
    )
    .sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of normalized) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map((range) => ({
    startAt: new Date(range.start).toISOString(),
    endAt: new Date(range.end).toISOString()
  }));
}

export function eraseCalendarDraftRange(
  drafts: CalendarDraft[],
  target: Pick<
    ReservationSegmentInput,
    "scope" | "machineId" | "resourceGroupId"
  >,
  erasedRange: CalendarTimeRange,
  createId: () => string,
  immediateBoundary?: string
) {
  const erasedStart = new Date(erasedRange.startAt).getTime();
  const erasedEnd = new Date(erasedRange.endAt).getTime();
  if (
    !Number.isFinite(erasedStart) ||
    !Number.isFinite(erasedEnd) ||
    erasedStart >= erasedEnd
  ) {
    return { drafts, changed: false };
  }
  const targetKey = reservationTargetKey(target);
  const boundaryTime = immediateBoundary
    ? new Date(immediateBoundary).getTime()
    : Number.NaN;
  let changed = false;
  const next = drafts.flatMap((draft) => {
    if (reservationTargetKey(draft) !== targetKey) return [draft];
    const start = new Date(draft.startAt).getTime();
    const end = new Date(draft.endAt).getTime();
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      erasedEnd <= start ||
      erasedStart >= end
    ) {
      return [draft];
    }
    changed = true;
    const ranges = [
      { start, end: Math.min(end, erasedStart) },
      { start: Math.max(start, erasedEnd), end }
    ].filter((range) => range.end > range.start);
    return ranges.map((range, index) => ({
      ...draft,
      id: index === 0 ? draft.id : createId(),
      startAt: new Date(range.start).toISOString(),
      endAt: new Date(range.end).toISOString(),
      ...(Number.isFinite(boundaryTime)
        ? {
            startMode:
              range.start <= boundaryTime
                ? "IMMEDIATE" as const
                : "SCHEDULED" as const
          }
        : {})
    }));
  });
  return { drafts: next, changed };
}

export function mergeCalendarDrafts(
  drafts: CalendarDraft[],
  additions: Array<ReservationSegmentInput & CalendarTimeRange>,
  createId: () => string,
  immediateBoundary?: string
) {
  const boundaryTime = immediateBoundary
    ? new Date(immediateBoundary).getTime()
    : Number.NaN;
  const targetOrder = Array.from(
    new Set([
      ...drafts.map(reservationTargetKey),
      ...additions.map(reservationTargetKey)
    ])
  );
  return targetOrder.flatMap((targetKey) => {
    const existing = drafts.filter(
      (draft) => reservationTargetKey(draft) === targetKey
    );
    const targetAdditions = additions.filter(
      (addition) => reservationTargetKey(addition) === targetKey
    );
    const validExisting = existing.filter((draft) => {
      const start = new Date(draft.startAt).getTime();
      const end = new Date(draft.endAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && start < end;
    });
    const invalidExisting = existing.filter(
      (draft) => !validExisting.includes(draft)
    );
    const ranges = mergeTimeRanges([...validExisting, ...targetAdditions]);
    const target = validExisting[0] ?? targetAdditions[0] ?? existing[0];
    return [
      ...ranges.map((range, index) => ({
        ...target,
        id: validExisting[index]?.id ?? createId(),
        ...range,
        ...(Number.isFinite(boundaryTime)
          ? {
              startMode:
                new Date(range.startAt).getTime() <= boundaryTime
                  ? "IMMEDIATE" as const
                  : "SCHEDULED" as const
            }
          : target.startMode
            ? { startMode: target.startMode }
            : {})
      })),
      ...invalidExisting
    ];
  });
}

export function advanceCalendarDrafts(
  drafts: CalendarDraft[],
  boundary: string
) {
  const boundaryTime = new Date(boundary).getTime();
  if (!Number.isFinite(boundaryTime)) {
    return { drafts, changed: false };
  }
  let changed = false;
  const next = drafts.flatMap((draft) => {
    const start = new Date(draft.startAt).getTime();
    const end = new Date(draft.endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [draft];
    const immediate = draft.startMode === "IMMEDIATE" || start <= boundaryTime;
    if (!immediate) {
      if (draft.startMode === "SCHEDULED") return [draft];
      changed = true;
      return [{ ...draft, startMode: "SCHEDULED" as const }];
    }
    if (end <= boundaryTime) {
      changed = true;
      return [];
    }
    if (start !== boundaryTime || draft.startMode !== "IMMEDIATE") {
      changed = true;
      return [
        {
          ...draft,
          startMode: "IMMEDIATE" as const,
          startAt: new Date(boundaryTime).toISOString()
        }
      ];
    }
    return [draft];
  });
  return { drafts: next, changed };
}

export function reservationInput(
  draft: CalendarDraft,
  metadata: CalendarMetadata
): ReservationSegmentInput {
  return {
    scope: draft.scope,
    machineId: draft.machineId,
    resourceGroupId: draft.resourceGroupId,
    startMode: draft.startMode,
    startAt: draft.startAt,
    endAt: draft.endAt,
    title: metadata.title,
    purpose: metadata.purpose,
    note: metadata.note
  };
}

export function previewKey(input: ReservationSegmentInput) {
  return `${reservationTargetKey(input)}\u0000${input.startAt}\u0000${input.endAt}`;
}

export function previewsByDraftId(
  drafts: CalendarDraft[],
  items: ReservationPreviewItem[]
) {
  const result = new Map<string, ReservationPreviewItem>();
  drafts.forEach((draft, index) => {
    const item = items[index];
    if (item) result.set(draft.id, item);
  });
  return result;
}

export function splitDrafts(
  drafts: CalendarDraft[],
  previews: ReadonlyMap<string, ReservationPreviewItem>,
  createId: () => string
) {
  return drafts.flatMap((draft) => {
    const result = previews.get(draft.id);
    if (!result || result.available) return [draft];
    return result.splitSegments.map((segment) => ({
      ...segment,
      id: createId()
    }));
  });
}

/** Apply an authoritative preview without regenerating unchanged draft IDs. */
export function adjustDraftsToAvailability(drafts: CalendarDraft[], items: ReservationPreviewItem[], createId: () => string) {
  if (items.length !== drafts.length) throw new Error("Incomplete availability preview");
  let changed = false;
  const next = drafts.flatMap((draft, index) => {
    const item = items[index];
    if (item.input.resourceGroupId !== draft.resourceGroupId || item.input.endAt !== draft.endAt) {
      throw new Error("Mismatched availability preview");
    }
    const ranges = item.available ? [item.input] : item.splitSegments;
    if (ranges.length === 1 && ranges[0].startAt === draft.startAt && ranges[0].endAt === draft.endAt) return [draft];
    changed = true;
    return ranges.map((segment, part) => ({ ...draft, ...segment, id: part === 0 ? draft.id : createId() }));
  });
  return { drafts: changed ? next : drafts, changed };
}

export function calendarDraftIssues(
  drafts: CalendarDraft[],
  rules: CalendarBookingRules,
  now = Date.now(),
  allowMixedScopes = false
) {
  const issues: string[] = [];
  if (drafts.length > 100) issues.push(tr("一次最多提交 100 条占用"));
  if (!allowMixedScopes && new Set(drafts.map((draft) => draft.scope ?? "RESOURCE_GROUP")).size > 1) {
    issues.push(tr("整机占用和资源组占用不能同时提交"));
  }
  const grouped = new Map<string, CalendarDraft[]>();
  for (const draft of drafts) {
    const fieldIssues = calendarDraftFieldIssues(draft, rules, now);
    if (fieldIssues.startAt) issues.push(fieldIssues.startAt);
    if (fieldIssues.endAt) issues.push(fieldIssues.endAt);
    const targetKey = reservationTargetKey(draft);
    const bucket = grouped.get(targetKey) ?? [];
    bucket.push(draft);
    grouped.set(targetKey, bucket);
  }
  for (const bucket of grouped.values()) {
    const sorted = [...bucket].sort((a, b) => a.startAt.localeCompare(b.startAt));
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].startAt < sorted[index - 1].endAt) {
        issues.push(tr("同一占用目标存在重叠的草稿时段"));
        break;
      }
    }
  }
  return Array.from(new Set(issues));
}

export function calendarDraftFieldIssues(
  draft: CalendarDraft,
  rules: CalendarBookingRules,
  now = Date.now()
): CalendarDraftFieldIssues {
  const start = new Date(draft.startAt).getTime();
  const end = new Date(draft.endAt).getTime();
  if (!Number.isFinite(start)) {
    return { startAt: tr("请输入有效的开始时间") };
  }
  if (!Number.isFinite(end) || end <= start) {
    return { endAt: tr("结束时间必须晚于开始时间") };
  }
  const issues: CalendarDraftFieldIssues = {};
  const currentMinute = Math.floor(now / 60_000) * 60_000;
  if (start < currentMinute) {
    issues.startAt = tr("不能占用已经过去的时间");
  }
  if (end > now + rules.advanceDays * 24 * 60 * 60_000) {
    issues.endAt = tr("占用结束时间不能超过未来 {{v0}} 天", { v0: rules.advanceDays });
  }
  return issues;
}
