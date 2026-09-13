import { useId, useRef, useMemo, useState, useLayoutEffect, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, Server, Globe2 } from "lucide-react";
import { tr } from "../../i18n/index";
import { calculateVisibleManagerCount } from "../../manager-summary";
import type { resolveCatalogAccessDisplay } from "../../catalog-access-state";

type CatalogManager = {
  displayName: string;
  employeeNumber: string | null;
};

export type CatalogMachine = {
  id: string;
  name: string;
  address: string;
  status: "ACTIVE" | "DISABLED";
  availabilityStatus: "ACTIVE" | "DISABLED" | "MAINTENANCE";
  resourceSummary: string;
  tags: string[];
  managers: CatalogManager[];
  hasAccess: boolean;
  expiresAt: string | null;
  isManager: boolean;
  request: {
    id: string;
    status: "PENDING";
    reason: string;
    createdAt: string;
    expiresAt: string | null;
    previousExpiresAt: string | null;
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
                {tr("共 {{v0}} 人", { v0: labels.length })}</button>
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
            {tr("共 {{v0}} 人", { v0: labels.length })}</button>
        </div>
      </div>
    </div>
  );
}


export function ResourceCatalogCard({ machine, accessDisplay, children }: {
  machine: CatalogMachine;
  accessDisplay: ReturnType<typeof resolveCatalogAccessDisplay>;
  children: ReactNode;
}) {
  const availability = machine.availabilityStatus === "DISABLED"
    ? { className: "disabled", label: tr("status.disabled") }
    : machine.availabilityStatus === "MAINTENANCE"
      ? { className: "scheduled", label: tr("维护") }
      : { className: "active", label: tr("status.enabled") };

  return (
    <article className="card resource-catalog-card">
      <div className="catalog-card-header">
        <div className="catalog-machine-icon"><Server size={20} /></div>
        <div className="catalog-machine-heading">
          <h2 title={machine.name}>{machine.name}</h2>
          <div className="catalog-machine-login-ip" title={machine.address || tr("未填写登录 IP")}>
            <Globe2 size={12} aria-hidden="true" />
            <code>{machine.address || tr("未填写登录 IP")}</code>
          </div>
        </div>
        <div className="catalog-card-statuses">
          <span className={`state-chip ${availability.className}`}>{availability.label}</span>
        </div>
      </div>
      <p className={`catalog-resource-summary${machine.resourceSummary ? "" : " empty"}`}>
        {machine.resourceSummary || tr("尚未配置资源")}
      </p>
      <div className="catalog-machine-details">
        <AdaptiveManagerList managers={machine.managers} />
        {machine.tags.length > 0 && <div className="tag-row">
          {machine.tags.map(tag => <span key={tag}>{tag}</span>)}
        </div>}
      </div>
      <div className="catalog-card-controls">
        <span className={`state-chip catalog-access-chip ${accessDisplay.state.toLowerCase()}`}>
          {accessDisplay.label}
        </span>
        <div className="catalog-card-action-row">{children}</div>
      </div>
    </article>
  );
}