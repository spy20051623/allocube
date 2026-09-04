import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/App.tsx", import.meta.url),
  "utf8"
);

describe("登录表单结构", () => {
  it("用户名和工号登录复用同一个表单组件", () => {
    expect(source.match(/function LoginCredentialForm\(/g)).toHaveLength(1);
    expect(source.match(/<LoginCredentialForm/g)).toHaveLength(2);
    expect(source).not.toContain("function UsernameLoginForm(");
    expect(source).not.toContain("function EmployeeNumberLoginForm(");
  });

  it("保留两套表单与标签页的稳定关联", () => {
    expect(source).toContain(
      'const formPrefix = usernameLogin ? "username" : "employee-number";'
    );
    expect(source).toContain('aria-controls="username-login-form"');
    expect(source).toContain('aria-controls="employee-number-login-form"');
    expect(source).toContain('aria-labelledby={`${formPrefix}-login-tab`}');
  });

  it("仅规范化工号输入的大小写", () => {
    expect(source).toMatch(
      /usernameLogin\s+\? event\.target\.value\s+: event\.target\.value\.toLowerCase\(\)/
    );
  });
});
