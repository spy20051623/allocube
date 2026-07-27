import { describe, expect, it } from "vitest";
import { resolveNotificationDestination } from "../src/notification-navigation";
import { SourceRateLimiter } from "../server/source-rate-limit";
import { normalizeNotificationLink } from "../server/mailer";
import { buildPasswordResetUrl } from "../server/security-urls";
import { csvCell } from "../server/routes-admin";

describe("安全边界", () => {
  it("拒绝外部、协议相对、反斜杠和损坏的通知链接", () => {
    for (const link of [
      "https://attacker.invalid/calendar",
      "//attacker.invalid/calendar",
      "/\\attacker.invalid/calendar",
      "/calendar\u0000",
      "/%zz"
    ]) {
      expect(
        resolveNotificationDestination({ type: "UNKNOWN", link })
      ).toBeNull();
    }
  });

  it("服务端只保留同源站内通知链接", () => {
    expect(normalizeNotificationLink("/calendar?day=2026-07-27")).toBe(
      "/calendar?day=2026-07-27"
    );
    expect(normalizeNotificationLink("https://attacker.invalid/")).toBe("");
    expect(normalizeNotificationLink("//attacker.invalid/")).toBe("");
    expect(normalizeNotificationLink("/\\attacker.invalid/")).toBe("");
  });

  it("密码重置令牌只放在 URL 片段中，不会随 HTTP 请求或 Referer 发送", () => {
    const url = new URL(
      buildPasswordResetUrl("https://allocube.company.test", "a+b/c?d")
    );
    expect(url.pathname).toBe("/reset-password");
    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("token")).toBe("a+b/c?d");
  });

  it("按来源限制认证请求并给出剩余等待时间", () => {
    const limiter = new SourceRateLimiter();
    const policy = { max: 2, windowMs: 10_000 };
    expect(limiter.check("login:127.0.0.1", policy, 1_000)).toEqual({
      allowed: true
    });
    expect(limiter.check("login:127.0.0.1", policy, 1_001)).toEqual({
      allowed: true
    });
    expect(limiter.check("login:127.0.0.1", policy, 1_002)).toEqual({
      allowed: false,
      retryAfterSeconds: 10
    });
    expect(limiter.check("login:127.0.0.1", policy, 11_000)).toEqual({
      allowed: true
    });
  });

  it("达到来源键容量后拒绝新来源而不是无限增长", () => {
    const limiter = new SourceRateLimiter(1);
    const policy = { max: 2, windowMs: 10_000 };
    expect(limiter.check("source-a", policy, 1_000).allowed).toBe(true);
    expect(limiter.check("source-b", policy, 1_001)).toEqual({
      allowed: false,
      retryAfterSeconds: 60
    });
  });

  it("CSV 单元格阻止公式注入并正确转义引号", () => {
    expect(csvCell("=HYPERLINK(\"https://attacker.invalid\")")).toBe(
      "\"'=HYPERLINK(\"\"https://attacker.invalid\"\")\""
    );
    expect(csvCell("\t+cmd")).toBe("\"'\t+cmd\"");
    expect(csvCell("普通文本")).toBe("\"普通文本\"");
  });
});
