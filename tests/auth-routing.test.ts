import { describe, expect, it } from "vitest";
import { resolveAuthLocation } from "../src/auth-routing.js";

describe("认证页面路径", () => {
  it("解析四个独立认证页面", () => {
    expect(resolveAuthLocation("/login", "").path).toBe("/login");
    expect(resolveAuthLocation("/register", "").path).toBe("/register");
    expect(resolveAuthLocation("/forgot-password", "").path).toBe("/forgot-password");
    expect(resolveAuthLocation("/reset-password", "", "#token=abc").resetToken).toBe("abc");
  });

  it("未登录根地址和未知地址都规范化为登录页", () => {
    expect(resolveAuthLocation("/", "").canonicalUrl).toBe("/login");
    expect(resolveAuthLocation("/unknown", "").canonicalUrl).toBe("/login");
  });

  it("只从正式重置地址读取令牌", () => {
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
});
