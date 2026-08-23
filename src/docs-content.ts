import apiMarkdown from "../docs/manual/api.md?raw";
import gettingStartedMarkdown from "../docs/manual/getting-started.md?raw";
import machineAdminMarkdown from "../docs/manual/machine-admin.md?raw";
import operationsMarkdown from "../docs/manual/operations.md?raw";
import overviewMarkdown from "../docs/manual/README.md?raw";
import systemAdminMarkdown from "../docs/manual/system-admin.md?raw";
import troubleshootingMarkdown from "../docs/manual/troubleshooting.md?raw";
import userGuideMarkdown from "../docs/manual/user-guide.md?raw";
import { docsPath, type DocsSlug } from "./docs-routing";

export const DOCS_ALLOW_RAW_HTML = false;

export type DocsHeading = {
  depth: 1 | 2 | 3;
  id: string;
  text: string;
};

export type DocsSection = {
  slug: DocsSlug;
  title: string;
  description: string;
  path: string;
  markdown: string;
};

export const docsSections: readonly DocsSection[] = [
  {
    slug: "overview",
    title: "产品介绍",
    description: "认识 Allocube 的角色、核心概念和能力边界。",
    path: docsPath("overview"),
    markdown: overviewMarkdown
  },
  {
    slug: "getting-started",
    title: "开始使用",
    description: "注册、审核、登录、密码找回和首次使用。",
    path: docsPath("getting-started"),
    markdown: gettingStartedMarkdown
  },
  {
    slug: "user-guide",
    title: "普通用户指南",
    description: "机器使用权、资源浏览、占用管理、通知和用户信息。",
    path: docsPath("user-guide"),
    markdown: userGuideMarkdown
  },
  {
    slug: "machine-admin",
    title: "机器管理员指南",
    description: "成员、申请、资源、维护和占用释放。",
    path: docsPath("machine-admin"),
    markdown: machineAdminMarkdown
  },
  {
    slug: "system-admin",
    title: "系统管理员指南",
    description: "用户、机器、系统公告、系统设置、统计和审计。",
    path: docsPath("system-admin"),
    markdown: systemAdminMarkdown
  },
  {
    slug: "operations",
    title: "部署与运维",
    description: "初始化、Docker、升级、备份、安全和健康检查。",
    path: docsPath("operations"),
    markdown: operationsMarkdown
  },
  {
    slug: "api",
    title: "官方 API",
    description: "个人访问令牌、认证、查询、两阶段写入和兼容策略。",
    path: docsPath("api"),
    markdown: apiMarkdown
  },
  {
    slug: "troubleshooting",
    title: "故障排查",
    description: "常见提示、部署问题和 API 调用异常。",
    path: docsPath("troubleshooting"),
    markdown: troubleshootingMarkdown
  }
];

export const docsSectionBySlug = new Map(
  docsSections.map((section) => [section.slug, section])
);

export function slugifyDocsHeading(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

export function extractDocsHeadings(markdown: string): DocsHeading[] {
  const used = new Map<string, number>();
  const headings: DocsHeading[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const text = stripInlineMarkdown(match[2]);
    const base = slugifyDocsHeading(text);
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    headings.push({
      depth: match[1].length as 1 | 2 | 3,
      id: seen ? `${base}-${seen + 1}` : base,
      text
    });
  }
  return headings;
}

export function markdownSearchText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*/g, " "))
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*~`|\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function docsSectionMatches(section: DocsSection, query: string) {
  const terms = normalizeSearchTerms(query);
  if (terms.length === 0) return false;
  const haystack = normalizeSearchValue(
    `${section.title} ${section.description} ${markdownSearchText(section.markdown)}`
  );
  return terms.every((term) => haystack.includes(term));
}

export function normalizeSearchTerms(query: string) {
  return normalizeSearchValue(query).split(" ").filter(Boolean);
}

function normalizeSearchValue(value: string) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function stripInlineMarkdown(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
}
