export type Page =
  | "calendar"
  | "resources"
  | "my"
  | "profile"
  | "notifications"
  | "admin";

export type AdminTab = "machines" | "users" | "report" | "settings" | "audit";
export type MachineAdminSection = "info" | "resources" | "users";

export const appPaths = [
  "/calendar",
  "/resources",
  "/reservations",
  "/profile",
  "/notifications",
  "/admin/machines",
  "/admin/users",
  "/admin/reports",
  "/admin/settings",
  "/admin/audit"
] as const;

export type StaticAppPath = (typeof appPaths)[number];
export type AppPath =
  | StaticAppPath
  | `/admin/machines/${string}/${MachineAdminSection}`;

export type ResolvedAppRoute = {
  page: Page;
  adminTab?: AdminTab;
  machineId?: string;
  machineSection?: MachineAdminSection;
};

const canonicalRoutes = new Map<StaticAppPath, ResolvedAppRoute>([
  ["/calendar", { page: "calendar" }],
  ["/resources", { page: "resources" }],
  ["/reservations", { page: "my" }],
  ["/profile", { page: "profile" }],
  ["/notifications", { page: "notifications" }],
  ["/admin/machines", { page: "admin", adminTab: "machines" }],
  ["/admin/users", { page: "admin", adminTab: "users" }],
  ["/admin/reports", { page: "admin", adminTab: "report" }],
  ["/admin/settings", { page: "admin", adminTab: "settings" }],
  ["/admin/audit", { page: "admin", adminTab: "audit" }]
]);

export function appPath(page: Page, adminTab: AdminTab = "machines"): StaticAppPath {
  if (page === "calendar") return "/calendar";
  if (page === "resources") return "/resources";
  if (page === "my") return "/reservations";
  if (page === "profile") return "/profile";
  if (page === "notifications") return "/notifications";
  if (adminTab === "users") return "/admin/users";
  if (adminTab === "report") return "/admin/reports";
  if (adminTab === "settings") return "/admin/settings";
  if (adminTab === "audit") return "/admin/audit";
  return "/admin/machines";
}

export function resolveAppRoute(pathname: string): ResolvedAppRoute | null {
  const normalized = normalizePathname(pathname);
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
    /^\/admin\/machines\/[^/]+\/(info|resources|users)$/.test(normalized)
  );
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
