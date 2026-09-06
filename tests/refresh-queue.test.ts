import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshQueue } from "../src/refresh-queue";
import { affectsRealtime, parseRealtimeChange } from "../src/shared/realtime";
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("刷新调度", () => {
  it("200 毫秒内的操作刷新和事件刷新合并", async () => {
    const run = vi.fn(async () => 1), queue = new RefreshQueue(run);
    const requests = [queue.request([]), queue.request([]), queue.request([])];
    await vi.advanceTimersByTimeAsync(199); expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await Promise.all(requests)).toEqual([1,1,1]); expect(run).toHaveBeenCalledOnce(); queue.dispose();
  });
  it("请求在途收到多次更新只补刷一次，禁止并行请求", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const queue = new RefreshQueue(run); void queue.request([]);
    await vi.advanceTimersByTimeAsync(200); void queue.request([]); void queue.request([]);
    await vi.advanceTimersByTimeAsync(1000); expect(run).toHaveBeenCalledOnce();
    finish(); await vi.advanceTimersByTimeAsync(200); expect(run).toHaveBeenCalledTimes(2); finish(); queue.dispose();
  });
  it("隐藏后停止刷新，恢复可见只更新一次，权限复核可立即执行", async () => {
    let visible = false;
    const run = vi.fn(async () => undefined), queue = new RefreshQueue(run, () => visible);
    void queue.request([]); void queue.request([]);
    await vi.advanceTimersByTimeAsync(30_000); expect(run).not.toHaveBeenCalled();
    visible = true; queue.resume(); await vi.advanceTimersByTimeAsync(200); expect(run).toHaveBeenCalledOnce();
    visible = false; void queue.request([], true); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2); queue.dispose();
  });
  it("卸载取消在途请求，清理待执行刷新", async () => {
    let signal!: AbortSignal;
    const queue = new RefreshQueue(async (s: AbortSignal) => { signal=s; await new Promise<void>(resolve => s.addEventListener("abort", () => resolve())); });
    void queue.request([]); await vi.advanceTimersByTimeAsync(200); void queue.request([]); queue.dispose();
    expect(signal.aborted).toBe(true); await vi.runAllTimersAsync();
  });
  it("旧格式和无效范围回退完整刷新，机器与时间相交才匹配", () => {
    expect(parseRealtimeChange('{"revision":1}')).toBeNull();
    expect(parseRealtimeChange('invalid')).toBeNull();
    expect(affectsRealtime(null, "session")).toBe(true);
    const change = parseRealtimeChange(JSON.stringify({version:2,eventId:"id",revision:1,scopes:[{topic:"timeline",machineId:"m",from:"2026-09-06T00:00:00Z",to:"2026-09-07T00:00:00Z"}]}))!;
    expect(affectsRealtime(change,"timeline",{machineIds:["other"]})).toBe(false);
    expect(affectsRealtime(change,"timeline",{machineIds:["m"],from:"2026-09-07T00:00:00Z",to:"2026-09-08T00:00:00Z"})).toBe(false);
    expect(affectsRealtime(change,"timeline",{machineIds:["m"],from:"2026-09-06T10:00:00Z",to:"2026-09-06T11:00:00Z"})).toBe(true);
  });
});
