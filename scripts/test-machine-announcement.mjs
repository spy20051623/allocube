import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const path = `/admin/machines/${fixture.ids.machine1}`;
const day = new Date(Date.now() + 32 * 3_600_000).toISOString().slice(0, 10);
let release;
const save = async announcement => {
  const current = await fixture.request("Administrator", path);
  const response = await fixture.request("Administrator", path + "/announcement", "PUT", { announcement, expectedVersion: current.body.machine.version });
  assert.equal(response.status, 200, JSON.stringify(response.body));
};
async function open(actor, theme, locale, width, url) {
  const context = await browser.newContext({ viewport: { width, height: 950 }, timezoneId: "Asia/Shanghai" });
  context.setDefaultTimeout(10_000);
  const cookie = fixture.accounts[actor].cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split + 1), url: fixture.origin }]);
  await context.addInitScript(({ theme, locale }) => {
    localStorage.setItem("allocube:theme:v1", theme); localStorage.setItem("allocube:locale:v1", locale);
    localStorage.setItem("allocube.calendar-zoom-guide.v1", "dismissed");
  }, { theme, locale });
  const page = await context.newPage();
  await page.goto(fixture.origin + url);
  return { page, context };
}
try {
  await mkdir(".codex-tmp/machine-announcement", { recursive: true });
  for (const [theme, locale, width] of [["light", "zh-CN", 1440], ["dark", "en", 390]]) {
    const firstLine = "请在使用前确认环境。Please check the environment. ".repeat(25);
    const content = firstLine + "\n<b>plain text</b> **Markdown**\n\nFinal paragraph.";
    await save(content);
    const { page, context } = await open("peer", theme, locale, width, `/calendar?date=${day}&view=day`);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const row = page.locator(".machine-announcement-link"), viewer = page.getByRole("dialog");
    await row.waitFor();
    assert.equal(await row.count(), 1);
    assert.equal(await row.locator("span").textContent(), firstLine + "…");
    assert.deepEqual(await row.locator("span").evaluate(node => ({ ellipsis: getComputedStyle(node).textOverflow, nowrap: getComputedStyle(node).whiteSpace, clipped: node.scrollWidth > node.clientWidth })),
      { ellipsis: "ellipsis", nowrap: "nowrap", clipped: true });
    const strip = page.locator(".machine-strip").first();
    await strip.click(); assert.equal(await strip.getAttribute("aria-expanded"), "false");
    assert.equal(await page.getByRole("button", { name: /查看 .* 的机器公告|Read the announcement for/ }).count(), 0);
    await strip.click();
    await page.getByRole("button", { name: locale === "en" ? "Week" : "一周", exact: true }).click();
    await row.click(); assert.equal(await viewer.locator(".machine-announcement-body").innerText(), content);
    assert.equal(await viewer.locator(".machine-announcement-body b, .machine-announcement-body strong").count(), 0);
    await page.keyboard.press("Escape");
    assert.equal(await row.evaluate(node => node === document.activeElement), true);
    await page.getByRole("button", { name: locale === "en" ? "Day" : "一天", exact: true }).click();
    await page.locator(".timeline-zoom-control button").last().click();
    await page.locator(".timeline-scroll-shell").evaluate(node => { node.scrollLeft = 350; });
    const rowBox = await row.boundingBox(), shellBox = await page.locator(".timeline-scroll-shell").boundingBox();
    assert(Math.abs(rowBox.x - shellBox.x) <= 2 && rowBox.width <= shellBox.width + 1, "Announcement must stay within the visible timeline width");
    // Wait for the scroll position and sticky elements to settle in the same frame.
    await page.waitForFunction(() => {
      const announcementIcon = document.querySelector(".machine-announcement-link > svg");
      const machineIcon = document.querySelector(".machine-strip-leading > svg:last-child");
      return announcementIcon && machineIcon && Math.abs(announcementIcon.getBoundingClientRect().x - machineIcon.getBoundingClientRect().x) <= 1;
    });
    assert.equal(await row.evaluate(node => getComputedStyle(node).paddingRight), await strip.locator(".machine-strip-visible").evaluate(node => getComputedStyle(node).paddingRight));
    await page.screenshot({ path: `.codex-tmp/machine-announcement/${theme}-${locale}-row.png` });
    await page.locator(".drawer-add-button").click();
    await viewer.locator('[name="manualStartAt"]').fill(`${day}T09:00`);
    await viewer.locator('[name="manualEndAt"]').fill(`${day}T10:00`);
    await viewer.locator('button[type="submit"]').click();
    const title = page.locator('.booking-drawer input[name="title"]'); await title.fill("Keep my draft");
    await row.click();
    await page.screenshot({ path: `.codex-tmp/machine-announcement/${theme}-${locale}-viewer.png` });
    await save("Updated while reading");
    await viewer.getByText("Updated while reading", { exact: true }).waitFor();
    await save(""); await viewer.waitFor({ state: "detached" });
    assert.equal(await row.count(), 0); assert.equal(await title.inputValue(), "Keep my draft");
    assert.deepEqual(errors, []);
    await context.close();
    console.log(JSON.stringify({ theme, locale, width, singleLine: true, plainText: true, liveViewer: true, emptyHidden: true, draftRetained: true }));
  }

  await save("使用前请确认环境配置。\n完成任务后及时释放资源。\n\nPlease check the environment before use.");
  const { page, context } = await open("Administrator", "light", "zh-CN", 1440, path + "/info");
  const section = page.locator(".machine-announcement-section"), editor = page.getByRole("dialog");
  await section.screenshot({ path: ".codex-tmp/machine-announcement/light-zh-CN-settings.png" });
  await section.getByRole("button", { name: "编辑", exact: true }).click();
  const input = page.locator('[name="machineAnnouncement"]');
  assert.equal(await input.evaluate(node => node.tagName), "TEXTAREA");
  assert((await input.inputValue()).includes("\n\n"));
  await editor.screenshot({ path: ".codex-tmp/machine-announcement/light-zh-CN-editor.png" });
  await input.fill("Local draft"); await save("Remote update");
  await section.locator(".machine-announcement-preview .machine-announcement-body").getByText("Remote update", { exact: true }).waitFor();
  assert.equal(await input.inputValue(), "Local draft");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "确认覆盖", exact: true }).waitFor();
  await page.getByRole("dialog").last().getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await input.inputValue(), "Local draft");
  assert.equal((await fixture.request("Administrator", path)).body.machine.announcement, "Remote update");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "确认覆盖", exact: true }).click();
  await input.waitFor({ state: "detached" });
  assert.equal((await fixture.request("Administrator", path)).body.machine.announcement, "Local draft");
  await section.locator(".machine-announcement-preview .machine-announcement-body").getByText("Local draft", { exact: true }).waitFor();
  await section.getByRole("button", { name: "编辑", exact: true }).click(); await input.fill("");
  let writes = 0;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/v1/admin/machines/*/announcement", async route => {
    writes++; const response = await route.fetch(); await gate; await route.fulfill({ response });
  });
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await editor.locator("form").dispatchEvent("submit");
  assert(await input.isDisabled());
  await page.keyboard.press("Escape"); assert.equal(await input.count(), 1);
  release(); release = undefined;
  await input.waitFor({ state: "detached" }); assert.equal(writes, 1);
  assert.equal((await fixture.request("Administrator", path)).body.machine.announcement, "");
  await page.unroute("**/api/v1/admin/machines/*/announcement");

  await section.locator(".machine-announcement-preview .machine-announcement-body").getByText("暂无机器公告", { exact: true }).waitFor();
  await section.screenshot({ path: ".codex-tmp/machine-announcement/light-zh-CN-settings-empty.png" });
  await section.getByRole("button", { name: "编辑", exact: true }).click();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const paste = async text => {
    await page.evaluate(text => navigator.clipboard.writeText(text), text);
    await input.focus(); await input.press("ControlOrMeta+A"); await input.press("ControlOrMeta+V");
  };
  await paste("  Plain\r\ntext <b>literal</b>  ");
  assert.equal(await input.inputValue(), "  Plain\ntext <b>literal</b>  ");
  await paste("x".repeat(2001));
  assert.equal((await input.inputValue()).length, 2000);
  const savedText = "Saved despite a lost response\n\nSecond paragraph";
  await input.fill(savedText);
  let lostWrites = 0;
  await page.route("**/api/v1/admin/machines/*/announcement", async route => {
    lostWrites++; await route.fetch(); await route.abort("connectionreset");
  });
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "结果尚未确认" }).waitFor();
  assert.equal(await input.inputValue(), savedText);
  assert.equal((await fixture.request("Administrator", path)).body.machine.announcement, savedText);
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await editor.getByRole("button", { name: "取消", exact: true }).click();
  await section.getByRole("button", { name: "编辑", exact: true }).click();
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  assert.equal(lostWrites, 1, "An uncertain write must not be replayed after reopening");
  await page.unroute("**/api/v1/admin/machines/*/announcement");
  await context.close();

  // Manager revocation closes an open editor while retaining read-only membership.
  assert.equal((await fixture.request("Administrator", path + "/managers", "POST", { userId: fixture.ids.owner })).status, 200);
  const manager = await open("owner", "dark", "en", 390, path + "/info");
  const managerSection = manager.page.locator(".machine-announcement-section");
  await managerSection.screenshot({ path: ".codex-tmp/machine-announcement/dark-en-settings.png" });
  await managerSection.getByRole("button", { name: "Edit", exact: true }).click();
  await manager.page.locator('[name="machineAnnouncement"]').fill("Unsaved manager draft");
  assert.equal((await fixture.request("Administrator", path + `/managers/${fixture.ids.owner}`, "DELETE")).status, 200);
  await manager.page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await managerSection.getByRole("button", { name: "Edit", exact: true }).count(), 0);
  await manager.context.close();

  // Removing membership must close a reader's already-open announcement.
  await save("Visible until access is removed");
  const member = await open("peer", "dark", "zh-CN", 1440, "/calendar");
  await member.page.locator(".machine-announcement-link").click();
  const removed = await fixture.request("Administrator", path + `/members/${fixture.ids.peer}`, "DELETE");
  assert.equal(removed.status, 200);
  await member.page.getByRole("dialog").waitFor({ state: "detached" });
  await member.context.close();
  console.log(JSON.stringify({ independentEditor: true, dirtyDraftRetained: true, conflictCancelAndOverwrite: true, duplicateSubmitBlocked: true, pasteValidation: true, lostResponseNotReplayed: true, permissionRevocation: true }));
} finally { release?.(); await browser.close(); await fixture.close(); }
