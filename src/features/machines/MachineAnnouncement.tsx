import { Megaphone, Pencil } from "lucide-react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../../Modal";
import { SectionHeader } from "../../components/SectionHeader";
import { Field } from "../../components/forms";
import { useConflictApi } from "../../app/useConflictApi";
import { EditCancelled } from "../../edit-conflict";
import { jsonBody } from "../../api";
import { tr } from "../../i18n/index";
import { MACHINE_ANNOUNCEMENT_MAX_LENGTH, normalizeMachineAnnouncement } from "../../shared/machine-announcement";

type AnnouncementMachine = { id: string; name: string; announcement: string };
type Notify = (kind: "success" | "error", message: string) => void;

export function MachineAnnouncementRow({ machine, onOpen }: { machine: AnnouncementMachine; onOpen: () => void }) {
  if (!machine.announcement) return null;
  const firstLine = machine.announcement.split("\n", 1)[0];
  return (
    <div className="machine-announcement-row">
      <button type="button" className="machine-announcement-link" onClick={onOpen}
        aria-label={tr("查看 {{name}} 的机器公告：{{content}}", { name: machine.name, content: machine.announcement })}>
        <Megaphone size={14} aria-hidden="true" />
        <span>{firstLine}{firstLine.length < machine.announcement.length ? "…" : ""}</span>
      </button>
    </div>
  );
}

export function MachineAnnouncementViewer({ machine, onClose }: { machine: AnnouncementMachine; onClose: () => void }) {
  return createPortal(
    <Modal title={`${machine.name} · ${tr("机器公告")}`} onClose={onClose}>
      <p className="machine-announcement-body">{machine.announcement}</p>
    </Modal>, document.body
  );
}

function MachineAnnouncementEditor({ machine, onClose, onSaved, notify }: {
  machine: AnnouncementMachine & { version: number };
  onClose: () => void;
  onSaved: () => Promise<void>;
  notify: Notify;
}) {
  const { request, busy, writing } = useConflictApi();
  const [announcement, setAnnouncement] = useState(machine.announcement);
  const [expectedVersion] = useState(machine.version);
  const normalized = normalizeMachineAnnouncement(announcement);
  const tooLong = normalized.length > MACHINE_ANNOUNCEMENT_MAX_LENGTH;
  const close = () => { if (!writing.current) onClose(); };
  return (
    <Modal title={tr("编辑机器公告")} onClose={close} wide>
      <form onSubmit={async event => {
        event.preventDefault();
        if (tooLong || writing.current) return;
        try {
          await request(`/admin/machines/${machine.id}/announcement`, {
            method: "PUT", body: jsonBody({ announcement: normalized, expectedVersion })
          });
          notify("success", tr("机器公告已保存"));
          await onSaved();
        } catch (error) {
          if (error instanceof EditCancelled) return;
          notify("error", error instanceof Error ? error.message : tr("保存失败"));
        }
      }}>
        <fieldset disabled={busy} className="editor-fieldset stack-form">
          <Field label={tr("机器公告")}>
            <textarea name="machineAnnouncement" rows={10} autoFocus value={announcement} maxLength={MACHINE_ANNOUNCEMENT_MAX_LENGTH}
              aria-invalid={tooLong} onChange={event => setAnnouncement(event.target.value)} />
          </Field>
          <span className="field-counter">{normalized.length}/{MACHINE_ANNOUNCEMENT_MAX_LENGTH}</span>
          {tooLong && <p role="alert">{tr("公告不能超过 {{count}} 个字符", { count: MACHINE_ANNOUNCEMENT_MAX_LENGTH })}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={close}>{tr("取消")}</button>
            <button type="submit" className="primary-button" disabled={busy || tooLong}>{tr("保存修改")}</button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

export function MachineAnnouncementSection({ machine, canManage, onSaved, notify }: {
  machine: AnnouncementMachine & { version?: number };
  canManage: boolean;
  onSaved: () => Promise<void>;
  notify: Notify;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="card panel-card machine-announcement-section">
      <SectionHeader title={tr("机器公告")} actions={canManage ? (
        <button type="button" className="secondary-button compact" onClick={() => setEditing(true)}>
          <Pencil size={14} />{tr("编辑")}
        </button>
      ) : undefined} />
      <div className={`machine-announcement-preview${machine.announcement ? "" : " empty"}`}>
        <span className="machine-announcement-symbol"><Megaphone size={18} aria-hidden="true" /></span>
        <p className="machine-announcement-body">{machine.announcement || tr("暂无机器公告")}</p>
      </div>
      {editing && canManage && machine.version !== undefined && (
        <MachineAnnouncementEditor machine={{ ...machine, version: machine.version }} notify={notify}
          onClose={() => setEditing(false)} onSaved={async () => { setEditing(false); await onSaved(); }} />
      )}
    </section>
  );
}
