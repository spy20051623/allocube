import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeListener = (event?: { data: string }) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly listeners = new Map<string, Set<FakeListener>>();
  readonly url: string;
  onopen: FakeListener | null = null;
  onerror: FakeListener | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(eventName: string, listener: FakeListener) {
    const listeners = this.listeners.get(eventName) ?? new Set();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  emit(eventName: string, payload?: unknown) {
    for (const listener of this.listeners.get(eventName) ?? []) listener(payload === undefined ? undefined : { data: JSON.stringify(payload) });
  }

  close() {
    this.closed = true;
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("页面内实时连接复用", () => {
  it("按独立事件标识去重，同排期版本的新事件及旧格式均可投递", async () => {
    const { subscribeRealtimeEvent } = await import("../src/realtime");
    const listener = vi.fn(), stop = subscribeRealtimeEvent("revision", listener);
    const source = FakeEventSource.instances[0];
    const event = { version: 2, eventId: "first", revision: 4, scopes: [{ topic: "notifications" }] };
    source.emit("revision", event); source.emit("revision", event);
    source.emit("revision", { ...event, eventId: "second" });
    source.emit("revision", { revision: 4 });
    source.emit("revision", { ...event, version: 99 });
    expect(listener.mock.calls.map(([value]) => value?.eventId ?? null)).toEqual(["first", "second", null, null]);
    stop(); vi.runAllTimers();
  });

  it("隐藏时保留连接但暂停同步与断线轮询，失权立即送达，前台统一追赶", async () => {
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", document);
    const { subscribeRealtimeEvent } = await import("../src/realtime");
    const listener = vi.fn(), stop = subscribeRealtimeEvent("revision", listener);
    const source = FakeEventSource.instances[0]; source.onopen?.();
    document.visibilityState = "hidden"; document.dispatchEvent(new Event("visibilitychange"));
    source.emit("revision", { revision: 1 }); source.onerror?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).not.toHaveBeenCalled(); expect(source.closed).toBe(false);
    source.emit("revision", { version: 2, eventId: "revoked", revision: 1, accessChanged: true, scopes: [{ topic: "session" }] });
    expect(listener).toHaveBeenCalledOnce();
    document.visibilityState = "visible"; document.dispatchEvent(new Event("visibilitychange"));
    expect(listener).toHaveBeenLastCalledWith(null);
    await vi.advanceTimersByTimeAsync(30_000); expect(listener).toHaveBeenCalledTimes(3);
    source.onopen?.(); source.emit("revision", { revision: 2 });
    await vi.advanceTimersByTimeAsync(30_000); expect(listener).toHaveBeenCalledTimes(4);
    stop(); await vi.advanceTimersByTimeAsync(0);
    expect(source.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });

  it("多个页面订阅共用一条 EventSource", async () => {
    const { subscribeRealtimeEvent } = await import("../src/realtime");
    const onRevision = vi.fn();
    const onAnnouncement = vi.fn();

    const unsubscribeRevision = subscribeRealtimeEvent(
      "revision",
      onRevision
    );
    const unsubscribeAnnouncement = subscribeRealtimeEvent(
      "announcement",
      onAnnouncement
    );

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe("/api/v1/events");
    FakeEventSource.instances[0].emit("revision");
    expect(onRevision).toHaveBeenCalledOnce();
    expect(onAnnouncement).not.toHaveBeenCalled();

    unsubscribeRevision();
    vi.runAllTimers();
    expect(FakeEventSource.instances[0].closed).toBe(false);

    unsubscribeAnnouncement();
    vi.runAllTimers();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it("快速切换订阅不会关闭并重建连接", async () => {
    const { subscribeRealtimeEvent } = await import("../src/realtime");
    const unsubscribeFirst = subscribeRealtimeEvent("revision", vi.fn());
    const firstSource = FakeEventSource.instances[0];

    unsubscribeFirst();
    const unsubscribeSecond = subscribeRealtimeEvent("revision", vi.fn());
    vi.runAllTimers();

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(firstSource.closed).toBe(false);

    unsubscribeSecond();
    vi.runAllTimers();
  });

  it("向日历同步连接和断线状态", async () => {
    const { subscribeRealtimeConnection } = await import("../src/realtime");
    const states: string[] = [];
    const unsubscribe = subscribeRealtimeConnection((state) => {
      states.push(state);
    });
    const eventSource = FakeEventSource.instances[0];

    eventSource.onopen?.();
    eventSource.onerror?.();

    expect(states).toEqual(["CONNECTING", "CONNECTED", "DISCONNECTED"]);
    unsubscribe();
    vi.runAllTimers();
  });
});
