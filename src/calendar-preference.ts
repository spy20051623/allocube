import { DAY_ZOOM_LEVELS, DEFAULT_DAY_VISIBLE_HOURS } from "./calendar-state";

export type CalendarPreference = {
  machineId?: string;
  reservationMode: "RESOURCE_GROUP" | "MACHINE";
  visibleHours: (typeof DAY_ZOOM_LEVELS)[number];
};

const STORAGE_KEY = "allocube.calendar-preference.v1";
const MACHINE_COLLAPSE_STORAGE_KEY = "allocube.calendar-machine-collapse.v1";
const ZOOM_PREFERENCE_VERSION = 1;

const fallbackPreference: CalendarPreference = {
  reservationMode: "RESOURCE_GROUP",
  visibleHours: DEFAULT_DAY_VISIBLE_HOURS
};

// Keep choices for this page if browser storage cannot accept them.
let volatilePreference: CalendarPreference | null = null;

function saveCalendarPreference(preference: CalendarPreference) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...preference,
      zoomPreferenceVersion: ZOOM_PREFERENCE_VERSION
    }));
    volatilePreference = null;
  } catch {
    volatilePreference = preference;
  }
}

export function readCalendarPreference(): CalendarPreference {
  if (volatilePreference) return volatilePreference;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = (raw ? JSON.parse(raw) : {}) as Partial<CalendarPreference> & { zoomPreferenceVersion?: number };
    const needsMigration = parsed.zoomPreferenceVersion !== ZOOM_PREFERENCE_VERSION;
    const visibleHours = DAY_ZOOM_LEVELS.includes(parsed.visibleHours as CalendarPreference["visibleHours"])
      ? parsed.visibleHours as CalendarPreference["visibleHours"]
      : fallbackPreference.visibleHours;
    const preference: CalendarPreference = {
      ...(typeof parsed.machineId === "string" && parsed.machineId
        ? { machineId: parsed.machineId }
        : {}),
      reservationMode:
        parsed.reservationMode === "MACHINE" ? "MACHINE" : "RESOURCE_GROUP",
      // Legacy storage did not distinguish the 12-hour default from a manual choice.
      visibleHours: needsMigration && visibleHours === 12 ? DEFAULT_DAY_VISIBLE_HOURS : visibleHours
    };
    if (needsMigration) saveCalendarPreference(preference);
    return preference;
  } catch {
    return fallbackPreference;
  }
}

export function writeCalendarPreference(
  update: Partial<CalendarPreference>
) {
  saveCalendarPreference({ ...readCalendarPreference(), ...update });
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
