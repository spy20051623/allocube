import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  Boxes,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FileJson,
  Menu,
  RefreshCw,
  Search,
  X
} from "lucide-react";
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  docsSectionBySlug,
  docsSectionMatches,
  docsSections,
  DOCS_ALLOW_RAW_HTML,
  extractDocsHeadings,
  slugifyDocsHeading
} from "./docs-content";
import type { ResolvedDocsRoute } from "./docs-routing";
import {
  isObject,
  buildOpenApiOperationUrl,
  listOpenApiOperations,
  mediaTypeDetails,
  openApiOperationMatches,
  resolveOpenApiValue,
  type OpenApiOperation
} from "./openapi-docs";
import "./documentation.css";

const OPENAPI_URL = "/api/open/v1/openapi.json";

type OpenApiState =
  | { status: "loading" }
  | { status: "ready"; document: unknown; operations: OpenApiOperation[] }
  | { status: "error"; message: string };

type SearchResult = {
  key: string;
  href: string;
  eyebrow: string;
  title: string;
  detail: string;
};

type DocsNotify = (kind: "success" | "error", message: string) => void;

const DocsNotifyContext = createContext<DocsNotify>(() => undefined);

export function DocumentationPage({ route, notify }: { route: ResolvedDocsRoute; notify: DocsNotify }) {
  const [query, setQuery] = useState("");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [openApi, setOpenApi] = useState<OpenApiState>({ status: "loading" });
  const searchRef = useRef<HTMLDivElement>(null);

  const loadOpenApi = useCallback(async () => {
    setOpenApi({ status: "loading" });
    try {
      const response = await fetch(OPENAPI_URL, {
        headers: { Accept: "application/json" },
        credentials: "omit"
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document: unknown = await response.json();
      const operations = listOpenApiOperations(document);
      if (operations.length === 0) throw new Error("OpenAPI 文档中没有可展示的端点");
      setOpenApi({ status: "ready", document, operations });
    } catch (error) {
      setOpenApi({
        status: "error",
        message: error instanceof Error ? error.message : "无法加载 OpenAPI 文档"
      });
    }
  }, []);

  useEffect(() => {
    document.body.classList.add("docs-page-active");
    const previousTitle = document.title;
    document.title = "文档中心 · Allocube";
    void loadOpenApi();
    return () => {
      document.body.classList.remove("docs-page-active");
      document.title = previousTitle;
    };
  }, [loadOpenApi]);

  useEffect(() => {
    const closeSearch = (event: MouseEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setQuery("");
    };
    document.addEventListener("mousedown", closeSearch);
    return () => document.removeEventListener("mousedown", closeSearch);
  }, []);

  useEffect(() => {
    if (route.kind !== "section" || !window.location.hash) return;
    const frame = window.requestAnimationFrame(() => {
      let targetId = window.location.hash.slice(1);
      try {
        targetId = decodeURIComponent(targetId);
      } catch {
        // 无法解码的片段由浏览器按普通未知锚点处理。
      }
      document.getElementById(targetId)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [route, openApi.status]);

  if (route.kind === "not-found") {
    return <DocsNotFound pathname={route.pathname} />;
  }

  const section = docsSectionBySlug.get(route.slug) ?? docsSections[0];
  const headings = extractDocsHeadings(section.markdown).filter((heading) => heading.depth > 1);
  const operations = openApi.status === "ready" ? openApi.operations : [];
  const searchResults = buildSearchResults(query, operations);

  return (
    <DocsNotifyContext.Provider value={notify}>
    <div className="docs-shell">
      <header className="docs-header">
        <a className="docs-brand" href="/docs" aria-label="Allocube 文档中心首页">
          <span className="docs-brand-mark"><Boxes size={20} /></span>
          <span><strong>Allocube</strong><small>文档中心</small></span>
        </a>
        <div className="docs-search" ref={searchRef}>
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="搜索文档"
            placeholder="搜索手册、路径或 operationId"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button type="button" aria-label="清除搜索" onClick={() => setQuery("")}>
              <X size={15} />
            </button>
          )}
          {query.trim() && (
            <SearchResults results={searchResults} onSelect={() => setQuery("")} />
          )}
        </div>
        <nav className="docs-header-actions" aria-label="文档快捷入口">
          {section.slug === "api" && (
            <a href={OPENAPI_URL} target="_blank" rel="noreferrer">
              <FileJson size={16} /> OpenAPI JSON
            </a>
          )}
          <a href="/login"><ArrowLeft size={16} /> 返回系统</a>
        </nav>
        <button
          className="docs-mobile-menu"
          type="button"
          aria-label="打开章节导航"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen((open) => !open)}
        >
          {navigationOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      <div className="docs-layout">
        <aside className={`docs-sidebar${navigationOpen ? " open" : ""}`}>
          <div className="docs-sidebar-title">产品手册</div>
          <nav aria-label="文档章节">
            {docsSections.map((item) => (
              <a
                key={item.slug}
                href={item.path}
                className={item.slug === section.slug ? "active" : ""}
                onClick={() => setNavigationOpen(false)}
              >
                <span>{item.title}</span>
              </a>
            ))}
          </nav>
          <div className="docs-sidebar-note">
            <BookOpenText size={16} />
            <p>说明内容以仓库中的版本化 Markdown 为准；API 字段以 OpenAPI JSON 为准。</p>
          </div>
        </aside>

        <main className="docs-main" id="main-content">
          <article className="docs-article">
            <MarkdownDocument markdown={section.markdown} />
          </article>
          {section.slug === "api" && (
            <OpenApiReference state={openApi} onRetry={loadOpenApi} />
          )}
          <DocsPager currentSlug={section.slug} />
        </main>

        <aside className="docs-toc" aria-label="本页目录">
          <strong>本页内容</strong>
          <nav>
            {headings.map((heading) => (
              <a
                key={`${heading.id}-${heading.depth}`}
                href={`#${heading.id}`}
                className={heading.depth === 3 ? "nested" : ""}
              >
                {heading.text}
              </a>
            ))}
            {section.slug === "api" && <a href="#api-reference">端点参考</a>}
          </nav>
        </aside>
      </div>
    </div>
    </DocsNotifyContext.Provider>
  );
}

function MarkdownDocument({ markdown }: { markdown: string }) {
  const components = useMemo<Components>(() => ({
    h1: ({ children }) => <h1 id={slugifyDocsHeading(nodeText(children))}>{children}</h1>,
    h2: ({ children }) => <LinkedHeading level={2}>{children}</LinkedHeading>,
    h3: ({ children }) => <LinkedHeading level={3}>{children}</LinkedHeading>,
    a: ({ href = "", children, ...props }) => {
      const external = /^https?:\/\//.test(href);
      return (
        <a
          {...props}
          href={href}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
        >
          {children}{external && <ExternalLink className="docs-inline-icon" size={12} />}
        </a>
      );
    },
    pre: ({ children }) => <CopyableCode>{children}</CopyableCode>,
    table: ({ children }) => <div className="docs-table-wrap"><table>{children}</table></div>
  }), []);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml={!DOCS_ALLOW_RAW_HTML}
      components={components}
    >
      {markdown}
    </ReactMarkdown>
  );
}

function LinkedHeading({ level, children }: { level: 2 | 3; children: ReactNode }) {
  const text = nodeText(children);
  const id = slugifyDocsHeading(text);
  const content = <>{children}<a className="docs-heading-anchor" href={`#${id}`} aria-label={`链接到${text}`}>#</a></>;
  return level === 2 ? <h2 id={id}>{content}</h2> : <h3 id={id}>{content}</h3>;
}

function CopyableCode({ children }: { children: ReactNode }) {
  const copyToClipboard = useCopyToClipboard();
  const text = nodeText(children).replace(/\n$/, "");
  return (
    <div className="docs-code-block">
      <button type="button" onClick={() => void copyToClipboard(text)} aria-label="复制代码">
        <Clipboard size={14} />
        复制
      </button>
      <pre>{children}</pre>
    </div>
  );
}

function SearchResults({ results, onSelect }: { results: SearchResult[]; onSelect: () => void }) {
  return (
    <div className="docs-search-results" role="listbox" aria-label="搜索结果">
      {results.length === 0 ? (
        <div className="docs-search-empty">没有找到匹配内容</div>
      ) : results.map((result) => (
        <a key={result.key} href={result.href} onClick={onSelect} role="option" aria-selected="false">
          <span>{result.eyebrow}</span>
          <strong>{result.title}</strong>
          <small>{result.detail}</small>
        </a>
      ))}
    </div>
  );
}

function buildSearchResults(query: string, operations: OpenApiOperation[]): SearchResult[] {
  if (!query.trim()) return [];
  const sectionResults = docsSections
    .filter((section) => docsSectionMatches(section, query))
    .map((section) => ({
      key: `section-${section.slug}`,
      href: section.path,
      eyebrow: "产品手册",
      title: section.title,
      detail: section.description
    }));
  const operationResults = operations
    .filter((operation) => openApiOperationMatches(operation, query))
    .slice(0, 12)
    .map((operation) => ({
      key: `operation-${operation.operationId || `${operation.method}-${operation.path}`}`,
      href: `/docs/api#${operationAnchor(operation)}`,
      eyebrow: `${operation.method} · ${operation.tag}`,
      title: operation.path,
      detail: operation.summary || operation.operationId
    }));
  return [...sectionResults, ...operationResults].slice(0, 16);
}

function OpenApiReference({
  state,
  onRetry
}: {
  state: OpenApiState;
  onRetry: () => Promise<void>;
}) {
  return (
    <section className="api-reference" id="api-reference">
      <div className="api-reference-head">
        <div>
          <span>OpenAPI 3.1</span>
          <h2>端点参考</h2>
          <p>以下内容从公开的 OpenAPI JSON 实时生成，不接受或保存个人访问令牌。</p>
        </div>
        <a className="docs-outline-button" href={OPENAPI_URL} target="_blank" rel="noreferrer">
          <FileJson size={15} /> 原始 JSON
        </a>
      </div>
      {state.status === "loading" && (
        <div className="api-state"><RefreshCw className="spinning" size={20} />正在加载端点定义…</div>
      )}
      {state.status === "error" && (
        <div className="api-state api-state-error">
          <AlertTriangle size={21} />
          <div><strong>OpenAPI 加载失败</strong><p>{state.message}。上方 API 接入指南仍可正常阅读。</p></div>
          <button type="button" className="docs-outline-button" onClick={() => void onRetry()}>
            <RefreshCw size={15} /> 重试
          </button>
        </div>
      )}
      {state.status === "ready" && (
        <OpenApiGroups document={state.document} operations={state.operations} />
      )}
    </section>
  );
}

function OpenApiGroups({ document, operations }: { document: unknown; operations: OpenApiOperation[] }) {
  const groups = new Map<string, OpenApiOperation[]>();
  for (const operation of operations) {
    groups.set(operation.tag, [...(groups.get(operation.tag) ?? []), operation]);
  }
  return (
    <div className="api-groups">
      {[...groups].map(([tag, items]) => (
        <section className="api-group" key={tag}>
          <h3>{tag}</h3>
          {items.map((operation) => (
            <OpenApiOperationCard key={`${operation.method}-${operation.path}`} document={document} operation={operation} />
          ))}
        </section>
      ))}
    </div>
  );
}

function OpenApiOperationCard({ document, operation }: { document: unknown; operation: OpenApiOperation }) {
  const copyToClipboard = useCopyToClipboard();
  const endpointUrl = buildOpenApiOperationUrl(window.location.origin, operation.path);

  return (
    <details className="api-operation" id={operationAnchor(operation)}>
      <summary>
        <span className={`api-method method-${operation.method.toLocaleLowerCase()}`}>{operation.method}</span>
        <code>{operation.path}</code>
        <span className="api-summary">{operation.summary}</span>
        <button
          type="button"
          className="api-copy-endpoint"
          aria-label={`复制接口地址 ${endpointUrl}`}
          title={endpointUrl}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void copyToClipboard(endpointUrl);
          }}
        >
          <Clipboard size={11} />
        </button>
        <ChevronRight className="api-chevron" size={17} />
      </summary>
      <div className="api-operation-body">
        {operation.description && <p>{operation.description}</p>}
        {operation.operationId && <p className="api-operation-id"><strong>operationId</strong><code>{operation.operationId}</code></p>}
        <div className="api-endpoint-url">
          <strong>完整 URL</strong>
          <button
            type="button"
            className="api-endpoint-url-value"
            aria-label={`复制完整接口地址 ${endpointUrl}`}
            title="点击复制完整 URL"
            onClick={() => void copyToClipboard(endpointUrl)}
          >
            <code>{endpointUrl}</code>
          </button>
        </div>
        {operation.parameters.length > 0 && (
          <ApiParameters document={document} parameters={operation.parameters} />
        )}
        {operation.requestBody && (
          <ApiRequestBody document={document} requestBody={operation.requestBody} />
        )}
        <ApiResponses document={document} responses={operation.responses} />
      </div>
    </details>
  );
}

