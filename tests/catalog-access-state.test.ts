import { describe, expect, it } from "vitest";
import { resolveCatalogAccessDisplay } from "../src/catalog-access-state.js";

describe("全部资源卡片身份状态", () => {
  it("按系统管理员、机器管理员和使用权优先级显示身份", () => {
    expect(
      resolveCatalogAccessDisplay({
        userRole: "SYSTEM_ADMIN",
        isManager: false,
        hasAccess: true,
        hasPendingRequest: false
      })
    ).toEqual({
      state: "ADMIN",
      label: "管理员",
      action: null,
      actionLabel: null
    });
    expect(
      resolveCatalogAccessDisplay({
        userRole: "USER",
        isManager: true,
        hasAccess: true,
        hasPendingRequest: true
      })
    ).toEqual({
      state: "ADMIN",
      label: "管理员",
      action: "EXIT",
      actionLabel: "退出"
    });
    expect(
      resolveCatalogAccessDisplay({
        userRole: "USER",
        isManager: false,
        hasAccess: true,
        hasPendingRequest: true
      })
    ).toEqual({
      state: "USER",
      label: "使用者",
      action: "EXIT",
      actionLabel: "退出"
    });
  });

  it("无权限用户根据待审核状态显示撤回或申请", () => {
    expect(
      resolveCatalogAccessDisplay({
        userRole: "USER",
        isManager: false,
        hasAccess: false,
        hasPendingRequest: true
      })
    ).toEqual({
      state: "PENDING",
      label: "审核中",
      action: "WITHDRAW",
      actionLabel: "撤回"
    });
    expect(
      resolveCatalogAccessDisplay({
        userRole: "USER",
        isManager: false,
        hasAccess: false,
        hasPendingRequest: false
      })
    ).toEqual({
      state: "NO_ACCESS",
      label: "无权限",
      action: "APPLY",
      actionLabel: "申请"
    });
  });
});
