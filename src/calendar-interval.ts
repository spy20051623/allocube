export type CalendarViewRange = { from: string; to: string };

/** Intersect half-open intervals [start, end); touching endpoints have no duration. */
export function intersectCalendarInterval(
  interval: { startAt: string; endAt: string },
  range: CalendarViewRange
): { start: number; end: number } | null {
  const start = Date.parse(interval.startAt), end = Date.parse(interval.endAt);
  const from = Date.parse(range.from), to = Date.parse(range.to);
  if (![start, end, from, to].every(Number.isFinite) || end <= start || to <= from) return null;
  const clippedStart = Math.max(start, from), clippedEnd = Math.min(end, to);
  return clippedStart < clippedEnd ? { start: clippedStart, end: clippedEnd } : null;
}
