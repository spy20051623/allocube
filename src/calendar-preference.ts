import { DAY_ZOOM_LEVELS } from "./calendar-state";

export type CalendarPreference = {
  machineId?: string;
  reservationMode: "RESOURCE_GROUP" | "MACHINE";
  visibleHours: (typeof DAY_ZOOM_LEVELS)[number];
};

const STORAGE_KEY = "allocube.calendar-preference.v1";
const MACHINE_COLLAPSE_STORAGE_KEY = "allocube.calendar-machine-collapse.v1";

const fallbackPreference: CalendarPreference = {
  reservationMode: "RESOURCE_GROUP",
  visibleHours: 12
};

export function readCalendarPreference(): CalendarPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallbackPreference;
    const parsed = JSON.parse(raw) as Partial<CalendarPreference>;
    return {
      ...(typeof parsed.machineId === "string" && parsed.machineId
        ? { machineId: parsed.machineId }
        : {}),
      reservationMode:
        parsed.reservationMode === "MACHINE" ? "MACHINE" : "RESOURCE_GROUP",
      visibleHours: DAY_ZOOM_LEVELS.includes(
        parsed.visibleHours as (typeof DAY_ZOOM_LEVELS)[number]
      )
        ? (parsed.visibleHours as (typeof DAY_ZOOM_LEVELS)[number])
        : 12
    };
  } catch {
    return fallbackPreference;
  }
}

export function writeCalendarPreference(
  update: Partial<CalendarPreference>
) {
  try {
    const current = readCalendarPreference();
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...current,
        ...update
      })
    );
  } catch {
    // 浏览器禁用存储时不影响排期功能。
  }
}

function machineCollapseStorageKey(userId: string) {
  return `${MACHINE_COLLAPSE_STORAGE_KEY}:${encodeURIComponent(userId)}`;
}

export function readCollapsedCalendarMachineIds(userId: string): string[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(machineCollapseStorageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.filter((value): value is string => typeof value === "string" && Boolean(value)))
    ).slice(0, 1_000);
  } catch {
    return [];
  }
}

export function writeCollapsedCalendarMachineIds(
  userId: string,
  machineIds: Iterable<string>
) {
  if (!userId) return;
  try {
    const normalized = Array.from(
      new Set(Array.from(machineIds).filter(Boolean))
    ).slice(0, 1_000);
    localStorage.setItem(
      machineCollapseStorageKey(userId),
      JSON.stringify(normalized)
    );
  } catch {
    // 浏览器禁用存储时不影响排期功能。
  }
}
