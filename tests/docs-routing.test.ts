import { describe, expect, it } from "vitest";
import {
  docsPath,
  docsPaths,
  resolveDocsRoute
} from "../src/docs-routing.js";

describe("公开文档路径", () => {
  it("解析全部公开章节并兼容尾斜杠", () => {
    for (const path of docsPaths) {
      expect(resolveDocsRoute(path)).toMatchObject({ kind: "section" });
      expect(resolveDocsRoute(`${path}/`)).toEqual(resolveDocsRoute(path));
    }
    expect(resolveDocsRoute("/docs")).toEqual({ kind: "section", slug: "overview" });
    expect(resolveDocsRoute("/docs/api")).toEqual({ kind: "section", slug: "api" });
  });

  it("生成稳定的章节链接并把未知文档路径交给文档 404", () => {
    expect(docsPath("overview")).toBe("/docs");
    expect(docsPath("troubleshooting")).toBe("/docs/troubleshooting");
    expect(resolveDocsRoute("/docs/not-a-section")).toEqual({
      kind: "not-found",
      pathname: "/docs/not-a-section"
    });
    expect(resolveDocsRoute("/calendar")).toBeNull();
  });
});
