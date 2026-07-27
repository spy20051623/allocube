const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function chinaLocalToIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour) - 8,
      Number(minute)
    )
  ).toISOString();
}

export function isoToChinaLocal(value: string) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(time + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16);
}

export function todayChina() {
  return isoToChinaLocal(new Date().toISOString()).slice(0, 10);
}

export function addDays(date: string, days: number) {
  const base = chinaLocalToIso(`${date}T00:00`);
  return isoToChinaLocal(
    new Date(new Date(base).getTime() + days * 24 * 60 * 60 * 1000).toISOString()
  ).slice(0, 10);
}

export function shiftCalendarMonth(date: string, offset: number) {
  const match = date.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!match) return date;
  const shifted = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1)
  );
  return `${shifted.getUTCFullYear()}-${String(
    shifted.getUTCMonth() + 1
  ).padStart(2, "0")}-01`;
}

export function calendarMonthDates(date: string) {
  const monthStart = shiftCalendarMonth(date, 0);
  const match = monthStart.match(/^(\d{4})-(\d{2})-01$/);
  if (!match) return [];
  const first = Date.UTC(Number(match[1]), Number(match[2]) - 1, 1);
  const mondayOffset = (new Date(first).getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) =>
    new Date(first + (index - mondayOffset) * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
  );
}

export function calendarMonthLabel(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-\d{2}$/);
  return match ? `${match[1]}年${Number(match[2])}月` : "";
}

export function formatChina(
  value: string,
  options: Intl.DateTimeFormatOptions = {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }
) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...options
  }).format(date);
}

export function formatChinaFullMinute(value: string) {
  const local = isoToChinaLocal(value);
  const match = local.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
  );
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

export function formatChinaDate(value: string) {
  const local = isoToChinaLocal(value);
  const match = local.match(/^(\d{4})-(\d{2})-(\d{2})T/);
  if (!match) return "";
  return `${match[1]}/${match[2]}/${match[3]}`;
}

export function chinaDateDayOffset(start: string, end: string) {
  const startDate = isoToChinaLocal(start).slice(0, 10);
  const endDate = isoToChinaLocal(end).slice(0, 10);
  if (!startDate || !endDate) return 0;
  const startTime = Date.parse(`${startDate}T00:00:00Z`);
  const endTime = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return 0;
  return Math.max(0, Math.round((endTime - startTime) / 86_400_000));
}

export function minuteDifference(start: string, end: string) {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

export function durationText(minutes: number) {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
}

export function durationHoursText(minutes: number) {
  return `${(minutes / 60).toFixed(1)} 小时`;
}

export function mondayOf(date: string) {
  const iso = chinaLocalToIso(`${date}T00:00`);
  const shifted = new Date(new Date(iso).getTime() + SHANGHAI_OFFSET_MS);
  const day = shifted.getUTCDay() || 7;
  return addDays(date, 1 - day);
}
