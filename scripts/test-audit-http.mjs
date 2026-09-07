import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { startRealtimeFixture } from "./test-realtime-http.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fixture = await startRealtimeFixture();
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
const errors = [], results = {};
const database = new Database(fixture.databasePath);
try {
  const admin = database.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get().id;
  const insert = database.prepare("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?)");
  const stamp = "2026-09-07T00:00:00.000Z";
  database.transaction(()=>{for(let i=0;i<367;i++)insert.run(randomUUID(),admin,"RESERVATION_UPDATE","reservation",`legacy-${i}`,JSON.stringify({resource_group_id:fixture.ids.group1,start_at:stamp,end_at:"2026-09-07T01:00:00.000Z",note:"Before"}),JSON.stringify({resourceGroupId:fixture.ids.group1,startAt:stamp,endAt:"2026-09-07T02:00:00.000Z",note:"After",secret:"DO-NOT-EXPOSE"}),stamp);})();
  for(const name of ["owner","peer"]) for(const endpoint of ["/admin/audit","/admin/audit/options","/admin/audit/missing"]) assert.equal((await fixture.request(name,endpoint)).status,403);
  database.prepare("INSERT INTO machine_admins(machine_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)").run(fixture.ids.machine1,fixture.ids.peer,admin,stamp);
  for(const endpoint of ["/admin/audit","/admin/audit/options","/admin/audit/missing"]) assert.equal((await fixture.request("peer",endpoint)).status,403);
  const first=await fixture.request("Administrator","/admin/audit?action=RESERVATION_UPDATE");assert.equal(first.status,200);assert.equal(first.body.total,367);
  assert(!JSON.stringify(first.body).includes("DO-NOT-EXPOSE"));
  let next=first.body.nextCursor, ids=first.body.logs.map(row=>row.id);
  while(next){const response=await fixture.request("Administrator",`/admin/audit?action=RESERVATION_UPDATE&cursor=${encodeURIComponent(next)}`);assert.equal(response.status,200);ids.push(...response.body.logs.map(row=>row.id));next=response.body.nextCursor;}
  assert.equal(new Set(ids).size,367);
  const detail=await fixture.request("Administrator",`/admin/audit/${ids[0]}`);assert.equal(detail.status,200);assert(detail.body.fields.some(field=>field.key==="note"));assert(!JSON.stringify(detail.body).includes("DO-NOT-EXPOSE"));
  assert.equal((await fixture.request("Administrator","/admin/audit/missing")).status,404);
  assert.equal((await fixture.request("Administrator","/admin/audit?cursor=invalid")).status,400);
  results.httpPermissionsPaginationAndDetails=true;
  async function pageFor(locale,width) {
    const context=await browser.newContext({viewport:{width,height:900}});
    await context.addInitScript(value=>localStorage.setItem("allocube:locale:v1",value),locale);
    const cookie=fixture.accounts.Administrator.cookie, separator=cookie.indexOf("=");
    await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:fixture.origin}]);
    const page=await context.newPage();page.on("pageerror",e=>errors.push(e.message));
    await page.goto(fixture.origin+"/admin/audit");await page.locator("button.audit-record").first().waitFor();return page;
  }
  const page=await pageFor("zh-CN",1440);
  let reads=0;page.on("request",r=>{const u=new URL(r.url());if(u.pathname==="/api/v1/admin/audit")reads++;});
  await page.locator('input[type="date"]').first().fill("2099-01-01");assert.equal(reads,0);
  await page.getByRole("button",{name:"查询",exact:true}).click();await page.getByText("暂无审计记录",{exact:true}).waitFor();
  await page.getByRole("button",{name:"重置",exact:true}).click();await page.locator("button.audit-record").first().waitFor();
  await page.getByRole("button",{name:"下一页",exact:true}).click();await page.getByText(/第 2 页/).waitFor();
  const scrollTop = await page.locator(".audit-records").evaluate(e=>e.getBoundingClientRect().top);
  const containerTop = await page.locator(".audit-management-page").evaluate(e=>e.getBoundingClientRect().top);
  assert(scrollTop >= containerTop && scrollTop < containerTop + 30, `List top after paging: ${scrollTop}, container: ${containerTop}`);
  await page.locator("button.audit-record").first().click();await page.getByRole("dialog").getByText("修改后 / 记录值",{exact:true}).first().waitFor();await page.keyboard.press("Escape");
  results.explicitQueryPaginationAndKeyboard=true;
  // A failed refresh must retain content; an explicit retry resolves it.
  let fail=true;
  await page.route("**/api/v1/admin/audit?*",async route=>{if(fail){fail=false;await route.abort();}else await route.continue();});
  await page.getByRole("button",{name:"查询",exact:true}).click();await page.getByRole("alert").waitFor();assert.equal(await page.locator("button.audit-record").count(),50);
  await page.getByRole("button",{name:"重试",exact:true}).click();await page.getByRole("alert").waitFor({state:"hidden"});
  await page.unroute("**/api/v1/admin/audit?*");
  // Let the first response arrive after a newer query; it cannot overwrite the new result.
  let release;const held=new Promise(resolve=>{release=resolve;});let started;const heldStarted=new Promise(resolve=>{started=resolve;});let hold=true;
  await page.route("**/api/v1/admin/audit?*",async route=>{if(hold){hold=false;const response=await route.fetch();started();await held;await route.fulfill({response}).catch(()=>{});}else await route.continue();});
  await page.getByRole("button",{name:"查询",exact:true}).click();await heldStarted;
  await page.locator('input[type="date"]').first().fill("2099-01-01");await page.getByRole("button",{name:"查询",exact:true}).click();await page.getByText("暂无审计记录",{exact:true}).waitFor();release();
  await page.unrouteAll({behavior:"wait"});assert.equal(await page.locator("button.audit-record").count(),0);
  results.failedRefreshAndOutOfOrder=true;
  await page.getByRole("button",{name:"重置",exact:true}).click();await page.locator("button.audit-record").first().waitFor();
  let finishDetail;const detailWait=new Promise(resolve=>{finishDetail=resolve;});let detailStarted;const detailReady=new Promise(resolve=>{detailStarted=resolve;});
  await page.route("**/api/v1/admin/audit/*",async route=>{const response=await route.fetch();detailStarted();await detailWait;await route.fulfill({response}).catch(()=>{});});
  await page.locator("button.audit-record").first().click();await detailReady;await page.keyboard.press("Escape");finishDetail();await page.unrouteAll({behavior:"wait"});assert.equal(await page.getByRole("dialog").count(),0);
  // The deadline includes stalled response bodies, and keeps the existing list available.
  let finishTimeout;const timeoutWait=new Promise(resolve=>{finishTimeout=resolve;});
  await page.route("**/api/v1/admin/audit?*",async route=>{await timeoutWait;await route.abort().catch(()=>{});});
  await page.getByRole("button",{name:"查询",exact:true}).click();await page.getByText("请求超时",{exact:false}).waitFor({timeout:20000});
  assert.equal(await page.locator("button.audit-record").count(),50);finishTimeout();await page.unrouteAll({behavior:"wait"});
  await page.getByRole("button",{name:"重试",exact:true}).click();await page.getByRole("alert").waitFor({state:"hidden"});
  results.closedDetailAndTimeout=true;
  for(const locale of ["zh-CN","en"]) for(const width of [1440,390]) {
    const screen=await pageFor(locale,width);
    assert(await screen.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await screen.screenshot({path:`.codex-tmp/audit-${locale}-${width}.png`,fullPage:false});
    await screen.locator("button.audit-record").nth(8).click();await screen.locator(".audit-detail-meta").waitFor();
    assert(await screen.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await screen.screenshot({path:`.codex-tmp/audit-detail-${locale}-${width}.png`,fullPage:false});
    await screen.context().close();
  }
  results.bilingualDesktopAndNarrow=true;
  // Bulk history must not transfer payloads or stall independent health reads.
  database.transaction(()=>{for(let i=0;i<20000;i++)insert.run(randomUUID(),admin,"USER_LOGIN","session",admin,null,null,stamp);})();
  const start=performance.now();const [list,health]=await Promise.all([fixture.request("Administrator","/admin/audit"),fetch(fixture.origin+"/health")]);
  assert.equal(list.status,200);assert.equal(health.status,200);assert(performance.now()-start<2000);
  results.largeHistoryHttpMs=Math.round(performance.now()-start);
  assert.deepEqual(errors,[]);assert(!fixture.logs().includes('"level":50'),fixture.logs());
  console.log(JSON.stringify(results));
} finally {database.close();await browser.close();await fixture.close();}
