import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { PageHeader } from "../../PageHeader";
import { MachineAccessRequestModal } from "../machines/MachineAccessRequestModal";
import { tr } from "../../i18n/index";
import { ChevronLeft, RefreshCw, Server } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { api } from "../../api";
import { type Page } from "../../app-routing";
import { resolveCatalogAccessDisplay } from "../../catalog-access-state";
import { ResourceCatalogCard, type CatalogMachine } from "./ResourceCatalogCard";
import type { AuthUser } from "../../shared/types";
import { useAppDialog } from "../../components/dialogs";
import { EmptyState } from "../../components/feedback";
import { accessExpiryLabel } from "../machines/AccessExpiryField";

export function ResourceCatalogPage({
  user,
  notify,
  navigate
}: {
  user: AuthUser;
  notify: (kind: "success" | "error", message: string) => void;
  navigate: (page: Page) => void;
}) {
  const dialog = useAppDialog();
  const [machines, setMachines] = useState<CatalogMachine[]>([]);
  const [loading, setLoading] = useState(true);
  const [requesting, setRequesting] = useState<CatalogMachine | null>(null);

  const fetchLoad = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await api<{ machines: CatalogMachine[] }>("/machines/catalog", { signal });
      if (signal.aborted) return;
      setMachines(result.machines);
    } catch (error) {
      if (signal.aborted) return;
      notify("error", error instanceof Error ? error.message : tr("机器目录加载失败"));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [notify]);
  const load = useRealtimeRefresh(fetchLoad, ["catalog"]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="page-shell resource-catalog-page">
      <PageHeader
        title={tr("全部资源")}
        actions={(
          <button className="secondary-button" onClick={() => navigate("calendar")}>
            <ChevronLeft size={16} />
            {tr("返回资源日历")}</button>
        )}
      />
      {loading ? (
        <div className="content-loading"><RefreshCw className="spin" />{tr("正在载入")}</div>
      ) : machines.length ? (
        <div className="resource-catalog-grid">
          {machines.map((machine) => {
            const accessDisplay = resolveCatalogAccessDisplay({
              userRole: user.role,
              isManager: machine.isManager,
              hasAccess: machine.hasAccess,
              hasPendingRequest: Boolean(machine.request),
              pendingRenewal: Boolean(machine.request?.previousExpiresAt),
              expiresAt: machine.expiresAt
            });
            return (
              <ResourceCatalogCard key={machine.id} machine={machine} accessDisplay={accessDisplay}>
                  <div className="catalog-card-dates">
                  {machine.hasAccess && machine.expiresAt && <small className="catalog-access-expiry">{tr("到期日期")}：<time dateTime={machine.expiresAt}>{accessExpiryLabel(machine.expiresAt)}</time></small>}
                  {machine.request && <small className="catalog-access-expiry">{machine.request.previousExpiresAt ? tr("申请延期至") : tr("申请使用至")}：<time dateTime={machine.request.expiresAt ?? undefined}>{accessExpiryLabel(machine.request.expiresAt)}</time></small>}
                  </div>
                  {accessDisplay.action === "RENEW" && <button className="primary-button compact catalog-card-action"
                    onClick={() => {
                      setRequesting(machine);
                    }}>{tr("延期")}</button>}
                  {accessDisplay.action === "WITHDRAW" && machine.request && (
                    <button
                      className="secondary-button compact catalog-card-action"
                      onClick={async () => {
                        if (!(await dialog.confirm({
                          title: tr("撤回申请"),
                          message: tr("确认撤回对 {{v0}} 的使用权申请？", { v0: machine.name }),
                          confirmLabel: tr("撤回")
                        }))) return;
                        try {
                          await api(`/machine-access/requests/${machine.request!.id}`, {
                            method: "DELETE"
                          });
                          notify("success", tr("使用权申请已撤回"));
                          await load();
                        } catch (error) {
                          notify(
                            "error",
                            error instanceof Error ? error.message : tr("撤回失败")
                          );
                        }
                      }}
                    >
                      {accessDisplay.actionLabel}
                    </button>
                  )}
                  {accessDisplay.action === "APPLY" && (
                    <button
                      className="primary-button compact catalog-card-action"
                      onClick={() => {
                        setRequesting(machine);
                      }}
                    >
                      {accessDisplay.actionLabel}
                    </button>
                  )}
                  {(accessDisplay.action === "EXIT" || accessDisplay.action === "RENEW" || (machine.hasAccess && accessDisplay.action === "WITHDRAW")) && (
                    <button
                      className="secondary-button compact catalog-card-action danger"
                      onClick={async () => {
                        const confirmation = machine.isManager
                          ? tr("退出 {{v0}} 后，你将同时失去管理员身份；进行中和未来占用都会被释放。确定退出？", { v0: machine.name })
                          : tr("退出 {{v0}} 后，进行中和未来占用都会被释放。确定退出？", { v0: machine.name });
                        if (!(await dialog.confirm({
                          title: tr("退出机器"),
                          message: machine.request?.previousExpiresAt ? `${confirmation} ${tr("待审批的延期申请也将结束。")}` : confirmation,
                          confirmLabel: tr("确认退出"),
                          tone: "danger"
                        }))) return;
                        try {
                          await api(`/machines/${machine.id}/membership`, {
                            method: "DELETE"
                          });
                          notify("success", tr("已退出 {{v0}}", { v0: machine.name }));
                          await load();
                        } catch (error) {
                          notify(
                            "error",
                            error instanceof Error ? error.message : tr("退出失败")
                          );
                        }
                      }}
                    >
                      {tr("退出")}
                    </button>
                  )}
              </ResourceCatalogCard>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={Server} title={tr("暂时没有可申请的机器")} />
      )}
      {requesting && (
        <MachineAccessRequestModal machine={requesting} notify={notify} onClose={() => setRequesting(null)} onSubmitted={load} />
      )}
    </div>
  );
}
