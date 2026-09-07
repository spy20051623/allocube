import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startRealtimeFixture } from "./test-realtime-http.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const fixture = await startRealtimeFixture();
try {
  const context = await browser.newContext();
  const cookie = fixture.accounts.owner.cookie, separator = cookie.indexOf("=");
  await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: fixture.origin }]);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.enable");
  let revalidated = 0;
  cdp.on("Network.responseReceivedExtraInfo", event => { if (event.statusCode === 304) revalidated++; });
  const assets = () => page.evaluate(() => performance.getEntriesByType("resource")
    .filter(entry => new URL(entry.name).pathname.startsWith("/assets/"))
    .map(entry => ({ url: entry.name, transfer: entry.transferSize, decoded: entry.decodedBodySize })));

  await page.goto(fixture.origin + "/calendar"); await page.locator(".calendar-main").waitFor();
  const cold = await assets(); assert(cold.length > 0 && cold.some(asset => asset.transfer > 0));
  await page.goto(fixture.origin + "/calendar"); await page.locator(".calendar-main").waitFor();
  const warm = await assets();
  assert(warm.length > 0 && warm.every(asset => asset.transfer === 0 && asset.decoded > 0), JSON.stringify(warm));
  assert(revalidated > 0, "HTML was not conditionally revalidated");

  await page.goto(fixture.origin + "/docs/user-guide"); await page.locator(".docs-article h1").waitFor();
  const docsCold = (await assets()).filter(asset => asset.url.includes("DocumentationPage-"));
  assert.equal(docsCold.length, 2); assert(docsCold.every(asset => asset.transfer > 0));
  await page.goto(fixture.origin + "/docs/user-guide"); await page.locator(".docs-article h1").waitFor();
  const docsWarm = (await assets()).filter(asset => asset.url.includes("DocumentationPage-"));
  assert.equal(docsWarm.length, 2); assert(docsWarm.every(asset => asset.transfer === 0 && asset.decoded > 0));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ htmlRevalidations: revalidated, coldAssetTransfer: cold.reduce((sum, asset) => sum + asset.transfer, 0), warmAssetTransfer: warm.reduce((sum, asset) => sum + asset.transfer, 0), documentAssetsCached: true }));
} finally { await browser.close(); await fixture.close(); }
