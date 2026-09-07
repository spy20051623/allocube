import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { withRequestDeadline } from "../../request-deadline";
import { useServerClock } from "../../ServerClock";
import { tr } from "../../i18n/index";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { api } from "../../api";
import { type RealtimeConnectionState, subscribeRealtimeConnection } from "../../realtime";
import type { TimelineReservation, UnavailabilityWindow, ResourceGroup } from "../../shared/types";
import { type TimelinePayload } from "./types";

export function useTimelineData({ range, notify, synchronizeServerClock }: { range: { from: string; to: string }; notify: (kind: "success" | "error", message: string) => void; synchronizeServerClock: ReturnType<typeof useServerClock>["synchronize"] }) {
  const [timeline, setTimeline] = useState<TimelinePayload | null>(null);

  const [initialLoading, setInitialLoading] = useState(true);

  const [refreshing, setRefreshing] = useState(false);

  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(
    "CONNECTING"
  );

  const requestIdRef = useRef(0);

  const requestControllerRef = useRef<AbortController | null>(null);

  const timelineRef = useRef<TimelinePayload | null>(null);

  const fetchTimeline = useCallback(async (signal: AbortSignal) => {
    const requestId = ++requestIdRef.current;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    signal.addEventListener("abort", () => controller.abort(), { once: true });
    if (timelineRef.current) setRefreshing(true);
    else if (!timelineRef.current) setInitialLoading(true);
    try {
      const requestStartedAt = performance.now();
      const query = new URLSearchParams({
        from: range.from,
        to: range.to
      });
      const result = await withRequestDeadline(readSignal => api<TimelinePayload>(`/timeline?${query}`, {
        signal: readSignal
      }), controller.signal);
      if (controller.signal.aborted || requestId !== requestIdRef.current) return;
      synchronizeServerClock(result.serverNow, requestStartedAt);
      timelineRef.current = result;
      setTimeline(result);
    } catch (error) {
      if (controller.signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("时间轴加载失败"));
    } finally {
      if (requestId === requestIdRef.current) {
        setInitialLoading(false);
        setRefreshing(false);
      }
    }
  }, [
    notify,
    range.from,
    range.to,
    synchronizeServerClock
  ]);

  const loadTimeline = useRealtimeRefresh(fetchTimeline, ["timeline"], {
    // The query covers all accessible machines, including ones created since its last response.
    // Server-side audience filtering already excludes machines this user cannot access.
    filter: () => ({ from: range.from, to: range.to })
  });

  useEffect(() => {
    void loadTimeline();
    return () => requestControllerRef.current?.abort();
  }, [loadTimeline]);

  useEffect(() => {
    return subscribeRealtimeConnection(setConnectionState);
  }, []);

  const reservationsByGroup = useMemo(() => {
    const map = new Map<string, TimelineReservation[]>();
    for (const item of timeline?.reservations ?? []) {
      if (item.scope === "MACHINE") continue;
      const bucket = map.get(item.resourceGroupId) ?? [];
      bucket.push(item);
      map.set(item.resourceGroupId, bucket);
    }
    return map;
  }, [timeline]);

  const machineReservationsByMachine = useMemo(() => {
    const map = new Map<string, TimelineReservation[]>();
    for (const item of timeline?.reservations ?? []) {
      if (item.scope !== "MACHINE") continue;
      const bucket = map.get(item.machineId) ?? [];
      bucket.push(item);
      map.set(item.machineId, bucket);
    }
    return map;
  }, [timeline]);

  const unavailabilityByGroup = useMemo(() => {
    const map = new Map<string, UnavailabilityWindow[]>();
    for (const item of timeline?.unavailability ?? []) {
      if (!item.resourceGroupId) continue;
      const bucket = map.get(item.resourceGroupId) ?? [];
      bucket.push(item);
      map.set(item.resourceGroupId, bucket);
    }
    return map;
  }, [timeline]);

  const machineUnavailability = useMemo(() => {
    const map = new Map<string, UnavailabilityWindow[]>();
    for (const item of timeline?.unavailability ?? []) {
      if (item.resourceGroupId) continue;
      const bucket = map.get(item.machineId) ?? [];
      bucket.push(item);
      map.set(item.machineId, bucket);
    }
    return map;
  }, [timeline]);

  const groupsByMachine = useMemo(() => {
    const map = new Map<string, Array<Omit<ResourceGroup, "version">>>();
    for (const group of timeline?.groups ?? []) {
      const list = map.get(group.machineId) ?? [];
      list.push(group);
      map.set(group.machineId, list);
    }
    return map;
  }, [timeline]);
  return {
    timeline,
    initialLoading,
    refreshing,
    connectionState,
    loadTimeline,
    reservationsByGroup,
    machineReservationsByMachine,
    unavailabilityByGroup,
    machineUnavailability,
    groupsByMachine
  };
}
