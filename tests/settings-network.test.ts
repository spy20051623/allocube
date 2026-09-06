import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRequestDeadline, RequestTimeoutError } from "../src/request-deadline";
import { SettingsRequestGate, olderSettingsVersion, validateSettingsResponse } from "../src/settings-state";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("设置请求在弱网下的顺序与终止", () => {
  it("读取和响应体长期挂起时终止请求，迟到结果不生效", async () => {
    let finish!: (value: string) => void, signal!: AbortSignal;
    const apply = vi.fn();
    const result = withRequestDeadline(s => { signal = s; return new Promise<string>(resolve => { finish = resolve; }); }).then(apply);
    const rejected = expect(result).rejects.toBeInstanceOf(RequestTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000); await rejected;
    expect(signal.aborted).toBe(true);
    finish("late body"); await Promise.resolve(); expect(apply).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("一项设置读取失败时取消同批另一项请求，不遗留占线请求", async () => {
    let sibling!: AbortSignal;
    await expect(withRequestDeadline(signal => Promise.all([
      Promise.reject(new Error("network")),
      new Promise<void>(resolve => { sibling = signal; signal.addEventListener("abort", () => resolve()); })
    ]))).rejects.toThrow("network");
    expect(sibling.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("卸载或切换身份会取消读取，已取消请求不会执行", async () => {
    const controller = new AbortController(); controller.abort(); const run = vi.fn();
    await expect(withRequestDeadline(run, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(run).not.toHaveBeenCalled();
  });

  it("保存使之前的读取失效，保存期间禁止读取和重复写入", () => {
    const gate = new SettingsRequestGate(), parent = new AbortController();
    const old = gate.beginRead(parent.signal)!;
    expect(gate.beginWrite()).toBe(true);
    expect(old.signal.aborted).toBe(true); expect(old.current()).toBe(false);
    expect(gate.beginRead(parent.signal)).toBeNull(); expect(gate.beginWrite()).toBe(false);
    gate.endWrite();
    const latest = gate.beginRead(parent.signal)!;
    expect(latest.current()).toBe(true); expect(old.current()).toBe(false);
    old.dispose(); gate.invalidate(); expect(latest.signal.aborted).toBe(true); latest.dispose();
  });

  it("确认重载时丢弃此前在途读取，不借用之前请求替换草稿", () => {
    const gate = new SettingsRequestGate(), parent = new AbortController();
    const beforeConfirmation = gate.beginRead(parent.signal)!;
    gate.invalidate(); const reload = gate.beginRead(parent.signal)!;
    expect(beforeConfirmation.current()).toBe(false); expect(reload.current()).toBe(true);
    parent.abort(); expect(reload.current()).toBe(false); beforeConfirmation.dispose(); reload.dispose();
  });

  it("拒绝版本回退，两类设置版本互不替代", () => {
    const previous = { adminSettings: { version: 4 }, smtp: { version: 8 } };
    expect(olderSettingsVersion(previous, { version: 3 }, { version: 9 })).toBe(true);
    expect(olderSettingsVersion(previous, { version: 5 }, { version: 7 })).toBe(true);
    expect(olderSettingsVersion(previous, { version: 4 }, { version: 8 })).toBe(false);
  });
  it("网关返回 HTML、截断对象或缺失版本时不将其当成设置", () => {
    for (const value of ["<html>Proxy error</html>", null, {}, { version: 3 }]) {
      expect(() => validateSettingsResponse(value)).toThrow("Invalid settings response");
      expect(() => validateSettingsResponse(value, true)).toThrow("Invalid settings response");
    }
  });
});
