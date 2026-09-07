import type { TimelinePayload } from "./types";

function groupBy<T>(items: readonly T[], key: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    if (id === undefined) continue;
    const bucket = groups.get(id) ?? [];
    bucket.push(item);
    groups.set(id, bucket);
  }
  return groups;
}

/** Preserve server order and keep whole-machine events off resource-group tracks. */
export function indexTimeline(timeline: TimelinePayload | null) {
  const reservations = timeline?.reservations ?? [];
  const unavailability = timeline?.unavailability ?? [];
  return {
    reservationsByGroup: groupBy(reservations, item => item.scope === "MACHINE" ? undefined : item.resourceGroupId),
    machineReservationsByMachine: groupBy(reservations, item => item.scope === "MACHINE" ? item.machineId : undefined),
    unavailabilityByGroup: groupBy(unavailability, item => item.resourceGroupId || undefined),
    machineUnavailability: groupBy(unavailability, item => item.resourceGroupId ? undefined : item.machineId),
    groupsByMachine: groupBy(timeline?.groups ?? [], item => item.machineId)
  };
}