function ApiParameters({ document, parameters }: { document: unknown; parameters: Record<string, unknown>[] }) {
  return (
    <div className="api-subsection">
      <h4>参数</h4>
      <div className="docs-table-wrap">
        <table className="api-parameters-table">
          <thead><tr><th>参数名</th><th>类型</th><th>位置</th><th>必填</th><th>说明</th></tr></thead>
          <tbody>
            {parameters.map((parameter, index) => (
              <tr key={`${String(parameter.name)}-${index}`}>
                <td className="api-parameter-name"><code>{String(parameter.name ?? "-")}</code></td>
                <td><span className="api-parameter-type">{schemaTypeLabel(document, parameter.schema)}</span></td>
                <td><span className="api-parameter-location">{parameterLocationLabel(parameter.in)}</span></td>
                <td>
                  <span className={`api-parameter-required ${parameter.required === true ? "required" : "optional"}`}>
                    {parameter.required === true ? "是" : "否"}
                  </span>
                </td>
                <td className="api-parameter-description">
                  {typeof parameter.description === "string" && <span>{parameter.description}</span>}
                  {parameter.schema !== undefined && <SchemaConstraintSummary document={document} value={parameter.schema} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ApiResponses({ document, responses }: { document: unknown; responses: Record<string, unknown> }) {
  return (
    <div className="api-subsection">
      <h4>响应</h4>
      <div className="api-responses">
        {Object.entries(responses).map(([status, raw]) => {
          const response = resolveOpenApiValue(document, raw);
          const object = isObject(response) ? response : {};
          const media = mediaTypeDetails(object);
          const headers = isObject(object.headers) ? object.headers : undefined;
          return (
            <details className={`api-response api-response-${responseStatusTone(status)}`} key={status}>
              <summary>
                <code>{status}</code>
                <span>{String(object.description ?? "")}</span>
                <ChevronRight className="api-response-chevron" size={15} />
              </summary>
              {headers && <ApiResponseHeaders document={document} headers={headers} />}
              {media?.schema !== undefined && (
                <SchemaDisclosure document={document} value={media.schema} />
              )}
              {media?.example !== undefined && <ApiExample title="示例" value={media.example} />}
              {isObject(media?.examples) && Object.entries(media.examples).map(([name, example]) => (
                <ApiExample key={name} title={name} value={example} />
              ))}
            </details>
          );
        })}
      </div>
    </div>
  );
}

function ApiRequestBody({ document, requestBody }: { document: unknown; requestBody: Record<string, unknown> }) {
  const media = mediaTypeDetails(requestBody);
  return (
    <div className="api-subsection">
      <h4>请求体</h4>
      {media?.schema !== undefined && (
        <SchemaDisclosure document={document} value={media.schema} />
      )}
      {media?.example !== undefined && <ApiExample title="示例" value={media.example} />}
      {isObject(media?.examples) && Object.entries(media.examples).map(([name, example]) => (
        <ApiExample key={name} title={name} value={example} />
      ))}
      {!media && <JsonPreview value={requestBody} />}
    </div>
  );
}

function ApiExample({ title, value }: { title: string; value: unknown }) {
  const resolved = isObject(value) && "value" in value ? value.value : value;
  const summary = isObject(value) && typeof value.summary === "string" ? value.summary : "";
  return (
    <div className="api-example">
      <strong>{title}{summary ? ` · ${summary}` : ""}</strong>
      <JsonPreview value={resolved} />
    </div>
  );
}

function ApiResponseHeaders({ document, headers }: { document: unknown; headers: Record<string, unknown> }) {
  return (
    <div className="api-response-headers">
      <strong>响应头</strong>
      <div className="docs-table-wrap">
        <table>
          <thead><tr><th>名称</th><th>类型</th><th>说明</th></tr></thead>
          <tbody>
            {Object.entries(headers).map(([name, raw]) => {
              const header = resolveOpenApiValue(document, raw);
              const object = isObject(header) ? header : {};
              return (
                <tr key={name}>
                  <td><code>{name}</code></td>
                  <td><SchemaInlineSummary document={document} value={object.schema} compact /></td>
                  <td>{String(object.description ?? "")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SchemaDisclosure({ document, value }: { document: unknown; value: unknown }) {
  const resolved = resolveOpenApiValue(document, value);
  return (
    <div className="api-schema-disclosure">
      <SchemaExplorer document={document} value={value} />
      <details className="api-schema-raw">
        <summary>查看原始 Schema</summary>
        <JsonPreview value={resolved} />
      </details>
    </div>
  );
}

function SchemaExplorer({
  document,
  value,
  depth = 0,
  references = new Set<string>(),
  showDescription = true
}: {
  document: unknown;
  value: unknown;
  depth?: number;
  references?: Set<string>;
  showDescription?: boolean;
}) {
  const reference = isObject(value) && typeof value.$ref === "string" ? value.$ref : undefined;
  if (reference && references.has(reference)) {
    return <div className="api-schema-reference">引用 {reference.split("/").at(-1)}</div>;
  }
  const resolved = resolveOpenApiValue(document, value);
  if (!isObject(resolved)) return <SchemaInlineSummary document={document} value={resolved} />;
  const nextReferences = reference ? new Set([...references, reference]) : references;
  const required = new Set(Array.isArray(resolved.required) ? resolved.required.filter((item): item is string => typeof item === "string") : []);
  const properties = isObject(resolved.properties) ? resolved.properties : undefined;
  const variants = Array.isArray(resolved.oneOf)
    ? { label: "可选结构", values: resolved.oneOf }
    : Array.isArray(resolved.anyOf)
      ? { label: "可选结构", values: resolved.anyOf }
      : Array.isArray(resolved.allOf)
        ? { label: "组合结构", values: resolved.allOf }
        : undefined;

  return (
    <div className={`api-schema-explorer depth-${Math.min(depth, 4)}`}>
      {showDescription && typeof resolved.description === "string" && <p className="api-schema-description">{resolved.description}</p>}
      {showDescription && <SchemaInlineSummary document={document} value={resolved} compact />}
      {properties && (
        <div className="api-schema-fields">
          {Object.entries(properties).map(([name, property]) => {
            const propertySchema = resolveOpenApiValue(document, property);
            const description = isObject(propertySchema) && typeof propertySchema.description === "string" ? propertySchema.description : "";
            return (
              <div className="api-schema-field" key={name}>
                <div className="api-schema-field-head">
                  <code>{name}</code>
                  <SchemaInlineSummary document={document} value={property} compact />
                  {required.has(name) && <span className="api-required-badge">必填</span>}
                </div>
                {description && <p>{description}</p>}
                {depth < 8 && schemaHasChildren(document, property) && (
                  <SchemaExplorer
                    document={document}
                    value={property}
                    depth={depth + 1}
                    references={nextReferences}
                    showDescription={false}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
      {resolved.items !== undefined && depth < 8 && (
        <div className="api-schema-items">
          <strong>数组元素</strong>
          <SchemaExplorer document={document} value={resolved.items} depth={depth + 1} references={nextReferences} />
        </div>
      )}
      {variants && depth < 8 && (
        <div className="api-schema-variants">
          <strong>{variants.label}</strong>
          {variants.values.map((variant, index) => (
            <details key={index}>
              <summary>{schemaVariantLabel(document, variant, index)}</summary>
              <SchemaExplorer document={document} value={variant} depth={depth + 1} references={nextReferences} />
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

function SchemaInlineSummary({ document, value, compact = false }: { document: unknown; value: unknown; compact?: boolean }) {
  const resolved = resolveOpenApiValue(document, value);
  if (!isObject(resolved)) return <span className="api-schema-type">{schemaDisplayValue(resolved)}</span>;
  const constraints = schemaConstraintLabels(resolved);
  return (
    <span className={`api-schema-inline${compact ? " compact" : ""}`}>
      <span className="api-schema-type">{schemaTypeLabel(document, value)}</span>
      {constraints.map((constraint) => <span className="api-schema-constraint" key={constraint}>{constraint}</span>)}
    </span>
  );
}

function SchemaConstraintSummary({ document, value }: { document: unknown; value: unknown }) {
  const resolved = resolveOpenApiValue(document, value);
  if (!isObject(resolved)) return null;
  const constraints = schemaConstraintLabels(resolved);
  if (constraints.length === 0) return null;
  return (
    <span className="api-parameter-constraints">
      {constraints.map((constraint) => <span className="api-schema-constraint" key={constraint}>{constraint}</span>)}
    </span>
  );
}

function schemaTypeLabel(document: unknown, value: unknown): string {
  const resolved = resolveOpenApiValue(document, value);
  if (!isObject(resolved)) return typeof resolved;
  if (Array.isArray(resolved.type)) return resolved.type.map(String).join(" | ");
  if (typeof resolved.type === "string") {
    if (resolved.type === "array") return `array<${schemaTypeLabel(document, resolved.items)}>`;
    return resolved.format ? `${resolved.type} · ${String(resolved.format)}` : resolved.type;
  }
  if (Array.isArray(resolved.oneOf) || Array.isArray(resolved.anyOf)) return "联合类型";
  if (Array.isArray(resolved.allOf)) return "组合对象";
  if (isObject(resolved.properties)) return "object";
  if (resolved.const !== undefined) return typeof resolved.const;
  return "任意类型";
}

function schemaVariantLabel(document: unknown, value: unknown, index: number) {
  const resolved = resolveOpenApiValue(document, value);
  if (isObject(resolved)) {
    if (typeof resolved.title === "string" && resolved.title.trim()) return resolved.title;
    if (typeof resolved.description === "string" && resolved.description.trim()) return resolved.description;
    if (isObject(resolved.properties)) {
      const action = resolveOpenApiValue(document, resolved.properties.action);
      if (isObject(action)) {
        if (typeof action.const === "string") return action.const;
        if (Array.isArray(action.enum)) return action.enum.map(String).join(" / ");
      }
    }
  }
  const type = schemaTypeLabel(document, value);
  return type === "object" ? `结构 ${index + 1}` : type;
}

function schemaConstraintLabels(schema: Record<string, unknown>): string[] {
  const labels: string[] = [];
  if (Array.isArray(schema.enum)) labels.push(`可选：${schema.enum.map(schemaDisplayValue).join(" / ")}`);
  if (schema.const !== undefined) labels.push(`固定：${schemaDisplayValue(schema.const)}`);
  if (schema.default !== undefined) labels.push(`默认：${schemaDisplayValue(schema.default)}`);
  if (schema.minimum !== undefined) labels.push(`最小：${String(schema.minimum)}`);
  if (schema.maximum !== undefined) labels.push(`最大：${String(schema.maximum)}`);
  if (schema.minLength !== undefined) labels.push(`最短：${String(schema.minLength)}`);
  if (schema.maxLength !== undefined) labels.push(`最长：${String(schema.maxLength)}`);
  if (schema.minItems !== undefined) labels.push(`最少 ${String(schema.minItems)} 项`);
  if (schema.maxItems !== undefined) labels.push(`最多 ${String(schema.maxItems)} 项`);
  if (typeof schema.pattern === "string") labels.push(`格式：${schema.pattern}`);
  return labels;
}

function schemaDisplayValue(value: unknown) {
  if (value === "") return "(空)";
  if (value === null) return "null";
  if (value === undefined) return "-";
  return String(value);
}

function schemaHasChildren(document: unknown, value: unknown) {
  const resolved = resolveOpenApiValue(document, value);
  return isObject(resolved) && (
    isObject(resolved.properties) ||
    resolved.items !== undefined ||
    Array.isArray(resolved.oneOf) ||
    Array.isArray(resolved.anyOf) ||
    Array.isArray(resolved.allOf)
  );
}

function responseStatusTone(status: string) {
  if (/^2/.test(status)) return "success";
  if (/^4/.test(status)) return "client-error";
  if (/^5/.test(status)) return "server-error";
  return "default";
}

function parameterLocationLabel(value: unknown) {
  if (value === "query") return "查询参数";
  if (value === "path") return "路径参数";
  if (value === "header") return "请求头";
  if (value === "cookie") return "Cookie";
  return String(value ?? "-");
}

function JsonPreview({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const copyToClipboard = useCopyToClipboard();
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  return (
    <div className={`api-json${compact ? " compact" : ""}`}>
      <button type="button" aria-label="复制 JSON" onClick={() => void copyToClipboard(serialized)}>
        <Clipboard size={13} />
      </button>
      <pre><code>{serialized}</code></pre>
    </div>
  );
}

function useCopyToClipboard() {
  const notify = useContext(DocsNotifyContext);
  return useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("success", "复制成功");
    } catch {
      notify("error", "复制失败，请手动复制");
    }
  }, [notify]);
}

function DocsPager({ currentSlug }: { currentSlug: string }) {
  const index = docsSections.findIndex((section) => section.slug === currentSlug);
  const previous = index > 0 ? docsSections[index - 1] : undefined;
  const next = index >= 0 && index < docsSections.length - 1 ? docsSections[index + 1] : undefined;
  return (
    <nav className="docs-pager" aria-label="相邻章节">
      {previous ? <a href={previous.path}><small>上一章</small><strong>← {previous.title}</strong></a> : <span />}
      {next && <a className="next" href={next.path}><small>下一章</small><strong>{next.title} →</strong></a>}
    </nav>
  );
}

function DocsNotFound({ pathname }: { pathname: string }) {
  useEffect(() => {
    document.body.classList.add("docs-page-active");
    return () => document.body.classList.remove("docs-page-active");
  }, []);
  return (
    <div className="docs-not-found">
      <a className="docs-brand" href="/docs"><span className="docs-brand-mark"><Boxes size={20} /></span><strong>Allocube 文档中心</strong></a>
      <div><span>404</span><h1>没有这个文档章节</h1><p><code>{pathname}</code> 不在当前文档版本中。</p><a href="/docs">返回文档首页</a></div>
    </div>
  );
}

function operationAnchor(operation: OpenApiOperation) {
  return operation.operationId || slugifyDocsHeading(`${operation.method}-${operation.path}`);
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return Children.toArray(node).map(nodeText).join("");
}
