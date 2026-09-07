import { withRequestDeadline } from "./request-deadline";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AuditRequestSequence } from "./audit-state";
import type { AuditDetail, AuditFilters, AuditOptions, AuditPage } from "./shared/audit";

export function useAuditRecords(initialFilters: AuditFilters = {}) {
  const initial = useRef(initialFilters);
  const [data, setData] = useState<AuditPage | null>(null);
  const [options, setOptions] = useState<AuditOptions>({ actors: [], actions: [] });
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState("");
  const sequence = useRef(new AuditRequestSequence()), optionSequence = useRef(new AuditRequestSequence());
  const filters = useRef<AuditFilters>({}), cursors = useRef<(string | undefined)[]>([undefined]);
  const lastAttempt = useRef<{ filters: AuditFilters; cursor?: string; reset: boolean }>({ filters: {}, reset: true });
  const load = useCallback(async (nextFilters: AuditFilters, cursor?: string, reset = false) => {
    const task = sequence.current.begin();
    lastAttempt.current = { filters: nextFilters, cursor, reset };
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams(nextFilters);
      if (cursor) params.set("cursor", cursor);
      const result = await withRequestDeadline(signal => api<AuditPage>(`/admin/audit?${params}`, { signal }), task.signal);
      if (!task.current()) return false;
      if (reset) cursors.current = [undefined];
      cursors.current[result.page - 1] = result.cursor;
      if (result.nextCursor) cursors.current[result.page] = result.nextCursor;
      filters.current = nextFilters; setData(result);
      return true;
    } catch (e) {
      if (task.current()) {
        if (e instanceof ApiError && [401,403].includes(e.status)) { setData(null); setOptions({ actors: [], actions: [] }); }
        setError(e instanceof Error ? e.message : "请求失败");
      }
      return false;
    } finally { if (task.current()) setLoading(false); }
  }, []);
  const loadOptions = useCallback(async () => {
    const task = optionSequence.current.begin(); setOptionsError("");
    try {
      const result = await withRequestDeadline(signal => api<AuditOptions>("/admin/audit/options", { signal }), task.signal);
      if (task.current()) setOptions(result);
    } catch (e) { if (task.current()) setOptionsError(e instanceof Error ? e.message : "请求失败"); }
  }, []);
  useEffect(() => {
    void load(initial.current, undefined, true); void loadOptions();
    return () => { sequence.current.cancel(); optionSequence.current.cancel(); };
  }, [load, loadOptions]);
  return { data, options, loading, error, optionsError, loadOptions,
    query: (next: AuditFilters) => { void loadOptions(); return load(next, undefined, true); },
    retry: () => load(lastAttempt.current.filters, lastAttempt.current.cursor, lastAttempt.current.reset),
    go: (page: number) => load(filters.current, cursors.current[page - 1]) };
}

export function useAuditDetail(id: string) {
  const [data, setData] = useState<AuditDetail | null>(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const sequence = useRef(new AuditRequestSequence());
  const load = useCallback(async () => {
    const task = sequence.current.begin(); setLoading(true); setError(""); setData(null);
    try {
      const result = await withRequestDeadline(signal => api<AuditDetail>(`/admin/audit/${encodeURIComponent(id)}`, { signal }), task.signal);
      if (task.current()) setData(result);
    } catch (e) { if (task.current()) setError(e instanceof Error ? e.message : "请求失败"); }
    finally { if (task.current()) setLoading(false); }
  }, [id]);
  useEffect(() => { void load(); return () => sequence.current.cancel(); }, [load]);
  return { data, error, loading, retry: load };
}
