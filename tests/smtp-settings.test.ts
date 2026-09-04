import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-smtp-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "smtp.sqlite");
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "smtp-test-session-secret-at-least-32-characters";
process.env.SMTP_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");

let app: ReturnType<typeof Fastify>;
let database: typeof import("../server/db.js");
let adminCookie = "";

beforeAll(async () => {
  database = await import("../server/db.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerAdminRoutes } = await import("../server/routes-admin.js");
  await database.initializeDatabase();
  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  registerAuthRoutes(app);
  registerAdminRoutes(app, () => undefined);
  await app.ready();
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      identifierType: "USERNAME",
      identifier: "Administrator",
      password: "Admin12#$"
    }
  });
  expect(login.statusCode).toBe(200);
  adminCookie = login.cookies
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
});

describe("系统管理员 SMTP 配置", () => {
  it("把 SMTP 原始错误归类为安全的中文提示", async () => {
    const { classifySmtpError } = await import("../server/mailer.js");
    expect(classifySmtpError({ code: "EAUTH" })).toContain("登录失败");
    expect(
      classifySmtpError({
        code: "ESOCKET",
        message: "self-signed certificate"
      })
    ).toContain("证书验证失败");
    expect(classifySmtpError({ code: "ETIMEDOUT" })).toContain("无法连接");
    expect(classifySmtpError({ command: "MAIL FROM" })).toContain("发件人");
    expect(classifySmtpError({ command: "RCPT TO" })).toContain("测试收件地址");
  });

  it("初始状态停用且接口不返回密码", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: adminCookie }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      enabled: false,
      hasPassword: false,
      passwordStatus: "NOT_SET",
      operational: false,
      version: 1
    });
    expect(response.body).not.toContain("password_encrypted");
  });

  it("加密保存密码并立即启用配置", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        host: "127.0.0.1",
        port: 1,
        security: "STARTTLS",
        username: "noreply@company.test",
        password: "mailbox-secret-password",
        clearPassword: false,
        fromName: "Allocube",
        fromAddress: "noreply@company.test",
        expectedVersion: 1
      }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings).toMatchObject({
      enabled: true,
      hasPassword: true,
      passwordStatus: "READY",
      operational: true,
      version: 2
    });
    expect(response.body).not.toContain("mailbox-secret-password");
    const stored = database.db
      .prepare("SELECT password_encrypted FROM smtp_settings WHERE id = 1")
      .get() as { password_encrypted: string };
    expect(stored.password_encrypted).not.toContain("mailbox-secret-password");
    expect(stored.password_encrypted.startsWith("v2.")).toBe(true);
    const audit = database.db
      .prepare(
        "SELECT before_json, after_json FROM audit_logs WHERE action = 'SMTP_SETTINGS_ENABLE'"
      )
      .get() as { before_json: string; after_json: string };
    expect(JSON.stringify(audit)).not.toContain("mailbox-secret-password");
    expect(JSON.stringify(audit)).not.toContain(stored.password_encrypted);
  });

  it("拒绝旧版本覆盖并将测试错误分类回显", async () => {
    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        host: "smtp.company.test",
        port: 994,
        security: "IMPLICIT_TLS",
        username: "noreply@company.test",
        fromName: "Allocube",
        fromAddress: "noreply@company.test",
        expectedVersion: 1
      }
    });
    expect(stale.statusCode).toBe(409);

    const test = await app.inject({
      method: "POST",
      url: "/api/v1/admin/smtp-settings/test",
      headers: { cookie: adminCookie },
      payload: { recipient: "recipient@example.com" }
    });
    expect(test.statusCode).toBe(502);
    expect(test.json()).toMatchObject({
      code: "SMTP_TEST_FAILED"
    });
    expect(test.json().error).not.toContain("127.0.0.1");
  });

  it("停用时取消未发送邮件且拒绝继续入队", async () => {
    const { queueEmail } = await import("../server/mailer.js");
    expect(
      queueEmail(
        "recipient@example.com",
        "等待发送",
        "<p>等待发送</p>"
      )
    ).toBe(true);
    const disable = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: adminCookie },
      payload: {
        enabled: false,
        host: "127.0.0.1",
        port: 1,
        security: "STARTTLS",
        username: "noreply@company.test",
        fromName: "Allocube",
        fromAddress: "noreply@company.test",
        expectedVersion: 2
      }
    });
    expect(disable.statusCode).toBe(200);
    const cancelled = database.db
      .prepare(
        "SELECT COUNT(*) AS count FROM email_outbox WHERE status = 'CANCELLED'"
      )
      .get() as { count: number };
    expect(cancelled.count).toBeGreaterThan(0);
    expect(
      queueEmail(
        "recipient@example.com",
        "不应入队",
        "<p>不应入队</p>"
      )
    ).toBe(false);
  });

  it("邮件关闭时拒绝验证码并允许无邮箱注册", async () => {
    const before = database.db
      .prepare("SELECT COUNT(*) AS count FROM email_verification_challenges")
      .get() as { count: number };
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/registration-email-code",
      payload: { email: "disabled@example.com" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "邮件功能当前未启用",
      code: "EMAIL_FEATURE_DISABLED"
    });
    const after = database.db
      .prepare("SELECT COUNT(*) AS count FROM email_verification_challenges")
      .get() as { count: number };
    expect(after.count).toBe(before.count);

    const config = await app.inject({
      method: "GET",
      url: "/api/v1/auth/registration-config"
    });
    expect(config.json()).toMatchObject({
      emailEnabled: false,
      allowRegistrationWithoutEmail: true,
      allowedEmailDomains: []
    });
    const registration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "无邮箱用户",
        realName: "无邮箱成员",
        employeeNumber: "10002001",
        email: null,
        challengeId: null,
        code: null,
        password: "NoEmailUser123!",
        expectedConfigRevision: config.json().revision
      }
    });
    expect(registration.statusCode).toBe(201);
    expect(
      database.db
        .prepare("SELECT email FROM users WHERE id = ?")
        .get(registration.json().userId)
    ).toEqual({ email: null });
  });

  it("普通用户不能读取或修改 SMTP 配置", async () => {
    const { hashPassword } = await import("../server/auth.js");
    const userId = randomUUID();
    const now = database.nowIso();
    database.db
      .prepare(
        `INSERT INTO users(
          id, username, username_normalized, email, display_name, password_hash,
          role, status, approved_at, created_at, updated_at
        ) VALUES(?, '普通用户', '普通用户', 'smtp-user@example.com', '普通用户', ?,
          'USER', 'ACTIVE', ?, ?, ?)`
      )
      .run(userId, await hashPassword("NormalUser123!"), now, now, now);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "USERNAME",
        identifier: "普通用户",
        password: "NormalUser123!"
      }
    });
    const cookieValue = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const registrationConfig = await app.inject({
      method: "GET",
      url: "/api/v1/auth/registration-config"
    });
    const clearWithoutConfirmation = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: cookieValue },
      payload: {
        email: null,
        currentPassword: "NormalUser123!",
        expectedConfigRevision: registrationConfig.json().revision
      }
    });
    expect(clearWithoutConfirmation.statusCode).toBe(400);
    expect(clearWithoutConfirmation.json().code).toBe(
      "EMAIL_CLEAR_CONFIRMATION_REQUIRED"
    );
    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: cookieValue },
      payload: {
        email: null,
        currentPassword: "NormalUser123!",
        clearEmailConfirmed: true,
        expectedConfigRevision: registrationConfig.json().revision
      }
    });
    expect(cleared.statusCode).toBe(200);
    expect(
      database.db.prepare("SELECT email FROM users WHERE id = ?").get(userId)
    ).toEqual({ email: null });
    const getResponse = await app.inject({
      method: "GET",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: cookieValue }
    });
    expect(getResponse.statusCode).toBe(403);
    const patchResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: cookieValue },
      payload: {
        enabled: false,
        host: "",
        port: 465,
        security: "IMPLICIT_TLS",
        username: "",
        fromName: "",
        fromAddress: "",
        expectedVersion: 3
      }
    });
    expect(patchResponse.statusCode).toBe(403);
  });

  it("过期的验证码类邮件不会投递", async () => {
    const enable = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/smtp-settings",
      headers: { cookie: adminCookie },
      payload: {
        enabled: true,
        host: "127.0.0.1",
        port: 1,
        security: "STARTTLS",
        username: "noreply@company.test",
        fromName: "Allocube",
        fromAddress: "noreply@company.test",
        expectedVersion: 3
      }
    });
    expect(enable.statusCode).toBe(200);
    const { processEmailOutbox, queueEmail } = await import("../server/mailer.js");
    expect(
      queueEmail(
        "recipient@example.com",
        "已经过期",
        "<p>已经过期</p>",
        null,
        new Date(Date.now() - 1000).toISOString()
      )
    ).toBe(true);
    await processEmailOutbox();
    const expired = database.db
      .prepare(
        "SELECT status, to_email AS toEmail, html FROM email_outbox WHERE subject = '已经过期' ORDER BY created_at DESC LIMIT 1"
      )
      .get() as { status: string; toEmail: string; html: string };
    expect(expired.status).toBe("EXPIRED");
    expect(expired.toEmail).toBe("[redacted]");
    expect(expired.html).toBe("[redacted]");
  });
});
