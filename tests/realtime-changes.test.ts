import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";
import { RealtimeChanges } from "../server/realtime-changes";
import { affectsRealtime } from "../src/shared/realtime";

let db: Database.Database, changes: RealtimeChanges;
const date = "2026-09-06T00:00:00.000Z";
const sessions = ["a", "b", "c", "admin"];
function session(user: string, id = user) { db.prepare("INSERT INTO sessions VALUES(?,?,?,'csrf','2099-01-01',?,?)").run(id, user, id, date, date); }
function reservation(id = "r", machine = "m1", user = "a", start = "2026-09-06T10:00:00.000Z", end = "2026-09-06T11:00:00.000Z") {
  db.prepare("INSERT INTO reservation_batches VALUES(?,?,?)").run(id, user, date);
  db.prepare(`INSERT INTO reservations(id,batch_id,resource_group_id,machine_id,user_id,start_at,end_at,initial_start_at,initial_end_at,snapshot_group_name,snapshot_resource_config_json,snapshot_group_version,created_at,updated_at,title)
    VALUES(?,?,?,?,?,?,?,?,?,'private group','[]',1,?,?,'private purpose')`).run(id, id, machine, machine, user, start, end, start, end, date, date);
}
const drain = () => changes.drain(sessions, 5);
beforeEach(() => {
  db = new Database(":memory:"); db.pragma("foreign_keys=ON"); db.exec(FINAL_SCHEMA_SQL);
  for (const user of sessions) {
    db.prepare("INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at) VALUES(?,?,?,'private name','private hash',?,'ACTIVE',?,?)").run(user,user,user,user === "admin" ? "SYSTEM_ADMIN" : "USER",date,date);
    session(user);
  }
  for (const id of ["m1", "m2"]) {
    db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(id,id,date,date);
    db.prepare("INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES(?,?,?, ?,?)").run(id,id,id,date,date);
  }
  for (const [user, machine] of [["a", "m1"], ["b", "m1"], ["c", "m2"]]) db.prepare("INSERT INTO machine_access_memberships VALUES(?,?,?,'SEED','admin',?,?)").run(user,machine,user,date,date);
  changes = new RealtimeChanges(db);
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });

