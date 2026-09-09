import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const endpoint = "/admin/system-maintenance";
const read = async () => (await fixture.request("Administrator", endpoint)).body;
const save = async text => {
  const current = await read();
  const response = await fixture.request("Administrator", endpoint, "PUT", { text, expectedVersion: current.version });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
};
async function open(actor, theme, locale, width, pathname, storageBlocked = false) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, timezoneId: "Asia/Shanghai" });
  context.setDefaultTimeout(10_000);
  const cookie = fixture.accounts[actor].cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  await context.addInitScript(({ theme, locale, storageBlocked }) => {
    localStorage.setItem("allocube:theme:v1", theme); localStorage.setItem("allocube:locale:v1", locale);
    localStorage.setItem("allocube.calendar-zoom-guide.v1", "dismissed");
    if (storageBlocked) for (const method of ["getItem", "setItem"]) {
      const original = Storage.prototype[method];
      Storage.prototype[method] = function(key, ...args) {
        if (key.startsWith("allocube:system-maintenance-dismissed:")) throw new DOMException("Disabled", "SecurityError");
        return original.call(this, key, ...args);
      };
    }
  }, { theme, locale, storageBlocked });
  const page = await context.newPage();
  await page.route("**/api/v1/auth/me", async route => {
    const response = await route.fetch(), body = await response.json();
    body.user.passwordChangeRecommended = true;
    await route.fulfill({ response, json: body });
  });
  await page.goto(fixture.origin + pathname);
  return { context, page };
}
let release;
try {
  await mkdir(".codex-tmp/system-maintenance", { recursive: true });
  for (const [theme, locale, width] of [["light", "zh-CN", 1440], ["dark", "en", 390]]) {
    const text = "系统将于今晚升级，期间可能短暂中断。 <b>Plain text</b> **Maintenance**";
    await save(text);
    const day = new Date(Date.now() + 32 * 3_600_000).toISOString().slice(0, 10);
    const { context, page } = await open("peer", theme, locale, width, `/calendar?date=${day}&view=day`);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const banner = page.locator(".system-maintenance-banner");
    await banner.waitFor();
    assert.equal(await banner.locator("span").innerText(), text);
    assert.equal(await banner.locator("b,strong").count(), 0);
    const header = await page.locator(".topbar").boundingBox(), strip = await banner.boundingBox(), password = await page.locator(".password-banner").boundingBox();
    assert(Math.abs(strip.y - header.y - header.height) <= 1);
    assert(Math.abs(password.y - strip.y - strip.height) <= 1);
    const close = await banner.getByRole("button").boundingBox(); assert(close.x + close.width <= width);
    await page.screenshot({ path: `.codex-tmp/system-maintenance/${theme}-${locale}-banner.png` });
    await page.locator(".drawer-add-button").click();
    const manual = page.getByRole("dialog");
    await manual.locator('[name="manualStartAt"]').fill(`${day}T09:00`);
    await manual.locator('[name="manualEndAt"]').fill(`${day}T10:00`);
    await manual.locator('button[type="submit"]').click();
    const draft = page.locator('.booking-drawer input[name="title"]'); await draft.fill("Maintenance keeps draft");
    await banner.getByRole("button").click();
    await banner.waitFor({ state: "detached" }); assert.equal(await draft.inputValue(), "Maintenance keeps draft");
    const tab = await context.newPage(); await tab.goto(fixture.origin + "/calendar");
    await tab.locator(".calendar-layout").waitFor(); assert.equal(await tab.locator(".system-maintenance-banner").count(), 0);
    await tab.close(); await page.bringToFront();
    await save("维护时间已更新 / Maintenance rescheduled");
    await banner.getByText("维护时间已更新 / Maintenance rescheduled", { exact: true }).waitFor();
    assert.equal(await draft.inputValue(), "Maintenance keeps draft");
    const otherTab = await context.newPage(); await otherTab.goto(fixture.origin + "/calendar");
    await otherTab.locator(".system-maintenance-banner button").click();
    await page.bringToFront(); await banner.waitFor({ state: "detached" });
    await otherTab.close();
    await save(""); await save("Another update"); await banner.getByText("Another update", { exact: true }).waitFor();
    await save(""); await banner.waitFor({ state: "detached" });
    assert.equal(await draft.inputValue(), "Maintenance keeps draft");
    assert.deepEqual(errors, []); await context.close();
    console.log(JSON.stringify({ theme, locale, width, bannersStack: true, plainText: true, dismissalPersists: true, newVersionReappears: true, crossTabDismissal: true, draftRetained: true }));
  }
  const { context, page } = await open("Administrator", "light", "zh-CN", 1440, "/admin/announcements");
  const panel = page.locator(".system-maintenance-panel"), input = page.locator('[name="systemMaintenanceText"]');
  const edit = () => panel.getByRole("button", { name: "编辑", exact: true }).click();
  const submit = () => page.getByRole("dialog").getByRole("button", { name: "保存修改", exact: true }).click();
  await edit(); await input.fill("本地维护草稿"); await save("其他管理员的更新");
  await panel.getByText("其他管理员的更新", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "本地维护草稿");
  await submit();
  const conflict = page.getByRole("dialog", { name: "数据已更新", exact: true });
  await conflict.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await input.inputValue(), "本地维护草稿"); assert.equal((await read()).text, "其他管理员的更新");
  await submit(); await page.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await input.waitFor({ state: "detached" }); await panel.getByText("本地维护草稿", { exact: true }).waitFor();
  await page.screenshot({ path: ".codex-tmp/system-maintenance/admin.png" });
  await edit();
  const paste = text => input.evaluate((node, text) => {
    node.select(); const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", text);
    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, text);
  await paste("  系统\r\n升级  "); assert.equal(await input.inputValue(), "系统 升级");
  await paste("字".repeat(121)); await page.getByRole("alert").getByText("维护提示不能超过 120 字").waitFor();
  assert(await page.getByRole("dialog").getByRole("button", { name: "保存修改", exact: true }).isDisabled());
  await input.fill("字".repeat(120));
  await page.getByRole("dialog").screenshot({ path: ".codex-tmp/system-maintenance/editor.png" });
  let writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/v1/admin/system-maintenance", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    writes++; const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  await submit(); await page.getByRole("dialog").locator("form").dispatchEvent("submit");
  assert(await input.isDisabled()); await page.keyboard.press("Escape"); assert.equal(await input.count(), 1);
  release(); release = undefined; await input.waitFor({ state: "detached" }); assert.equal(writes, 1);
  await page.unroute("**/api/v1/admin/system-maintenance");
  await panel.getByText("字".repeat(120), { exact: true }).waitFor();
  await edit(); await input.fill(""); await submit(); await input.waitFor({ state: "detached" });
  assert.equal((await read()).text, ""); await context.close();
  await save("Storage unavailable");
  const blocked = await open("peer", "dark", "en", 390, "/calendar", true);
  await blocked.page.locator(".system-maintenance-banner button").click();
  await blocked.page.locator(".system-maintenance-banner").waitFor({ state: "detached" });
  await save("New maintenance"); await blocked.page.locator(".system-maintenance-banner").waitFor();
  await blocked.context.close();
  console.log(JSON.stringify({ adminEditor: true, conflictCancelAndOverwrite: true, validation: true, duplicateSubmitBlocked: true, storageFailure: true }));
} finally { release?.(); await browser.close(); await fixture.close(); }
