import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const fixture = await startRealtimeFixture();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) { for(let i=0;i<160;i++) { if(await check()) return; await pause(50); } throw new Error(message); }
const results = {}, errors = [];
async function contextFor(name, locale = "zh-CN", width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 } });
  const cookie = fixture.accounts[name].cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  await context.addInitScript(locale => localStorage.setItem("allocube:locale:v1", locale), locale);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  return { context, page };
}
async function feedback(name, id, data) {
  const body = new FormData(); body.set("metadata", JSON.stringify(data));
  const response = await fetch(fixture.origin + "/api/v1/feedback" + (id ? "/" + id : ""), {
    method: id ? "PUT" : "POST", body,
    headers: { origin: fixture.origin, cookie: fixture.accounts[name].cookie, "x-csrf-token": fixture.accounts[name].csrf }
  });
  const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result.ticket;
}
try {
  const { context, page } = await contextFor("Administrator");
  const id = fixture.ids.machine1, machineUrl = `/admin/machines/${id}`;
  const readMachine = async () => (await fixture.request("Administrator", machineUrl)).body.machine;
  async function changeMachine(name) {
    const saved = await readMachine(); const result = await fixture.request("Administrator", machineUrl, "PATCH", { ...saved, name, expectedVersion: saved.version });
    assert.equal(result.status, 200); return result;
  }
  for (const [account, csrf, status] of [["peer", true, 403], ["Administrator", false, 403]]) {
    const response = await fetch(fixture.origin + "/api/v1" + machineUrl, {
      method: "PATCH", headers: { origin: fixture.origin, cookie: fixture.accounts[account].cookie,
        "content-type": "application/json", "x-allocube-overwrite": "true",
        ...(csrf ? { "x-csrf-token": fixture.accounts[account].csrf } : {}) },
      body: JSON.stringify({ name: "not authorized", expectedVersion: 1 })
    });
    assert.equal(response.status, status);
  }
  results.overwriteRetainsPermissionAndCsrfChecks = true;
  await page.goto(fixture.origin + machineUrl + "/info");
  await page.locator(".machine-info-panel").getByRole("button", { name: "编辑", exact: true }).click();
  const name = page.locator(".machine-form-primary input").first();
  await changeMachine("remote clean"); await until(async () => await name.inputValue() === "remote clean", "pristine machine form did not synchronize");
  await name.fill("local draft"); await changeMachine("remote dirty");
  await page.locator(".machine-info-identity strong").filter({ hasText: "remote dirty" }).waitFor();
  assert.equal(await name.inputValue(), "local draft");
  const saveMachine = () => page.locator(".machine-form-actions .primary-button").click();
  await saveMachine(); const confirm = page.getByRole("dialog", { name: "数据已更新", exact: true }); await confirm.waitFor();
  await page.keyboard.press("Escape"); await until(async () => await confirm.count() === 0, "Escape did not cancel confirmation");
  assert.equal(await name.inputValue(), "local draft"); assert.equal((await readMachine()).name, "remote dirty");
  assert.equal(await page.locator(".machine-form .context-notice").count(), 0);
  await saveMachine(); await confirm.waitFor(); await changeMachine("remote during confirmation");
  await confirm.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await until(async () => await name.count() === 0, "machine editor did not close");
  assert.equal((await readMachine()).name, "local draft");
  results.machinePristineSyncDirtyPreservedCancelAndOverwrite = true;
  await until(async () => await page.locator(".machine-info-identity strong").innerText() === "local draft", "saved machine view did not synchronize");

  // The write reaches the server but its response is lost. Reopening the same editor must not replay it.
  let writes = 0, lose = true;
  await page.route(`**/api/v1${machineUrl}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++; const response = await route.fetch();
    if (lose) { lose = false; await route.abort("connectionreset"); } else await route.fulfill({ response });
  });
  await page.locator(".machine-info-panel").getByRole("button", { name: "编辑", exact: true }).click();
  await name.fill("lost response saved"); await saveMachine();
  await page.locator(".toast").filter({ hasText: "结果尚未确认" }).waitFor();
  assert.equal(await name.inputValue(), "lost response saved"); assert.equal((await readMachine()).name, "lost response saved");
  await saveMachine(); await pause(300); assert.equal(writes, 1);
  await page.locator(".machine-form-actions").getByRole("button", { name: "取消", exact: true }).click();
  await page.locator(".machine-info-panel").getByRole("button", { name: "编辑", exact: true }).click();
  await name.fill("must not replay"); await saveMachine(); await pause(300); assert.equal(writes, 1);
  results.lostResponseIsNotReplayedEvenAfterReopening = true;
  await page.unroute(`**/api/v1${machineUrl}`);
  await page.reload();

  const resourceId = (await fixture.request("Administrator", "/admin/machines", "POST", { name: "Editable resource fixture" })).body.id;
  const poolId = randomUUID(), groupId = randomUUID();
  const config = { pools: [{ id: poolId, expectedVersion: 0, kind: "CAPACITY", name: "initial pool", unit: "GB", capacity: 10 }], groups: [{ id: groupId, expectedVersion: 0, name: "group", allocations: [{ kind: "CAPACITY", poolId, quantity: 2 }] }] };
  assert.equal((await fixture.request("Administrator", `/admin/machines/${resourceId}/resource-configuration`, "PUT", config)).status, 200);
  await page.goto(fixture.origin + `/admin/machines/${resourceId}/resources`);
  await page.getByRole("button", { name: "编辑资源", exact: true }).click();
  const poolName = page.locator(".resource-config-form .two-fields input").first(); await poolName.waitFor();
  async function changePool(value) {
    const pool = (await fixture.request("Administrator", `/admin/machines/${resourceId}/resource-pools`)).body.pools[0];
    assert.equal((await fixture.request("Administrator", `/admin/resource-pools/${poolId}`, "PATCH", { ...pool, name: value, expectedVersion: pool.version })).status, 200);
  }
  await changePool("remote pool clean"); await until(async () => await poolName.inputValue() === "remote pool clean", "pool baseline did not synchronize");
  await poolName.fill("local pool draft"); await changePool("remote pool dirty"); await pause(500);
  assert.equal(await poolName.inputValue(), "local pool draft");
  await page.getByRole("button", { name: "保存配置", exact: true }).click(); await confirm.waitFor();
  await confirm.getByRole("button", { name: "取消", exact: true }).click(); assert.equal(await poolName.inputValue(), "local pool draft");
  await page.getByRole("button", { name: "保存配置", exact: true }).click(); await confirm.waitFor();
  await confirm.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await until(async () => await poolName.count() === 0, "resource editor did not close");
  assert.equal((await fixture.request("Administrator", `/admin/machines/${resourceId}/resource-pools`)).body.pools[0].name, "local pool draft");
  results.resourcePristineSyncAndDraftConflict = true;

  // Cancelling the extra conflict confirmation restores the original reason input.
  await page.locator('.group-admin-actions button[title="停用"]').first().click();
  const reasonDialog = page.getByRole("dialog", { name: "停用资源组", exact: true });
  await reasonDialog.locator("textarea").fill("retained reason");
  await reasonDialog.getByRole("button", { name: "确认", exact: true }).click();
  const impactDialog = page.getByRole("dialog", { name: "确认停用", exact: true });
  await impactDialog.waitFor();
  await changeMachine("invalidate disable preview");
  await impactDialog.getByRole("button", { name: "停用", exact: true }).click();
  await confirm.waitFor(); await confirm.getByRole("button", { name: "取消", exact: true }).click();
  await reasonDialog.waitFor(); assert.equal(await reasonDialog.locator("textarea").inputValue(), "retained reason");
  assert.equal((await fixture.request("Administrator", `/admin/machines/${resourceId}/groups`)).body.groups[0].status, "ACTIVE");
  await reasonDialog.locator("textarea").fill("revised reason");
  await reasonDialog.getByRole("button", { name: "确认", exact: true }).click();
  await confirm.waitFor(); await confirm.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await until(async () => (await fixture.request("Administrator", `/admin/machines/${resourceId}/groups`)).body.groups[0].status === "DISABLED", "resubmitted disable did not finish");
  results.cancelledConflictReturnsToReasonDraft = true;

  const owner = await contextFor("owner");
  let ticket = await feedback("owner", null, { type: "ISSUE", level: "NORMAL", title: "initial feedback", bodyMarkdown: "feedback body" });
  await owner.page.goto(fixture.origin + `/feedback/${ticket.id}`);
  await owner.page.getByRole("button", { name: "编辑", exact: true }).click();
  const feedbackTitle = owner.page.locator(".feedback-editor-fields input[maxlength='120']");
  ticket = await feedback("owner", ticket.id, { expectedVersion: ticket.version, level: "NORMAL", title: "remote feedback clean", bodyMarkdown: "remote body", retainedAttachmentIds: [] });
  await until(async () => await feedbackTitle.inputValue() === "remote feedback clean", "pristine feedback did not synchronize");
  await feedbackTitle.fill("local feedback draft");
  ticket = await feedback("owner", ticket.id, { expectedVersion: ticket.version, level: "NORMAL", title: "remote feedback dirty", bodyMarkdown: "remote dirty body", retainedAttachmentIds: [] });
  await pause(500); assert.equal(await feedbackTitle.inputValue(), "local feedback draft");
  await owner.page.locator(".feedback-editor-modal .modal-actions .primary-button").click();
  const feedbackConfirm = owner.page.getByRole("dialog", { name: "数据已更新", exact: true }); await feedbackConfirm.waitFor();
  await feedbackConfirm.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await feedbackTitle.inputValue(), "local feedback draft");
  await owner.page.locator(".feedback-editor-modal .modal-actions .primary-button").click(); await feedbackConfirm.waitFor();
  await feedbackConfirm.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await until(async () => await feedbackTitle.count() === 0, "feedback editor did not close");
  assert.equal((await fixture.request("owner", `/feedback/${ticket.id}`)).body.ticket.title, "local feedback draft");
  results.feedbackMultipartPristineSyncAndDraftConflict = true;

  let releaseComment, commentStarted = false;
  const heldComment = new Promise(resolve => { releaseComment = resolve; });
  await owner.page.route(`**/api/v1/feedback/${ticket.id}/comments`, async route => {
    commentStarted = true; await heldComment; await route.continue();
  });
  const commentInput = owner.page.locator(".feedback-comment-form textarea");
  await commentInput.fill("in flight comment");
  await owner.page.getByRole("button", { name: "发送评论", exact: true }).click();
  await until(() => commentStarted, "comment request did not start");
  assert(await commentInput.isDisabled());
  assert(await owner.page.locator('.feedback-comment-form input[type="file"]').isDisabled());
  assert.equal(await commentInput.inputValue(), "in flight comment");
  releaseComment();
  await until(async () => !(await commentInput.isDisabled()) && await commentInput.inputValue() === "", "comment did not complete");
  results.pendingFeedbackWriteLocksTextAndImages = true;
  await owner.context.close();

  const english = await contextFor("Administrator", "en", 390);
  let announcement = (await fixture.request("Administrator", "/admin/announcements", "POST", { title: "initial announcement", bodyMarkdown: "initial body" })).body.announcement;
  await english.page.goto(fixture.origin + "/admin/announcements");
  const acknowledge = async () => { await pause(300); const button = english.page.locator(".announcement-dialog-footer button"); if (await button.count()) await button.click(); };
  await acknowledge();
  await english.page.locator(".announcement-card-actions").getByRole("button", { name: "Edit", exact: true }).click();
  const announcementTitle = english.page.locator(".announcement-create-fields input");
  async function changeAnnouncement(title) {
    const response = await fixture.request("Administrator", `/admin/announcements/${announcement.id}`, "PUT", { expectedVersion: announcement.version, title, bodyMarkdown: "remote body" });
    assert.equal(response.status, 200); announcement = response.body.announcement; await acknowledge();
  }
  await changeAnnouncement("remote announcement clean"); await until(async () => await announcementTitle.inputValue() === "remote announcement clean", "pristine announcement did not synchronize");
  await announcementTitle.fill("local announcement draft"); await changeAnnouncement("remote announcement dirty");
  await english.page.locator(".announcement-editor-modal .modal-actions .primary-button").click();
  const englishConfirm = english.page.getByRole("dialog", { name: "Data updated", exact: true }); await englishConfirm.waitFor();
  const bounds = await englishConfirm.boundingBox(); assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await englishConfirm.getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal(await announcementTitle.inputValue(), "local announcement draft");
  await english.page.locator(".announcement-editor-modal .modal-actions .primary-button").click(); await englishConfirm.waitFor();
  await englishConfirm.getByRole("button", { name: "Confirm overwrite", exact: true }).click();
  await until(async () => await announcementTitle.count() === 0, "announcement editor did not close");
  assert.equal((await fixture.request("Administrator", "/admin/announcements")).body.announcements[0].title, "local announcement draft");
  results.announcementEnglishNarrowPristineSyncAndDraftConflict = true;
  assert.deepEqual(errors, []); console.log(JSON.stringify(results));
  await english.context.close(); await context.close();
} finally { await browser.close(); await fixture.close(); }
