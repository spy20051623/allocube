import { EditCancelled } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { withRequestDeadline } from "../../request-deadline";
import { tr } from "../../i18n/index";
import { Pencil, PowerOff, Power, Trash2 } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { jsonBody } from "../../api";
import type { ResourceGroup, ResourcePool } from "../../shared/types";
import { useConflictApi } from "../../app/useConflictApi";
import { SectionHeader } from "../../components/SectionHeader";
import { ResourceSummary } from "../catalog/ResourceSummary";
import { ResourceConfigurationModal } from "../resources/ResourceConfigurationModal";

export function MachineResourcesSection({
  machine,
  canManage,
  notify,
  reloadMachines
}: {
  machine: any;
  canManage: boolean;
  notify: (kind: "success" | "error", message: string) => void;
  reloadMachines: () => Promise<any[]>;
}) {
  const { request: api, dialog } = useConflictApi();
  const [groups, setGroups] = useState<ResourceGroup[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [pools, setPools] = useState<ResourcePool[]>([]);
  const [resourceEditorOpen, setResourceEditorOpen] = useState(false);
  const [openingResourceEditor, setOpeningResourceEditor] = useState(false);

  const fetchLoad = useCallback(async (signal: AbortSignal) => {
    try {
      const [groupResult, poolResult] = await withRequestDeadline(readSignal => Promise.all([
        api<{ groups: ResourceGroup[] }>(`/admin/machines/${machine.id}/groups`, { signal: readSignal }),
        api<{ pools: ResourcePool[] }>(`/admin/machines/${machine.id}/resource-pools`, { signal: readSignal })
      ]), signal);
      if (signal.aborted) return;
      setGroups(groupResult.groups);
      setPools(poolResult.pools);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("资源设置加载失败"));
    } finally {
      if (!signal.aborted) setGroupsLoaded(true);
    }
  }, [machine.id, notify]);
  const load = useRealtimeRefresh(fetchLoad, ["groups"], { filter: () => ({ machineId: machine.id }) });

  const openResourceEditor = async () => {
    setOpeningResourceEditor(true);
    try {
      const [poolResult, groupResult] = await Promise.all([
        api<{ pools: ResourcePool[] }>(
          `/admin/machines/${machine.id}/resource-pools`
        ),
        api<{ groups: ResourceGroup[] }>(
          `/admin/machines/${machine.id}/groups`
        )
      ]);
      setPools(poolResult.pools);
      setGroups(groupResult.groups);
      setResourceEditorOpen(true);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify(
        "error",
        error instanceof Error ? error.message : tr("资源配置加载失败")
      );
    } finally {
      setOpeningResourceEditor(false);
    }
  };

  useEffect(() => {
    setGroups([]);
    setGroupsLoaded(false);
    void load();
  }, [load]);

  const disableGroup = async (group: ResourceGroup) => {
    const reason = await dialog.prompt({
      title: tr("停用资源组"),
      message: tr("停用 {{v0}} 会立即处理进行中和未来的占用。", { v0: group.name }),
      label: tr("原因（选填）"),
      multiline: true,
      maxLength: 1000
    });
    if (reason === null) return;
    try {
      const preview = await api<{
        revision: number;
        summary: { total: number; cancelled: number; trimmed: number; split: number };
      }>(`/admin/groups/${group.id}/disable/preview`, { method: "POST" });
      const summary = preview.summary;
      if (!(await dialog.confirm({
        title: tr("确认停用"),
        message: summary.total
          ? tr("将影响 {{v0}} 条占用：取消 {{v1}} 条、裁切 {{v2}} 条、拆分 {{v3}} 条。", { v0: summary.total, v1: summary.cancelled, v2: summary.trimmed, v3: summary.split })
          : tr("当前没有受影响的占用。"),
        confirmLabel: tr("停用"),
        tone: "danger"
      }))) return;
      await api(`/admin/groups/${group.id}/disable`, {
        method: "POST",
        body: jsonBody({
          expectedVersion: group.version,
          expectedRevision: preview.revision,
          reason
        })
      });
      notify("success", tr("资源组已停用"));
      await load();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("停用失败"));
    }
  };

  const enableGroup = async (group: ResourceGroup) => {
    try {
      await api(`/admin/groups/${group.id}/enable`, {
        method: "POST",
        body: jsonBody({ expectedVersion: group.version })
      });
      notify("success", tr("资源组已重新启用"));
      await load();
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("重新启用失败"));
    }
  };

  const deleteGroup = async (group: ResourceGroup) => {
    try {
      const impact = await api<{ counts: Record<string, number> }>(
        `/admin/groups/${group.id}/deletion-impact`
      );
      const total = Object.values(impact.counts).reduce(
        (sum, value) => sum + value,
        0
      );
      const countLines = [
        tr("资源分配 {{v0}} 项", { v0: impact.counts.allocations ?? 0 }),
        tr("占用 {{v0}} 条", { v0: impact.counts.reservations ?? 0 }),
        tr("维护记录 {{v0}} 条", { v0: impact.counts.unavailability ?? 0 }),
        tr("配置历史 {{v0}} 条", { v0: impact.counts.revisions ?? 0 })
      ].join("\n");
      if (!(await dialog.confirm({
        title: tr("永久删除资源组"),
        message: tr("删除后无法恢复 {{v0}} 的配置。\n{{v1}}\n共涉及 {{v2}} 条记录；占用、维护和审计历史会继续保留，并以“资源组已删除”“资源已删除”等名称显示。", { v0: group.name, v1: countLines, v2: total }),
        confirmLabel: tr("永久删除"),
        tone: "danger"
      }))) return;
      await api(`/admin/groups/${group.id}`, {
        method: "DELETE",
        body: jsonBody({ expectedVersion: group.version })
      });
      notify("success", tr("资源组已永久删除"));
      await Promise.all([load(), reloadMachines()]);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      notify("error", error instanceof Error ? error.message : tr("删除资源组失败"));
    }
  };

  return (
    <div className="machine-section-stack">
      <section className="card panel-card resource-group-panel">
        <SectionHeader
          title={tr("资源组")}
          actions={canManage ? (
            <button
              className="secondary-button compact"
              onClick={() => void openResourceEditor()}
              disabled={openingResourceEditor}
            >
              <Pencil size={14} />{tr("编辑资源")}</button>
          ) : undefined}
        />
        <div className="group-admin-table">
          <div className="group-admin-row head" aria-hidden="true">
            <span>{tr("资源组信息")}</span><span>{tr("状态")}</span><span />
          </div>
          {groups.map((group) => {
            const effectiveStatus =
              group.status === "DISABLED" ||
                machine.availabilityStatus === "LONG_TERM"
                ? "DISABLED"
                : group.hasCurrentPlannedUnavailability ||
                  machine.availabilityStatus === "PLANNED"
                  ? "MAINTENANCE"
                  : "ACTIVE";
            return (
              <div className={`group-admin-row ${group.status.toLowerCase()}`} key={group.id}>
                <div className="group-admin-info">
                  <span className="group-admin-copy">
                    <strong className="group-admin-name" title={group.name}>{group.name}</strong>
                    <ResourceSummary value={group.resourceSummary} />
                  </span>
                </div>
                <span className="group-status-cell">
                  <span
                    className={`state-chip ${effectiveStatus === "DISABLED"
                        ? "disabled"
                        : effectiveStatus === "MAINTENANCE"
                          ? "scheduled"
                          : "active"
                      }`}
                  >
                    {effectiveStatus === "DISABLED"
                      ? tr("status.disabled")
                      : effectiveStatus === "MAINTENANCE"
                        ? tr("维护")
                        : tr("status.enabled")}
                  </span>
                </span>
                <div className="group-admin-actions">
                  {canManage && group.status === "ACTIVE" && (
                    <button className="icon-button tiny danger" title={tr("停用")} onClick={() => void disableGroup(group)}><PowerOff size={14} /></button>
                  )}
                  {canManage && group.status === "DISABLED" && (
                    <>
                      <button className="icon-button tiny" title={tr("重新启用")} onClick={() => void enableGroup(group)}><Power size={14} /></button>
                      <button className="icon-button tiny danger" title={tr("永久删除")} onClick={() => void deleteGroup(group)}><Trash2 size={14} /></button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {!groupsLoaded && <div className="mini-empty">{tr("正在加载资源组")}</div>}
          {groupsLoaded && !groups.length && (
            <div className="mini-empty">{tr("尚未配置资源组")}</div>
          )}
        </div>
      </section>
      {resourceEditorOpen && canManage && (
        <ResourceConfigurationModal
          machine={machine}
          pools={pools}
          groups={groups}
          onClose={() => setResourceEditorOpen(false)}
          onSaved={async () => {
            setResourceEditorOpen(false);
            await Promise.all([load(), reloadMachines()]);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
