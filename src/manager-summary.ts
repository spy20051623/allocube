export function calculateVisibleManagerCount(
  availableWidth: number,
  itemWidths: number[],
  overflowButtonWidth: number,
  gap: number
) {
  if (!itemWidths.length || availableWidth <= 0) return 0;

  const completeListWidth =
    itemWidths.reduce((total, width) => total + width, 0) +
    gap * Math.max(0, itemWidths.length - 1);
  if (completeListWidth <= availableWidth) return itemWidths.length;

  let usedWidth = overflowButtonWidth;
  let visibleCount = 0;
  for (const itemWidth of itemWidths) {
    const nextWidth = usedWidth + gap + itemWidth;
    if (nextWidth > availableWidth) break;
    usedWidth = nextWidth;
    visibleCount += 1;
  }
  return visibleCount;
}
