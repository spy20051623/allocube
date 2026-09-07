import { useRef, useCallback, useEffect } from "react";
import { timelineDragAutoScrollDelta } from "../../calendar-state";
import { type CalendarDragState } from "./types";
import { TIMELINE_RESOURCE_COLUMN_WIDTH } from "./layout";

export function useDragAutoScroll({ dragState, timelineShellRef, timelineHorizontalScrollRef, dragPreviewUpdaterRef }: { dragState: React.RefObject<CalendarDragState | null>; timelineShellRef: React.RefObject<HTMLDivElement | null>; timelineHorizontalScrollRef: React.RefObject<HTMLDivElement | null>; dragPreviewUpdaterRef: React.RefObject<(active: CalendarDragState, endClientX: number) => void>; }) {
  const dragAutoScrollFrameRef = useRef<number | null>(null);

  const dragAutoScrollTickRef = useRef<FrameRequestCallback>(() => undefined);

  const stopDragAutoScroll = useCallback(() => {
    if (dragAutoScrollFrameRef.current === null) return;
    window.cancelAnimationFrame(dragAutoScrollFrameRef.current);
    dragAutoScrollFrameRef.current = null;
  }, []);

  dragAutoScrollTickRef.current = () => {
    dragAutoScrollFrameRef.current = null;
    const active = dragState.current;
    const shell = timelineShellRef.current;
    if (!active?.engaged || !shell) return;
    const shellRect = shell.getBoundingClientRect();
    const delta = timelineDragAutoScrollDelta({
      pointer: active.lastX,
      viewportStart: shellRect.left + TIMELINE_RESOURCE_COLUMN_WIDTH,
      viewportEnd: shellRect.left + shell.clientWidth
    });
    if (delta === 0) return;
    const maximum = Math.max(0, shell.scrollWidth - shell.clientWidth);
    const nextScrollLeft = Math.max(
      0,
      Math.min(maximum, shell.scrollLeft + delta)
    );
    if (Math.abs(nextScrollLeft - shell.scrollLeft) < 0.5) return;
    shell.scrollLeft = nextScrollLeft;
    if (timelineHorizontalScrollRef.current) {
      timelineHorizontalScrollRef.current.scrollLeft = nextScrollLeft;
    }
    dragPreviewUpdaterRef.current(active, active.lastX);
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(
      dragAutoScrollTickRef.current
    );
  };

  const startDragAutoScroll = useCallback(() => {
    if (dragAutoScrollFrameRef.current !== null) return;
    dragAutoScrollFrameRef.current = window.requestAnimationFrame(
      dragAutoScrollTickRef.current
    );
  }, []);

  useEffect(() => stopDragAutoScroll, [stopDragAutoScroll]);
  return { startDragAutoScroll, stopDragAutoScroll };
}
