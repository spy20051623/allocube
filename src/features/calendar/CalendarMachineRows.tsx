import { tr } from "../../i18n/index";
import {
  type CalendarResultFieldWidths,
  CALENDAR_RESULT_FIELD_GAP,
  allocateCalendarResultFieldWidths
} from "../../calendar-result-layout";
import { ChevronDown, Server } from "lucide-react";
import { useRef, useState, useLayoutEffect } from "react";
import type { Machine, ResourceGroup } from "../../shared/types";
import { ResourceSummary } from "../catalog/ResourceSummary";

function CalendarMachineTags({
  tags,
  className = ""
}: {
  tags: string[];
  className?: string;
}) {
  if (!tags.length) return null;
  const visibleTags = tags.slice(0, 3);
  const remaining = tags.length - visibleTags.length;
  return (
    <span
      className={`calendar-machine-tags${className ? ` ${className}` : ""}`}
      title={tags.join("、")}
    >
      {visibleTags.map((tag) => (
        <span key={tag}>{tag}</span>
      ))}
      {remaining > 0 && <span>+{remaining}</span>}
    </span>
  );
}

export function CalendarMachineStripLine({
  machine,
  maintenanceNow
}: {
  machine: Machine;
  maintenanceNow: boolean;
}) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const leadingRef = useRef<HTMLSpanElement>(null);
  const stateRef = useRef<HTMLSpanElement>(null);
  const titleMeasureRef = useRef<HTMLElement>(null);
  const addressMeasureRef = useRef<HTMLElement>(null);
  const tagsMeasureRef = useRef<HTMLSpanElement>(null);
  const resourceMeasureRef = useRef<HTMLSpanElement>(null);
  const [widths, setWidths] = useState<CalendarResultFieldWidths | null>(null);
  const tagKey = machine.tags.join("\u0000");
  const stateClass =
    machine.status === "DISABLED"
      ? "disabled"
      : maintenanceNow
        ? "scheduled"
        : "active";
  const stateLabel =
    machine.status === "DISABLED"
      ? tr("status.disabled")
      : maintenanceNow
        ? tr("维护")
        : tr("status.enabled");
  const resourceText = machine.resourceSummary || tr("尚未配置资源");

  useLayoutEffect(() => {
    let active = true;
    const recalculate = () => {
      if (!active) return;
      const root = rootRef.current;
      const strip = root?.parentElement;
      const shell = root?.closest<HTMLElement>(".timeline-scroll-shell");
      if (!root || !strip || !shell) return;
      const visibleWidth = Math.min(strip.clientWidth, shell.clientWidth);
      root.style.width = `${visibleWidth}px`;
      const rootStyle = window.getComputedStyle(root);
      const horizontalPadding =
        Number.parseFloat(rootStyle.paddingLeft) +
        Number.parseFloat(rootStyle.paddingRight);
      const rootWidth = root.clientWidth - horizontalPadding;
      if (!rootWidth) return;
      const fixedWidth =
        (leadingRef.current?.offsetWidth ?? 0) +
        (stateRef.current?.offsetWidth ?? 0) +
        CALENDAR_RESULT_FIELD_GAP * 2;
      const measureWidth = (element: HTMLElement | null) => {
        const width = Math.max(
          element?.scrollWidth ?? 0,
          element?.offsetWidth ?? 0
        );
        return width > 0 ? width + 1 : 0;
      };
      const next = allocateCalendarResultFieldWidths(
        {
          title: measureWidth(titleMeasureRef.current),
          address: measureWidth(addressMeasureRef.current),
          tags: measureWidth(tagsMeasureRef.current),
          resource: measureWidth(resourceMeasureRef.current)
        },
        Math.max(0, rootWidth - fixedWidth)
      );
      setWidths((current) =>
        current?.title === next.title &&
          current.address === next.address &&
          current.tags === next.tags &&
          current.resource === next.resource
          ? current
          : next
      );
    };
    recalculate();

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(recalculate);
    [
      rootRef.current,
      rootRef.current?.parentElement,
      rootRef.current?.closest(".timeline-scroll-shell"),
      leadingRef.current,
      stateRef.current,
      titleMeasureRef.current,
      addressMeasureRef.current,
      tagsMeasureRef.current,
      resourceMeasureRef.current
    ].forEach((element) => {
      if (element) observer?.observe(element);
    });
    void document.fonts?.ready.then(recalculate);

    return () => {
      active = false;
      observer?.disconnect();
    };
  }, [machine.address, machine.name, resourceText, stateLabel, tagKey]);

  const fieldStyle = (width: number | undefined) =>
    width === undefined ? undefined : { width };

  return (
    <span
      className="machine-strip-visible"
      ref={rootRef}
      style={{ columnGap: CALENDAR_RESULT_FIELD_GAP }}
    >
      <span className="machine-strip-leading" ref={leadingRef}>
        <ChevronDown className="machine-collapse-icon" size={15} />
        <Server size={16} />
      </span>
      <strong
        className="calendar-machine-name"
        style={fieldStyle(widths?.title)}
        title={machine.name}
      >
        {machine.name}
      </strong>
      {machine.address && (widths === null || widths.address > 0) && (
        <code style={fieldStyle(widths?.address)} title={machine.address}>
          {machine.address}
        </code>
      )}
      {machine.tags.length > 0 && (widths === null || widths.tags > 0) && (
        <span
          className="machine-strip-tags-field"
          style={fieldStyle(widths?.tags)}
        >
          <CalendarMachineTags tags={machine.tags} />
        </span>
      )}
      <span className={`state-chip machine-strip-state ${stateClass}`} ref={stateRef}>
        {stateLabel}
      </span>
      {(widths === null || widths.resource > 0) && (
        <span
          className="machine-resource-summary"
          style={fieldStyle(widths?.resource)}
          title={resourceText}
        >
          {resourceText}
        </span>
      )}
      <span className="machine-strip-measure" aria-hidden="true">
        <strong ref={titleMeasureRef}>{machine.name}</strong>
        {machine.address && <code ref={addressMeasureRef}>{machine.address}</code>}
        {machine.tags.length > 0 && (
          <span ref={tagsMeasureRef}>
            <CalendarMachineTags tags={machine.tags} />
          </span>
        )}
        <span className="machine-resource-summary" ref={resourceMeasureRef}>
          {resourceText}
        </span>
      </span>
    </span>
  );
}

export function CalendarResourceCell({
  group,
  longTermDisabled,
  maintenanceNow
}: {
  group: Omit<ResourceGroup, "version">;
  longTermDisabled: boolean;
  maintenanceNow: boolean;
}) {
  return (
    <div className="resource-cell">
      <span className="resource-copy">
        <strong title={group.name}>{group.name}</strong>
        <ResourceSummary value={group.resourceSummary} />
      </span>
      <span
        className={`state-chip ${longTermDisabled
            ? "disabled"
            : maintenanceNow
              ? "scheduled"
              : "active"
          }`}
      >
        {longTermDisabled
          ? tr("status.disabled")
          : maintenanceNow
            ? tr("维护")
            : tr("status.enabled")}
      </span>
    </div>
  );
}
