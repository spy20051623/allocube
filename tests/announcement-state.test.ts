import { describe, expect, it } from "vitest";
import {
  announcementSeenStorageKey,
  hasSeenAnnouncementVersion,
  readSeenAnnouncementIds,
  rememberSeenAnnouncement,
  resolveAnnouncementLink
} from "../src/shared/announcements.js";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("公告链接和本机展示状态", () => {
  it("只接受 HTTP(S) 外链和已知站内页面", () => {
    expect(resolveAnnouncementLink("https://example.org/help")).toMatchObject({
      kind: "external"
    });
    expect(resolveAnnouncementLink("allocube:/calendar?machine=one")).toEqual({
      kind: "internal",
      href: "/calendar?machine=one"
    });
    expect(resolveAnnouncementLink("allocube:/docs/api#commit")).toEqual({
      kind: "internal",
      href: "/docs/api#commit"
    });
    expect(resolveAnnouncementLink("javascript:alert(1)")).toBeNull();
    expect(resolveAnnouncementLink("allocube:/unknown")).toBeNull();
    expect(resolveAnnouncementLink("allocube://example.org")).toBeNull();
    expect(resolveAnnouncementLink("/calendar")).toBeNull();
  });

  it("按用户保存公告 ID，且能容忍损坏的本地数据", () => {
    const storage = new MemoryStorage();
    rememberSeenAnnouncement("user-a", "announcement-1", 1, storage);
    rememberSeenAnnouncement("user-a", "announcement-1", 1, storage);
    rememberSeenAnnouncement("user-a", "announcement-2", 3, storage);

    expect([...readSeenAnnouncementIds("user-a", storage)]).toEqual([
      "announcement-1:1",
      "announcement-2:3"
    ]);
    expect([...readSeenAnnouncementIds("user-b", storage)]).toEqual([]);

    storage.setItem(announcementSeenStorageKey("user-b"), "not-json");
    expect([...readSeenAnnouncementIds("user-b", storage)]).toEqual([]);
  });

  it("同一版本只展示一次，新版本会重新展示", () => {
    const seen = new Set(["announcement-1:2", "legacy-announcement"]);
    expect(hasSeenAnnouncementVersion(seen, "announcement-1", 2)).toBe(true);
    expect(hasSeenAnnouncementVersion(seen, "announcement-1", 3)).toBe(false);
    expect(hasSeenAnnouncementVersion(seen, "legacy-announcement", 1)).toBe(true);
    expect(hasSeenAnnouncementVersion(seen, "legacy-announcement", 2)).toBe(false);
  });
});
