import { createHash } from "node:crypto";
import { BusinessError } from "./business-error.js";

// Only persisted reservation columns, never aliases from a joined list query.
const fields = [
  "id", "batch_id", "scope", "resource_group_id", "machine_id", "user_id",
  "start_at", "end_at", "initial_start_at", "initial_end_at",
  "parent_reservation_id", "adjusted_by_unavailability_id", "adjustment_type",
  "adjustment_reason", "title", "purpose", "note", "status", "snapshot_group_name",
  "snapshot_resource_config_json", "snapshot_group_version", "cancelled_at",
  "cancelled_by", "cancellation_reason", "created_at", "updated_at"
] as const;

export function reservationStateToken(row: Record<string, unknown>) {
  return createHash("sha256")
    .update(JSON.stringify(fields.map((field) => row[field] ?? null)))
    .digest("hex");
}

export function assertReservationState(row: Record<string, unknown>, expected?: string) {
  if (expected !== undefined && reservationStateToken(row) !== expected) {
    throw new BusinessError("占用记录已变化，请刷新后重新确认", 409, undefined, "RESERVATION_CHANGED");
  }
}
