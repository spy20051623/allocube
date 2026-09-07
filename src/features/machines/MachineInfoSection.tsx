import { EditCancelled } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { useServerClock } from "../../ServerClock";
import { tr } from "../../i18n/index";
import {
  RefreshCw,
  Pencil,
  Server,
  Gauge,
  Cpu,
  Info,
  ShieldCheck,
  Plus,
  X,
  Power,
  PowerOff,
  Trash2
} from "lucide-react";
import { useRef, useState, useLayoutEffect, useCallback, useEffect } from "react";
import { jsonBody } from "../../api";
import { formatChinaFullMinute, formatChinaDate, formatChina } from "../../date";
import type { ResourceGroup } from "../../shared/types";
import { useConflictApi } from "../../app/useConflictApi";
import { useAppDialog } from "../../components/dialogs";
import { SectionHeader } from "../../components/SectionHeader";
import { MaintenanceModal, MachineStopModal } from "./UnavailabilityModals";
import { MachineFormModal } from "./MachineFormModal";

function ExpandableMachineText({ value }: { value: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      if (!expanded) setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(measure);
    observer?.observe(element);
    if (!observer) window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener("resize", measure);
    };
  }, [expanded, value]);

  return (
    <div className="machine-info-text">
      <p ref={textRef} className={expanded ? "expanded" : ""}>{value || tr("未填写")}</p>
      {(overflowing || expanded) && (
        <button type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? tr("收起") : tr("展开")}
        </button>
      )}
    </div>
  );
}

function formatUnavailabilityPeriod(
  startAt: string,
  endAt: string
) {
  const start = formatChinaFullMinute(startAt);
  const end =
    formatChinaDate(startAt) === formatChinaDate(endAt)
      ? formatChina(endAt, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      })
      : formatChinaFullMinute(endAt);
  return `${start} — ${end}`;
}

