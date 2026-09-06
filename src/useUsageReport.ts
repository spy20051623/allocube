import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, jsonBody } from "./api";
import { tr } from "./i18n";
import type { ReportJob, UsageReport } from "./shared/reports";

export function useUsageReport(fromDate: string, toDate: string, machineId: string, isSystemAdmin: boolean,
  notify: (kind: "success" | "error", message: string) => void) {
  const [report, setReport] = useState<UsageReport | null>(null);
  const [job, setJob] = useState<ReportJob | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [statusKnown, setStatusKnown] = useState(false);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0), jobSequence = useRef(0);
  const currentJob = useRef<ReportJob | null>(null);
  const mounted = useRef(true);
  const locked = useRef(false);
  const query = new URLSearchParams({ fromDate, toDate, ...(machineId ? { machineId } : {}) }).toString();
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const serial = ++sequence.current;
    setLoading(true);
    try {
      const result = await api<UsageReport>(`/admin/report?${query}`, { signal: controller.signal });
      if (mounted.current && serial === sequence.current) setReport(result);
    } catch (error) {
      if (!controller.signal.aborted && mounted.current && serial === sequence.current) notify("error", error instanceof Error ? error.message : tr("统计加载失败"));
    } finally {
      if (mounted.current && serial === sequence.current) setLoading(false);
    }
  }, [query, notify]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => { setReport(null); void load(); }, [load]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); jobSequence.current++; };
  }, []);

  const checkJob = useCallback(async () => {
    const serial = ++jobSequence.current;
    const result = await api<{ job: ReportJob | null }>("/admin/report/rebuild");
    if (!mounted.current || serial !== jobSequence.current) return result.job;
    const previous = currentJob.current;
    currentJob.current = result.job; setJob(result.job); setStatusKnown(true);
    if (previous?.id === result.job?.id && previous?.status !== result.job?.status) {
      if (result.job?.status === "SUCCEEDED") { notify("success", tr("全部重新统计完成")); void loadRef.current(); }
      if (result.job?.status === "FAILED") notify("error", tr("重新统计失败，原统计结果仍可使用"));
    }
    return result.job;
  }, [notify]);
  useEffect(() => {
    if (!isSystemAdmin) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await checkJob(); } catch { if (!cancelled) setStatusKnown(false); }
      if (!cancelled) timer = setTimeout(() => void poll(), 5000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); jobSequence.current++; };
  }, [isSystemAdmin, checkJob]);

  const rebuild = async () => {
    if (locked.current) return;
    const previousJobId = currentJob.current?.id;
    locked.current = true; setSubmitting(true);
    jobSequence.current++;
    try {
      await api<{ job: ReportJob }>("/admin/report/rebuild", { method: "POST", body: jsonBody({}) });
      const latest = await checkJob();
      if (latest?.status === "SUCCEEDED") void loadRef.current();
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) notify("error", error.message);
      else {
        try {
          const latest = await checkJob();
          if (latest?.id !== previousJobId && latest?.status === "SUCCEEDED") {
            notify("success", tr("全部重新统计完成")); void loadRef.current();
          } else if (latest?.id !== previousJobId && latest?.status === "FAILED") {
            notify("error", tr("重新统计失败，原统计结果仍可使用"));
          } else if (!latest || !["QUEUED", "RUNNING"].includes(latest.status)) notify("error", tr("提交结果未确认，请核对任务状态后再操作"));
        } catch { setStatusKnown(false); notify("error", tr("提交结果未确认，请核对任务状态后再操作")); }
      }
    } finally {
      locked.current = false; if (mounted.current) setSubmitting(false);
    }
  };
  return { report, job, loading, submitting, statusKnown, load, rebuild };
}
