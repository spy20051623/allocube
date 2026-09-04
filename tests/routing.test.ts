import { describe, expect, it } from "vitest";
import {
  appPath,
  feedbackPath,
  isAppPath,
  machineAdminPath,
  resolveAppRoute
} from "../src/app-routing.js";
import { resolveAuthLocation } from "../src/auth-routing.js";
import { docsPath, docsPaths, resolveDocsRoute } from "../src/docs-routing.js";
import { resolveNotificationDestination } from "../src/notification-navigation.js";

describe("页面与通知路由", () => {
  it("生成并解析应用页面路径", () => {
    expect(appPath("calendar")).toBe("/calendar");
    expect(appPath("resources")).toBe("/resources");
    expect(appPath("my")).toBe("/reservations");
    expect(appPath("announcements")).toBe("/announcements");
    expect(appPath("feedback")).toBe("/feedback");
    expect(appPath("profile")).toBe("/profile");
    expect(appPath("notifications")).toBe("/notifications");
    expect(appPath("admin", "machines")).toBe("/admin/machines");
    expect(appPath("admin", "users")).toBe("/admin/users");
    expect(appPath("admin", "report")).toBe("/admin/reports");
    expect(appPath("admin", "announcements")).toBe("/admin/announcements");
    expect(appPath("admin", "feedback")).toBe("/admin/feedback");
    expect(appPath("admin", "settings")).toBe("/admin/settings");
    expect(appPath("admin", "audit")).toBe("/admin/audit");

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
    expect(feedbackPath("id/特殊")).toBe("/feedback/id%2F%E7%89%B9%E6%AE%8A");
    expect(
      resolveAppRoute("/feedback/550e8400-e29b-41d4-a716-446655440000")
    ).toEqual({
      page: "feedback",
      feedbackId: "550e8400-e29b-41d4-a716-446655440000"
    });
    expect(
      resolveAppRoute("/admin/feedback/550e8400-e29b-41d4-a716-446655440000")
    ).toEqual({
      page: "admin",
      adminTab: "feedback",
      feedbackId: "550e8400-e29b-41d4-a716-446655440000"
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
    expect(isAppPath("/calendar")).toBe(true);
    expect(isAppPath("/feedback/example-id")).toBe(true);
    expect(isAppPath("/admin/machines/machine-1/info")).toBe(true);
    expect(isAppPath("/my")).toBe(false);
    expect(resolveAppRoute("/admin/machines/machine-1/unknown")).toBeNull();
    expect(resolveAppRoute("/#calendar")).toBeNull();
    expect(resolveAppRoute("/unknown")).toBeNull();
  });

  it("解析认证路径并只从正式重置地址读取令牌", () => {
    expect(resolveAuthLocation("/login", "").path).toBe("/login");
    expect(resolveAuthLocation("/register", "").path).toBe("/register");
    expect(resolveAuthLocation("/forgot-password", "").path).toBe(
      "/forgot-password"
    );
    expect(resolveAuthLocation("/", "").canonicalUrl).toBe("/login");
    expect(resolveAuthLocation("/unknown", "").canonicalUrl).toBe("/login");
    expect(
      resolveAuthLocation("/reset-password", "", "#token=a%2Bb%2Fc").resetToken
    ).toBe("a+b/c");
    expect(
      resolveAuthLocation("/reset-password", "?token=query-token").resetToken
    ).toBe("");
    expect(resolveAuthLocation("/", "?reset=old-token").canonicalUrl).toBe(
      "/login"
    );
  });

  it("生成并解析公开文档路径", () => {
    for (const path of docsPaths) {
      expect(resolveDocsRoute(path)).toMatchObject({ kind: "section" });
      expect(resolveDocsRoute(`${path}/`)).toEqual(resolveDocsRoute(path));
    }
    expect(docsPath("overview")).toBe("/docs");
    expect(docsPath("troubleshooting")).toBe("/docs/troubleshooting");
    expect(resolveDocsRoute("/docs")).toEqual({
      kind: "section",
      slug: "overview"
    });
    expect(resolveDocsRoute("/docs/api")).toEqual({
      kind: "section",
      slug: "api"
    });
    expect(resolveDocsRoute("/docs/not-a-section")).toEqual({
      kind: "not-found",
      pathname: "/docs/not-a-section"
    });
    expect(resolveDocsRoute("/calendar")).toBeNull();
  });

  it("只为可处理的站内通知生成目标", () => {
    expect(
      resolveNotificationDestination({
        type: "USER_APPROVAL",
        link: "/admin/users"
      })
    ).toEqual({ path: "/admin/users" });
    expect(
      resolveNotificationDestination({
        type: "PROFILE_CHANGE_REVIEW",
        link: "/"
      })
    ).toEqual({ path: "/admin/users" });
    expect(
      resolveNotificationDestination({
        type: "RESERVATION_CANCELLED",
        link: "/reservations"
      })
    ).toEqual({ path: "/reservations" });
    expect(
      resolveNotificationDestination({
        type: "PROFILE_CHANGE_APPROVED",
        link: "/profile"
      })
    ).toEqual({ path: "/profile" });
    expect(
      resolveNotificationDestination({
        type: "FEEDBACK_STATUS_CHANGED",
        link: "/feedback/550e8400-e29b-41d4-a716-446655440000"
      })
    ).toEqual({
      path: "/feedback/550e8400-e29b-41d4-a716-446655440000"
    });
    expect(
      resolveNotificationDestination({
        type: "MACHINE_ACCESS_REQUEST",
        link: "/admin/machines/43f88a10-a42e-4fe3-8a4a-2c434d4c20a7/users"
      })
    ).toEqual({
      path: "/admin/machines/43f88a10-a42e-4fe3-8a4a-2c434d4c20a7/users"
    });
    expect(
      resolveNotificationDestination({
        type: "REGISTRATION_SUBMITTED",
        link: "/"
      })
    ).toBeNull();
    expect(
      resolveNotificationDestination({
        type: "UNKNOWN",
        link: "https://example.com/"
      })
    ).toBeNull();
  });
});
