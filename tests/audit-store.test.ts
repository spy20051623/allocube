import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";
import { AuditStore } from "../server/audit-store";

let db: Database.Database, store: AuditStore, statements: string[];
const date = "2026-09-07T00:00:00.000Z";
function audit(action = "USER_LOGIN", type = "user", entity = "u", before?: unknown, after?: unknown, actor: string | null = "u", at = date, operation: string | null = null) {
  const id = randomUUID();
  db.prepare("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at,api_operation_id) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(id, actor, action, type, entity, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), at, operation);
  return id;
}
beforeEach(() => {
  statements = [];
  db = new Database(":memory:", { verbose: sql => statements.push(sql) }); db.exec(FINAL_SCHEMA_SQL);
  db.prepare("INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at) VALUES('u','user','user','User','hash','SYSTEM_ADMIN','ACTIVE',?,?)").run(date,date);
  db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES('m','Machine',?,?)").run(date,date);
  db.prepare("INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES('g','m','Group',?,?)").run(date,date);
  store = new AuditStore(db, "test-cursor-secret");
});
afterEach(() => db.close());

describe("audit queries", () => {
  it("shows key operation metadata without exposing keys, proofs or unrelated identity fields", () => {
    for (const action of ["SSH_KEY_ADD", "SSH_KEY_REMOVE", "SSH_KEY_ACTIVATE", "SSH_KEY_DEACTIVATE"]) {
      const personal = action === "SSH_KEY_ADD" || action === "SSH_KEY_REMOVE";
      const metadata = { ...(personal ? { name: "Laptop" } : {}), keyId: "key", fingerprint: "SHA256:public-fingerprint" };
      const detail = store.detail(audit(action, personal ? "user" : "machine", personal ? "u" : "m", undefined,
        { ...metadata, publicKey: "SECRET_KEY", privateKey: "SECRET_PRIVATE", code: "SECRET_CODE", email: "SECRET_EMAIL" }));
      expect(detail.fields).toEqual(Object.entries(metadata).map(([key, after]) => ({ key, after })));
      expect(detail.unavailable).toBe(false);
      expect(JSON.stringify(detail)).not.toContain("SECRET");
    }
    // Old records only have a fingerprint; they must still become readable.
    expect(store.detail(audit("SSH_KEY_REMOVE", "user", "u", undefined, { fingerprint: "SHA256:old" })).fields)
      .toEqual([{ key: "fingerprint", after: "SHA256:old" }]);
    expect(store.detail(audit("USER_LOGIN", "user", "u", undefined, { keyId: "SECRET", fingerprint: "SECRET" })).fields).toEqual([]);
    const removed = audit("SSH_KEY_ADD", "user", "u", undefined, { name: "SECRET", fingerprint: "SECRET" });
    db.prepare("INSERT INTO deleted_user_tombstones VALUES('u',?,'u','{}')").run(date);
    expect(store.detail(removed).fields).toEqual([]);
  });
  it("pages beyond 300 with equal timestamps and a fixed insertion boundary, including returning to page one", () => {
    const ids: string[] = [];
    db.transaction(() => { for (let i=0;i<367;i++) ids.push(audit()); })();
    const first = store.list({});
    const late = audit("USER_LOGIN", "user", "u", undefined, undefined, "u", "2020-01-01T00:00:00.000Z");
    audit();
    const found = first.logs.map(r => r.id); let cursor = first.nextCursor;
    while (cursor) { const page = store.list({ cursor }); expect(page.total).toBe(367); found.push(...page.logs.map(r => r.id)); cursor = page.nextCursor; }
    expect(found).toEqual(ids.sort().reverse()); expect(new Set(found).size).toBe(367); expect(found).not.toContain(late);
    expect(store.list({cursor:first.cursor}).logs).toEqual(first.logs);
    expect(store.list({}).total).toBe(369);
    expect(() => store.list({cursor:first.nextCursor!,source:"API"})).toThrow();
    expect(() => store.list({cursor:first.nextCursor! + "x"})).toThrow();
  });
  it("filters operation time using inclusive start and exclusive next-day end, actor, action and source", () => {
    audit("USER_LOGIN","user","u",undefined,undefined,null,"2026-09-06T15:59:59.999Z");
    const match = audit("RESERVATION_CREATE","reservation","r",undefined,{resourceGroupId:"g"},"u","2026-09-06T16:00:00.000Z","operation");
    audit("USER_LOGIN","user","u",undefined,undefined,"u","2026-09-07T16:00:00.000Z");
    const page = store.list({from:"2026-09-06T16:00:00Z",to:"2026-09-07T16:00:00Z",actor:"u",action:"RESERVATION_CREATE",source:"API"});
    expect(page.logs.map(r=>r.id)).toEqual([match]); expect(page.total).toBe(1);
    expect(store.list({source:"OTHER"}).total).toBe(2); expect(store.list({actor:"__system__"}).total).toBe(1);
    expect(store.options().actors).toHaveLength(2); expect(store.options().actions).toEqual(["RESERVATION_CREATE","USER_LOGIN"]);
    expect(() => store.list({from:date,to:date})).toThrow();
  });
  it("returns safe normalized changes and historical times, excluding unrecorded and secret fields", () => {
    const id = audit("RESERVATION_UPDATE","reservation","r",{resource_group_id:"g",start_at:date,end_at:"2026-09-07T01:00:00.000Z",note:"Original",password_hash:"SECRET"},
      {resourceGroupId:"g",startAt:date,endAt:"2026-09-07T02:00:00.000Z",note:"Edited",unknown:{secret:"SECRET"}});
    const detail = store.detail(id);
    expect(detail.entry.entityName).toBe("Machine / Group"); expect(detail.entry.endAt).toBe("2026-09-07T02:00:00.000Z");
    expect(detail.fields).toEqual([{key:"endAt",before:"2026-09-07T01:00:00.000Z",after:"2026-09-07T02:00:00.000Z"},{key:"note",before:"Original",after:"Edited"}]);
    expect(JSON.stringify(detail)).not.toContain("SECRET");
    const list = store.list({}); expect(list.logs[0]).not.toHaveProperty("before"); expect(list.logs[0]).not.toHaveProperty("fields");
    const blank = store.detail(audit("RESERVATION_CANCEL","reservation","r",undefined,{reason:"Only reason"}));
    expect(blank.entry.startAt).toBeUndefined(); expect(blank.fields).toEqual([{key:"reason",after:"Only reason"}]);
  });
  it("handles settings, maintenance, feedback, permission, report and replacement payloads without guessing missing values", () => {
    const cases: [string,string,unknown,unknown,string][] = [
      ["SETTINGS_UPDATE","settings",{minBookingMinutes:10,maxBookingMinutes:120},{minBookingMinutes:15,maxBookingMinutes:120},"minBookingMinutes"],
      ["UNAVAILABILITY_CREATE","resource_unavailability",undefined,{targetType:"MACHINE",startAt:date,reasonProvided:true},"reasonProvided"],
      ["FEEDBACK_UPDATE","feedback",{bodyLength:15},{bodyLength:20,changedFields:["bodyMarkdown"]},"bodyLength"],
      ["MACHINE_ADMIN_ASSIGN","machine",undefined,{userId:"u"},"userId"],
      ["REPORT_REBUILD_REQUEST","REPORT",undefined,{fromDate:"2026-09-01",toDate:"2026-09-06"},"fromDate"],
      ["RESERVATION_REPLACE","reservation",{start_at:date},{newReservationIds:["new"],segmentCount:1},"newReservationIds"],
      ["SMTP_SETTINGS_UPDATE","smtp_settings",{hasPassword:true},{passwordChanged:true,password:"SECRET",password_encrypted:"SECRET"},"passwordChanged"]
    ];
    for (const [action,type,b,a,key] of cases) {
      const detail = store.detail(audit(action,type,type==="machine"?"m":"target",b,a));
      expect(detail.fields.some(f=>f.key===key),action).toBe(true);
      expect(JSON.stringify(detail)).not.toContain("SECRET");
    }
  });
  it("does not reveal historical identity or notes after related resource/user deletion", () => {
    const id = audit("RESERVATION_CREATE","reservation","r",undefined,{resourceGroupId:"g",title:"PRIVATE OLD TITLE",note:"PRIVATE NOTE",startAt:date});
    db.prepare("INSERT INTO deleted_resource_group_tombstones VALUES('g','m',?,'u','{}')").run(date);
    const detail = store.detail(id);
    expect(detail.entry.resourceGroupName).toBe("资源组已删除"); expect(detail.fields).toEqual([]); expect(detail.entry.startAt).toBeUndefined();
    expect(JSON.stringify(detail)).not.toContain("PRIVATE");
    const userLog = audit("USER_STATUS_CHANGE","user","u",{displayName:"OLD PRIVATE NAME"},{status:"DISABLED"});
    db.prepare("INSERT INTO deleted_user_tombstones VALUES('u',?,'u','{}')").run(date);
    expect(store.detail(userLog).entry.actorName).toBe("用户已删除"); expect(store.detail(userLog).fields).toEqual([]);
    expect(store.options().actors[0].name).toBe("用户已删除");
  });
  it("tolerates corrupt, empty and unknown payloads", () => {
    const bad = audit(); db.prepare("UPDATE audit_logs SET before_json='invalid' WHERE id=?").run(bad);
    expect(store.list({}).total).toBe(1); expect(store.detail(bad).unavailable).toBe(true);
    const unknown = store.detail(audit("FUTURE_ACTION","future","id",undefined,{secret:"SECRET",name:"unapproved"}));
    expect(unknown.entry.action).toBe("FUTURE_ACTION"); expect(unknown.fields).toEqual([]);
    expect(() => store.detail("missing")).toThrow("审计记录不存在");
  });
  it("preserves change flags and safely describes resource composition", () => {
    const note = store.detail(audit("MACHINE_UPDATE","machine","m",{managementNotesChanged:true},{managementNotesChanged:true}));
    expect(note.fields).toContainEqual({key:"managementNotesChanged",after:true});
    db.prepare("INSERT INTO resource_pools(id,machine_id,name,kind,unit,range_start,range_end,created_at,updated_at) VALUES('p','m','CPU','INDEX_RANGE','core',0,63,?,?)").run(date,date);
    const group = audit("RESOURCE_GROUP_UPDATE","resource_group","g",undefined,{allocations:[{poolId:"p",poolName:"OLD POOL NAME",kind:"INDEX_RANGE",ranges:[{start:1,end:4}],secret:"SECRET"}]});
    expect(store.detail(group).fields).toContainEqual({key:"allocations",after:["CPU · 1–4"]});
    db.prepare("INSERT INTO deleted_resource_pool_tombstones VALUES('p','m',?,'u')").run(date);
    const removed=store.detail(group);expect(removed.fields).toContainEqual({key:"allocations",after:["资源项已删除"]});
    expect(JSON.stringify(removed)).not.toContain("OLD POOL NAME");expect(JSON.stringify(removed)).not.toContain("SECRET");
  });
  it("batch resolves repeated objects and limits payload reads on a large history", () => {
    db.transaction(() => { for(let i=0;i<20000;i++) audit("RESERVATION_CREATE","reservation",`r${i}`,undefined,{resourceGroupId:"g",startAt:date}); })();
    statements.length=0; const start=performance.now(); const page=store.list({});
    expect(page.total).toBe(20000); expect(page.logs).toHaveLength(50);
    expect(statements.filter(s=>/^SELECT/.test(s)).length).toBeLessThan(22);
    expect(statements.filter(s=>s.includes("FROM resource_groups WHERE"))).toHaveLength(1);
    expect(performance.now()-start).toBeLessThan(2000);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM audit_logs WHERE actor_user_id=? ORDER BY created_at DESC,id DESC LIMIT 50").all("u");
    expect(JSON.stringify(plan)).toContain("audit_actor_time_idx");
  });
});
