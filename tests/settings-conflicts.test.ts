import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-settings-conflicts-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "settings.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "SettingsConflict82!";
process.env.SESSION_SECRET = "settings-conflicts-test-secret-at-least-32-characters";
let app: ReturnType<typeof Fastify>;
let database: typeof import("../server/db.js");
let adminCookie: string;

beforeAll(async () => {
  database = await import("../server/db.js");
  await database.initializeDatabase();
  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET });
  (await import("../server/routes-auth.js")).registerAuthRoutes(app);
  (await import("../server/routes-schedule.js")).registerScheduleRoutes(app, () => undefined);
  (await import("../server/routes-admin.js")).registerAdminRoutes(app, () => undefined);
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: {
    identifierType: "USERNAME", identifier: "Administrator", password: "SettingsConflict82!"
  } });
  expect(login.statusCode).toBe(200);
  adminCookie = login.cookies.map(item => `${item.name}=${item.value}`).join("; ");
});
afterAll(async () => { await app?.close(); database?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

const cases = [
  ["/settings", { minBookingMinutes: 3, maxBookingMinutes: 600, advanceDays: 20 }],
  ["/settings/site-profile", { siteOrigin: "https://settings.allocube.test", icpFilingNumber: "", publicSecurityFilingNumber: "" }],
  ["/settings/email-domains", { allowedEmailDomains: ["allocube.test"] }],
  ["/settings/registration-email", { allowRegistrationWithoutEmail: true }],
  ["/settings/site-origin", { siteOrigin: "https://origin.allocube.test" }],
  ["/settings/icp-filing", { icpFilingNumber: "" }],
  ["/settings/public-security-filing", { publicSecurityFilingNumber: "" }],
  ["/smtp-settings", { enabled: false, host: "smtp.allocube.test", port: 465, security: "IMPLICIT_TLS", username: "mail", fromName: "Allocube", fromAddress: "mail@allocube.test", password: "SettingsMailSecret82!" }]
] as const;

describe("系统设置显式覆盖", () => {
  it.each(cases)("%s 只有显式覆盖才接受过期版本，保留事务及审计", async (endpoint, values) => {
    const smtp = endpoint === "/smtp-settings";
    const read = async () => (await app.inject({ url: `/api/v1/admin/${smtp ? "smtp-settings" : "settings"}`, headers: { cookie: adminCookie } })).json();
    const original = await read();
    const patch = (payload: object) => app.inject({ method: "PATCH", url: `/api/v1/admin${endpoint}`, headers: { cookie: adminCookie }, payload });
    const payload = { ...values, expectedVersion: original.version };
    const saved = await patch(payload);
    expect(saved.statusCode, saved.body).toBe(200);
    const before = await read();
    const auditCount = () => (database.db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get() as { count: number }).count;
    const count = auditCount();
    for (const overwrite of [undefined, false]) {
      expect((await patch({ ...payload, overwrite })).statusCode).toBe(409);
      expect(await read()).toEqual(before);
      expect(auditCount()).toBe(count);
    }
    const overwritten = await patch({ ...payload, overwrite: true });
    expect(overwritten.statusCode, overwritten.body).toBe(200);
    expect(overwritten.json().settings.version).toBe(before.version + 1);
    expect(auditCount()).toBe(count + 1);
    if (smtp) expect(overwritten.body).not.toContain("SettingsMailSecret82!");
    else {
      // Overwriting one section must not reset other settings.
      for (const key of ["siteOrigin", "minBookingMinutes", "allowedEmailDomains", "allowRegistrationWithoutEmail"]) {
        if (!(key in values)) expect(overwritten.json().settings[key]).toEqual(before[key]);
      }
    }
    expect((await app.inject({ method: "PATCH", url: `/api/v1/admin${endpoint}`, payload: { ...payload, overwrite: true } })).statusCode).toBe(401);
  });

  it("显式覆盖仍校验字段并完整回滚", async () => {
    const before = database.getAdminSettings();
    const response = await app.inject({ method: "PATCH", url: "/api/v1/admin/settings", headers: { cookie: adminCookie }, payload: {
      minBookingMinutes: 120, maxBookingMinutes: 60, advanceDays: 20, expectedVersion: 1, overwrite: true
    } });
    expect(response.statusCode).toBe(400);
    expect(database.getAdminSettings()).toEqual(before);
  });
});
