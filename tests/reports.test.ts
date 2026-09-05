import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { ReportStore } from "../server/report-store";
import { latestReportDate } from "../src/shared/reports";
import { startReportScheduler } from "../server/report-scheduler";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-daily-reports-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "data.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "ReportsTest82!";
const now = Date.parse("2026-09-06T07:00:00+08:00");
const created = "2026-09-01T00:00:00+08:00";
const iso = (value: string) => new Date(value).toISOString();
let database: typeof import("../server/db");
let routes: typeof import("../server/report-routes");
let store: ReportStore, app: ReturnType<typeof Fastify>;
let admin: string, user: string, machine: string, group: string, group2: string;
let adminCookie: string, userCookie: string;

function reservation(start: string, end: string, scope = "RESOURCE_GROUP", owner = user, target = group) {
  const id = randomUUID(), batch = randomUUID();
  database.db.prepare("INSERT INTO reservation_batches VALUES(?,?,?)").run(batch, owner, iso(created));
  database.db.prepare(`INSERT INTO reservations(id,batch_id,scope,resource_group_id,machine_id,user_id,
    start_at,end_at,initial_start_at,initial_end_at,status,snapshot_group_name,snapshot_resource_config_json,
    snapshot_group_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'CONFIRMED','Group','[]',1,?,?)`)
    .run(id, batch, scope, target, machine, owner, iso(start), iso(end), iso(start), iso(end), iso(created), iso(created));
  return id;
}
function maintenance(start: string, end: string, target: string | null = null) {
  database.db.prepare(`INSERT INTO resource_unavailability(id,machine_id,resource_group_id,kind,start_at,end_at,reason,created_by,created_at)
    VALUES(?,?,?,'PLANNED',?,?,'Test',?,?)`).run(randomUUID(), machine, target, iso(start), iso(end), admin, iso(created));
}
function settle(day: string) { store.settleDay(store.state()!.active_version, day); }
function report(from = "2026-09-01", to = from) { return routes.readUsageReport([machine], from, to); }
function finish() { for (let i = 0; i < 100; i++) if (!store.step(now)) return; throw new Error("Task did not finish"); }
async function login(identifier: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifierType: "USERNAME", identifier, password: "ReportsTest82!" } });
  expect(response.statusCode, response.body).toBe(200);
  return response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}
beforeAll(async () => {
  database = await import("../server/db"); await database.initializeDatabase();
  routes = await import("../server/report-routes");
  admin = (database.db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as { id: string }).id;
  user = randomUUID();
  database.db.prepare(`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at)
    SELECT ?,'reader','reader','Reader',password_hash,'USER','ACTIVE',?,? FROM users WHERE id=?`).run(user, iso(created), iso(created), admin);
  app = Fastify(); await app.register(cookie);
  (await import("../server/routes-auth")).registerAuthRoutes(app);
  routes.registerReportRoutes(app, (s) => `"${s.replaceAll('"', '""')}"`);
  adminCookie = await login("Administrator"); userCookie = await login("reader");
});
beforeEach(() => {
  database.db.exec(`DELETE FROM audit_logs; DELETE FROM report_jobs; DELETE FROM report_state; DELETE FROM report_versions;
    DELETE FROM reservations; DELETE FROM reservation_batches; DELETE FROM resource_unavailability;
    DELETE FROM deleted_resource_group_tombstones; DELETE FROM deleted_machine_tombstones; DELETE FROM deleted_user_tombstones;
    DELETE FROM resource_groups; DELETE FROM machine_admins; DELETE FROM machine_access_memberships; DELETE FROM machines;`);
  machine = randomUUID(); group = randomUUID(); group2 = randomUUID();
  database.db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,'Machine',?,?)").run(machine, iso(created), iso(created));
  for (const id of [group, group2]) database.db.prepare("INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES(?,?,?,?,?)").run(id, machine, id, iso(created), iso(created));
  store = new ReportStore(database.db); store.initialize(now);
});
afterAll(async () => { await app.close(); database.db.close(); });

