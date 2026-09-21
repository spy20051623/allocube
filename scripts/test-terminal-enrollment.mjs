import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
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
  await context.addInitScript(() => { if (!localStorage.getItem("allocube:locale:v1")) localStorage.setItem("allocube:locale:v1", "zh-CN"); });
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
  const machineCall = async (value, action, data) => {
    const now = Math.floor(Date.now()/1000);
    const unsigned = Buffer.from(JSON.stringify({alg:"EdDSA"})).toString("base64url") + "." + Buffer.from(JSON.stringify({
      iss:value.terminalId,sub:value.terminalId,aud:"https://terminal-fixture.test/api/v1/terminal/machine/token",
      iat:now,exp:now+60,jti:crypto.randomUUID(),
    })).toString("base64url");
    const minted=await context.request.post(fixture.origin+"/api/v1/terminal/machine/token",{headers:proxyHeaders,data:{
      client_id:value.terminalId,grant_type:"client_credentials",client_assertion_type:"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion:unsigned+"."+sign(null,Buffer.from(unsigned),keys.privateKey).toString("base64url"),
    }});
    assert.equal(minted.status(),200,await minted.text());
    const response=await context.request.post(fixture.origin+"/api/v1/terminal/machine/"+action,{headers:{...proxyHeaders,authorization:`Bearer ${(await minted.json()).access_token}`},data});
    assert.equal(response.status(),200,await response.text());
  };
  await enroll(enrollment);
  await modal.getByRole("status").filter({hasText:"身份已登记"}).waitFor({timeout:5000});
  assert.equal(await panel.locator(".terminal-sync-overview .terminal-sync-status").innerText(),"待确认接入");
  await machineCall(enrollment,"keys",{employees:["12345678"]});
  assert.equal(await modal.locator(".terminal-sync-connected").count(),0,"Key preview is not completed enrollment");
  await page.screenshot({path:".codex-tmp/terminal-confirmation-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:".codex-tmp/terminal-confirmation-mobile.png"});
  assert.equal(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth),true,"Pending content must fit narrow dialog");
  await page.setViewportSize({width:1280,height:960});
  await machineCall(enrollment,"confirm-installation",{protocolVersion:1});
  await modal.getByRole("status").filter({ hasText: "机器已接入" }).waitFor({ timeout: 5000 });
  assert.equal(await panel.locator(".terminal-sync-overview .terminal-sync-status").innerText(), "已接入");
  assert.notEqual(await panel.locator("time").innerText(), "—");
  assert.equal(await modal.locator("pre").count(), 0, "Completed enrollment command must disappear");
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
  await panel.locator(".terminal-sync-status.pending").waitFor();
  await machineCall(next.body,"confirm-installation",{protocolVersion:1});
  await panel.locator(".terminal-sync-status.active").waitFor({ timeout: 5000 });
  await panel.getByRole("button", { name: "管理接入" }).click();
  await modal.locator(".terminal-sync-connected").waitFor();
  assert.equal(await modal.locator("pre").count(), 0);
  const english = await manage("POST", {});
  assert.equal(english.status,200);
  await enroll(english.body);
  await page.evaluate(() => localStorage.setItem("allocube:locale:v1","en"));
  await page.reload();
  await panel.getByRole("button",{name:"Manage connection"}).click();
  await modal.getByRole("status").filter({hasText:"Identity registered"}).waitFor();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:".codex-tmp/terminal-confirmation-mobile-en.png"});
  assert.equal(await modal.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await machineCall(english.body,"confirm-installation",{protocolVersion:1});
  await modal.locator(".terminal-sync-connected").waitFor();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ enrollmentFeedbackMs: latency, modalAndBadgeUpdated: true, consumedCommandRemoved: true, remoteDisableAndRegeneration: true, closedModalUpdates: true }));
} finally {
  await browser?.close();
  await fixture.close();
}
