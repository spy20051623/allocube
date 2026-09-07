import { addDays, chinaLocalToIso } from "./date";
import type { AuditFilters } from "./shared/audit";

export type AuditDraft = { fromDate: string; toDate: string; actor: string; action: string; source: string };
export const emptyAuditDraft: AuditDraft = { fromDate: "", toDate: "", actor: "", action: "", source: "" };
export function auditFilters(draft: AuditDraft): AuditFilters {
  for (const date of [draft.fromDate, draft.toDate]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date)) throw new Error("日期范围无效");
  }
  const from = draft.fromDate ? chinaLocalToIso(`${draft.fromDate}T00:00`) : undefined;
  const to = draft.toDate ? chinaLocalToIso(`${addDays(draft.toDate, 1)}T00:00`) : undefined;
  if ((draft.fromDate && !from) || (draft.toDate && !to) || (from && to && from >= to)) throw new Error("日期范围无效");
  return { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(draft.actor ? { actor: draft.actor } : {}),
    ...(draft.action ? { action: draft.action } : {}), ...(draft.source === "API" || draft.source === "OTHER" ? { source: draft.source } : {}) };
}

/** Aborts superseded work and also guards against transports that deliver after abort. */
export class AuditRequestSequence {
  private sequence = 0;
  private controller?: AbortController;
  begin() {
    this.cancel();
    const number = this.sequence;
    const controller = this.controller = new AbortController();
    return { signal: controller.signal, current: () => number === this.sequence && !controller.signal.aborted };
  }
  cancel() { this.sequence++; this.controller?.abort(); }
}
