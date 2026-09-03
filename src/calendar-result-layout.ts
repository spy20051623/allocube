export type CalendarResultFieldWidths = {
  title: number;
  address: number;
  tags: number;
  resource: number;
};

export const CALENDAR_RESULT_FIELD_GAP = 4;

const MIN_SECONDARY_FIELD_WIDTH = 48;

export function allocateCalendarResultFieldWidths(
  intrinsic: CalendarResultFieldWidths,
  availableWidth: number
): CalendarResultFieldWidths {
  const widths = { ...intrinsic };
  const totalWidth =
    widths.title +
    (widths.address > 0 ? CALENDAR_RESULT_FIELD_GAP + widths.address : 0) +
    (widths.tags > 0 ? CALENDAR_RESULT_FIELD_GAP + widths.tags : 0) +
    (widths.resource > 0 ? CALENDAR_RESULT_FIELD_GAP + widths.resource : 0);
  let overflow = Math.max(0, totalWidth - Math.max(0, availableWidth));

  for (const field of ["resource", "tags", "address"] as const) {
    if (overflow <= 0 || widths[field] <= 0) continue;
    const reducedWidth = widths[field] - overflow;
    if (reducedWidth >= MIN_SECONDARY_FIELD_WIDTH) {
      widths[field] = reducedWidth;
      overflow = 0;
      break;
    }
    overflow = Math.max(
      0,
      overflow - widths[field] - CALENDAR_RESULT_FIELD_GAP
    );
    widths[field] = 0;
  }

  if (overflow > 0) widths.title = Math.max(0, widths.title - overflow);
  return widths;
}
