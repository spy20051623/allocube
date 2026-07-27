import { describe, expect, it } from "vitest";
import {
  verificationButtonLabel,
  verificationCooldownSeconds
} from "../src/auth-feedback.js";

describe("认证页面反馈", () => {
  it("使用固定截止时间计算验证码剩余秒数", () => {
    expect(verificationCooldownSeconds(null, 1_000)).toBe(0);
    expect(verificationCooldownSeconds(61_000, 1_000)).toBe(60);
    expect(verificationCooldownSeconds(60_001, 1_000)).toBe(60);
    expect(verificationCooldownSeconds(1_000, 1_001)).toBe(0);
  });

  it("验证码按钮文案不会因邮箱变化提前解除倒计时", () => {
    expect(
      verificationButtonLabel({
        sending: true,
        remainingSeconds: 0
      })
    ).toBe("发送中…");
    expect(
      verificationButtonLabel({
        sending: false,
        remainingSeconds: 59
      })
    ).toBe("59秒");
    expect(
      verificationButtonLabel({
        sending: false,
        remainingSeconds: 59
      })
    ).toBe("59秒");
    expect(
      verificationButtonLabel({
        sending: false,
        remainingSeconds: 0
      })
    ).toBe("获取验证码");
  });
});
