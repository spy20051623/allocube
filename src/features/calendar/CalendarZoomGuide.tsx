import { X, ZoomIn } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { tr } from "../../i18n/index";

export function CalendarZoomGuide({ anchorRef, onDismiss }: {
  anchorRef: RefObject<HTMLDivElement | null>;
  onDismiss: () => void;
}) {
  const guideRef = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; arrow: number | null; above: boolean } | null>(null);
  const message = tr("系统更新已将默认缩放调整至 24 小时。可点击工具栏 − / +，或按住 Alt 并滚动滚轮缩放。");

  useLayoutEffect(() => {
    const anchor = anchorRef.current, guide = guideRef.current;
    if (!anchor || !guide) return;
    const toolbar = anchor.closest(".toolbar");
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const container = toolbar?.getBoundingClientRect() ?? rect;
      if (container.bottom <= 0 || container.top >= window.innerHeight) {
        setPosition(null);
        return;
      }
      // On narrow screens the toolbar scrolls; keep the tip visible without scrolling it.
      const anchorVisible = rect.left >= Math.max(0, container.left) && rect.right <= Math.min(window.innerWidth, container.right);
      const target = anchorVisible ? rect : container;
      const center = (target.left + target.right) / 2;
      const width = guide.offsetWidth, height = guide.offsetHeight;
      const left = Math.max(12, Math.min(center - width / 2, window.innerWidth - width - 12));
      const above = target.top >= height + 20;
      const top = Math.max(12, Math.min(above ? target.top - height - 8 : target.bottom + 8, window.innerHeight - height - 12));
      const arrow = anchorVisible ? Math.max(16, Math.min(width - 16, center - left)) : null;
      setPosition(current => current?.left === left && current.top === top && current.arrow === arrow && current.above === above
        ? current : { left, top, arrow, above });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(guide);
    observer.observe(anchor);
    if (toolbar) observer.observe(toolbar);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, message]);

  return createPortal(
    <aside ref={guideRef} className={`calendar-zoom-guide${position?.above ? " above" : " below"}`}
      role="note" aria-label={tr("时间轴缩放")}
      style={{ left: position?.left, top: position?.top, visibility: position ? "visible" : "hidden", "--guide-arrow-left": `${position?.arrow ?? 0}px` } as CSSProperties}>
      {position?.arrow != null && <i className="calendar-zoom-guide-arrow" aria-hidden="true" />}
      <ZoomIn size={16} aria-hidden="true" />
      <span>{message}</span>
      <button type="button" aria-label={tr("关闭缩放提示")} title={tr("关闭缩放提示")}
        onClick={onDismiss} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onDismiss(); } }}>
        <X size={14} aria-hidden="true" />
      </button>
    </aside>, document.body
  );
}
