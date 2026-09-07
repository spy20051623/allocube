import { useRealtimeRefresh } from "../useRealtimeRefresh";
import { withRequestDeadline } from "../request-deadline";
import { useState, useRef, useEffect, useCallback } from "react";
import { api, setCsrfToken, ApiError } from "../api";
import type { DashboardBootstrap } from "../shared/types";

export function useSession(docsRoute: boolean) {
  const [sessionReadError, setSessionReadError] = useState(false);
  const [bootstrap, setBootstrap] = useState<DashboardBootstrap | null>(null);
  const [loading, setLoading] = useState(true);
  const sessionRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRetryAttempt = useRef(0);
  const sessionGeneration = useRef(0);
  const [sessionRetryEpoch, setSessionRetryEpoch] = useState(0);
  useEffect(() => () => { if (sessionRetry.current) clearTimeout(sessionRetry.current); }, []);
  const fetchLoadSession = useCallback(async (signal: AbortSignal) => {
    if (sessionRetry.current) clearTimeout(sessionRetry.current);
    sessionRetry.current = null;
    const generation = sessionGeneration.current;
    try {
      const value = await withRequestDeadline(readSignal => api<DashboardBootstrap>("/auth/me", { signal: readSignal, cache: "no-store" }), signal);
      if (signal.aborted || generation !== sessionGeneration.current) return;
      if (!value?.user || typeof value.user.id !== "string" || typeof value.csrfToken !== "string") throw new Error("Invalid session response");
      setCsrfToken(value.csrfToken);
      setBootstrap(value);
      setLoading(false); setSessionReadError(false); sessionRetryAttempt.current = 0;
    } catch (error) {
      if (signal.aborted || generation !== sessionGeneration.current) return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) {
        setBootstrap(null); setLoading(false); setSessionReadError(false);
      } else {
        // A transport failure says nothing about authentication. Keep valid drafts;
        // an authority recheck keeps the protected UI hidden until it succeeds.
        setSessionReadError(true);
        const delay = [2000, 5000, 15000, 30000][Math.min(sessionRetryAttempt.current++, 3)];
        sessionRetry.current = setTimeout(() => setSessionRetryEpoch(value => value + 1), delay);
      }
    }
  }, []);
  const loadSession = useRealtimeRefresh(fetchLoadSession, ["session"], {
    enabled: !docsRoute && bootstrap?.user.status === "ACTIVE",
    onSecurity: change => {
      sessionGeneration.current++;
      if (sessionRetry.current) clearTimeout(sessionRetry.current);
      setCsrfToken("");
      if (change.sessionEnded) { setBootstrap(null); setLoading(false); }
      else setLoading(true);
    }
  });
  const acceptAuthenticatedSession = useCallback(
    async (value: DashboardBootstrap) => {
      sessionGeneration.current++;
      if (sessionRetry.current) clearTimeout(sessionRetry.current);
      setSessionReadError(false); sessionRetryAttempt.current = 0;
      setCsrfToken(value.csrfToken);
      setBootstrap(value);
      setLoading(false);
    },
    []
  );
  useEffect(() => {
    if (docsRoute) {
      setLoading(false);
      return;
    }
    void loadSession();
  }, [docsRoute, loadSession, sessionRetryEpoch]);
  useEffect(() => {
    if (
      docsRoute ||
      !bootstrap ||
      bootstrap.user.status === "ACTIVE"
    ) {
      return;
    }
    const refresh = window.setInterval(() => { if (document.visibilityState !== "hidden") void loadSession(); }, 30_000);
    return () => window.clearInterval(refresh);
  }, [bootstrap?.user.id, bootstrap?.user.status, docsRoute, loadSession]);
  return { bootstrap, setBootstrap, loading, sessionReadError, loadSession, acceptAuthenticatedSession };
}
