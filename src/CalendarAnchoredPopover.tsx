import { X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { tr } from "./i18n/index";

const VIEWPORT_PADDING = 12;
const ANCHOR_GAP = 8;
const CALENDAR_POPOVER_WIDTH = 340;

type AnchorBounds = Pick<DOMRect, "left" | "right" | "top">;

export type CalendarPopoverViewport = {
  width: number;
  height: number;
};

export function calendarAnchoredPopoverPosition(
  anchor: AnchorBounds,
  popoverWidth: number,
  estimatedHeight: number,
  viewport: CalendarPopoverViewport
) {
  const preferredLeft = anchor.right + ANCHOR_GAP;
  const left =
    preferredLeft + popoverWidth <= viewport.width - VIEWPORT_PADDING
      ? preferredLeft
      : Math.max(
          VIEWPORT_PADDING,
          anchor.left - popoverWidth - ANCHOR_GAP
        );
  const top = Math.min(
    Math.max(VIEWPORT_PADDING, anchor.top - ANCHOR_GAP),
    Math.max(
      VIEWPORT_PADDING,
      viewport.height - estimatedHeight - VIEWPORT_PADDING
    )
  );
  return { left, top };
}

export function CalendarAnchoredPopover({
  anchor,
  ariaLabel,
  className = "",
  heading,
  badge,
  actions,
  onClose,
  children
}: {
  anchor: AnchorBounds;
  ariaLabel: string;
  className?: string;
  heading: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null
  );

  useLayoutEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const next = calendarAnchoredPopoverPosition(
      anchor,
      CALENDAR_POPOVER_WIDTH,
      popover.offsetHeight,
      { width: window.innerWidth, height: window.innerHeight }
    );
    setPosition((current) =>
      current?.left === next.left && current.top === next.top ? current : next
    );
  });

  const style: CSSProperties = {
    left: position?.left ?? VIEWPORT_PADDING,
    top: position?.top ?? VIEWPORT_PADDING,
    width: CALENDAR_POPOVER_WIDTH,
    visibility: position ? "visible" : "hidden"
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const handleViewportChange = () => onClose();
    const handleViewportScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        popoverRef.current?.contains(event.target)
      ) {
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportScroll, true);
    const focusFrame = window.requestAnimationFrame(() =>
      popoverRef.current?.focus()
    );
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportScroll, true);
    };
  }, [onClose]);

  return (
    <div className="reservation-popover-layer" onPointerDown={onClose}>
      <article
        ref={popoverRef}
        className={`reservation-popover${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="false"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={style}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="reservation-popover-head">
          <div>
            <strong>{heading}</strong>
            {badge}
          </div>
          <div className="reservation-popover-actions">
            {actions}
            <button
              className="reservation-popover-action"
              type="button"
              aria-label={tr("关闭")}
              title={tr("关闭")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>
        {children}
      </article>
    </div>
  );
}
