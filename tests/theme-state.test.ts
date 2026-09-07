import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ThemePreference } from "../src/theme/state";

const source = readFileSync(new URL("../public/theme-init.js", import.meta.url), "utf8");
function fixture({ stored = null, dark = false, blocked = false, noMedia = false }: {
  stored?: string | null; dark?: boolean; blocked?: boolean; noMedia?: boolean;
} = {}) {
  let saved = stored;
  const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
  const meta = { content: "" };
  const systemListeners: Array<() => void> = [];
  const storageListeners: Array<(event: object) => void> = [];
  const storage = {
    getItem: () => { if (blocked) throw new Error("blocked"); return saved; },
    setItem: (_key: string, value: string) => { if (blocked) throw new Error("blocked"); saved = value; }
  };
  const media = { matches: dark, addEventListener: (_event: string, listener: () => void) => systemListeners.push(listener) };
  const window = {
    localStorage: storage,
    matchMedia: noMedia ? undefined : () => media,
    addEventListener: (_event: string, listener: (event: object) => void) => storageListeners.push(listener),
    allocubeTheme: undefined as unknown as Window["allocubeTheme"]
  };
  const context = { window, document: { documentElement: root, querySelector: () => meta } };
  runInNewContext(source, context);
  return {
    root, meta, store: window.allocubeTheme, saved: () => saved,
    system(next: boolean) { media.matches = next; systemListeners.forEach(listener => listener()); },
    storage(value: string | null, key: string | null = "allocube:theme:v1") {
      saved = value; storageListeners.forEach(listener => listener({ key, newValue: value, storageArea: storage }));
    },
    reload() { return fixture({ stored: saved, dark: media.matches }); },
    initializeAgain() { runInNewContext(source, context); return systemListeners.length; }
  };
}

describe("主题偏好与首屏初始化", () => {
  it.each([false, true])("未保存偏好时跟随系统（深色=%s）", dark => {
    const f = fixture({ dark });
    expect(f.store.getSnapshot()).toEqual({ preference: "system", resolved: dark ? "dark" : "light" });
    expect(f.root.dataset.theme).toBe(dark ? "dark" : "light");
    expect(f.root.style.colorScheme).toBe(f.root.dataset.theme);
    expect(f.meta.content).toBe(dark ? "#111318" : "#f5f6f8");
  });
  it.each(["light", "dark"] as ThemePreference[])("手动选择 %s 后忽略系统变化，刷新后保留", value => {
    const f = fixture();
    f.store.setPreference(value);
    f.system(value !== "dark");
    expect(f.store.getSnapshot().resolved).toBe(value);
    expect(f.saved()).toBe(value);
    expect(f.reload().store.getSnapshot()).toEqual(f.store.getSnapshot());
  });
  it("恢复跟随系统后立即使用当前系统主题并继续监听", () => {
    const f = fixture({ stored: "light", dark: true });
    f.store.setPreference("system");
    expect(f.store.getSnapshot().resolved).toBe("dark");
    f.system(false);
    expect(f.store.getSnapshot().resolved).toBe("light");
  });
  it("非法存储值和跨标签页删除偏好都回到跟随系统", () => {
    const f = fixture({ stored: "invalid", dark: true });
    expect(f.store.getSnapshot().preference).toBe("system");
    f.storage("light");
    expect(f.store.getSnapshot().resolved).toBe("light");
    f.storage(null);
    expect(f.store.getSnapshot()).toEqual({ preference: "system", resolved: "dark" });
    f.storage("light", "unrelated");
    expect(f.store.getSnapshot().preference).toBe("system");
    f.storage(null, null);
    expect(f.root.dataset.theme).toBe("dark");
  });
  it("存储被禁用时保持内存偏好，系统查询不可用时默认浅色", () => {
    const f = fixture({ blocked: true, noMedia: true });
    expect(f.store.getSnapshot().resolved).toBe("light");
    f.store.setPreference("dark");
    expect(f.root.dataset.theme).toBe("dark");
  });
  it("只在状态变化时通知，可解除订阅，重复初始化不增加监听", () => {
    const f = fixture();
    let calls = 0;
    const initial = f.store.getSnapshot();
    const unsubscribe = f.store.subscribe(() => calls++);
    f.system(false);
    expect(f.store.getSnapshot()).toBe(initial);
    f.store.setPreference("light");
    expect(calls).toBe(1);
    unsubscribe(); f.store.setPreference("dark");
    expect(calls).toBe(1);
    expect(f.initializeAgain()).toBe(1);
  });
  it("同源同步脚本位于应用模块之前，不依赖内联脚本", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html.indexOf('/theme-init.js')).toBeLessThan(html.indexOf('type="module"'));
  });
});
