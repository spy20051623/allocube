import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const fixture = await startRealtimeFixture();
const results = {}, errors = [];
async function openPage(locale = "zh-CN", width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(locale => {
    if (!localStorage.getItem("allocube:locale:v1")) localStorage.setItem("allocube:locale:v1", locale);
  }, locale);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  return page;
}
try {
  const page = await openPage();
  const requested = [];
  page.on("request", request => requested.push(request.url()));
  await page.goto(fixture.origin + "/login");
  await page.locator(".auth-card").waitFor();
  assert(!requested.some(url => /DocumentationPage-|\/api\/open\/v1\/openapi.json/.test(url)));
  results.loginDoesNotLoadDocumentation = true;

  const cookie = fixture.accounts.owner.cookie, separator = cookie.indexOf("=");
  await page.context().addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: fixture.origin }]);
  await page.goto(fixture.origin + "/calendar");
  await page.locator(".calendar-main").waitFor();
  assert(!requested.some(url => /DocumentationPage-|\/api\/open\/v1\/openapi.json/.test(url)));
  results.calendarDoesNotLoadDocumentation = true;

  await page.goto(fixture.origin + "/docs/user-guide#申请机器使用权");
  await page.locator(".docs-article h1").filter({ hasText: "普通用户指南" }).waitFor();
  assert(requested.some(url => /DocumentationPage-.*\.js/.test(url)));
  assert(requested.some(url => /DocumentationPage-.*\.css/.test(url)));
  assert.equal(await page.locator(".docs-header").evaluate(element => getComputedStyle(element).position), "sticky");
  await page.locator(".docs-header-actions .language-switcher-trigger").click();
  await page.getByRole("menuitemradio", { name: /English/ }).click();
  await page.locator(".docs-article h1").filter({ hasText: "User guide" }).waitFor();
  await page.locator('.docs-sidebar a[href="/docs/api"]').click();
  await page.locator("#api-reference").waitFor();
  await page.goBack();
  await page.locator(".docs-article h1").filter({ hasText: "User guide" }).waitFor();
  await page.goForward(); await page.locator("#api-reference").waitFor();
  results.directLinkLanguageAndHistory = true;

  const narrow = await openPage("en", 390);
  await narrow.goto(fixture.origin + "/docs/user-guide");
  await narrow.locator(".docs-article h1").filter({ hasText: "User guide" }).waitFor();
  assert(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  results.englishNarrow = true;

  // Retry reloads the same URL, including its anchor, for both JS and CSS failures.
  for (const extension of ["js", "css"]) {
    const failed = await openPage();
    let failOnce = true;
    await failed.route(`**/assets/DocumentationPage-*.${extension}`, async route => {
      if (failOnce) { failOnce = false; return route.abort("connectionreset"); }
      await route.continue();
    });
    await failed.goto(fixture.origin + "/docs/user-guide#申请机器使用权");
    await failed.getByRole("alert").filter({ hasText: "文档加载失败" }).waitFor();
    await failed.getByRole("button", { name: "重试", exact: true }).click();
    await failed.locator(".docs-article h1").filter({ hasText: "普通用户指南" }).waitFor();
    assert.equal(decodeURIComponent(new URL(failed.url()).hash), "#申请机器使用权");
    assert.equal(await failed.locator(".docs-header").evaluate(element => getComputedStyle(element).position), "sticky");
    results[`${extension}FailureRetry`] = true;
  }

  const slow = await openPage();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await slow.route("**/assets/DocumentationPage-*.js", async route => { await held; await route.continue().catch(() => {}); });
  await slow.goto(fixture.origin + "/docs/user-guide");
  await slow.locator('.boot-shell [role="status"]').waitFor();
  await slow.getByRole("alert").filter({ hasText: "文档加载失败" }).waitFor({ timeout: 20_000 });
  release();
  await slow.getByRole("button", { name: "重试", exact: true }).click();
  await slow.locator(".docs-article h1").waitFor();
  results.timeoutAndRetry = true;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(results));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    if (!page.isClosed()) console.error(JSON.stringify({ url: page.url(), headings: await page.locator("h1").allTextContents(), locale: await page.evaluate(() => localStorage.getItem("allocube:locale:v1")) }));
  }
  throw error;
} finally { await browser.close(); await fixture.close(); }
