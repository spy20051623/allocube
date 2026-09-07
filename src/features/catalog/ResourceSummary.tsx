import { tr } from "../../i18n/index";
import { useId, useRef, useState, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

export function ResourceSummary({
  value,
  className = ""
}: {
  value: string;
  className?: string;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      left: Math.min(window.innerWidth - 340, Math.max(12, rect.left)),
      top: rect.bottom + 7
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
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
        {value || tr("尚未配置资源")}
      </span>
      {open && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className="resource-summary-popover"
          style={position}
        >
          {value || tr("尚未配置资源")}
        </span>,
        document.body
      )}
    </>
  );
}
