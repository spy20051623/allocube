export type Page =
  | "calendar"
  | "resources"
  | "my"
  | "announcements"
  | "feedback"
  | "profile"
  | "notifications"
  | "admin";

export type AdminTab =
  | "machines"
  | "users"
  | "report"
  | "announcements"
  | "feedback"
  | "settings"
  | "audit";
export type MachineAdminSection = "info" | "resources" | "users";

export const appPaths = [
  "/calendar",
  "/resources",
  "/reservations",
  "/announcements",
  "/feedback",
  "/profile",
  "/notifications",
  "/admin/machines",
  "/admin/users",
  "/admin/reports",
  "/admin/announcements",
  "/admin/feedback",
  "/admin/settings",
  "/admin/audit"
] as const;

export type StaticAppPath = (typeof appPaths)[number];
export type AppPath =
  | StaticAppPath
  | `/admin/machines/${string}/${MachineAdminSection}`
  | `/feedback/${string}`
  | `/admin/feedback/${string}`;

export type ResolvedAppRoute = {
  page: Page;
  adminTab?: AdminTab;
  machineId?: string;
  machineSection?: MachineAdminSection;
  feedbackId?: string;
};

const canonicalRoutes = new Map<StaticAppPath, ResolvedAppRoute>([
  ["/calendar", { page: "calendar" }],
  ["/resources", { page: "resources" }],
  ["/reservations", { page: "my" }],
  ["/announcements", { page: "announcements" }],
  ["/feedback", { page: "feedback" }],
  ["/profile", { page: "profile" }],
  ["/notifications", { page: "notifications" }],
  ["/admin/machines", { page: "admin", adminTab: "machines" }],
  ["/admin/users", { page: "admin", adminTab: "users" }],
  ["/admin/reports", { page: "admin", adminTab: "report" }],
  ["/admin/announcements", { page: "admin", adminTab: "announcements" }],
  ["/admin/feedback", { page: "admin", adminTab: "feedback" }],
  ["/admin/settings", { page: "admin", adminTab: "settings" }],
  ["/admin/audit", { page: "admin", adminTab: "audit" }]
]);

export function appPath(page: Page, adminTab: AdminTab = "machines"): StaticAppPath {
  if (page === "calendar") return "/calendar";
  if (page === "resources") return "/resources";
  if (page === "my") return "/reservations";
  if (page === "announcements") return "/announcements";
  if (page === "feedback") return "/feedback";
  if (page === "profile") return "/profile";
  if (page === "notifications") return "/notifications";
  if (adminTab === "users") return "/admin/users";
  if (adminTab === "report") return "/admin/reports";
  if (adminTab === "announcements") return "/admin/announcements";
  if (adminTab === "feedback") return "/admin/feedback";
  if (adminTab === "settings") return "/admin/settings";
  if (adminTab === "audit") return "/admin/audit";
  return "/admin/machines";
}

export function resolveAppRoute(pathname: string): ResolvedAppRoute | null {
  const normalized = normalizePathname(pathname);
  const feedbackRoute = normalized.match(/^\/(admin\/)?feedback\/([^/]+)$/);
  if (feedbackRoute) {
    let feedbackId: string;
    try {
      feedbackId = decodeURIComponent(feedbackRoute[2]);
    } catch {
      return null;
    }
    return feedbackRoute[1]
      ? { page: "admin", adminTab: "feedback", feedbackId }
      : { page: "feedback", feedbackId };
  }
  const machineRoute = normalized.match(
    /^\/admin\/machines\/([^/]+)\/(info|resources|users)$/
  );
  if (machineRoute) {
    let machineId: string;
    try {
      machineId = decodeURIComponent(machineRoute[1]);
    } catch {
      return null;
    }
    return {
      page: "admin",
      adminTab: "machines",
      machineId,
      machineSection: machineRoute[2] as MachineAdminSection
    };
  }
  return canonicalRoutes.get(normalized as StaticAppPath) ?? null;
}

export function isAppPath(value: string): value is AppPath {
  const normalized = normalizePathname(value);
  return (
    canonicalRoutes.has(normalized as StaticAppPath) ||
    /^\/admin\/machines\/[^/]+\/(info|resources|users)$/.test(normalized) ||
    /^\/(admin\/)?feedback\/[^/]+$/.test(normalized)
  );
}

export function feedbackPath(feedbackId: string, admin = false) {
  const segment = encodeURIComponent(feedbackId);
  return `${admin ? "/admin" : ""}/feedback/${segment}` as AppPath;
}

export function machineAdminPath(
  machineId: string,
  section: MachineAdminSection = "info"
) {
  return `/admin/machines/${encodeURIComponent(machineId)}/${section}` as const;
}

function normalizePathname(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}
