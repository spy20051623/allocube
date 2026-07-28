import { describe, expect, it } from "vitest";
import { siteOriginValidationError } from "../src/shared/site-origin.js";

describe("生产站点地址校验", () => {
  it("接受不带业务路径的 HTTPS 地址", () => {
    expect(siteOriginValidationError("https://allocube.company.test")).toBeNull();
    expect(siteOriginValidationError("https://allocube.company.test/")).toBeNull();
    expect(siteOriginValidationError("https://allocube.company.test:8443")).toBeNull();
  });

  it("接受不带业务路径的 HTTP 地址", () => {
    expect(siteOriginValidationError("http://allocube.company.test")).toBeNull();
    expect(siteOriginValidationError("http://192.168.1.10:38887")).toBeNull();
  });

  it("拒绝未替换的示例域名", () => {
    expect(siteOriginValidationError("https://allocube.example.com")).toContain(
      "示例域名"
    );
  });

  it("拒绝路径、查询参数、片段和账号信息", () => {
    expect(siteOriginValidationError("https://allocube.company.test/app")).not.toBeNull();
    expect(siteOriginValidationError("https://allocube.company.test/?a=1")).not.toBeNull();
    expect(siteOriginValidationError("https://allocube.company.test/#top")).not.toBeNull();
    expect(siteOriginValidationError("https://user:pass@allocube.company.test")).not.toBeNull();
  });

  it("拒绝无效地址", () => {
    expect(siteOriginValidationError("allocube.example.com")).not.toBeNull();
    expect(siteOriginValidationError("")).not.toBeNull();
  });

  it("HTTP 地址仍拒绝账号信息", () => {
    expect(siteOriginValidationError("http://localhost:5173")).toBeNull();
    expect(
      siteOriginValidationError("http://user:pass@192.168.1.10:5173")
    ).not.toBeNull();
  });
});
