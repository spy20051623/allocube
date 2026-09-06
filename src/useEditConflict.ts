import { withRequestDeadline } from "./request-deadline";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { claimEdit, confirmedEdit, editWithRetainedReason, markEditUncertain, EditCancelled, EditOutcomeUnknown } from "./edit-conflict";
import { tr } from "./i18n";

export function useEditConflict(confirm: (impactChanged: boolean, signal: AbortSignal) => Promise<boolean>,
  resumeReason?: (options: RequestInit, signal: AbortSignal) => Promise<RequestInit | null>) {
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const resumeRef = useRef(resumeReason);
  resumeRef.current = resumeReason;
  const controller = useRef(new AbortController());
  const writing = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
  const request: typeof api = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    if (["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase()) || path.endsWith("/preview")) return withRequestDeadline(signal => api<T>(path, { ...options, signal }), options.signal ?? undefined);
    if (writing.current || controller.current.signal.aborted) throw new EditCancelled();
    const signal = controller.current.signal;
    let release: (() => unknown) | undefined;
    try {
      release = claimEdit(path);
      writing.current = true; setBusy(true);
      return await editWithRetainedReason(options,
        draft => confirmedEdit<T>(path, draft, impact => confirmRef.current(impact, signal), signal),
        draft => signal.aborted ? Promise.resolve(null) : resumeRef.current?.(draft, signal) ?? Promise.resolve(null));
    } catch (error) {
      if (error instanceof EditOutcomeUnknown) {
        markEditUncertain(path);
        throw new Error(tr("上次操作的结果尚未确认。请手动刷新页面核对后再操作。"));
      }
      throw error;
    } finally {
      writing.current = false;
      release?.();
      if (!signal.aborted) setBusy(false);
    }
  }, []);
  return { request, busy, writing };
}
