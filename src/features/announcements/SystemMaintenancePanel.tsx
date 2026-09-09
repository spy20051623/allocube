import { Pencil } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, jsonBody } from "../../api";
import { useConflictApi } from "../../app/useConflictApi";
import { SectionHeader } from "../../components/SectionHeader";
import { Field } from "../../components/forms";
import { EditCancelled } from "../../edit-conflict";
import { tr } from "../../i18n";
import { Modal } from "../../Modal";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { SYSTEM_MAINTENANCE_MAX_LENGTH, normalizeSystemMaintenanceText, type SystemMaintenanceNotice } from "../../shared/system-maintenance";

type Notify = (kind: "success" | "error", message: string) => void;

export function SystemMaintenancePanel({ notify }: { notify: Notify }) {
  const [notice, setNotice] = useState<SystemMaintenanceNotice | null>(null);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const fetchNotice = useCallback(async (signal: AbortSignal) => {
    try {
      const value = await api<SystemMaintenanceNotice>("/admin/system-maintenance", { signal });
      if (!signal.aborted) { setNotice(value); setError(false); }
    } catch { if (!signal.aborted) setError(true); }
  }, []);
  const reload = useRealtimeRefresh(fetchNotice, ["settings"]);
  useEffect(() => { void reload(); }, [reload]);
  return <section className="card panel-card system-maintenance-panel">
    <SectionHeader title={tr("系统维护")} actions={notice && !error ? (
      <button type="button" className="secondary-button compact" onClick={() => setEditing(true)}>
        <Pencil size={14} />{tr("编辑")}
      </button>
    ) : undefined} />
    {error ? <div className="system-maintenance-load-error" role="alert">
      {tr("维护提示加载失败")}
      <button type="button" className="secondary-button compact" onClick={() => void reload()}>{tr("重试")}</button>
    </div> : <p className={`system-maintenance-preview${notice?.text ? "" : " empty"}`}>
      {notice ? notice.text || tr("暂无系统维护提示") : tr("加载中…")}
    </p>}
    {editing && notice && <SystemMaintenanceEditor notice={notice} notify={notify} onClose={() => setEditing(false)}
      onSaved={async () => { setEditing(false); await reload(); }} />}
  </section>;
}

function SystemMaintenanceEditor({ notice, notify, onClose, onSaved }: {
  notice: SystemMaintenanceNotice; notify: Notify; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { request, busy, writing } = useConflictApi();
  const [text, setText] = useState(notice.text);
  const [expectedVersion] = useState(notice.version);
  const normalized = normalizeSystemMaintenanceText(text);
  const tooLong = normalized.length > SYSTEM_MAINTENANCE_MAX_LENGTH;
  const close = () => { if (!writing.current) onClose(); };
  return <Modal title={tr("编辑系统维护提示")} onClose={close}>
    <form onSubmit={async event => {
      event.preventDefault();
      if (writing.current || tooLong) return;
      try {
        await request("/admin/system-maintenance", { method: "PUT", body: jsonBody({ text: normalized, expectedVersion }) });
        notify("success", tr("系统维护提示已更新"));
        await onSaved();
      } catch (error) {
        if (!(error instanceof EditCancelled)) notify("error", error instanceof Error ? error.message : tr("保存失败"));
      }
    }}>
      <fieldset className="editor-fieldset stack-form" disabled={busy}>
        <Field label={tr("提示内容")}>
          <input name="systemMaintenanceText" autoFocus value={text} maxLength={SYSTEM_MAINTENANCE_MAX_LENGTH}
            onChange={event => setText(event.target.value)} aria-invalid={tooLong}
            onPaste={event => {
              event.preventDefault();
              const input = event.currentTarget;
              setText(normalizeSystemMaintenanceText(text.slice(0, input.selectionStart ?? 0) + event.clipboardData.getData("text") + text.slice(input.selectionEnd ?? text.length)));
            }} />
        </Field>
        <span className="field-counter">{normalized.length}/{SYSTEM_MAINTENANCE_MAX_LENGTH}</span>
        {tooLong && <p role="alert">{tr("维护提示不能超过 120 字")}</p>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={close}>{tr("取消")}</button>
          <button type="submit" className="primary-button" disabled={busy || tooLong}>{tr("保存修改")}</button>
        </div>
      </fieldset>
    </form>
  </Modal>;
}
