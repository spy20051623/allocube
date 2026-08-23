import {
  AlertTriangle,
  ArrowLeft,
  BookOpenText,
  Boxes,
  Check,
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
  isValidElement,
  useCallback,
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

export function DocumentationPage({ route }: { route: ResolvedDocsRoute }) {
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
  const [copied, setCopied] = useState(false);
  const text = nodeText(children).replace(/\n$/, "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="docs-code-block">
      <button type="button" onClick={() => void copy()} aria-label="复制代码">
        {copied ? <Check size={14} /> : <Clipboard size={14} />}
        {copied ? "已复制" : "复制"}
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
  return (
    <details className="api-operation" id={operationAnchor(operation)}>
      <summary>
        <span className={`api-method method-${operation.method.toLocaleLowerCase()}`}>{operation.method}</span>
        <code>{operation.path}</code>
        <span className="api-summary">{operation.summary}</span>
        <ChevronRight className="api-chevron" size={17} />
      </summary>
      <div className="api-operation-body">
        {operation.description && <p>{operation.description}</p>}
        {operation.operationId && <p className="api-operation-id"><strong>operationId</strong><code>{operation.operationId}</code></p>}
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
        <table>
          <thead><tr><th>名称</th><th>位置</th><th>必填</th><th>说明 / Schema</th></tr></thead>
          <tbody>
            {parameters.map((parameter, index) => (
              <tr key={`${String(parameter.name)}-${index}`}>
                <td><code>{String(parameter.name ?? "-")}</code></td>
                <td>{String(parameter.in ?? "-")}</td>
                <td>{parameter.required === true ? "是" : "否"}</td>
                <td>
                  {typeof parameter.description === "string" && <span>{parameter.description}</span>}
                  {parameter.schema !== undefined && <JsonPreview value={resolveOpenApiValue(document, parameter.schema)} compact />}
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
          return (
            <div className="api-response" key={status}>
              <div><code>{status}</code><span>{String(object.description ?? "")}</span></div>
              {media?.schema !== undefined && (
                <SchemaDisclosure value={resolveOpenApiValue(document, media.schema)} />
              )}
              {media?.example !== undefined && <ApiExample title="示例" value={media.example} />}
              {isObject(media?.examples) && Object.entries(media.examples).map(([name, example]) => (
                <ApiExample key={name} title={name} value={example} />
              ))}
            </div>
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
      <h4>请求体{media?.mediaType ? ` · ${media.mediaType}` : ""}</h4>
      {media?.schema !== undefined && (
        <SchemaDisclosure value={resolveOpenApiValue(document, media.schema)} />
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

function SchemaDisclosure({ value }: { value: unknown }) {
  return (
    <details className="api-schema-disclosure">
      <summary>查看 Schema</summary>
      <JsonPreview value={value} />
    </details>
  );
}

function JsonPreview({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  return (
    <div className={`api-json${compact ? " compact" : ""}`}>
      <button type="button" aria-label="复制 JSON" onClick={async () => {
        try {
          await navigator.clipboard.writeText(serialized);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          setCopied(false);
        }
      }}>{copied ? <Check size={13} /> : <Clipboard size={13} />}</button>
      <pre><code>{serialized}</code></pre>
    </div>
  );
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
