import { localizeResourceSummary } from "../../resource-summary";
import { tr } from "../../i18n/index";
import { useId, useRef, useState, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { tooltipPosition } from "../../tooltip-position";

export function ResourceSummary({
  value,
  className = ""
}: {
  value: string;
  className?: string;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = popoverRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    const next = tooltipPosition(rect,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }, { gap: 7 });
    setPosition(current => current.left === next.left && current.top === next.top ? current : { left: next.left, top: next.top });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (popoverRef.current) observer.observe(popoverRef.current);
    if (anchorRef.current) observer.observe(anchorRef.current);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  return (
    <>
      <span
        ref={anchorRef}
        className={`resource-summary ${className}`.trim()}
        tabIndex={0}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {localizeResourceSummary(value) || tr("尚未配置资源")}
      </span>
      {open && createPortal(
        <span
          ref={popoverRef}
          id={tooltipId}
          role="tooltip"
          className="resource-summary-popover"
          style={position}
        >
          {localizeResourceSummary(value) || tr("尚未配置资源")}
        </span>,
        document.body
      )}
    </>
  );
}
