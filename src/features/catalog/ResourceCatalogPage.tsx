import { useRealtimeRefresh } from "../../useRealtimeRefresh";
import { PageHeader } from "../../PageHeader";
import { Modal } from "../../Modal";
import { tr } from "../../i18n/index";
import { useTranslation } from "react-i18next";
import { ShieldCheck, ChevronLeft, RefreshCw, Server, Globe2 } from "lucide-react";
import { useId, useRef, useMemo, useState, useLayoutEffect, useEffect, useCallback } from "react";
import { api, jsonBody } from "../../api";
import { type Page } from "../../app-routing";
import { resolveCatalogAccessDisplay } from "../../catalog-access-state";
import { calculateVisibleManagerCount } from "../../manager-summary";
import type { AuthUser } from "../../shared/types";
import { useAppDialog } from "../../components/dialogs";
import { EmptyState } from "../../components/feedback";
import { Field } from "../../components/forms";

type CatalogManager = {
  displayName: string;
  employeeNumber: string | null;
};

type CatalogMachine = {
  id: string;
  name: string;
  address: string;
  status: "ACTIVE" | "DISABLED";
  availabilityStatus: "ACTIVE" | "DISABLED" | "MAINTENANCE";
  resourceSummary: string;
  tags: string[];
  managers: CatalogManager[];
  hasAccess: boolean;
  isManager: boolean;
  request: {
    id: string;
    status: "PENDING";
    reason: string;
    createdAt: string;
  } | null;
};

function catalogManagerLabel(manager: CatalogManager) {
  return `${manager.displayName} · ${manager.employeeNumber || tr("暂无工号")}`;
}

