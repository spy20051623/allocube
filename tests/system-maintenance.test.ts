import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAdminFixture } from "./helpers/admin-fixture";
import { normalizeSystemMaintenanceText } from "../src/shared/system-maintenance";

const fixture = createAdminFixture("system-maintenance");
let context: Awaited<ReturnType<typeof fixture.start>>;
let userCookie: string;
let announcementEvents = 0;
beforeAll(async () => {
  context = await fixture.start(async app => {
    (await import("../server/announcements")).registerAnnouncementRoutes(app, () => { announcementEvents++; });
  });
  const { db, nowIso } = context.database, now = nowIso();
  db.prepare(`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at)
    SELECT ?,'maintenance-user','maintenance-user','Member',password_hash,'USER','ACTIVE',?,? FROM users WHERE role='SYSTEM_ADMIN' LIMIT 1`)
    .run(randomUUID(), now, now);
  const login = await context.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
    identifierType: "USERNAME", identifier: "maintenance-user", password: "SettingsConflict82!"
  } });
  expect(login.statusCode).toBe(200);
  userCookie = login.cookies.map(item => `${item.name}=${item.value}`).join("; ");
  expect(login.json().maintenanceNotice).toEqual({ text: "", version: 1 });
});
afterAll(() => fixture.close());
const read = () => context.app.inject({ method: "GET", url: "/api/v1/admin/system-maintenance", headers: { cookie: context.adminCookie } });
const write = (text: unknown, expectedVersion: number, cookie = context.adminCookie, overwrite = false) => context.app.inject({
  method: "PUT", url: "/api/v1/admin/system-maintenance", headers: { cookie, ...(overwrite ? { "x-allocube-overwrite": "true" } : {}) }, payload: { text, expectedVersion }
});

it("normalizes a single line and treats whitespace as an empty notice", () => {
  expect(normalizeSystemMaintenanceText(" \t系统\r\n升级\u2028稍后恢复 ")).toBe("系统 升级 稍后恢复");
  expect(normalizeSystemMaintenanceText("\n \t")).toBe("");
});

it("starts empty and only system administrators can edit or read management data", async () => {
  expect((await read()).json()).toEqual({ text: "", version: 1 });
  expect((await write("not allowed", 1, userCookie, true)).statusCode).toBe(403);
  expect((await context.app.inject({ method: "GET", url: "/api/v1/admin/system-maintenance", headers: { cookie: userCookie } })).statusCode).toBe(403);
  expect((await context.app.inject({ method: "GET", url: "/api/v1/admin/system-maintenance" })).statusCode).toBe(401);
});

it("publishes plain text through the session without announcements, mail or schedule changes", async () => {
  const { db, getScheduleRevision } = context.database;
  const revision = getScheduleRevision();
  const counts = () => ["announcements", "notifications", "email_outbox"].map(table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get());
  const before = counts();
  const result = await write("  <b>维护</b>\r\n**升级**  ", 1);
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json()).toEqual({ text: "<b>维护</b> **升级**", version: 2 });
  const session = await context.app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: userCookie } });
  expect(session.json().maintenanceNotice).toEqual(result.json());
  expect(counts()).toEqual(before);
  expect(getScheduleRevision()).toBe(revision);
  expect(announcementEvents).toBe(0);
  const audit = db.prepare("SELECT before_json,after_json FROM audit_logs WHERE action='SYSTEM_MAINTENANCE_UPDATE'").all();
  expect(audit).toEqual([{ before_json: JSON.stringify({ maintenanceText: "" }), after_json: JSON.stringify({ maintenanceText: result.json().text }) }]);
});

it("enforces 120 characters and versions; clearing removes the notice", async () => {
  const version = (await read()).json().version;
  for (const invalid of ["字".repeat(121), null, 120]) expect((await write(invalid, version)).statusCode).toBe(400);
  expect((await write("字".repeat(120), version)).statusCode).toBe(200);
  expect((await write("stale", version)).statusCode).toBe(409);
  expect((await read()).json().text).toBe("字".repeat(120));
  expect((await write(" \n ", version, context.adminCookie, true)).json()).toEqual({ text: "", version: version + 2 });
});

it("rolls back the stored text and version when audit insertion fails", async () => {
  const before = (await read()).json(), { db } = context.database;
  db.exec("CREATE TEMP TRIGGER fail_maintenance_audit BEFORE INSERT ON audit_logs WHEN NEW.action='SYSTEM_MAINTENANCE_UPDATE' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  try {
    expect((await write("must roll back", before.version)).statusCode).toBe(500);
    expect((await read()).json()).toEqual(before);
  } finally { db.exec("DROP TRIGGER fail_maintenance_audit"); }
});
