import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
let fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const output = ".codex-tmp/theme";
await mkdir(output, { recursive: true });
const errors = [], results = {}, screenshots = [], releases = [], contrastFindings = [];
async function contextFor({ account, locale = "en", width = 1440, theme, colorScheme = "light" } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "Asia/Shanghai", colorScheme });
  context.setDefaultTimeout(10_000);
  await context.addInitScript(({ locale, theme }) => {
    try {
      localStorage.setItem("allocube:locale:v1", locale);
      if (theme && !localStorage.getItem("allocube:theme:v1")) localStorage.setItem("allocube:theme:v1", theme);
    } catch { /* about:blank and the explicitly blocked-storage scenario */ }
  }, { locale, theme });
  if (account) {
    const cookie = fixture.accounts[account].cookie, split = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  }
  context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
  return context;
}
const trigger = page => page.locator('.theme-switcher:visible .language-switcher-trigger');
const language = page => page.locator('.locale-switcher:visible .language-switcher-trigger');
async function select(page, option) {
  await trigger(page).click();
  await page.getByRole("menuitemradio", { name: option, exact: true }).click();
}
async function expectTheme(page, mode, preference) {
  await page.waitForFunction(({ mode, preference }) => document.documentElement.dataset.theme === mode &&
    (!preference || document.documentElement.dataset.themePreference === preference), { mode, preference });
  assert.equal(await page.locator("html").evaluate(e => getComputedStyle(e).colorScheme), mode);
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute("content"), mode === "dark" ? "#111318" : "#f5f6f8");
}
async function screenshot(page, name) {
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: false, animations: "disabled" });
  screenshots.push(name);
  if (name.endsWith("dark")) {
    const findings = await page.evaluate(() => {
      // Normalize modern CSS colors (including color-mix's color(srgb ...)) to byte RGB.
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true }), cache = new Map();
      const rgba = value => {
        if (!cache.has(value)) {
          ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          cache.set(value, [r, g, b, a / 255]);
        }
        return [...cache.get(value)];
      };
      const over = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
      const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const findings = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!(el instanceof HTMLElement) || el.closest(':disabled, [aria-disabled="true"]') || ![...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) continue;
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth || style.visibility !== "visible") continue;
        let bg = [17, 19, 24], opacity = 1, gradient = false;
        const ancestors = []; for (let parent = el; parent; parent = parent.parentElement) ancestors.unshift(parent);
        for (const node of ancestors) {
          const css = getComputedStyle(node); bg = over(rgba(css.backgroundColor), bg); opacity *= Number(css.opacity);
          if (css.backgroundImage !== "none") gradient = true;
        }
        if (gradient || opacity === 0) continue; // Textures are checked through palette pairs and screenshots.
        const color = rgba(style.color); color[3] = (color[3] ?? 1) * opacity;
        if (color[3] === 0) continue; // Invisible heading anchors are revealed on hover/focus.
        const a = luminance(over(color, bg)), b = luminance(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        const large = parseFloat(style.fontSize) >= 24 || parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700;
        if (ratio + .01 < (large ? 3 : 4.5)) findings.push({ tag: el.tagName, className: el.className, text: el.textContent.trim().slice(0, 65), ratio: Number(ratio.toFixed(2)), color: style.color, background: bg });
      }
      return findings;
    });
    if (findings.length) contrastFindings.push({ name, findings });
  }
}
try {
  // A production response with the actual CSP must initialize before any app JS runs.
  for (const preference of [undefined, "light", "dark", "invalid"]) {
    console.log("Early theme:", preference ?? "system");
    const context = await contextFor({ theme: preference, colorScheme: "dark" }), page = await context.newPage();
    let release; const held = new Promise(resolve => { release = resolve; }); releases.push(release);
    await page.route("**/assets/*.js", async route => { await held; await route.continue().catch(() => {}); });
    const response = await page.goto(fixture.origin + "/login", { waitUntil: "commit" });
    const csp = response.headers()["content-security-policy"];
    assert(csp.includes("script-src 'self'"));
    assert(!/script-src[^;]*'unsafe-inline'/.test(csp));
    await expectTheme(page, preference === "light" ? "light" : "dark", ["light", "dark"].includes(preference) ? preference : "system");
    assert.equal(await page.locator("#root").innerHTML(), "");
    release(); await page.locator(".auth-card").waitFor();
    await context.close();
  }
  const init = await fetch(fixture.origin + "/theme-init.js");
  assert.equal(init.status, 200); assert(!(init.headers.get("cache-control") || "").includes("immutable"));
  results.productionCspAndEarlyPaint = true;
  console.log("Early initialization passed; checking preference menus");

  const context = await contextFor({ colorScheme: "dark" }), page = await context.newPage();
  await page.goto(fixture.origin + "/login"); await trigger(page).waitFor();
  await expectTheme(page, "dark", "system");
  await page.emulateMedia({ colorScheme: "light" }); await expectTheme(page, "light", "system");
  await page.locator('input[name="username"]').fill("peer");
  await select(page, "Dark"); assert.equal(await page.locator('input[name="username"]').inputValue(), "peer");
  await expectTheme(page, "dark", "dark");
  await page.emulateMedia({ colorScheme: "dark" }); await select(page, "Light");
  await expectTheme(page, "light", "light");
  await page.reload(); await trigger(page).waitFor(); await expectTheme(page, "light", "light");
  await select(page, "System"); await expectTheme(page, "dark", "system");

  await trigger(page).focus(); await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByRole("menuitemradio", { name: "System", exact: true }).getAttribute("aria-checked"), "true");
  await page.keyboard.press("End"); await page.keyboard.press("ArrowDown");
  assert(await page.getByRole("menuitemradio", { name: "System", exact: true }).evaluate(e => e === document.activeElement));
  await page.keyboard.press("ArrowUp"); await page.keyboard.press("Home"); await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter"); await expectTheme(page, "light", "light");
  assert(await trigger(page).evaluate(e => e === document.activeElement));
  await trigger(page).click(); await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu").count(), 0);
  assert(await trigger(page).evaluate(e => e === document.activeElement));
  await language(page).click(); await trigger(page).click();
  assert.equal(await page.getByRole("menu").count(), 1);
  assert.equal(await language(page).getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Tab"); assert.equal(await page.getByRole("menu").count(), 0);
  results.preferenceAndKeyboard = true;

  const sibling = await context.newPage(); await sibling.goto(fixture.origin + "/login"); await trigger(sibling).waitFor();
  await select(page, "Dark"); await expectTheme(sibling, "dark", "dark");
  await sibling.evaluate(() => localStorage.removeItem("allocube:theme:v1"));
  await expectTheme(page, "dark", "system");
  await select(page, "Dark");
  await page.locator('input[name="username"]').fill("peer");
  await page.locator('input[name="password"]').fill(fixture.password);
  await page.locator('.auth-submit').click();
  await page.locator(".calendar-main").waitFor(); await expectTheme(page, "dark", "dark");
  await page.locator(".topbar-user-trigger").click();
  await page.getByRole("menuitem", { name: /Log out/ }).click();
  await page.locator(".auth-card").waitFor(); await expectTheme(page, "dark", "dark");
  results.tabSyncAndAuthentication = true;
  await context.close();

  const blocked = await contextFor();
  await blocked.addInitScript(() => Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } }));
  const blockedPage = await blocked.newPage(); await blockedPage.goto(fixture.origin + "/login");
  await select(blockedPage, /^(Dark|深色)$/); await expectTheme(blockedPage, "dark", "dark");
  await blocked.close(); results.blockedStorage = true;

  // Hold an actual save response while changing appearance: state and request count must survive.
  const adminContext = await contextFor({ account: "Administrator" }), admin = await adminContext.newPage();
  await admin.goto(fixture.origin + "/admin/settings");
  const input = admin.locator('.settings-fields input[type="number"]').first(); await input.fill("12");
  await select(admin, "Dark"); assert.equal(await input.inputValue(), "12");
  let writes = 0, releaseSave, started;
  const saveHeld = new Promise(resolve => { releaseSave = resolve; }); releases.push(releaseSave);
  const saveStarted = new Promise(resolve => { started = resolve; });
  await admin.route("**/api/v1/admin/settings", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++; const response = await route.fetch(); started(); await saveHeld; await route.fulfill({ response });
  });
  const save = admin.locator(".settings-card").first().locator(".primary-button");
  await save.click(); await saveStarted;
  await select(admin, "Light"); assert(await save.isDisabled()); assert.equal(await input.inputValue(), "12");
  releaseSave(); await admin.waitForFunction(() => !document.querySelector('fieldset.settings-page').disabled);
  assert.equal(writes, 1); await admin.unrouteAll({ behavior: "wait" });
  results.draftAndPendingSave = true;
  console.log("Persistence, authentication and pending save passed; checking calendar and screenshots");

  await admin.goto(fixture.origin + "/calendar"); await admin.locator(".calendar-main").waitFor();
  await admin.locator(".drawer-add-button").click();
  const dialog = admin.getByRole("dialog");
  const times = await admin.evaluate(() => {
    const local = offset => { const d = new Date(Date.now() + offset * 60000); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    return { start: local(60), end: local(90) };
  });
  await dialog.locator('[name="manualStartAt"]').fill(times.start);
  await dialog.locator('[name="manualEndAt"]').fill(times.end);
  await dialog.locator('button.primary-button').click();
  const draft = admin.locator('.booking-drawer input[name="title"]'); await draft.fill("Theme draft retained");
  const count = await admin.locator(".booking-drawer .draft-card").count();
  await select(admin, "Dark"); assert.equal(await draft.inputValue(), "Theme draft retained");
  assert.equal(await admin.locator(".booking-drawer .draft-card").count(), count);
  await screenshot(admin, "calendar-dark-draft");
  results.calendarDraft = true;
  await adminContext.close();

  for (const locale of ["zh-CN", "en"]) for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    // Each matrix cell owns its server and database, keeping rate limits and data isolated.
    await fixture.close(); fixture = await startRealtimeFixture();
    const base = Math.floor(Date.now() / 60000) * 60000;
    const iso = minutes => new Date(base + minutes * 60000).toISOString();
    for (const [account, start, end, scope] of [["owner", 15, 65, "RESOURCE_GROUP"], ["Administrator", 85, 135, "RESOURCE_GROUP"], ["owner", 155, 205, "MACHINE"]]) {
      const created = await fixture.request(account, "/reservations/batch", "POST", { segments: [{ resourceGroupId: fixture.ids.group1, scope, startAt: iso(start), endAt: iso(end), title: `${account} ${scope}` }] });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }
    const period = { startAt: iso(225), endAt: iso(275) };
    const preview = await fixture.request("Administrator", `/admin/groups/${fixture.ids.group1}/unavailability/preview`, "POST", period);
    assert.equal(preview.status, 200);
    const maintenance = await fixture.request("Administrator", `/admin/groups/${fixture.ids.group1}/unavailability`, "POST", { ...period, reason: "Scheduled maintenance", expectedRevision: preview.body.revision });
    assert.equal(maintenance.status, 201, JSON.stringify(maintenance.body));
    const data = new FormData(); data.set("metadata", JSON.stringify({ type: "ISSUE", level: "NORMAL", title: "Theme review", bodyMarkdown: "## Theme review\n\nBody with **emphasis**, `inline code` and a [link](/docs/user-guide).\n\n```js\nconst theme = 'dark';\n```\n\n> Check readable feedback details." }));
    const feedbackResponse = await fetch(fixture.origin + "/api/v1/feedback", { method: "POST", headers: { origin: fixture.origin, cookie: fixture.accounts.owner.cookie, "x-csrf-token": fixture.accounts.owner.csrf }, body: data });
    assert.equal(feedbackResponse.status, 201, await feedbackResponse.clone().text());
    const feedbackId = (await feedbackResponse.json()).ticket.id;
    const routes = [
    ["calendar", "/calendar", ".calendar-main .time-track"], ["settings", "/admin/settings", ".settings-fields input"],
    ["audit", "/admin/audit", "button.audit-record"], ["feedback", `/admin/feedback/${feedbackId}`, ".feedback-detail-page"],
    ["docs", "/docs/user-guide", ".docs-article h1"], ["api", "/docs/api", ".api-operation"]
  ];
    if (locale === "en" && width === 1440 && theme === "dark") routes.push(
      ["resources", "/resources", ".resource-catalog-page"], ["profile", "/profile", ".profile-layout"],
      ["notifications", "/notifications", ".page-shell"], ["machines", "/admin/machines", ".machine-management-content"],
      ["users", "/admin/users", ".admin-table"], ["reports", "/admin/reports", ".report-page"],
      ["announcements", "/admin/announcements", ".announcement-management-page"]
    );
    console.log("Screenshots:", locale, width, theme);
    const ctx = await contextFor({ locale, width, theme }); const screen = await ctx.newPage();
    await screen.goto(fixture.origin + "/login"); await screen.locator(".auth-card").waitFor();
    await screenshot(screen, `login-${locale}-${width}-${theme}`);
    const languageBox = await language(screen).boundingBox(), themeBox = await trigger(screen).boundingBox();
    assert(themeBox.x >= languageBox.x + languageBox.width);
    assert.equal(themeBox.height, languageBox.height);
    await trigger(screen).click(); await screenshot(screen, `menu-${locale}-${width}-${theme}`); await screen.keyboard.press("Escape");
    await screen.goto(fixture.origin + "/register"); await screen.locator(".auth-card").waitFor();
    await expectTheme(screen, theme, theme); await screenshot(screen, `register-${locale}-${width}-${theme}`);
    const cookie = fixture.accounts.Administrator.cookie, split = cookie.indexOf("=");
    await ctx.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
    for (const [name, path, ready] of routes) {
      await screen.goto(fixture.origin + path); await screen.locator(ready).first().waitFor();
      await expectTheme(screen, theme, theme);
      await screenshot(screen, `${name}-${locale}-${width}-${theme}`);
      if (name === "audit") {
        await screen.locator("button.audit-record").first().click(); await screen.locator(".audit-detail-meta").waitFor();
        await screenshot(screen, `dialog-${locale}-${width}-${theme}`); await screen.keyboard.press("Escape");
      }
      if (name === "docs") assert(await screen.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    if (locale === "en" && width === 390 && theme === "dark") {
      await screen.goto(fixture.origin + "/docs/user-guide"); await screen.locator(".docs-article h1").waitFor();
      for (const width of [800, 1024]) {
        await screen.setViewportSize({ width, height: 900 });
        assert(await screen.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Docs width ${width}`);
      }
    }
    await ctx.close();
  }
  results.bilingualResponsiveScreenshots = screenshots.length;
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify({ results, screenshots, contrastFindings }, null, 2));
  assert.deepEqual(contrastFindings, [], "Visible enabled text must meet its contrast threshold");
  console.log(JSON.stringify(results));
} finally { releases.forEach(release => release()); await browser.close(); await fixture.close(); }
