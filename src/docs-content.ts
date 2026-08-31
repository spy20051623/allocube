import { currentLocale, tr, type AppLocale } from "./i18n/index";
import type { TranslationKey } from "./i18n/resources";
import apiMarkdown from "../docs/manual/api.md?raw";
import gettingStartedMarkdown from "../docs/manual/getting-started.md?raw";
import machineAdminMarkdown from "../docs/manual/machine-admin.md?raw";
import operationsMarkdown from "../docs/manual/operations.md?raw";
import overviewMarkdown from "../docs/manual/README.md?raw";
import systemAdminMarkdown from "../docs/manual/system-admin.md?raw";
import troubleshootingMarkdown from "../docs/manual/troubleshooting.md?raw";
import userGuideMarkdown from "../docs/manual/user-guide.md?raw";
import apiMarkdownEn from "../docs/manual/en/api.md?raw";
import gettingStartedMarkdownEn from "../docs/manual/en/getting-started.md?raw";
import machineAdminMarkdownEn from "../docs/manual/en/machine-admin.md?raw";
import operationsMarkdownEn from "../docs/manual/en/operations.md?raw";
import overviewMarkdownEn from "../docs/manual/en/README.md?raw";
import systemAdminMarkdownEn from "../docs/manual/en/system-admin.md?raw";
import troubleshootingMarkdownEn from "../docs/manual/en/troubleshooting.md?raw";
import userGuideMarkdownEn from "../docs/manual/en/user-guide.md?raw";
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

function createDocsSections(locale: AppLocale): readonly DocsSection[] {
  const english = locale === "en";
  const text = (key: TranslationKey) => tr(key, { lng: locale });
  return [
  {
    slug: "overview",
    title: text("产品介绍"),
    description: text("认识 Allocube 的角色、核心概念和能力边界。"),
    path: docsPath("overview"),
    markdown: english ? overviewMarkdownEn : overviewMarkdown
  },
  {
    slug: "getting-started",
    title: text("开始使用"),
    description: text("注册、审核、登录、密码找回和首次使用。"),
    path: docsPath("getting-started"),
    markdown: english ? gettingStartedMarkdownEn : gettingStartedMarkdown
  },
  {
    slug: "user-guide",
    title: text("普通用户指南"),
    description: text("机器使用权、资源浏览、占用管理、通知和用户信息。"),
    path: docsPath("user-guide"),
    markdown: english ? userGuideMarkdownEn : userGuideMarkdown
  },
  {
    slug: "machine-admin",
    title: text("机器管理员指南"),
    description: text("成员、申请、资源、维护和占用释放。"),
    path: docsPath("machine-admin"),
    markdown: english ? machineAdminMarkdownEn : machineAdminMarkdown
  },
  {
    slug: "system-admin",
    title: text("系统管理员指南"),
    description: text("用户、机器、系统公告、系统设置、统计和审计。"),
    path: docsPath("system-admin"),
    markdown: english ? systemAdminMarkdownEn : systemAdminMarkdown
  },
  {
    slug: "operations",
    title: text("部署与运维"),
    description: text("初始化、Docker、升级、备份、安全和健康检查。"),
    path: docsPath("operations"),
    markdown: english ? operationsMarkdownEn : operationsMarkdown
  },
  {
    slug: "api",
    title: text("官方 API"),
    description: text("个人访问令牌、认证、查询、两阶段写入和兼容策略。"),
    path: docsPath("api"),
    markdown: english ? apiMarkdownEn : apiMarkdown
  },
  {
    slug: "troubleshooting",
    title: text("故障排查"),
    description: text("常见提示、部署问题和 API 调用异常。"),
    path: docsPath("troubleshooting"),
    markdown: english ? troubleshootingMarkdownEn : troubleshootingMarkdown
  }
  ];
}

export const docsSections: readonly DocsSection[] = createDocsSections("zh-CN");

export function getDocsSections(locale = currentLocale()) {
  return createDocsSections(locale);
}

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
