import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_NUMBER_MESSAGE,
  getPasswordChecks,
  isEmployeeNumberValid,
  passwordIsValid
} from "../src/shared/identity-rules.js";
import {
  parseServerRegistrationErrors,
  validateEmail,
  validateRegistrationField,
  validateRegistrationForm,
  type RegistrationFormValues
} from "../src/registration-validation.js";

function validForm(
  overrides: Partial<RegistrationFormValues> = {}
): RegistrationFormValues {
  return {
    username: "测试用户",
    realName: "测试成员",
    employeeNumber: "12345678",
    email: "user@example.com",
    challengeId: "55f6e08a-69c7-4b4a-9f57-7cbbb1c717fe",
    challengeEmail: "user@example.com",
    code: "123456",
    password: "ValidPass123!",
    confirmPassword: "ValidPass123!",
    ...overrides
  };
}

describe("注册静态校验", () => {
  it("一次返回全部字段错误", () => {
    const errors = validateRegistrationForm(
      {
        username: "a",
        realName: "a",
        employeeNumber: "u1001",
        email: "bad-email",
        challengeId: "",
        challengeEmail: "",
        code: "12",
        password: "中文 password 1",
        confirmPassword: "different"
      },
      ["example.com"]
    );
    expect(Object.keys(errors).sort()).toEqual(
      [
        "code",
        "confirmPassword",
        "email",
        "employeeNumber",
        "password",
        "realName",
        "username"
      ].sort()
    );
  });

  it("按配置检查邮箱域名", () => {
    expect(validateEmail("user@outside.com", [])).toEqual([]);
    expect(validateEmail("user@outside.com", ["example.com"])).toEqual([
      "仅允许以下邮箱域名：example.com"
    ]);
    expect(validateEmail("user@example.com", ["example.com"])).toEqual([]);
  });

  it("邮件可选或关闭时不要求邮箱和验证码", () => {
    const blankEmail = validForm({
      email: "",
      challengeId: "",
      challengeEmail: "",
      code: ""
    });
    expect(validateRegistrationForm(blankEmail, ["example.com"], true)).toEqual(
      {}
    );
    expect(
      validateRegistrationForm(
        { ...blankEmail, email: "不会提交@example.com" },
        ["example.com"],
        false
      )
    ).toEqual({});
  });

  it("只接受两种工号格式", () => {
    expect(isEmployeeNumberValid("12345678")).toBe(true);
    expect(isEmployeeNumberValid("wx123456")).toBe(true);
    expect(isEmployeeNumberValid("WX1234567")).toBe(true);
    expect(isEmployeeNumberValid("1234567")).toBe(false);
    expect(isEmployeeNumberValid("wx12345")).toBe(false);
    expect(isEmployeeNumberValid("wx12345678")).toBe(false);
    expect(isEmployeeNumberValid("u1001")).toBe(false);
    expect(EMPLOYEE_NUMBER_MESSAGE).toBe("请输入合法工号");
  });

  it("验证码静态校验只检查六位长度", () => {
    expect(
      validateRegistrationField(
        "code",
        validForm({
          challengeId: "",
          challengeEmail: "",
          code: "123456"
        }),
        []
      )
    ).toEqual([]);
    expect(
      validateRegistrationField("code", validForm({ code: "12345" }), [])
    ).toEqual(["请输入6位验证码"]);
  });

  it("密码检查单以四个组合项实时反映全部规则", () => {
    const checks = getPasswordChecks("ValidPass123!", {
      username: "测试用户",
      employeeNumbers: ["12345678"]
    });
    expect(checks.map((check) => check.key)).toEqual([
      "format",
      "letter",
      "digit",
      "safeIdentity"
    ]);
    expect(checks.every((check) => check.met !== false)).toBe(true);
    expect(
      getPasswordChecks("PasswordOnly", {}).find(
        (check) => check.key === "digit"
      )?.met
    ).toBe(false);
    expect(
      getPasswordChecks("ValidPass123!", {}).find(
        (check) => check.key === "safeIdentity"
      )?.met
    ).toBeNull();
    expect(
      getPasswordChecks("password123", {
        username: "测试用户",
        employeeNumbers: ["12345678"]
      }).find((check) => check.key === "safeIdentity")?.met
    ).toBe(false);
    expect(
      getPasswordChecks("12345678", {}).find(
        (check) => check.key === "letter"
      )?.met
    ).toBe(false);
  });

  it("拒绝中文、空格、Unicode 和标识重复密码", () => {
    expect(passwordIsValid("Abcdefg1!")).toBe(true);
    expect(passwordIsValid("中文Abcdef1")).toBe(false);
    expect(passwordIsValid("Abc def1")).toBe(false);
    expect(passwordIsValid("Abcdef1😀")).toBe(false);
    expect(
      passwordIsValid("Employee123", {
        username: "Employee123"
      })
    ).toBe(false);
    expect(
      passwordIsValid("wx123456", {
        employeeNumbers: ["WX123456"]
      })
    ).toBe(false);
  });

  it("只解析受支持的服务端字段错误", () => {
    expect(
      parseServerRegistrationErrors({
        username: ["该用户名已被占用"],
        confirmPassword: ["不应由服务端返回"],
        unknown: ["忽略"],
        email: "错误格式"
      })
    ).toEqual({
      username: ["该用户名已被占用"]
    });
    expect(parseServerRegistrationErrors(null)).toBeNull();
  });

  it("合法表单不会产生静态错误", () => {
    expect(validateRegistrationForm(validForm(), ["example.com"])).toEqual({});
  });
});
