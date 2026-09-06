import { useCallback, useEffect, useMemo, useRef } from "react";
import { RefreshQueue } from "./refresh-queue";
import { subscribeRealtimeEvent } from "./realtime";
import { affectsRealtime, type RealtimeChange, type RealtimeTopic } from "./shared/realtime";

export function useRealtimeRefresh<T>(loader: (signal: AbortSignal) => Promise<T>, topics: RealtimeTopic[], options: {
  enabled?: boolean;
  filter?: () => { machineId?: string; machineIds?: string[]; from?: string; to?: string };
  onSecurity?: (change: RealtimeChange) => void;
} = {}) {
  const latest = useRef({ topics, options }); latest.current = { topics, options };
  const queue = useMemo(() => new RefreshQueue(loader), [loader]);
  const refresh = useCallback(() => queue.request([]), [queue]);
  const enabled = options.enabled !== false;
  useEffect(() => {
    queue.activate();
    const onVisible = () => queue.resume();
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); queue.dispose(); };
  }, [queue]);
  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = subscribeRealtimeEvent("revision", change => {
      const { topics, options } = latest.current;
      if (options.enabled === false) return;
      if (change?.accessChanged || change?.sessionEnded) options.onSecurity?.(change);
      if (change?.sessionEnded) { queue.abort(); return; }
      const urgent = Boolean(change?.accessChanged && topics.includes("session"));
      if (!urgent && !topics.some(topic => affectsRealtime(change, topic, options.filter?.()))) return;
      if (urgent) queue.abort();
      void queue.request([], urgent);
    });
    return unsubscribe;
  }, [queue, enabled]);
  return refresh;
}
