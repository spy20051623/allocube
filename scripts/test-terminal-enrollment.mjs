import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  // Emulate the HTTPS reverse proxy headers on the isolated local test server.
  const db = new Database(fixture.databasePath);
  db.prepare("UPDATE settings SET value='https://terminal-fixture.test' WHERE key='public_site_origin'").run();
  db.close();
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const proxyHeaders = { host: "terminal-fixture.test", "x-forwarded-proto": "https", origin: "https://terminal-fixture.test" };
  await context.route("**/api/v1/admin/machines/*/terminal", async route => {
    const response = await route.fetch({ headers: { ...route.request().headers(), ...proxyHeaders } });
    await route.fulfill({ response });
  });
  const cookie = fixture.accounts.Administrator.cookie, separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: fixture.origin }]);
  await context.addInitScript(() => localStorage.setItem("allocube:locale:v1", "zh-CN"));
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${fixture.origin}/admin/machines/${fixture.ids.machine1}/info`);
  const panel = page.locator(".terminal-sync-panel");
  await panel.getByRole("button", { name: "管理接入" }).click();
  const modal = page.locator(".terminal-sync-modal");
  const created = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith(`/admin/machines/${fixture.ids.machine1}/terminal`));
  await modal.getByRole("button", { name: "生成接入凭据" }).click();
  const enrollmentResponse = await created;
  const enrollment = await enrollmentResponse.json();
  assert.equal(enrollmentResponse.status(), 200, enrollment.error);
  await modal.locator("pre").waitFor({ timeout: 5000 });
  const keys = generateKeyPairSync("ed25519");
  const enroll = async (value) => {
    const response = await context.request.post(fixture.origin + "/api/v1/terminal/machine/enroll", {
      headers: { ...proxyHeaders, "content-type": "application/json" }, data: {
        terminalId: value.terminalId, enrollmentToken: value.enrollmentToken,
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
        proof: sign(null, Buffer.from(`allocube-enroll:${value.terminalId}:${value.enrollmentToken}`), keys.privateKey).toString("base64url"),
      },
    });
    assert.equal(response.status(), 200, await response.text());
  };
  const manage = async (method, body) => {
    const response = await context.request.fetch(`${fixture.origin}/api/v1/admin/machines/${fixture.ids.machine1}/terminal`, {
      method, headers: { ...proxyHeaders, cookie, "x-csrf-token": fixture.accounts.Administrator.csrf, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { data: body } : {}),
    });
    return { status: response.status(), body: await response.json() };
  };
  const started = Date.now();
  await enroll(enrollment);
  await modal.getByRole("status").filter({ hasText: "机器已接入" }).waitFor({ timeout: 5000 });
  assert.equal(await panel.locator(".terminal-sync-overview .terminal-sync-status").innerText(), "已接入");
  assert.notEqual(await panel.locator("time").innerText(), "—");
  assert.equal(await modal.locator("pre").count(), 0, "Consumed enrollment command must disappear");
  const latency = Date.now() - started;
  // Remote disable/regeneration and a closed modal must still refresh the machine badge.
  const disabled = await manage("DELETE");
  assert.equal(disabled.status, 200);
  await modal.locator(".terminal-sync-status.disabled").waitFor();
  assert.equal(await modal.locator(".terminal-sync-connected").count(), 0);
  await modal.locator(".modal-actions").getByRole("button", { name: "关闭", exact: true }).click();
  const next = await manage("POST", {});
  assert.equal(next.status, 200);
  await panel.locator(".terminal-sync-status.pending").waitFor();
  await enroll(next.body);
  await panel.locator(".terminal-sync-status.active").waitFor({ timeout: 5000 });
  await panel.getByRole("button", { name: "管理接入" }).click();
  await modal.locator(".terminal-sync-connected").waitFor();
  assert.equal(await modal.locator("pre").count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ enrollmentFeedbackMs: latency, modalAndBadgeUpdated: true, consumedCommandRemoved: true, remoteDisableAndRegeneration: true, closedModalUpdates: true }));
} finally {
  await browser.close();
  await fixture.close();
}
