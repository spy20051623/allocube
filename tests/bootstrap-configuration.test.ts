import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "resource-bootstrap-")
);
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "bootstrap.sqlite");
process.env.BOOTSTRAP_ADMIN_NAME = "首次管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.BOOTSTRAP_SITE_ORIGIN = "https://allocube.company.test";
process.env.BOOTSTRAP_ALLOWED_EMAIL_DOMAINS = "company.test,example.test";
process.env.BOOTSTRAP_ADVANCE_DAYS = "60";
process.env.BOOTSTRAP_SMTP_ENABLED = "true";
process.env.BOOTSTRAP_SMTP_HOST = "smtp.company.test";
process.env.BOOTSTRAP_SMTP_PORT = "994";
process.env.BOOTSTRAP_SMTP_SECURITY = "IMPLICIT_TLS";
process.env.BOOTSTRAP_SMTP_USERNAME = "noreply@company.test";
process.env.BOOTSTRAP_SMTP_PASSWORD = "smtp-bootstrap-password";
process.env.BOOTSTRAP_SMTP_FROM_NAME = "Allocube";
process.env.BOOTSTRAP_SMTP_FROM_ADDRESS = "noreply@company.test";

let dbModule: typeof import("../server/db.js");
let configModule: typeof import("../server/config.js");
let smtpModule: typeof import("../server/smtp-settings.js");

beforeAll(async () => {
  configModule = await import("../server/config.js");
  dbModule = await import("../server/db.js");
  smtpModule = await import("../server/smtp-settings.js");
  await dbModule.initializeDatabase();
});

describe("首次启动配置", () => {
  it("将引导配置一次性写入持久配置", () => {
    expect(dbModule.getAdminSettings()).not.toHaveProperty("minBookingMinutes");
    expect(dbModule.getAdminSettings()).not.toHaveProperty("maxBookingMinutes");
    expect(dbModule.db.prepare("SELECT key FROM settings WHERE key IN ('min_booking_minutes','max_booking_minutes')").all()).toEqual([]);
    expect(dbModule.getAdminSettings()).toMatchObject({
      advanceDays: 60,
      siteOrigin: "https://allocube.company.test",
      allowedEmailDomains: ["company.test", "example.test"],
      allowRegistrationWithoutEmail: true
    });
    expect(smtpModule.getSavedSmtpSettings()).toMatchObject({
      host: "smtp.company.test",
      port: 994,
      security: "IMPLICIT_TLS",
      username: "noreply@company.test",
      password: "smtp-bootstrap-password",
      fromAddress: "noreply@company.test"
    });
    expect(
      dbModule.db
        .prepare(
          "SELECT value FROM app_meta WHERE key = 'persistent_configuration_initialized'"
        )
        .get()
    ).toBeTruthy();
  });

  it("空库只创建初始管理员，不生成业务示例数据", () => {
    expect(
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM users").get()
    ).toEqual({ count: 1 });
    expect(
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM machines").get()
    ).toEqual({ count: 0 });
    expect(
      dbModule.db.prepare("SELECT COUNT(*) AS count FROM reservations").get()
    ).toEqual({ count: 0 });
  });

  it("生成独立实例密钥文件且不把明文 SMTP 密码写入数据库", () => {
    expect(fs.existsSync(configModule.config.instanceSecretsPath)).toBe(
      true
    );
    const secrets = JSON.parse(
      fs.readFileSync(configModule.config.instanceSecretsPath, "utf8")
    ) as Record<string, unknown>;
    expect(secrets).toMatchObject({ version: 1 });
    expect(String(secrets.sessionSecret).length).toBeGreaterThanOrEqual(32);
    expect(
      Buffer.from(
        String(secrets.smtpSettingsEncryptionKey),
        "base64"
      ).length
    ).toBe(32);
    const stored = dbModule.db
      .prepare(
        "SELECT password_encrypted AS password FROM smtp_settings WHERE id = 1"
      )
      .get() as { password: string };
    expect(stored.password).not.toContain("smtp-bootstrap-password");
  });

  it.each([366, 3650, 3651, 1e100])("首次配置的最远天数 %s 自动封顶", (days) => {
    const previous = process.env.BOOTSTRAP_ADVANCE_DAYS;
    try {
      process.env.BOOTSTRAP_ADVANCE_DAYS = String(days);
      expect(configModule.getBootstrapConfig().advanceDays).toBe(Math.min(days, 3650));
    } finally {
      process.env.BOOTSTRAP_ADVANCE_DAYS = previous;
    }
  });

  it("初始化完成后再次启动不会重新采用引导配置", async () => {
    dbModule.db
      .prepare(
        "UPDATE settings SET value = '17' WHERE key = 'advance_days'"
      )
      .run();
    process.env.BOOTSTRAP_ADVANCE_DAYS = "不是数字";
    process.env.BOOTSTRAP_SITE_ORIGIN = "https://ignored.company.test";
    process.env.BOOTSTRAP_SMTP_SECURITY = "INVALID";
    await dbModule.initializeDatabase();
    expect(dbModule.getAdminSettings()).toMatchObject({
      advanceDays: 17,
      siteOrigin: "https://allocube.company.test"
    });
  });
});
