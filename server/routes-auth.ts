import { randomUUID } from "node:crypto";
import { getSystemMaintenanceNotice } from "./system-maintenance.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  firstPasswordError,
  getPasswordChecks,
  passwordCheckFailed
} from "../src/shared/identity-rules.js";
import {
  checkPassword,
  consumeAuthToken,
  createAuthToken,
  createSession,
  destroySession,
  findAuthTokenUserId,
  getManagedMachineIds,
  hashPassword,
  publicUser,
  requireActiveUser,
  requireSession,
  type UserRow
} from "./auth.js";
import {
  addAudit,
  db,
  getAllowRegistrationWithoutEmail,
  getAllowedEmailDomains,
  getIcpFilingNumber,
  getPublicSiteOrigin,
  getPublicSecurityFilingNumber,
  getRegistrationConfigRevision,
  getSettings,
  nowIso,
  withImmediateTransaction
} from "./db.js";
import {
  IdentityError,
  assertEmailChallengeCanBeSent,
  consumeEmailChallenge,
  createEmailChallenge,
  ensureEmailAvailable,
  ensureEmployeeNumberAvailable,
  ensureUsernameAvailable,
  insertRegistrationRevision,
  normalizeEmail,
  normalizeEmployeeNumber,
  normalizeUsername,
  verifyEmailChallenge
} from "./identity.js";
import { createNotification, escapeHtml, queueEmail } from "./mailer.js";
import {
  getSmtpSettingsRow,
  isMailServiceAvailable
} from "./smtp-settings.js";
import { buildPasswordResetUrl } from "./security-urls.js";

const passwordSchema = z.string().max(256).superRefine((value, context) => {
  const message = firstPasswordError(value);
  if (message) context.addIssue({ code: "custom", message });
});
const emailSchema = z.string().trim().email().max(254).transform(normalizeEmail);
const emailPreferencesSchema = z.object({
  reservationUpdates: z.boolean(),
  machineAccessUpdates: z.boolean().optional(),
  approvalUpdates: z.boolean().optional(),
  administrationUpdates: z.boolean()
});
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$3paqNPGzeP3FYzfIfNeVjw$Jcl1CJErJo0uU+DqmeWvaj++8Ia6SGnugzZ4ttS2Vrw";

type RegistrationField =
  | "username"
  | "realName"
  | "employeeNumber"
  | "email"
  | "code"
  | "password";
type RegistrationFieldErrors = Partial<Record<RegistrationField, string[]>>;

type RegistrationPayload = {
  username: string;
  realName: string;
  employeeNumber: string;
  email: string | null;
  password: string;
  challengeId: string | null;
  code: string | null;
  withoutEmailConfirmed: boolean;
  expectedConfigRevision: number | null;
};

function addRegistrationError(
  errors: RegistrationFieldErrors,
  field: RegistrationField,
  message: string
) {
  const messages = errors[field] ?? [];
  if (!messages.includes(message)) messages.push(message);
  errors[field] = messages;
}

function sendRegistrationErrors(
  reply: FastifyReply,
  fieldErrors: RegistrationFieldErrors,
  statusCode: 400 | 409 = 400
) {
  return reply.code(statusCode).send({
    error: "注册信息未通过检查",
    code: "REGISTRATION_VALIDATION_FAILED",
    fieldErrors
  });
}

function registrationFieldForIdentityError(
  error: IdentityError
): RegistrationField | null {
  if (error.message.includes("用户名")) return "username";
  if (error.message.includes("邮箱")) return "email";
  if (error.message.includes("工号")) return "employeeNumber";
  if (error.message.includes("验证码")) return "code";
  return null;
}

function readRegistrationPayload(input: unknown) {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const errors: RegistrationFieldErrors = {};
  const read = (
    field: "username" | "realName" | "employeeNumber" | "password",
    uiField: RegistrationField
  ) => {
    const value = record[field];
    if (typeof value === "string") return value;
    addRegistrationError(errors, uiField, "请填写此项");
    return "";
  };
  const payload: RegistrationPayload = {
    username: read("username", "username"),
    realName: read("realName", "realName"),
    employeeNumber: read("employeeNumber", "employeeNumber"),
    email:
      typeof record.email === "string" && record.email.trim()
        ? record.email
        : null,
    password: read("password", "password"),
    challengeId:
      typeof record.challengeId === "string" ? record.challengeId : null,
    code: typeof record.code === "string" ? record.code : null,
    withoutEmailConfirmed: record.withoutEmailConfirmed === true,
    expectedConfigRevision:
      typeof record.expectedConfigRevision === "number" &&
      Number.isInteger(record.expectedConfigRevision)
        ? record.expectedConfigRevision
        : null
  };
  return { payload, errors };
}

function registrationConfigPayload() {
  return {
    emailEnabled: Boolean(getSmtpSettingsRow().enabled),
    allowRegistrationWithoutEmail: getAllowRegistrationWithoutEmail(),
    allowedEmailDomains: getAllowedEmailDomains(),
    revision: getRegistrationConfigRevision()
  };
}

class RegistrationConfigChangedError extends Error {}

function sendRegistrationConfigChanged(reply: FastifyReply) {
  return reply.code(409).send({
    error: "注册规则已更新，请按最新规则确认后重试",
    code: "REGISTRATION_CONFIG_CHANGED",
    registrationConfig: registrationConfigPayload()
  });
}

function collectRegistrationAvailabilityErrors(
  username: { normalized: string } | null,
  email: string | null,
  employeeNumber: string | null,
  errors: RegistrationFieldErrors
) {
  let hasConflict = false;
  const collect = (field: RegistrationField, check: () => void) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      addRegistrationError(errors, field, error.message);
      hasConflict = true;
    }
  };
  if (username) {
    collect("username", () => ensureUsernameAvailable(username.normalized));
  }
  if (email) collect("email", () => ensureEmailAvailable(email));
  if (employeeNumber) {
    collect("employeeNumber", () =>
      ensureEmployeeNumberAvailable(employeeNumber)
    );
  }
  return hasConflict;
}

function validateEmailDomain(email: string) {
  const allowedEmailDomains = getAllowedEmailDomains();
  if (!allowedEmailDomains.length) return;
  const domain = email.split("@")[1];
  if (!allowedEmailDomains.includes(domain)) {
    throw new IdentityError("该邮箱域名不在允许范围内");
  }
}

