import { createAdminFixture } from "./helpers/admin-fixture";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixture = createAdminFixture("settings-conflicts");
let app: ReturnType<typeof Fastify>;
let database: typeof import("../server/db.js");
let adminCookie: string;

beforeAll(async () => {
  ({ app, database, adminCookie } = await fixture.start());
});

afterAll(() => fixture.close());

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

  it("审计失败时同时回滚设置值、版本和注册配置修订", async () => {
    const before = database.getAdminSettings();
    const revision = database.getRegistrationConfigRevision();
    database.db.exec(`CREATE TEMP TRIGGER reject_settings_audit
      BEFORE INSERT ON audit_logs WHEN NEW.action = 'REGISTRATION_EMAIL_POLICY_UPDATE'
      BEGIN SELECT RAISE(ABORT, 'test audit failure'); END`);
    try {
      const response = await app.inject({
        method: "PATCH", url: "/api/v1/admin/settings/registration-email",
        headers: { cookie: adminCookie },
        payload: { allowRegistrationWithoutEmail: !before.allowRegistrationWithoutEmail, expectedVersion: before.version }
      });
      expect(response.statusCode).toBe(500);
      expect(database.getAdminSettings()).toEqual(before);
      expect(database.getRegistrationConfigRevision()).toBe(revision);
    } finally {
      database.db.exec("DROP TRIGGER reject_settings_audit");
    }
  });
});
