import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

// Optional browser acceptance runner; does not install browsers or touch the local service.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const fixture = await startRealtimeFixture();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const until = async (condition, message, timeout = 10_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await pause(50); }
  throw new Error(message);
};
async function contextFor(name, locale = "zh-CN") {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const cookie = fixture.accounts[name].cookie, separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: fixture.origin }]);
  await context.addInitScript(locale => localStorage.setItem("allocube:locale:v1", locale), locale);
  await context.addInitScript(() => {
    const original = window.fetch, pending = new Set();
    window.settingsReadConcurrency = 0;
    window.fetch = async (input, options) => {
      if (!String(input).startsWith("/api/v1/admin/settings") || options?.method && options.method !== "GET") return original(input, options);
      const request = {}, finish = () => pending.delete(request);
      pending.add(request); window.settingsReadConcurrency = Math.max(window.settingsReadConcurrency, pending.size);
      options?.signal?.addEventListener("abort", finish, { once: true });
      try { return await original(input, options); }
      finally { finish(); options?.signal?.removeEventListener("abort", finish); }
    };
  });
  return context;
}
const results = {};
const releases = [];
try {
  const context = await contextFor("Administrator"), page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  let firstFailure = true, holdRead = null, holdSave = null, loseSave = false;
  let writes = 0, reads = 0;
  page.on("request", request => {
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/v1/admin/settings") {
      reads++;
    }
  });
  await page.route("**/api/v1/admin/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    try {
      if (request.method() === "GET" && path === "/api/v1/admin/smtp-settings" && firstFailure) {
        firstFailure = false;
        await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Injected outage"}' }); return;
      }
      if (request.method() === "GET" && path === "/api/v1/admin/settings") {
        if (holdRead) {
          const held = holdRead; holdRead = null;
          const response = await route.fetch(); held.started = true;
          await held.promise; await route.fulfill({ response }); return;
        }
      }
      if (request.method() === "PATCH" && path === "/api/v1/admin/settings") {
        writes++;
        const response = await route.fetch();
        if (holdSave) { const held = holdSave; holdSave = null; held.started = true; await held.promise; }
        if (loseSave) { loseSave = false; await route.abort("connectionreset"); return; }
        await route.fulfill({ response }); return;
      }
      await route.continue();
    } catch (error) { if (!page.isClosed() && !/closed|handled|cancel|abort|Invalid Interception/i.test(String(error))) errors.push(String(error)); }
  });
  const rules = page.locator(".settings-fields input[type=number]").first();
  const save = page.locator(".settings-card").first().locator(".primary-button");
  const retryNotice = page.getByText("设置读取失败，正在重试。已有内容和输入已保留。", { exact: true });
  const staleNotice = page.getByText("设置已更新，请重新加载后核对。未保存的内容已保留。", { exact: true });
  const uncertainNotice = page.locator(".context-notice span").filter({ hasText: "操作结果未确认" });
  const sync = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const holdNextRead = () => { const value = deferred(); releases.push(value.release); holdRead = value; return value; };
  const settings = async () => (await fixture.request("Administrator", "/admin/settings")).body;
  const externalSave = async value => {
    const old = await settings();
    const result = await fixture.request("Administrator", "/admin/settings", "PATCH", { minBookingMinutes: value, maxBookingMinutes: old.maxBookingMinutes, advanceDays: old.advanceDays, expectedVersion: old.version });
    assert.equal(result.status, 200); return result;
  };
  const validRules = { minBookingMinutes: 2, maxBookingMinutes: 1440, advanceDays: 30, expectedVersion: 1, overwrite: true };
  assert.equal((await fixture.request("peer", "/admin/settings", "PATCH", validRules)).status, 403);
  const missingCsrf = await fetch(fixture.origin + "/api/v1/admin/settings", {
    method: "PATCH", headers: { origin: fixture.origin, cookie: fixture.accounts.Administrator.cookie, "content-type": "application/json" },
    body: JSON.stringify(validRules)
  });
  assert.equal(missingCsrf.status, 403);
  results.overwriteRetainsAuthorizationAndCsrf = true;
  const conflict = page.getByRole("dialog");
  const confirmOverwrite = () => conflict.getByRole("button", { name: "确认覆盖", exact: true }).click();
  const cancelOverwrite = () => conflict.getByRole("button", { name: "取消", exact: true }).click();

  await externalSave(11);
  await page.goto(fixture.origin + "/admin/settings");
  await retryNotice.waitFor(); assert.equal(await rules.count(), 0);
  await rules.waitFor(); assert.equal(await rules.inputValue(), "11"); assert.equal(await staleNotice.count(), 0);
  results.initialPartialFailureRetries = true;

  const slow = holdNextRead(); await sync(); await until(() => slow.started, "Slow read did not start");
  await rules.fill("12"); await save.click();
  await until(async () => (await settings()).minBookingMinutes === 12 && !(await rules.isDisabled()), "Save did not finish");
  slow.release(); await pause(700); assert.equal(await rules.inputValue(), "12"); assert.equal(await staleNotice.count(), 0);
  results.lateReadCannotUndoSave = true;

  holdSave = deferred(); const saved = holdSave; releases.push(saved.release);
  await rules.fill("13"); const beforeWrites = writes; await save.click();
  await until(() => saved.started, "Write did not reach server");
  assert(await rules.isDisabled()); assert(await save.isDisabled());
  await pause(700); assert.equal(await staleNotice.count(), 0);
  saved.release(); await until(async () => !(await rules.isDisabled()), "Write controls did not unlock");
  assert.equal(writes, beforeWrites + 1); assert.equal(await rules.inputValue(), "13");
  results.ownEventBeforeWriteResponse = true;

  await rules.fill("14"); loseSave = true; const uncertainWrites = writes; await save.click();
  await uncertainNotice.waitFor(); await pause(2500);
  assert.equal(writes, uncertainWrites + 1); assert(await save.isDisabled()); assert.equal(await rules.inputValue(), "14");
  assert.equal((await settings()).minBookingMinutes, 14);
  assert.equal(await page.getByRole("button", { name: "重新加载", exact: true }).count(), 0);
  await page.reload(); await rules.waitFor(); assert.equal(await rules.inputValue(), "14");
  results.committedWriteWithLostResponseNotReplayed = true;

  await rules.fill("15"); const readCount = reads;
  await context.setOffline(true); await sync(); await retryNotice.waitFor();
  await pause(2500); assert.equal(await rules.inputValue(), "15");
  assert(reads - readCount <= 4, "Retry storm");
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
  await pause(500); const hiddenReads = reads; await pause(5500); assert.equal(reads, hiddenReads);
  await context.setOffline(false);
  await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
  await retryNotice.waitFor({ state: "hidden" }); assert.equal(await rules.inputValue(), "15");
  results.offlineAuthFailureKeepsDraft = true; results.hiddenRetriesPaused = true;

  await externalSave(16); await sync(); await pause(700);
  assert.equal(await rules.inputValue(), "15"); assert.equal(await staleNotice.count(), 0); assert(!(await save.isDisabled()));
  await save.click(); await conflict.waitFor();
  assert.equal((await settings()).minBookingMinutes, 16); assert(await rules.isDisabled());
  await cancelOverwrite(); assert.equal(await rules.inputValue(), "15"); assert(!(await save.isDisabled()));
  assert.equal((await settings()).minBookingMinutes, 16); assert.equal(await uncertainNotice.count(), 0);
  results.conflictCancelKeepsDraft = true;

  await save.click(); await conflict.waitFor();
  // Another update while confirmation is open is covered by the explicit overwrite choice.
  await externalSave(17); const beforeOverwrite = writes; await confirmOverwrite();
  await until(async () => (await settings()).minBookingMinutes === 15 && !(await rules.isDisabled()), "Confirmed overwrite did not finish");
  assert.equal(writes, beforeOverwrite + 1); assert.equal(await rules.inputValue(), "15");
  results.confirmedOverwriteSurvivesAnotherUpdate = true;

  const site = page.locator('input[name="site-origin"]');
  await rules.fill("18"); await site.fill("https://draft.allocube.test");
  const base = await settings();
  const remoteSite = await fixture.request("Administrator", "/admin/settings/site-profile", "PATCH", {
    siteOrigin: "https://remote.allocube.test", icpFilingNumber: base.icpFilingNumber,
    publicSecurityFilingNumber: base.publicSecurityFilingNumber, expectedVersion: base.version
  }); assert.equal(remoteSite.status, 200);
  await save.click(); await conflict.waitFor(); await confirmOverwrite();
  await until(async () => !(await rules.isDisabled()), "Booking overwrite did not unlock");
  assert.equal((await settings()).siteOrigin, "https://remote.allocube.test");
  assert.equal(await site.inputValue(), "https://draft.allocube.test");
  await page.getByRole("button", { name: "保存站点信息", exact: true }).click(); await conflict.waitFor();
  await cancelOverwrite(); assert.equal(await site.inputValue(), "https://draft.allocube.test");
  results.otherSectionDraftKeepsOriginalVersion = true;

  // A confirmed overwrite whose response is lost is still never replayed automatically.
  await page.getByRole("button", { name: "保存站点信息", exact: true }).click(); await conflict.waitFor();
  await cancelOverwrite();
  await rules.fill("19"); await externalSave(20); await save.click(); await conflict.waitFor();
  loseSave = true; const lostOverwriteWrites = writes; await confirmOverwrite(); await uncertainNotice.waitFor();
  await pause(2300); assert.equal(writes, lostOverwriteWrites + 1);
  assert.equal((await settings()).minBookingMinutes, 19); assert.equal(await rules.inputValue(), "19");
  results.lostOverwriteResponseNotReplayed = true;
  await page.reload(); await rules.waitFor();
  await externalSave(16); await until(async () => await rules.inputValue() === "16", "Untouched form did not update automatically");
  assert.equal(await conflict.count(), 0); assert.equal(await staleNotice.count(), 0);
  results.untouchedFormUpdatesWithoutPrompt = true;

  const hung = holdNextRead(); await sync(); await until(() => hung.started, "Hung read did not start");
  await retryNotice.waitFor({ timeout: 20_000 });
  await retryNotice.waitFor({ state: "hidden", timeout: 10_000 });
  hung.release(); assert.equal(await rules.inputValue(), "16");
  results.hungRequestTimesOutAndRecovers = true;

  const maxReading = await page.evaluate(() => window.settingsReadConcurrency);
  const oldPage = holdNextRead(); await sync(); await until(() => oldPage.started, "Read before navigation did not start");
  await page.goto(fixture.origin + "/calendar"); oldPage.release();
  await page.goto(fixture.origin + "/admin/settings"); await rules.waitFor();
  assert.equal(await rules.inputValue(), "16");
  results.navigationCancelsOldReads = true;

  // SPA navigation must retain an ambiguous write guard, and discard late dialogs.
  const leavingWrite = deferred(); releases.push(leavingWrite.release); holdSave = leavingWrite;
  await rules.fill("23"); await save.click();
  await until(() => leavingWrite.started, "Write before SPA navigation did not start");
  const navigationWrites = writes;
  await page.locator(".admin-sidebar").getByRole("button", { name: "资源管理", exact: true }).click();
  await until(async () => await rules.count() === 0, "Settings did not unmount");
  leavingWrite.release();
  await page.locator(".admin-sidebar").getByRole("button", { name: "系统设置", exact: true }).click();
  await rules.waitFor(); await uncertainNotice.waitFor();
  assert(await save.isDisabled()); assert.equal(await conflict.count(), 0); assert.equal(writes, navigationWrites);
  assert.equal((await settings()).minBookingMinutes, 23);
  await page.reload(); await rules.waitFor();
  assert.equal(await uncertainNotice.count(), 0); assert.equal(await rules.inputValue(), "23");
  results.navigationDuringWriteRequiresManualVerification = true;
  assert(maxReading <= 1, `Concurrent settings reads: ${maxReading}`); assert.deepEqual(errors, []);
  results.maxConcurrentSettingsReads = maxReading;
  const englishContext = await contextFor("Administrator", "en"), englishPage = await englishContext.newPage();
  await englishPage.setViewportSize({ width: 390, height: 844 });
  await englishPage.goto(fixture.origin + "/admin/settings");
  const englishRules = englishPage.locator(".settings-fields input[type=number]").first();
  await englishRules.waitFor(); await englishRules.fill("21"); await externalSave(22);
  await englishPage.locator(".settings-card").first().locator(".primary-button").click();
  const englishDialog = englishPage.getByRole("dialog"); await englishDialog.waitFor();
  await englishDialog.getByRole("button", { name: "Confirm overwrite", exact: true }).waitFor();
  const bounds = await englishDialog.boundingBox();
  assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await englishDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await englishRules.inputValue(), "21"); assert.equal((await settings()).minBookingMinutes, 22);
  assert.equal(await englishPage.getByRole("button", { name: "Reload", exact: true }).count(), 0);
  results.englishNarrowConfirmationKeepsDraft = true;
  await englishContext.close();
  const peerContext = await contextFor("peer"), peerPage = await peerContext.newPage();
  let denyReadOnce = false;
  await peerPage.route("**/api/v1/auth/me", async route => {
    if (denyReadOnce) {
      denyReadOnce = false;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Injected auth outage"}' });
    } else await route.continue();
  });
  await peerPage.goto(fixture.origin + "/calendar");
  await peerPage.locator(".live-state.connected").waitFor();
  await peerPage.getByText("Realtime machine 1", { exact: true }).first().waitFor();
  denyReadOnce = true;
  assert.equal((await fixture.request("Administrator", `/admin/machines/${fixture.ids.machine1}/members/${fixture.ids.peer}`, "DELETE")).status, 200);
  await peerPage.locator(".boot-shell").waitFor(); await pause(500);
  assert.equal(await peerPage.locator(".calendar-main").count(), 0);
  await peerPage.locator(".calendar-main").waitFor();
  assert.equal(await peerPage.getByText("Realtime machine 1", { exact: true }).count(), 0);
  results.failedAuthorityRecheckKeepsRestrictedContentHidden = true;
  await peerContext.close();
  console.log(JSON.stringify(results));
} finally {
  for (const release of releases) release();
  await browser.close(); await fixture.close();
}
