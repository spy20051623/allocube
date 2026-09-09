export const ADMIN_BOOKING_BLOCKED_MESSAGE = "系统管理员账号已禁止提交占用，请使用个人账号。";
export const ADMIN_BOOKING_DISABLED_CODE = "ADMIN_BOOKING_DISABLED";
export const MAX_BOOKING_ADVANCE_DAYS = 3650;

export function capBookingAdvanceDays(days: number) {
  return Math.min(days, MAX_BOOKING_ADVANCE_DAYS);
}

export function isAdminBookingBlocked(role: string, settings: { blockAdminBookings: boolean }) {
  return role === "SYSTEM_ADMIN" && settings.blockAdminBookings;
}
