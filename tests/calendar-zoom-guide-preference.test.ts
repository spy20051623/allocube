import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("日历缩放提示独立于缩放偏好", () => {
  const store = new Map<string, string>();
  let preference: typeof import("../src/features/calendar/calendar-zoom-guide-preference");
  beforeEach(async () => {
    store.clear();
    vi.resetModules();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value)
    });
    preference = await import("../src/features/calendar/calendar-zoom-guide-preference");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("默认展示提示，无效标记不当作已关闭", () => {
    expect(preference.readZoomGuideDismissed()).toBe(false);
    store.set("allocube.calendar-zoom-guide.v1", "invalid");
    expect(preference.readZoomGuideDismissed()).toBe(false);
  });

  it("关闭记录可重新加载，且不修改缩放偏好", async () => {
    const zoomPreference = JSON.stringify({ visibleHours: 12, zoomPreferenceVersion: 1 });
    store.set("allocube.calendar-preference.v1", zoomPreference);
    preference.saveZoomGuideDismissed();
    expect(preference.readZoomGuideDismissed()).toBe(true);
    expect(store.get("allocube.calendar-preference.v1")).toBe(zoomPreference);
    vi.resetModules();
    const reloaded = await import("../src/features/calendar/calendar-zoom-guide-preference");
    expect(reloaded.readZoomGuideDismissed()).toBe(true);
  });

  it.each(["read", "write"])("存储 %s 失败时仍在当前页面记住关闭", failure => {
    vi.stubGlobal("localStorage", {
      getItem: () => { if (failure === "read") throw new Error("Blocked"); return null; },
      setItem: () => { throw new Error("Blocked"); }
    });
    expect(preference.readZoomGuideDismissed()).toBe(false);
    preference.saveZoomGuideDismissed();
    expect(preference.readZoomGuideDismissed()).toBe(true);
  });
});
