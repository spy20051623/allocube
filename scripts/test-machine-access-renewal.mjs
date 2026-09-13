import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const Database = require("better-sqlite3");
const fixture = await startRealtimeFixture();
let browser;
const day = offset => new Date(Date.now() + offset * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
const boundary = date => new Date(Date.parse(`${date}T00:00:00+08:00`) + 86400_000).toISOString();
const errors = [];
async function open(actor, locale, width, path) {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, timezoneId: "America/New_York" });
  const cookie = fixture.accounts[actor].cookie, split = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, split), value: cookie.slice(split+1), url: fixture.origin }]);
  await context.addInitScript(locale => localStorage.setItem("allocube:locale:v1", locale), locale);
  const page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(fixture.origin + path);
  return { context, page };
}
try {
  const original = boundary(day(2));
  const members = await fixture.request("Administrator", `/admin/machines/${fixture.ids.machine1}/access`);
  const member = members.body.members.find(item => item.id === fixture.ids.owner);
  const edited = await fixture.request("Administrator", `/admin/machines/${fixture.ids.machine1}/members/${fixture.ids.owner}/expiry`, "PATCH", { expiresAt: original, expectedVersion: member.expectedVersion });
  assert.equal(edited.status, 200);
  const resourcesDb = new Database(fixture.databasePath);
  const seededAt = new Date().toISOString();
  for (const machineId of [fixture.ids.machine1, fixture.ids.machine2]) {
    resourcesDb.prepare("INSERT INTO resource_pools(id,machine_id,name,kind,unit,range_start,range_end,created_at,updated_at) VALUES(?,?,?,'INDEX_RANGE',?,0,127,?,?)")
      .run(randomUUID(), machineId, "CPU", "cores", seededAt, seededAt);
    resourcesDb.prepare("INSERT INTO resource_pools(id,machine_id,name,kind,unit,capacity_milli,created_at,updated_at) VALUES(?,?,?,'CAPACITY',?,512000,?,?)")
      .run(randomUUID(), machineId, "Memory", "GiB", seededAt, seededAt);
  }
  resourcesDb.close();
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  await mkdir(".codex-tmp/machine-access-renewal", { recursive: true });
  const user = await open("owner", "zh-CN", 1440, "/resources");
  const card = user.page.locator(".resource-catalog-card").filter({ hasText: "Realtime machine 1" });
  const permanent = user.page.locator(".resource-catalog-card").filter({ hasText: "Realtime machine 2" });
  await card.getByRole("button", { name: "延期", exact: true }).waitFor();
  assert.equal(await permanent.getByRole("button", { name: "延期", exact: true }).count(), 0);
  const statusOffset = locator => locator.evaluate(card => card.getBoundingClientRect().right - card.querySelector(".catalog-card-statuses > .state-chip").getBoundingClientRect().right);
  assert(Math.abs(await statusOffset(card) - await statusOffset(permanent)) < 1, "Action width must not move the availability badge");
  await user.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-initial-zh.png", fullPage: true });
  const english = await open("owner", "en", 1100, "/resources");
  await english.page.getByRole("button", { name: "Extend", exact: true }).waitFor();
  await english.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-en-desktop.png", fullPage: true });
  await english.context.close();
  const submit = async () => {
    await card.getByRole("button", { name: "延期", exact: true }).click();
    const field = user.page.getByRole("button", { name: "延期至", exact: true });
    assert.equal(await field.innerText(), day(32));
    for (const days of [7, 15, 30]) {
      await field.click();
      await user.page.locator(".calendar-date-footer").getByRole("button", { name: `${days}天`, exact: true }).click();
      assert.equal(await field.innerText(), day(2 + days));
    }
    await user.page.screenshot({ path: ".codex-tmp/machine-access-renewal/modal-zh.png", fullPage: true });
    await user.page.getByRole("button", { name: "提交申请", exact: true }).click();
    await user.page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: "hidden" });
    await card.getByText("使用者 · 延期审核中", { exact: true }).waitFor();
    const catalog = await fixture.request("owner", "/machines/catalog");
    const machine = catalog.body.machines.find(item => item.id === fixture.ids.machine1);
    assert.equal(machine.expiresAt, original);
    assert.equal(machine.request.previousExpiresAt, original);
    assert.equal(machine.request.expiresAt, boundary(day(32)));
  };
  await submit();
  await card.getByRole("button", { name: "撤回", exact: true }).click();
  await user.page.getByRole("dialog").getByRole("button", { name: "撤回", exact: true }).click();
  await card.getByRole("button", { name: "延期", exact: true }).waitFor();
  await submit();
  await user.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-zh.png", fullPage: true });
  const admin = await open("Administrator", "zh-CN", 1440, `/admin/machines/${fixture.ids.machine1}/users`);
  const pending = admin.page.locator(".machine-request-row").filter({ hasText: "owner" });
  await pending.getByText("延期申请", { exact: true }).waitFor();
  assert((await pending.locator(".renewal-expiry-comparison").innerText()).includes(day(2)));
  assert((await pending.locator(".renewal-expiry-comparison").innerText()).includes(day(32)));
  await admin.page.screenshot({ path: ".codex-tmp/machine-access-renewal/approval-zh.png", fullPage: true });
  const narrow = await open("owner", "en", 390, "/resources");
  await narrow.page.getByText("Member · Extension pending", { exact: true }).waitFor();
  assert(await narrow.page.locator(".resource-catalog-card").evaluateAll(cards => cards.every(card => {
    const bounds = card.getBoundingClientRect();
    return bounds.right <= window.innerWidth && [...card.querySelectorAll(".catalog-card-controls > *")].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
    });
  })), "Mobile card controls must stay within their cards and viewport");
  await narrow.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-en-mobile.png", fullPage: true });
  await pending.getByRole("button", { name: "通过申请", exact: true }).click();
  await pending.waitFor({ state: "hidden" });
  await card.getByRole("button", { name: "延期", exact: true }).waitFor();
  assert((await card.locator(".catalog-access-expiry").innerText()).includes(day(32)));
  // Simulate a deadline already crossed in this isolated fixture.
  const db = new Database(fixture.databasePath);
  db.prepare("UPDATE machine_access_memberships SET expires_at=? WHERE machine_id=? AND user_id=?").run(boundary(day(-1)), fixture.ids.machine1, fixture.ids.owner);
  db.close();
  await user.page.reload();
  await card.getByRole("button", { name: "申请", exact: true }).waitFor();
  assert.equal(await card.getByRole("button", { name: "延期", exact: true }).count(), 0);
  assert.equal(await card.getByText("重新申请", { exact: true }).count(), 0);
  // Rich catalog fixtures exercise layout independently of the renewal lifecycle above.
  const layoutDb = new Database(fixture.databasePath);
  const now = new Date().toISOString();
  layoutDb.prepare("UPDATE machines SET name=?,address=?,tags_json=? WHERE id=?").run("Realtime machine 1 · ARM64 编译与持续集成共享服务器 / performance-validation", "2001:db8:1234:5678:90ab:cdef:1234:5678", JSON.stringify(["ARM64", "编译测试", "Shared infrastructure", "长标签 long-resource-tag"]), fixture.ids.machine1);
  layoutDb.prepare("UPDATE users SET display_name=? WHERE id=?").run("平台基础设施管理员 Infrastructure administrator", fixture.ids.peer);
  layoutDb.prepare("INSERT INTO machine_admins(machine_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)").run(fixture.ids.machine1, fixture.ids.peer, fixture.ids.peer, now);
  layoutDb.prepare("UPDATE machines SET status='DISABLED' WHERE id=?").run(fixture.ids.machine2);
  const pendingMachine = randomUUID();
  layoutDb.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(pendingMachine,"GPU training · 待审批",now,now);
  layoutDb.prepare("INSERT INTO machine_access_requests(id,machine_id,user_id,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),pendingMachine,fixture.ids.owner,boundary(day(15)),now,now);
  layoutDb.close();
  await user.page.reload();
  await user.page.getByText("GPU training · 待审批",{exact:true}).waitFor();
  await user.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-rich-zh.png", fullPage: true });
  await narrow.page.reload();
  await narrow.page.getByText("GPU training · 待审批",{exact:true}).waitFor();
  assert(await narrow.page.locator(".resource-catalog-card").evaluateAll(cards => cards.every(card => {
    const bounds = card.getBoundingClientRect();
    return [...card.querySelectorAll("h2, .state-chip, .catalog-card-action, time, .tag-row span")].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
    });
  })), "Long titles, labels and actions must stay inside cards");
  await narrow.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-rich-mobile.png", fullPage: true });
  const managerTrigger = narrow.page.locator(".catalog-manager-count").filter({ visible: true }).first();
  await managerTrigger.focus();
  await narrow.page.getByRole("tooltip").waitFor();
  await narrow.page.keyboard.press("Escape");
  await narrow.page.getByRole("tooltip").waitFor({ state: "hidden" });
  await narrow.page.setViewportSize({ width: 320, height: 1000 });
  await narrow.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-rich-320.png", fullPage: true });
  assert(await narrow.page.locator(".resource-catalog-card").evaluateAll(cards => cards.every(card => {
    const bounds = card.getBoundingClientRect();
    return bounds.right <= window.innerWidth && [...card.querySelectorAll("h2, .state-chip, .catalog-card-action, time, .tag-row span")].every(child => {
      const rect = child.getBoundingClientRect();
      return rect.left >= bounds.left && rect.right <= bounds.right && rect.bottom <= bounds.bottom;
    });
  })), "Small phones must not clip card content");
  await narrow.page.emulateMedia({ colorScheme: "dark" });
  await narrow.page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
  await narrow.page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))));
  await narrow.page.screenshot({ path: ".codex-tmp/machine-access-renewal/catalog-rich-dark.png", fullPage: true });
  assert.deepEqual(errors, []);
  await user.context.close(); await admin.context.close(); await narrow.context.close();
  console.log("Renewal browser flow passed: presets, withdrawal, pending dates, approval, expired Apply and English mobile");
} finally { await browser?.close(); await fixture.close(); }
