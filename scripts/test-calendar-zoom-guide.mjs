import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const day = new Date(Date.now() + 32 * 3_600_000).toISOString().slice(0, 10);
try {
  await mkdir(".codex-tmp/zoom-guide", { recursive: true });
  for (const [theme, locale, width] of [["light", "zh-CN", 1440], ["dark", "en", 390]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "Asia/Shanghai" });
    context.setDefaultTimeout(10_000);
    await context.addInitScript(({ theme, locale }) => {
      localStorage.setItem("allocube:locale:v1", locale);
      localStorage.setItem("allocube:theme:v1", theme);
      if (!sessionStorage.getItem("zoom-test-initialized")) {
        localStorage.setItem("allocube.calendar-preference.v1", JSON.stringify({ visibleHours: 12, reservationMode: "RESOURCE_GROUP" }));
        sessionStorage.setItem("zoom-test-initialized", "true");
      }
    }, { theme, locale });
    const cookie = fixture.accounts.owner.cookie, split = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const guide = page.locator(".calendar-zoom-guide");
    const zoomLabel = page.locator(".timeline-zoom-control span");
    const zoomIn = page.locator(".timeline-zoom-control button").last();
    await page.goto(`${fixture.origin}/calendar?date=${day}&view=day`);
    await page.locator(".live-state.connected").waitFor();
    await page.locator(".time-track").first().waitFor();
    await guide.waitFor();
    assert.equal(await zoomLabel.innerText(), "24h");
    assert.match(await guide.innerText(), locale === "en" ? /system update/ : /系统更新/);
    assert.equal(await guide.evaluate(node => node.scrollWidth <= node.clientWidth), true);
    const guideBox = await guide.boundingBox(), gridBox = await page.locator(".timeline-scroll-frame").boundingBox();
    assert(guideBox.y + guideBox.height <= gridBox.y + 1, "Guide must not overlap the calendar");
    assert(guideBox.x >= 0 && guideBox.x + guideBox.width <= width, "Floating guide must remain inside the viewport");
    const toolbarBox = await page.locator(".calendar-main > .toolbar").boundingBox();
    assert(Math.abs(toolbarBox.y + toolbarBox.height - gridBox.y) <= 1, "Guide must not allocate a row or move the calendar");
    assert.deepEqual(await guide.evaluate(node => ({ portal: node.parentElement === document.body, position: getComputedStyle(node).position, pointerEvents: getComputedStyle(node).pointerEvents })),
      { portal: true, position: "fixed", pointerEvents: "none" });
    await page.screenshot({ path: `.codex-tmp/zoom-guide/${theme}-${locale}-${width}.png` });
    await zoomIn.scrollIntoViewIfNeeded();
    await guide.locator(".calendar-zoom-guide-arrow").waitFor();
    await page.getByRole("button", { name: locale === "en" ? "Week" : "一周", exact: true }).click();
    assert.equal(await guide.count(), 0);
    await page.getByRole("button", { name: locale === "en" ? "Day" : "一天", exact: true }).click();
    await guide.waitFor();

    // Zooming should acknowledge the guide without discarding an existing draft.
    await page.locator(".drawer-add-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(await guide.locator("button").evaluate(node => {
      const rect = node.getBoundingClientRect();
      return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".calendar-zoom-guide"));
    }), false, "Guide must not sit above an active modal");
    await dialog.locator('[name="manualStartAt"]').fill(`${day}T09:00`);
    await dialog.locator('[name="manualEndAt"]').fill(`${day}T10:00`);
    await dialog.locator('button[type="submit"]').click();
    const draft = page.locator(".booking-drawer .draft-card").first();
    await draft.waitFor();
    const title = page.locator('.booking-drawer input[name="title"]');
    await title.fill("Keep my draft");
    await zoomIn.focus(); await zoomIn.press("Enter");
    assert.equal(await zoomLabel.innerText(), "12h");
    assert.equal(await guide.count(), 0);
    assert.equal(await title.inputValue(), "Keep my draft");
    assert.equal(await draft.locator('[name="startAt"]').inputValue(), `${day}T09:00`);
    await page.reload();
    await page.locator(".live-state.connected").waitFor();
    assert.equal(await zoomLabel.innerText(), "12h");
    assert.equal(await guide.count(), 0);

    // Dismissal is persistent too and returns keyboard focus to the zoom control.
    await page.evaluate(() => {
      localStorage.removeItem("allocube.calendar-zoom-guide.v1");
    });
    await page.reload(); await guide.waitFor();
    assert.equal(await zoomLabel.innerText(), "12h");
    assert.match(await guide.innerText(), locale === "en" ? /system update/ : /系统更新/);
    await guide.locator("button").focus(); await guide.locator("button").press("Enter");
    assert.equal(await guide.count(), 0);
    assert.equal(await zoomIn.evaluate(node => node === document.activeElement), true);
    assert.equal(await zoomLabel.innerText(), "12h");
    await page.reload(); await page.locator(".live-state.connected").waitFor();
    assert.equal(await guide.count(), 0);

    await page.evaluate(() => {
      localStorage.removeItem("allocube.calendar-zoom-guide.v1");
    });
    await page.reload(); await guide.waitFor();
    await page.locator(".time-track").first().hover();
    await page.keyboard.down("Alt"); await page.mouse.wheel(0, -100); await page.keyboard.up("Alt");
    await guide.waitFor({ state: "detached" });
    assert.equal(await zoomLabel.innerText(), "6h");
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ theme, locale, width, migratedOnce: true, guideDismissal: true, keyboardAndWheel: true, draftRetained: true, floatingWithoutLayoutShift: true }));
    await context.close();
  }
} finally { await browser.close(); await fixture.close(); }
