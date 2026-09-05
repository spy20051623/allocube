import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { useServerClock } from "./ServerClock";
import { subscribeRealtimeConnection, subscribeRealtimeEvent } from "./realtime";
import { ReservationRequestGate } from "./my-reservations-state";
import type { OwnReservationPage } from "./shared/my-reservations";

export function useReservationRefresh(nextBoundary?: string | null) {
  const [epoch, setEpoch] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { currentTime } = useServerClock();
  const clock = useRef(currentTime);
  clock.current = currentTime;
  const refresh = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => { timer.current = null; setEpoch((v) => v + 1); }, 200);
  }, []);
  useEffect(() => {
    let disconnected = false;
    const unsubscribe = subscribeRealtimeEvent("revision", refresh);
    const connection = subscribeRealtimeConnection((state) => {
      disconnected = state !== "CONNECTED";
      if (state === "CONNECTED") refresh();
    });
    const interval = setInterval(() => { if (disconnected) refresh(); }, 30_000);
    const onVisibility = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      unsubscribe(); connection(); clearInterval(interval);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);
  useEffect(() => {
    if (!nextBoundary) return;
    const wait = Math.min(86_400_000, Math.max(0, Date.parse(nextBoundary) - clock.current + 100));
    const timeout = setTimeout(refresh, wait);
    return () => clearTimeout(timeout);
  }, [nextBoundary, epoch, refresh]);
  return { epoch, refresh };
}

export function useReservationPage(query: string | null, epoch: number, enabled = true) {
  const key = String(query);
  const [pagination, setPagination] = useState<{ key: string; cursors: Array<string | null> }>({ key, cursors: [null] });
  const cursors = pagination.key === key ? pagination.cursors : [null];
  const cursor = cursors.at(-1) ?? null;
  const [result, setResult] = useState<{ query: string; data: OwnReservationPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  const gate = useRef(new ReservationRequestGate());
  const { synchronize } = useServerClock();
  useEffect(() => {
    setPagination((previous) => previous.key === key ? previous : { key, cursors: [null] });
  }, [key]);
  useEffect(() => {
    if (!enabled || query === null) return;
    const request = gate.current.start();
    const started = performance.now();
    setLoading(true); setError(null);
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    void api<OwnReservationPage>(`/reservations/mine?${params}`, { signal: request.signal })
      .then((data) => {
        if (!request.current()) return;
        synchronize(data.serverNow, started);
        setResult({ query, data });
      }).catch((err: unknown) => {
        if (!request.current()) return;
        if (err instanceof ApiError && ["STALE_CURSOR", "INVALID_CURSOR"].includes(err.code ?? "") && cursor) {
          setPagination({ key, cursors: [null] });
        } else setError(err instanceof Error ? err : new Error(String(err)));
      }).finally(() => { if (request.current()) setLoading(false); });
    return () => gate.current.cancel();
  }, [query, key, cursor, enabled, epoch, retry, synchronize]);
  const data = result?.query === query ? result.data : null;
  return {
    data, loading, error, page: cursors.length,
    previous: () => setPagination({ key, cursors: cursors.slice(0, -1) }),
    next: () => { if (data?.nextCursor) setPagination({ key, cursors: [...cursors, data.nextCursor] }); },
    retry: () => setRetry((v) => v + 1)
  };
}

// The overview has no page controls: collect every server page into one snapshot.
// Keep the previous snapshot visible until a refresh has completely succeeded.
export async function loadAllReservationPages(
  fetchPage: (cursor: string | null) => Promise<OwnReservationPage>,
  signal: AbortSignal
): Promise<OwnReservationPage> {
  for (let attempt = 0; ; attempt++) {
    const records = new Map<string, OwnReservationPage["reservations"][number]>();
    let cursor: string | null = null;
    try {
      do {
        signal.throwIfAborted();
        const page = await fetchPage(cursor);
        signal.throwIfAborted();
        for (const item of page.reservations) records.set(item.id, item);
        cursor = page.nextCursor;
        if (!cursor) return { ...page, reservations: [...records.values()] };
      } while (cursor);
    } catch (error) {
      if (attempt === 0 && error instanceof ApiError && error.code === "STALE_CURSOR" && !signal.aborted) continue;
      throw error;
    }
  }
}

export function useAllReservations(query: string, epoch: number) {
  const [result, setResult] = useState<{ query: string; data: OwnReservationPage } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  const { synchronize } = useServerClock();
  const gate = useRef(new ReservationRequestGate());
  useEffect(() => {
    const request = gate.current.start();
    setLoading(true); setError(null);
    void loadAllReservationPages(async (cursor) => {
      const params = new URLSearchParams(query);
      params.set("limit", "100");
      if (cursor) params.set("cursor", cursor);
      const started = performance.now();
      const page = await api<OwnReservationPage>(`/reservations/mine?${params}`, { signal: request.signal });
      if (request.current()) synchronize(page.serverNow, started);
      return page;
    }, request.signal).then((page) => {
      if (request.current()) setResult({ query, data: page });
    }).catch((err: unknown) => {
      if (request.current()) setError(err instanceof Error ? err : new Error(String(err)));
    }).finally(() => { if (request.current()) setLoading(false); });
    return () => gate.current.cancel();
  }, [epoch, query, retry, synchronize]);
  return { data: result?.query === query ? result.data : null, loading, error, retry: () => setRetry((v) => v + 1) };
}
