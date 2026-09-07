import { EditCancelled } from "../../edit-conflict";
import { Modal } from "../../Modal";
import { useServerClock } from "../../ServerClock";
import { tr } from "../../i18n/index";
import { type UnavailabilityImpactData, UnavailabilityImpactSummary } from "../../UnavailabilityImpactSummary";
import { Eye, CircleAlert } from "lucide-react";
import { useState, useEffect } from "react";
import { jsonBody, ApiError } from "../../api";
import { isoToChinaLocal, chinaLocalToIso } from "../../date";
import { currentMinuteStart } from "../../calendar-state";
import type { ResourceGroup } from "../../shared/types";
import { useConflictApi } from "../../app/useConflictApi";
import { initialReservationTime } from "../calendar/reservation-events";
import { ChoiceField, Field } from "../../components/forms";

type MaintenancePreview = UnavailabilityImpactData & {
  target: { version: number };
  startAt: string;
  endAt: string;
  revision: number;
};

export function MaintenanceModal({
  machine,
  groups,
  openingTime,
  onClose,
  onCompleted,
  notify
}: {
  machine: any;
  groups: ResourceGroup[];
  openingTime: number;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const { request: api, writing: mutationWriting } = useConflictApi();
  const { currentTime } = useServerClock();
  const [initial] = useState(() => initialReservationTime(openingTime));
  const [targetId, setTargetId] = useState("MACHINE");
  const [form, setForm] = useState({
    startAt: initial.start,
    endAt: initial.end,
    reason: ""
  });
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [startFocused, setStartFocused] = useState(false);
  const [timeRangeEdited, setTimeRangeEdited] = useState(false);
  const currentMinuteLocal = isoToChinaLocal(currentMinuteStart(currentTime));
  const timeRangeError =
    form.startAt && form.endAt && form.endAt <= form.startAt
      ? tr("结束时间必须晚于开始时间")
      : "";

  useEffect(() => {
    if (startFocused || mutationWriting.current) return;
    if (!timeRangeEdited) {
      const next = initialReservationTime(currentTime);
      if (form.startAt === next.start && form.endAt === next.end) return;
      setForm((current) => ({
        ...current,
        startAt: next.start,
        endAt: next.end
      }));
      setPreview(null);
      return;
    }
    if (!form.startAt || form.startAt > currentMinuteLocal) return;
    if (form.startAt === currentMinuteLocal) return;
    setForm((current) => ({ ...current, startAt: currentMinuteLocal }));
    setPreview(null);
  }, [
    currentMinuteLocal,
    currentTime,
    form.endAt,
    form.startAt,
    startFocused,
    timeRangeEdited
  ]);

  const updateForm = (
    field: "startAt" | "endAt" | "reason",
    value: string
  ) => {
    setForm((current) => ({ ...current, [field]: value }));
    setPreview(null);
  };

  const updateTimeField = (
    field: "startAt" | "endAt",
    value: string
  ) => {
    setTimeRangeEdited(true);
    updateForm(field, value);
  };

  const runPreview = async () => {
    if (timeRangeError) return;
    setPreviewing(true);
    try {
      const result = await api<MaintenancePreview>(
        `/admin/machines/${machine.id}/maintenance/preview`,
        {
          method: "POST",
          body: jsonBody({
            resourceGroupId: targetId === "MACHINE" ? null : targetId,
            startAt: chinaLocalToIso(form.startAt),
            endAt: chinaLocalToIso(form.endAt)
          })
        });
      setForm((current) => ({
        ...current,
        startAt: isoToChinaLocal(result.startAt),
        endAt: isoToChinaLocal(result.endAt)
      }));
      setPreview(result);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      setPreview(null);
      notify("error", error instanceof Error ? error.message : tr("维护影响加载失败"));
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      await api(`/admin/machines/${machine.id}/maintenance`, {
        method: "POST",
        body: jsonBody({
          resourceGroupId: targetId === "MACHINE" ? null : targetId,
          startAt: chinaLocalToIso(form.startAt),
          endAt: chinaLocalToIso(form.endAt),
          reason: form.reason,
          expectedRevision: preview.revision
        })
      });
      notify("success", tr("维护安排已创建"));
      await onCompleted();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) {
        setPreview(null);
      }
      notify(
        "error",
        error instanceof Error ? error.message : tr("创建维护失败")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={tr("安排维护：{{v0}}", { v0: machine.name })}
      onClose={onClose}
      wide
    >
      <fieldset disabled={submitting || previewing} className="editor-fieldset stack-form machine-disable-modal">
        <ChoiceField
          label={tr("维护范围")}
          value={targetId}
          options={[
            { value: "MACHINE", label: tr("整机") },
            ...groups
              .filter((group) => group.status === "ACTIVE")
              .map((group) => ({
                value: group.id,
                label: `${tr("资源组 ·")}${group.name}`
              }))
          ]}
          onChange={(value) => {
            setTargetId(value);
            setPreview(null);
          }}
        />
        <div className="machine-disable-time-grid">
          <Field label={tr("开始时间")}>
            <input
              type="datetime-local"
              value={form.startAt}
              onFocus={() => setStartFocused(true)}
              onChange={(event) =>
                updateTimeField("startAt", event.target.value)
              }
              onBlur={(event) => {
                setStartFocused(false);
                const value = event.currentTarget.value;
                if (value && value <= currentMinuteLocal) {
                  updateForm("startAt", currentMinuteLocal);
                }
              }}
            />
          </Field>
          <Field label={tr("结束时间")} error={timeRangeError}>
            <input
              type="datetime-local"
              value={form.endAt}
              aria-invalid={Boolean(timeRangeError)}
              onChange={(event) =>
                updateTimeField("endAt", event.target.value)
              }
            />
          </Field>
        </div>
        <Field label={tr("原因（选填）")}>
          <textarea
            value={form.reason}
            maxLength={1000}
            rows={3}
            onChange={(event) => updateForm("reason", event.target.value)}
          />
        </Field>
        {preview && <UnavailabilityImpactSummary impact={preview} />}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={previewing || submitting}
          >
            {tr("取消")}</button>
          <button
            type="button"
            className="secondary-button machine-disable-modal-action"
            onClick={() => void runPreview()}
            disabled={Boolean(timeRangeError) || previewing || submitting}
          >
            <Eye size={15} />{tr("查看影响")}</button>
          <button
            type="button"
            className="primary-button machine-disable-modal-action"
            onClick={() => void submit()}
            disabled={
              Boolean(timeRangeError) || !preview || previewing || submitting
            }
          >
            {tr("action.maintenance.create")}</button>
        </div>
      </fieldset>
    </Modal>
  );
}

export function MachineStopModal({
  machine,
  onClose,
  onCompleted,
  notify
}: {
  machine: any;
  onClose: () => void;
  onCompleted: () => Promise<void>;
  notify: (kind: "success" | "error", message: string) => void;
}) {
  const { request: api } = useConflictApi();
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<MaintenancePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const runPreview = async () => {
    setPreviewing(true);
    try {
      setPreview(
        await api<MaintenancePreview>(
          `/admin/machines/${machine.id}/disable/preview`,
          { method: "POST" }
        )
      );
    } catch (error) {
      if (error instanceof EditCancelled) return;
      setPreview(null);
      notify("error", error instanceof Error ? error.message : tr("停用影响加载失败"));
    } finally {
      setPreviewing(false);
    }
  };

  const submit = async () => {
    if (!preview) return;
    setSubmitting(true);
    try {
      await api(`/admin/machines/${machine.id}/disable`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: preview.target.version,
          expectedRevision: preview.revision,
          reason
        })
      });
      notify("success", tr("机器已停用"));
      await onCompleted();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (error instanceof ApiError && error.status === 409) setPreview(null);
      notify("error", error instanceof Error ? error.message : tr("停用机器失败"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title={tr("停用机器：{{v0}}", { v0: machine.name })} onClose={onClose} wide>
      <fieldset disabled={submitting || previewing} className="editor-fieldset stack-form machine-disable-modal">
        <div className="modal-note warning">
          <CircleAlert size={15} />
          <span>{tr("停用后将持续不可用，重新启用前不能创建新的占用。")}</span>
        </div>
        <Field label={tr("原因（选填）")}>
          <textarea
            value={reason}
            maxLength={1000}
            rows={3}
            onChange={(event) => {
              setReason(event.target.value);
              setPreview(null);
            }}
          />
        </Field>
        {preview && <UnavailabilityImpactSummary impact={preview} />}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={previewing || submitting}
          >
            {tr("取消")}</button>
          <button
            type="button"
            className="secondary-button machine-disable-modal-action"
            onClick={() => void runPreview()}
            disabled={previewing || submitting}
          >
            <Eye size={15} />{tr("查看影响")}</button>
          <button
            type="button"
            className="danger-button machine-disable-modal-action"
            onClick={() => void submit()}
            disabled={!preview || previewing || submitting}
          >
            {tr("确认停用")}</button>
        </div>
      </fieldset>
    </Modal>
  );
}
