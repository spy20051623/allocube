import { useState } from "react";
import { addDays } from "../../date";
import { Modal } from "../../Modal";
import { Field } from "../../components/forms";
import { api, jsonBody } from "../../api";
import { tr } from "../../i18n/index";
import { AccessExpiryField, accessExpiryValue, accessExpiryLabel, defaultAccessExpiryInput, accessExpiryInput } from "./AccessExpiryField";

export type MachineAccessRequestTarget = { id: string; name: string; hasAccess: boolean; expiresAt: string | null };

export function MachineAccessRequestModal({ machine, notify, onClose, onSubmitted }: {
  machine: MachineAccessRequestTarget;
  notify: (kind: "success" | "error", message: string) => void;
  onClose: () => void;
  onSubmitted: () => void | Promise<unknown>;
}) {
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState(() => machine.hasAccess && machine.expiresAt ? addDays(accessExpiryInput(machine.expiresAt), 30) : defaultAccessExpiryInput());
  const [busy, setBusy] = useState(false);
  return (
        <Modal title={machine.hasAccess ? tr("申请延长 {{v0}} 的使用期限", { v0: machine.name }) : tr("申请使用 {{v0}}", { v0: machine.name })} className="machine-access-modal" onClose={() => onClose()}>
          <div className="stack-form">
            {machine.hasAccess && machine.expiresAt && <small className="catalog-access-expiry">{tr("当前到期日期")}：{accessExpiryLabel(machine.expiresAt)}</small>}
            <AccessExpiryField label={machine.hasAccess ? tr("延期至") : tr("申请使用至")} value={expiry} onChange={setExpiry}
              presetBaseDate={machine.hasAccess && machine.expiresAt ? accessExpiryInput(machine.expiresAt) : undefined} />
            <Field label={tr("申请理由（选填）")}>
              <textarea
                rows={3}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            {reason.length > 0 && <div className="field-counter">{reason.length}/500</div>}
            <div className="modal-actions">
            <button type="button" className="secondary-button" disabled={busy} onClick={() => onClose()}>{tr("取消")}</button>
            <button
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const expiresAt = accessExpiryValue(expiry, false);
                  if (machine.hasAccess && machine.expiresAt && expiresAt && Date.parse(expiresAt) <= Date.parse(machine.expiresAt)) {
                    throw new Error(tr("延期日期必须晚于当前到期日期"));
                  }
                  await api(`/machines/${machine.id}/access-requests`, {
                    method: "POST",
                    body: jsonBody({ reason, expiresAt })
                  });
                  notify("success", machine.hasAccess ? tr("延期申请已提交") : tr("使用权申请已提交"));
                  onClose();
                  await onSubmitted();
                } catch (error) {
                  notify(
                    "error",
                    error instanceof Error ? error.message : tr("申请提交失败")
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {tr("提交申请")}</button>
            </div>
          </div>
        </Modal>
  );
}
