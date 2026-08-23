import { describe, expect, it } from "vitest";
import { resolveNotificationDestination } from "../src/notification-navigation";

describe("通知目标解析", () => {
  it("将注册和资料审核通知指向用户管理", () => {
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
  });

  it("解析正式的应用内链接", () => {
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
    ).toEqual({ path: "/feedback/550e8400-e29b-41d4-a716-446655440000" });
  });

  it("只为适合处理的通知提供目标", () => {
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

  it("机器申请进入对应机器的用户与权限页", () => {
    expect(
      resolveNotificationDestination({
        type: "MACHINE_ACCESS_REQUEST",
        link: "/admin/machines/43f88a10-a42e-4fe3-8a4a-2c434d4c20a7/users"
      })
    ).toEqual({
      path: "/admin/machines/43f88a10-a42e-4fe3-8a4a-2c434d4c20a7/users"
    });
  });
});
