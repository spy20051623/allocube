import { describe, expect, it } from "vitest";
import {
  appPath,
  feedbackPath,
  isAppPath,
  machineAdminPath,
  resolveAppRoute
} from "../src/app-routing.js";

describe("应用页面路径", () => {
  it("为主要页面生成稳定、可读的路径", () => {
    expect(appPath("calendar")).toBe("/calendar");
    expect(appPath("resources")).toBe("/resources");
    expect(appPath("my")).toBe("/reservations");
    expect(appPath("announcements")).toBe("/announcements");
    expect(appPath("feedback")).toBe("/feedback");
    expect(appPath("profile")).toBe("/profile");
    expect(appPath("notifications")).toBe("/notifications");
  });

  it("为管理控制台生成独立子路径", () => {
    expect(appPath("admin", "machines")).toBe("/admin/machines");
    expect(appPath("admin", "users")).toBe("/admin/users");
    expect(appPath("admin", "report")).toBe("/admin/reports");
    expect(appPath("admin", "announcements")).toBe("/admin/announcements");
    expect(appPath("admin", "feedback")).toBe("/admin/feedback");
    expect(appPath("admin", "settings")).toBe("/admin/settings");
    expect(appPath("admin", "audit")).toBe("/admin/audit");
  });

  it("从路径恢复页面和管理标签", () => {
    expect(resolveAppRoute("/reservations")).toEqual({ page: "my" });
    expect(resolveAppRoute("/announcements/")).toEqual({ page: "announcements" });
    expect(resolveAppRoute("/admin/users")).toEqual({
      page: "admin",
      adminTab: "users"
    });
    expect(resolveAppRoute("/admin/settings/")).toEqual({
      page: "admin",
      adminTab: "settings"
    });
    expect(resolveAppRoute("/admin/announcements")).toEqual({
      page: "admin",
      adminTab: "announcements"
    });
    expect(resolveAppRoute("/feedback/550e8400-e29b-41d4-a716-446655440000")).toEqual({
      page: "feedback",
      feedbackId: "550e8400-e29b-41d4-a716-446655440000"
    });
    expect(resolveAppRoute("/admin/feedback/550e8400-e29b-41d4-a716-446655440000")).toEqual({
      page: "admin",
      adminTab: "feedback",
      feedbackId: "550e8400-e29b-41d4-a716-446655440000"
    });
    expect(feedbackPath("id/特殊")).toBe("/feedback/id%2F%E7%89%B9%E6%AE%8A");
    expect(resolveAppRoute("/admin/machines/machine-1/resources")).toEqual({
      page: "admin",
      adminTab: "machines",
      machineId: "machine-1",
      machineSection: "resources"
    });
    expect(machineAdminPath("machine/特殊", "users")).toBe(
      "/admin/machines/machine%2F%E7%89%B9%E6%AE%8A/users"
    );
    expect(
      resolveAppRoute("/admin/machines/machine%2F%E7%89%B9%E6%AE%8A/users")
    ).toMatchObject({
      machineId: "machine/特殊",
      machineSection: "users"
    });
  });

  it("不接受旧路径或未知路径", () => {
    expect(isAppPath("/calendar")).toBe(true);
    expect(isAppPath("/announcements")).toBe(true);
    expect(isAppPath("/feedback/example-id")).toBe(true);
    expect(isAppPath("/admin/feedback/example-id")).toBe(true);
    expect(isAppPath("/admin/machines/machine-1/info")).toBe(true);
    expect(isAppPath("/my")).toBe(false);
    expect(resolveAppRoute("/admin/machines/machine-1/unknown")).toBeNull();
    expect(resolveAppRoute("/#calendar")).toBeNull();
    expect(resolveAppRoute("/unknown")).toBeNull();
  });
});
