import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OwnReservation, OwnReservationPage } from "../src/shared/my-reservations";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-my-reservations-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Reservations82!";
const now = Date.UTC(2026, 8, 5, 10, 0);
const iso = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
let database: typeof import("../server/db");
let app: ReturnType<typeof Fastify>;
let userId: string, otherId: string, machineId: string, secondMachineId: string, groupId: string, secondGroupId: string;
let session: string;
const publish = vi.fn();

function insert(start: number, end: number, options: { user?: string; group?: string; machine?: string; status?: string; cancelledAt?: string; title?: string } = {}) {
  const id = randomUUID(), batchId = randomUUID(), user = options.user ?? userId;
  database.db.prepare("INSERT INTO reservation_batches(id,user_id,created_at) VALUES(?,?,?)").run(batchId, user, iso(-2000));
  database.db.prepare(`INSERT INTO reservations(
    id,batch_id,scope,resource_group_id,machine_id,user_id,start_at,end_at,initial_start_at,initial_end_at,
    title,purpose,note,status,cancelled_at,snapshot_group_name,snapshot_resource_config_json,snapshot_group_version,created_at,updated_at
  ) VALUES(?,?,'RESOURCE_GROUP',?,?,?,?,?,?,?,?,'','',?,?,'Group','[]',1,?,?)`).run(
    id,batchId,options.group ?? groupId,options.machine ?? machineId,user,iso(start),iso(end),iso(start),iso(end),options.title ?? "",options.status ?? "CONFIRMED",options.cancelledAt ?? null,iso(-2000),iso(-2000)
  );
  return id;
}
async function getPage(query = "") {
  const response = await app.inject({ method: "GET", url: `/api/v1/reservations/mine${query ? `?${query}` : ""}`, headers: { cookie: session } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<OwnReservationPage>();
}
async function detail(id: string) {
  const response = await app.inject({ method: "GET", url: `/api/v1/reservations/mine/${id}`, headers: { cookie: session } });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ reservation: OwnReservation }>().reservation;
}
async function cancelBatch(items: OwnReservation[]) {
  return app.inject({ method: "POST", url: "/api/v1/reservations/mine/cancel-batch", headers: { cookie: session },
    payload: { reservations: items.map(({ id, stateToken }) => ({ id, stateToken })), reason: "Plan changed" } });
}
function stateCounts() {
  return {
    cancelled: database.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status != 'CONFIRMED'").get(),
    audits: database.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get(),
    notifications: database.db.prepare("SELECT COUNT(*) AS n FROM notifications").get(),
    revision: database.getScheduleRevision()
  };
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
  database = await import("../server/db"); await database.initializeDatabase();
  userId = (database.db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as { id: string }).id;
  otherId = randomUUID();
  database.db.prepare(`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at)
    VALUES(?,'other','other','Other','unused','USER','ACTIVE',?,?)`).run(otherId, iso(-2000), iso(-2000));
  machineId = randomUUID(); secondMachineId = randomUUID(); groupId = randomUUID(); secondGroupId = randomUUID();
  for (const [machine, group, name] of [[machineId,groupId,"Machine A"], [secondMachineId,secondGroupId,"Machine B"]]) {
    database.db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(machine,name,iso(-2000),iso(-2000));
    database.db.prepare("INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES(?,?,'Group',?,?)").run(group,machine,iso(-2000),iso(-2000));
  }
  app = Fastify(); await app.register(cookie);
  const { registerAuthRoutes } = await import("../server/routes-auth");
  const { registerScheduleRoutes } = await import("../server/routes-schedule");
  registerAuthRoutes(app); registerScheduleRoutes(app, publish);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
    identifierType: "USERNAME", identifier: "Administrator", password: "Reservations82!"
  } });
  expect(login.statusCode).toBe(200);
  session = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
});
afterAll(async () => { vi.useRealTimers(); await app?.close(); database?.db.close(); });

