import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
let browser;
const local = days => new Date(Date.now() + days * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
const expiry = value => new Date(Date.parse(value + "T00:00:00+08:00") + 86400_000).toISOString();
const errors = [];
async function selectExpiry(page, label, value) {
  await page.getByRole("button", { name: label, exact: true }).click();
  const picker = page.locator(".calendar-date-popover");
  await picker.waitFor();
  const bounds = await picker.boundingBox();
  const viewport = page.viewportSize();
  assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, "Date picker must stay inside viewport");
  assert.equal(await page.locator('.access-expiry-field input[type="checkbox"]').count(), 0);
  if (label === "申请使用至") assert.equal(await picker.getByRole("button", { name: "长期有效", exact: true }).count(), 0);
  const date = value.slice(0, 10);
  for (let i = 0; i < 24 && !await picker.locator(`[data-date="${date}"]`).count(); i++) {
    const middle = await picker.locator("[data-date]").nth(15).getAttribute("data-date");
    await picker.getByRole("button", { name: date < middle ? "上个月" : "下个月", exact: true }).click();
  }
  await picker.locator(`[data-date="${date}"]`).click();
  assert.equal(await page.locator('input[type="time"]').count(), 0);
}
async function open(actor, locale, width, path) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, timezoneId: "Asia/Shanghai" });
  const cookie = fixture.accounts[actor].cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  await context.addInitScript(locale => localStorage.setItem("allocube:locale:v1", locale), locale);
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.origin + path);
  return { page, context };
}
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  await mkdir(".codex-tmp/machine-access-expiry", { recursive: true });
  const applicant = await open("other", "zh-CN", 1280, "/resources");
  const card = applicant.page.locator(".resource-catalog-card").filter({ hasText: "Realtime machine 1" });
  await card.getByRole("button").click();
  await applicant.page.screenshot({ path: ".codex-tmp/machine-access-expiry/apply-zh.png", fullPage: true });
  const deadline = local(4);
  for (const days of [7, 15, 30]) {
    await applicant.page.getByRole("button", { name: "申请使用至", exact: true }).click();
    const shortcuts = applicant.page.locator(".calendar-date-footer");
    assert.equal(await shortcuts.getByRole("button").count(), 3);
    await shortcuts.getByRole("button", { name: `${days}天`, exact: true }).click();
    assert.equal(await applicant.page.getByRole("button", { name: "申请使用至", exact: true }).innerText(), local(days));
  }
  await selectExpiry(applicant.page, "申请使用至", deadline);
  await applicant.page.getByRole("button", { name: "提交申请", exact: true }).click();
  await applicant.page.getByRole("dialog").waitFor({ state: "hidden" });

  const admin = await open("Administrator", "zh-CN", 1440, `/admin/machines/${fixture.ids.machine1}/users`);
  const pending = admin.page.locator(".machine-request-row").filter({ hasText: "other" });
  await pending.locator(".access-expiry-button").click();
  await admin.page.getByRole("button", { name: "到期日期", exact: true }).click();
  await admin.page.locator(".calendar-date-popover").waitFor();
  assert.deepEqual(await admin.page.locator(".calendar-date-footer button").allTextContents(), ["7天", "15天", "30天", "长期有效"]);
  await admin.page.screenshot({ path: ".codex-tmp/machine-access-expiry/picker-zh.png", fullPage: true, animations: "disabled" });
  await admin.page.keyboard.press("Escape");
  assert.equal(await admin.page.locator('[role="dialog"][aria-modal="true"]').count(), 1, "Escape closes the picker, not its parent editor");
  await selectExpiry(admin.page, "到期日期", local(3));
  await admin.page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await admin.page.getByRole("dialog").waitFor({ state: "hidden" });
  await admin.page.screenshot({ path: ".codex-tmp/machine-access-expiry/pending-zh.png", fullPage: true });
  const approvalResponse = admin.page.waitForResponse(response => response.url().endsWith("/approve"));
  await pending.getByRole("button", { name: "通过申请", exact: true }).click();
  const approval = await approvalResponse;
  assert.equal(approval.status(), 200, await approval.text());
  await pending.waitFor({ state: "hidden" });
  const member = admin.page.locator(".machine-member-row").filter({ hasText: "other" });
  await member.locator(".access-expiry-button").waitFor();
  await member.locator(".access-expiry-button").click();
  await admin.page.getByRole("button", { name: "到期日期", exact: true }).click();
  await admin.page.locator(".calendar-date-popover").getByRole("button", { name: "长期有效", exact: true }).click();
  assert.equal(await admin.page.getByRole("button", { name: "到期日期", exact: true }).innerText(), "长期有效");
  await admin.page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await admin.page.getByRole("dialog").waitFor({ state: "hidden" });
  await member.getByText("长期有效", { exact: true }).waitFor();

  const boundary = Date.parse(expiry(local(2)));
  const segment = { resourceGroupId: fixture.ids.group1, startAt: new Date(boundary - 30 * 60_000).toISOString(), endAt: new Date(boundary + 30 * 60_000).toISOString(), scope: "RESOURCE_GROUP" };
  const booked = await fixture.request("other", "/reservations/batch", "POST", { segments: [segment] });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  await member.locator(".access-expiry-button").click();
  const shortened = local(2);
  await selectExpiry(admin.page, "到期日期", shortened);
  await admin.page.getByText("超期占用将取消或截断，且不会自动恢复。", { exact: true }).waitFor();
  await admin.page.screenshot({ path: ".codex-tmp/machine-access-expiry/shorten-zh.png", fullPage: true });
  await admin.page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await admin.page.getByRole("dialog").waitFor({ state: "hidden" });
  const mine = await fixture.request("other", "/reservations/mine?category=UPCOMING");
  assert.equal(mine.body.reservations[0].endAt, expiry(shortened));
  await member.locator(".access-expiry-button").click();
  const promoted = await fixture.request("Administrator", `/admin/machines/${fixture.ids.machine1}/managers/${fixture.ids.other}`, "PUT", {});
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  await admin.page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: "hidden" });
  await member.getByText("长期有效", { exact: true }).waitFor();
  assert.equal(await member.locator(".access-expiry-button").count(), 0);

  const narrow = await open("Administrator", "en", 390, `/admin/machines/${fixture.ids.machine1}/users`);
  await narrow.page.locator(".machine-member-row").filter({ hasText: "other" }).getByText("Permanent", { exact: true }).waitFor();
  await narrow.page.screenshot({ path: ".codex-tmp/machine-access-expiry/members-en-mobile.png", fullPage: true });
  // The existing admin shell has a desktop minimum width. Keep new column overflow inside its list.
  assert(await narrow.page.locator(".machine-member-list").evaluate(list => list.getBoundingClientRect().width <= list.parentElement.getBoundingClientRect().width), "Expiry columns must stay inside their panel");
  await narrow.page.locator(".machine-member-row").filter({ hasText: "owner" }).locator(".access-expiry-button").click();
  await narrow.page.getByRole("button", { name: "Expiration date", exact: true }).click();
  const mobilePicker = narrow.page.locator(".calendar-date-popover");
  await mobilePicker.waitFor();
  const mobileBounds = await mobilePicker.boundingBox();
  assert(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 391, "Mobile picker must fit viewport");
  await narrow.page.screenshot({ path: ".codex-tmp/machine-access-expiry/picker-en-mobile.png", fullPage: true, animations: "disabled" });
  await narrow.page.keyboard.press("Escape");
  await narrow.page.getByRole("button", { name: "Cancel", exact: true }).click();
  await admin.page.getByRole("button", { name: "邀请用户", exact: true }).click();
  await admin.page.locator(".invite-member-modal").waitFor();
  assert.equal(await admin.page.locator(".invite-member-modal .context-notice").count(), 0);
  await admin.page.screenshot({ path: ".codex-tmp/machine-access-expiry/invite-zh.png", fullPage: true });
  await narrow.context.close(); await admin.context.close(); await applicant.context.close();
  assert.deepEqual(errors, []);
  console.log("Machine access expiration browser flow passed (Chinese desktop / English mobile)");
} finally { await browser?.close(); await fixture.close(); }
