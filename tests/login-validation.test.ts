import { describe, expect, it } from "vitest";
import {
  validateLoginField,
  validateLoginForm
} from "../src/login-validation.js";

describe("登录静态校验", () => {
  it("一次返回用户名登录的全部必填错误", () => {
    expect(validateLoginForm("USERNAME", "  ", "")).toEqual({
      identifier: "请输入用户名",
      password: "请输入密码"
    });
  });

  it("用户名登录不套用注册名称规则", () => {
    expect(validateLoginForm("USERNAME", "Administrator", "Admin12#$")).toEqual(
      {}
    );
  });

  it("区分空工号与格式错误", () => {
    expect(
      validateLoginField("EMPLOYEE_NUMBER", "identifier", "", "")
    ).toBe("请输入工号");
    expect(
      validateLoginField("EMPLOYEE_NUMBER", "identifier", "123", "")
    ).toBe("请输入合法工号");
  });

  it("允许两种合法工号格式", () => {
    expect(validateLoginForm("EMPLOYEE_NUMBER", "12345678", "secret")).toEqual(
      {}
    );
    expect(validateLoginForm("EMPLOYEE_NUMBER", "WX1234567", "secret")).toEqual(
      {}
    );
  });

  it("登录阶段只检查密码是否为空", () => {
    expect(
      validateLoginField("USERNAME", "password", "someone", "1")
    ).toBeNull();
  });
});
