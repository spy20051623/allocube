import { isAppPath } from "../app-routing.js";
import { resolveDocsRoute } from "../docs-routing.js";

export const ANNOUNCEMENT_INTERNAL_LINK_PREFIX = "allocube:";
export const ANNOUNCEMENT_SEEN_STORAGE_PREFIX =
  "allocube:seen-announcements:v1:";

export type AnnouncementLink =
  | { kind: "internal"; href: string }
  | { kind: "external"; href: string };

export function resolveAnnouncementLink(value: string | undefined): AnnouncementLink | null {
  const href = value?.trim() ?? "";
  if (!href) return null;

  if (href.toLowerCase().startsWith(ANNOUNCEMENT_INTERNAL_LINK_PREFIX)) {
    const target = href.slice(ANNOUNCEMENT_INTERNAL_LINK_PREFIX.length);
    if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
      return null;
    }
    const pathname = target.split(/[?#]/, 1)[0];
    const docsRoute = resolveDocsRoute(pathname);
    if (!isAppPath(pathname) && docsRoute?.kind !== "section") return null;
    return { kind: "internal", href: target };
  }

  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return { kind: "external", href: parsed.toString() };
  } catch {
    return null;
  }
}

export function invalidAnnouncementInternalLinks(markdown: string) {
  const invalid: string[] = [];
  for (const match of markdown.matchAll(/\]\(\s*(allocube:[^)\s]+)[^)]*\)/giu)) {
    if (!resolveAnnouncementLink(match[1])) invalid.push(match[1]);
  }
  return invalid;
}

export function announcementSeenStorageKey(userId: string) {
  return `${ANNOUNCEMENT_SEEN_STORAGE_PREFIX}${userId}`;
}

export function readSeenAnnouncementIds(
  userId: string,
  storage: Pick<Storage, "getItem">
) {
  try {
    const parsed = JSON.parse(storage.getItem(announcementSeenStorageKey(userId)) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : []
    );
  } catch {
    return new Set<string>();
  }
}

export function announcementSeenVersionKey(
  announcementId: string,
  version: number
) {
  return `${announcementId}:${version}`;
}

export function hasSeenAnnouncementVersion(
  seen: ReadonlySet<string>,
  announcementId: string,
  version: number
) {
  return (
    seen.has(announcementSeenVersionKey(announcementId, version)) ||
    (version === 1 && seen.has(announcementId))
  );
}

export function rememberSeenAnnouncement(
  userId: string,
  announcementId: string,
  version: number,
  storage: Pick<Storage, "getItem" | "setItem">
) {
  const ids = readSeenAnnouncementIds(userId, storage);
  ids.add(announcementSeenVersionKey(announcementId, version));
  storage.setItem(
    announcementSeenStorageKey(userId),
    JSON.stringify([...ids])
  );
}