describe("按提交结果定向发布实时事件", () => {
  it("终端登记、停用和联系时间只通知有权访问或管理该机器的用户", () => {
    db.prepare("DELETE FROM machine_access_memberships WHERE user_id='b'").run();
    db.prepare("INSERT INTO machine_admins VALUES('m1','b','admin',?)").run(date);
    drain();
    db.prepare("INSERT INTO machine_terminals(id,machine_id,callback_url,created_at) VALUES('terminal1','m1','',?)").run(date);
    for (const operation of [
      () => {},
      () => db.prepare("UPDATE machine_terminals SET public_key='private fixture key',last_seen_at=? WHERE id='terminal1'").run(date),
      () => db.prepare("UPDATE machine_terminals SET enabled=0 WHERE id='terminal1'").run(),
      () => db.prepare("UPDATE machine_terminals SET last_seen_at='2026-09-07' WHERE id='terminal1'").run(),
      () => db.prepare("DELETE FROM machine_terminals WHERE id='terminal1'").run(),
    ]) {
      operation();
      const result = drain();
      expect([...result.keys()]).toEqual(["a", "b", "admin"]);
      for (const change of result.values()) expect(change.scopes).toEqual([{ topic: "terminal", machineId: "m1" }]);
      expect(JSON.stringify([...result.values()])).not.toContain("fixture key");
    }
    expect(affectsRealtime(changes.full(5), "terminal", { machineId: "m1" })).toBe(true);
  });
  it("占用只通知可访问机器的用户，本人列表不刷新其他用户", () => {
    reservation(); const result = drain();
    expect([...result.keys()]).toEqual(["a", "b", "admin"]);
    expect(affectsRealtime(result.get("a")!, "ownReservations")).toBe(true);
    expect(result.get("b")!.scopes.map(s => s.topic)).toEqual(["timeline"]);
    expect(affectsRealtime(result.get("b")!, "timeline", { machineIds: ["m1"], from: "2026-09-07", to: "2026-09-08" })).toBe(false);
    expect(JSON.stringify([...result.values()])).not.toMatch(/private|user_id|password|purpose|title/);
    expect(drain().size).toBe(0);
  });
  it("外层及嵌套回滚不会留下通知，原子替换同时保留前后机器和日期", () => {
    reservation(); drain();
    expect(() => db.transaction(() => {
      db.prepare("DELETE FROM reservations WHERE id='r'").run();
      db.transaction(() => reservation("new", "m2"))();
      expect(drain().size).toBe(0);
      throw new Error("rollback");
    })()).toThrow("rollback");
    expect(drain().size).toBe(0);
    db.transaction(() => {
      db.prepare("DELETE FROM reservations WHERE id='r'").run();
      reservation("new", "m2", "a", "2026-09-08T10:00:00.000Z", "2026-09-08T11:00:00.000Z");
    })();
    const result = drain();
    expect(result.get("admin")!.scopes.filter(s => s.topic === "timeline").map(s => s.machineId).sort()).toEqual(["m1", "m2"]);
    expect(affectsRealtime(result.get("c")!, "ownReservations")).toBe(false);
  });
  it("同一排期版本的不同权限和通知事件仍有独立标识", () => {
    db.prepare("DELETE FROM machine_access_memberships WHERE user_id='a'").run();
    const first = drain().get("a")!;
    expect(first.accessChanged).toBe(true);
    expect(affectsRealtime(first, "timeline")).toBe(true);
    db.prepare("INSERT INTO notifications(id,user_id,type,title,body,created_at) VALUES('n','a','TEST','private','private',?)").run(date);
    const next = drain(); expect([...next.keys()]).toEqual(["a"]);
    expect(next.get("a")!.scopes).toEqual([{ topic: "notifications" }]);
    expect(next.get("a")!.eventId).not.toBe(first.eventId);
    expect(next.get("a")!.revision).toBe(first.revision);
  });
  it("撤销会话和停用账号发送失效事件，不附带业务范围", () => {
    db.prepare("DELETE FROM sessions WHERE id='a'").run();
    db.prepare("UPDATE users SET status='DISABLED' WHERE id='b'").run();
    const result = drain();
    for (const id of ["a", "b"]) expect(result.get(id)).toMatchObject({ sessionEnded: true, scopes: [{ topic: "session" }] });
  });
  it("删除资源后仍刷新失权用户的历史，目录更新不暴露无权机器标识", () => {
    reservation(); drain();
    db.prepare("INSERT INTO deleted_resource_group_tombstones VALUES('m1','m1',?,'admin','{}')").run(date);
    db.prepare("UPDATE resource_groups SET name='deleted' WHERE id='m1'").run();
    const result = drain();
    expect(affectsRealtime(result.get("a")!, "ownReservations")).toBe(true);
    expect(result.get("c")!.scopes).toEqual([{ topic: "catalog" }]);
  });
  it("维护边界只更新对应机器，不触发会话查询", () => {
    changes.boundary(["m1", "m1"]); const result = drain();
    expect(result.get("c")!.scopes).toEqual([{ topic: "catalog" }]);
    expect(affectsRealtime(result.get("b")!, "timeline", { machineId: "m1" })).toBe(true);
    expect(affectsRealtime(result.get("b")!, "session")).toBe(false);
  });
  it("设置更新和通知已读有独立范围；会话心跳不产生刷新", () => {
    db.prepare("UPDATE sessions SET last_seen_at='2026-09-07'").run();
    db.prepare("UPDATE users SET last_login_at='2026-09-07' WHERE id='a'").run();
    expect(drain().size).toBe(0);
    db.prepare("INSERT INTO settings VALUES('advance_days','30',?)").run(date);
    expect(drain().get("a")!.scopes).toEqual([{ topic: "session" }]);
  });
  it("管理员变动及身份更新同步目录和相关成员展示", () => {
    db.prepare("INSERT INTO machine_admins VALUES('m1','a','admin',?)").run(date);
    const granted = drain();
    expect(granted.get("a")!.accessChanged).toBeUndefined();
    expect(affectsRealtime(granted.get("a")!, "session")).toBe(true);
    expect(granted.get("c")!.scopes).toEqual([{ topic: "catalog" }]);
    db.prepare("UPDATE users SET display_name='new name' WHERE id='a'").run();
    const renamed = drain();
    expect(affectsRealtime(renamed.get("b")!, "access", { machineId: "m1" })).toBe(true);
    expect(affectsRealtime(renamed.get("c")!, "catalog")).toBe(true);
    expect(affectsRealtime(renamed.get("c")!, "session")).toBe(false);
    db.prepare("DELETE FROM machine_admins WHERE user_id='a'").run();
    const revoked = drain().get("a")!;
    expect(revoked.accessChanged).toBe(true);
    expect(affectsRealtime(revoked, "session")).toBe(true);
  });
  it("机器删除后的清理事件包含会话复核，新增机器可进入全机器查询", () => {
    reservation(); drain();
    db.prepare("INSERT INTO deleted_machine_tombstones VALUES('m1',?,'admin','{}')").run(date);
    db.prepare("UPDATE machines SET name='deleted' WHERE id='m1'").run();
    const removed = drain().get("a")!;
    expect(removed.accessChanged).toBe(true);
    expect(affectsRealtime(removed, "session")).toBe(true);
    db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES('new','new',?,?)").run(date,date);
    expect(affectsRealtime(drain().get("admin")!, "timeline", { from: date, to: "2026-09-07" })).toBe(true);
  });
  it("多个连接复用同一用户投递和批量权限查询，临时记录不写入持久结构", () => {
    for (let i=0;i<50;i++) session("b", `b${i}`);
    reservation(); const spy = vi.spyOn(db, "prepare");
    const result = changes.drain([...sessions,...Array.from({length:50},(_,i)=>`b${i}`)], 5);
    expect(result.get("b0")).toBe(result.get("b49"));
    expect(spy.mock.calls.filter(([sql]) => sql.includes("FROM machine_access_memberships"))).toHaveLength(1);
    expect(spy.mock.calls.filter(([sql]) => sql.includes("FROM machine_admins"))).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'realtime_%'").all()).toEqual([]);
  });
});
