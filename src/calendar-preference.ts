import { DAY_ZOOM_LEVELS } from "./calendar-state";

export type CalendarPreference = {
  machineId?: string;
  reservationMode: "RESOURCE_GROUP" | "MACHINE";
  visibleHours: (typeof DAY_ZOOM_LEVELS)[number];
};

const STORAGE_KEY = "allocube.calendar-preference.v1";

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