describe("本人占用管理", () => {
  it("超过 200 条未来和历史记录时仍完整分类，稳定翻页且不遗漏进行中记录", async () => {
    const activeId = insert(-5, 30);
    const futureIds: string[] = [], historyIds: string[] = [];
    database.db.transaction(() => {
      for (let i = 0; i < 205; i++) {
        futureIds.push(insert(300 + Math.floor(i / 3), 420 + Math.floor(i / 3)));
        historyIds.push(insert(-1000 + Math.floor(i / 3), -900 + Math.floor(i / 3)));
      }
    })();
    const active = await getPage("category=ACTIVE&limit=6");
    expect(active.reservations.map((r) => r.id)).toEqual([activeId]);
    expect(active.counts).toEqual({ ACTIVE: 1, UPCOMING: 205, HISTORY: 205 });
    expect(active.nextBoundary).toBe(iso(30));
    for (const [category, ids] of [["UPCOMING",futureIds], ["HISTORY",historyIds]] as const) {
      let cursor: string | null = null;
      const found: string[] = [];
      do {
        const params = new URLSearchParams({ category, limit: "20" }); if (cursor) params.set("cursor",cursor);
        const page = await getPage(params.toString());
        expect(page.total).toBe(205);
        found.push(...page.reservations.map((r) => r.id)); cursor = page.nextCursor;
      } while(cursor);
      expect(found).toHaveLength(205); expect(new Set(found)).toEqual(new Set(ids));
    }
    expect((await getPage()).reservations.every((r) => r.startAt > iso(0))).toBe(true);
  });

  it("按时段交集及机器筛选，筛选选项来自全部本人记录，分类数量不受筛选影响", async () => {
    const id = insert(100, 180, { machine: secondMachineId, group: secondGroupId });
    const hidden = insert(100, 180, { user: otherId });
    const query = new URLSearchParams({ machineId: secondMachineId, from: iso(150), to: iso(200) });
    const page = await getPage(query.toString());
    expect(page.reservations.map((r) => r.id)).toEqual([id]);
    expect(page.machineOptions).toHaveLength(2); expect(page.counts.UPCOMING).toBe(206);
    query.set("from",iso(180)); expect((await getPage(query.toString())).total).toBe(0);
    const response = await app.inject({ method:"GET",url:`/api/v1/reservations/mine/${hidden}`,headers:{cookie:session} });
    expect(response.statusCode).toBe(404); expect(response.body).not.toContain(otherId);
    const inspect = await app.inject({ method:"POST",url:"/api/v1/reservations/mine/inspect",headers:{cookie:session},payload:{ids:[id,hidden]} });
    expect(inspect.json().reservations.map((r: OwnReservation) => r.id)).toEqual([id]);
  });

  it("历史按取消或结束时间排序，已取消预约不混入未来列表", async () => {
    const cancelled = insert(800,900,{status:"CANCELLED",cancelledAt:iso(-1)});
    const history = await getPage("category=HISTORY&historyStatus=CANCELLED");
    expect(history.reservations.map((r) => r.id)).toEqual([cancelled]);
    const ended = await getPage("category=HISTORY&historyStatus=ENDED");
    expect(ended.reservations.every((r) => r.status === "CONFIRMED")).toBe(true);
  });

  it("拒绝无效或不匹配的游标，排期变化和时间跨界使游标失效", async () => {
    const page = await getPage();
    const request = (cursor: string, extra = "") => app.inject({ method:"GET",url:`/api/v1/reservations/mine?cursor=${encodeURIComponent(cursor)}${extra}`,headers:{cookie:session} });
    expect((await request("invalid")).statusCode).toBe(400);
    expect((await request(page.nextCursor!,"&category=HISTORY")).statusCode).toBe(400);
    database.bumpScheduleRevision(); expect((await request(page.nextCursor!)).statusCode).toBe(409);
    const fresh = await getPage(); vi.setSystemTime(now+31*60_000);
    expect((await request(fresh.nextCursor!)).statusCode).toBe(409); vi.setSystemTime(now);
  });

  it("加载重复资源组时查询数量不随返回记录数线性增长", async () => {
    const original = database.db.prepare.bind(database.db);
    let calls = 0;
    const spy = vi.spyOn(database.db,"prepare").mockImplementation(((...args: Parameters<typeof original>) => { calls++; return original(...args); }) as typeof database.db.prepare);
    try {
      await getPage("limit=20"); const small = calls; calls=0;
      await getPage("limit=100"); expect(calls).toBeLessThanOrEqual(small+1); expect(calls).toBeLessThan(25);
    } finally { spy.mockRestore(); }
  });

  it("本页改期保留说明、拒绝旧状态覆盖及冲突、禁止调整进行中时间", async () => {
    const id = insert(1000,1060,{title:"Keep me"});
    const initial = await detail(id);
    const body = {scope:initial.scope,resourceGroupId:groupId,startAt:iso(1100),endAt:iso(1160),title:initial.title,purpose:initial.purpose,note:initial.note,expectedStateToken:initial.stateToken};
    const patch = (payload: unknown) => app.inject({method:"PATCH",url:`/api/v1/reservations/${id}`,headers:{cookie:session},payload});
    expect((await patch(body)).statusCode).toBe(200);
    const updated = await detail(id); expect(updated.title).toBe("Keep me"); expect(updated.startAt).toBe(iso(1100));
    expect((await patch({...body,title:"Overwrite"})).statusCode).toBe(409);
    const conflict = await patch({...body,expectedStateToken:updated.stateToken,startAt:iso(301),endAt:iso(350)});
    expect(conflict.statusCode).toBe(409); expect((await detail(id)).startAt).toBe(iso(1100));
    const activeId=insert(-20,50); const active=await detail(activeId);
    const activeBody={scope:active.scope,resourceGroupId:groupId,startAt:active.startAt,endAt:active.endAt,title:"Active note",expectedStateToken:active.stateToken};
    const activePatch=(payload:unknown)=>app.inject({method:"PATCH",url:`/api/v1/reservations/${activeId}`,headers:{cookie:session},payload});
    expect((await activePatch({...activeBody,endAt:iso(80)})).statusCode).toBe(400);
    expect((await activePatch(activeBody)).statusCode).toBe(200);
  });

  it("批量预检拒绝已变化、越权、开始或取消的记录且不产生副作用", async () => {
    const own = await detail(insert(1400,1460));
    const changed = await detail(insert(1500,1560));
    database.db.prepare("UPDATE reservations SET note='Changed' WHERE id=?").run(changed.id);
    const before=stateCounts(); publish.mockClear();
    const result=await cancelBatch([own,changed]); expect(result.statusCode).toBe(409);
    expect(stateCounts()).toEqual(before); expect(publish).not.toHaveBeenCalled();
    expect(result.json().details.issues).toEqual([{id:changed.id,code:"CHANGED"}]);
    const foreign=insert(1500,1560,{user:otherId});
    const denied=await cancelBatch([own,{...own,id:foreign}]); expect(denied.statusCode).toBe(409);
    expect(denied.json().details.issues).toEqual([{id:foreign,code:"NOT_AVAILABLE"}]);
    const started=await detail(insert(-10,80)); expect((await cancelBatch([own,started])).statusCode).toBe(409);
    expect(stateCounts().cancelled).toEqual(before.cancelled);
  });

  it("写入途中失败时也回滚全部取消、审计和版本，成功仅广播一次", async () => {
    const first=await detail(insert(1700,1760)), second=await detail(insert(1800,1860));
    database.db.exec(`CREATE TEMP TRIGGER fail_batch BEFORE UPDATE OF status ON reservations WHEN NEW.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'test batch rollback'); END`);
    const before=stateCounts(); publish.mockClear();
    const failed=await cancelBatch([first,second]); expect(failed.statusCode).toBe(500);
    expect(stateCounts()).toEqual(before); expect(publish).not.toHaveBeenCalled();
    database.db.exec("DROP TRIGGER fail_batch");
    const done=await cancelBatch([first,second]); expect(done.statusCode,done.body).toBe(200);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='RESERVATION_CANCEL' AND entity_id IN (?,?)").get(first.id,second.id)).toEqual({n:2});
    expect((await detail(first.id)).status).toBe("CANCELLED");
    expect((await detail(second.id)).cancellationReason).toBe("Plan changed");
    const after=stateCounts(); expect((await cancelBatch([first,second])).statusCode).toBe(409); expect(stateCounts()).toEqual(after);
  });

  it("拒绝空集合、重复 ID 和超过 100 条的批量请求", async () => {
    const own=await detail(insert(1900,1960));
    for(const items of [[],[own,own],Array.from({length:101},()=>({...own,id:randomUUID()}))]) expect((await cancelBatch(items)).statusCode).toBe(400);
  });

  it("本人失去机器使用权后仍能读取历史及详情，但不能改期或跳转日历", async () => {
    const historyId=insert(-120,-60,{user:otherId});
    const futureId=insert(2400,2460,{user:otherId});
    database.db.prepare("UPDATE users SET password_hash=(SELECT password_hash FROM users WHERE id=?) WHERE id=?").run(userId,otherId);
    const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{identifierType:"USERNAME",identifier:"other",password:"Reservations82!"}});
    expect(login.statusCode).toBe(200);
    const ownCookie=login.cookies.map((c)=>`${c.name}=${c.value}`).join("; ");
    const read=await app.inject({method:"GET",url:`/api/v1/reservations/mine/${historyId}`,headers:{cookie:ownCookie}});
    expect(read.statusCode).toBe(200); expect(read.json().reservation).toMatchObject({id:historyId,canViewCalendar:false,canEdit:false});
    const list=await app.inject({method:"GET",url:"/api/v1/reservations/mine?category=HISTORY",headers:{cookie:ownCookie}});
    expect(list.json().reservations.map((r:OwnReservation)=>r.id)).toContain(historyId);
    const future=await app.inject({method:"GET",url:`/api/v1/reservations/mine/${futureId}`,headers:{cookie:ownCookie}});
    const item=future.json().reservation as OwnReservation;
    const denied=await app.inject({method:"PATCH",url:`/api/v1/reservations/${futureId}`,headers:{cookie:ownCookie},payload:{scope:item.scope,resourceGroupId:item.resourceGroupId,startAt:iso(2500),endAt:iso(2560),expectedStateToken:item.stateToken}});
    expect(denied.statusCode).toBe(403);
  });

  it("草稿打开后预约刚开始或结束时，写入事务重新核对时间规则", async () => {
    const item=await detail(insert(120,180));
    const payload={scope:item.scope,resourceGroupId:item.resourceGroupId,startAt:iso(150),endAt:iso(210),expectedStateToken:item.stateToken};
    const patch=()=>app.inject({method:"PATCH",url:`/api/v1/reservations/${item.id}`,headers:{cookie:session},payload});
    try {
      vi.setSystemTime(now+120*60_000); expect((await patch()).statusCode).toBe(400);
      expect((await cancelBatch([item])).statusCode).toBe(409);
      vi.setSystemTime(now+180*60_000); expect((await patch()).statusCode).toBe(400);
      expect((await detail(item.id)).startAt).toBe(item.startAt);
    } finally {vi.setSystemTime(now);}
  });

  it("改期重新检查新增维护，冲突时原始记录和状态标识不变", async () => {
    const item=await detail(insert(3000,3060));
    database.db.prepare(`INSERT INTO resource_unavailability(id,machine_id,resource_group_id,kind,start_at,end_at,reason,created_by,created_at)
      VALUES(?,?,?,'PLANNED',?,?,'Maintenance',?,?)`).run(randomUUID(),machineId,groupId,iso(3100),iso(3160),userId,iso(0));
    const failed=await app.inject({method:"PATCH",url:`/api/v1/reservations/${item.id}`,headers:{cookie:session},payload:{scope:item.scope,resourceGroupId:item.resourceGroupId,startAt:iso(3100),endAt:iso(3160),expectedStateToken:item.stateToken}});
    expect(failed.statusCode).toBe(409);expect((await detail(item.id)).stateToken).toBe(item.stateToken);
  });

  it("多条编辑预览排除整个编辑序列，提交原子结束进行中、取消未来并新建", async () => {
    const active=await detail(insert(-30,90,{machine:secondMachineId,group:secondGroupId}));
    const upcoming=await detail(insert(4100,4160,{machine:secondMachineId,group:secondGroupId}));
    const payload={replaceReservations:[active,upcoming].map(({id,stateToken})=>({id,stateToken})),segments:[
      {scope:"RESOURCE_GROUP",resourceGroupId:secondGroupId,startAt:iso(4100),endAt:iso(4160),title:"Edited title",purpose:"Edited purpose",note:"Edited note"},
      {scope:"MACHINE",machineId,resourceGroupId:groupId,startAt:iso(4200),endAt:iso(4260)}
    ]};
    const preview=await app.inject({method:"POST",url:"/api/v1/reservations/preview",headers:{cookie:session},payload});
    expect(preview.statusCode,preview.body).toBe(200);expect(preview.json().items.every((item:{available:boolean})=>item.available)).toBe(true);
    expect((await detail(active.id)).endAt).toBe(active.endAt);
    publish.mockClear();
    const done=await app.inject({method:"POST",url:"/api/v1/reservations/batch",headers:{cookie:session},payload});
    expect(done.statusCode,done.body).toBe(201);expect(done.json().reservations).toHaveLength(2);expect(publish).toHaveBeenCalledTimes(1);
    expect((await detail(active.id)).endAt).toBe(iso(0));expect((await detail(upcoming.id)).status).toBe("CANCELLED");
    expect(await detail(done.json().reservations[0].id)).toMatchObject({title:"Edited title",purpose:"Edited purpose",note:"Edited note"});
    const audits=database.db.prepare("SELECT after_json FROM audit_logs WHERE action='RESERVATION_REPLACE' AND entity_id IN (?,?)").all(active.id,upcoming.id) as {after_json:string}[];
    expect(audits).toHaveLength(2);expect(JSON.parse(audits[0].after_json).newReservationIds).toHaveLength(2);
    const before=stateCounts();expect((await app.inject({method:"POST",url:"/api/v1/reservations/batch",headers:{cookie:session},payload})).statusCode).toBeGreaterThanOrEqual(400);expect(stateCounts()).toEqual(before);
  });

  it("多条编辑的冲突、状态变化、外部用户或已结束原记录均保留全部旧占用", async () => {
    const first=await detail(insert(5000,5060)), second=await detail(insert(5100,5160));
    const post=(selection: OwnReservation[], start=5200)=>app.inject({method:"POST",url:"/api/v1/reservations/batch",headers:{cookie:session},payload:{
      replaceReservations:selection.map(({id,stateToken})=>({id,stateToken})),segments:[{resourceGroupId:groupId,startAt:iso(start),endAt:iso(start+60)}]
    }});
    const before=stateCounts();expect((await post([first,second],301)).statusCode).toBe(409);expect(stateCounts()).toEqual(before);
    database.db.prepare("UPDATE reservations SET note='Concurrent adjustment' WHERE id=?").run(second.id);
    expect((await post([first,second])).statusCode).toBe(409);expect(stateCounts()).toEqual(before);
    const foreign=insert(5300,5360,{user:otherId});expect((await post([first,{...first,id:foreign}])).statusCode).toBe(403);
    const ended=await detail(insert(-90,-30));expect((await post([first,ended])).statusCode).toBe(409);
    expect((await detail(first.id)).stateToken).toBe(first.stateToken);
  });

  it("新记录写入途中失败时回滚原记录、已新建记录、批次、审计和版本", async () => {
    const first=await detail(insert(5500,5560)), second=await detail(insert(5600,5660));
    const before=stateCounts();const count=()=>database.db.prepare('SELECT COUNT(*) AS n FROM reservation_batches').get();const batches=count();
    database.db.exec("CREATE TEMP TRIGGER fail_replacement BEFORE INSERT ON reservations WHEN NEW.title='Fail replacement' BEGIN SELECT RAISE(ABORT,'test insert failure'); END");
    publish.mockClear();
    try {
      const failed=await app.inject({method:"POST",url:"/api/v1/reservations/batch",headers:{cookie:session},payload:{
        replaceReservations:[first,second].map(({id,stateToken})=>({id,stateToken})),segments:[
          {resourceGroupId:groupId,startAt:iso(5500),endAt:iso(5560)},
          {resourceGroupId:groupId,startAt:iso(5600),endAt:iso(5660),title:'Fail replacement'}
        ]
      }});
      expect(failed.statusCode).toBe(500);expect(stateCounts()).toEqual(before);expect(count()).toEqual(batches);expect(publish).not.toHaveBeenCalled();
      expect((await detail(first.id)).stateToken).toBe(first.stateToken);expect((await detail(second.id)).stateToken).toBe(second.stateToken);
    } finally { database.db.exec('DROP TRIGGER fail_replacement'); }
  });

  it("释放与新建之间持有即时事务写锁，其他连接既看不到中间释放也不能插入写入", async () => {
    const original=await detail(insert(6000,6060));
    const external=new Database(process.env.DATABASE_PATH!);external.pragma('busy_timeout=0');
    let externalStatus: unknown;let blockedCode: unknown;
    database.db.function('inspect_replacement_lock',()=>{
      externalStatus=external.prepare('SELECT status FROM reservations WHERE id=?').get(original.id);
      try { external.prepare("UPDATE app_meta SET value=value WHERE key='schedule_revision'").run(); }
      catch(error) { blockedCode=(error as {code:string}).code; }
      return 0;
    });
    database.db.exec(`CREATE TEMP TRIGGER inspect_replacement AFTER UPDATE OF status ON reservations WHEN NEW.id='${original.id}' BEGIN SELECT inspect_replacement_lock(); END`);
    try {
      const response=await app.inject({method:'POST',url:'/api/v1/reservations/batch',headers:{cookie:session},payload:{
        replaceReservations:[{id:original.id,stateToken:original.stateToken}],
        segments:[{resourceGroupId:groupId,startAt:iso(6000),endAt:iso(6060)}]
      }});
      expect(response.statusCode,response.body).toBe(201);
      expect(externalStatus).toEqual({status:'CONFIRMED'});expect(blockedCode).toBe('SQLITE_BUSY');
      expect(external.prepare('SELECT status FROM reservations WHERE id=?').get(original.id)).toEqual({status:'CANCELLED'});
    } finally {database.db.exec('DROP TRIGGER inspect_replacement');external.close();}
  });

  it("机器与资源组筛选覆盖所有分类，选项完整且隔离其他用户，历史每页 50 条", async () => {
    const machine = randomUUID(), group = randomUUID(), privateGroup = randomUUID();
    database.db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,'Filter machine',?,?)").run(machine,iso(-2000),iso(-2000));
    for (const id of [group, privateGroup]) database.db.prepare("INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").run(id,machine,id===group?'Filter group':'Private group',iso(-2000),iso(-2000));
    const active = insert(-10,90,{machine,group});
    const upcoming = insert(7000,7060,{machine,group});
    insert(7100,7160,{machine,group:privateGroup,user:otherId});
    const whole = insert(7200,7260,{machine,group});
    database.db.prepare("UPDATE reservations SET scope='MACHINE' WHERE id=?").run(whole);
    const historyIds = Array.from({length: 55},(_,i)=>insert(-500-i*2,-499-i*2,{machine,group}));
    for (const [category, ids] of [["ACTIVE",[active]],["UPCOMING",[upcoming]]] as const) {
      const page = await getPage(`category=${category}&machineId=${machine}&resourceGroupId=${group}`);
      expect(page.reservations.map(item=>item.id)).toEqual(ids);
      expect(page.resourceGroupOptions).toContainEqual({id:group,machineId:machine,name:'Filter group',scope:'RESOURCE_GROUP'});
      expect(page.resourceGroupOptions).toContainEqual({id:machine,machineId:machine,name:'整机',scope:'MACHINE'});
      expect(page.resourceGroupOptions.some(item=>item.id===privateGroup)).toBe(false);
    }
    const wholePage = await getPage(`machineId=${machine}&scope=MACHINE`);
    expect(wholePage.reservations.map(item=>item.id)).toEqual([whole]);
    expect((await getPage(`machineId=${secondMachineId}&resourceGroupId=${group}`)).total).toBe(0);
    const query = `category=HISTORY&machineId=${machine}&resourceGroupId=${group}&limit=50`;
    const first = await getPage(query); const second = await getPage(`${query}&cursor=${first.nextCursor}`);
    expect(first.total).toBe(55); expect(first.reservations).toHaveLength(50); expect(second.reservations).toHaveLength(5);
    expect([...first.reservations,...second.reservations].map(item=>item.id)).toEqual(historyIds);
    const wrongCursor = await app.inject({method:'GET',url:`/api/v1/reservations/mine?${query}&scope=MACHINE&cursor=${first.nextCursor}`,headers:{cookie:session}});
    expect(wrongCursor.statusCode).toBe(400);
  });
});


