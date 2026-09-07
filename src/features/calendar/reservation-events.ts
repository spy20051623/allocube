import { tr } from "../../i18n/index";
import { type CalendarEventModel } from "../../CalendarEventVisual";
import { isoToChinaLocal } from "../../date";
import { type CalendarTimeRange, currentMinuteStart } from "../../calendar-state";
import type { TimelineReservation, AuthUser } from "../../shared/types";

export function reservationCalendarEvent(
  item: TimelineReservation
): CalendarEventModel {
  return {
    key: item.id,
    kind:
      item.scope === "MACHINE"
        ? "MACHINE_RESERVATION"
        : "GENERAL_RESERVATION",
    stage: "COMMITTED",
    startAt: item.startAt,
    endAt: item.endAt,
    label: `${item.scope === "MACHINE" ? tr("整机 · ") : ""}${item.applicantName
      }${item.applicantEmployeeNumber
        ? ` · ${item.applicantEmployeeNumber}`
        : ""
      }`,
    mine: item.mine
  };
}

export function draftCalendarEvent(
  draft: CalendarTimeRange & {
    scope?: "RESOURCE_GROUP" | "MACHINE";
  },
  user: AuthUser,
  key: string,
  preview: boolean
): CalendarEventModel {
  return {
    key,
    kind:
      draft.scope === "MACHINE"
        ? "MACHINE_RESERVATION"
        : "GENERAL_RESERVATION",
    stage: preview ? "DRAFT_PREVIEW" : "DRAFT",
    startAt: draft.startAt,
    endAt: draft.endAt,
    label: `${draft.scope === "MACHINE" ? tr("整机 · ") : ""}${user.displayName
      }${user.employeeNumber ? ` · ${user.employeeNumber}` : ""}`
  };
}

export function initialReservationTime(nowTime: number) {
  const startAt = currentMinuteStart(nowTime);
  const endAt = new Date(
    new Date(startAt).getTime() + 2 * 60 * 60 * 1000
  ).toISOString();
  return {
    start: isoToChinaLocal(startAt),
    end: isoToChinaLocal(endAt)
  };
}
