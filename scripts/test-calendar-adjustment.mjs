import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, message) => { for (let i = 0; i < 150; i++) { if (await check()) return; await pause(100); } throw new Error(message); };
const base = Math.floor(Date.now() / 60_000) * 60_000;
const iso = minute => new Date(base + minute * 60_000).toISOString();
const local = minute => new Date(base + (minute + 480) * 60_000).toISOString().slice(0, 16);
let release;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Asia/Shanghai" });
  const cookie = fixture.accounts.peer.cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  await context.addInitScript(() => localStorage.setItem("allocube:locale:v1", "zh-CN"));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let holdPreview = false, held = false, submitRace = false, loseWrite = false, writes = 0, previews = 0;
  const create = async (start, end) => {
    const result = await fixture.request("owner", "/reservations/batch", "POST", { segments: [{ resourceGroupId: fixture.ids.group1, startAt: iso(start), endAt: iso(end) }] });
    assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body.reservations[0];
  };
  await page.route("**/api/v1/reservations/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/preview")) {
      previews++;
      if (holdPreview) {
        holdPreview = false;
        const response = await route.fetch(); held = true;
        await new Promise(resolve => { release = resolve; });
        try { await route.fulfill({ response }); } catch { /* The edited draft cancelled this read. */ }
        return;
      }
    }
    if (path.endsWith("/batch") && route.request().method() === "POST") {
      writes++;
      if (submitRace) { submitRace = false; await create(200, 210); }
      if (loseWrite) { loseWrite = false; await route.fetch(); await route.abort("connectionreset"); return; }
    }
    await route.continue();
  });
  await page.goto(fixture.origin + "/calendar"); await page.locator(".live-state.connected").waitFor();
  const cards = page.locator(".booking-drawer .draft-card");
  const add = async (start, end) => {
    await page.locator(".drawer-add-button").click();
    const dialog = page.getByRole("dialog");
    await dialog.locator('[name="manualStartAt"]').fill(local(start));
    await dialog.locator('[name="manualEndAt"]').fill(local(end));
    await dialog.getByRole("button", { name: "加入占用详情", exact: true }).click();
    await cards.first().waitFor();
  };
  await add(100, 220);
  const title = page.locator('.booking-drawer input[name="title"]'); await title.fill("Keep this draft");
  await create(140, 160);
  await until(async () => await cards.count() === 2, "Remote reservation did not split the draft");
  assert.equal(await title.inputValue(), "Keep this draft");
  assert.equal(await page.getByRole("button", { name: "自动拆分", exact: true }).count(), 0);
  await page.locator('.toast').filter({ hasText: "已自动调整" }).waitFor();
  assert.equal(await page.locator('.booking-drawer [role="status"]').filter({ hasText: "已自动调整" }).count(), 0);

  // A preview of the old input must never replace the user's newer time input.
  holdPreview = true; await create(120, 130);
  await until(() => held, "Held preview did not start");
  await cards.first().locator('[name="startAt"]').fill(local(135)); await title.click();
  await pause(600); release(); release = undefined; await pause(700);
  assert.equal(await cards.first().locator('[name="startAt"]').inputValue(), local(135));
  assert.equal(await cards.count(), 2);

  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await pause(400); const hiddenCount = previews; await create(180, 190); await pause(900); assert.equal(previews, hiddenCount);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await until(async () => await cards.count() === 3, "Foreground draft was not updated");

  submitRace = true;
  const done = page.waitForResponse(response => response.url().endsWith("/reservations/batch"));
  await page.getByRole("button", { name: "提交占用", exact: true }).click();
  const response = await done; assert.equal(response.status(), 201); const body = await response.json();
  assert.equal(body.adjusted, true); assert.equal(body.reservations.length, 4);
  assert(body.reservations.every(row => row.title === "Keep this draft"));
  await until(async () => await cards.count() === 0, "Successful submission did not clear the draft");
  await page.getByText("已自动调整并提交 4 条资源占用", { exact: true }).waitFor();
  assert.equal(writes, 1);

  await add(300, 360); await create(300, 360);
  await until(async () => await cards.count() === 0, "Fully occupied draft was not removed");
  await page.locator('.toast').filter({ hasText: "没有剩余可用时段" }).waitFor();
  assert.equal(writes, 1);

  await add(400, 460); loseWrite = true;
  await page.getByRole("button", { name: "提交占用", exact: true }).click();
  await page.locator(".draft-issues").filter({ hasText: "提交结果暂不明确" }).waitFor();
  await pause(1600); assert.equal(writes, 2); assert.equal(await cards.count(), 1);
  assert(await page.getByRole("button", { name: "提交占用", exact: true }).isDisabled());
  const original = await fixture.request("peer", "/reservations/batch", "POST", { segments: [{ resourceGroupId: fixture.ids.group1, startAt: iso(600), endAt: iso(660), title: "Original notes" }] });
  assert.equal(original.status, 201);
  const originalId = original.body.reservations[0].id;
  const english = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Asia/Shanghai" });
  await english.addCookies(await context.cookies());
  await english.addInitScript(() => localStorage.setItem("allocube:locale:v1", "en"));
  const edit = await english.newPage();
  const params = new URLSearchParams({ date: local(600).slice(0, 10), machine: fixture.ids.machine1, edit: originalId });
  await edit.goto(fixture.origin + "/calendar?" + params);
  const editCards = edit.locator(".booking-drawer .draft-card"); await editCards.first().waitFor();
  await editCards.first().locator('[name="endAt"]').fill(local(720));
  await edit.locator('.booking-drawer input[name="title"]').click();
  await create(680, 700);
  await until(async () => await editCards.count() === 2, "Editing draft did not adjust around the new conflict");
  assert.equal(await edit.locator('.booking-drawer input[name="title"]').inputValue(), "Original notes");
  await edit.locator('.toast').filter({ hasText: "automatically adjusted" }).waitFor();
  assert(await edit.locator(".booking-drawer").evaluate(node => node.scrollWidth <= node.clientWidth));
  const editedResponse = edit.waitForResponse(response => response.url().endsWith("/reservations/batch"));
  await edit.locator(".drawer-actions .primary-button").click();
  const edited = await editedResponse; assert.equal(edited.status(), 201); assert.equal((await edited.json()).reservations.length, 2);
  const storedOriginal = await fixture.request("peer", "/reservations/mine/" + originalId);
  assert.equal(storedOriginal.body.reservation.status, "CANCELLED");
  await english.close();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ automaticSplit: true, noticeWithoutConfirmation: true, latePreviewCannotOverwriteInput: true, hiddenPauseAndResume: true, transactionalAdjustmentAtSubmission: true, metadataPreserved: true, noAvailableSlots: true, uncertainWriteNotReplayed: true, englishNarrowAtomicEditing: true }));
} finally { release?.(); await browser.close(); await fixture.close(); }