describe("每日统计与全量重算", () => {
  it("固定北京时间 06:00，不受本机时区影响", () => {
    expect(latestReportDate(Date.parse("2026-09-05T21:59:59.999Z"))).toBe("2026-09-04");
    expect(latestReportDate(Date.parse("2026-09-05T22:00:00Z"))).toBe("2026-09-05");
    expect(latestReportDate(Date.parse("2026-09-06T16:00:00Z"))).toBe("2026-09-05");
  });
  it("近期优先补齐全部历史、空日期也有完成标记，重复执行不增加结果", () => {
    expect(store.step(now)).toBe(true);
    expect(database.db.prepare("SELECT day FROM report_days").all()).toEqual([{ day: "2026-09-05" }]);
    finish();
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM report_days").get()).toEqual({ n: 5 });
    expect(store.step(now)).toBe(false);
    expect(report("2026-09-01", "2026-09-05").coverage.pendingDates).toEqual([]);
  });
  it("跨日预约按日分摊，多日去重且整机不重复增加用户时长", () => {
    reservation("2026-09-01T23:00+08:00", "2026-09-02T01:00+08:00", "MACHINE");
    settle("2026-09-01"); settle("2026-09-02");
    const result = report("2026-09-01", "2026-09-02");
    expect(result.summary).toMatchObject({ reservationCount: 1, reservedMinutes: 240 });
    expect(result.users[0].reservedMinutes).toBe(120);
    expect(result.groups.map((g) => g.reservedMinutes)).toEqual([120, 120]);
    expect(report().users[0].reservedMinutes).toBe(60);
  });
  it("维护区间合并、按资源组存在时间扣除，不累计重复维护", () => {
    database.db.prepare("UPDATE resource_groups SET created_at=? WHERE id=?").run(iso("2026-09-01T12:00+08:00"), group2);
    maintenance("2026-09-01T10:00+08:00", "2026-09-01T13:00+08:00");
    maintenance("2026-09-01T12:00+08:00", "2026-09-01T14:00+08:00", group2);
    settle("2026-09-01");
    expect(report().groups.find((r) => r.resourceGroupId === group)!.availableMinutes).toBe(1260);
    expect(report().groups.find((r) => r.resourceGroupId === group2)!.availableMinutes).toBe(600);
  });
  it("取消记录不计入，汇总后舍入保留零碎时长", () => {
    const cancelled = reservation("2026-09-01T10:00+08:00", "2026-09-01T11:00+08:00");
    database.db.prepare("UPDATE reservations SET status='CANCELLED' WHERE id=?").run(cancelled);
    reservation("2026-09-01T23:59:40+08:00", "2026-09-02T00:00:20+08:00");
    settle("2026-09-01"); settle("2026-09-02");
    expect(report("2026-09-01", "2026-09-02").summary).toMatchObject({ reservationCount: 1, reservedMinutes: 1 });
  });
  it("日常不改历史，全量重算只在全部完成时切换", () => {
    const id = reservation("2026-09-01T10:00+08:00", "2026-09-01T11:00+08:00");
    finish(); const old = report();
    database.db.prepare("UPDATE reservations SET end_at=? WHERE id=?").run(iso("2026-09-01T12:00+08:00"), id);
    finish(); expect(report()).toEqual(old);
    const job = store.requestRebuild(admin, now);
    expect(store.requestRebuild(admin, now).id).toBe(job.id);
    store.step(now); expect(report()).toEqual(old);
    expect(store.job()).toMatchObject({ status: "RUNNING", completedDays: 1 });
    finish(); expect(store.job()).toMatchObject({ status: "SUCCEEDED", completedDays: 5 });
    expect(report().summary.reservedMinutes).toBe(120);
    expect(report().coverage.version).not.toBe(old.coverage.version);
    expect(database.db.prepare("SELECT action FROM audit_logs ORDER BY rowid").all()).toEqual([
      { action: "REPORT_REBUILD_REQUEST" }, { action: "REPORT_REBUILD_SUCCEEDED" }
    ]);
  });
  it("写入失败整天回滚，全量失败保留旧结果并允许重新发起", () => {
    finish(); const old = report(); const first = store.requestRebuild(admin, now);
    database.db.exec("CREATE TEMP TRIGGER fail_report BEFORE INSERT ON report_group_days BEGIN SELECT RAISE(ABORT,'test failure'); END");
    expect(() => store.step(now)).toThrow("test failure");
    expect(store.job()?.status).toBe("FAILED"); expect(report()).toEqual(old);
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM report_days WHERE version_id!=(SELECT active_version FROM report_state)").get()).toEqual({ n: 0 });
    database.db.exec("DROP TRIGGER fail_report");
    expect(store.requestRebuild(admin, now).id).not.toBe(first.id); finish(); expect(store.job()?.status).toBe("SUCCEEDED");
  });
  it("新的独立连接可以续跑已有进度而不重复结算", () => {
    const task = store.requestRebuild(admin, now); store.step(now);
    const connection = new Database(process.env.DATABASE_PATH!); connection.pragma("foreign_keys=ON");
    try {
      const resumed = new ReportStore(connection); resumed.initialize(now);
      expect(resumed.job()?.id).toBe(task.id); resumed.step(now);
      expect(resumed.job()?.completedDays).toBe(2);
    } finally { connection.close(); }
    finish(); expect(store.job()?.completedDays).toBe(5);
  });
  it("未结算日期有明确覆盖信息，CSV 拒绝不完整范围", async () => {
    settle("2026-09-01");
    const response = await app.inject({ url: "/api/v1/admin/report?fromDate=2026-09-01&toDate=2026-09-02", headers: { cookie: adminCookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().coverage.pendingDates).toEqual(["2026-09-02"]);
    expect((await app.inject({ url: "/api/v1/admin/report.csv?fromDate=2026-09-01&toDate=2026-09-02", headers: { cookie: adminCookie } })).statusCode).toBe(409);
    settle("2026-09-02");
    const csv = await app.inject({ url: "/api/v1/admin/report.csv?fromDate=2026-09-01&toDate=2026-09-02&locale=en", headers: { cookie: adminCookie } });
    expect(csv.statusCode).toBe(200); expect(csv.body).toContain('"Machine","Resource group"');
  });
  it("重算只允许系统管理员，普通用户和机器管理员均不能操作", async () => {
    database.db.prepare("INSERT INTO machine_admins(machine_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)").run(machine, user, admin, iso(created));
    for (const method of ["GET", "POST"] as const) {
      expect((await app.inject({ method, url: "/api/v1/admin/report/rebuild", headers: { cookie: userCookie }, ...(method === "POST" ? { payload: {} } : {}) })).statusCode).toBe(403);
    }
    const post = () => app.inject({ method: "POST", url: "/api/v1/admin/report/rebuild", headers: { cookie: adminCookie }, payload: {} });
    const first = await post(); expect(first.statusCode).toBe(202);
    expect((await post()).json().job.id).toBe(first.json().job.id);
  });
  it("查询使用当前权限，删除对象不泄露快照中的旧名称", async () => {
    reservation("2026-09-01T10:00+08:00", "2026-09-01T11:00+08:00"); settle("2026-09-01");
    const denied = await app.inject({ url: `/api/v1/admin/report?fromDate=2026-09-01&toDate=2026-09-01&machineId=${machine}`, headers: { cookie: userCookie } });
    expect(denied.json().groups).toEqual([]);
    database.db.prepare("INSERT INTO machine_access_memberships VALUES(?,?,?,'ADMIN_INVITE',?,?,?)").run(randomUUID(), machine, user, admin, iso(created), iso(created));
    const request = () => app.inject({ url: `/api/v1/admin/report?fromDate=2026-09-01&toDate=2026-09-01&machineId=${machine}`, headers: { cookie: userCookie } });
    expect((await request()).json().groups.length).toBeGreaterThan(0);
    database.db.prepare("DELETE FROM machine_access_memberships WHERE machine_id=? AND user_id=?").run(machine, user);
    expect((await request()).json().groups).toEqual([]);
    database.db.prepare("INSERT INTO deleted_resource_group_tombstones VALUES(?,?,?,?,?)").run(group, machine, iso("2026-09-03T00:00+08:00"), admin, "{}");
    database.db.prepare("INSERT INTO deleted_user_tombstones VALUES(?,?,?,?)").run(user, iso("2026-09-03T00:00+08:00"), admin, "{}");
    const result = report();
    expect(result.groups.find((r) => r.resourceGroupId === group)).toMatchObject({ groupName: "资源组已删除", resourceSummary: "资源已删除", reservedMinutes: 60 });
    expect(result.users[0]).toMatchObject({ displayName: "用户已删除", employeeNumber: null });
  });
  it("读取快照时不查询原始占用与维护记录", () => {
    finish();
    const original = database.db.prepare.bind(database.db), sql: string[] = [];
    const spy = vi.spyOn(database.db, "prepare").mockImplementation(((text: string) => { sql.push(text); return original(text); }) as typeof database.db.prepare);
    try { report(); } finally { spy.mockRestore(); }
    expect(sql.some((s) => /\b(?:FROM|JOIN)\s+(?:reservations|resource_unavailability)\b/i.test(s))).toBe(false);
  });
  it("全量切换失败不会发布新版本", () => {
    finish(); const old = report(); store.requestRebuild(admin, now);
    while (store.job()!.completedDays < store.job()!.totalDays) store.step(now);
    database.db.exec("CREATE TEMP TRIGGER fail_switch BEFORE UPDATE OF active_version ON report_state BEGIN SELECT RAISE(ABORT,'switch failure'); END");
    try { expect(() => store.step(now)).toThrow("switch failure"); }
    finally { database.db.exec("DROP TRIGGER fail_switch"); }
    expect(store.job()?.status).toBe("FAILED"); expect(report()).toEqual(old);
  });
  it("同一次查询在另一连接切换版本时仍读取完整旧版本", () => {
    const id = reservation("2026-09-01T10:00+08:00", "2026-09-01T11:00+08:00");
    finish(); const old = report();
    database.db.prepare("UPDATE reservations SET end_at=? WHERE id=?").run(iso("2026-09-01T12:00+08:00"), id);
    store.requestRebuild(admin, now);
    while (store.job()!.completedDays < store.job()!.totalDays) store.step(now);
    const connection = new Database(process.env.DATABASE_PATH!); connection.pragma("foreign_keys=ON");
    const peer = new ReportStore(connection);
    const prepare = database.db.prepare.bind(database.db); let switched = false;
    const spy = vi.spyOn(database.db, "prepare").mockImplementation(((sql: string) => {
      if (!switched && sql.includes("FROM report_group_days f")) { switched = true; peer.step(now); }
      return prepare(sql);
    }) as typeof database.db.prepare);
    try { expect(report()).toEqual(old); expect(switched).toBe(true); }
    finally { spy.mockRestore(); connection.close(); }
    expect(report().summary.reservedMinutes).toBe(120);
  });
  it("资源组不存在的时段不分配整机占用", () => {
    database.db.prepare("UPDATE resource_groups SET created_at=? WHERE id=?").run(iso("2026-09-01T12:00+08:00"), group2);
    reservation("2026-09-01T10:00+08:00", "2026-09-01T14:00+08:00", "MACHINE");
    settle("2026-09-01");
    expect(report().groups.find((r) => r.resourceGroupId === group2)?.reservedMinutes).toBe(120);
    expect(report().users[0].reservedMinutes).toBe(240);
  });
  it("重复日写入被拒绝，事务失败后重试仅生成一份数据", () => {
    const version = store.state()!.active_version;
    database.db.exec("CREATE TEMP TRIGGER fail_day BEFORE INSERT ON report_group_days BEGIN SELECT RAISE(ABORT,'day failure'); END");
    try { expect(() => store.settleDay(version, "2026-09-01")).toThrow("day failure"); }
    finally { database.db.exec("DROP TRIGGER fail_day"); }
    expect(report().coverage.pendingDates).toEqual(["2026-09-01"]);
    settle("2026-09-01"); settle("2026-09-01");
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM report_group_days").get()).toEqual({ n: 2 });
  });
  it("拒绝旧时间参数、非法日期和超过 366 天的范围", async () => {
    for (const query of ["from=2026-09-01T00:00:00Z&to=2026-09-02T00:00:00Z", "fromDate=2026-02-30&toDate=2026-03-01", "fromDate=2024-01-01&toDate=2026-01-01"]) {
      const response = await app.inject({ url: `/api/v1/admin/report?${query}`, headers: { cookie: adminCookie } });
      // Minimal Fastify harness does not install the production Zod error handler.
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
  });
  it("真正的 Worker 执行大量数据重算时主线程仍能服务请求", async () => {
    database.db.transaction(() => {
      for (let i = 0; i < 10_000; i++) reservation("2026-09-01T10:00+08:00", "2026-09-01T11:00+08:00");
    })();
    store.requestRebuild(admin, now);
    const error = vi.fn(); const stop = startReportScheduler(process.env.DATABASE_PATH!, { error });
    let requests = 0;
    try {
      for (let i = 0; i < 150 && store.job()?.status !== "SUCCEEDED"; i++) {
        const response = await app.inject({ url: "/api/v1/admin/report/rebuild", headers: { cookie: adminCookie } });
        expect(response.statusCode).toBe(200); requests++;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(error.mock.calls).toEqual([]);
      expect(store.job()?.status).toBe("SUCCEEDED"); expect(requests).toBeGreaterThan(0);
      expect(report().summary.reservationCount).toBe(10_000);
    } finally { await stop(); }
  }, 20_000);
});
