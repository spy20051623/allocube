import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readCollapsedCalendarMachineIds,
  readCalendarPreference,
  writeCollapsedCalendarMachineIds,
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
  afterEach(() => vi.unstubAllGlobals());

  it("缺少或损坏的偏好使用安全默认值", () => {
    expect(readCalendarPreference()).toEqual({
      reservationMode: "RESOURCE_GROUP",
      visibleHours: 24
    });
    store.set("allocube.calendar-preference.v1", "{");
    expect(readCalendarPreference()).toEqual({
      reservationMode: "RESOURCE_GROUP",
      visibleHours: 24
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

  it("旧十二小时偏好只迁移一次，保留机器和模式，随后可重新选择十二小时", () => {
    store.set("allocube.calendar-preference.v1", JSON.stringify({ machineId: "machine-a", reservationMode: "MACHINE", visibleHours: 12 }));
    expect(readCalendarPreference()).toEqual({ machineId: "machine-a", reservationMode: "MACHINE", visibleHours: 24 });
    expect(JSON.parse(store.get("allocube.calendar-preference.v1")!).zoomPreferenceVersion).toBe(1);
    writeCalendarPreference({ visibleHours: 12 });
    expect(readCalendarPreference()).toEqual({ machineId: "machine-a", reservationMode: "MACHINE", visibleHours: 12 });
    writeCalendarPreference({ reservationMode: "RESOURCE_GROUP" });
    expect(readCalendarPreference()).toMatchObject({ visibleHours: 12 });
  });

  it.each([6, 24])("保留旧 %i 小时选择", visibleHours => {
    store.set("allocube.calendar-preference.v1", JSON.stringify({ visibleHours }));
    expect(readCalendarPreference()).toMatchObject({ visibleHours });
  });

  it.each(["read", "write"])("存储 %s 失败时，在当前页面保留迁移和手动缩放", async failure => {
    vi.resetModules();
    const preference = await import("../src/calendar-preference");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        if (failure === "read") throw new Error("Storage blocked");
        return JSON.stringify({ visibleHours: 12 });
      },
      setItem: () => { throw new Error("Storage blocked"); }
    });
    expect(preference.readCalendarPreference().visibleHours).toBe(24);
    preference.writeCalendarPreference({ visibleHours: 12 });
    expect(preference.readCalendarPreference()).toMatchObject({ visibleHours: 12 });
  });

  it("按用户保存去重后的机器折叠状态", () => {
    writeCollapsedCalendarMachineIds("user/a", [
      "machine-a",
      "machine-b",
      "machine-a",
      ""
    ]);

    expect(readCollapsedCalendarMachineIds("user/a")).toEqual([
      "machine-a",
      "machine-b"
    ]);
    expect(readCollapsedCalendarMachineIds("user/b")).toEqual([]);
  });

  it("损坏的机器折叠状态不会影响日历", () => {
    store.set("allocube.calendar-machine-collapse.v1:user", "{");
    expect(readCollapsedCalendarMachineIds("user")).toEqual([]);
    store.set(
      "allocube.calendar-machine-collapse.v1:user",
      JSON.stringify(["machine-a", 1, null, "machine-a"])
    );
    expect(readCollapsedCalendarMachineIds("user")).toEqual(["machine-a"]);
  });
});
