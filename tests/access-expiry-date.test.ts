import { afterEach, expect, it, vi } from "vitest";
import { setBeijingTimeMode } from "../src/date";
import { accessExpiryValue, accessExpiryInput, accessExpiryLabel, defaultAccessExpiryInput } from "../src/features/machines/AccessExpiryField";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); setBeijingTimeMode(false); });

it("uses the selected day's exclusive midnight boundary, including month and year transitions", () => {
  setBeijingTimeMode(true);
  vi.useFakeTimers(); vi.setSystemTime("2026-09-13T03:00:00.000Z");
  expect(defaultAccessExpiryInput()).toBe("2026-10-13");
  for (const [day, iso] of [["2026-09-13", "2026-09-13T16:00:00.000Z"], ["2026-09-30", "2026-09-30T16:00:00.000Z"], ["2026-12-31", "2026-12-31T16:00:00.000Z"]]) {
    expect(accessExpiryValue(day, false)).toBe(iso);
    expect(accessExpiryInput(iso)).toBe(day);
    expect(accessExpiryLabel(iso)).toBe(day);
  }
  expect(() => accessExpiryValue("2026-09-12", false)).toThrow();
  expect(() => accessExpiryValue("2027-02-30", false)).toThrow();
  expect(accessExpiryValue("", true)).toBeNull();
});

it("rejects yesterday exactly at the next midnight", () => {
  setBeijingTimeMode(true);
  vi.useFakeTimers(); vi.setSystemTime("2026-09-13T16:00:00.000Z");
  expect(() => accessExpiryValue("2026-09-13", false)).toThrow();
  expect(accessExpiryValue("2026-09-14", false)).toBe("2026-09-14T16:00:00.000Z");
});

it.each(["America/New_York", "Pacific/Honolulu", "Asia/Tokyo"])("keeps Beijing expiry dates in %s, independent of display mode", timezone => {
  vi.stubEnv("TZ", timezone);
  vi.useFakeTimers(); vi.setSystemTime("2026-09-13T16:01:00.000Z");
  for (const mode of [false, true]) {
    setBeijingTimeMode(mode);
    expect(defaultAccessExpiryInput()).toBe("2026-10-14");
    expect(accessExpiryValue("2026-09-14", false)).toBe("2026-09-14T16:00:00.000Z");
    expect(accessExpiryInput("2026-09-14T16:00:00.000Z")).toBe("2026-09-14");
    expect(() => accessExpiryValue("2026-09-13", false)).toThrow();
  }
});