function userSelect(where: string) {
  return `
    SELECT
      u.id, u.username, u.email, u.display_name, u.password_hash, u.role, u.status,
      u.password_change_recommended, u.application_revision, u.username_changed_at,
      u.last_login_at, u.last_login_ip,
      COALESCE((SELECT ep.reservation_updates FROM user_email_preferences ep
        WHERE ep.user_id = u.id), 1) AS email_reservation_updates,
      0 AS email_machine_access_updates,
      0 AS email_approval_updates,
      COALESCE((SELECT ep.administration_updates FROM user_email_preferences ep
        WHERE ep.user_id = u.id), 1) AS email_administration_updates,
      COALESCE(
        (SELECT en.employee_number FROM employee_numbers en
         WHERE en.user_id = u.id AND en.status = 'ACTIVE'
         LIMIT 1),
        (SELECT er.employee_number FROM pending_registration_employee_numbers er
         WHERE er.user_id = u.id
         LIMIT 1)
      ) AS employee_number,
      (SELECT pcr.id FROM profile_change_requests pcr
       WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
       LIMIT 1) AS pending_profile_change_id,
      (SELECT pcr.requested_display_name FROM profile_change_requests pcr
       WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
       LIMIT 1) AS pending_display_name,
      (SELECT pcr.requested_employee_number FROM profile_change_requests pcr
       WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
       LIMIT 1) AS pending_employee_number,
      (SELECT pcr.requested_at FROM profile_change_requests pcr
       WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
       LIMIT 1) AS pending_profile_requested_at
    FROM users u
    ${where}
      AND NOT EXISTS (
        SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
      )`;
}

function passwordContextForUser(userId: string) {
  const user = db
    .prepare("SELECT username FROM users WHERE id = ?")
    .get(userId) as { username: string } | undefined;
  const employeeNumbers = db
    .prepare(
      `SELECT employee_number FROM employee_numbers WHERE user_id = ?
       UNION
       SELECT employee_number FROM pending_registration_employee_numbers
       WHERE user_id = ?
       UNION
       SELECT requested_employee_number AS employee_number FROM profile_change_requests
       WHERE user_id = ? AND status = 'PENDING'`
    )
    .all(userId, userId, userId) as Array<{ employee_number: string }>;
  return {
    username: user?.username,
    employeeNumbers: employeeNumbers.map((item) => item.employee_number)
  };
}

function notifyApprovalQueue(userId: string, name: string) {
  const admins = db
    .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN' AND status = 'ACTIVE'")
    .all() as Array<{ id: string }>;
  for (const admin of admins) {
    createNotification(
      admin.id,
      "USER_APPROVAL",
      "有新的注册申请",
      `${name} 已提交账号申请，等待审核。`,
      "/admin/users"
    );
  }
  createNotification(
    userId,
    "REGISTRATION_SUBMITTED",
    "注册申请已提交",
    "管理员审核完成后会通知你，审核期间可以在用户信息中修改资料。",
    "/"
  );
}

