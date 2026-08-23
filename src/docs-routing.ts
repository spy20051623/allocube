export const docsSlugs = [
  "overview",
  "getting-started",
  "user-guide",
  "machine-admin",
  "system-admin",
  "operations",
  "api",
  "troubleshooting"
] as const;

export type DocsSlug = (typeof docsSlugs)[number];

export type ResolvedDocsRoute =
  | { kind: "section"; slug: DocsSlug }
  | { kind: "not-found"; pathname: string };

export const docsPaths = [
  "/docs",
  "/docs/getting-started",
  "/docs/user-guide",
  "/docs/machine-admin",
  "/docs/system-admin",
  "/docs/operations",
  "/docs/api",
  "/docs/troubleshooting"
] as const;

const routeByPath = new Map<string, DocsSlug>([
  ["/docs", "overview"],
  ["/docs/getting-started", "getting-started"],
  ["/docs/user-guide", "user-guide"],
  ["/docs/machine-admin", "machine-admin"],
  ["/docs/system-admin", "system-admin"],
  ["/docs/operations", "operations"],
  ["/docs/api", "api"],
  ["/docs/troubleshooting", "troubleshooting"]
]);

export function docsPath(slug: DocsSlug) {
  return slug === "overview" ? "/docs" : (`/docs/${slug}` as const);
}

export function resolveDocsRoute(pathname: string): ResolvedDocsRoute | null {
  const normalized = normalizeDocsPathname(pathname);
  const slug = routeByPath.get(normalized);
  if (slug) return { kind: "section", slug };
  if (normalized === "/docs" || normalized.startsWith("/docs/")) {
    return { kind: "not-found", pathname: normalized };
  }
  return null;
}

function normalizeDocsPathname(pathname: string) {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "");
}
