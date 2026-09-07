import { canSyncDraft, EditCancelled } from "../../edit-conflict";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { CircleAlert } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { jsonBody } from "../../api";
import { resourceTagDraftIssue } from "../../resource-config-validation";
import { useConflictApi } from "../../app/useConflictApi";
import { Field } from "../../components/forms";
import { TagEditor } from "../../components/TagEditor";

export function MachineFormModal({
  machine,
  onClose,
  onSaved,
  notify
}: {
  machine?: any;
  onClose: () => void;
  onSaved: (machineId?: string) => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const { request: api, busy: mutationBusy } = useConflictApi();
  const [expectedVersion, setExpectedVersion] = useState<number | undefined>(machine?.version);
  const [form, setForm] = useState({
    name: machine?.name ?? "",
    address: machine?.address ?? "",
    hardwareNotes: machine?.hardwareNotes ?? "",
    connectionGuide: machine?.connectionGuide ?? "",
    managementNotes: machine?.managementNotes ?? "",
    tags: [...(machine?.tags ?? [])],
    tagInput: ""
  });
  const baseline = useRef(form);
  useEffect(() => {
    if (!machine || Number(machine.version) <= Number(expectedVersion) || !canSyncDraft(baseline.current, form, mutationBusy)) return;
    const next = {
      name: machine.name ?? "", address: machine.address ?? "", hardwareNotes: machine.hardwareNotes ?? "",
      connectionGuide: machine.connectionGuide ?? "", managementNotes: machine.managementNotes ?? "", tags: [...(machine.tags ?? [])], tagInput: ""
    };
    baseline.current = next; setForm(next); setExpectedVersion(machine.version);
  }, [machine, expectedVersion, form, mutationBusy]);
  const tagIssue = resourceTagDraftIssue(form.tags, form.tagInput);
  return (
    <Modal title={machine ? tr("编辑机器") : tr("新增机器")} onClose={onClose} wide>
      <fieldset disabled={mutationBusy} className="editor-fieldset stack-form machine-form">
        <div className="machine-form-primary">
          <Field label={tr("机器名称")}>
            <input
              autoFocus
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label={tr("连接地址")}>
            <input
              value={form.address}
              onChange={(event) => setForm({ ...form, address: event.target.value })}
              placeholder={tr("IP 或主机名")}
            />
          </Field>
        </div>
        <div className="field">
          <span>{tr("标签")}</span>
          <TagEditor
            tags={form.tags}
            input={form.tagInput}
            invalid={Boolean(tagIssue)}
            onChange={(tags, tagInput) =>
              setForm({ ...form, tags, tagInput })}
          />
          {tagIssue && (
            <span className="resource-tag-error" role="alert">
              <CircleAlert size={12} />
              {tagIssue}
            </span>
          )}
        </div>
        <div className="machine-form-public-notes">
          <Field label={tr("硬件说明（用户可见）")}>
            <textarea
              rows={4}
              value={form.hardwareNotes}
              onChange={(event) => setForm({ ...form, hardwareNotes: event.target.value })}
            />
          </Field>
          <Field label={tr("连接说明（用户可见）")}>
            <textarea
              rows={4}
              value={form.connectionGuide}
              onChange={(event) => setForm({ ...form, connectionGuide: event.target.value })}
            />
          </Field>
        </div>
        <label className="field machine-form-management">
          <span className="machine-form-label">
            <span>{tr("管理备注（仅管理员可见）")}</span>
            <small><CircleAlert size={12} />{tr("请勿填写密码或密钥")}</small>
          </span>
          <textarea
            rows={4}
            maxLength={5000}
            value={form.managementNotes}
            onChange={(event) => setForm({ ...form, managementNotes: event.target.value })}
          />
          <span className="field-counter">{form.managementNotes.length}/5000</span>
        </label>
        <div className="modal-actions machine-form-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {tr("取消")}</button>
          <button
            className="primary-button"
            disabled={Boolean(tagIssue) || mutationBusy}
            onClick={async () => {
              try {
                const { tagInput: _tagInput, ...formValues } = form;
                const body = {
                  ...formValues,
                  ...(machine ? { expectedVersion } : {}),
                  tags: form.tags
                };
                const result = await api<{ id?: string }>(
                  machine ? `/admin/machines/${machine.id}` : "/admin/machines",
                  {
                    method: machine ? "PATCH" : "POST",
                    body: jsonBody(body)
                  }
                );
                await onSaved(result.id ?? machine?.id);
              } catch (error) {
                if (error instanceof EditCancelled) return;
                notify("error", error instanceof Error ? error.message : tr("保存失败"));
              }
            }}>{machine ? tr("保存修改") : tr("action.machine.create")}</button>
        </div>
      </fieldset>
    </Modal>
  );
}
