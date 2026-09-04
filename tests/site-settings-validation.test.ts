import { describe, expect, it } from "vitest";
import {
  EMAIL_DOMAIN_MESSAGE,
  normalizeAllowedEmailDomain,
  normalizeAllowedEmailDomains
} from "../src/shared/email-domain-rules.js";
import { icpFilingValidationError } from "../src/shared/icp-filing.js";
import {
  publicSecurityFilingCode,
  publicSecurityFilingUrl,
  publicSecurityFilingValidationError
} from "../src/shared/public-security-filing.js";
import { siteOriginValidationError } from "../src/shared/site-origin.js";

describe("站点设置校验", () => {
  it("校验站点地址", () => {
    for (const value of [
      "https://allocube.company.test",
      "https://allocube.company.test/",
      "https://allocube.company.test:8443",
      "http://allocube.company.test",
      "http://192.168.1.10:38887",
      "http://localhost:5173"
    ]) {
      expect(siteOriginValidationError(value), value).toBeNull();
    }
    expect(siteOriginValidationError("https://allocube.example.com")).toContain(
      "示例域名"
    );
    for (const value of [
      "https://allocube.company.test/app",
      "https://allocube.company.test/?a=1",
      "https://allocube.company.test/#top",
      "https://user:pass@allocube.company.test",
      "http://user:pass@192.168.1.10:5173",
      "allocube.example.com",
      ""
    ]) {
      expect(siteOriginValidationError(value), value).not.toBeNull();
    }
  });

  it("校验 ICP 备案号", () => {
    for (const value of [
      "浙ICP备12345678号-1",
      "京ICP备12345678号-2",
      "粤ICP备12345678号-12",
      ""
    ]) {
      expect(icpFilingValidationError(value), value).toBeNull();
    }
    expect(icpFilingValidationError("浙ICP备12345678号")).not.toBeNull();
    expect(icpFilingValidationError("AICP备12345678号-1")).not.toBeNull();
  });

  it("校验公安备案信息并生成查询链接", () => {
    const filingNumber = "京公网安备 11000000000000号";
    expect(publicSecurityFilingValidationError(filingNumber)).toBeNull();
    expect(publicSecurityFilingCode(filingNumber)).toBe("11000000000000");
    expect(publicSecurityFilingUrl(filingNumber)).toBe(
      "https://beian.mps.gov.cn/#/query/webSearch?code=11000000000000"
    );
    expect(publicSecurityFilingValidationError("")).toBeNull();
    expect(publicSecurityFilingUrl("")).toBe("");
    expect(publicSecurityFilingValidationError("京公网安备 123号")).toBe(
      "请输入正确的公安备案号，如：省公网安备 11000000000000号（请将“省”替换为省份简称）"
    );
  });

  it("规范化并校验注册邮箱域名", () => {
    expect(
      normalizeAllowedEmailDomains([
        " Company.TEST ",
        "example.com",
        "company.test"
      ])
    ).toEqual(["company.test", "example.com"]);
    for (const value of [
      "https://company.test",
      "user@company.test",
      "*.company.test",
      "company",
      "-bad.example",
      "bad..example.com"
    ]) {
      expect(() => normalizeAllowedEmailDomain(value), value).toThrow(
        EMAIL_DOMAIN_MESSAGE
      );
    }
  });
});
