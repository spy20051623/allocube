import { describe, expect, it } from "vitest";
import {
  publicSecurityFilingCode,
  publicSecurityFilingUrl,
  publicSecurityFilingValidationError
} from "../src/shared/public-security-filing";

describe("公安备案信息", () => {
  it("从完整备案号生成公安部查询链接", () => {
    const filingNumber = "京公网安备 11000000000000号";
    expect(publicSecurityFilingValidationError(filingNumber)).toBeNull();
    expect(publicSecurityFilingCode(filingNumber)).toBe("11000000000000");
    expect(publicSecurityFilingUrl(filingNumber)).toBe(
      "https://beian.mps.gov.cn/#/query/webSearch?code=11000000000000"
    );
  });

  it("允许空配置并拒绝缺少14位代码的内容", () => {
    expect(publicSecurityFilingValidationError("")).toBeNull();
    expect(publicSecurityFilingUrl("")).toBe("");
    expect(publicSecurityFilingValidationError("京公网安备 123号")).toBe(
      "请输入正确的公安备案号，如：省公网安备 11000000000000号（请将“省”替换为省份简称）"
    );
  });
});
