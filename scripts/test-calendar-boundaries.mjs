import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const day = new Date(Date.now() + (24 + 8) * 3_600_000).toISOString().slice(0, 10);
const base = Date.parse(`${day}T00:00:00+08:00`);
const iso = minutes => new Date(base + minutes * 60_000).toISOString();
const nextDay = new Date(base + (24 + 8) * 3_600_000).toISOString().slice(0, 10);
let release;
try {
  for (const [group, end] of [[fixture.ids.group1, 1440], [fixture.ids.group2, 1441]]) {
    const result = await fixture.request("owner", "/reservations/batch", "POST", { segments: [{
      resourceGroupId: group, startAt: iso(1080), endAt: iso(end).replace(".000Z", "Z")
    }] });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: "Asia/Shanghai" });
    context.setDefaultTimeout(10_000);
    await context.addInitScript(theme => {
      localStorage.setItem("allocube:locale:v1", "zh-CN");
      localStorage.setItem("allocube:theme:v1", theme);
    }, theme);
    const cookie = fixture.accounts.owner.cookie, split = cookie.indexOf("=");
    await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${fixture.origin}/calendar?date=${day}&view=day`);
    await page.locator(".live-state.connected").waitFor();
    const bars = page.locator(".timeline-bar-visual.booking-bar");
    await bars.nth(1).waitFor();
    assert.deepEqual(await bars.locator("small").allTextContents(), ["18:00–24:00", "18:00–24:00"]);

    // Retain yesterday's payload while the next day's request is pending.
    const gate = new Promise(resolve => { release = resolve; });
    let held;
    const requested = new Promise(resolve => { held = resolve; });
    await page.route("**/api/v1/timeline?**", async route => {
      held();
      await gate;
      await route.continue();
    });
    const refreshed = page.waitForResponse(response => response.url().includes("/api/v1/timeline?"));
    await page.getByRole("button", { name: "下一时间范围", exact: true }).click();
    await Promise.race([requested, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Next-day timeline request did not start")), 10_000);
      timer.unref();
    })]);
    assert.deepEqual(await bars.locator("small").allTextContents(), ["00:00–00:01"]);
    release(); release = undefined;
    await refreshed;
    await page.unroute("**/api/v1/timeline?**");
    assert.deepEqual(await bars.locator("small").allTextContents(), ["00:00–00:01"]);
    assert.equal(await page.locator(".timeline-row").first().locator(".timeline-bar-anchor").count(), 0);

    await page.getByRole("button", { name: "一周", exact: true }).click();
    const emptyDay = page.getByRole("button", { name: `${nextDay} CPU group 1，空闲，点击查看日视图`, exact: true });
    await emptyDay.waitFor();
    assert.equal(await emptyDay.locator(".week-mini-track i").count(), 0);
    await emptyDay.hover();
    assert.equal(await page.locator(".week-day-popover").count(), 0);
    const occupiedDay = page.getByRole("button", { name: new RegExp(`^${nextDay} CPU group 2，`) });
    assert.equal(await occupiedDay.locator(".week-mini-track i").count(), 1);
    await occupiedDay.hover();
    await page.locator(".week-day-popover").waitFor();
    assert.deepEqual(await page.locator(".week-day-popover time").allTextContents(), ["00:00–00:01"]);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ theme, midnightEndExcluded: true, stalePayloadClipped: true, realMidnightMinuteRetained: true, weekSummaryAndPopover: true }));
    await context.close();
  }
} finally { release?.(); await browser.close(); await fixture.close(); }
