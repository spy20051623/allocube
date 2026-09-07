import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { Plus } from "lucide-react";
import { useState } from "react";
import { chinaLocalToIso } from "../../date";
import { type CalendarDraft, currentMinuteStart, calendarDraftFieldIssues } from "../../calendar-state";
import type { Machine, ResourceGroup, DashboardBootstrap } from "../../shared/types";
import { type CalendarReservationTarget } from "./types";
import { initialReservationTime } from "./reservation-events";
import { CalendarTargetFields } from "./ReservationFields";
import { Field } from "../../components/forms";

export function CalendarManualBookingModal({
  mode: initialMode,
  machines,
  groups,
  settings,
  currentTime,
  lockMode = false,
  initialMachineId,
  onClose,
  onAdd
}: {
  mode: "RESOURCE_GROUP" | "MACHINE";
  machines: Machine[];
  groups: Array<Omit<ResourceGroup, "version">>;
  settings: DashboardBootstrap["settings"];
  currentTime: number;
  lockMode?: boolean;
  initialMachineId?: string;
  onClose: () => void;
  onAdd: (
    target: CalendarReservationTarget,
    startAt: string,
    endAt: string
  ) => boolean;
}) {
  const [initialTime] = useState(() => initialReservationTime(currentTime));
  const [mode, setMode] = useState(initialMode);
  const [machineId, setMachineId] = useState(initialMachineId ?? "");
  const [targetId, setTargetId] = useState("");
  const [startAt, setStartAt] = useState(initialTime.start);
  const [endAt, setEndAt] = useState(initialTime.end);
  const [submitted, setSubmitted] = useState(false);
  const machineGroups = new Map<string, typeof groups>();
  for (const group of groups) {
    const list = machineGroups.get(group.machineId) ?? [];
    list.push(group);
    machineGroups.set(group.machineId, list);
  }
  const activeGroups = groups.filter(
    (group) =>
      group.status === "ACTIVE" &&
      machines.some(
        (machine) =>
          machine.id === group.machineId && machine.status === "ACTIVE"
      )
  );
  const groupMachineOptions = machines.filter(
    (machine) =>
      machine.status === "ACTIVE" &&
      activeGroups.some((group) => group.machineId === machine.id)
  );
  const wholeMachineOptions = machines.filter(
    (machine) =>
      machine.status === "ACTIVE" &&
      (machineGroups.get(machine.id)?.length ?? 0) > 0 &&
      machineGroups
        .get(machine.id)!
        .every((group) => group.status === "ACTIVE")
  );
  const availableMachines =
    mode === "RESOURCE_GROUP"
      ? groupMachineOptions
      : wholeMachineOptions;
  const selectedMachineId =
    machineId &&
      availableMachines.some((machine) => machine.id === machineId)
      ? machineId
      : availableMachines[0]?.id ?? "";
  const groupOptions = activeGroups.filter(
    (group) => group.machineId === selectedMachineId
  );
  const selectedResourceGroupId =
    targetId && groupOptions.some((group) => group.id === targetId)
      ? targetId
      : groupOptions[0]?.id ?? "";
  const selectedResourceOptionId =
    mode === "MACHINE" ? "MACHINE" : selectedResourceGroupId;
  const resourceOptions =
    mode === "MACHINE"
      ? [{ id: "MACHINE", label: tr("整机") }]
      : groupOptions.map((group) => ({ id: group.id, label: group.name }));
  const selectedTargetId =
    mode === "MACHINE" ? selectedMachineId : selectedResourceGroupId;
  const draft: CalendarDraft = {
    id: "manual",
    scope: mode,
    machineId: selectedMachineId,
    resourceGroupId:
      mode === "MACHINE"
        ? activeGroups.find((group) => group.machineId === selectedMachineId)
          ?.id ?? ""
        : selectedResourceGroupId,
    startMode:
      startAt &&
        new Date(chinaLocalToIso(startAt)).getTime() <=
        new Date(currentMinuteStart(currentTime)).getTime()
        ? "IMMEDIATE"
        : "SCHEDULED",
    startAt: startAt ? chinaLocalToIso(startAt) : "",
    endAt: endAt ? chinaLocalToIso(endAt) : ""
  };
  const issues = calendarDraftFieldIssues(draft, settings, currentTime);

  return (
    <Modal title={tr("新增占用")} onClose={onClose}>
      <form
        className="stack-form calendar-manual-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!selectedTargetId || issues.startAt || issues.endAt) return;
          onAdd(
            {
              scope: mode,
              machineId: draft.machineId ?? "",
              resourceGroupId: draft.resourceGroupId
            },
            draft.startAt,
            draft.endAt
          );
        }}
      >
        <div className="segmented calendar-manual-mode">
          <button
            type="button"
            className={mode === "RESOURCE_GROUP" ? "active" : ""}
            disabled={lockMode}
            onClick={() => {
              setMode("RESOURCE_GROUP");
              setMachineId("");
              setTargetId("");
              setSubmitted(false);
            }}
          >
            {tr("资源组")}</button>
          <button
            type="button"
            className={mode === "MACHINE" ? "active" : ""}
            disabled={lockMode}
            onClick={() => {
              setMode("MACHINE");
              setMachineId("");
              setTargetId("");
              setSubmitted(false);
            }}
          >
            {tr("整机")}</button>
        </div>
        <CalendarTargetFields
          machines={availableMachines}
          machineId={selectedMachineId}
          resourceOptions={resourceOptions}
          resourceId={selectedResourceOptionId}
          onMachineChange={(nextMachineId) => {
            setMachineId(nextMachineId);
            setTargetId("");
            setSubmitted(false);
          }}
          onResourceChange={(nextResourceId) => {
            if (mode === "RESOURCE_GROUP") setTargetId(nextResourceId);
            setSubmitted(false);
          }}
        />
        {!availableMachines.length && (
          <div className="auth-form-feedback error" role="alert">
            {tr("当前没有可占用的机器")}</div>
        )}
        <Field
          label={tr("开始时间")}
          error={submitted ? issues.startAt : undefined}
        >
          <input
            type="datetime-local"
            name="manualStartAt"
            value={startAt}
            onChange={(event) => {
              setStartAt(event.target.value);
              setSubmitted(false);
            }}
          />
        </Field>
        <Field
          label={tr("结束时间")}
          error={submitted ? issues.endAt : undefined}
        >
          <input
            type="datetime-local"
            name="manualEndAt"
            value={endAt}
            onChange={(event) => {
              setEndAt(event.target.value);
              setSubmitted(false);
            }}
          />
        </Field>
        <button
          className="primary-button"
          type="submit"
          disabled={!selectedTargetId}
        >
          <Plus size={15} />
          {tr("加入占用详情")}</button>
      </form>
    </Modal>
  );
}
