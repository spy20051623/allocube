import { db, getSettings } from "./db.js";
import { BusinessError } from "./business-error.js";
import { ADMIN_BOOKING_BLOCKED_MESSAGE, ADMIN_BOOKING_DISABLED_CODE, isAdminBookingBlocked } from "../src/shared/booking-policy.js";

/** Read the current policy and role again inside each reservation write transaction. */
export function assertUserCanSubmitReservations(userId: string) {
  const settings = getSettings();
  if (!settings.blockAdminBookings) return;
  const user = db.prepare("SELECT role FROM users WHERE id = ?").get(userId) as { role: string } | undefined;
  if (user && isAdminBookingBlocked(user.role, settings)) {
    throw new BusinessError(ADMIN_BOOKING_BLOCKED_MESSAGE, 403, undefined, ADMIN_BOOKING_DISABLED_CODE);
  }
}
