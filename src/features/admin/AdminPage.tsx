import { AuditPanel } from "../../AuditPanel";
import { EditCancelled } from "../../edit-conflict";
import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { PageHeader } from "../../PageHeader";
import { tr } from "../../i18n/index";
import {
  Server,
  Users,
  Activity,
  Megaphone,
  MessageSquare,
  Settings,
  ShieldCheck,
  Plus,
  RefreshCw,
  ChevronRight,
  Search
} from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { api } from "../../api";
import { type AdminTab, type MachineAdminSection } from "../../app-routing";
import type { DashboardBootstrap } from "../../shared/types";
import { notificationBadgeText } from "../../notification-navigation";
import { MachineAdminPanel } from "../machines/MachineAdminPanel";
import { UserAdminPanel } from "../users/UserAdminPanel";
import { ReportPanel } from "../reports/ReportPanel";
import { AnnouncementAdminPanel } from "../announcements/AnnouncementAdminPanel";
import { FeedbackAdminPanel } from "../feedback/FeedbackPages";
import { SettingsPanel } from "../settings/SettingsPanel";
import { MachineFormModal } from "../machines/MachineFormModal";

export function AdminPage({
  bootstrap,
  notify,
  tab,
  onTabChange,
  onOpenResourceCatalog,
  machineId,
  machineSection,
  onMachineRoute,
  feedbackId,
  feedbackRefreshToken,
  onFeedbackRoute,
  onUnreadCountRefresh
}: {
  bootstrap: DashboardBootstrap;
  notify: (kind: "success" | "error", message: string) => void;
  tab: AdminTab;
  onTabChange: (tab: AdminTab) => void;
  onOpenResourceCatalog: () => void;
  machineId?: string;
  machineSection?: MachineAdminSection;
  feedbackId?: string;
  feedbackRefreshToken: number;
  onFeedbackRoute: (feedbackId?: string) => void;
  onUnreadCountRefresh: () => Promise<void>;
  onMachineRoute: (
    machineId: string,
    section: MachineAdminSection,
    replace?: boolean
  ) => void;
}) {
  const isSystemAdmin = bootstrap.user.role === "SYSTEM_ADMIN";
  const visibleTab =
    !isSystemAdmin && ["announcements", "feedback", "settings", "audit"].includes(tab)
      ? "machines"
      : tab;
  const [machines, setMachines] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [newMachineOpen, setNewMachineOpen] = useState(false);
  const [machineSearch, setMachineSearch] = useState("");
  const [machinesLoaded, setMachinesLoaded] = useState(false);
  const [feedbackOpenCount, setFeedbackOpenCount] = useState(0);

  const fetchLoadMachines = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ machines: any[] }>("/admin/machines", { signal });
      if (signal.aborted) return [];
      setMachines(result.machines);
      return result.machines;
    } catch (error) {
      if (signal.aborted) return [];
      notify("error", error instanceof Error ? error.message : tr("机器加载失败"));
      return [];
    } finally {
      if (!signal.aborted) setMachinesLoaded(true);
    }
  }, [notify]);
  const loadMachines = useRealtimeRefresh(fetchLoadMachines, ["machines"], { enabled: visibleTab === "machines" });
  const fetchLoadUsers = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ users: any[] }>(
        isSystemAdmin ? "/admin/users" : "/users/directory", { signal }
      );
      if (signal.aborted) return;
      setUsers(result.users);
    } catch (error) {
      if (error instanceof EditCancelled) return;
      if (signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("用户加载失败"));
    }
  }, [isSystemAdmin, notify]);
  const loadUsers = useRealtimeRefresh(fetchLoadUsers, ["users"], { enabled: visibleTab === "users" || visibleTab === "machines" });

  useEffect(() => {
    if (visibleTab === "machines" || visibleTab === "report") void loadMachines();
    if (visibleTab === "machines" || visibleTab === "users") void loadUsers();
  }, [loadMachines, loadUsers, visibleTab]);

  useEffect(() => {
    if (!isSystemAdmin) return;
    void api<{ openCount: number }>("/admin/feedback/summary")
      .then((result) => setFeedbackOpenCount(result.openCount))
      .catch(() => undefined);
  }, [feedbackRefreshToken, isSystemAdmin]);

  useEffect(() => {
    if (visibleTab !== "machines" || !machinesLoaded || !machines.length) return;
    if (machineId && machines.some((machine) => machine.id === machineId)) return;
    onMachineRoute(machines[0].id, machineSection ?? "info", true);
  }, [
    machineId,
    machineSection,
    machines,
    machinesLoaded,
    onMachineRoute,
    visibleTab
  ]);

  const tabs = [
    { id: "machines" as const, label: tr("资源管理"), icon: Server, show: true },
    { id: "users" as const, label: tr("用户管理"), icon: Users, show: true },
    { id: "report" as const, label: tr("使用统计"), icon: Activity, show: true },
    { id: "announcements" as const, label: tr("系统公告"), icon: Megaphone, show: isSystemAdmin },
    { id: "feedback" as const, label: tr("反馈处理"), icon: MessageSquare, show: isSystemAdmin, badge: feedbackOpenCount },
    { id: "settings" as const, label: tr("系统设置"), icon: Settings, show: isSystemAdmin },
    { id: "audit" as const, label: tr("审计记录"), icon: ShieldCheck, show: isSystemAdmin }
  ];

  return (
    <div className={`admin-shell${visibleTab === "feedback" ? " feedback-admin-shell" : ""}${visibleTab === "report" ? " report-admin-shell" : ""}${visibleTab === "audit" ? " audit-admin-shell" : ""}`}>
      <aside className="admin-sidebar">
        <div>
          <h2>{tr("管理控制台")}</h2>
        </div>
        <nav>
          {tabs.filter((item) => item.show).map((item) => (
            <button key={item.id} className={visibleTab === item.id ? "active" : ""} onClick={() => onTabChange(item.id)}>
              <item.icon size={17} />{item.label}
              {"badge" in item && typeof item.badge === "number" && item.badge > 0 && (
                <span className="admin-tab-badge">{notificationBadgeText(item.badge)}</span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <section
        className={`admin-content${visibleTab === "machines" ? " machine-management-content" : ""}${visibleTab === "report" ? " report-management-content" : ""}${visibleTab === "feedback" ? " feedback-management-content" : ""}`}
      >
        {visibleTab === "machines" && (
          <>
            <PageHeader
              title={tr("资源管理")}
              actions={isSystemAdmin ? <button className="primary-button" onClick={() => setNewMachineOpen(true)}><Plus size={16} />{tr("action.machine.new")}</button> : undefined}
            />
            {!machinesLoaded ? (
              <div className="card machine-management-loading" aria-live="polite">
                <RefreshCw size={18} className="spin" />
                {tr("正在加载机器")}</div>
            ) : !machines.length ? (
              <section className="card machine-management-empty">
                <div className="machine-management-empty-icon">
                  <Server size={25} />
                </div>
                <h2>{tr("暂无可查看的机器")}</h2>
                <p>{tr("获得机器使用权后，可在这里查看和管理相关资源。")}</p>
                <button
                  type="button"
                  className="secondary-button accent"
                  onClick={onOpenResourceCatalog}
                >
                  {tr("查看全部资源")}<ChevronRight size={16} />
                </button>
              </section>
            ) : (
              <div className="machine-admin-layout">
                <div className="machine-list card">
                  <label className="machine-list-search">
                    <Search size={15} />
                    <input
                      value={machineSearch}
                      onChange={(event) => setMachineSearch(event.target.value)}
                      placeholder={tr("搜索名称或地址")}
                    />
                  </label>
                  <div className="machine-list-scroll">
                    {machines
                      .filter((machine) => {
                        const query = machineSearch.trim().toLowerCase();
                        return (
                          !query ||
                          String(machine.name).toLowerCase().includes(query) ||
                          String(machine.address ?? "").toLowerCase().includes(query)
                        );
                      })
                      .map((machine) => (
                        <button
                          key={machine.id}
                          className={machineId === machine.id ? "active" : ""}
                          onClick={() =>
                            onMachineRoute(
                              machine.id,
                              machineSection ?? "info"
                            )
                          }
                        >
                          <span className="machine-list-icon"><Server size={18} /></span>
                          <span>
                            <strong>{machine.name}</strong>
                            <small>{machine.address || tr("未填写地址")} ｜ {machine.resourceSummary || tr("尚未配置资源")}</small>
                          </span>
                          <ChevronRight size={17} />
                        </button>
                      ))}
                    {machines.length > 0 &&
                      !machines.some((machine) => {
                        const query = machineSearch.trim().toLowerCase();
                        return (
                          !query ||
                          String(machine.name).toLowerCase().includes(query) ||
                          String(machine.address ?? "").toLowerCase().includes(query)
                        );
                      }) && <div className="mini-empty">{tr("没有匹配的机器")}</div>}
                  </div>
                </div>
                {machineId && machines.some((machine) => machine.id === machineId) && (
                  <MachineAdminPanel
                    key={machineId}
                    machine={machines.find((item) => item.id === machineId)}
                    isSystemAdmin={isSystemAdmin}
                    canManage={Boolean(
                      machines.find((item) => item.id === machineId)?.canManage
                    )}
                    notify={notify}
                    reloadMachines={loadMachines}
                    section={machineSection ?? "info"}
                    onSectionChange={(nextSection) =>
                      onMachineRoute(machineId, nextSection)
                    }
                  />
                )}
              </div>
            )}
          </>
        )}
        {visibleTab === "users" && (
          <UserAdminPanel
            users={users}
            canManage={isSystemAdmin}
            notify={notify}
            reload={loadUsers}
          />
        )}
        {visibleTab === "report" && <ReportPanel machines={machines} notify={notify} isSystemAdmin={isSystemAdmin} />}
        {visibleTab === "announcements" && <AnnouncementAdminPanel notify={notify} />}
        {visibleTab === "feedback" && (
          <FeedbackAdminPanel
            feedbackId={feedbackId}
            refreshToken={feedbackRefreshToken}
            notify={notify}
            onOpen={onFeedbackRoute}
            onUnreadCountRefresh={onUnreadCountRefresh}
          />
        )}
        {visibleTab === "settings" && <SettingsPanel notify={notify} />}
        {visibleTab === "audit" && <AuditPanel />}
      </section>
      {newMachineOpen && (
        <MachineFormModal
          onClose={() => setNewMachineOpen(false)}
          onSaved={async (createdMachineId) => {
            setNewMachineOpen(false);
            notify("success", tr("机器已创建"));
            await loadMachines();
            if (createdMachineId) onMachineRoute(createdMachineId, "info");
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
