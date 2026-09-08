import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAdminFixture } from "./helpers/admin-fixture";
import { normalizeMachineAnnouncement } from "../src/shared/machine-announcement";

const fixture = createAdminFixture("machine-announcement");
let context: Awaited<ReturnType<typeof fixture.start>>;
const cookies: Record<string, string> = {};
const users: Record<string, string> = {};
beforeAll(async () => {
  context = await fixture.start();
  cookies.admin = context.adminCookie;
  const db = context.database.db, now = context.database.nowIso();
  users.admin = (db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as { id: string }).id;
  for (const name of ["manager", "member", "stranger"]) {
    users[name] = randomUUID();
    db.prepare(`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at)
      SELECT ?,?,?,?,password_hash,'USER','ACTIVE',?,? FROM users WHERE id=?`).run(users[name], name, name, name, now, now, users.admin);
    const response = await context.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifierType: "USERNAME", identifier: name, password: "SettingsConflict82!" } });
    expect(response.statusCode).toBe(200);
    cookies[name] = response.cookies.map(item => `${item.name}=${item.value}`).join("; ");
  }
});
afterAll(() => fixture.close());
function machine() {
  const { db, nowIso } = context.database, id = randomUUID(), now = nowIso();
  db.prepare("INSERT INTO machines(id,name,connection_guide,created_at,updated_at) VALUES(?,?,'retained',?,?)").run(id, id, now, now);
  for (const role of ["manager", "member"]) db.prepare("INSERT INTO machine_access_memberships VALUES(?,?,?,'SEED',?,?,?)").run(randomUUID(), id, users[role], users.admin, now, now);
  db.prepare("INSERT INTO machine_admins VALUES(?,?,?,?)").run(id, users.manager, users.admin, now);
  return id;
}
const put = (id: string, announcement: unknown, expectedVersion = 1, actor = "manager", overwrite = false) => context.app.inject({
  method: "PUT", url: `/api/v1/admin/machines/${id}/announcement`, headers: { cookie: cookies[actor], ...(overwrite ? { "x-allocube-overwrite": "true" } : {}) }, payload: { announcement, expectedVersion }
});
const getMachine = (id: string, actor = "manager") => context.app.inject({ method: "GET", url: `/api/v1/admin/machines/${id}`, headers: { cookie: cookies[actor] } });

it("共享规范化保留纯文本和分段，统一换行符", () => {
  expect(normalizeMachineAnnouncement(" \tA\r\nB\u2028C\u2029D  ")).toBe("A\nB\nC\nD");
  expect(normalizeMachineAnnouncement("A\r\n\r\nB\rC")).toBe("A\n\nB\nC");
  expect(normalizeMachineAnnouncement(" \r\n \t")).toBe("");
  expect(normalizeMachineAnnouncement("<script>alert(1)</script> **文字**")).toBe("<script>alert(1)</script> **文字**");
});

it("管理员独立更新公告，每次仅产生一条审计和一次修订，不创建通知", async () => {
  const id = machine(), { db, getScheduleRevision } = context.database;
  const revision = getScheduleRevision();
  const notifications = db.prepare("SELECT COUNT(*) AS n FROM notifications").get();
  const emails = db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get();
  const response = await put(id, "  第一行\r\n第二行  ");
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toEqual({ announcement: "第一行\n第二行", version: 2, revision: revision + 1 });
  expect((await getMachine(id, "member")).json().machine.announcement).toBe("第一行\n第二行");
  expect(db.prepare("SELECT connection_guide FROM machines WHERE id=?").get(id)).toEqual({ connection_guide: "retained" });
  expect(db.prepare("SELECT before_json,after_json FROM audit_logs WHERE entity_id=? AND action='MACHINE_ANNOUNCEMENT_UPDATE'").all(id))
    .toEqual([{ before_json: '{"announcement":""}', after_json: JSON.stringify({ announcement: "第一行\n第二行" }) }]);
  expect(db.prepare("SELECT COUNT(*) AS n FROM notifications").get()).toEqual(notifications);
  expect(db.prepare("SELECT COUNT(*) AS n FROM email_outbox").get()).toEqual(emails);
  const timeline = await context.app.inject({ method: "GET", url: "/api/v1/timeline?from=2026-09-09T00:00:00Z&to=2026-09-10T00:00:00Z", headers: { cookie: cookies.member } });
  expect(timeline.json().machines.find((item: { id: string }) => item.id === id).announcement).toBe("第一行\n第二行");
  expect((await put(id, " \n ", 2, "admin")).json().announcement).toBe("");
});

it("拒绝普通成员、其他机器管理员及撤销管理权限后的写入", async () => {
  const id = machine();
  const otherId = machine();
  context.database.db.prepare("INSERT INTO machine_admins VALUES(?,?,?,?)").run(otherId, users.stranger, users.admin, context.database.nowIso());
  for (const actor of ["member", "stranger"]) expect((await put(id, "forbidden", 1, actor, true)).statusCode).toBe(403);
  expect((await getMachine(id, "stranger")).statusCode).toBe(403);
  context.database.db.prepare("DELETE FROM machine_admins WHERE machine_id=?").run(id);
  expect((await put(id, "forbidden", 1, "manager", true)).statusCode).toBe(403);
  expect((await getMachine(id)).json().machine.announcement).toBe("");
});

it("版本冲突不写入，确认覆盖只更新公告，普通机器编辑保留公告", async () => {
  const id = machine();
  expect((await put(id, "remote")).statusCode).toBe(200);
  const revision = context.database.getScheduleRevision();
  const stale = await put(id, "local");
  expect(stale.statusCode).toBe(409); expect(stale.json().code).toBe("MACHINE_SETTINGS_STALE");
  expect(context.database.getScheduleRevision()).toBe(revision);
  expect((await put(id, "local", 1, "manager", true)).json().version).toBe(3);
  const updated = await context.app.inject({ method: "PATCH", url: `/api/v1/admin/machines/${id}`, headers: { cookie: cookies.manager }, payload: { name: id + " changed", expectedVersion: 3 } });
  expect(updated.statusCode).toBe(200);
  expect((await getMachine(id)).json().machine.announcement).toBe("local");
});

it("服务端限制长度和类型，失败时不写入", async () => {
  const id = machine();
  for (const text of ["x".repeat(2001), null, 123]) expect((await put(id, text)).statusCode).toBe(400);
  expect((await put(id, "x".repeat(2000))).statusCode).toBe(200);
});

it("审计写入失败时公告、版本和修订一并回滚", async () => {
  const id = machine(), { db, getScheduleRevision } = context.database, revision = getScheduleRevision();
  db.exec("CREATE TEMP TRIGGER fail_announcement_audit BEFORE INSERT ON audit_logs WHEN NEW.action='MACHINE_ANNOUNCEMENT_UPDATE' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  try {
    expect((await put(id, "must roll back")).statusCode).toBe(500);
    expect(db.prepare("SELECT announcement,version FROM machines WHERE id=?").get(id)).toEqual({ announcement: "", version: 1 });
    expect(getScheduleRevision()).toBe(revision);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity_id=?").get(id)).toEqual({ n: 0 });
  } finally { db.exec("DROP TRIGGER fail_announcement_audit"); }
});
