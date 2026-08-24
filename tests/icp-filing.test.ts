import { describe, expect, it } from "vitest";
import { icpFilingValidationError } from "../src/shared/icp-filing";

describe("ICP备案号格式", () => {
  it("接受不同省份简称开头的完整网站备案号", () => {
    expect(
      icpFilingValidationError("浙ICP备12345678号-1")
    ).toBeNull();
    expect(icpFilingValidationError("京ICP备12345678号-2")).toBeNull();
    expect(icpFilingValidationError("粤ICP备12345678号-12")).toBeNull();
  });

  it("允许空配置并拒绝缺少网站序号或错误省份的内容", () => {
    expect(icpFilingValidationError("")).toBeNull();
    expect(icpFilingValidationError("浙ICP备12345678号")).not.toBeNull();
    expect(icpFilingValidationError("AICP备12345678号-1")).not.toBeNull();
  });
});
