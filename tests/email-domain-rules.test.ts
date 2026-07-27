import { describe, expect, it } from "vitest";
import {
  EMAIL_DOMAIN_MESSAGE,
  normalizeAllowedEmailDomain,
  normalizeAllowedEmailDomains
} from "../src/shared/email-domain-rules";

describe("邮箱域名白名单规则", () => {
  it("统一大小写并去除重复域名", () => {
    expect(
      normalizeAllowedEmailDomains([" Company.TEST ", "example.com", "company.test"])
    ).toEqual(["company.test", "example.com"]);
  });

  it("拒绝协议、邮箱地址、通配符和不完整域名", () => {
    for (const value of [
      "https://company.test",
      "user@company.test",
      "*.company.test",
      "company",
      "-bad.example",
      "bad..example.com"
    ]) {
      expect(() => normalizeAllowedEmailDomain(value)).toThrow(
        EMAIL_DOMAIN_MESSAGE
      );
    }
  });
});
