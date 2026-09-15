type Bounds = { left: number; right: number; top: number; bottom: number };

// Sizes must come from the rendered panel, not from its item count.
export function tooltipPosition(
  anchor: Bounds,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  options: { align?: "start" | "center"; bounds?: Pick<Bounds, "left" | "right">; gap?: number } = {}
): { left: number; top: number; placement: "above" | "below" } {
  const padding = 12;
  const gap = options.gap ?? 8;
  const below = viewport.height - padding - anchor.bottom - gap;
  const above = anchor.top - padding - gap;
  const placement = below < panel.height && above > below ? "above" : "below";
  const top = Math.max(padding, Math.min(
    placement === "above" ? anchor.top - panel.height - gap : anchor.bottom + gap,
    viewport.height - padding - panel.height
  ));
  let minLeft = Math.max(padding, options.bounds?.left ?? padding);
  let maxRight = Math.min(viewport.width - padding, options.bounds?.right ?? viewport.width - padding);
  if (maxRight - minLeft < panel.width) {
    minLeft = padding;
    maxRight = viewport.width - padding;
  }
  const preferredLeft = options.align === "center"
    ? (anchor.left + anchor.right - panel.width) / 2
    : anchor.left;
  const left = Math.max(minLeft, Math.min(preferredLeft, maxRight - panel.width));
  return { left, top, placement };
}
