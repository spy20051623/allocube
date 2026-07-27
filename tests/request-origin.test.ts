import { describe, expect, it } from "vitest";
import { requestOriginMatches } from "../server/request-origin.js";

describe("请求来源校验", () => {
  it("按当前请求来源判断，而不依赖邮件站点地址", () => {
    expect(
      requestOriginMatches(
        "https://allocube.company.test",
        "https",
        "allocube.company.test"
      )
    ).toBe(true);
    expect(
      requestOriginMatches(
        "https://attacker.test",
        "https",
        "allocube.company.test"
      )
    ).toBe(false);
  });

  it("拒绝畸形来源和包含额外内容的来源", () => {
    expect(
      requestOriginMatches(
        "https://allocube.company.test/path",
        "https",
        "allocube.company.test"
      )
    ).toBe(false);
    expect(requestOriginMatches("not-a-url", "https", "allocube.company.test")).toBe(
      false
    );
  });

  it("兼容没有 Origin 的同源非浏览器请求", () => {
    expect(requestOriginMatches(undefined, "https", "allocube.company.test")).toBe(
      true
    );
  });
});