function updatePendingRegistration(
  userId: string,
  update: (context: {
    status: "PENDING_APPROVAL" | "CHANGES_REQUESTED";
    revision: number;
    employeeRequestId: string;
    employeeNumber: string;
  }) => void
) {
  return withImmediateTransaction(() => {
    const row = db
      .prepare(
        `SELECT u.status, u.application_revision,
          er.user_id AS employee_request_id, er.employee_number
         FROM users u
         JOIN pending_registration_employee_numbers er
           ON er.user_id = u.id
         WHERE u.id = ?`
      )
      .get(userId) as
      | {
          status: string;
          application_revision: number;
          employee_request_id: string;
          employee_number: string;
        }
      | undefined;
    if (
      !row ||
      !["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(row.status)
    ) {
      throw new IdentityError("账号状态已更新，请刷新后重试", 409);
    }
    update({
      status: row.status as "PENDING_APPROVAL" | "CHANGES_REQUESTED",
      revision: row.application_revision,
      employeeRequestId: row.employee_request_id,
      employeeNumber: row.employee_number
    });
    const revision = row.application_revision + 1;
    const now = nowIso();
    db.prepare(
      `UPDATE users
       SET status = 'PENDING_APPROVAL', application_revision = ?,
         version = version + 1, updated_at = ?
       WHERE id = ?`
    ).run(revision, now, userId);
    insertRegistrationRevision(userId, revision);
    const current = db
      .prepare("SELECT display_name FROM users WHERE id = ?")
      .get(userId) as { display_name: string };
    return { revision, displayName: current.display_name };
  });
}

function notifyUpdatedRegistration(name: string) {
  const admins = db
    .prepare(
      "SELECT id FROM users WHERE role = 'SYSTEM_ADMIN' AND status = 'ACTIVE'"
    )
    .all() as Array<{ id: string }>;
  for (const admin of admins) {
    createNotification(
      admin.id,
      "USER_APPROVAL",
      "注册信息已更新",
      `${name} 更新了注册信息，请审核最新版本。`,
      "/admin/users"
    );
  }
}

export function registerAuthRoutes(app: FastifyInstance) {
  app.get("/api/v1/auth/site-config", async () => ({
    icpFilingNumber: getIcpFilingNumber(),
    publicSecurityFilingNumber: getPublicSecurityFilingNumber()
  }));

  app.get("/api/v1/auth/registration-config", async () =>
    registrationConfigPayload()
  );

  app.post(
    "/api/v1/auth/registration-email-code",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      if (!getSmtpSettingsRow().enabled) {
        return reply.code(409).send({
          error: "邮件功能当前未启用",
          code: "EMAIL_FEATURE_DISABLED"
        });
      }
      if (!isMailServiceAvailable()) {
        return reply.code(503).send({
          error: "邮件服务暂不可用，请联系管理员",
          code: "MAIL_SERVICE_UNAVAILABLE"
        });
      }
      const parsed = z.object({ email: emailSchema }).safeParse(request.body);
      if (!parsed.success) {
        return sendRegistrationErrors(reply, {
          email: ["请输入有效的邮箱地址"]
        });
      }
      const { email } = parsed.data;
      try {
        validateEmailDomain(email);
        ensureEmailAvailable(email);
      } catch (error) {
        if (error instanceof IdentityError) {
          return sendRegistrationErrors(
            reply,
            { email: [error.message] },
            error.statusCode === 409 ? 409 : 400
          );
        }
        throw error;
      }
      assertEmailChallengeCanBeSent(email, "REGISTER", null);
      const challenge = createEmailChallenge(email, "REGISTER", null);
      queueEmail(
        email,
        "Allocube 注册验证码 / Registration verification code",
        `<p style="color:#64748b">简体中文</p><h2>注册验证码</h2><p>你的验证码是：</p>
         <p style="font-size:28px;font-weight:700;letter-spacing:6px">${challenge.code}</p>
         <p>验证码 10 分钟内有效，请勿转发。</p><hr />
         <p style="color:#64748b">English</p><h2>Registration verification code</h2><p>Your verification code is:</p>
         <p style="font-size:28px;font-weight:700;letter-spacing:6px">${challenge.code}</p>
         <p>The code is valid for 10 minutes. Do not forward it.</p>`,
        null,
        challenge.expiresAt
      );
      return {
        challengeId: challenge.id,
        expiresAt: challenge.expiresAt
      };
    }
  );

  app.post(
    "/api/v1/auth/register",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const { payload: body, errors } = readRegistrationPayload(request.body);
      const registrationConfig = registrationConfigPayload();
      if (
        body.expectedConfigRevision === null ||
        body.expectedConfigRevision !== registrationConfig.revision
      ) {
        return sendRegistrationConfigChanged(reply);
      }
      if (
        !registrationConfig.emailEnabled &&
        (body.email !== null ||
          body.challengeId !== null ||
          body.code !== null)
      ) {
        return reply.code(409).send({
          error: "邮件功能当前未启用，请按最新注册规则重试",
          code: "EMAIL_FEATURE_DISABLED"
        });
      }
      if (
        registrationConfig.emailEnabled &&
        body.email === null &&
        !registrationConfig.allowRegistrationWithoutEmail
      ) {
        return sendRegistrationErrors(reply, {
          email: ["请输入邮箱"]
        });
      }
      if (
        registrationConfig.emailEnabled &&
        body.email === null &&
        registrationConfig.allowRegistrationWithoutEmail &&
        !body.withoutEmailConfirmed
      ) {
        return reply.code(400).send({
          error: "请确认不填写邮箱的影响",
          code: "EMAIL_OMISSION_CONFIRMATION_REQUIRED"
        });
      }
      if (
        registrationConfig.emailEnabled &&
        body.email === null &&
        (body.challengeId !== null || body.code !== null)
      ) {
        return sendRegistrationErrors(reply, {
          code: ["未填写邮箱时不需要验证码"]
        });
      }
      let username: ReturnType<typeof normalizeUsername> | null = null;
      let employeeNumber: string | null = null;
      let email: string | null = null;
      let hasFormatError = Object.keys(errors).length > 0;

      try {
        username = normalizeUsername(body.username);
      } catch (error) {
        if (!(error instanceof IdentityError)) throw error;
        addRegistrationError(errors, "username", error.message);
        hasFormatError = true;
      }

      const realName = body.realName.trim();
      const realNameLength = Array.from(realName).length;
      if (realNameLength < 2 || realNameLength > 60) {
        addRegistrationError(errors, "realName", "姓名必须为 2–60 个字符");
        hasFormatError = true;
      }

      try {
        employeeNumber = normalizeEmployeeNumber(body.employeeNumber);
      } catch (error) {
        if (!(error instanceof IdentityError)) throw error;
        addRegistrationError(errors, "employeeNumber", error.message);
        hasFormatError = true;
      }

      if (registrationConfig.emailEnabled && body.email !== null) {
        const parsedEmail = emailSchema.safeParse(body.email);
        if (parsedEmail.success) {
          email = parsedEmail.data;
          try {
            validateEmailDomain(email);
          } catch (error) {
            if (!(error instanceof IdentityError)) throw error;
            addRegistrationError(errors, "email", error.message);
            hasFormatError = true;
          }
        } else {
          addRegistrationError(errors, "email", "请输入有效的邮箱地址");
          hasFormatError = true;
        }
      }

      const passwordChecks = getPasswordChecks(body.password, {
        username: body.username,
        employeeNumbers: [body.employeeNumber]
      });
      for (const check of passwordChecks.filter(passwordCheckFailed)) {
        addRegistrationError(errors, "password", check.label);
        hasFormatError = true;
      }

      const emailWasProvided =
        registrationConfig.emailEnabled && body.email !== null;
      const challengeIdValid =
        emailWasProvided &&
        z.string().uuid().safeParse(body.challengeId).success;
      if (emailWasProvided) {
        if (!challengeIdValid) {
          addRegistrationError(errors, "code", "验证码无效，请重新输入");
          hasFormatError = true;
        }
        if (!body.code || !/^\d{6}$/.test(body.code)) {
          addRegistrationError(errors, "code", "请输入6位验证码");
          hasFormatError = true;
        }
      }

      let challengeVerified = false;
      if (
        challengeIdValid &&
        body.code !== null &&
        /^\d{6}$/.test(body.code) &&
        email &&
        !errors.email
      ) {
        try {
          verifyEmailChallenge(
            body.challengeId!,
            email,
            body.code,
            "REGISTER",
            null
          );
          challengeVerified = true;
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
          addRegistrationError(errors, "code", error.message);
          hasFormatError = true;
        }
      }

      const hasConflict = email === null || challengeVerified
        ? collectRegistrationAvailabilityErrors(
            username,
            email,
            employeeNumber,
            errors
          )
        : false;

      if (Object.keys(errors).length) {
        return sendRegistrationErrors(
          reply,
          errors,
          !hasFormatError && hasConflict ? 409 : 400
        );
      }

      const validUsername = username!;
      const validEmployeeNumber = employeeNumber!;
      const passwordHash = await hashPassword(body.password);
      const userId = randomUUID();
      const now = nowIso();

      try {
        withImmediateTransaction(() => {
          const latestConfig = registrationConfigPayload();
          if (
            latestConfig.revision !== body.expectedConfigRevision ||
            latestConfig.emailEnabled !== registrationConfig.emailEnabled ||
            latestConfig.allowRegistrationWithoutEmail !==
              registrationConfig.allowRegistrationWithoutEmail
          ) {
            throw new RegistrationConfigChangedError();
          }
          if (email) {
            verifyEmailChallenge(
              body.challengeId!,
              email,
              body.code!,
              "REGISTER",
              null
            );
          }
          ensureUsernameAvailable(validUsername.normalized);
          if (email) ensureEmailAvailable(email);
          ensureEmployeeNumberAvailable(validEmployeeNumber);
          db.prepare(
            `INSERT INTO users(
              id, username, username_normalized, email, display_name, password_hash,
              role, status, auto_logout_minutes, application_revision, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, 'USER', 'PENDING_APPROVAL', 0, 1, ?, ?)`
          ).run(
            userId,
            validUsername.display,
            validUsername.normalized,
            email,
            realName,
            passwordHash,
            now,
            now
          );
          db.prepare(
            `INSERT INTO pending_registration_employee_numbers(
              user_id, employee_number, created_at, updated_at
            ) VALUES(?, ?, ?, ?)`
          ).run(userId, validEmployeeNumber, now, now);
          insertRegistrationRevision(userId, 1);
          if (email) consumeEmailChallenge(body.challengeId!);
        });
      } catch (error) {
        if (error instanceof RegistrationConfigChangedError) {
          return sendRegistrationConfigChanged(reply);
        }
        if (error instanceof IdentityError) {
          const field = registrationFieldForIdentityError(error);
          if (field) {
            return sendRegistrationErrors(
              reply,
              { [field]: [error.message] },
              field === "code" ? 400 : 409
            );
          }
        }
        throw error;
      }

      addAudit(null, "USER_REGISTER", "user", userId, undefined, {
        emailOmitted: email === null
      });
      notifyApprovalQueue(userId, realName);
      return reply.code(201).send({
        message: "注册申请已提交，请等待管理员审核。",
        userId
      });
    }
  );

  app.post(
    "/api/v1/auth/login",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const body = z
        .object({
          identifierType: z.enum(["USERNAME", "EMPLOYEE_NUMBER"]),
          identifier: z.string().trim().min(1).max(80),
          password: z.string().min(1).max(256)
        })
        .parse(request.body);
      let row: UserRow | undefined;
      if (body.identifierType === "USERNAME") {
        const normalized =
          body.identifier.normalize("NFKC").toLocaleLowerCase("zh-CN");
        row = db
          .prepare(userSelect("WHERE u.username_normalized = ?"))
          .get(normalized) as UserRow | undefined;
      } else {
        try {
          const employeeNumber = normalizeEmployeeNumber(body.identifier);
          row = db
            .prepare(
              userSelect(
                `JOIN employee_numbers en ON en.user_id = u.id
                 WHERE en.employee_number = ? AND en.status = 'ACTIVE'`
              )
            )
            .get(employeeNumber) as UserRow | undefined;
        } catch {
          row = undefined;
        }
      }
      const passwordMatches = await checkPassword(
        row?.password_hash ?? DUMMY_PASSWORD_HASH,
        body.password
      );
      if (!row || !passwordMatches) {
        return reply.code(401).send({ error: "用户名、工号或密码不正确" });
      }
      if (row.status === "DISABLED") {
        return reply.code(403).send({ error: "账号已被停用" });
      }
      if (body.identifierType === "EMPLOYEE_NUMBER" && row.status !== "ACTIVE") {
        return reply.code(401).send({ error: "用户名、工号或密码不正确" });
      }
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(
        row.id,
        nowIso()
      );
      const loginAt = nowIso();
      const loginIp = request.ip.slice(0, 128);
      db.prepare(
        `UPDATE users
         SET last_login_at = ?, last_login_ip = ?,
           version = version + 1, updated_at = ?
         WHERE id = ?`
      ).run(loginAt, loginIp, loginAt, row.id);
      row.last_login_at = loginAt;
      row.last_login_ip = loginIp;
      destroySession(request, reply);
      const csrfToken = createSession(row.id, reply);
      addAudit(row.id, "USER_LOGIN", "session", row.id, undefined, undefined);
      const user = publicUser(row);
      return {
        user,
        csrfToken,
        serverNow: nowIso(),
        settings: getSettings(),
        maintenanceNotice: getSystemMaintenanceNotice(),
        managedMachineIds:
          user.status === "ACTIVE"
            ? getManagedMachineIds(user.id, user.role)
            : []
      };
    }
  );

  app.post("/api/v1/auth/logout", async (request, reply) => {
    destroySession(request, reply);
    return { message: "已退出登录" };
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    return {
      user: auth.user,
      csrfToken: auth.csrfToken,
      serverNow: nowIso(),
      settings: getSettings(),
      maintenanceNotice: getSystemMaintenanceNotice(),
      managedMachineIds:
        auth.user.status === "ACTIVE"
          ? getManagedMachineIds(auth.user.id, auth.user.role)
          : []
    };
  });

  app.patch("/api/v1/auth/email-preferences", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    const preferences = emailPreferencesSchema.parse(request.body);
    const normalizedPreferences = {
      reservationUpdates: preferences.reservationUpdates,
      machineAccessUpdates: false,
      approvalUpdates: false,
      administrationUpdates: preferences.administrationUpdates
    };
    const updatedAt = nowIso();
    db.prepare(
      `INSERT INTO user_email_preferences(
        user_id, reservation_updates, machine_access_updates,
        approval_updates, administration_updates, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        reservation_updates = excluded.reservation_updates,
        machine_access_updates = excluded.machine_access_updates,
        approval_updates = excluded.approval_updates,
        administration_updates = excluded.administration_updates,
        updated_at = excluded.updated_at`
    ).run(
      auth.user.id,
      Number(preferences.reservationUpdates),
      0,
      0,
      Number(preferences.administrationUpdates),
      updatedAt
    );
    addAudit(
      auth.user.id,
      "EMAIL_PREFERENCES_UPDATE",
      "user",
      auth.user.id,
      auth.user.emailPreferences,
      normalizedPreferences
    );
    return {
      message: "邮件接收设置已更新",
      emailPreferences: normalizedPreferences
    };
  });

  app.post(
    "/api/v1/auth/change-password",
    { config: { rateLimit: { max: 6, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const auth = requireSession(request, reply);
      if (!auth) return;
      const body = z
        .object({
          currentPassword: z.string().min(1).max(256),
          newPassword: passwordSchema
        })
        .parse(request.body);
      const contextError = firstPasswordError(
        body.newPassword,
        passwordContextForUser(auth.user.id)
      );
      if (contextError) {
        return reply.code(400).send({
          error: "密码未通过检查",
          code: "PASSWORD_VALIDATION_FAILED",
          fieldErrors: { newPassword: [contextError] }
        });
      }
      const row = db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(auth.user.id) as { password_hash: string };
      if (!(await checkPassword(row.password_hash, body.currentPassword))) {
        return reply.code(400).send({
          error: "当前密码不正确",
          code: "CURRENT_PASSWORD_INVALID",
          fieldErrors: { currentPassword: ["当前密码不正确"] }
        });
      }
      const passwordHash = await hashPassword(body.newPassword);
      withImmediateTransaction(() => {
        db.prepare(
          `UPDATE users SET password_hash = ?, password_change_recommended = 0,
            version = version + 1, updated_at = ? WHERE id = ?`
        ).run(passwordHash, nowIso(), auth.user.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(
          auth.user.id,
          auth.sessionId
        );
        db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(auth.user.id);
        addAudit(
          auth.user.id,
          "PASSWORD_CHANGE",
          "user",
          auth.user.id,
          undefined,
          undefined
        );
      });
      return { message: "密码已更新" };
    }
  );

  app.post("/api/v1/auth/change-username", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    if (auth.user.role === "SYSTEM_ADMIN") {
      return reply.code(400).send({ error: "Administrator 用户名不可修改" });
    }
    const body = z.object({ username: z.string().max(128) }).parse(request.body);
    let username: ReturnType<typeof normalizeUsername>;
    try {
      username = normalizeUsername(body.username);
    } catch (error) {
      if (error instanceof IdentityError) {
        return reply.code(error.statusCode === 409 ? 409 : 400).send({
          error: "用户名未通过检查",
          code: "USERNAME_VALIDATION_FAILED",
          fieldErrors: { username: [error.message] }
        });
      }
      throw error;
    }
    const row = db
      .prepare(
        `SELECT username, username_normalized, username_changed_at, created_at
         FROM users WHERE id = ?`
      )
      .get(auth.user.id) as {
      username: string;
      username_normalized: string;
      username_changed_at: string | null;
      created_at: string;
    };
    if (row.username_normalized === username.normalized) {
      return reply.code(400).send({
        error: "用户名未通过检查",
        code: "USERNAME_VALIDATION_FAILED",
        fieldErrors: { username: ["新用户名与当前用户名相同"] }
      });
    }
    if (auth.user.status !== "ACTIVE") {
      if (
        !["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(
          auth.user.status
        )
      ) {
        return reply.code(403).send({ error: "当前账号不能修改用户名" });
      }
      try {
        const result = updatePendingRegistration(auth.user.id, () => {
          ensureUsernameAvailable(username.normalized, auth.user.id);
          db.prepare(
            `UPDATE users SET username = ?, username_normalized = ?,
              version = version + 1, updated_at = ? WHERE id = ?`
          ).run(
            username.display,
            username.normalized,
            nowIso(),
            auth.user.id
          );
          db.prepare(
            "DELETE FROM sessions WHERE user_id = ? AND id != ?"
          ).run(auth.user.id, auth.sessionId);
        });
        notifyUpdatedRegistration(result.displayName);
        addAudit(
          auth.user.id,
          "REGISTRATION_PROFILE_EDIT",
          "user",
          auth.user.id,
          undefined,
          { applicationRevision: result.revision, usernameChanged: true }
        );
        return { message: "用户名已更新，注册信息已重新提交" };
      } catch (error) {
        if (error instanceof IdentityError) {
          return reply.code(error.statusCode === 409 ? 409 : 400).send({
            error: "用户名未通过检查",
            code: "USERNAME_VALIDATION_FAILED",
            fieldErrors: { username: [error.message] }
          });
        }
        throw error;
      }
    }
    try {
      withImmediateTransaction(() => {
        ensureUsernameAvailable(username.normalized, auth.user.id);
        const now = nowIso();
        db.prepare(
          `INSERT INTO username_history(
            id, user_id, username, username_normalized, started_at, ended_at, created_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          auth.user.id,
          row.username,
          row.username_normalized,
          row.username_changed_at ?? row.created_at,
          now,
          now
        );
        db.prepare(
          `UPDATE users SET username = ?, username_normalized = ?,
            username_changed_at = ?, version = version + 1,
            updated_at = ? WHERE id = ?`
        ).run(username.display, username.normalized, now, now, auth.user.id);
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(
          auth.user.id,
          auth.sessionId
        );
      });
    } catch (error) {
      if (error instanceof IdentityError) {
        return reply.code(error.statusCode === 409 ? 409 : 400).send({
          error: "用户名未通过检查",
          code: "USERNAME_VALIDATION_FAILED",
          fieldErrors: { username: [error.message] }
        });
      }
      throw error;
    }
    createNotification(
      auth.user.id,
      "USERNAME_CHANGED",
      "用户名已修改",
      `你的登录用户名已修改为 ${username.display}。`,
      "/"
    );
    addAudit(auth.user.id, "USERNAME_CHANGE", "user", auth.user.id, undefined, undefined);
    return { message: "用户名已更新" };
  });

  app.post("/api/v1/auth/profile-change-requests", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    if (auth.user.role === "SYSTEM_ADMIN") {
      return reply.code(403).send({ error: "Administrator 资料不可修改" });
    }
    const body = z
      .object({
        displayName: z.string().max(200),
        employeeNumber: z.string().max(64)
      })
      .parse(request.body);
    const displayName = body.displayName.trim();
    const fieldErrors: Partial<Record<"displayName" | "employeeNumber", string[]>> = {};
    if (Array.from(displayName).length < 2 || Array.from(displayName).length > 60) {
      fieldErrors.displayName = ["姓名必须为 2–60 个字符"];
    }
    let employeeNumber: string | null = null;
    try {
      employeeNumber = normalizeEmployeeNumber(body.employeeNumber);
    } catch (error) {
      if (!(error instanceof IdentityError)) throw error;
      fieldErrors.employeeNumber = [error.message];
    }
    if (Object.keys(fieldErrors).length) {
      return reply.code(400).send({
        error: "资料未通过检查",
        code: "PROFILE_CHANGE_VALIDATION_FAILED",
        fieldErrors
      });
    }
    if (auth.user.status !== "ACTIVE") {
      if (
        !["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(
          auth.user.status
        )
      ) {
        return reply.code(403).send({ error: "当前账号不能修改资料" });
      }
      if (
        auth.user.displayName === displayName &&
        auth.user.employeeNumber === employeeNumber
      ) {
        return reply.code(400).send({
          error: "资料未通过检查",
          code: "PROFILE_CHANGE_VALIDATION_FAILED",
          fieldErrors: { displayName: ["姓名或工号至少需要修改一项"] }
        });
      }
      try {
        const result = updatePendingRegistration(
          auth.user.id,
          (context) => {
            if (employeeNumber !== context.employeeNumber) {
              ensureEmployeeNumberAvailable(
                employeeNumber!,
                context.employeeRequestId
              );
              db.prepare(
                `UPDATE pending_registration_employee_numbers
                 SET employee_number = ?, updated_at = ? WHERE user_id = ?`
              ).run(
                employeeNumber,
                nowIso(),
                context.employeeRequestId
              );
            }
            db.prepare(
              `UPDATE users SET display_name = ?,
                version = version + 1, updated_at = ? WHERE id = ?`
            ).run(displayName, nowIso(), auth.user.id);
          }
        );
        notifyUpdatedRegistration(result.displayName);
        addAudit(
          auth.user.id,
          "REGISTRATION_PROFILE_EDIT",
          "user",
          auth.user.id,
          undefined,
          {
            applicationRevision: result.revision,
            displayNameChanged: auth.user.displayName !== displayName,
            employeeNumberChanged:
              auth.user.employeeNumber !== employeeNumber
          }
        );
        return reply
          .code(201)
          .send({ message: "资料已更新，注册信息已重新提交" });
      } catch (error) {
        if (error instanceof IdentityError) {
          const employeeConflict = error.message.includes("工号");
          return reply.code(error.statusCode === 409 ? 409 : 400).send({
            error: employeeConflict ? "资料未通过检查" : error.message,
            code: employeeConflict
              ? "PROFILE_CHANGE_VALIDATION_FAILED"
              : "REGISTRATION_REVISION_CONFLICT",
            ...(employeeConflict
              ? { fieldErrors: { employeeNumber: [error.message] } }
              : {})
          });
        }
        throw error;
      }
    }
    const current = db
      .prepare(
        `SELECT u.display_name, en.employee_number
         FROM users u
         JOIN employee_numbers en ON en.user_id = u.id AND en.status = 'ACTIVE'
         WHERE u.id = ? AND u.status = 'ACTIVE'`
      )
      .get(auth.user.id) as
      | { display_name: string; employee_number: string }
      | undefined;
    if (!current) return reply.code(409).send({ error: "当前资料不可修改" });
    if (
      current.display_name === displayName &&
      current.employee_number === employeeNumber
    ) {
      return reply.code(400).send({
        error: "资料未通过检查",
        code: "PROFILE_CHANGE_VALIDATION_FAILED",
        fieldErrors: { displayName: ["姓名或工号至少需要修改一项"] }
      });
    }
    const requestId = randomUUID();
    try {
      withImmediateTransaction(() => {
        const pending = db
          .prepare(
            `SELECT 1 FROM profile_change_requests
             WHERE user_id = ? AND status = 'PENDING'`
          )
          .get(auth.user.id);
        if (pending) {
          throw new IdentityError("已有资料修改正在审核，请先撤回后再修改", 409);
        }
        if (employeeNumber !== current.employee_number) {
          ensureEmployeeNumberAvailable(employeeNumber!);
        }
        const now = nowIso();
        db.prepare(
          `INSERT INTO profile_change_requests(
            id, user_id, current_display_name, current_employee_number,
            requested_display_name, requested_employee_number,
            status, requested_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
        ).run(
          requestId,
          auth.user.id,
          current.display_name,
          current.employee_number,
          displayName,
          employeeNumber,
          now,
          now
        );
      });
    } catch (error) {
      if (error instanceof IdentityError) {
        const employeeConflict = error.message.includes("工号");
        return reply.code(error.statusCode === 409 ? 409 : 400).send({
          error: employeeConflict ? "资料未通过检查" : error.message,
          code: employeeConflict
            ? "PROFILE_CHANGE_VALIDATION_FAILED"
            : "PROFILE_CHANGE_PENDING",
          ...(employeeConflict
            ? { fieldErrors: { employeeNumber: [error.message] } }
            : {})
        });
      }
      throw error;
    }
    const admins = db
      .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN' AND status = 'ACTIVE'")
      .all() as Array<{ id: string }>;
    for (const admin of admins) {
      createNotification(
        admin.id,
        "PROFILE_CHANGE_REVIEW",
        "有新的资料修改待审核",
        `${current.display_name} 提交了姓名或工号修改。`,
        "/admin/users"
      );
    }
    createNotification(
      auth.user.id,
      "PROFILE_CHANGE_SUBMITTED",
      "资料修改已提交",
      "审核完成后会通知你。",
      "/profile"
    );
    addAudit(
      auth.user.id,
      "PROFILE_CHANGE_REQUEST",
      "profile_change_request",
      requestId,
      undefined,
      { displayNameChanged: current.display_name !== displayName, employeeNumberChanged: current.employee_number !== employeeNumber }
    );
    return reply.code(201).send({ message: "资料修改已提交审核", id: requestId });
  });

  app.delete("/api/v1/auth/profile-change-requests/:id", async (request, reply) => {
    const auth = requireActiveUser(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const changed = withImmediateTransaction(() =>
      db.prepare(
        `UPDATE profile_change_requests
         SET status = 'WITHDRAWN', version = version + 1, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'PENDING'`
      ).run(nowIso(), id, auth.user.id)
    );
    if (!changed.changes) {
      return reply.code(409).send({
        error: "该资料修改已被处理，请刷新后重试",
        code: "PROFILE_CHANGE_ALREADY_PROCESSED"
      });
    }
    addAudit(
      auth.user.id,
      "PROFILE_CHANGE_WITHDRAW",
      "profile_change_request",
      id,
      undefined,
      undefined
    );
    return { message: "资料修改已撤回" };
  });

  app.post(
    "/api/v1/auth/email-change-code",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    if (!getSmtpSettingsRow().enabled) {
      return reply.code(409).send({
        error: "邮件功能当前未启用",
        code: "EMAIL_FEATURE_DISABLED"
      });
    }
    if (!isMailServiceAvailable()) {
      return reply.code(503).send({
        error: "邮件服务暂不可用，请联系管理员",
        code: "MAIL_SERVICE_UNAVAILABLE"
      });
    }
    if (
      !["ACTIVE", "PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(
        auth.user.status
      )
    ) {
      return reply.code(409).send({ error: "当前状态不能更换邮箱" });
    }
    const { email } = z.object({ email: emailSchema }).parse(request.body);
    validateEmailDomain(email);
    ensureEmailAvailable(email, auth.user.id);
    assertEmailChallengeCanBeSent(email, "EMAIL_CHANGE", auth.user.id);
    const challenge = createEmailChallenge(email, "EMAIL_CHANGE", auth.user.id);
    queueEmail(
      email,
      "Allocube 邮箱验证码 / Email verification code",
      `<p style="color:#64748b">简体中文</p><h2>邮箱验证码</h2><p>你的验证码是：</p>
       <p style="font-size:28px;font-weight:700;letter-spacing:6px">${challenge.code}</p>
       <p>验证码 10 分钟内有效。</p><hr />
       <p style="color:#64748b">English</p><h2>Email verification code</h2><p>Your verification code is:</p>
       <p style="font-size:28px;font-weight:700;letter-spacing:6px">${challenge.code}</p>
       <p>The code is valid for 10 minutes.</p>`,
      auth.user.id,
      challenge.expiresAt
    );
    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt
    };
    }
  );

  app.post(
    "/api/v1/auth/change-email",
    { config: { rateLimit: { max: 6, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const auth = requireSession(request, reply);
      if (!auth) return;
      if (
        !["ACTIVE", "PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(
          auth.user.status
        )
      ) {
        return reply.code(403).send({ error: "当前账号不能修改邮箱" });
      }
      const rawBody = z
        .object({
          email: z.union([z.string().trim().max(254), z.null()]),
          challengeId: z.string().uuid().nullable().optional(),
          code: z.string().nullable().optional(),
          currentPassword: z.string().max(256).optional(),
          clearEmailConfirmed: z.boolean().optional().default(false),
          expectedConfigRevision: z.number().int().min(1)
        })
        .parse(request.body);
      const configAtSubmit = registrationConfigPayload();
      if (rawBody.expectedConfigRevision !== configAtSubmit.revision) {
        return sendRegistrationConfigChanged(reply);
      }
      let targetEmail: string | null = null;
      if (typeof rawBody.email === "string" && rawBody.email) {
        const parsedEmail = emailSchema.safeParse(rawBody.email);
        if (!parsedEmail.success) {
          return reply.code(400).send({
            error: "邮箱未通过检查",
            code: "EMAIL_CHANGE_VALIDATION_FAILED",
            fieldErrors: { email: ["请输入有效的邮箱地址"] }
          });
        }
        targetEmail = parsedEmail.data;
      }
      if (!configAtSubmit.emailEnabled && targetEmail) {
        return reply.code(409).send({
          error: "邮件功能当前未启用，只能清空已有邮箱",
          code: "EMAIL_FEATURE_DISABLED"
        });
      }
      if (targetEmail === null && !rawBody.clearEmailConfirmed) {
        return reply.code(400).send({
          error: "请确认清空邮箱的影响",
          code: "EMAIL_CLEAR_CONFIRMATION_REQUIRED"
        });
      }
      if (
        targetEmail === null &&
        (rawBody.challengeId != null || rawBody.code != null)
      ) {
        return reply.code(400).send({
          error: "邮箱未通过检查",
          code: "EMAIL_CHANGE_VALIDATION_FAILED",
          fieldErrors: { code: ["清空邮箱时不需要验证码"] }
        });
      }
      if (
        targetEmail &&
        (!rawBody.challengeId ||
          !rawBody.code ||
          !/^\d{6}$/.test(rawBody.code))
      ) {
        return reply.code(400).send({
          error: "邮箱未通过检查",
          code: "EMAIL_CHANGE_VALIDATION_FAILED",
          fieldErrors: { code: ["验证码无效，请重新输入"] }
        });
      }
      if (targetEmail === null) {
        if (!rawBody.currentPassword) {
          return reply.code(400).send({
            error: "请输入当前密码",
            code: "CURRENT_PASSWORD_REQUIRED",
            fieldErrors: { currentPassword: ["请输入当前密码"] }
          });
        }
        const passwordRow = db
          .prepare("SELECT password_hash FROM users WHERE id = ?")
          .get(auth.user.id) as { password_hash: string };
        if (
          !(await checkPassword(
            passwordRow.password_hash,
            rawBody.currentPassword
          ))
        ) {
          return reply.code(400).send({
            error: "当前密码不正确",
            code: "CURRENT_PASSWORD_INVALID",
            fieldErrors: { currentPassword: ["当前密码不正确"] }
          });
        }
      }
      const current = db
        .prepare(
          `SELECT email,
            COALESCE(
              (SELECT MAX(ended_at) FROM email_history
               WHERE user_id = users.id),
              created_at
            ) AS email_started_at
           FROM users WHERE id = ?`
        )
        .get(auth.user.id) as {
          email: string | null;
          email_started_at: string;
        };
      if (targetEmail === current.email) {
        return reply.code(400).send({
          error: targetEmail ? "新邮箱与当前邮箱相同" : "当前账号没有邮箱"
        });
      }
      try {
        if (targetEmail) {
          validateEmailDomain(targetEmail);
          ensureEmailAvailable(targetEmail, auth.user.id);
          verifyEmailChallenge(
            rawBody.challengeId!,
            targetEmail,
            rawBody.code!,
            "EMAIL_CHANGE",
            auth.user.id
          );
        }
        const updateEmail = () => {
          const latestConfig = registrationConfigPayload();
          if (
            latestConfig.revision !== rawBody.expectedConfigRevision ||
            latestConfig.emailEnabled !== configAtSubmit.emailEnabled
          ) {
            throw new RegistrationConfigChangedError();
          }
          if (!latestConfig.emailEnabled && targetEmail) {
            throw new RegistrationConfigChangedError();
          }
          const latestUser = db
            .prepare("SELECT email FROM users WHERE id = ?")
            .get(auth.user.id) as { email: string | null } | undefined;
          if (!latestUser || latestUser.email !== current.email) {
            throw new IdentityError("邮箱已被更新，请刷新后重试", 409);
          }
          if (targetEmail) {
            ensureEmailAvailable(targetEmail, auth.user.id);
            verifyEmailChallenge(
              rawBody.challengeId!,
              targetEmail,
              rawBody.code!,
              "EMAIL_CHANGE",
              auth.user.id
            );
          }
          const now = nowIso();
          if (current.email) {
            db.prepare(
              `INSERT INTO email_history(
                id, user_id, email, started_at, ended_at, created_at
               ) VALUES(?, ?, ?, ?, ?, ?)`
            ).run(
              randomUUID(),
              auth.user.id,
              current.email,
              current.email_started_at,
              now,
              now
            );
          }
          db.prepare(
            `UPDATE users SET email = ?,
              version = version + 1, updated_at = ? WHERE id = ?`
          ).run(targetEmail, now, auth.user.id);
          if (targetEmail) consumeEmailChallenge(rawBody.challengeId!);
          db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(
            auth.user.id
          );
          db.prepare(
            "DELETE FROM sessions WHERE user_id = ? AND id != ?"
          ).run(auth.user.id, auth.sessionId);
        };

        const pending = auth.user.status !== "ACTIVE";
        const result = pending
          ? updatePendingRegistration(auth.user.id, updateEmail)
          : withImmediateTransaction(() => {
              updateEmail();
              return null;
            });

        if (result) notifyUpdatedRegistration(result.displayName);
        addAudit(
          auth.user.id,
          pending ? "REGISTRATION_PROFILE_EDIT" : "EMAIL_CHANGE",
          "user",
          auth.user.id,
          undefined,
          {
            emailChanged: true,
            emailCleared: targetEmail === null,
            ...(result ? { applicationRevision: result.revision } : {})
          }
        );
        return {
          message: result
            ? "邮箱已更新，注册信息已重新提交"
            : targetEmail
              ? "邮箱已更新"
              : "邮箱已清空"
        };
      } catch (error) {
        if (error instanceof RegistrationConfigChangedError) {
          return sendRegistrationConfigChanged(reply);
        }
        if (error instanceof IdentityError) {
          return reply.code(error.statusCode === 409 ? 409 : 400).send({
            error: "邮箱未通过检查",
            code: "EMAIL_CHANGE_VALIDATION_FAILED",
            fieldErrors: { email: [error.message] }
          });
        }
        throw error;
      }
    }
  );

  app.post(
    "/api/v1/auth/forgot-password",
    { config: { rateLimit: { max: 5, timeWindow: "30 minutes" } } },
    async (request, reply) => {
      if (!getSmtpSettingsRow().enabled) {
        return reply.code(503).send({
          error: "邮件功能当前未启用，请联系管理员获取密码重置链接",
          code: "EMAIL_FEATURE_DISABLED"
        });
      }
      if (!isMailServiceAvailable()) {
        return reply.code(503).send({
          error: "邮件服务暂不可用，请联系管理员",
          code: "MAIL_SERVICE_UNAVAILABLE"
        });
      }
      const siteOrigin = getPublicSiteOrigin();
      if (!siteOrigin) {
        return reply.code(503).send({
          error: "站点地址尚未配置，请联系管理员",
          code: "SITE_ORIGIN_NOT_CONFIGURED"
        });
      }
      const { email } = z.object({ email: emailSchema }).parse(request.body);
      const row = db
        .prepare("SELECT id, email FROM users WHERE email = ? AND status = 'ACTIVE'")
        .get(email) as { id: string; email: string } | undefined;
      if (row) {
        const token = createAuthToken(row.id, "PASSWORD_RESET", 30);
        queueEmail(
          row.email,
          "重置 Allocube 密码 / Reset your Allocube password",
          `<p style="color:#64748b">简体中文</p><h2>重置密码</h2><p>链接将在 30 分钟后失效：</p>
           <p><a href="${escapeHtml(buildPasswordResetUrl(siteOrigin, token))}">设置新密码</a></p><hr />
           <p style="color:#64748b">English</p><h2>Reset password</h2><p>This link expires in 30 minutes:</p>
           <p><a href="${escapeHtml(buildPasswordResetUrl(siteOrigin, token))}">Set a new password</a></p>`,
          row.id,
          new Date(Date.now() + 30 * 60 * 1000).toISOString()
        );
      }
      return { message: "如果当前邮箱存在，重置邮件已经发送" };
    }
  );

  app.post(
    "/api/v1/auth/reset-password",
    { config: { rateLimit: { max: 8, timeWindow: "30 minutes" } } },
    async (request, reply) => {
      const parsed = z
        .object({
          token: z.string().max(512),
          password: z.string().max(256)
        })
        .safeParse(request.body);
      if (!parsed.success || parsed.data.token.length < 20) {
        return reply.code(400).send({
          error: "重置链接无效或已经过期",
          code: "PASSWORD_RESET_TOKEN_INVALID"
        });
      }
      const body = parsed.data;
      const tokenUserId = findAuthTokenUserId(body.token, "PASSWORD_RESET");
      if (!tokenUserId) {
        return reply.code(400).send({
          error: "重置链接无效或已经过期",
          code: "PASSWORD_RESET_TOKEN_INVALID"
        });
      }
      const contextError = firstPasswordError(
        body.password,
        passwordContextForUser(tokenUserId)
      );
      if (contextError) {
        return reply.code(400).send({
          error: "新密码未通过检查",
          code: "PASSWORD_VALIDATION_FAILED",
          fieldErrors: { password: [contextError] }
        });
      }
      const passwordHash = await hashPassword(body.password);
      const userId = withImmediateTransaction(() => {
        const consumedUserId = consumeAuthToken(body.token, "PASSWORD_RESET");
        if (!consumedUserId) return null;
        db.prepare(
          `UPDATE users SET password_hash = ?, password_change_recommended = 0,
            version = version + 1, updated_at = ? WHERE id = ?`
        ).run(passwordHash, nowIso(), consumedUserId);
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(consumedUserId);
        db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(consumedUserId);
        addAudit(
          consumedUserId,
          "PASSWORD_RESET",
          "user",
          consumedUserId,
          undefined,
          undefined
        );
        return consumedUserId;
      });
      if (!userId) {
        return reply.code(400).send({
          error: "重置链接无效或已经过期",
          code: "PASSWORD_RESET_TOKEN_INVALID"
        });
      }
      return { message: "密码已经重置，请重新登录" };
    }
  );
}
