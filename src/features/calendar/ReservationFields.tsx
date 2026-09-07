import { tr } from "../../i18n/index";
import { type CalendarMetadata } from "../../calendar-state";
import type { Machine } from "../../shared/types";
import { ChoiceField, Field } from "../../components/forms";

export function CalendarTargetFields({
  machines,
  machineId,
  resourceOptions,
  resourceId,
  onMachineChange,
  onResourceChange
}: {
  machines: Machine[];
  machineId: string;
  resourceOptions: Array<{ id: string; label: string }>;
  resourceId: string;
  onMachineChange: (machineId: string) => void;
  onResourceChange: (resourceId: string) => void;
}) {
  return (
    <>
      <ChoiceField
        label={tr("机器")}
        value={machineId}
        options={machines.map((machine) => ({ value: machine.id, label: machine.name }))}
        onChange={onMachineChange}
      />
      <ChoiceField
        label={tr("资源组")}
        value={resourceId}
        disabled={!machineId}
        options={resourceOptions.map((option) => ({ value: option.id, label: option.label }))}
        onChange={onResourceChange}
      />
    </>
  );
}

export function CalendarReservationTimeFields({
  startValue,
  endValue,
  fieldKey,
  readOnly = false,
  className = "calendar-reservation-time-fields",
  onStartBlur,
  onEndBlur,
  onFocusCapture,
  onBlurCapture,
  startError,
  endError
}: {
  startValue: string;
  endValue: string;
  fieldKey: string;
  readOnly?: boolean;
  className?: string;
  onStartBlur?: (value: string) => void;
  onEndBlur?: (value: string) => void;
  onFocusCapture?: React.FocusEventHandler<HTMLDivElement>;
  onBlurCapture?: React.FocusEventHandler<HTMLDivElement>;
  startError?: string;
  endError?: string;
}) {
  return (
    <div
      className={className}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <Field label={tr("开始时间")} error={startError}>
        <input
          key={`start-${fieldKey}`}
          type="datetime-local"
          name="startAt"
          defaultValue={startValue}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onBlur={(event) => onStartBlur?.(event.currentTarget.value)}
        />
      </Field>
      <Field label={tr("结束时间")} error={endError}>
        <input
          key={`end-${fieldKey}`}
          type="datetime-local"
          name="endAt"
          defaultValue={endValue}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onBlur={(event) => onEndBlur?.(event.currentTarget.value)}
        />
      </Field>
    </div>
  );
}

export function CalendarReservationMetadataFields({
  values,
  readOnly = false,
  onChange
}: {
  values: CalendarMetadata;
  readOnly?: boolean;
  onChange?: (field: keyof CalendarMetadata, value: string) => void;
}) {
  return (
    <div className="calendar-reservation-metadata-fields">
      <Field label={tr("标题（选填）")}>
        <input
          name="title"
          maxLength={120}
          value={values.title}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onChange={(event) => onChange?.("title", event.target.value)}
        />
      </Field>
      <Field label={tr("用途（选填）")}>
        <textarea
          name="purpose"
          maxLength={500}
          rows={3}
          value={values.purpose}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onChange={(event) => onChange?.("purpose", event.target.value)}
        />
      </Field>
      <Field label={tr("备注（选填）")}>
        <textarea
          name="note"
          maxLength={1000}
          rows={3}
          value={values.note}
          readOnly={readOnly}
          aria-readonly={readOnly}
          onChange={(event) => onChange?.("note", event.target.value)}
        />
      </Field>
    </div>
  );
}
