import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { createServerClockAnchor, serverTimeFromAnchor } from "./calendar-state";

type ServerClockContextValue = {
  currentTime: number;
  ready: boolean;
  synchronize: (
    serverNow: string,
    requestStartedAt: number,
    responseReceivedAt?: number
  ) => void;
};

const ServerClockContext = createContext<ServerClockContextValue | null>(null);

export function useServerClock() {
  const value = useContext(ServerClockContext);
  if (!value) throw new Error("ServerClockProvider is missing");
  return value;
}

export function ServerClockProvider({
  initialServerNow,
  children
}: {
  initialServerNow: string;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<ReturnType<typeof createServerClockAnchor>>(null);
  const initialMonotonicTime = performance.now();
  if (!anchorRef.current) {
    anchorRef.current = createServerClockAnchor(
      initialServerNow,
      initialMonotonicTime,
      initialMonotonicTime
    );
  }
  const [currentTime, setCurrentTime] = useState(
    () =>
      anchorRef.current
        ? serverTimeFromAnchor(anchorRef.current, performance.now())
        : 0
  );
  const [ready, setReady] = useState(Boolean(anchorRef.current));

  const synchronize = useCallback(
    (
      serverNow: string,
      requestStartedAt: number,
      responseReceivedAt = performance.now()
    ) => {
      const anchor = createServerClockAnchor(
        serverNow,
        requestStartedAt,
        responseReceivedAt
      );
      if (!anchor) return;
      anchorRef.current = anchor;
      setCurrentTime(serverTimeFromAnchor(anchor, responseReceivedAt));
      setReady(true);
    },
    []
  );

  useEffect(() => {
    const receivedAt = performance.now();
    synchronize(initialServerNow, receivedAt, receivedAt);
  }, [initialServerNow, synchronize]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const anchor = anchorRef.current;
      if (anchor) {
        setCurrentTime(serverTimeFromAnchor(anchor, performance.now()));
      }
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    const requestStartedAt = performance.now();
    try {
      const result = await api<{ serverNow: string }>("/server-time");
      synchronize(result.serverNow, requestStartedAt);
    } catch {
      // 保留现有服务器时间基准继续计时，等待下一次校准。
    }
  }, [synchronize]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), 5 * 60_000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  const value = useMemo(
    () => ({ currentTime, ready, synchronize }),
    [currentTime, ready, synchronize]
  );

  return (
    <ServerClockContext.Provider value={value}>
      {children}
    </ServerClockContext.Provider>
  );
}
