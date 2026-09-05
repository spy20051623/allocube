import { addDays, chinaLocalToIso } from "./date";
import type { OwnReservation, ReservationCategory, ReservationHistoryStatus } from "./shared/my-reservations";

export const MAX_RESERVATION_SELECTION = 100;
export type ReservationFilters = { machineId: string; from: string; to: string; historyStatus: ReservationHistoryStatus };
export const emptyReservationFilters: ReservationFilters = { machineId: "", from: "", to: "", historyStatus: "ALL" };

export function reservationPhase(item: Pick<OwnReservation, "status" | "startAt" | "endAt">, now: number) {
  if (item.status !== "CONFIRMED") return "CANCELLED" as const;
  if (Date.parse(item.endAt) <= now) return "ENDED" as const;
  return Date.parse(item.startAt) <= now ? "ACTIVE" as const : "UPCOMING" as const;
}

export function reservationQuery(category: ReservationCategory, filters: ReservationFilters) {
  const params = new URLSearchParams({ category, limit: category === "ACTIVE" ? "6" : "20" });
  if (category === "ACTIVE") return params.toString();
  if (filters.from && filters.to && filters.from > filters.to) return null;
  if (filters.machineId) params.set("machineId", filters.machineId);
  if (filters.from) {
    const from = chinaLocalToIso(`${filters.from}T00:00`);
    if (!from) return null;
    params.set("from", from);
  }
  if (filters.to) {
    const to = chinaLocalToIso(`${addDays(filters.to, 1)}T00:00`);
    if (!to) return null;
    params.set("to", to);
  }
  if (category === "HISTORY") params.set("historyStatus", filters.historyStatus);
  return params.toString();
}

export function selectReservationPage(
  selected: ReadonlyMap<string, OwnReservation>, rows: OwnReservation[], checked: boolean, now: number
) {
  const next = new Map(selected);
  for (const row of rows) {
    if (!checked) next.delete(row.id);
    else if (reservationPhase(row, now) === "UPCOMING" && !next.has(row.id) && next.size < MAX_RESERVATION_SELECTION) {
      // Keep the originally selected snapshot; background updates must not change consent.
      next.set(row.id, row);
    }
  }
  return next;
}

export function selectionIsCurrent(selected: OwnReservation[], latest: OwnReservation[], now: number) {
  const byId = new Map(latest.map((r) => [r.id, r]));
  return selected.every((r) => {
    const current = byId.get(r.id);
    return current && current.stateToken === r.stateToken && reservationPhase(current, now) === "UPCOMING";
  });
}

export class ReservationRequestGate {
  private id = 0;
  private controller: AbortController | null = null;
  start() {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.id;
    return { signal: controller.signal, current: () => id === this.id && !controller.signal.aborted };
  }
  cancel() { this.controller?.abort(); this.id++; }
}
