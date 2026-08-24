import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeListener = () => void;

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

  emit(eventName: string) {
    for (const listener of this.listeners.get(eventName) ?? []) listener();
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
