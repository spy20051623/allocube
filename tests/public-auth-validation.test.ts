import { describe, expect, it } from "vitest";
import {
  validateForgotPasswordEmail,
  validateResetPasswordForm
} from "../src/public-auth-validation.js";

describe("公开认证页面静态校验", () => {
  it("找回密码只检查通用邮箱格式，不使用注册域名白名单", () => {
    expect(validateForgotPasswordEmail("")).toEqual(["请输入有效的邮箱地址"]);
    expect(validateForgotPasswordEmail("bad-email")).toEqual([
      "请输入有效的邮箱地址"
    ]);
    expect(validateForgotPasswordEmail("user@outside.example")).toEqual([]);
  });

  it("设置新密码一次返回密码规则和确认密码错误", () => {
    const errors = validateResetPasswordForm("short", "");
    expect(errors.password).toEqual(
      expect.arrayContaining([
        "8–64个字符，仅使用英文字母、数字和常用半角符号",
        "包含数字"
      ])
    );
    expect(errors.confirmPassword).toEqual(["请再次输入密码"]);
  });

  it("确认密码必须与新密码完全一致", () => {
    expect(
      validateResetPasswordForm("NewPassword123!", "NewPassword123")
    ).toMatchObject({
      confirmPassword: ["两次输入的密码不一致"]
    });
    expect(
      validateResetPasswordForm("NewPassword123!", "NewPassword123!")
    ).toEqual({});
  });
});
