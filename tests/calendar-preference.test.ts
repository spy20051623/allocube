import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCalendarPreference,
  writeCalendarPreference
} from "../src/calendar-preference";

describe("资源日历偏好", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value)
    });
  });

  it("缺少或损坏的偏好使用安全默认值", () => {
    expect(readCalendarPreference()).toEqual({
      reservationMode: "RESOURCE_GROUP",
      visibleHours: 12
    });
    store.set("allocube.calendar-preference.v1", "{");
    expect(readCalendarPreference()).toEqual({
      reservationMode: "RESOURCE_GROUP",
      visibleHours: 12
    });
  });

  it("保存机器、模式和缩放档位", () => {
    writeCalendarPreference({
      machineId: "machine-a",
      reservationMode: "MACHINE",
      visibleHours: 6
    });
    expect(readCalendarPreference()).toEqual({
      machineId: "machine-a",
      reservationMode: "MACHINE",
      visibleHours: 6
    });
  });
});