function AdaptiveManagerList({ managers }: { managers: CatalogManager[] }) {
  const popoverId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const { i18n } = useTranslation();
  const labels = useMemo(
    () => managers.map(catalogManagerLabel),
    [i18n.resolvedLanguage, managers]
  );
  const [visibleCount, setVisibleCount] = useState(labels.length);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const measure = measureRef.current;
    if (!summary || !measure || !labels.length) return;

    const recalculate = () => {
      const itemWidths = Array.from(
        measure.querySelectorAll<HTMLElement>("[data-manager-measure]")
      ).map((item) => item.getBoundingClientRect().width);
      const overflowButton = measure.querySelector<HTMLElement>(
        "[data-manager-overflow-measure]"
      );
      if (itemWidths.length !== labels.length || !overflowButton) return;

      const nextVisibleCount = calculateVisibleManagerCount(
        summary.clientWidth,
        itemWidths,
        overflowButton.getBoundingClientRect().width,
        10
      );
      setVisibleCount((current) =>
        current === nextVisibleCount ? current : nextVisibleCount
      );
      if (nextVisibleCount === labels.length) setOpen(false);
    };

    recalculate();
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(recalculate);
    resizeObserver?.observe(summary);
    if (!resizeObserver) window.addEventListener("resize", recalculate);

    let disposed = false;
    void document.fonts?.ready.then(() => {
      if (!disposed) recalculate();
    });
    document.fonts?.addEventListener("loadingdone", recalculate);

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", recalculate);
      document.fonts?.removeEventListener("loadingdone", recalculate);
    };
  }, [labels]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    },
    []
  );

  const cancelClose = () => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };
  const openPopover = () => {
    cancelClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 140);
  };

  if (!labels.length) {
    return (
      <div className="catalog-manager-list">
        <ShieldCheck size={14} />
        <span>{tr("管理员")}</span>
        <em>{tr("暂无机器管理员")}</em>
      </div>
    );
  }

  const hasOverflow = visibleCount < labels.length;

  return (
    <div className="catalog-manager-list">
      <ShieldCheck size={14} />
      <span>{tr("管理员")}</span>
      <div className="catalog-manager-summary" ref={summaryRef}>
        <div className="catalog-manager-visible">
          {labels.slice(0, visibleCount).map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
          {hasOverflow && (
            <div
              className="catalog-manager-overflow"
              onMouseEnter={openPopover}
              onMouseLeave={scheduleClose}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  scheduleClose();
                }
              }}
            >
              <button
                ref={triggerRef}
                type="button"
                className="catalog-manager-count"
                aria-label={tr("共 {{v0}} 位管理员，查看完整名单", { v0: labels.length })}
                aria-expanded={open}
                aria-controls={popoverId}
                onFocus={openPopover}
                onClick={openPopover}
              >
                {tr("共")}{labels.length} {tr("人")}</button>
              {open && (
                <div
                  className="catalog-manager-popover"
                  id={popoverId}
                  role="tooltip"
                  onMouseEnter={cancelClose}
                  onMouseLeave={scheduleClose}
                >
                  <strong>{tr("机器管理员")}</strong>
                  <div>
                    {labels.map((label, index) => (
                      <span key={`${label}-full-${index}`}>{label}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="catalog-manager-measure" aria-hidden="true" ref={measureRef}>
          {labels.map((label, index) => (
            <span data-manager-measure key={`${label}-measure-${index}`}>
              {label}
            </span>
          ))}
          <button
            type="button"
            className="catalog-manager-count"
            data-manager-overflow-measure
            tabIndex={-1}
          >
            {tr("共")}{labels.length} {tr("人")}</button>
        </div>
      </div>
    </div>
  );
}

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
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

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
              hasPendingRequest: Boolean(machine.request)
            });
            return (
              <article
                className="card resource-catalog-card"
                key={machine.id}
              >
                <div className="catalog-machine-icon"><Server size={21} /></div>
                <div className="catalog-machine-copy">
                  <div className="catalog-machine-heading">
                    <h2 title={machine.name}>{machine.name}</h2>
                    <span
                      className={`state-chip ${machine.availabilityStatus === "DISABLED"
                          ? "disabled"
                          : machine.availabilityStatus === "MAINTENANCE"
                            ? "scheduled"
                            : "active"
                        }`}
                    >
                      {machine.availabilityStatus === "DISABLED"
                        ? tr("status.disabled")
                        : machine.availabilityStatus === "MAINTENANCE"
                          ? tr("维护")
                          : tr("status.enabled")}
                    </span>
                  </div>
                  <p title={machine.resourceSummary || tr("尚未配置资源")}>
                    {machine.resourceSummary || tr("尚未配置资源")}
                  </p>
                  <div
                    className="catalog-machine-login-ip"
                    title={machine.address || tr("未填写登录 IP")}
                  >
                    <Globe2 size={13} />
                    <span>{tr("登录 IP")}</span>
                    <code>{machine.address || tr("未填写")}</code>
                  </div>
                  <AdaptiveManagerList managers={machine.managers} />
                  <div className="tag-row">
                    {machine.tags.map((tag) => <span key={tag}>{tag}</span>)}
                  </div>
                </div>
                <div className="catalog-card-controls">
                  <span
                    className={`state-chip catalog-access-chip ${accessDisplay.state.toLowerCase()}`}
                  >
                    {accessDisplay.label}
                  </span>
                  {accessDisplay.action === "EXIT" && (
                    <button
                      className="secondary-button compact catalog-card-action danger"
                      onClick={async () => {
                        const confirmation = machine.isManager
                          ? tr("退出 {{v0}} 后，你将同时失去管理员身份；进行中和未来占用都会被释放。确定退出？", { v0: machine.name })
                          : tr("退出 {{v0}} 后，进行中和未来占用都会被释放。确定退出？", { v0: machine.name });
                        if (!(await dialog.confirm({
                          title: tr("退出机器"),
                          message: confirmation,
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
                      {accessDisplay.actionLabel}
                    </button>
                  )}
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
                        setReason("");
                        setRequesting(machine);
                      }}
                    >
                      {accessDisplay.actionLabel}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={Server} title={tr("暂时没有可申请的机器")} />
      )}
      {requesting && (
        <Modal title={tr("申请使用 {{v0}}", { v0: requesting.name })} onClose={() => setRequesting(null)}>
          <div className="stack-form">
            <Field label={tr("申请理由（选填）")}>
              <textarea
                rows={5}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
            <div className="field-counter">{reason.length}/500</div>
            <button
              className="primary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/machines/${requesting.id}/access-requests`, {
                    method: "POST",
                    body: jsonBody({ reason })
                  });
                  notify("success", tr("使用权申请已提交"));
                  setRequesting(null);
                  await load();
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
        </Modal>
      )}
    </div>
  );
}
