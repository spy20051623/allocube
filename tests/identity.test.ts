import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-identity-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "identity.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "identity-test-session-secret-at-least-32-characters";

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import("../server/db.js");

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerScheduleRoutes } = await import("../server/routes-schedule.js");
  const { registerAdminRoutes } = await import("../server/routes-admin.js");
  const { encryptSmtpPassword } = await import("../server/smtp-settings.js");
  await dbModule.initializeDatabase();
  dbModule.db
    .prepare(
      `UPDATE smtp_settings SET
         enabled = 1, host = 'smtp.test.local', port = 465,
         security = 'IMPLICIT_TLS', username = 'noreply@test.local',
         password_encrypted = ?, from_name = '测试 Allocube',
         from_address = 'noreply@test.local', version = version + 1
       WHERE id = 1`
    )
    .run(encryptSmtpPassword("smtp-test-password"));
  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  registerAuthRoutes(app);
  registerScheduleRoutes(app, () => undefined);
  registerAdminRoutes(app, () => undefined);
  await app.ready();
});

async function requestCode(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/registration-email-code",
    payload: { email }
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).not.toHaveProperty("developmentCode");
  const queued = dbModule.db
    .prepare(
      `SELECT html FROM email_outbox
       WHERE to_email = ? AND subject = 'Allocube 注册验证码'
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(email) as { html: string };
  const code = queued.html.match(/letter-spacing:6px">(\d{6})</)?.[1];
  expect(code).toMatch(/^\d{6}$/);
  return {
    ...(response.json() as { challengeId: string }),
    code: code!
  };
}

async function registrationConfig() {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/auth/registration-config"
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    emailEnabled: boolean;
    allowRegistrationWithoutEmail: boolean;
    allowedEmailDomains: string[];
    revision: number;
  };
}

async function registerPending(input: {
  username: string;
  realName: string;
  employeeNumber: string;
  email: string;
}) {
  const challenge = await requestCode(input.email);
  const config = await registrationConfig();
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      ...input,
      password: "Registration123!",
      challengeId: challenge.challengeId,
      code: challenge.code,
      expectedConfigRevision: config.revision
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { userId: string };
}

async function loginCookie(identifier: string, password = "Registration123!") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifierType: "USERNAME", identifier, password }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}

async function previewAndDisableUser(
  adminCookie: string,
  userId: string,
  reason = ""
) {
  const preview = await app.inject({
    method: "POST",
    url: `/api/v1/admin/users/${userId}/disable/preview`,
    headers: { cookie: adminCookie },
    payload: {}
  });
  expect(preview.statusCode).toBe(200);
  const disabled = await app.inject({
    method: "POST",
    url: `/api/v1/admin/users/${userId}/disable`,
    headers: { cookie: adminCookie },
    payload: {
      expectedVersion: preview.json().user.version,
      expectedRevision: preview.json().revision,
      reason
    }
  });
  return { preview, disabled };
}

describe("用户身份与审批生命周期", () => {
  it("支持中文用户名规范化", async () => {
    const { normalizeUsername } = await import("../server/identity.js");
    expect(normalizeUsername("审批测试").normalized).toBe("审批测试");
    expect(normalizeUsername("Ａlice").normalized).toBe("alice");
  });

  it("公开注册配置返回邮件开关、邮箱域名白名单和版本", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/auth/registration-config"
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      emailEnabled: true,
      allowRegistrationWithoutEmail: true,
      allowedEmailDomains: [],
      revision: 1
    });
  });

  it("邮件开启时允许确认后不填写邮箱注册", async () => {
    const config = await registrationConfig();
    const payload = {
      username: "可选邮箱用户",
      realName: "可选邮箱成员",
      employeeNumber: "10001999",
      email: null,
      challengeId: null,
      code: null,
      password: "OptionalEmail123!",
      expectedConfigRevision: config.revision
    };
    const unconfirmed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload
    });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.json().code).toBe(
      "EMAIL_OMISSION_CONFIRMATION_REQUIRED"
    );

    const confirmed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { ...payload, withoutEmailConfirmed: true }
    });
    expect(confirmed.statusCode).toBe(201);
    expect(
      dbModule.db
        .prepare("SELECT email FROM registration_revisions WHERE user_id = ?")
        .get(confirmed.json().userId)
    ).toEqual({ email: null });

    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${confirmed.json().userId}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedRevision: 1 }
    });
    expect(approved.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare("SELECT status, email FROM users WHERE id = ?")
        .get(confirmed.json().userId)
    ).toEqual({ status: "ACTIVE", email: null });
    expect(
      dbModule.db
        .prepare("SELECT employee_number FROM employee_numbers WHERE user_id = ?")
        .get(confirmed.json().userId)
    ).toEqual({ employee_number: "10001999" });
  });

  it("登录和会话恢复均返回服务器时间", async () => {
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
    expect(Number.isFinite(new Date(login.json().serverNow).getTime())).toBe(true);
    expect(login.json()).toHaveProperty("settings");
    expect(login.json()).toHaveProperty("managedMachineIds");

    const cookieHeader = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: cookieHeader }
    });
    expect(session.statusCode).toBe(200);
    expect(Number.isFinite(new Date(session.json().serverNow).getTime())).toBe(true);
  });

  it("系统管理员可以在线修改注册邮箱白名单并立即生效", async () => {
    const existingChallenge = await requestCode("before-policy@blocked.test");
    const initialRegistrationConfig = await registrationConfig();
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/admin/settings",
      headers: { cookie: adminCookie }
    });
    expect(before.statusCode).toBe(200);
    const initialVersion = before.json().version as number;

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/email-domains",
      headers: { cookie: adminCookie },
      payload: {
        allowedEmailDomains: [" Example.COM ", "example.com"],
        expectedVersion: initialVersion
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings.allowedEmailDomains).toEqual([
      "example.com"
    ]);

    const publicConfig = await app.inject({
      method: "GET",
      url: "/api/v1/auth/registration-config"
    });
    expect(publicConfig.json()).toEqual({
      emailEnabled: true,
      allowRegistrationWithoutEmail: true,
      allowedEmailDomains: ["example.com"],
      revision: 2
    });

    const staleRegistration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "过期配置用户",
        realName: "过期配置",
        employeeNumber: "10009997",
        email: "before-policy@blocked.test",
        password: "Registration123!",
        challengeId: existingChallenge.challengeId,
        code: existingChallenge.code,
        expectedConfigRevision: initialRegistrationConfig.revision
      }
    });
    expect(staleRegistration.statusCode).toBe(409);
    expect(staleRegistration.json()).toMatchObject({
      code: "REGISTRATION_CONFIG_CHANGED",
      registrationConfig: publicConfig.json()
    });

    const blockedRegistration = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "策略更新测试",
        realName: "策略测试",
        employeeNumber: "10009998",
        email: "before-policy@blocked.test",
        password: "Registration123!",
        challengeId: existingChallenge.challengeId,
        code: existingChallenge.code,
        expectedConfigRevision: publicConfig.json().revision
      }
    });
    expect(blockedRegistration.statusCode).toBe(400);
    expect(blockedRegistration.json().fieldErrors.email).toContain(
      "该邮箱域名不在允许范围内"
    );
    expect(
      dbModule.db
        .prepare(
          "SELECT used_at AS usedAt FROM email_verification_challenges WHERE id = ?"
        )
        .get(existingChallenge.challengeId)
    ).toEqual({ usedAt: null });

    const blocked = await app.inject({
      method: "POST",
      url: "/api/v1/auth/registration-email-code",
      payload: { email: "user@blocked.test" }
    });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().fieldErrors.email).toContain(
      "该邮箱域名不在允许范围内"
    );

    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/email-domains",
      headers: { cookie: adminCookie },
      payload: {
        allowedEmailDomains: [],
        expectedVersion: initialVersion
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("SETTINGS_VERSION_CONFLICT");

    const restored = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/email-domains",
      headers: { cookie: adminCookie },
      payload: {
        allowedEmailDomains: [],
        expectedVersion: updated.json().settings.version
      }
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().settings.allowedEmailDomains).toEqual([]);

    const required = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/registration-email",
      headers: { cookie: adminCookie },
      payload: {
        allowRegistrationWithoutEmail: false,
        expectedVersion: restored.json().settings.version
      }
    });
    expect(required.statusCode).toBe(200);
    expect(required.json().settings.allowRegistrationWithoutEmail).toBe(false);

    const requiredConfig = await registrationConfig();
    expect(requiredConfig.allowRegistrationWithoutEmail).toBe(false);
    const missingEmail = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "必须填写邮箱",
        realName: "必填邮箱成员",
        employeeNumber: "10009996",
        email: null,
        challengeId: null,
        code: null,
        password: "Registration123!",
        expectedConfigRevision: requiredConfig.revision,
        withoutEmailConfirmed: true
      }
    });
    expect(missingEmail.statusCode).toBe(400);
    expect(missingEmail.json().fieldErrors.email).toEqual(["请输入邮箱"]);

    const optionalAgain = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/registration-email",
      headers: { cookie: adminCookie },
      payload: {
        allowRegistrationWithoutEmail: true,
        expectedVersion: required.json().settings.version
      }
    });
    expect(optionalAgain.statusCode).toBe(200);
    expect(optionalAgain.json().settings.allowRegistrationWithoutEmail).toBe(true);
  });

  it("系统管理员可以在线配置邮件使用的站点地址", async () => {
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const before = await app.inject({
      method: "GET",
      url: "/api/v1/admin/settings",
      headers: { cookie: adminCookie }
    });
    expect(before.statusCode).toBe(200);
    expect(before.json().siteOrigin).toBe("http://localhost:5173");

    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/site-origin",
      headers: { cookie: adminCookie },
      payload: {
        siteOrigin: "https://allocube.company.test/reset-password",
        expectedVersion: before.json().version
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe("SITE_ORIGIN_VALIDATION_FAILED");

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/site-origin",
      headers: { cookie: adminCookie },
      payload: {
        siteOrigin: "https://allocube.company.test/",
        expectedVersion: before.json().version
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().settings.siteOrigin).toBe(
      "https://allocube.company.test"
    );

    const stale = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/site-origin",
      headers: { cookie: adminCookie },
      payload: {
        siteOrigin: "https://resource.company.test",
        expectedVersion: before.json().version
      }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("SETTINGS_VERSION_CONFLICT");

    const restored = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/site-origin",
      headers: { cookie: adminCookie },
      payload: {
        siteOrigin: "http://localhost:5173",
        expectedVersion: updated.json().settings.version
      }
    });
    expect(restored.statusCode).toBe(200);
  });

  it("登录标识中的 SQL 片段只会被当作普通文本", async () => {
    for (const [identifierType, identifier] of [
      ["USERNAME", "Administrator' OR 1=1 --"],
      ["EMPLOYEE_NUMBER", "10000000' OR 1=1 --"]
    ] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: {
          identifierType,
          identifier,
          password: "anything123"
        }
      });
      expect(response.statusCode).toBe(401);
      expect(response.cookies).toHaveLength(0);
    }
  });

  it("注册接口一次返回全部可判断的字段错误且不创建账号", async () => {
    const config = await registrationConfig();
    const before = (
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'USER'")
        .get() as { count: number }
    ).count;
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "a",
        realName: "a",
        employeeNumber: "u1001",
        email: "bad-email",
        password: "中文 password 1",
        challengeId: "not-a-challenge",
        code: "12",
        expectedConfigRevision: config.revision
      }
    });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body).toMatchObject({
      error: "注册信息未通过检查",
      code: "REGISTRATION_VALIDATION_FAILED",
      fieldErrors: {
        username: expect.any(Array),
        realName: expect.any(Array),
        employeeNumber: expect.any(Array),
        email: expect.any(Array),
        code: expect.any(Array),
        password: expect.any(Array)
      }
    });
    expect(body.fieldErrors.employeeNumber).toContain("请输入合法工号");
    expect(body.fieldErrors.code).toEqual(
      expect.arrayContaining(["验证码无效，请重新输入", "请输入6位验证码"])
    );
    const after = (
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'USER'")
        .get() as { count: number }
    ).count;
    expect(after).toBe(before);
  });

  it("验证码错误时不创建账号，正确后预占全部标识", async () => {
    const challenge = await requestCode("pending@example.com");
    const config = await registrationConfig();
    const usersBefore = (
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'USER'")
        .get() as { count: number }
    ).count;
    const payload = {
      username: "待审用户",
      realName: "测试成员",
      employeeNumber: "10001001",
      email: "pending@example.com",
      password: "Registration123!",
      challengeId: challenge.challengeId,
      code: challenge.code === "000000" ? "000001" : "000000",
      expectedConfigRevision: config.revision
    };
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({
      fieldErrors: {
        code: ["验证码无效，请重新输入"]
      }
    });
    expect(
      (dbModule.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'USER'").get() as {
        count: number;
      }).count
    ).toBe(usersBefore);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { ...payload, code: challenge.code }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().message).toBe("注册申请已提交，请等待管理员审核。");
    const user = dbModule.db
      .prepare(
        "SELECT status, username_normalized, email FROM users WHERE id = ?"
      )
      .get(created.json().userId) as {
        status: string;
        username_normalized: string;
        email: string;
      };
    expect(user).toEqual({
      status: "PENDING_APPROVAL",
      username_normalized: "待审用户",
      email: "pending@example.com"
    });
    expect(
      dbModule.db
        .prepare(
          `SELECT employee_number FROM pending_registration_employee_numbers
           WHERE user_id = ?`
        )
        .get(created.json().userId)
    ).toEqual({ employee_number: "10001001" });
  });

  it("注册标识冲突以 409 同时映射到对应字段", async () => {
    const challenge = await requestCode("conflict@example.com");
    const config = await registrationConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: "待审用户",
        realName: "冲突测试",
        employeeNumber: "10001001",
        email: "conflict@example.com",
        password: "ConflictPass123!",
        challengeId: challenge.challengeId,
        code: challenge.code,
        expectedConfigRevision: config.revision
      }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "REGISTRATION_VALIDATION_FAILED",
      fieldErrors: {
        username: ["该用户名已被占用"],
        employeeNumber: ["该工号正在审核中"]
      }
    });
  });

  it("待审批账号只能用用户名建立受限会话", async () => {
    const usernameLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "USERNAME",
        identifier: "待审用户",
        password: "Registration123!"
      }
    });
    expect(usernameLogin.statusCode).toBe(200);
    expect(usernameLogin.json().user.status).toBe("PENDING_APPROVAL");
    expect(usernameLogin.json().user).not.toHaveProperty("applicationRevision");

    const employeeLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "EMPLOYEE_NUMBER",
        identifier: "10001001",
        password: "Registration123!"
      }
    });
    expect(employeeLogin.statusCode).toBe(401);
  });

  it("非系统管理员不能读取或修改邮箱域名白名单", async () => {
    const userCookie = await loginCookie("待审用户");
    const read = await app.inject({
      method: "GET",
      url: "/api/v1/admin/settings",
      headers: { cookie: userCookie }
    });
    expect(read.statusCode).toBe(403);

    const update = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/email-domains",
      headers: { cookie: userCookie },
      payload: {
        allowedEmailDomains: ["attacker.test"],
        expectedVersion: 1
      }
    });
    expect(update.statusCode).toBe(403);
    const updatePolicy = await app.inject({
      method: "PATCH",
      url: "/api/v1/admin/settings/registration-email",
      headers: { cookie: userCookie },
      payload: {
        allowRegistrationWithoutEmail: false,
        expectedVersion: 1
      }
    });
    expect(updatePolicy.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/auth/registration-config"
        })
      ).json()
    ).toMatchObject({
      emailEnabled: true,
      allowedEmailDomains: [],
      revision: expect.any(Number)
    });
  });

  it("审批通过后工号成为永久登录标识", async () => {
    const adminLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "USERNAME",
        identifier: "Administrator",
        password: "Admin12#$"
      }
    });
    const cookies = adminLogin.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '待审用户'")
      .get() as { id: string };
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/approve`,
      headers: { cookie: cookies },
      payload: { expectedRevision: 1 }
    });
    expect(approved.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare("SELECT employee_number FROM employee_numbers WHERE user_id = ?")
        .get(user.id)
    ).toEqual({ employee_number: "10001001" });

    const employeeLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "EMPLOYEE_NUMBER",
        identifier: "10001001",
        password: "Registration123!"
      }
    });
    expect(employeeLogin.statusCode).toBe(200);
    expect(employeeLogin.json().user.id).toBe(user.id);
  });

  it("姓名和工号修改需审核，审批后旧工号永久停用", async () => {
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '待审用户'")
      .get() as { id: string };
    const other = await registerPending({
      username: "其他用户",
      realName: "其他成员",
      employeeNumber: "10001002",
      email: "other@example.com"
    });
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${other.userId}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedRevision: 1 }
    });
    expect(approved.statusCode).toBe(200);
    const userCookie = await loginCookie("待审用户");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/profile-change-requests",
      headers: { cookie: userCookie },
      payload: {
        displayName: "更新成员",
        employeeNumber: "10003003"
      }
    });
    expect(created.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/auth/profile-change-requests",
      headers: { cookie: userCookie },
      payload: {
        displayName: "再次更新",
        employeeNumber: "10003004"
      }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe("PROFILE_CHANGE_PENDING");
    const meBeforeApproval = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: userCookie }
    });
    expect(meBeforeApproval.json().user).toMatchObject({
      displayName: "测试成员",
      employeeNumber: "10001001",
      pendingProfileChange: {
        displayName: "更新成员",
        employeeNumber: "10003003"
      }
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: adminCookie }
    });
    const pending = list
      .json()
      .users.find((item: Record<string, unknown>) => item.username === "待审用户")
      .pendingProfileChange;
    const processed = await app.inject({
      method: "POST",
      url: `/api/v1/admin/profile-change-requests/${pending.id}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: pending.expectedVersion }
    });
    expect(processed.statusCode).toBe(200);
    expect(
      (
        dbModule.db
          .prepare(
            `SELECT COUNT(*) AS count FROM employee_numbers
             WHERE user_id = ? AND status = 'ACTIVE'`
          )
          .get(user.id) as { count: number }
      ).count
    ).toBe(1);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: userCookie }
    });
    expect(me.json().user).toMatchObject({
      displayName: "更新成员",
      employeeNumber: "10003003",
      pendingProfileChange: null
    });
    expect(me.json().user).not.toHaveProperty("applicationRevision");
    const oldNumberLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "EMPLOYEE_NUMBER",
        identifier: "10001001",
        password: "Registration123!"
      }
    });
    expect(oldNumberLogin.statusCode).toBe(401);
    const newNumberLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "EMPLOYEE_NUMBER",
        identifier: "10003003",
        password: "Registration123!"
      }
    });
    expect(newNumberLogin.statusCode).toBe(200);
    const { ensureEmployeeNumberAvailable } = await import("../server/identity.js");
    expect(() => ensureEmployeeNumberAvailable("10001001")).toThrow(
      "该工号已经归属其他账号"
    );
  });

  it("时间轴只返回展示身份，不暴露用户 ID 或资源组版本", async () => {
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '待审用户'")
      .get() as { id: string };
    const machineId = randomUUID();
    const poolId = randomUUID();
    const groupId = randomUUID();
    const now = dbModule.nowIso();
    dbModule.db
      .prepare(
        `INSERT INTO machines(id, name, created_at, updated_at)
         VALUES(?, 'Identity-Test-Machine', ?, ?)`
      )
      .run(machineId, now, now);
    dbModule.db.prepare(
      `INSERT INTO resource_pools(
        id, machine_id, name, kind, unit, range_start, range_end, created_at, updated_at
      ) VALUES(?, ?, '逻辑核', 'INDEX_RANGE', '核', 0, 31, ?, ?)`
    ).run(poolId, machineId, now, now);
    dbModule.db
      .prepare(
        `INSERT INTO resource_groups(
          id, machine_id, name, version, created_at, updated_at
        ) VALUES(?, ?, 'Identity-Group', 3, ?, ?)`
      )
      .run(groupId, machineId, now, now);
    const allocationId = randomUUID();
    dbModule.db.prepare(
      `INSERT INTO resource_group_allocations(
        id, resource_group_id, resource_pool_id, kind
      ) VALUES(?, ?, ?, 'INDEX_RANGE')`
    ).run(allocationId, groupId, poolId);
    dbModule.db.prepare(
      `INSERT INTO resource_group_allocation_ranges(
        id, allocation_id, range_start, range_end
      ) VALUES(?, ?, 0, 7)`
    ).run(randomUUID(), allocationId);
    dbModule.db
      .prepare(
        `INSERT INTO machine_access_memberships(
          id, machine_id, user_id, source, created_at, updated_at
        ) VALUES(?, ?, ?, 'SEED', ?, ?)`
      )
      .run(randomUUID(), machineId, user.id, now, now);
    const reservationBase = Math.floor(Date.now() / 60_000) * 60_000;
    const startAt = new Date(reservationBase + 120 * 60_000).toISOString();
    const endAt = new Date(reservationBase + 180 * 60_000).toISOString();
    const { commitReservationBatch } = await import("../server/scheduling.js");
    commitReservationBatch(user.id, [{ resourceGroupId: groupId, startAt, endAt }]);

    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const timeline = await app.inject({
      method: "GET",
      url: `/api/v1/timeline?from=${encodeURIComponent(
        new Date(Date.now() + 60 * 60_000).toISOString()
      )}&to=${encodeURIComponent(new Date(Date.now() + 240 * 60_000).toISOString())}`,
      headers: { cookie: adminCookie }
    });
    expect(timeline.statusCode).toBe(200);
    const payload = timeline.json();
    expect(Number.isFinite(new Date(payload.serverNow).getTime())).toBe(true);
    const reservation = payload.reservations.find(
      (item: Record<string, unknown>) => item.resourceGroupId === groupId
    );
    const group = payload.groups.find((item: Record<string, unknown>) => item.id === groupId);
    expect(reservation).toMatchObject({
      applicantName: "更新成员",
      applicantEmployeeNumber: "10003003"
    });
    expect(reservation).not.toHaveProperty("userId");
    expect(group).not.toHaveProperty("version");
  });

  it("停用账号始终释放占用，并从机器成员列表隐藏", async () => {
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '待审用户'")
      .get() as { id: string };
    const machine = dbModule.db
      .prepare("SELECT id FROM machines WHERE name = 'Identity-Test-Machine'")
      .get() as { id: string };
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const stalePreview = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/disable/preview`,
      headers: { cookie: adminCookie },
      payload: {}
    });
    expect(stalePreview.statusCode).toBe(200);
    dbModule.bumpScheduleRevision();
    const staleDisable = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/disable`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: stalePreview.json().user.version,
        expectedRevision: stalePreview.json().revision,
        reason: ""
      }
    });
    expect(staleDisable.statusCode).toBe(409);
    expect(staleDisable.json().code).toBe("USER_DISABLE_PREVIEW_STALE");
    const staleUserPreview = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/disable/preview`,
      headers: { cookie: adminCookie },
      payload: {}
    });
    expect(staleUserPreview.statusCode).toBe(200);
    await loginCookie("待审用户");
    const staleUserDisable = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/disable`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: staleUserPreview.json().user.version,
        expectedRevision: staleUserPreview.json().revision,
        reason: ""
      }
    });
    expect(staleUserDisable.statusCode).toBe(409);
    const { preview, disabled } = await previewAndDisableUser(
      adminCookie,
      user.id
    );
    expect(disabled.statusCode).toBe(200);
    const repeatedDisable = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/disable`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: disabled.json().version,
        expectedRevision: disabled.json().revision,
        reason: ""
      }
    });
    expect(repeatedDisable.statusCode).toBe(409);
    expect(
      dbModule.db
        .prepare(
          `SELECT COUNT(*) AS count FROM reservations
           WHERE user_id = ? AND status = 'CONFIRMED'`
        )
        .get(user.id)
    ).toEqual({ count: 0 });
    const disabledAccess = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machine.id}/access`,
      headers: { cookie: adminCookie }
    });
    expect(disabledAccess.statusCode).toBe(200);
    expect(
      disabledAccess.json().members.some(
        (member: Record<string, unknown>) => member.id === user.id
      )
    ).toBe(false);

    const enabled = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/enable`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: disabled.json().version }
    });
    expect(enabled.statusCode).toBe(200);
    const repeatedEnable = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${user.id}/enable`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: enabled.json().version }
    });
    expect(repeatedEnable.statusCode).toBe(409);
    const enabledAccess = await app.inject({
      method: "GET",
      url: `/api/v1/admin/machines/${machine.id}/access`,
      headers: { cookie: adminCookie }
    });
    expect(
      enabledAccess.json().members.some(
        (member: Record<string, unknown>) => member.id === user.id
      )
    ).toBe(true);
  });

  it("用户撤回资料修改后，旧审批版本不能再处理", async () => {
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '待审用户'")
      .get() as { id: string };
    const userCookie = await loginCookie("待审用户");
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/profile-change-requests",
      headers: { cookie: userCookie },
      payload: {
        displayName: "撤回测试",
        employeeNumber: "10003003"
      }
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().id;
    const withdrawn = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/profile-change-requests/${requestId}`,
      headers: { cookie: userCookie }
    });
    expect(withdrawn.statusCode).toBe(200);
    const staleApproval = await app.inject({
      method: "POST",
      url: `/api/v1/admin/profile-change-requests/${requestId}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: 1 }
    });
    expect(staleApproval.statusCode).toBe(409);
    expect(staleApproval.json().code).toBe("PROFILE_CHANGE_ALREADY_PROCESSED");
    expect(
      dbModule.db
        .prepare("SELECT display_name FROM users WHERE id = ?")
        .get(user.id)
    ).toEqual({ display_name: "更新成员" });
    expect(
      dbModule.db
        .prepare(
          `SELECT COUNT(*) AS count FROM profile_change_requests
           WHERE user_id = ? AND status = 'PENDING'`
        )
        .get(user.id)
    ).toEqual({ count: 0 });
  });

  it("资料修改拒绝时原因可选并使用中性通知", async () => {
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '待审用户'")
      .get() as { id: string };
    const userCookie = await loginCookie("待审用户");
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/profile-change-requests",
      headers: { cookie: userCookie },
      payload: {
        displayName: "拒绝测试",
        employeeNumber: "10003004"
      }
    });
    expect(created.statusCode).toBe(201);
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: adminCookie }
    });
    const request = list
      .json()
      .users.find((item: Record<string, unknown>) => item.id === user.id)
      .pendingProfileChange;
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/admin/profile-change-requests/${request.id}/reject`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: request.expectedVersion }
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare(
          `SELECT body FROM notifications
           WHERE user_id = ? AND type = 'PROFILE_CHANGE_REJECTED'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(user.id)
    ).toEqual({ body: "资料修改未通过。" });
  });

  it("用户名修改只校验用户名并立即生效", async () => {
    const userCookie = await loginCookie("待审用户");
    const updated = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-username",
      headers: { cookie: userCookie },
      payload: { username: "更新用户名" }
    });
    expect(updated.statusCode).toBe(200);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-username",
      headers: { cookie: await loginCookie("其他用户") },
      payload: { username: "更新用户名" }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      code: "USERNAME_VALIDATION_FAILED",
      fieldErrors: { username: ["该用户名已被占用"] }
    });
    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "USERNAME",
        identifier: "待审用户",
        password: "Registration123!"
      }
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: await loginCookie("更新用户名") }
    });
    expect(newLogin.json().user.username).toBe("更新用户名");
  });

  it("已启用用户可以连续修改用户名，不存在冷却期限", async () => {
    const created = await registerPending({
      username: "连续改名用户",
      realName: "连续改名测试",
      employeeNumber: "10001006",
      email: "rename-twice@example.com"
    });
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/approve`,
      headers: {
        cookie: await loginCookie("Administrator", "Admin12#$")
      },
      payload: { expectedRevision: 1 }
    });
    expect(approved.statusCode).toBe(200);

    const userCookie = await loginCookie("连续改名用户");
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-username",
      headers: { cookie: userCookie },
      payload: { username: "连续改名一" }
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-username",
      headers: { cookie: userCookie },
      payload: { username: "连续改名二" }
    });
    expect(second.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare("SELECT username FROM users WHERE id = ?")
        .get(created.userId)
    ).toEqual({ username: "连续改名二" });
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM username_history WHERE user_id = ?"
        )
        .get(created.userId)
    ).toEqual({ count: 2 });
  });

  it("记录最近登录信息并按个人设置执行无操作自动登出", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "203.0.113.24",
      payload: {
        identifierType: "USERNAME",
        identifier: "Administrator",
        password: "Admin12#$"
      }
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().user).toMatchObject({
      lastLoginAt: expect.any(String),
      lastLoginIp: "203.0.113.24",
      autoLogoutMinutes: 60
    });
    const cookie = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/security-preferences",
      headers: { cookie },
      payload: { autoLogoutMinutes: 1440 }
    });
    expect(updated.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie }
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.autoLogoutMinutes).toBe(1440);
    expect(me.json().user.lastLoginIp).toBe("203.0.113.24");

    const administrator = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = 'administrator'")
      .get() as { id: string };
    dbModule.db
      .prepare("UPDATE sessions SET last_seen_at = ? WHERE user_id = ?")
      .run(
        new Date(Date.now() - 1441 * 60_000).toISOString(),
        administrator.id
      );
    const sessionsBeforeExpiry = (
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
        .get(administrator.id) as { count: number }
    ).count;
    const expired = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie }
    });
    expect(expired.statusCode).toBe(401);
    expect(
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?")
        .get(administrator.id)
    ).toEqual({ count: sessionsBeforeExpiry - 1 });
  });

  it("管理员审核列表提供最近提交时间，并把并发令牌留作隐藏字段", async () => {
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: adminCookie }
    });
    expect(response.statusCode).toBe(200);
    const user = response
      .json()
      .users.find((item: Record<string, unknown>) => item.username === "其他用户");
    const administrator = response
      .json()
      .users.find((item: Record<string, unknown>) => item.username === "Administrator");
    expect(user.lastSubmittedAt).toEqual(expect.any(String));
    expect(user.applicationRevision).toBe(1);
    expect(administrator.lastLoginAt).toEqual(expect.any(String));
  });

  it("普通用户可以查看安全用户目录，但不会获得申请和管理信息", async () => {
    const userCookie = await loginCookie("更新用户名");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/users/directory",
      headers: { cookie: userCookie }
    });
    expect(response.statusCode).toBe(200);
    const users = response.json().users as Array<Record<string, unknown>>;
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((user) => user.username && user.displayName)).toBe(true);
    for (const user of users) {
      expect(Object.keys(user).sort()).toEqual(
        ["displayName", "employeeNumber", "status", "username"].sort()
      );
      expect(["ACTIVE", "DISABLED"]).toContain(user.status);
    }
    expect(
      users.some((user) => user.username === "待审用户")
    ).toBe(false);
  });

  it("普通用户可以打开使用统计，但只能看到有权限机器的数据", async () => {
    const userCookie = await loginCookie("更新用户名");
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/admin/report?from=${encodeURIComponent(
        new Date(Date.now() + 60 * 60_000).toISOString()
      )}&to=${encodeURIComponent(new Date(Date.now() + 240 * 60_000).toISOString())}`,
      headers: { cookie: userCookie }
    });
    expect(response.statusCode).toBe(200);
    const accessibleMachineIds = new Set(
      (
        dbModule.db
          .prepare(
            `SELECT machine_id FROM machine_access_memberships
             WHERE user_id = (
               SELECT id FROM users WHERE username_normalized = '更新用户名'
             )`
          )
          .all() as Array<{ machine_id: string }>
      ).map((row) => row.machine_id)
    );
    expect(response.json().groups.length).toBeGreaterThan(0);
    expect(
      response
        .json()
        .groups.every((group: { machineId: string }) =>
          accessibleMachineIds.has(group.machineId)
        )
    ).toBe(true);
  });

  it("密码重置邮件使用独立重置页面地址", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/forgot-password",
      payload: { email: "pending@example.com" }
    });
    expect(response.statusCode).toBe(200);
    const email = dbModule.db
      .prepare(
        `SELECT html FROM email_outbox
         WHERE subject = '重置 Allocube 密码' ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { html: string };
    expect(email.html).toContain("/reset-password#token=");
    expect(email.html).not.toContain("/?reset=");
  });

  it("密码重置接口区分密码字段错误和无效链接", async () => {
    const user = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = '其他用户'")
      .get() as { id: string };
    dbModule.db
      .prepare(
        `UPDATE employee_numbers SET employee_number = 'wx123456'
         WHERE user_id = ? AND status = 'ACTIVE'`
      )
      .run(user.id);
    const { createAuthToken } = await import("../server/auth.js");
    const token = createAuthToken(user.id, "PASSWORD_RESET", 30);

    const passwordFailure = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token, password: "wx123456" }
    });
    expect(passwordFailure.statusCode).toBe(400);
    expect(passwordFailure.json()).toEqual({
      error: "新密码未通过检查",
      code: "PASSWORD_VALIDATION_FAILED",
      fieldErrors: {
        password: ["密码不能使用常见密码、用户名或工号"]
      }
    });

    const invalidToken = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: "invalid", password: "NewPassword123!" }
    });
    expect(invalidToken.statusCode).toBe(400);
    expect(invalidToken.json()).toEqual({
      error: "重置链接无效或已经过期",
      code: "PASSWORD_RESET_TOKEN_INVALID"
    });
  });

  it("只允许使用同一用户最新签发的密码重置链接", async () => {
    const created = await registerPending({
      username: "reset_case",
      realName: "重置测试",
      employeeNumber: "93000001",
      email: "reset-case@example.com"
    });
    const { createAuthToken } = await import("../server/auth.js");
    const firstToken = createAuthToken(created.userId, "PASSWORD_RESET", 30);
    const secondToken = createAuthToken(created.userId, "PASSWORD_RESET", 30);

    const stale = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: firstToken, password: "FreshPassword456!" }
    });
    expect(stale.statusCode).toBe(400);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: secondToken, password: "FreshPassword456!" }
    });
    expect(reset.statusCode).toBe(200);
    expect(
      (
        dbModule.db
          .prepare("SELECT COUNT(*) AS count FROM auth_tokens WHERE user_id = ?")
          .get(created.userId) as { count: number }
      ).count
    ).toBe(0);

    const reused = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: secondToken, password: "AnotherPassword789!" }
    });
    expect(reused.statusCode).toBe(400);
  });

  it("系统管理员可为无邮箱用户生成一次性重置链接", async () => {
    const { hashPassword, findAuthTokenUserId } = await import(
      "../server/auth.js"
    );
    const userId = randomUUID();
    const now = dbModule.nowIso();
    dbModule.db
      .prepare(
        `INSERT INTO users(
          id, username, username_normalized, email, display_name, password_hash,
          role, status, approved_at, created_at, updated_at
        ) VALUES(?, '无邮箱重置用户', '无邮箱重置用户', NULL, '无邮箱重置用户', ?,
          'USER', 'ACTIVE', ?, ?, ?)`
      )
      .run(userId, await hashPassword("ResetLinkOld123!"), now, now, now);
    const userCookie = await loginCookie(
      "无邮箱重置用户",
      "ResetLinkOld123!"
    );
    const forbidden = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/password-reset-link`,
      headers: { cookie: userCookie },
      payload: {}
    });
    expect(forbidden.statusCode).toBe(403);
    const adminCookie = await loginCookie("Administrator", "Admin12#$");

    const first = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/password-reset-link`,
      headers: { cookie: adminCookie },
      payload: {}
    });
    expect(first.statusCode).toBe(200);
    const firstUrl = new URL(first.json().resetUrl);
    const firstToken = new URLSearchParams(firstUrl.hash.slice(1)).get("token")!;
    expect(firstUrl.pathname).toBe("/reset-password");
    expect(findAuthTokenUserId(firstToken, "PASSWORD_RESET")).toBe(userId);

    const second = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/password-reset-link`,
      headers: { cookie: adminCookie },
      payload: {}
    });
    expect(second.statusCode).toBe(200);
    const secondUrl = new URL(second.json().resetUrl);
    const secondToken = new URLSearchParams(secondUrl.hash.slice(1)).get("token")!;
    expect(findAuthTokenUserId(firstToken, "PASSWORD_RESET")).toBeNull();
    expect(findAuthTokenUserId(secondToken, "PASSWORD_RESET")).toBe(userId);

    const reset = await app.inject({
      method: "POST",
      url: "/api/v1/auth/reset-password",
      payload: { token: secondToken, password: "ResetLinkFresh456!" }
    });
    expect(reset.statusCode).toBe(200);
    expect(findAuthTokenUserId(secondToken, "PASSWORD_RESET")).toBeNull();
    const audit = dbModule.db
      .prepare(
        `SELECT before_json, after_json FROM audit_logs
         WHERE action = 'PASSWORD_RESET_LINK_CREATE'
           AND entity_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(userId) as { before_json: string | null; after_json: string | null };
    expect(JSON.stringify(audit)).not.toContain(secondToken);
    expect(JSON.stringify(audit)).not.toContain("/reset-password");
  });

  it("系统管理员不能代用户修改邮箱", async () => {
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const userId = randomUUID();
    const codeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/email-change-code`,
      headers: { cookie: adminCookie },
      payload: { email: "assisted@example.com" }
    });
    const changeResponse = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${userId}/change-email`,
      headers: { cookie: adminCookie },
      payload: {
        email: null,
        clearEmailConfirmed: true,
        expectedConfigRevision: 1
      }
    });
    expect(codeResponse.statusCode).toBe(404);
    expect(changeResponse.statusCode).toBe(404);
  });

  it("邮箱换绑需要动态验证码，清空邮箱需要当前密码", async () => {
    const userCookie = await loginCookie("更新用户名");
    const config = await registrationConfig();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-change-code",
      headers: { cookie: userCookie },
      payload: { email: "changed@example.com" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty("developmentCode");
    const email = dbModule.db
      .prepare(
        `SELECT html FROM email_outbox
         WHERE to_email = 'changed@example.com'
           AND subject = 'Allocube 邮箱验证码'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { html: string };
    const code = email.html.match(/letter-spacing:6px">(\d{6})</)?.[1];
    expect(code).toMatch(/^\d{6}$/);
    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: userCookie },
      payload: {
        email: "changed@example.com",
        challengeId: response.json().challengeId,
        code,
        expectedConfigRevision: config.revision
      }
    });
    expect(changed.statusCode).toBe(200);
    const clearWithoutPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: userCookie },
      payload: {
        email: null,
        clearEmailConfirmed: true,
        expectedConfigRevision: config.revision
      }
    });
    expect(clearWithoutPassword.statusCode).toBe(400);
    expect(clearWithoutPassword.json().fieldErrors).toEqual({
      currentPassword: ["请输入当前密码"]
    });
    const clearWithWrongPassword = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: userCookie },
      payload: {
        email: null,
        currentPassword: "WrongPassword123!",
        clearEmailConfirmed: true,
        expectedConfigRevision: config.revision
      }
    });
    expect(clearWithWrongPassword.statusCode).toBe(400);
    expect(clearWithWrongPassword.json().fieldErrors).toEqual({
      currentPassword: ["当前密码不正确"]
    });
    const cleared = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: userCookie },
      payload: {
        email: null,
        currentPassword: "Registration123!",
        clearEmailConfirmed: true,
        expectedConfigRevision: config.revision
      }
    });
    expect(cleared.statusCode).toBe(200);
    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: userCookie }
    });
    expect(me.json().user.email).toBeNull();
  });

  it("打回和最终拒绝均允许不填写原因", async () => {
    const created = await registerPending({
      username: "待释放用户",
      realName: "释放测试",
      employeeNumber: "10001003",
      email: "release@example.com"
    });
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const returned = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/return`,
      headers: { cookie: adminCookie },
      payload: { expectedRevision: 1, reason: "   " }
    });
    expect(returned.statusCode).toBe(200);
    expect(
      dbModule.db
        .prepare(
          "SELECT status FROM users WHERE id = ?"
        )
        .get(created.userId)
    ).toEqual({
      status: "CHANGES_REQUESTED"
    });
    expect(
      dbModule.db
        .prepare(
          `SELECT body FROM notifications
           WHERE user_id = ? AND title = '注册资料需要修改'
           ORDER BY created_at DESC LIMIT 1`
        )
        .get(created.userId)
    ).toEqual({ body: "管理员请你更新注册资料。" });

    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/reject`,
      headers: { cookie: adminCookie },
      payload: { expectedRevision: 1 }
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      dbModule.db.prepare("SELECT 1 FROM users WHERE id = ?").get(created.userId)
    ).toBeUndefined();
    expect(
      dbModule.db
        .prepare(
          `SELECT reason_code FROM registration_tombstones
           WHERE user_id = ?`
        )
        .get(created.userId)
    ).toEqual({ reason_code: "ADMIN_REJECTED" });
    const { ensureEmailAvailable, ensureEmployeeNumberAvailable, ensureUsernameAvailable } =
      await import("../server/identity.js");
    expect(() => ensureUsernameAvailable("待释放用户")).not.toThrow();
    expect(() => ensureEmailAvailable("release@example.com")).not.toThrow();
    expect(() => ensureEmployeeNumberAvailable("10001003")).not.toThrow();
  });

  it("未审核用户修改资料会自动提交完整新版本且旧版本失效", async () => {
    const created = await registerPending({
      username: "自动重提用户",
      realName: "重提测试",
      employeeNumber: "10001004",
      email: "revision@example.com"
    });
    const userCookie = await loginCookie("自动重提用户");
    const adminCookie = await loginCookie("Administrator", "Admin12#$");

    const notifications = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: userCookie }
    });
    expect(notifications.statusCode).toBe(200);
    const unreadCount = await app.inject({
      method: "GET",
      url: "/api/v1/notifications/unread-count",
      headers: { cookie: userCookie }
    });
    expect(unreadCount.statusCode).toBe(200);
    expect(unreadCount.json()).toEqual({
      unreadCount: notifications.json().unreadCount
    });
    const readAll = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/read-all",
      headers: { cookie: userCookie },
      payload: {}
    });
    expect(readAll.statusCode).toBe(200);
    expect(readAll.json().updatedCount).toBe(notifications.json().unreadCount);
    const notificationsAfterReadAll = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { cookie: userCookie }
    });
    expect(notificationsAfterReadAll.statusCode).toBe(200);
    expect(notificationsAfterReadAll.json().unreadCount).toBe(0);
    expect(
      notificationsAfterReadAll
        .json()
        .notifications.every((item: { readAt: string | null }) => item.readAt)
    ).toBe(true);
    const businessRoute = await app.inject({
      method: "GET",
      url: "/api/v1/machines/catalog",
      headers: { cookie: userCookie }
    });
    expect(businessRoute.statusCode).toBe(403);

    const renamed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-username",
      headers: { cookie: userCookie },
      payload: { username: "最新重提用户" }
    });
    expect(renamed.statusCode).toBe(200);

    const identity = await app.inject({
      method: "POST",
      url: "/api/v1/auth/profile-change-requests",
      headers: { cookie: userCookie },
      payload: {
        displayName: "最新资料",
        employeeNumber: "10001005"
      }
    });
    expect(identity.statusCode).toBe(201);

    const emailCode = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email-change-code",
      headers: { cookie: userCookie },
      payload: { email: "latest-revision@example.com" }
    });
    expect(emailCode.statusCode).toBe(200);
    const email = dbModule.db
      .prepare(
        `SELECT html FROM email_outbox
         WHERE to_email = 'latest-revision@example.com'
           AND subject = 'Allocube 邮箱验证码'
         ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { html: string };
    const code = email.html.match(/letter-spacing:6px">(\d{6})</)?.[1];
    const config = await registrationConfig();
    const changedEmail = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-email",
      headers: { cookie: userCookie },
      payload: {
        email: "latest-revision@example.com",
        challengeId: emailCode.json().challengeId,
        code,
        expectedConfigRevision: config.revision
      }
    });
    expect(changedEmail.statusCode).toBe(200);

    expect(
      dbModule.db
        .prepare(
          `SELECT status, application_revision, username, display_name, email
           FROM users WHERE id = ?`
        )
        .get(created.userId)
    ).toEqual({
      status: "PENDING_APPROVAL",
      application_revision: 4,
      username: "最新重提用户",
      display_name: "最新资料",
      email: "latest-revision@example.com"
    });
    expect(
      dbModule.db.prepare("SELECT 1 FROM users WHERE id = ?").get(created.userId)
    ).toBeDefined();
    expect(
      dbModule.db
        .prepare(
          `SELECT username, display_name, email, employee_number
           FROM registration_revisions
           WHERE user_id = ? AND revision = 4`
        )
        .get(created.userId)
    ).toEqual({
      username: "最新重提用户",
      display_name: "最新资料",
      email: "latest-revision@example.com",
      employee_number: "10001005"
    });

    const staleApproval = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedRevision: 1 }
    });
    expect(staleApproval.statusCode).toBe(409);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: userCookie }
    });
    expect(me.json().user).toMatchObject({
      username: "最新重提用户",
      displayName: "最新资料",
      employeeNumber: "10001005",
      email: "latest-revision@example.com"
    });
    expect(me.json().user).not.toHaveProperty("changeDeadlineAt");
    expect(me.json().user).not.toHaveProperty("reviewNote");

    for (const [method, url] of [
      ["GET", "/api/v1/auth/registration"],
      ["POST", "/api/v1/auth/registration/withdraw-approval"],
      ["POST", "/api/v1/auth/registration/resubmit"],
      ["DELETE", "/api/v1/auth/registration"]
    ]) {
      const removed = await app.inject({
        method,
        url,
        headers: { cookie: userCookie }
      });
      expect(removed.statusCode).toBe(404);
    }
  });

  it("正式用户必须先停用才能永久删除，历史记录保留 UUID 并匿名显示", async () => {
    const created = await registerPending({
      username: "待删除用户",
      realName: "删除测试成员",
      employeeNumber: "10001991",
      email: "delete-user@example.com"
    });
    const adminCookie = await loginCookie("Administrator", "Admin12#$");
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/approve`,
      headers: { cookie: adminCookie },
      payload: { expectedRevision: 1 }
    });
    expect(approved.statusCode).toBe(200);
    const userCookie = await loginCookie("待删除用户");
    const forbiddenImpact = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${created.userId}/deletion-impact`,
      headers: { cookie: userCookie }
    });
    expect(forbiddenImpact.statusCode).toBe(403);
    const adminUser = dbModule.db
      .prepare("SELECT id FROM users WHERE username_normalized = 'administrator'")
      .get() as { id: string };
    const protectedAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${adminUser.id}/deletion-impact`,
      headers: { cookie: adminCookie }
    });
    expect(protectedAdmin.statusCode).toBe(400);

    const machine = dbModule.db
      .prepare("SELECT id FROM machines ORDER BY created_at LIMIT 1")
      .get() as { id: string };
    const group = dbModule.db
      .prepare("SELECT id, version FROM resource_groups WHERE machine_id = ? LIMIT 1")
      .get(machine.id) as { id: string; version: number };
    const now = dbModule.nowIso();
    const batchId = randomUUID();
    const reservationId = randomUUID();
    const startAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const endAt = new Date(Date.now() - 60 * 60_000).toISOString();
    dbModule.db
      .prepare(
        "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
      )
      .run(batchId, created.userId, now);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
          id, batch_id, resource_group_id, machine_id, user_id,
          start_at, end_at, initial_start_at, initial_end_at,
          title, purpose, note, status, snapshot_group_name,
          snapshot_resource_config_json, snapshot_group_version,
          created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 'CONFIRMED',
          '历史资源组', '[]', ?, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        group.id,
        machine.id,
        created.userId,
        startAt,
        endAt,
        startAt,
        endAt,
        group.version,
        now,
        now
      );
    dbModule.addAudit(
      created.userId,
      "RESERVATION_CREATE",
      "reservation",
      reservationId,
      undefined,
      { displayName: "删除测试成员" }
    );

    const deleteBeforeDisable = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${created.userId}/deletion-impact`,
      headers: { cookie: adminCookie }
    });
    expect(deleteBeforeDisable.statusCode).toBe(200);
    const refused = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${created.userId}`,
      headers: { cookie: adminCookie },
      payload: {
        expectedVersion: deleteBeforeDisable.json().user.version
      }
    });
    expect(refused.statusCode).toBe(409);

    const { disabled } = await previewAndDisableUser(
      adminCookie,
      created.userId
    );
    expect(disabled.statusCode).toBe(200);
    const impact = await app.inject({
      method: "GET",
      url: `/api/v1/admin/users/${created.userId}/deletion-impact`,
      headers: { cookie: adminCookie }
    });
    expect(impact.statusCode).toBe(200);
    expect(impact.json().counts.reservations).toBeGreaterThanOrEqual(1);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/users/${created.userId}`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: impact.json().user.version }
    });
    expect(deleted.statusCode).toBe(200);

    expect(
      dbModule.db
        .prepare(
          `SELECT id, display_name, email, status
           FROM users WHERE id = ?`
        )
        .get(created.userId)
    ).toEqual({
      id: created.userId,
      display_name: "用户已删除",
      email: null,
      status: "DISABLED"
    });
    expect(
      dbModule.db
        .prepare("SELECT user_id FROM deleted_user_tombstones WHERE user_id = ?")
        .get(created.userId)
    ).toEqual({ user_id: created.userId });
    expect(
      dbModule.db
        .prepare("SELECT COUNT(*) AS count FROM employee_numbers WHERE user_id = ?")
        .get(created.userId)
    ).toEqual({ count: 0 });
    expect(
      dbModule.db
        .prepare("SELECT user_id FROM reservations WHERE id = ?")
        .get(reservationId)
    ).toEqual({ user_id: created.userId });
    expect(dbModule.db.pragma("foreign_key_check")).toEqual([]);

    const deletedVersion = (
      dbModule.db
        .prepare("SELECT version FROM users WHERE id = ?")
        .get(created.userId) as { version: number }
    ).version;
    const cannotEnableDeleted = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/enable`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: deletedVersion }
    });
    expect(cannotEnableDeleted.statusCode).toBe(404);
    const cannotResetDeleted = await app.inject({
      method: "POST",
      url: `/api/v1/admin/users/${created.userId}/password-reset-link`,
      headers: { cookie: adminCookie },
      payload: {}
    });
    expect(cannotResetDeleted.statusCode).toBe(404);

    const users = await app.inject({
      method: "GET",
      url: "/api/v1/admin/users",
      headers: { cookie: adminCookie }
    });
    expect(
      users.json().users.some(
        (user: Record<string, unknown>) => user.id === created.userId
      )
    ).toBe(false);

    const report = await app.inject({
      method: "GET",
      url:
        `/api/v1/admin/report?from=${encodeURIComponent(
          new Date(Date.now() - 3 * 60 * 60_000).toISOString()
        )}&to=${encodeURIComponent(now)}&machineId=${machine.id}`,
      headers: { cookie: adminCookie }
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ displayName: "用户已删除" })
      ])
    );
  });

  it("allows users to choose optional email categories without suppressing security mail", async () => {
    const created = await registerPending({
      username: "mail-pref-user",
      realName: "邮件偏好用户",
      employeeNumber: "10009123",
      email: "mail-pref@example.com"
    });
    const cookie = await loginCookie("mail-pref-user");
    const preferences = {
      reservationUpdates: false,
      machineAccessUpdates: true,
      approvalUpdates: false,
      administrationUpdates: false
    };
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/v1/auth/email-preferences",
      headers: { cookie },
      payload: preferences
    });
    expect(updated.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie }
    });
    expect(me.json().user.emailPreferences).toEqual(preferences);

    const { createNotification } = await import("../server/mailer.js");
    createNotification(
      created.userId,
      "RESERVATION_CANCELLED",
      "可选占用邮件",
      "该邮件已关闭。"
    );
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND title = ?"
        )
        .get(created.userId, "可选占用邮件")
    ).toEqual({ count: 1 });
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM email_outbox WHERE user_id = ? AND subject = ?"
        )
        .get(created.userId, "可选占用邮件")
    ).toEqual({ count: 0 });

    createNotification(
      created.userId,
      "MACHINE_ACCESS_REQUEST",
      "机器管理邮件",
      "普通用户或机器管理员使用机器权限邮件设置。"
    );
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM email_outbox WHERE user_id = ? AND subject = ?"
        )
        .get(created.userId, "机器管理邮件")
    ).toEqual({ count: 0 });

    createNotification(
      created.userId,
      "ACCOUNT_STATUS",
      "账号安全邮件",
      "该邮件必须发送。"
    );
    expect(
      dbModule.db
        .prepare(
          "SELECT COUNT(*) AS count FROM email_outbox WHERE user_id = ? AND subject = ?"
        )
        .get(created.userId, "账号安全邮件")
    ).toEqual({ count: 1 });
  });
});