describe("日历提交自动保留可用片段", () => {
  const post = (segments: unknown[], replaceReservations?: unknown[], autoAdjust = true) => app.inject({ method: "POST", url: "/api/v1/reservations/batch", headers: { cookie: session }, payload: { segments, replaceReservations, autoAdjust } });
  const segment = (start: number, end: number) => ({ resourceGroupId: groupId, startAt: iso(start), endAt: iso(end), title: "", purpose: "", note: "Keep notes" });
  it("预览之后新增占用和维护，提交事务内自动拆分整机占用", async () => {
    const wanted = { ...segment(9000,9120), scope: "MACHINE", machineId };
    const preview = await app.inject({method:"POST",url:"/api/v1/reservations/preview",headers:{cookie:session},payload:{segments:[wanted],autoAdjust:true}});
    expect(preview.json().items[0].available).toBe(true);
    const foreign = insert(9040,9060,{user:otherId});
    database.db.prepare(`INSERT INTO resource_unavailability(id,machine_id,resource_group_id,kind,start_at,end_at,reason,created_by,created_at)
      VALUES(?,?,?,'PLANNED',?,?,'Maintenance',?,?)`).run(randomUUID(),machineId,groupId,iso(9080),iso(9100),userId,iso(0));
    expect((await post([wanted],undefined,false)).statusCode).toBe(409);
    publish.mockClear(); const done = await post([wanted]);
    expect(done.statusCode,done.body).toBe(201); expect(done.json().adjusted).toBe(true);
    expect(done.json().reservations.map((r:{startAt:string;endAt:string})=>[r.startAt,r.endAt])).toEqual([[iso(9000),iso(9040)],[iso(9060),iso(9080)],[iso(9100),iso(9120)]]);
    expect(done.json().reservations.every((r:{scope:string;note:string})=>r.scope==='MACHINE'&&r.note==='Keep notes')).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(database.db.prepare('SELECT status FROM reservations WHERE id=?').get(foreign)).toEqual({status:'CONFIRMED'});
  });
  it("全部不可用时不释放任何原占用，不写入批次、审计或版本", async () => {
    const original=await detail(insert(10000,10060)); insert(10100,10160,{user:otherId});
    const counts=stateCounts(); publish.mockClear();
    const failed=await post([segment(10100,10160)],[{id:original.id,stateToken:original.stateToken}]);
    expect(failed.statusCode).toBe(409); expect(failed.json().code).toBe('NO_AVAILABLE_SEGMENTS');
    expect(stateCounts()).toEqual(counts);expect(publish).not.toHaveBeenCalled();expect((await detail(original.id)).stateToken).toBe(original.stateToken);
  });
  it("编辑时自动调整新时段，原记录与全部新片段原子替换", async () => {
    const original=await detail(insert(10200,10260));insert(10320,10340,{user:otherId});
    const result=await post([segment(10300,10360)],[{id:original.id,stateToken:original.stateToken}]);
    expect(result.statusCode,result.body).toBe(201);expect(result.json().reservations).toHaveLength(2);expect((await detail(original.id)).status).toBe('CANCELLED');
    const stale=await detail(insert(10400,10460));database.db.prepare("UPDATE reservations SET note='Remote change' WHERE id=?").run(stale.id);
    const counts=stateCounts();expect((await post([segment(10500,10560)],[{id:stale.id,stateToken:stale.stateToken}])).statusCode).toBe(409);expect(stateCounts()).toEqual(counts);
  });
  it("自动拆分后的写入失败回滚旧记录与已写片段", async () => {
    const original=await detail(insert(10600,10660));insert(10720,10740,{user:otherId});
    const counts=stateCounts();
    database.db.exec(`CREATE TEMP TRIGGER fail_auto_adjust BEFORE INSERT ON reservations WHEN NEW.start_at='${iso(10740)}' BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
    try {
      const result=await post([segment(10700,10760)],[{id:original.id,stateToken:original.stateToken}]);
      expect(result.statusCode).toBe(500);expect(stateCounts()).toEqual(counts);expect((await detail(original.id)).stateToken).toBe(original.stateToken);
      expect(database.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE start_at=?').get(iso(10700))).toEqual({n:0});
    } finally {database.db.exec('DROP TRIGGER fail_auto_adjust');}
  });
  it("提交中跨过结束时间时剔除过期片段，并保存其他可用片段", async () => {
    const result=await post([segment(-10,-1),segment(10800,10860)]);
    expect(result.statusCode,result.body).toBe(201);expect(result.json().adjusted).toBe(true);expect(result.json().reservations).toHaveLength(1);
  });
  it("旧最短时长配置不再丢弃一分钟的可用碎片", async () => {
    database.db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('min_booking_minutes','5',?)").run(iso(0));
    try {
      insert(14001,14019,{user:otherId});
      const result=await post([segment(14000,14020)]);
      expect(result.statusCode,result.body).toBe(201);
      expect(result.json().reservations.map((row:{startAt:string;endAt:string})=>[row.startAt,row.endAt])).toEqual([[iso(14000),iso(14001)],[iso(14019),iso(14020)]]);
    } finally {database.db.prepare("DELETE FROM settings WHERE key='min_booking_minutes'").run();}
  });
  it("自动拆分不截断超过100条的结果", async () => {
    const segments=[];
    for(let i=0;i<51;i++){const start=11000+i*5;segments.push(segment(start,start+3));insert(start+1,start+2,{user:otherId});}
    const counts=stateCounts();const result=await post(segments);
    expect(result.statusCode,result.body).toBe(400);expect(stateCounts()).toEqual(counts);
  });
});