export function MachineInfoSection({
  machine,
  isSystemAdmin,
  canManage,
  notify,
  reloadMachines
}: {
  machine: any;
  isSystemAdmin: boolean;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
}) {
  const { request: api } = useConflictApi();
  const dialog = useAppDialog();
  const { currentTime } = useServerClock();
  const [detail, setDetail] = useState<any | null>(null);
  const [unavailabilityWindows, setUnavailabilityWindows] = useState<any[]>([]);
  const [maintenanceGroups, setMaintenanceGroups] = useState<ResourceGroup[]>([]);
  const [editMachine, setEditMachine] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenanceInitialTime, setMaintenanceInitialTime] = useState<
    number | null
  >(null);
  const [stopOpen, setStopOpen] = useState(false);

  const fetchLoad = useCallback(async (signal: AbortSignal) => {
    try {
      const [machineResult, maintenanceResult, groupResult] = await Promise.all([
        api<{ machine: any }>(`/admin/machines/${machine.id}`, { signal }),
        api<{ maintenance: any[] }>(
          `/admin/machines/${machine.id}/maintenance`, { signal }
        ),
        api<{ groups: ResourceGroup[] }>(
          `/admin/machines/${machine.id}/groups`, { signal }
        )
      ]);
      if (signal.aborted) return;
      setDetail(machineResult.machine);
      setUnavailabilityWindows(maintenanceResult.maintenance);
      setMaintenanceGroups(groupResult.groups);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("机器信息加载失败"));
    }
  }, [machine.id, notify]);
  const load = useRealtimeRefresh(fetchLoad, ["machine"], { filter: () => ({ machineId: machine.id }) });

  useEffect(() => { void load(); }, [load]);

  const openMaintenance = () => {
    setMaintenanceInitialTime(currentTime);
    setMaintenanceOpen(true);
  };

  const closeMaintenance = () => {
    setMaintenanceOpen(false);
    setMaintenanceInitialTime(null);
  };

  if (!detail) {
    return <div className="content-loading"><RefreshCw className="spin" />{tr("正在载入")}</div>;
  }

  const currentMaintenance = unavailabilityWindows.filter(
    (item) =>
      item.status === "ACTIVE" &&
      new Date(item.endAt).getTime() > currentTime
  ).sort((left, right) => left.startAt.localeCompare(right.startAt));
  const machineMaintenanceNow = currentMaintenance.some(
    (item) =>
      item.resourceGroupId === null &&
      new Date(item.startAt).getTime() <= currentTime
  );
  const machineStatus = detail.status === "DISABLED"
    ? { label: tr("status.disabled"), className: "disabled" }
    : machineMaintenanceNow
      ? { label: tr("维护"), className: "scheduled" }
      : { label: tr("status.enabled"), className: "active" };

  const handleEnable = async () => {
    try {
      await api(`/admin/machines/${machine.id}/enable`, {
        method: "POST",
        body: jsonBody({ expectedVersion: detail.version })
      });
      notify("success", tr("机器已重新启用"));
      await Promise.all([load(), reloadMachines()]);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("重新启用失败"));
    }
  };

  const handleDelete = async () => {
    try {
      const impact = await api<{
        counts: Record<string, number>;
      }>(`/admin/machines/${machine.id}/deletion-impact`);
      const total = Object.values(impact.counts).reduce(
        (sum, value) => sum + value,
        0
      );
      const countLines = [
        tr("资源配置 {{v0}} 项", { v0: impact.counts.resourcePools ?? 0 }),
        tr("设备条目 {{v0}} 项", { v0: impact.counts.resourceItems ?? 0 }),
        tr("资源组 {{v0}} 个", { v0: impact.counts.resourceGroups ?? 0 }),
        tr("成员 {{v0}} 人", { v0: impact.counts.members ?? 0 }),
        tr("机器管理员 {{v0}} 人", { v0: impact.counts.managers ?? 0 }),
        tr("使用权申请 {{v0}} 条", { v0: impact.counts.accessRequests ?? 0 }),
        tr("占用 {{v0}} 条", { v0: impact.counts.reservations ?? 0 }),
        tr("维护记录 {{v0}} 条", { v0: impact.counts.unavailability ?? 0 })
      ].join("\n");
      if (!(await dialog.confirm({
        title: tr("永久删除机器"),
        message: tr("删除后无法恢复 {{v0}} 的配置和权限。\n{{v1}}\n共涉及 {{v2}} 条记录；占用、审批、维护和审计历史会继续保留，并以“机器已删除”“资源组已删除”等名称显示。", { v0: detail.name, v1: countLines, v2: total }),
        confirmLabel: tr("永久删除"),
        tone: "danger"
      }))) return;
      await api(`/admin/machines/${machine.id}`, {
        method: "DELETE",
        body: jsonBody({ expectedVersion: detail.version })
      });
      notify("success", tr("机器已永久删除"));
      await reloadMachines();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("删除机器失败"));
    }
  };

  return (
    <div className="machine-section-stack">
      <section className="card panel-card machine-info-panel">
        <SectionHeader
          title={tr("机器信息")}
          actions={canManage ? (
            <button className="secondary-button compact" onClick={() => setEditMachine(true)}>
              <Pencil size={14} />{tr("编辑")}</button>
          ) : undefined}
        />
        <div className="machine-info-overview">
          <div className="machine-info-identity">
            <span className="machine-info-symbol"><Server size={20} /></span>
            <div>
              <span>{tr("机器名称")}</span>
              <strong>{detail.name}</strong>
              <small>{tr("连接地址：")}{detail.address || tr("未填写")}</small>
            </div>
            <span className={`state-chip ${machineStatus.className}`}>
              {machineStatus.label}
            </span>
          </div>
          <div className="machine-info-resource">
            <span><Gauge size={14} />{tr("资源摘要")}</span>
            <strong>{detail.resourceSummary || tr("尚未配置资源")}</strong>
          </div>
        </div>
        <div className="machine-info-tags">
          <span>{tr("标签")}</span>
          <div className="tag-row">
            {detail.tags.length
              ? detail.tags.map((tag: string) => <span key={tag}>{tag}</span>)
              : <em>{tr("未填写")}</em>}
          </div>
        </div>
        <div className="machine-info-details">
          <div className="machine-info-detail">
            <span><Cpu size={14} />{tr("硬件说明")}</span>
            <ExpandableMachineText value={detail.hardwareNotes} />
          </div>
          <div className="machine-info-detail">
            <span><Info size={14} />{tr("连接说明")}</span>
            <ExpandableMachineText value={detail.connectionGuide} />
          </div>
          {canManage && (
            <div className="machine-info-detail management">
              <span><ShieldCheck size={14} />{tr("管理备注")}</span>
              <ExpandableMachineText value={detail.managementNotes} />
            </div>
          )}
        </div>
      </section>

      <section className="card panel-card machine-unavailability-panel maintenance-panel">
        <SectionHeader
          title={tr("维护管理")}
          actions={
            canManage && detail.status === "ACTIVE" ? (
              <button
                type="button"
                className="secondary-button compact"
                onClick={openMaintenance}
              >
                <Plus size={14} />{tr("安排维护")}</button>
            ) : undefined
          }
        />
        {currentMaintenance.length > 0 && (
          <div className="unavailability-table machine-unavailability-table">
            <div className="unavailability-table-row machine-unavailability-table-row head">
              <span>{tr("范围")}</span>
              <span>{tr("维护时间")}</span>
              <span>{tr("原因")}</span>
              <span />
            </div>
            {currentMaintenance.map((item) => (
              <div
                className="unavailability-table-row machine-unavailability-table-row"
                key={item.id}
              >
                <span
                  className={`unavailability-kind-chip ${item.resourceGroupId ? "group" : "planned"
                    }`}
                  title={item.resourceGroupName || tr("整机")}
                >
                  {item.resourceGroupName || tr("整机")}
                </span>
                <span
                  className="unavailability-period"
                  title={formatUnavailabilityPeriod(
                    item.startAt,
                    item.endAt
                  )}
                >
                  {formatUnavailabilityPeriod(
                    item.startAt,
                    item.endAt
                  )}
                </span>
                <span
                  className={`unavailability-reason${item.reason ? "" : " empty"}`}
                  title={item.reason || tr("未填写")}
                >
                  {item.reason || tr("未填写")}
                </span>
                {canManage ? (
                  <span className="unavailability-row-action">
                    <button className="icon-button tiny danger" title={tr("取消维护")} onClick={async () => {
                      if (!(await dialog.confirm({
                        title: tr("取消维护"),
                        message: tr("此前因维护被取消或调整的占用不会自动恢复。"),
                        confirmLabel: tr("取消维护"),
                        tone: "danger"
                      }))) return;
                      try {
                        await api(`/admin/maintenance/${item.id}`, { method: "DELETE" });
                        notify("success", tr("维护安排已取消"));
                        await load();
                      } catch (error) {
                        if (error instanceof EditCancelled) return;
                        notify("error", error instanceof Error ? error.message : tr("取消维护失败"));
                      }
                    }}><X size={14} /></button>
                  </span>
                ) : <span className="unavailability-row-action" />}
              </div>
            ))}
          </div>
        )}
        {currentMaintenance.length === 0 && (
          <div className="unavailability-empty">{tr("暂无维护安排")}</div>
        )}
      </section>

      <section className="card panel-card machine-state-panel">
        <SectionHeader title={tr("机器状态")} />
        <div className={`machine-disabled-state${detail.status === "ACTIVE" ? " active" : ""}`}>
          <div>
            {detail.status === "ACTIVE" ? <Power size={17} /> : <PowerOff size={17} />}
            <strong>{detail.status === "ACTIVE" ? tr("status.enabled") : tr("status.disabled")}</strong>
          </div>
          {canManage && (
            <div className="section-header-actions">
              {detail.status === "ACTIVE" ? (
                <button
                  className="secondary-button compact danger"
                  onClick={() => setStopOpen(true)}
                >
                  <PowerOff size={14} />{tr("停用")}</button>
              ) : (
                <>
                  <button
                    className="secondary-button compact"
                    onClick={() => void handleEnable()}
                  >
                    <Power size={14} />{tr("重新启用")}</button>
                  {isSystemAdmin && (
                    <button
                      className="secondary-button compact danger"
                      title={tr("永久删除机器")}
                      aria-label={tr("永久删除 {{v0}}", { v0: detail.name })}
                      onClick={() => void handleDelete()}
                    >
                      <Trash2 size={14} />{tr("永久删除")}</button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </section>
      {maintenanceOpen && maintenanceInitialTime !== null && canManage && (
        <MaintenanceModal
          machine={detail}
          groups={maintenanceGroups}
          openingTime={maintenanceInitialTime}
          onClose={closeMaintenance}
          onCompleted={async () => {
            closeMaintenance();
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
      {stopOpen && canManage && (
        <MachineStopModal
          machine={detail}
          onClose={() => setStopOpen(false)}
          onCompleted={async () => {
            setStopOpen(false);
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
      {editMachine && canManage && (
        <MachineFormModal
          machine={detail}
          onClose={() => setEditMachine(false)}
          onSaved={async () => {
            setEditMachine(false);
            notify("success", tr("机器资料已更新"));
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
