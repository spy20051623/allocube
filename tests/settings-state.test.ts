import { describe, expect, it } from "vitest";
import { smtpConfigurationIsDirty } from "../src/settings-state";

const settings = {
  host: "smtp.example.test", port: 465, security: "IMPLICIT_TLS",
  username: "sender", fromName: "Allocube", fromAddress: "sender@example.test"
};

describe("系统设置未保存状态", () => {
  it("首次加载没有邮件配置基准时，不阻止应用服务端设置", () => {
    expect(smtpConfigurationIsDirty(null, { ...settings, host: "", username: "" }, "", false)).toBe(false);
  });

  it("加载完成或保存后的原样表单没有未保存修改", () => {
    expect(smtpConfigurationIsDirty(settings, { ...settings }, "", false)).toBe(false);
  });

  it.each([
    { host: "other.example.test" }, { port: 587 }, { security: "STARTTLS" },
    { username: "other" }, { fromName: "New name" }, { fromAddress: "other@example.test" }
  ])("修改连接或发件配置时保留草稿：%j", change => {
    expect(smtpConfigurationIsDirty(settings, { ...settings, ...change }, "", false)).toBe(true);
  });

  it("更换或清除密码也属于未保存修改", () => {
    expect(smtpConfigurationIsDirty(settings, settings, "new password", false)).toBe(true);
    expect(smtpConfigurationIsDirty(settings, settings, "", true)).toBe(true);
  });
});
