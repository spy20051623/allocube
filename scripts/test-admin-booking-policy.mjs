import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const message = "系统管理员账号已禁止提交占用，请使用个人账号。";
const savePolicy = async blocked => {
  const { body: settings } = await fixture.request("Administrator", "/admin/settings");
  const result = await fixture.request("Administrator", "/admin/settings", "PATCH", { ...settings, blockAdminBookings: blocked, expectedVersion: settings.version });
  assert.equal(result.status, 200);
};
async function pageFor(actor, theme = "light", width = 1440, locale = "zh-CN") {
  const context = await browser.newContext({ viewport: { width, height: 950 }, timezoneId: "Asia/Shanghai" });
  context.setDefaultTimeout(10_000);
  const cookie = fixture.accounts[actor].cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  await context.addInitScript(({ theme, locale }) => {
    localStorage.setItem("allocube:theme:v1", theme); localStorage.setItem("allocube:locale:v1", locale);
    localStorage.setItem("allocube.calendar-zoom-guide.v1", "dismissed");
  }, { theme, locale });
  return { context, page: await context.newPage() };
}
try {
  await mkdir(".codex-tmp/admin-booking-policy", { recursive: true });
  const { page, context } = await pageFor("Administrator");
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.origin + "/admin/settings");
  const toggle = page.getByRole("switch", { name: "禁止系统管理员提交占用" });
  await toggle.waitFor(); assert.equal(await toggle.isChecked(), false);
  await toggle.focus(); await page.keyboard.press("Space"); assert.equal(await toggle.isChecked(), true);
  // A remote change must not replace the local switch draft.
  await savePolicy(false);
  assert.equal(await toggle.isChecked(), true);
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  const conflict = page.getByRole("dialog", { name: "设置已更新" });
  await conflict.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await toggle.isChecked(), true);
  await page.getByRole("button", { name: "保存规则", exact: true }).click();
  await conflict.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await page.getByText("全局占用规则已更新", { exact: true }).waitFor();
  await page.reload(); await toggle.waitFor(); assert.equal(await toggle.isChecked(), true);
  await page.screenshot({ path: ".codex-tmp/admin-booking-policy/settings-light.png" });
  const day = new Date(Date.now() + 32 * 3_600_000).toISOString().slice(0, 10);
  const calendar = await context.newPage(); await calendar.goto(`${fixture.origin}/calendar?date=${day}&view=day`);
  await calendar.getByText(message, { exact: true }).waitFor();
  await calendar.locator(".drawer-add-button").click();
  const manual = calendar.getByRole("dialog");
  await manual.locator('[name="manualStartAt"]').fill(`${day}T09:00`);
  await manual.locator('[name="manualEndAt"]').fill(`${day}T10:00`);
  await manual.locator('button[type="submit"]').click();
  const draft = calendar.locator('.booking-drawer input[name="title"]'); await draft.fill("Policy keeps draft");
  const submit = calendar.getByRole("button", { name: "提交占用", exact: true });
  assert.equal(await submit.isDisabled(), true);
  await calendar.screenshot({ path: ".codex-tmp/admin-booking-policy/calendar-light.png" });
  await savePolicy(false); await calendar.getByText(message, { exact: true }).waitFor({ state: "detached" });
  await submit.waitFor(); await calendar.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "提交占用" && !button.disabled));
  assert.equal(await draft.inputValue(), "Policy keeps draft");
  await savePolicy(true); await calendar.getByText(message, { exact: true }).waitFor();
  assert.equal(await submit.isDisabled(), true); assert.equal(await draft.inputValue(), "Policy keeps draft");
  const { page: peer } = await pageFor("peer"); await peer.goto(fixture.origin + "/calendar");
  await peer.locator(".calendar-layout").waitFor(); assert.equal(await peer.getByText(message, { exact: true }).count(), 0);
  const { page: narrow } = await pageFor("Administrator", "dark", 1280, "en");
  await narrow.goto(fixture.origin + "/admin/settings");
  const narrowToggle = narrow.getByRole("switch", { name: "Prevent system administrators from submitting reservations" });
  await narrowToggle.waitFor(); assert.equal(await narrowToggle.isChecked(), true);
  await narrow.screenshot({ path: ".codex-tmp/admin-booking-policy/settings-dark.png" });
  await narrow.setViewportSize({ width: 390, height: 950 });
  await narrow.goto(fixture.origin + "/calendar");
  const notice = narrow.getByText("System administrator accounts cannot submit reservations. Please use your personal account.", { exact: true });
  await notice.waitFor(); await notice.scrollIntoViewIfNeeded();
  const bounds = await notice.boundingBox(); assert(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await narrow.screenshot({ path: ".codex-tmp/admin-booking-policy/calendar-dark-narrow.png" });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ switchAndKeyboard: true, persistence: true, conflictAndDraft: true, realtime: true, normalUserUnaffected: true, themesAndNarrowLayout: true }));
} finally { await browser.close(); await fixture.close(); }
