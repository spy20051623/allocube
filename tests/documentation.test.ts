import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DOCS_ALLOW_RAW_HTML,
  docsSectionMatches,
  docsSections,
  extractDocsHeadings,
  markdownSearchText,
  slugifyDocsHeading
} from "../src/docs-content.js";
import {
  listOpenApiOperations,
  mediaTypeDetails,
  openApiOperationMatches
} from "../src/openapi-docs.js";
import { resolveDocsRoute } from "../src/docs-routing.js";
import { OPEN_API_DOCUMENT } from "../server/openapi-document.js";

describe("文档内容模型", () => {
  it("以 Markdown 提供所有约定章节和内部链接", () => {
    expect(docsSections.map((section) => section.slug)).toEqual([
      "overview",
      "getting-started",
      "user-guide",
      "machine-admin",
      "system-admin",
      "operations",
      "api",
      "troubleshooting"
    ]);
    expect(docsSections.every((section) => section.markdown.startsWith("# "))).toBe(true);
    for (const section of docsSections) {
      expect(extractDocsHeadings(section.markdown)[0]).toMatchObject({
        depth: 1,
        text: section.title
      });
    }
    expect(docsSections[0].markdown).toContain("/docs/getting-started");
  });

  it("保证文档中心内部链接和锚点都有有效目标", () => {
    for (const source of docsSections) {
      for (const match of source.markdown.matchAll(
        /\[[^\]]+\]\((\/docs(?:\/[^#)\s]*)?)(#[^)\s]+)?\)/gu
      )) {
        const route = resolveDocsRoute(match[1]);
        expect(route, `${source.path} 中的链接 ${match[0]}`).toMatchObject({
          kind: "section"
        });
        if (!route || route.kind !== "section" || !match[2]) continue;
        const target = docsSections.find((section) => section.slug === route.slug)!;
        const targetIds = extractDocsHeadings(target.markdown).map((heading) => heading.id);
        expect(
          targetIds,
          `${source.path} 中的锚点 ${match[0]}`
        ).toContain(decodeURIComponent(match[2].slice(1)));
      }
    }
  });

  it("生成正文目录、稳定锚点并处理重复标题", () => {
    expect(slugifyDocsHeading("两阶段写入 / Commit")).toBe("两阶段写入-commit");
    expect(extractDocsHeadings("# 标题\n## 查询\n### 参数\n## 查询")).toEqual([
      { depth: 1, id: "标题", text: "标题" },
      { depth: 2, id: "查询", text: "查询" },
      { depth: 3, id: "参数", text: "参数" },
      { depth: 2, id: "查询-2", text: "查询" }
    ]);
  });

  it("搜索 Markdown 标题、正文和代码，同时明确禁用原始 HTML", () => {
    const api = docsSections.find((section) => section.slug === "api")!;
    expect(docsSectionMatches(api, "两阶段 confirmationToken")).toBe(true);
    expect(docsSectionMatches(api, "不存在的关键词")).toBe(false);
    expect(markdownSearchText("[入口](/docs) `READ_ONLY`")).toContain("入口 READ_ONLY");
    expect(DOCS_ALLOW_RAW_HTML).toBe(false);
  });

  it("章节导航和正文不展示推荐读者标签", () => {
    const pageSource = fs.readFileSync(
      new URL("../src/DocumentationPage.tsx", import.meta.url),
      "utf8"
    );
    expect(pageSource).not.toMatch(/docs-audience|适合：|section\.audience|item\.audience/u);
    expect(docsSections.every((section) => !("audience" in section))).toBe(true);
  });

  it("统一使用已登记的尖括号占位符且不保留易混淆示例", () => {
    const overview = docsSections.find((section) => section.slug === "overview")!;
    const productionEnv = fs.readFileSync(
      new URL("../.env.production.example", import.meta.url),
      "utf8"
    );
    const documented = new Set(
      [...overview.markdown.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map((match) => match[1])
    );
    const sources = [
      ...docsSections.map((section) => section.markdown),
      productionEnv
    ];
    for (const source of sources) {
      expect(source).not.toMatch(/REDACTED|your-company|allocube\.example/u);
      for (const match of source.matchAll(/<([^>\r\n]+)>/g)) {
        expect(match[1]).toMatch(/^[A-Z][A-Z0-9_]*$/u);
        if (!["UPPER_SNAKE_CASE", "PLACEHOLDER_NAME"].includes(match[1])) {
          expect(documented.has(match[1]), `未登记占位符 <${match[1]}>`).toBe(true);
        }
      }
    }
    expect(docsSections.find((section) => section.slug === "api")!.markdown)
      .not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu);
  });

  it("统一产品术语、页面名称和技术数量写法", () => {
    const repositoryReadme = fs.readFileSync(
      new URL("../README.md", import.meta.url),
      "utf8"
    );
    const publicDocumentation = [
      repositoryReadme,
      ...docsSections.flatMap((section) => [
        section.title,
        section.description,
        section.markdown
      ])
    ].join("\n");

    expect(publicDocumentation).not.toMatch(
      /官方 AI API|官方API|预约|个人资料|机器权限|\bPAT\b|五分钟|八天/u
    );
    expect(publicDocumentation).not.toMatch(
      /统计(?:来自计划时段|来自登记的占用时段|基于登记占用时段)[^\n]*/u
    );

    const languagePolicy = fs.readFileSync(
      new URL("../docs/role-aware-language.md", import.meta.url),
      "utf8"
    );
    expect(languagePolicy).toContain("机器成员关系统一称为“机器使用权”");
    expect(languagePolicy).toContain("技术数量使用阿拉伯数字");
    expect(languagePolicy).toContain("<UPPER_SNAKE_CASE>");
  });

  it("让 OpenAPI 与说明文档共用名称、数量和占位符规范", () => {
    const overview = docsSections.find((section) => section.slug === "overview")!;
    const documented = new Set(
      [...overview.markdown.matchAll(/<([A-Z][A-Z0-9_]*)>/g)].map((match) => match[1])
    );
    const serialized = JSON.stringify(OPEN_API_DOCUMENT);

    expect(OPEN_API_DOCUMENT.info.title).toBe("Allocube 官方 API");
    expect(serialized).not.toMatch(/官方 AI API|五分钟|八天|REDACTED/u);
    for (const match of serialized.matchAll(/<([^>\r\n]+)>/g)) {
      expect(match[1]).toMatch(/^[A-Z][A-Z0-9_]*$/u);
      if (match[1] !== "UPPER_SNAKE_CASE") {
        expect(documented.has(match[1]), `OpenAPI 未登记占位符 <${match[1]}>`).toBe(true);
      }
    }
  });
});

describe("OpenAPI 文档展示模型", () => {
  const document = {
    openapi: "3.1.0",
    paths: {
      "/api/open/v1/machines/{id}": {
        parameters: [{ name: "id", in: "path", required: true }],
        get: {
          tags: ["Resources"],
          summary: "查询机器资源",
          operationId: "getMachineResources",
          responses: { "200": { description: "成功" } }
        }
      },
      "/api/open/v1/reservation-operations/prepare": {
        post: {
          tags: ["Reservations"],
          summary: "预检占用操作",
          operationId: "prepareReservationOperation",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object" },
                examples: { create: { value: { action: "CREATE" } } }
              }
            }
          },
          responses: { "200": { description: "预检结果" } }
        }
      }
    }
  };

  it("提取分组、参数、请求体、响应和唯一 operationId", () => {
    const operations = listOpenApiOperations(document);
    expect(operations).toHaveLength(2);
    expect(operations.map((operation) => operation.tag)).toEqual(["Reservations", "Resources"]);
    expect(operations.find((operation) => operation.method === "GET")?.parameters[0]).toMatchObject({ name: "id" });
    expect(operations.find((operation) => operation.method === "POST")?.requestBody).toBeTruthy();
    expect(mediaTypeDetails(operations.find((operation) => operation.method === "POST")?.requestBody)?.examples).toEqual({
      create: { value: { action: "CREATE" } }
    });
    expect(new Set(operations.map((operation) => operation.operationId)).size).toBe(2);
  });

  it("按方法、路径、标签、摘要和 operationId 搜索", () => {
    const operations = listOpenApiOperations(document);
    expect(operations.some((operation) => openApiOperationMatches(operation, "POST prepareReservation"))).toBe(true);
    expect(operations.some((operation) => openApiOperationMatches(operation, "Resources 查询机器"))).toBe(true);
  });
});
