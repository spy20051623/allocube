import { currentLocale, tr } from "./i18n/index";
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
let beijingTimeMode = false;

export function setBeijingTimeMode(enabled: boolean) {
  beijingTimeMode = enabled;
}

export function isBeijingTimeMode() {
  return beijingTimeMode;
}

export function isUtcPlus8Offset(offsetMinutes: number) {
  return offsetMinutes === -480;
}

export function clientUsesUtcPlus8(at: string | number | Date = Date.now()) {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) && isUtcPlus8Offset(date.getTimezoneOffset());
}

function localParts(date: Date) {
  return [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes()
  ];
}

function localDateTime(parts: number[]) {
  const [year, month, day, hour, minute] = parts;
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  return localParts(date).every((value, index) => value === parts[index])
    ? date
    : null;
}

export function chinaLocalToIso(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  if (!beijingTimeMode) {
    return localDateTime([
      Number(year),
      Number(month),
      Number(day),
      Number(hour),
      Number(minute)
    ])?.toISOString() ?? "";
  }
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
  const source = new Date(value);
  const time = source.getTime();
  if (!Number.isFinite(time)) return "";
  if (!beijingTimeMode) {
    const [year, month, day, hour, minute] = localParts(source);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  return new Date(time + SHANGHAI_OFFSET_MS).toISOString().slice(0, 16);
}

export function todayChina() {
  return isoToChinaLocal(new Date().toISOString()).slice(0, 10);
}

export function addDays(date: string, days: number) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  return new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
  ).toISOString().slice(0, 10);
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
  if (!match) return "";
  if (currentLocale() === "zh-CN") {
    return tr("{{v0}}年{{v1}}月", { v0: match[1], v1: Number(match[2]) });
  }
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export function calendarWeekdayLabels() {
  const locale = currentLocale();
  const formatter = new Intl.DateTimeFormat(locale, {
    weekday: locale === "en" ? "short" : "narrow",
    timeZone: "UTC"
  });
  const monday = Date.UTC(2021, 7, 2);
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(monday + index * 24 * 60 * 60 * 1000))
  );
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
  return new Intl.DateTimeFormat(currentLocale(), {
    ...(beijingTimeMode ? { timeZone: "Asia/Shanghai" } : {}),
    ...options
  }).format(date);
}

export function formatBeijing(
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
  return new Intl.DateTimeFormat(currentLocale(), {
    timeZone: "Asia/Shanghai",
    ...options
  }).format(date);
}

export function formatChinaFullMinute(value: string) {
  if (currentLocale() === "en") {
    return formatChina(value, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }
  const local = isoToChinaLocal(value);
  const match = local.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
  );
  if (!match) return "";
  const [, year, month, day, hour, minute] = match;
  return `${year}/${month}/${day} ${hour}:${minute}`;
}

export function formatChinaDate(value: string) {
  if (currentLocale() === "en") {
    return formatChina(value, { year: "numeric", month: "2-digit", day: "2-digit" });
  }
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
  if (currentLocale() === "en") {
    if (minutes < 60) return englishUnit(minutes, "minute");
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${englishUnit(hours, "hour")} ${englishUnit(rest, "minute")}` : englishUnit(hours, "hour");
  }
  if (minutes < 60) return tr("{{v0}} 分钟", { v0: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? tr("{{v0}} 小时 {{v1}} 分", { v0: hours, v1: rest }) : tr("{{v0}} 小时", { v0: hours });
}

export function compactDurationText(minutes: number) {
  const roundedMinutes = Math.max(0, Math.round(minutes));
  if (currentLocale() !== "en") return durationText(roundedMinutes);
  if (roundedMinutes < 60) return `${roundedMinutes}m`;
  const hours = Math.floor(roundedMinutes / 60);
  const rest = roundedMinutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function compactHoursText(minutes: number) {
  if (currentLocale() !== "en") return durationHoursText(minutes);
  const hours = new Intl.NumberFormat("en", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(minutes / 60);
  return `${hours}h`;
}

export function durationHoursText(minutes: number) {
  if (currentLocale() === "en") return englishUnit(minutes / 60, "hour", 1);
  return tr("{{v0}} 小时", { v0: (minutes / 60).toFixed(1) });
}

function englishUnit(value: number, unit: "minute" | "hour", fractionDigits = 0) {
  const formatted = new Intl.NumberFormat("en", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(value);
  return `${formatted} ${unit}${value === 1 ? "" : "s"}`;
}

export function mondayOf(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  const day = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  ).getUTCDay() || 7;
  return addDays(date, 1 - day);
}
