import { afterAll, beforeAll, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import i18n, { initializeI18n } from "../src/i18n/index";
import { localizeResourceSummary } from "../src/resource-summary";
import { ResourceSummary } from "../src/features/catalog/ResourceSummary";

beforeAll(initializeI18n);
afterAll(async () => { await i18n.changeLanguage("zh-CN"); });

it("translates every generated marker and preserves administrator-provided text", async () => {
  const source = "共享 · 共享内存 · 512 GB ｜ CPU · 64 核 ｜ 共享 · GPU · 2 张";
  await i18n.changeLanguage("en");
  const expected = "Shared · 共享内存 · 512 GB ｜ CPU · 64 核 ｜ Shared · GPU · 2 张";
  expect(localizeResourceSummary(source)).toBe(expected);
  expect(renderToStaticMarkup(<ResourceSummary value={source} />)).toContain(expected);
  expect(localizeResourceSummary("团队共享 · 128 GB")).toBe("团队共享 · 128 GB");
  expect(localizeResourceSummary("")).toBe("");
  await i18n.changeLanguage("zh-CN");
  expect(localizeResourceSummary(source)).toBe(source);
  expect(renderToStaticMarkup(<ResourceSummary value={source} />)).toContain(source);
});
