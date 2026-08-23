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
  openApiOperationMatches,
  buildOpenApiOperationUrl,
  resolveOpenApiValue
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

  it("使用当前站点地址生成可复制的完整接口 URL", () => {
    expect(buildOpenApiOperationUrl("https://allocube.example.com", "/machines"))
      .toBe("https://allocube.example.com/api/open/v1/machines");
    expect(buildOpenApiOperationUrl("https://allocube.example.com/", "reservations/{id}"))
      .toBe("https://allocube.example.com/api/open/v1/reservations/{id}");
  });

  it("以递归字段视图展示嵌套结构、响应头和原始 Schema", () => {
    const pageSource = fs.readFileSync(
      new URL("../src/DocumentationPage.tsx", import.meta.url),
      "utf8"
    );
    expect(pageSource).toContain("function SchemaExplorer");
    expect(pageSource).toContain("function ApiResponseHeaders");
    expect(pageSource).toContain("查看原始 Schema");
    expect(pageSource).not.toContain("requestBody.description");
    expect(pageSource).toContain("className=\"api-endpoint-url-value\"");
    expect(pageSource).toContain("点击复制完整 URL");
    expect(pageSource).toContain("notify(\"success\", \"复制成功\")");
    expect(pageSource).not.toContain("已复制");
    expect(pageSource).toContain("if (value === \"\") return \"(空)\"");
    expect(pageSource).toMatch(/<details className=\{`api-response/u);
    expect(pageSource).not.toMatch(/<details className=\{`api-response[^>]+open=/u);
  });
});

describe("OpenAPI 端点说明完整性", () => {
  const operations = listOpenApiOperations(OPEN_API_DOCUMENT);

  it("为每个端点说明参数、请求体、响应状态和通用故障", () => {
    expect(operations).toHaveLength(8);
    for (const operation of operations) {
      for (const parameter of operation.parameters) {
        expectNonEmptyDescription(parameter, `${operation.method} ${operation.path} 参数 ${String(parameter.name)}`);
      }
      if (operation.requestBody) {
        expectNonEmptyDescription(operation.requestBody, `${operation.method} ${operation.path} 请求体`);
      }
      expect(operation.responses, `${operation.method} ${operation.path} 缺少 500 响应`).toHaveProperty("500");
      for (const [status, rawResponse] of Object.entries(operation.responses)) {
        const response = resolveOpenApiValue(OPEN_API_DOCUMENT, rawResponse);
        expectRecord(response, `${operation.method} ${operation.path} 响应 ${status}`);
        expectNonEmptyDescription(response, `${operation.method} ${operation.path} 响应 ${status}`);
      }
    }
    const machines = operations.find((operation) => operation.method === "GET" && operation.path === "/machines");
    expect(machines?.responses).toHaveProperty("400");
  });

  it("说明成功、限流响应头，并为所有返回字段提供含义", () => {
    for (const operation of operations) {
      const success = resolveOpenApiValue(OPEN_API_DOCUMENT, operation.responses["200"]);
      expectRecord(success, `${operation.method} ${operation.path} 200 响应`);
      expect(success.headers).toHaveProperty("X-Request-Id");
      expect(success.headers).toHaveProperty("X-RateLimit-Limit");
      assertSchemaPropertyDescriptions(
        OPEN_API_DOCUMENT,
        mediaTypeDetails(success)?.schema,
        `${operation.method} ${operation.path} 200 响应体`
      );

      const rateLimited = resolveOpenApiValue(OPEN_API_DOCUMENT, operation.responses["429"]);
      expectRecord(rateLimited, `${operation.method} ${operation.path} 429 响应`);
      expect(rateLimited.headers).toHaveProperty("Retry-After");
    }
  });

  it("完整展示四种占用操作的提交成功示例", () => {
    const commit = operations.find((operation) => operation.operationId === "commitReservationOperation");
    expect(commit).toBeTruthy();
    const success = resolveOpenApiValue(OPEN_API_DOCUMENT, commit!.responses["200"]);
    expectRecord(success, "commit 200 响应");
    const examples = mediaTypeDetails(success)?.examples;
    expectRecord(examples, "commit 200 examples");
    expect(Object.keys(examples)).toEqual(["create", "update", "cancel", "end"]);
    expect((examples.update as { summary?: string }).summary).toBe("UPDATE 提交成功");
    expect((examples.end as { summary?: string }).summary).toBe("END 提交成功");
  });

  it("为请求字段和可复用模型中的每个属性提供含义", () => {
    const components = resolveOpenApiValue(OPEN_API_DOCUMENT, OPEN_API_DOCUMENT.components);
    expectRecord(components, "components");
    expectRecord(components.schemas, "components.schemas");
    for (const [name, schema] of Object.entries(components.schemas)) {
      assertSchemaPropertyDescriptions(OPEN_API_DOCUMENT, schema, `components.schemas.${name}`);
    }
    for (const operation of operations) {
      if (!operation.requestBody) continue;
      assertSchemaPropertyDescriptions(
        OPEN_API_DOCUMENT,
        mediaTypeDetails(operation.requestBody)?.schema,
        `${operation.method} ${operation.path} 请求体`
      );
    }
  });
});

function expectRecord(value: unknown, context: string): asserts value is Record<string, unknown> {
  expect(value, context).toBeTypeOf("object");
  expect(value, context).not.toBeNull();
  expect(Array.isArray(value), context).toBe(false);
}

function expectNonEmptyDescription(value: Record<string, unknown>, context: string) {
  expect(value.description, `${context} 缺少说明`).toBeTypeOf("string");
  expect(String(value.description).trim().length, `${context} 说明为空`).toBeGreaterThan(0);
}

function assertSchemaPropertyDescriptions(
  document: unknown,
  rawSchema: unknown,
  context: string,
  visitedReferences = new Set<string>()
) {
  if (rawSchema === undefined) throw new Error(`${context} 缺少 Schema`);
  const reference = isRecord(rawSchema) && typeof rawSchema.$ref === "string" ? rawSchema.$ref : undefined;
  if (reference && visitedReferences.has(reference)) return;
  const nextVisited = reference ? new Set([...visitedReferences, reference]) : visitedReferences;
  const schema = resolveOpenApiValue(document, rawSchema);
  expectRecord(schema, context);

  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      const resolvedProperty = resolveOpenApiValue(document, property);
      expectRecord(resolvedProperty, `${context}.${name}`);
      expectNonEmptyDescription(resolvedProperty, `${context}.${name}`);
      if (schemaHasNestedShape(document, property)) {
        assertSchemaPropertyDescriptions(document, property, `${context}.${name}`, nextVisited);
      }
    }
  }
  if (schema.items !== undefined) {
    assertSchemaPropertyDescriptions(document, schema.items, `${context}[]`, nextVisited);
  }
  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    if (!Array.isArray(schema[keyword])) continue;
    schema[keyword].forEach((variant, index) => {
      assertSchemaPropertyDescriptions(document, variant, `${context}.${keyword}[${index}]`, nextVisited);
    });
  }
}

function schemaHasNestedShape(document: unknown, value: unknown) {
  const schema = resolveOpenApiValue(document, value);
  return isRecord(schema) && (
    isRecord(schema.properties) ||
    schema.items !== undefined ||
    Array.isArray(schema.oneOf) ||
    Array.isArray(schema.anyOf) ||
    Array.isArray(schema.allOf)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
