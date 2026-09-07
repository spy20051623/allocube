import { isAppPath, type AppPath } from "./app-routing";

export type NotificationDestination = {
  path: AppPath;
};

type NotificationTargetInput = {
  type: string;
  link: string;
};

function internalTarget(link: string): AppPath | null {
  const value = link.trim();
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value, "https://local.invalid");
    return url.origin === "https://local.invalid" && isAppPath(url.pathname)
      ? url.pathname
      : null;
  } catch {
    return null;
  }
}

export function resolveNotificationDestination({
  type,
  link
}: NotificationTargetInput): NotificationDestination | null {
  if (type === "USER_APPROVAL" || type === "PROFILE_CHANGE_REVIEW") {
    return { path: "/admin/users" };
  }
  if (type === "MACHINE_ACCESS_REQUEST") {
    const path = internalTarget(link);
    return { path: path ?? "/admin/machines" };
  }
  const path = internalTarget(link);
  return path ? { path } : null;
}

export function notificationBadgeText(count: number) {
  return count > 99 ? "99+" : String(count);
}
