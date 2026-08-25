import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { normalizeSiteOrigin } from "../src/shared/site-origin.js";
import { icpFilingValidationError } from "../src/shared/icp-filing.js";
import { publicSecurityFilingValidationError } from "../src/shared/public-security-filing.js";
import {
  canAccessMachine,
  canManageMachine,
  createAuthToken,
  requireAuth,
  requireSystemAdmin
} from "./auth.js";
import {
  addAudit,
  bumpMachineAccessRevision,
  bumpScheduleRevision,
  checkpointSensitiveDeletion,
  currentMinuteIso,
  db,
  getAdminSettings,
  getMachineAccessRevision,
  getPublicSiteOrigin,
  getScheduleRevision,
  incrementRegistrationConfigRevision,
  nowIso,
  parseTags,
  withImmediateTransaction
} from "./db.js";
import {
  createNotification,
  escapeHtml,
  invalidateSmtpTransporter,
  queueEmail,
  sendSmtpTest
} from "./mailer.js";
import {
  IdentityError,
  deleteUnapprovedUser,
  ensureEmployeeNumberAvailable,
  ensureEmailAvailable,
  ensureUsernameAvailable
} from "./identity.js";
import { BusinessError } from "./business-error.js";
import { revokeApiTokensForUser } from "./api-tokens.js";
import {
  grantMachineAccess,
  removeMachineMembership
} from "./machine-access.js";
import {
  decryptSmtpPassword,
  encryptSmtpPassword,
  getSavedSmtpSettings,
  getSmtpSettingsRow,
  isMailServiceAvailable
} from "./smtp-settings.js";
import {
  getResourcePool,
  groupConfiguration,
  insertGroupRevision,
  insertPoolRevision,
  listResourcePools,
  machineResourceSummary,
  mapResourceGroup,
  resourceConfigurationSchema,
  resourceGroupSchema,
  resourcePoolConfiguration,
  resourcePoolSchema,
  replaceGroupAllocations,
  validateResourceConfiguration,
  validateAndResolveGroupAllocations
} from "./resources.js";
import {
  cancelUnavailability,
  createPlannedUnavailability,
  disableLongTerm,
  enableTarget,
  listUnavailability,
  previewLongTermDisable,
  previewUnavailability,
  resolveUnavailabilityTarget
} from "./unavailability.js";
import { buildPasswordResetUrl } from "./security-urls.js";
import { normalizeAllowedEmailDomains } from "../src/shared/email-domain-rules.js";

const machineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(200).optional().default(""),
  hardwareNotes: z.string().max(2000).optional().default(""),
  connectionGuide: z.string().max(5000).optional().default(""),
  managementNotes: z.string().max(5000).optional().default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional().default([])
});

const machineUpdateSchema = machineSchema.extend({
  expectedVersion: z.number().int().min(1)
});

const smtpSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().max(253),
    port: z.number().int().min(1).max(65535),
    security: z.enum(["IMPLICIT_TLS", "STARTTLS"]),
    username: z.string().trim().max(320),
    password: z.string().min(1).max(1024).optional(),
    clearPassword: z.boolean().optional().default(false),
    fromName: z.string().trim().max(100),
    fromAddress: z.union([z.literal(""), z.string().trim().email().max(254)]),
    expectedVersion: z.number().int().min(1)
  })
  .superRefine((value, context) => {
    if (value.clearPassword && value.password) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "不能同时设置和清除密码"
      });
    }
    if (!value.enabled) return;
    if (!value.host || /\s/.test(value.host)) {
      context.addIssue({
        code: "custom",
        path: ["host"],
        message: "请输入合法的 SMTP 服务器地址"
      });
    }
    if (!value.username) {
      context.addIssue({
        code: "custom",
        path: ["username"],
        message: "请输入 SMTP 登录账号"
      });
    }
    if (!value.fromName) {
      context.addIssue({
        code: "custom",
        path: ["fromName"],
        message: "请输入发件人名称"
      });
    }
    if (!value.fromAddress) {
      context.addIssue({
        code: "custom",
        path: ["fromAddress"],
        message: "请输入发件邮箱"
      });
    }
    if (value.clearPassword) {
      context.addIssue({
        code: "custom",
        path: ["password"],
        message: "启用邮件发送时不能清除密码"
      });
    }
  });

function smtpPasswordStatus(
  encryptedPassword: string | null
): "NOT_SET" | "READY" | "UNREADABLE" {
  if (!encryptedPassword) return "NOT_SET";
  try {
    decryptSmtpPassword(encryptedPassword);
    return "READY";
  } catch {
    return "UNREADABLE";
  }
}

function smtpAdminPayload() {
  const row = getSmtpSettingsRow();
  const queue = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed
       FROM email_outbox`
    )
    .get() as { pending: number | null; failed: number | null };
  const lastFailure = db
    .prepare(
      `SELECT last_error FROM email_outbox
       WHERE status = 'FAILED' AND last_error != ''
       ORDER BY created_at DESC LIMIT 1`
    )
    .get() as { last_error: string } | undefined;
  const passwordStatus = smtpPasswordStatus(row.password_encrypted);
  return {
    enabled: Boolean(row.enabled),
    host: row.host,
    port: row.port,
    security: row.security,
    username: row.username,
    fromName: row.from_name,
    fromAddress: row.from_address,
    hasPassword: Boolean(row.password_encrypted),
    passwordStatus,
    testable: getSavedSmtpSettings() !== null,
    operational: isMailServiceAvailable(),
    version: row.version,
    updatedAt: row.updated_at,
    lastTest: row.last_test_status
      ? {
          status: row.last_test_status,
          error: row.last_test_error,
          testedAt: row.last_tested_at
        }
      : null,
    queue: {
      pending: Number(queue.pending ?? 0),
      failed: Number(queue.failed ?? 0),
      lastError: lastFailure?.last_error ?? ""
    }
  };
}

export function registerAdminRoutes(
  app: FastifyInstance,
  publishRevision: (revision: number) => void
) {
  app.get("/api/v1/users/directory", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
           u.username,
           u.display_name,
           u.status,
           (SELECT en.employee_number
              FROM employee_numbers en
             WHERE en.user_id = u.id AND en.status = 'ACTIVE'
             LIMIT 1) AS employee_number
         FROM users u
         WHERE u.status IN ('ACTIVE', 'DISABLED')
           AND NOT EXISTS (
             SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
           )
         ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE`
      )
      .all() as Array<{
        username: string;
        display_name: string;
        status: "ACTIVE" | "DISABLED";
        employee_number: string | null;
      }>;
    return {
      users: rows.map((row) => ({
        username: row.username,
        displayName: row.display_name,
        employeeNumber: row.employee_number,
        status: row.status
      }))
    };
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
          u.id, u.username, u.email, u.display_name, u.role, u.status,
          u.version, u.disabled_at, u.disable_reason,
          u.password_change_recommended, u.application_revision,
          u.approved_at, u.created_at, u.updated_at, u.last_login_at,
          (SELECT MAX(rr.submitted_at) FROM registration_revisions rr
           WHERE rr.user_id = u.id) AS last_submitted_at,
          (SELECT en.employee_number FROM employee_numbers en
           WHERE en.user_id = u.id AND en.status = 'ACTIVE'
           LIMIT 1) AS employee_number,
          (SELECT er.employee_number FROM pending_registration_employee_numbers er
           WHERE er.user_id = u.id
           LIMIT 1) AS pending_employee_number,
          (SELECT pcr.id FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS profile_change_id,
          (SELECT pcr.requested_display_name FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS requested_display_name,
          (SELECT pcr.requested_employee_number FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS requested_employee_number,
          (SELECT pcr.requested_at FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS profile_change_requested_at,
          (SELECT pcr.version FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS profile_change_version,
          GROUP_CONCAT(m.name, '、') AS managed_machines
         FROM users u
         LEFT JOIN machine_admins ma ON ma.user_id = u.id
         LEFT JOIN machines m ON m.id = ma.machine_id
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )
         GROUP BY u.id
         ORDER BY
           CASE u.status WHEN 'PENDING_APPROVAL' THEN 0
             WHEN 'CHANGES_REQUESTED' THEN 1 ELSE 2 END,
           u.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return {
      users: rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        version: row.version,
        disabledAt: row.disabled_at,
        disableReason: row.disable_reason,
        passwordChangeRecommended: Boolean(row.password_change_recommended),
        applicationRevision: row.application_revision,
        employeeNumber: row.employee_number,
        pendingEmployeeNumber: row.pending_employee_number,
        pendingProfileChange: row.profile_change_id
          ? {
              id: row.profile_change_id,
              displayName: row.requested_display_name,
              employeeNumber: row.requested_employee_number,
              requestedAt: row.profile_change_requested_at,
              expectedVersion: row.profile_change_version
            }
          : null,
        approvedAt: row.approved_at,
        lastSubmittedAt: row.last_submitted_at,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        managedMachines: row.managed_machines ? String(row.managed_machines).split("、") : []
      }))
    };
  });

  app.post("/api/v1/admin/users/:id/approve", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().min(1) })
      .parse(request.body);
    withImmediateTransaction(() => {
      const user = db
        .prepare(
          `SELECT status, application_revision, username_normalized, email FROM users
           WHERE id = ?`
        )
        .get(id) as
        | {
            status: string;
            application_revision: number;
            username_normalized: string;
            email: string | null;
          }
        | undefined;
      if (
        !user ||
        user.status !== "PENDING_APPROVAL" ||
        user.application_revision !== expectedRevision
      ) {
        throw new IdentityError("注册信息已被更新，请刷新后重试", 409);
      }
      ensureUsernameAvailable(user.username_normalized, id);
      if (user.email) ensureEmailAvailable(user.email, id);
      const employeeRequest = db
        .prepare(
          `SELECT user_id AS id, employee_number
           FROM pending_registration_employee_numbers
           WHERE user_id = ?`
        )
        .get(id) as { id: string; employee_number: string } | undefined;
      if (!employeeRequest) throw new IdentityError("待审核的工号不存在", 409);
      ensureEmployeeNumberAvailable(employeeRequest.employee_number, employeeRequest.id);
      const now = nowIso();
      db.prepare(
        `INSERT INTO employee_numbers(
          id, user_id, employee_number, status, assigned_by, assigned_at, updated_at
        ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
      ).run(randomUUID(), id, employeeRequest.employee_number, auth.user.id, now, now);
      db.prepare(
        "DELETE FROM pending_registration_employee_numbers WHERE user_id = ?"
      ).run(id);
      db.prepare(
        `UPDATE users SET status = 'ACTIVE', approved_at = ?, approved_by = ?,
          version = version + 1, updated_at = ? WHERE id = ?`
      ).run(now, auth.user.id, now, id);
    });
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "账号审核已通过",
      "你现在可以使用用户名或有效工号登录并占用机器资源。",
      "/"
    );
    addAudit(auth.user.id, "USER_APPROVE", "user", id, undefined, { expectedRevision });
    return { message: "账号已批准" };
  });

  app.post(
    "/api/v1/admin/profile-change-requests/:id/approve",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { expectedVersion } = z
        .object({ expectedVersion: z.number().int().min(1) })
        .parse(request.body);
      let result:
        | {
            userId: string;
            displayName: string;
            employeeNumber: string;
            displayNameChanged: boolean;
            employeeNumberChanged: boolean;
          }
        | undefined;
      try {
        result = withImmediateTransaction(() => {
          const row = db
            .prepare(
              `SELECT pcr.user_id, pcr.status, pcr.version,
                pcr.requested_display_name, pcr.requested_employee_number,
                u.status AS user_status, u.display_name AS current_display_name,
                en.id AS current_employee_id,
                en.employee_number AS current_employee_number
               FROM profile_change_requests pcr
               JOIN users u ON u.id = pcr.user_id
               JOIN employee_numbers en
                 ON en.user_id = pcr.user_id AND en.status = 'ACTIVE'
               WHERE pcr.id = ?`
            )
            .get(id) as
            | {
                user_id: string;
                status: string;
                version: number;
                requested_display_name: string;
                requested_employee_number: string;
                user_status: string;
                current_display_name: string;
                current_employee_id: string;
                current_employee_number: string;
              }
            | undefined;
          if (
            !row ||
            row.status !== "PENDING" ||
            row.version !== expectedVersion ||
            row.user_status !== "ACTIVE"
          ) {
            throw new IdentityError(
              "该资料修改已被处理，请刷新后重试",
              409
            );
          }
          const now = nowIso();
          if (row.requested_employee_number !== row.current_employee_number) {
            ensureEmployeeNumberAvailable(
              row.requested_employee_number,
              undefined,
              id
            );
            db.prepare(
              `UPDATE employee_numbers
               SET status = 'INACTIVE', updated_at = ?
               WHERE id = ?`
            ).run(now, row.current_employee_id);
            db.prepare(
              `INSERT INTO employee_numbers(
                id, user_id, employee_number, status,
                assigned_by, assigned_at, updated_at
              ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
            ).run(
              randomUUID(),
              row.user_id,
              row.requested_employee_number,
              auth.user.id,
              now,
              now
            );
          }
          db.prepare(
            `UPDATE users SET display_name = ?,
              version = version + 1, updated_at = ? WHERE id = ?`
          ).run(row.requested_display_name, now, row.user_id);
          db.prepare(
            `UPDATE profile_change_requests
             SET status = 'APPROVED', version = version + 1,
               reviewed_by = ?, reviewed_at = ?, updated_at = ?
             WHERE id = ?`
          ).run(auth.user.id, now, now, id);
          return {
            userId: row.user_id,
            displayName: row.requested_display_name,
            employeeNumber: row.requested_employee_number,
            displayNameChanged:
              row.requested_display_name !== row.current_display_name,
            employeeNumberChanged:
              row.requested_employee_number !== row.current_employee_number
          };
        });
      } catch (error) {
        if (error instanceof IdentityError && error.statusCode === 409) {
          return reply.code(409).send({
            error: error.message,
            code: "PROFILE_CHANGE_ALREADY_PROCESSED"
          });
        }
        throw error;
      }
      createNotification(
        result.userId,
        "PROFILE_CHANGE_APPROVED",
        "资料修改已通过",
        `当前姓名为 ${result.displayName}，工号为 ${result.employeeNumber}。`,
        "/profile"
      );
      addAudit(
        auth.user.id,
        "PROFILE_CHANGE_APPROVE",
        "profile_change_request",
        id,
        undefined,
        {
          displayNameChanged: result.displayNameChanged,
          employeeNumberChanged: result.employeeNumberChanged,
          expectedVersion
        }
      );
      return { message: "资料修改已通过" };
    }
  );

  app.post(
    "/api/v1/admin/profile-change-requests/:id/reject",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          expectedVersion: z.number().int().min(1),
          reason: z.string().trim().max(500).optional().default("")
        })
        .parse(request.body);
      let userId = "";
      try {
        userId = withImmediateTransaction(() => {
          const row = db
            .prepare(
              `SELECT user_id, status, version
               FROM profile_change_requests WHERE id = ?`
            )
            .get(id) as
            | { user_id: string; status: string; version: number }
            | undefined;
          if (
            !row ||
            row.status !== "PENDING" ||
            row.version !== body.expectedVersion
          ) {
            throw new IdentityError(
              "该资料修改已被处理，请刷新后重试",
              409
            );
          }
          const now = nowIso();
          db.prepare(
            `UPDATE profile_change_requests
             SET status = 'REJECTED', version = version + 1,
               reviewed_by = ?, review_reason = ?, reviewed_at = ?, updated_at = ?
             WHERE id = ?`
          ).run(auth.user.id, body.reason, now, now, id);
          return row.user_id;
        });
      } catch (error) {
        if (error instanceof IdentityError && error.statusCode === 409) {
          return reply.code(409).send({
            error: error.message,
            code: "PROFILE_CHANGE_ALREADY_PROCESSED"
          });
        }
        throw error;
      }
      createNotification(
        userId,
        "PROFILE_CHANGE_REJECTED",
        "资料修改未通过",
        body.reason || "资料修改未通过。",
        "/profile"
      );
      addAudit(
        auth.user.id,
        "PROFILE_CHANGE_REJECT",
        "profile_change_request",
        id,
        undefined,
        {
          expectedVersion: body.expectedVersion,
          reasonProvided: Boolean(body.reason)
        }
      );
      return { message: "资料修改已拒绝" };
    }
  );

  app.post("/api/v1/admin/users/:id/return", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().min(1),
        reason: z.string().trim().max(500).optional().default("")
      })
      .parse(request.body);
    const result = db
      .prepare(
        `UPDATE users SET status = 'CHANGES_REQUESTED',
         version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'PENDING_APPROVAL' AND application_revision = ?`
      )
      .run(nowIso(), id, body.expectedRevision);
    if (!result.changes) {
      return reply.code(409).send({ error: "注册信息已被更新，请刷新后重试" });
    }
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "注册资料需要修改",
      body.reason || "管理员请你更新注册资料。",
      "/"
    );
    addAudit(auth.user.id, "USER_RETURN", "user", id, undefined, {
      expectedRevision: body.expectedRevision,
      reasonProvided: Boolean(body.reason)
    });
    return { message: "已要求用户修改注册信息" };
  });

  app.post("/api/v1/admin/users/:id/reject", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().min(1),
        reason: z.string().trim().max(500).optional().default("")
      })
      .parse(request.body);
    const user = db
      .prepare(
        `SELECT email FROM users
         WHERE id = ? AND status IN ('PENDING_APPROVAL', 'CHANGES_REQUESTED')
           AND application_revision = ?`
      )
      .get(id, body.expectedRevision) as { email: string | null } | undefined;
    if (!user) return reply.code(409).send({ error: "注册信息已被更新，请刷新后重试" });
    deleteUnapprovedUser(
      id,
      "ADMIN_REJECTED",
      auth.user.id,
      body.expectedRevision
    );
    queueEmail(
      user.email!,
      "注册审核未通过",
      escapeHtml(body.reason || "注册审核未通过。")
    );
    addAudit(auth.user.id, "USER_REJECT", "registration_tombstone", id, undefined, {
      expectedRevision: body.expectedRevision,
      reasonProvided: Boolean(body.reason)
    });
    return { message: "注册已拒绝，用户名、邮箱和工号已释放" };
  });

  app.post(
    "/api/v1/admin/users/:id/disable/preview",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = getManageableUser(id);
      if (!user) return reply.code(404).send({ error: "用户不存在" });
      if (user.role === "SYSTEM_ADMIN") {
        return reply.code(400).send({ error: "系统管理员账号不能停用" });
      }
      if (user.status !== "ACTIVE") {
        return reply.code(409).send({ error: "该账号当前不是启用状态" });
      }
      return {
        user: mapManageableUser(user),
        counts: userDisableImpact(id),
        revision: getScheduleRevision()
      };
    }
  );

  app.post("/api/v1/admin/users/:id/disable", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = longDisableSchema.parse(request.body);
    let result:
      | {
          version: number;
          revision: number;
          counts: ReturnType<typeof userDisableImpact>;
        }
      | undefined;
    result = withImmediateTransaction(() => {
      if (getScheduleRevision() !== body.expectedRevision) {
        throw new BusinessError(
          "占用情况已变化，请重新查看影响",
          409,
          undefined,
          "USER_DISABLE_PREVIEW_STALE"
        );
      }
      const user = getManageableUser(id);
      if (!user) throw new BusinessError("用户不存在", 404);
      if (user.role === "SYSTEM_ADMIN") {
        throw new BusinessError("系统管理员账号不能停用", 400);
      }
      if (user.status !== "ACTIVE" || user.version !== body.expectedVersion) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      const now = nowIso();
      const counts = userDisableImpact(id, now);
      const changed = db
        .prepare(
          `UPDATE users
           SET status = 'DISABLED', version = version + 1,
             disabled_at = ?, disabled_by = ?, disable_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'ACTIVE' AND version = ?
             AND NOT EXISTS (
               SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = users.id
             )`
        )
        .run(
          now,
          auth.user.id,
          body.reason,
          now,
          id,
          body.expectedVersion
        );
      if (!changed.changes) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      revokeApiTokensForUser(id, "账号已停用", now);
      db.prepare(
        `UPDATE profile_change_requests
         SET status = 'CANCELLED', version = version + 1,
           review_reason = '账号已停用', reviewed_by = ?,
           reviewed_at = ?, updated_at = ?
         WHERE user_id = ? AND status = 'PENDING'`
      ).run(auth.user.id, now, now, id);
      const currentMinute = currentMinuteIso();
      const justStartedReservations = db
        .prepare(
          `SELECT id, batch_id, machine_id, resource_group_id, scope, start_at
           FROM reservations
           WHERE user_id = ? AND status = 'CONFIRMED'
             AND start_at >= ? AND start_at <= ? AND end_at > ?`
        )
        .all(id, currentMinute, now, now) as Array<{
        id: string;
        batch_id: string;
        machine_id: string;
        resource_group_id: string;
        scope: string;
        start_at: string;
      }>;
      for (const reservation of justStartedReservations) {
        addAudit(
          auth.user.id,
          "RESERVATION_WITHDRAW_FIRST_MINUTE",
          "reservation",
          reservation.id,
          null,
          {
            machineId: reservation.machine_id,
            resourceGroupId: reservation.resource_group_id,
            scope: reservation.scope,
            startedAt: reservation.start_at,
            removedWithinFirstMinute: true,
            source: "USER_DISABLED"
          }
        );
        db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
        db.prepare(
          `DELETE FROM reservation_batches
           WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM reservations WHERE batch_id = ?
           )`
        ).run(reservation.batch_id, reservation.batch_id);
      }
      db.prepare(
        `UPDATE reservations SET end_at = ?, updated_at = ?
         WHERE user_id = ? AND status = 'CONFIRMED'
           AND start_at < ? AND end_at > ?`
      ).run(currentMinute, now, id, currentMinute, now);
      db.prepare(
        `UPDATE reservations SET status = 'CANCELLED', cancelled_at = ?,
          cancelled_by = ?, cancellation_reason = '账号停用释放资源', updated_at = ?
         WHERE user_id = ? AND status = 'CONFIRMED' AND start_at > ?`
      ).run(now, auth.user.id, now, id, now);
      addAudit(auth.user.id, "USER_STATUS_CHANGE", "user", id, {
        status: "ACTIVE"
      }, {
        status: "DISABLED",
        reasonProvided: Boolean(body.reason),
        impact: counts
      });
      bumpMachineAccessRevision();
      return {
        version: body.expectedVersion + 1,
        revision: bumpScheduleRevision(),
        counts
      };
    });
    publishRevision(result.revision);
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "账号已停用",
      body.reason || "账号已停用，当前和未来占用已经释放。",
      "/"
    );
    return { status: "DISABLED", ...result };
  });

  app.post("/api/v1/admin/users/:id/enable", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = versionSchema.parse(request.body);
    let result: { version: number; revision: number } | undefined;
    result = withImmediateTransaction(() => {
      const user = getManageableUser(id);
      if (!user) throw new BusinessError("用户不存在", 404);
      if (user.role === "SYSTEM_ADMIN") {
        throw new BusinessError("系统管理员账号不能重新启用", 400);
      }
      if (user.status !== "DISABLED" || user.version !== expectedVersion) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      const now = nowIso();
      const changed = db
        .prepare(
          `UPDATE users
           SET status = 'ACTIVE', version = version + 1,
             disabled_at = NULL, disabled_by = NULL,
             disable_reason = '', updated_at = ?
           WHERE id = ? AND status = 'DISABLED' AND version = ?
             AND NOT EXISTS (
               SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = users.id
             )`
        )
        .run(now, id, expectedVersion);
      if (!changed.changes) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      addAudit(auth.user.id, "USER_STATUS_CHANGE", "user", id, {
        status: "DISABLED"
      }, {
        status: "ACTIVE",
        reservationsRestored: false
      });
      bumpMachineAccessRevision();
      return {
        version: expectedVersion + 1,
        revision: bumpScheduleRevision()
      };
    });
    publishRevision(result.revision);
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "账号已重新启用",
      "你现在可以重新登录并使用系统，之前取消的占用不会恢复。",
      "/"
    );
    return { status: "ACTIVE", ...result };
  });

  app.get(
    "/api/v1/admin/users/:id/deletion-impact",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = getManageableUser(id);
      if (!user) return reply.code(404).send({ error: "用户不存在" });
      if (user.role === "SYSTEM_ADMIN") {
        return reply.code(400).send({ error: "系统管理员账号不能删除" });
      }
      return {
        user: mapManageableUser(user),
        counts: userDeleteImpact(id)
      };
    }
  );

  app.delete("/api/v1/admin/users/:id", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = versionSchema.parse(request.body);
    if (id === auth.user.id) {
      return reply.code(400).send({ error: "不能删除当前登录的系统管理员" });
    }
    let revision = getScheduleRevision();
    withImmediateTransaction(() => {
      const user = getManageableUser(id);
      if (!user) throw new BusinessError("用户不存在", 404);
      if (user.role === "SYSTEM_ADMIN") {
        throw new BusinessError("系统管理员账号不能删除", 400);
      }
      if (user.status !== "DISABLED") {
        throw new BusinessError("请先停用账号，再进行删除", 409);
      }
      if (user.version !== expectedVersion) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      const counts = userDeleteImpact(id);
      deleteUserRecords(id, auth.user.id, counts);
      addAudit(auth.user.id, "USER_DELETE", "user", id, undefined, {
        displayName: "用户已删除",
        counts
      });
      bumpMachineAccessRevision();
      revision = bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(revision);
    return { deleted: true };
  });

  app.post(
    "/api/v1/admin/users/:id/password-reset-link",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const user = db
      .prepare(
        `SELECT u.id FROM users u
         WHERE u.id = ? AND u.role = 'USER' AND u.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
           )`
      )
      .get(id);
    if (!user) {
      return reply.code(404).send({ error: "已启用的普通用户不存在" });
    }
    const siteOrigin = getPublicSiteOrigin();
    if (!siteOrigin) {
      return reply.code(409).send({
        error: "请先在系统设置中配置站点地址",
        code: "PUBLIC_SITE_ORIGIN_REQUIRED"
      });
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const token = withImmediateTransaction(() => {
      const latestUser = db
        .prepare(
          `SELECT 1 FROM users u
           WHERE u.id = ? AND u.role = 'USER' AND u.status = 'ACTIVE'
             AND NOT EXISTS (
               SELECT 1 FROM deleted_user_tombstones dut
               WHERE dut.user_id = u.id
             )`
        )
        .get(id);
      if (!latestUser) {
        throw new BusinessError("已启用的普通用户不存在", 404);
      }
      db.prepare(
        `DELETE FROM auth_tokens
         WHERE user_id = ? AND kind = 'PASSWORD_RESET' AND used_at IS NULL`
      ).run(id);
      return createAuthToken(id, "PASSWORD_RESET", 30);
    });
    addAudit(
      auth.user.id,
      "PASSWORD_RESET_LINK_CREATE",
      "user",
      id,
      undefined,
      { expiresInMinutes: 30 }
    );
    reply.header("Cache-Control", "no-store");
    return {
      resetUrl: buildPasswordResetUrl(siteOrigin, token),
      expiresAt
    };
    }
  );

  app.get("/api/v1/admin/machines", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
          m.*,
          (
            SELECT COUNT(*)
            FROM machine_access_requests mar
            WHERE mar.machine_id = m.id AND mar.status = 'PENDING'
          ) AS pending_access_request_count,
          EXISTS(
            SELECT 1 FROM resource_unavailability ru
            WHERE ru.machine_id = m.id AND ru.resource_group_id IS NULL
              AND ru.kind = 'PLANNED' AND ru.status = 'ACTIVE'
              AND ru.start_at <= ? AND ru.end_at > ?
          ) AS planned_unavailable_now
         FROM machines m
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt WHERE dmt.machine_id = m.id
         )
         ORDER BY m.name`
      )
      .all(nowIso(), nowIso()) as Array<Record<string, unknown>>;
    const managerRows = db
      .prepare(
        `SELECT ma.machine_id, u.id, u.display_name
         FROM machine_admins ma
         JOIN machines m ON m.id = ma.machine_id
         JOIN users u ON u.id = ma.user_id AND u.status = 'ACTIVE'
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )
         ORDER BY u.display_name COLLATE NOCASE, u.id`
      )
      .all() as Array<{
      machine_id: string;
      id: string;
      display_name: string;
    }>;
    const managersByMachine = new Map<
      string,
      Array<{ id: string; displayName: string }>
    >();
    for (const manager of managerRows) {
      const managers = managersByMachine.get(manager.machine_id) ?? [];
      managers.push({ id: manager.id, displayName: manager.display_name });
      managersByMachine.set(manager.machine_id, managers);
    }
    return {
      machines: rows
        .filter((row) =>
          canAccessMachine(auth.user.id, auth.user.role, String(row.id))
        )
        .map((row) => {
          const canManage = canManageMachine(
            auth.user.id,
            auth.user.role,
            String(row.id)
          );
          return {
            id: row.id,
            name: row.name,
            address: row.address,
            resourceSummary: machineResourceSummary(String(row.id)),
            status: row.status,
            availabilityStatus:
              row.status === "DISABLED"
                ? "LONG_TERM"
                : Number(row.planned_unavailable_now)
                  ? "PLANNED"
                  : "ACTIVE",
            managers: (managersByMachine.get(String(row.id)) ?? []).map(
              (manager) =>
                canManage
                  ? manager
                  : { displayName: manager.displayName }
            ),
            canManage,
            ...(canManage
              ? {
                  version: row.version,
                  pendingAccessRequestCount: Number(
                    row.pending_access_request_count ?? 0
                  )
                }
              : {})
          };
        })
    };
  });

  app.get("/api/v1/admin/machines/:id", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    const row = db
      .prepare("SELECT * FROM machines WHERE id = ?")
      .get(auth.machineId) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "机器不存在" });
    const machine = {
        id: row.id,
        name: row.name,
        address: row.address,
        resourceSummary: machineResourceSummary(String(row.id)),
        hardwareNotes: row.hardware_notes,
        connectionGuide: row.connection_guide,
        tags: parseTags(String(row.tags_json)),
        status: row.status,
        canManage: auth.canManage,
        ...(auth.canManage
          ? {
              managementNotes: row.management_notes,
              version: row.version
            }
          : {})
      };
    return {
      machine
    };
  });

  app.post("/api/v1/admin/machines", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const body = machineSchema.parse(request.body);
    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(
        `INSERT INTO machines(
          id, name, address, hardware_notes,
          connection_guide, management_notes, tags_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.name,
        body.address,
        body.hardwareNotes,
        body.connectionGuide,
        body.managementNotes,
        JSON.stringify(body.tags),
        now,
        now
      );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "机器名称已经存在" });
      }
      throw error;
    }
    addAudit(
      auth.user.id,
      "MACHINE_CREATE",
      "machine",
      id,
      undefined,
      machineAuditPayload(body, Boolean(body.managementNotes))
    );
    publishRevision(bumpScheduleRevision());
    return reply.code(201).send({ id });
  });

  app.patch("/api/v1/admin/machines/:id", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const body = machineUpdateSchema.parse(request.body);
    const before = db.prepare("SELECT * FROM machines WHERE id = ?").get(auth.machineId) as
      | Record<string, unknown>
      | undefined;
    if (!before) return reply.code(404).send({ error: "机器不存在" });
    let updateResult;
    try {
      updateResult = db.prepare(
        `UPDATE machines SET
          name = ?, address = ?, hardware_notes = ?,
          connection_guide = ?, management_notes = ?,
          tags_json = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND version = ?`
      ).run(
        body.name,
        body.address,
        body.hardwareNotes,
        body.connectionGuide,
        body.managementNotes,
        JSON.stringify(body.tags),
        nowIso(),
        auth.machineId,
        body.expectedVersion
      );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "机器名称已经存在" });
      }
      throw error;
    }
    if (!updateResult.changes) {
      return reply.code(409).send({
        error: "机器信息已由其他管理员更新，请刷新后重试",
        code: "MACHINE_SETTINGS_STALE"
      });
    }
    const notesChanged = String(before.management_notes ?? "") !== body.managementNotes;
    addAudit(
      auth.user.id,
      "MACHINE_UPDATE",
      "machine",
      auth.machineId,
      machineAuditPayloadFromRow(before, notesChanged),
      machineAuditPayload(body, notesChanged)
    );
    publishRevision(bumpScheduleRevision());
    return { message: "机器资料已更新" };
  });

  app.post(
    "/api/v1/admin/machines/:id/disable/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const auth = requireMachineManagerForId(request, reply, id);
      if (!auth) return;
      return previewLongTermDisable("MACHINE", id);
    }
  );

  app.post("/api/v1/admin/machines/:id/disable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    const body = longDisableSchema.parse(request.body);
    const result = disableLongTerm({
      type: "MACHINE",
      id,
      expectedVersion: body.expectedVersion,
      expectedRevision: body.expectedRevision,
      reason: body.reason,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.post("/api/v1/admin/machines/:id/enable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    const { expectedVersion } = versionSchema.parse(request.body);
    const result = enableTarget({
      type: "MACHINE",
      id,
      expectedVersion,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.get(
    "/api/v1/admin/machines/:id/deletion-impact",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const machine = getCurrentMachineRow(id);
      if (!machine) return reply.code(404).send({ error: "机器不存在" });
      return { machine, counts: machineDeleteImpact(id) };
    }
  );

  app.delete("/api/v1/admin/machines/:id", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = versionSchema.parse(request.body);
    withImmediateTransaction(() => {
      const machine = getCurrentMachineRow(id) as
        | { id: string; name: string; status: string; version: number }
        | undefined;
      if (!machine) throw new BusinessError("机器不存在", 404);
      if (machine.status !== "DISABLED") {
        throw new BusinessError("请先停用机器，再进行删除", 409);
      }
      if (machine.version !== expectedVersion) {
        throw new BusinessError("机器信息已更新，请刷新后重试", 409);
      }
      const counts = machineDeleteImpact(id);
      notifyDeletedMachineUsers(id, machine.name);
      deleteMachineRecords(id, auth.user.id, counts);
      addAudit(auth.user.id, "MACHINE_DELETE", "machine", id, undefined, {
        name: machine.name,
        counts
      });
      bumpMachineAccessRevision();
      bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(getScheduleRevision());
    return { deleted: true };
  });

  app.post("/api/v1/admin/machines/:id/managers", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.body);
    const result = assignMachineManager(reply, id, userId, auth.user.id);
    if (result) publishRevision(getScheduleRevision());
    return result;
  });

  app.put("/api/v1/admin/machines/:id/managers/:userId", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    const result = assignMachineManager(reply, params.id, params.userId, auth.user.id);
    if (result) publishRevision(getScheduleRevision());
    return result;
  });

  app.delete("/api/v1/admin/machines/:id/managers/:userId", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    const removed = db
      .prepare("DELETE FROM machine_admins WHERE machine_id = ? AND user_id = ?")
      .run(params.id, params.userId);
    if (!removed.changes) {
      return reply.code(404).send({ error: "该用户不是这台机器的管理员" });
    }
    addAudit(auth.user.id, "MACHINE_ADMIN_REMOVE", "machine", params.id, {
      userId: params.userId
    }, undefined);
    bumpMachineAccessRevision();
    createNotification(
      params.userId,
      "MACHINE_ROLE_CHANGED",
      "机器管理员身份已取消",
      "你仍然保留这台机器的普通使用权。",
      "/"
    );
    publishRevision(bumpScheduleRevision());
    return { message: "机器管理员授权已移除" };
  });

  app.get("/api/v1/admin/machines/:id/access", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    const now = nowIso();
    const members = db
      .prepare(
        `SELECT
           mam.user_id AS id, u.display_name, u.username,
           mam.source, mam.created_at,
           CASE WHEN ma.user_id IS NULL THEN 0 ELSE 1 END AS is_manager,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number,
           (SELECT COUNT(*) FROM reservations r
            WHERE r.machine_id = mam.machine_id AND r.user_id = mam.user_id
              AND r.status = 'CONFIRMED' AND r.start_at <= ? AND r.end_at > ?) AS active_count,
           (SELECT COUNT(*) FROM reservations r
            WHERE r.machine_id = mam.machine_id AND r.user_id = mam.user_id
              AND r.status = 'CONFIRMED' AND r.start_at > ?) AS future_count
         FROM machine_access_memberships mam
         JOIN users u
           ON u.id = mam.user_id AND u.role = 'USER' AND u.status = 'ACTIVE'
         LEFT JOIN machine_admins ma
           ON ma.machine_id = mam.machine_id AND ma.user_id = mam.user_id
         WHERE mam.machine_id = ?
         ORDER BY is_manager DESC, u.display_name, u.username`
      )
      .all(now, now, now, auth.machineId) as Array<Record<string, unknown>>;
    const requests = auth.canManage ? db
      .prepare(
        `SELECT
           mar.id, mar.user_id, mar.reason, mar.status, mar.version,
           mar.created_at, u.display_name, u.username,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number
         FROM machine_access_requests mar
         JOIN users u ON u.id = mar.user_id
         WHERE mar.machine_id = ? AND mar.status = 'PENDING'
         ORDER BY mar.created_at`
      )
      .all(auth.machineId) as Array<Record<string, unknown>> : [];
    return {
      ...(auth.canManage
        ? { accessRevision: getMachineAccessRevision() }
        : {}),
      members: members.map((row) => ({
        displayName: row.display_name,
        username: row.username,
        employeeNumber: row.employee_number,
        role: row.is_manager ? "MACHINE_ADMIN" : "MEMBER",
        grantedAt: row.created_at,
        ...(auth.canManage
          ? {
              id: row.id,
              source: row.source,
              impact: {
                activeReservations: Number(row.active_count),
                futureReservations: Number(row.future_count)
              }
            }
          : {})
      })),
      requests: requests.map((row) => ({
        id: row.id,
        userId: row.user_id,
        displayName: row.display_name,
        username: row.username,
        employeeNumber: row.employee_number,
        reason: row.reason,
        status: row.status,
        expectedVersion: row.version,
        createdAt: row.created_at
      }))
    };
  });

  app.get("/api/v1/admin/machines/:id/member-candidates", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const { q } = z
      .object({ q: z.string().trim().max(100).optional().default("") })
      .parse(request.query);
    const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;
    const rows = db
      .prepare(
        `SELECT
           u.id, u.display_name, u.username,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number
         FROM users u
         WHERE u.role = 'USER' AND u.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM machine_access_memberships mam
             WHERE mam.machine_id = ? AND mam.user_id = u.id
           )
           AND NOT EXISTS (
             SELECT 1 FROM machine_access_requests mar
             WHERE mar.machine_id = ? AND mar.user_id = u.id AND mar.status = 'PENDING'
           )
           AND (
             ? = '' OR u.display_name LIKE ? ESCAPE '\\'
             OR u.username LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM employee_numbers en
               WHERE en.user_id = u.id AND en.status = 'ACTIVE'
                 AND en.employee_number LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY u.display_name, u.username LIMIT 30`
      )
      .all(auth.machineId, auth.machineId, q, pattern, pattern, pattern) as Array<
      Record<string, unknown>
    >;
    return {
      users: rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        username: row.username,
        employeeNumber: row.employee_number
      }))
    };
  });

  app.post("/api/v1/admin/machines/:id/members", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.body);
    let invitedUser: { display_name: string } | undefined;
    withImmediateTransaction(() => {
      invitedUser = db
        .prepare(
          "SELECT display_name FROM users WHERE id = ? AND role = 'USER' AND status = 'ACTIVE'"
        )
        .get(userId) as { display_name: string } | undefined;
      if (!invitedUser) throw new BusinessError("只能邀请已启用用户", 400);
      const pending = db
        .prepare(
          `SELECT 1 FROM machine_access_requests
           WHERE machine_id = ? AND user_id = ? AND status = 'PENDING'`
        )
        .get(auth.machineId, userId);
      if (pending) {
        throw new BusinessError(
          "该用户已有待审批申请，请直接处理申请",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_PENDING"
        );
      }
      const existing = db
        .prepare(
          "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(auth.machineId, userId);
      if (existing) {
        throw new BusinessError(
          "该用户已经获得使用权，成员列表已刷新",
          409,
          undefined,
          "MACHINE_MEMBER_ALREADY_EXISTS"
        );
      }
      grantMachineAccess(auth.machineId, userId, "ADMIN_INVITE", auth.user.id);
      addAudit(
        auth.user.id,
        "MACHINE_MEMBER_INVITE",
        "machine",
        auth.machineId,
        undefined,
        { userId }
      );
    });
    const machine = db
      .prepare("SELECT name FROM machines WHERE id = ?")
      .get(auth.machineId) as { name: string };
    createNotification(
      userId,
      "MACHINE_ACCESS_GRANTED",
      "已获得机器使用权",
      `管理员已将你加入 ${machine.name}，现在可以查看资源并登记占用。`,
      "/calendar"
    );
    publishRevision(getScheduleRevision());
    return reply.code(201).send({ message: `${invitedUser!.display_name} 已加入机器` });
  });

  app.post("/api/v1/admin/machine-access/requests/:id/approve", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    let approved:
      | { userId: string; machineId: string; machineName: string }
      | undefined;
    withImmediateTransaction(() => {
      const row = db
        .prepare(
          `SELECT mar.*, m.name AS machine_name, u.status AS user_status
           FROM machine_access_requests mar
           JOIN machines m ON m.id = mar.machine_id
           JOIN users u ON u.id = mar.user_id
           WHERE mar.id = ?`
        )
        .get(id) as Record<string, any> | undefined;
      if (!row || !canManageMachine(auth.user.id, auth.user.role, row.machine_id)) {
        throw new BusinessError("无权处理这条申请", 403);
      }
      if (row.status !== "PENDING" || row.version !== expectedVersion) {
        throw new BusinessError(
          "该申请已由其他管理员处理，审批列表已刷新",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
        );
      }
      if (row.user_status !== "ACTIVE") {
        throw new BusinessError("申请人的账号当前不可用", 409);
      }
      const existing = db
        .prepare(
          "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(row.machine_id, row.user_id);
      if (existing) {
        throw new BusinessError(
          "该用户已经获得使用权，成员列表已刷新",
          409,
          undefined,
          "MACHINE_MEMBER_ALREADY_EXISTS"
        );
      }
      const now = nowIso();
      grantMachineAccess(row.machine_id, row.user_id, "APPLICATION", auth.user.id);
      const changed = db
        .prepare(
          `UPDATE machine_access_requests SET
             status = 'APPROVED', version = version + 1,
             reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING' AND version = ?`
        )
        .run(auth.user.id, now, now, id, expectedVersion);
      if (!changed.changes) {
        throw new BusinessError(
          "该申请已由其他管理员处理，审批列表已刷新",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
        );
      }
      addAudit(
        auth.user.id,
        "MACHINE_ACCESS_REQUEST_APPROVE",
        "machine_access_request",
        id,
        undefined,
        { userId: row.user_id, machineId: row.machine_id }
      );
      approved = {
        userId: row.user_id,
        machineId: row.machine_id,
        machineName: row.machine_name
      };
    });
    createNotification(
      approved!.userId,
      "MACHINE_ACCESS_GRANTED",
      "机器使用权申请已通过",
      `你现在可以使用 ${approved!.machineName}。`,
      "/calendar"
    );
    publishRevision(getScheduleRevision());
    return { message: "使用权申请已通过" };
  });

  app.post("/api/v1/admin/machine-access/requests/:id/reject", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        expectedVersion: z.number().int().min(1),
        reason: z.string().trim().max(500).optional().default("")
      })
      .parse(request.body);
    let rejected: { userId: string; machineName: string } | undefined;
    withImmediateTransaction(() => {
      const row = db
        .prepare(
          `SELECT mar.*, m.name AS machine_name
           FROM machine_access_requests mar
           JOIN machines m ON m.id = mar.machine_id
           WHERE mar.id = ?`
        )
        .get(id) as Record<string, any> | undefined;
      if (!row || !canManageMachine(auth.user.id, auth.user.role, row.machine_id)) {
        throw new BusinessError("无权处理这条申请", 403);
      }
      const now = nowIso();
      const changed = db
        .prepare(
          `UPDATE machine_access_requests SET
             status = 'REJECTED', version = version + 1, review_reason = ?,
             reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING' AND version = ?`
        )
        .run(body.reason, auth.user.id, now, now, id, body.expectedVersion);
      if (!changed.changes) {
        throw new BusinessError(
          "该申请已由其他管理员处理，审批列表已刷新",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
        );
      }
      addAudit(
        auth.user.id,
        "MACHINE_ACCESS_REQUEST_REJECT",
        "machine_access_request",
        id,
        undefined,
        { reasonProvided: Boolean(body.reason) }
      );
      bumpMachineAccessRevision();
      bumpScheduleRevision();
      rejected = { userId: row.user_id, machineName: row.machine_name };
    });
    createNotification(
      rejected!.userId,
      "MACHINE_ACCESS_REJECTED",
      "机器使用权申请未通过",
      body.reason
        ? `${rejected!.machineName}：${body.reason}`
        : "机器使用权申请未通过。",
      "/resources"
    );
    publishRevision(getScheduleRevision());
    return { message: "使用权申请已拒绝" };
  });

  app.delete("/api/v1/admin/machines/:id/members/:userId", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const { userId } = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    const target = db
      .prepare(
        `SELECT u.display_name,
           CASE WHEN ma.user_id IS NULL THEN 0 ELSE 1 END AS is_manager
         FROM machine_access_memberships mam
         JOIN users u ON u.id = mam.user_id
         LEFT JOIN machine_admins ma
           ON ma.machine_id = mam.machine_id AND ma.user_id = mam.user_id
         WHERE mam.machine_id = ? AND mam.user_id = ?`
      )
      .get(auth.machineId, userId) as
      | { display_name: string; is_manager: number }
      | undefined;
    if (!target) return reply.code(404).send({ error: "该用户没有这台机器的使用权" });
    if (target.is_manager && auth.user.role !== "SYSTEM_ADMIN") {
      return reply.code(403).send({ error: "只有系统管理员可以移除机器管理员" });
    }
    let impact!: ReturnType<typeof removeMachineMembership>;
    withImmediateTransaction(() => {
      impact = removeMachineMembership(
        auth.machineId,
        userId,
        auth.user.id,
        "机器管理员移除使用权"
      );
    });
    const machine = db
      .prepare("SELECT name FROM machines WHERE id = ?")
      .get(auth.machineId) as { name: string };
    createNotification(
      userId,
      "MACHINE_ACCESS_REMOVED",
      "机器使用权已被移除",
      `你已被移出 ${machine.name}，相关当前占用和未来占用已经释放。`,
      "/reservations"
    );
    publishRevision(getScheduleRevision());
    return {
      message: `${target.display_name} 已被移出机器`,
      impact: {
        activeReservations: impact.activeReservations,
        futureReservations: impact.futureReservations
      }
    };
  });

  app.get("/api/v1/admin/machines/:id/resource-pools", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    return { pools: listResourcePools(auth.machineId) };
  });

  app.put(
    "/api/v1/admin/machines/:id/resource-configuration",
    async (request, reply) => {
      const { id: machineId } = z.object({ id: z.string().uuid() }).parse(request.params);
      const auth = requireMachineManagerForId(request, reply, machineId);
      if (!auth) return;
      const body = resourceConfigurationSchema.parse(request.body);
      try {
        const revision = withImmediateTransaction(() => {
          const currentPools = listResourcePools(machineId);
          const currentGroupRows = db
            .prepare(
              `SELECT * FROM resource_groups
               WHERE machine_id = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM deleted_resource_group_tombstones drgt
                   WHERE drgt.resource_group_id = resource_groups.id
                 )`
            )
            .all(machineId) as Array<Record<string, unknown>>;
          const currentGroups = currentGroupRows.map(mapResourceGroup);
          const submittedPoolIds = new Set(body.pools.map((pool) => pool.id));
          const submittedGroupIds = new Set(body.groups.map((group) => group.id));
          const deletedPoolVersions = new Map(
            body.deletedPools.map((pool) => [pool.id, pool.expectedVersion])
          );

          if (
            deletedPoolVersions.size !== body.deletedPools.length ||
            body.deletedPools.some((pool) => submittedPoolIds.has(pool.id)) ||
            currentPools.some(
              (pool) =>
                !submittedPoolIds.has(pool.id) &&
                !deletedPoolVersions.has(pool.id)
            ) ||
            currentGroups.some((group) => !submittedGroupIds.has(group.id))
          ) {
            throw new BusinessError(
              "资源配置已由其他管理员更新，请刷新后重试",
              409,
              undefined,
              "RESOURCE_CONFIGURATION_STALE"
            );
          }

          const currentPoolMap = new Map(currentPools.map((pool) => [pool.id, pool]));
          for (const pool of body.pools) {
            const current = currentPoolMap.get(pool.id);
            if (current) {
              if (
                pool.expectedVersion !== current.version ||
                pool.kind !== current.kind
              ) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_STALE"
                );
              }
            } else {
              const collision = db
                .prepare("SELECT 1 FROM resource_pools WHERE id = ?")
                .get(pool.id);
              if (pool.expectedVersion !== 0 || collision) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_STALE"
                );
              }
            }
          }

          for (const deletedPool of body.deletedPools) {
            const current = currentPoolMap.get(deletedPool.id);
            if (
              !current ||
              current.version !== deletedPool.expectedVersion
            ) {
              throw new BusinessError(
                "资源配置已由其他管理员更新，请刷新后重试",
                409,
                undefined,
                "RESOURCE_CONFIGURATION_STALE"
              );
            }
          }

          const currentGroupMap = new Map(
            currentGroups.map((group) => [group.id, group])
          );
          for (const group of body.groups) {
            const current = currentGroupMap.get(group.id);
            if (current) {
              if (group.expectedVersion !== current.version) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_STALE"
                );
              }
            } else {
              const collision = db
                .prepare("SELECT 1 FROM resource_groups WHERE id = ?")
                .get(group.id);
              if (group.expectedVersion !== 0 || collision) {
                throw new BusinessError(
                  "资源配置已由其他管理员更新，请刷新后重试",
                  409,
                  undefined,
                  "RESOURCE_CONFIGURATION_STALE"
                );
              }
            }
          }

          const resolvedGroups = validateResourceConfiguration(body);
          const now = nowIso();
          db.prepare(
            `DELETE FROM resource_group_allocations
             WHERE resource_group_id IN (
               SELECT id FROM resource_groups WHERE machine_id = ?
             )`
          ).run(machineId);

          for (const deletedPool of body.deletedPools) {
            const current = currentPoolMap.get(deletedPool.id)!;
            tombstoneResourcePool(
              deletedPool.id,
              machineId,
              auth.user.id
            );
            addAudit(
              auth.user.id,
              "RESOURCE_POOL_DELETE",
              "resource_pool",
              deletedPool.id,
              undefined,
              { name: current.name }
            );
          }

          for (const pool of body.pools) {
            const current = currentPoolMap.get(pool.id);
            const nextVersion = current ? current.version + 1 : 1;
            if (current) {
              db.prepare(
                `UPDATE resource_pools SET
                  name = ?, sharing_mode = ?, unit = ?, description = ?, sort_order = ?,
                  range_start = ?, range_end = ?, capacity_milli = ?,
                  version = ?, updated_at = ?
                 WHERE id = ?`
              ).run(
                pool.name,
                pool.sharingMode,
                pool.unit,
                pool.description,
                pool.sortOrder,
                pool.kind === "INDEX_RANGE" ? pool.rangeStart : null,
                pool.kind === "INDEX_RANGE" ? pool.rangeEnd : null,
                pool.kind === "CAPACITY"
                  ? Math.round(pool.capacity * 1000)
                  : null,
                nextVersion,
                now,
                pool.id
              );
            } else {
              db.prepare(
                `INSERT INTO resource_pools(
                  id, machine_id, name, kind, sharing_mode, unit, description, sort_order,
                  range_start, range_end, capacity_milli, version,
                  created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
              ).run(
                pool.id,
                machineId,
                pool.name,
                pool.kind,
                pool.sharingMode,
                pool.unit,
                pool.description,
                pool.sortOrder,
                pool.kind === "INDEX_RANGE" ? pool.rangeStart : null,
                pool.kind === "INDEX_RANGE" ? pool.rangeEnd : null,
                pool.kind === "CAPACITY"
                  ? Math.round(pool.capacity * 1000)
                  : null,
                now,
                now
              );
            }

            if (pool.kind === "ITEM_LIST") {
              const requestedIds = new Set(pool.items.map((item) => item.id));
              for (const [index, item] of pool.items.entries()) {
                const existingItem = db
                  .prepare(
                    "SELECT pool_id FROM resource_pool_items WHERE id = ?"
                  )
                  .get(item.id) as { pool_id: string } | undefined;
                if (existingItem && existingItem.pool_id !== pool.id) {
                  throw new BusinessError(
                    "设备配置已由其他管理员更新，请刷新后重试",
                    409,
                    undefined,
                    "RESOURCE_CONFIGURATION_STALE"
                  );
                }
                if (existingItem) {
                  db.prepare(
                    `UPDATE resource_pool_items SET
                      item_key = ?, label = ?, sort_order = ?, updated_at = ?
                     WHERE id = ? AND pool_id = ?`
                  ).run(
                    item.key,
                    item.label,
                    index,
                    now,
                    item.id,
                    pool.id
                  );
                } else {
                  db.prepare(
                    `INSERT INTO resource_pool_items(
                      id, pool_id, item_key, label, sort_order, created_at, updated_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?)`
                  ).run(
                    item.id,
                    pool.id,
                    item.key,
                    item.label,
                    index,
                    now,
                    now
                  );
                }
              }
              if (current?.kind === "ITEM_LIST") {
                for (const item of current.items) {
                  if (!requestedIds.has(item.id)) {
                    db.prepare(
                      "DELETE FROM resource_pool_items WHERE id = ?"
                    ).run(item.id);
                  }
                }
              }
            }

            const updated = getResourcePool(pool.id)!;
            insertPoolRevision(
              pool.id,
              nextVersion,
              resourcePoolConfiguration(updated),
              auth.user.id
            );
            addAudit(
              auth.user.id,
              current ? "RESOURCE_POOL_UPDATE" : "RESOURCE_POOL_CREATE",
              "resource_pool",
              pool.id,
              current ? resourcePoolConfiguration(current) : undefined,
              resourcePoolConfiguration(updated)
            );
          }

          const allocationSignature = (
            allocations: ReturnType<typeof mapResourceGroup>["allocations"]
          ) =>
            JSON.stringify(
              allocations.map((allocation) => {
                if (allocation.kind === "INDEX_RANGE") {
                  return {
                    poolId: allocation.poolId,
                    kind: allocation.kind,
                    sharingMode: allocation.sharingMode,
                    ranges: allocation.ranges
                  };
                }
                if (allocation.kind === "ITEM_LIST") {
                  return {
                    poolId: allocation.poolId,
                    kind: allocation.kind,
                    sharingMode: allocation.sharingMode,
                    itemIds: allocation.items.map((item) => item.id)
                  };
                }
                return {
                  poolId: allocation.poolId,
                  kind: allocation.kind,
                  sharingMode: allocation.sharingMode,
                  quantity: allocation.quantity
                };
              })
            );

          for (const group of body.groups) {
            const current = currentGroupMap.get(group.id);
            const allocations = resolvedGroups.get(group.id)!;
            const nextVersion = current ? current.version + 1 : 1;
            if (current) {
              db.prepare(
                `UPDATE resource_groups SET
                  name = ?, description = ?, tags_json = ?, sort_order = ?,
                  version = ?, updated_at = ?
                 WHERE id = ?`
              ).run(
                group.name,
                group.description,
                JSON.stringify(group.tags),
                group.sortOrder,
                nextVersion,
                now,
                group.id
              );
            } else {
              db.prepare(
                `INSERT INTO resource_groups(
                  id, machine_id, name, description, tags_json, sort_order,
                  version, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`
              ).run(
                group.id,
                machineId,
                group.name,
                group.description,
                JSON.stringify(group.tags),
                group.sortOrder,
                now,
                now
              );
            }
            replaceGroupAllocations(group.id, allocations);
            const configuration = groupConfiguration(
              group.name,
              group.description,
              group.tags,
              allocations,
              group.sortOrder
            );
            insertGroupRevision(
              group.id,
              nextVersion,
              configuration,
              auth.user.id
            );
            const resourcesChanged =
              !current ||
              allocationSignature(current.allocations) !==
                allocationSignature(allocations);
            if (current && resourcesChanged) {
              const affected = db
                .prepare(
                  `SELECT DISTINCT r.user_id
                   FROM reservations r
                   WHERE r.resource_group_id = ?
                     AND r.status = 'CONFIRMED' AND r.end_at > ?`
                )
                .all(group.id, now) as Array<{ user_id: string }>;
              for (const user of affected) {
                createNotification(
                  user.user_id,
                  "RESOURCE_GROUP_CHANGED",
                  "资源组配置已调整",
                  `${group.name} 的资源已从“${current.resourceSummary}”调整为“${configuration.resourceSummary}”。你的未结束占用仍然有效，并立即采用新配置。`,
                  "/reservations"
                );
              }
            }
            addAudit(
              auth.user.id,
              current ? "RESOURCE_GROUP_UPDATE" : "RESOURCE_GROUP_CREATE",
              "resource_group",
              group.id,
              current
                ? groupConfiguration(
                    current.name,
                    current.description,
                    current.tags,
                    current.allocations,
                    current.sortOrder
                  )
                : undefined,
              configuration
            );
          }
          return bumpScheduleRevision();
        });
        publishRevision(revision);
        return { message: "资源配置已保存", revision };
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          return reply.code(409).send({
            error: "资源项名称、资源组名称或设备标识不能重复"
          });
        }
        throw error;
      }
    }
  );

  app.post("/api/v1/admin/machines/:id/resource-pools", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const body = resourcePoolSchema.parse(request.body);
    const id = randomUUID();
    const now = nowIso();
    try {
      withImmediateTransaction(() => {
        db.prepare(
          `INSERT INTO resource_pools(
            id, machine_id, name, kind, sharing_mode, unit, description, sort_order,
            range_start, range_end, capacity_milli, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          auth.machineId,
          body.name,
          body.kind,
          body.sharingMode,
          body.unit,
          body.description,
          body.sortOrder,
          body.kind === "INDEX_RANGE" ? body.rangeStart : null,
          body.kind === "INDEX_RANGE" ? body.rangeEnd : null,
          body.kind === "CAPACITY" ? Math.round(body.capacity * 1000) : null,
          now,
          now
        );
        if (body.kind === "ITEM_LIST") {
          const seen = new Set<string>();
          const insert = db.prepare(
            `INSERT INTO resource_pool_items(
              id, pool_id, item_key, label, sort_order, created_at, updated_at
            ) VALUES(?, ?, ?, ?, ?, ?, ?)`
          );
          body.items.forEach((item, index) => {
            const key = item.key.toLocaleLowerCase();
            if (seen.has(key)) throw new BusinessError("设备标识不能重复");
            seen.add(key);
            insert.run(randomUUID(), id, item.key, item.label, index, now, now);
          });
        }
        const pool = getResourcePool(id)!;
        insertPoolRevision(
          id,
          1,
          resourcePoolConfiguration(pool),
          auth.user.id
        );
        addAudit(
          auth.user.id,
          "RESOURCE_POOL_CREATE",
          "resource_pool",
          id,
          undefined,
          resourcePoolConfiguration(pool)
        );
        bumpScheduleRevision();
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "同一机器内资源项名称或设备标识不能重复" });
      }
      throw error;
    }
    publishRevision(getScheduleRevision());
    return reply.code(201).send({ id });
  });

  app.get("/api/v1/admin/resource-pools/:id/revisions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pool = getResourcePool(id);
    if (!pool) return reply.code(404).send({ error: "资源项不存在" });
    const auth = requireMachineManagerForId(request, reply, pool.machineId);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT r.*, u.display_name AS changed_by_name
         FROM resource_pool_revisions r
         LEFT JOIN users u ON u.id = r.changed_by
         WHERE r.resource_pool_id = ?
         ORDER BY r.version DESC`
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        configuration: JSON.parse(String(row.configuration_json)),
        changedByName: row.changed_by_name ?? "系统",
        createdAt: row.created_at
      }))
    };
  });

  app.patch("/api/v1/admin/resource-pools/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = getResourcePool(id);
    if (!current) return reply.code(404).send({ error: "资源项不存在" });
    const auth = requireMachineManagerForId(request, reply, current.machineId);
    if (!auth) return;
    const expectedVersion = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body).expectedVersion;
    const body = resourcePoolSchema.parse(request.body);
    if (body.kind !== current.kind) {
      return reply.code(409).send({ error: "资源项的分配方式不能修改" });
    }
    try {
      withImmediateTransaction(() => {
        const fresh = getResourcePool(id);
        if (!fresh || fresh.version !== expectedVersion) {
          throw new BusinessError("资源项已由其他管理员更新，请刷新后重试", 409);
        }
        if (body.kind === "INDEX_RANGE" && current.kind === "INDEX_RANGE") {
          const claim = db
            .prepare(
              `SELECT g.name, r.range_start, r.range_end
               FROM resource_group_allocation_ranges r
               JOIN resource_group_allocations a ON a.id = r.allocation_id
               JOIN resource_groups g ON g.id = a.resource_group_id
               WHERE a.resource_pool_id = ?
                 AND (r.range_start < ? OR r.range_end > ?)
               LIMIT 1`
            )
            .get(id, body.rangeStart, body.rangeEnd) as
            | { name: string; range_start: number; range_end: number }
            | undefined;
          if (claim) {
            throw new BusinessError(
              `缩小编号范围会影响 ${claim.name}（${claim.range_start}–${claim.range_end}）`,
              409
            );
          }
        }
        if (
          body.kind === "CAPACITY" &&
          current.kind === "CAPACITY" &&
          body.sharingMode === "EXCLUSIVE"
        ) {
          const allocated = db
            .prepare(
              `SELECT COALESCE(SUM(a.quantity_milli), 0) AS total
               FROM resource_group_allocations a
               JOIN resource_groups g ON g.id = a.resource_group_id
               WHERE a.resource_pool_id = ?`
            )
            .get(id) as { total: number };
          if (Number(allocated.total) > body.capacity * 1000) {
            throw new BusinessError("降低容量会影响现有资源组", 409);
          }
        }
        if (body.kind === "ITEM_LIST" && current.kind === "ITEM_LIST") {
          const requestedIds = new Set(
            body.items.flatMap((item) => (item.id ? [item.id] : []))
          );
          for (const item of current.items.filter(
            (candidate) => !requestedIds.has(candidate.id)
          )) {
            const allocation = db
              .prepare(
                `SELECT g.name
                 FROM resource_group_allocation_items ai
                 JOIN resource_group_allocations a ON a.id = ai.allocation_id
                 JOIN resource_groups g ON g.id = a.resource_group_id
                 WHERE ai.item_id = ?
                 LIMIT 1`
              )
              .get(item.id) as { name: string } | undefined;
            if (allocation) {
              throw new BusinessError(
                `删除设备 ${item.key} 会影响 ${allocation.name}`,
                409
              );
            }
          }
        }
        db.prepare(
          `UPDATE resource_pools SET
            name = ?, sharing_mode = ?, unit = ?, description = ?, sort_order = ?,
            range_start = ?, range_end = ?, capacity_milli = ?,
            version = version + 1, updated_at = ?
           WHERE id = ?`
        ).run(
          body.name,
          body.sharingMode,
          body.unit,
          body.description,
          body.sortOrder,
          body.kind === "INDEX_RANGE" ? body.rangeStart : null,
          body.kind === "INDEX_RANGE" ? body.rangeEnd : null,
          body.kind === "CAPACITY" ? Math.round(body.capacity * 1000) : null,
          nowIso(),
          id
        );
        if (
          body.kind === "CAPACITY" &&
          body.sharingMode === "SHARED"
        ) {
          db.prepare(
            `UPDATE resource_group_allocations
             SET quantity_milli = ?
             WHERE resource_pool_id = ?`
          ).run(Math.round(body.capacity * 1000), id);
        }
        if (body.kind === "ITEM_LIST") {
          const now = nowIso();
          const requestedIds = new Set<string>();
          const keys = new Set<string>();
          body.items.forEach((item, index) => {
            const normalizedKey = item.key.toLocaleLowerCase();
            if (keys.has(normalizedKey)) {
              throw new BusinessError("设备标识不能重复");
            }
            keys.add(normalizedKey);
            const itemId = item.id ?? randomUUID();
            requestedIds.add(itemId);
            if (item.id) {
              const result = db.prepare(
                `UPDATE resource_pool_items SET
                  item_key = ?, label = ?, sort_order = ?,
                  updated_at = ?
                 WHERE id = ? AND pool_id = ?`
              ).run(item.key, item.label, index, now, item.id, id);
              if (!result.changes) {
                throw new BusinessError("设备列表已更新，请刷新后重试", 409);
              }
            } else {
              db.prepare(
                `INSERT INTO resource_pool_items(
                  id, pool_id, item_key, label, sort_order, created_at, updated_at
                ) VALUES(?, ?, ?, ?, ?, ?, ?)`
              ).run(itemId, id, item.key, item.label, index, now, now);
            }
          });
          for (const item of current.items) {
            if (!requestedIds.has(item.id)) {
              db.prepare("DELETE FROM resource_pool_items WHERE id = ?").run(item.id);
            }
          }
        }
        const updated = getResourcePool(id)!;
        insertPoolRevision(
          id,
          updated.version,
          resourcePoolConfiguration(updated),
          auth.user.id
        );
        addAudit(
          auth.user.id,
          "RESOURCE_POOL_UPDATE",
          "resource_pool",
          id,
          resourcePoolConfiguration(current),
          resourcePoolConfiguration(updated)
        );
        bumpScheduleRevision();
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "同一机器内资源项名称或设备标识不能重复" });
      }
      throw error;
    }
    publishRevision(getScheduleRevision());
    return { message: "资源项已更新" };
  });

  app.delete("/api/v1/admin/resource-pools/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const pool = getResourcePool(id);
    if (!pool) return reply.code(404).send({ error: "资源项不存在" });
    const auth = requireMachineManagerForId(request, reply, pool.machineId);
    if (!auth) return;
    const expectedVersion = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body).expectedVersion;
    const result = withImmediateTransaction(() => {
      const usedBy = db
        .prepare(
          `SELECT DISTINCT g.name
           FROM resource_group_allocations a
           JOIN resource_groups g ON g.id = a.resource_group_id
           WHERE a.resource_pool_id = ?
           ORDER BY g.name`
        )
        .all(id) as Array<{ name: string }>;
      if (usedBy.length) {
        throw new BusinessError(
          `该资源项仍被以下资源组使用：${usedBy.map((group) => group.name).join("、")}`,
          409,
          { resourceGroups: usedBy.map((group) => group.name) },
          "RESOURCE_POOL_IN_USE"
        );
      }
      const fresh = getResourcePool(id);
      if (!fresh || fresh.version !== expectedVersion) {
        throw new BusinessError("资源项已更新，请刷新后重试", 409);
      }
      tombstoneResourcePool(id, pool.machineId, auth.user.id);
      addAudit(
        auth.user.id,
        "RESOURCE_POOL_DELETE",
        "resource_pool",
        id,
        undefined,
        { name: pool.name }
      );
      return bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(result);
    return { deleted: true };
  });

  app.get("/api/v1/admin/machines/:id/groups", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT * FROM resource_groups WHERE machine_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deleted_resource_group_tombstones drgt
             WHERE drgt.resource_group_id = resource_groups.id
           )
         ORDER BY sort_order, name`
        )
        .all(auth.machineId) as Array<Record<string, unknown>>;
    const now = nowIso();
    return {
      groups: rows.map((row) => {
        const group = mapResourceGroup(row);
        const visibleGroup = auth.canManage
          ? group
          : (({ version: _version, ...visible }) => visible)(group);
        return {
          ...visibleGroup,
          scheduledUnavailabilityCount: countRows(
            `SELECT COUNT(*) AS count FROM resource_unavailability
             WHERE resource_group_id = ? AND kind = 'PLANNED'
               AND status = 'ACTIVE' AND start_at > ?`,
            row.id,
            now
          ),
          hasCurrentPlannedUnavailability: Boolean(
            countRows(
              `SELECT COUNT(*) AS count FROM resource_unavailability
               WHERE resource_group_id = ? AND kind = 'PLANNED'
                 AND status = 'ACTIVE' AND start_at <= ? AND end_at > ?`,
              row.id,
              now,
              now
            )
          )
        };
      })
    };
  });

  app.post("/api/v1/admin/machines/:id/groups", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const body = resourceGroupSchema.parse(request.body);
    const requestedSortOrder =
      (request.body as { sortOrder?: unknown } | null)?.sortOrder;
    const id = randomUUID();
    const now = nowIso();
    try {
      withImmediateTransaction(() => {
        const duplicate = db
          .prepare(
            "SELECT 1 FROM resource_groups WHERE machine_id = ? AND name = ?"
          )
          .get(auth.machineId, body.name);
        if (duplicate) {
          throw new BusinessError("同一机器内资源组名称不能重复", 409);
        }
        const allocations = validateAndResolveGroupAllocations(
          auth.machineId,
          body.allocations
        );
        const sortOrder =
          typeof requestedSortOrder === "number"
            ? body.sortOrder
            : Number(
                (
                  db.prepare(
                    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next
                     FROM resource_groups WHERE machine_id = ?`
                  ).get(auth.machineId) as { next: number }
                ).next
              );
        db.prepare(
          `INSERT INTO resource_groups(
            id, machine_id, name, description, tags_json, sort_order,
            created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          auth.machineId,
          body.name,
          body.description,
          JSON.stringify(body.tags),
          sortOrder,
          now,
          now
        );
        replaceGroupAllocations(id, allocations);
        const configuration = groupConfiguration(
          body.name,
          body.description,
          body.tags,
          allocations,
          sortOrder
        );
        insertGroupRevision(id, 1, configuration, auth.user.id);
        addAudit(
          auth.user.id,
          "RESOURCE_GROUP_CREATE",
          "resource_group",
          id,
          undefined,
          configuration
        );
        bumpScheduleRevision();
      });
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "同一机器内资源组名称不能重复" });
      }
      throw error;
    }
    publishRevision(getScheduleRevision());
    return reply.code(201).send({ id });
  });

  app.get("/api/v1/admin/groups/:id/revisions", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id) as
      | { machine_id: string }
      | undefined;
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT r.*, u.display_name AS changed_by_name
         FROM resource_group_revisions r
         LEFT JOIN users u ON u.id = r.changed_by
         WHERE r.resource_group_id = ?
         ORDER BY r.version DESC`
      )
      .all(id) as Array<Record<string, unknown>>;
    return {
      revisions: rows.map((row) => ({
        id: row.id,
        version: row.version,
        configuration: JSON.parse(String(row.configuration_json)),
        changedByName: row.changed_by_name ?? "系统",
        createdAt: row.created_at
      }))
    };
  });

  app.patch("/api/v1/admin/groups/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const current = getCurrentResourceGroupRow(id);
    if (!current) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, current.machine_id);
    if (!auth) return;
    const body = resourceGroupSchema.parse(request.body);
    const sortOrder =
      typeof (request.body as { sortOrder?: unknown } | null)?.sortOrder ===
      "number"
        ? body.sortOrder
        : Number(current.sort_order ?? 0);
    if (body.expectedVersion === undefined) {
      return reply.code(400).send({ error: "缺少资源组配置版本" });
    }
    const beforeGroup = mapResourceGroup(current);
    withImmediateTransaction(() => {
      const fresh = getCurrentResourceGroupRow(id);
      if (!fresh || Number(fresh.version) !== body.expectedVersion) {
        throw new BusinessError("资源组已由其他管理员更新，请刷新后重试", 409);
      }
      const duplicate = db
        .prepare(
          `SELECT 1 FROM resource_groups
           WHERE machine_id = ? AND name = ? AND id != ?`
        )
        .get(current.machine_id, body.name, id);
      if (duplicate) {
        throw new BusinessError("同一机器内资源组名称不能重复", 409);
      }
      const allocations = validateAndResolveGroupAllocations(
        String(current.machine_id),
        body.allocations,
        id
      );
      const version = Number(current.version) + 1;
      db.prepare(
        `UPDATE resource_groups SET
          name = ?, description = ?, tags_json = ?, sort_order = ?,
          version = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        body.name,
        body.description,
        JSON.stringify(body.tags),
        sortOrder,
        version,
        nowIso(),
        id
      );
      replaceGroupAllocations(id, allocations);
      const configuration = groupConfiguration(
        body.name,
        body.description,
        body.tags,
        allocations,
        sortOrder
      );
      insertGroupRevision(id, version, configuration, auth.user.id);
      const resourcesChanged =
        JSON.stringify(beforeGroup.allocations) !== JSON.stringify(allocations);
      if (resourcesChanged) {
        const affected = db
          .prepare(
            `SELECT DISTINCT r.user_id, u.display_name
             FROM reservations r JOIN users u ON u.id = r.user_id
             WHERE r.resource_group_id = ? AND r.status = 'CONFIRMED' AND r.end_at > ?`
          )
          .all(id, nowIso()) as Array<{ user_id: string; display_name: string }>;
        for (const user of affected) {
          createNotification(
            user.user_id,
            "RESOURCE_GROUP_CHANGED",
            "资源组配置已调整",
            `${body.name} 的资源已从“${beforeGroup.resourceSummary}”调整为“${configuration.resourceSummary}”。你的未结束占用仍然有效，并立即采用新配置。`,
            "/reservations"
          );
        }
      }
      addAudit(
        auth.user.id,
        "RESOURCE_GROUP_UPDATE",
        "resource_group",
        id,
        groupConfiguration(
          beforeGroup.name,
          beforeGroup.description,
          beforeGroup.tags,
          beforeGroup.allocations,
          beforeGroup.sortOrder
        ),
        configuration
      );
      bumpScheduleRevision();
    });
    publishRevision(getScheduleRevision());
    return { message: "资源组已更新" };
  });

  app.post(
    "/api/v1/admin/groups/:id/unavailability/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      const body = plannedUnavailabilityPreviewSchema.parse(request.body);
      return previewUnavailability(
        "RESOURCE_GROUP",
        id,
        body.startAt,
        body.endAt
      );
    }
  );

  app.get(
    "/api/v1/admin/groups/:id/unavailability",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      return {
        unavailability: listUnavailability(target.machineId, id)
      };
    }
  );

  app.post(
    "/api/v1/admin/groups/:id/unavailability",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      const body = plannedUnavailabilitySchema.parse(request.body);
      const result = createPlannedUnavailability({
        type: "RESOURCE_GROUP",
        id,
        startAt: body.startAt,
        endAt: body.endAt,
        reason: body.reason,
        expectedRevision: body.expectedRevision,
        actorUserId: auth.user.id
      });
      publishRevision(result.revision);
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/v1/admin/groups/:id/disable/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      return previewLongTermDisable("RESOURCE_GROUP", id);
    }
  );

  app.post("/api/v1/admin/groups/:id/disable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id);
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const body = longDisableSchema.parse(request.body);
    const result = disableLongTerm({
      type: "RESOURCE_GROUP",
      id,
      expectedVersion: body.expectedVersion,
      expectedRevision: body.expectedRevision,
      reason: body.reason,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.post("/api/v1/admin/groups/:id/enable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id);
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    const result = enableTarget({
      type: "RESOURCE_GROUP",
      id,
      expectedVersion,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.get("/api/v1/admin/groups/:id/deletion-impact", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
    const auth = requireMachineManagerForId(request, reply, target.machineId);
    if (!auth) return;
    return { group: target, counts: resourceGroupDeleteImpact(id) };
  });

  app.delete("/api/v1/admin/groups/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id);
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    if (group.status !== "DISABLED") {
      return reply.code(409).send({ error: "请先停用资源组，再进行删除" });
    }
    withImmediateTransaction(() => {
      const fresh = getCurrentResourceGroupRow(id) as
        | { version: number; status: string }
        | undefined;
      if (
        !fresh ||
        fresh.status !== "DISABLED" ||
        fresh.version !== expectedVersion
      ) {
        throw new BusinessError("资源组已更新，请刷新后重试", 409);
      }
      const counts = resourceGroupDeleteImpact(id);
      notifyDeletedResourceGroupUsers(id, String(group.name));
      deleteResourceGroupRecords(id, auth.user.id, counts);
      addAudit(auth.user.id, "RESOURCE_GROUP_DELETE", "resource_group", id, undefined, {
        name: group.name,
        counts
      });
      bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(getScheduleRevision());
    return { deleted: true };
  });

  app.post(
    "/api/v1/admin/machines/:id/unavailability/preview",
    async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = plannedUnavailabilityPreviewSchema.parse(request.body);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    return previewUnavailability("MACHINE", id, body.startAt, body.endAt);
  }
  );

  app.get("/api/v1/admin/machines/:id/unavailability", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    return {
      unavailability: listUnavailability(auth.machineId).filter(
        (item) => item.resourceGroupId === null
      )
    };
  });

  app.post("/api/v1/admin/machines/:id/unavailability", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = plannedUnavailabilitySchema.parse(request.body);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    const result = createPlannedUnavailability({
      type: "MACHINE",
      id,
      startAt: body.startAt,
      endAt: body.endAt,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return reply.code(201).send(result);
  });

  app.get("/api/v1/admin/machines/:id/maintenance", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    return {
      maintenance: listUnavailability(auth.machineId).filter(
        (item) => item.kind === "PLANNED"
      )
    };
  });

  app.post(
    "/api/v1/admin/machines/:id/maintenance/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = maintenancePreviewSchema.parse(request.body);
      const auth = requireMachineManagerForId(request, reply, id);
      if (!auth) return;
      if (body.resourceGroupId) {
        const target = resolveUnavailabilityTarget(
          "RESOURCE_GROUP",
          body.resourceGroupId
        );
        if (target.machineId !== id) {
          return reply.code(400).send({ error: "资源组不属于当前机器" });
        }
        return previewUnavailability(
          "RESOURCE_GROUP",
          body.resourceGroupId,
          body.startAt,
          body.endAt
        );
      }
      return previewUnavailability("MACHINE", id, body.startAt, body.endAt);
    }
  );

  app.post("/api/v1/admin/machines/:id/maintenance", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = maintenanceSchema.parse(request.body);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    let type: "MACHINE" | "RESOURCE_GROUP" = "MACHINE";
    let targetId = id;
    if (body.resourceGroupId) {
      const target = resolveUnavailabilityTarget(
        "RESOURCE_GROUP",
        body.resourceGroupId
      );
      if (target.machineId !== id) {
        return reply.code(400).send({ error: "资源组不属于当前机器" });
      }
      type = "RESOURCE_GROUP";
      targetId = body.resourceGroupId;
    }
    const result = createPlannedUnavailability({
      type,
      id: targetId,
      startAt: body.startAt,
      endAt: body.endAt,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return reply.code(201).send(result);
  });

  app.delete("/api/v1/admin/maintenance/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const window = db
      .prepare("SELECT * FROM resource_unavailability WHERE id = ?")
      .get(id) as Record<string, any> | undefined;
    if (!window || window.kind !== "PLANNED") {
      return reply.code(404).send({ error: "维护安排不存在" });
    }
    const auth = requireMachineManagerForId(request, reply, window.machine_id);
    if (!auth) return;
    const result = cancelUnavailability(id, auth.user.id);
    publishRevision(result.revision);
    return { message: "维护安排已取消" };
  });

  app.delete("/api/v1/admin/unavailability/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const window = db
      .prepare("SELECT * FROM resource_unavailability WHERE id = ?")
      .get(id) as Record<string, any> | undefined;
    if (!window) return reply.code(404).send({ error: "维护安排不存在" });
    const auth = requireMachineManagerForId(request, reply, window.machine_id);
    if (!auth) return;
    const result = cancelUnavailability(id, auth.user.id);
    publishRevision(result.revision);
    return { message: "维护安排已取消" };
  });

  app.get("/api/v1/admin/smtp-settings", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    return smtpAdminPayload();
  });

  app.patch("/api/v1/admin/smtp-settings", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const body = smtpSettingsSchema.parse(request.body);
    const current = getSmtpSettingsRow();
    if (current.version !== body.expectedVersion) {
      return reply.code(409).send({
        error: "邮件配置已被其他管理员更新，请刷新后重试",
        code: "SMTP_SETTINGS_STALE"
      });
    }
    let encryptedPassword = current.password_encrypted;
    if (body.password) {
      encryptedPassword = encryptSmtpPassword(body.password);
    } else if (body.clearPassword) {
      encryptedPassword = null;
    }
    if (body.enabled && !encryptedPassword) {
      return reply.code(400).send({
        error: "启用邮件发送前请填写 SMTP 密码",
        code: "SMTP_PASSWORD_REQUIRED"
      });
    }
    const action =
      current.enabled && !body.enabled
        ? "SMTP_SETTINGS_DISABLE"
        : !current.enabled && body.enabled
          ? "SMTP_SETTINGS_ENABLE"
          : body.clearPassword
            ? "SMTP_PASSWORD_CLEAR"
            : "SMTP_SETTINGS_UPDATE";
    const now = nowIso();
    withImmediateTransaction(() => {
      const latest = getSmtpSettingsRow();
      if (latest.version !== body.expectedVersion) {
        throw new BusinessError(
          "邮件配置已被其他管理员更新，请刷新后重试",
          409
        );
      }
      db.prepare(
        `UPDATE smtp_settings SET
          enabled = ?, host = ?, port = ?, security = ?, username = ?,
          password_encrypted = ?, from_name = ?, from_address = ?,
          version = version + 1, last_test_status = NULL,
          last_test_error = '', last_tested_at = NULL, last_tested_by = NULL,
          updated_at = ?, updated_by = ?
         WHERE id = 1`
      ).run(
        body.enabled ? 1 : 0,
        body.host,
        body.port,
        body.security,
        body.username,
        encryptedPassword,
        body.fromName,
        body.fromAddress,
        now,
        auth.user.id
      );
      if (Boolean(latest.enabled) !== body.enabled) {
        incrementRegistrationConfigRevision(now);
      }
      if (!body.enabled) {
        db.prepare(
          `UPDATE email_outbox SET
             status = 'CANCELLED', cancelled_at = ?,
             cancellation_reason = '系统管理员停用了邮件发送',
             to_email = '[redacted]', html = '[redacted]'
           WHERE status IN ('PENDING', 'FAILED')`
        ).run(now);
      }
      addAudit(
        auth.user.id,
        action,
        "smtp_settings",
        "primary",
        {
          enabled: Boolean(current.enabled),
          host: current.host,
          port: current.port,
          security: current.security,
          username: current.username,
          fromName: current.from_name,
          fromAddress: current.from_address,
          hasPassword: Boolean(current.password_encrypted)
        },
        {
          enabled: body.enabled,
          host: body.host,
          port: body.port,
          security: body.security,
          username: body.username,
          fromName: body.fromName,
          fromAddress: body.fromAddress,
          passwordChanged: Boolean(body.password),
          passwordCleared: body.clearPassword
        }
      );
    });
    invalidateSmtpTransporter();
    return {
      message: body.enabled ? "邮件配置已保存并立即生效" : "邮件发送已停用",
      settings: smtpAdminPayload()
    };
  });

  app.post(
    "/api/v1/admin/smtp-settings/test",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { recipient } = z
        .object({ recipient: z.string().trim().email().max(254) })
        .parse(request.body);
      const testedAt = nowIso();
      try {
        await sendSmtpTest(recipient);
        db.prepare(
          `UPDATE smtp_settings SET
             last_test_status = 'SUCCESS', last_test_error = '',
             last_tested_at = ?, last_tested_by = ?
           WHERE id = 1`
        ).run(testedAt, auth.user.id);
        addAudit(
          auth.user.id,
          "SMTP_SETTINGS_TEST",
          "smtp_settings",
          "primary",
          undefined,
          { success: true }
        );
        return {
          message: "测试邮件已发送，请检查收件箱",
          testedAt
        };
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "SMTP 发送失败，请检查服务器配置";
        db.prepare(
          `UPDATE smtp_settings SET
             last_test_status = 'FAILED', last_test_error = ?,
             last_tested_at = ?, last_tested_by = ?
           WHERE id = 1`
        ).run(message, testedAt, auth.user.id);
        addAudit(
          auth.user.id,
          "SMTP_SETTINGS_TEST",
          "smtp_settings",
          "primary",
          undefined,
          { success: false }
        );
        return reply.code(502).send({
          error: message,
          code: "SMTP_TEST_FAILED"
        });
      }
    }
  );

  app.get("/api/v1/admin/settings", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    return getAdminSettings();
  });

  app.patch("/api/v1/admin/settings", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const body = z
      .object({
        minBookingMinutes: z.number().int().min(1).max(1440),
        maxBookingMinutes: z.number().int().min(1).max(10080),
        advanceDays: z.number().int().min(1).max(365),
        expectedVersion: z.number().int().min(1)
      })
      .refine((value) => value.maxBookingMinutes >= value.minBookingMinutes, {
        message: "最长时长不能小于最短时长"
      })
      .parse(request.body);
    const settings = withImmediateTransaction(() => {
      const before = getAdminSettings();
      if (before.version !== body.expectedVersion) {
        throw new BusinessError(
          "系统设置已由其他管理员更新，请刷新后重试",
          409,
          undefined,
          "SETTINGS_VERSION_CONFLICT"
        );
      }
      const updatedAt = nowIso();
      const upsert = db.prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`
      );
      upsert.run(
        "min_booking_minutes",
        String(body.minBookingMinutes),
        updatedAt
      );
      upsert.run(
        "max_booking_minutes",
        String(body.maxBookingMinutes),
        updatedAt
      );
      upsert.run("advance_days", String(body.advanceDays), updatedAt);
      upsert.run("settings_version", String(before.version + 1), updatedAt);
      const after = getAdminSettings();
      addAudit(
        auth.user.id,
        "SETTINGS_UPDATE",
        "settings",
        "booking",
        {
          minBookingMinutes: before.minBookingMinutes,
          maxBookingMinutes: before.maxBookingMinutes,
          advanceDays: before.advanceDays
        },
        {
          minBookingMinutes: after.minBookingMinutes,
          maxBookingMinutes: after.maxBookingMinutes,
          advanceDays: after.advanceDays
        }
      );
      return after;
    });
    return { message: "占用规则已更新", settings };
  });

  app.patch(
    "/api/v1/admin/settings/email-domains",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const body = z
        .object({
          allowedEmailDomains: z
            .array(z.string().trim().min(1).max(253))
            .max(100),
          expectedVersion: z.number().int().min(1)
        })
        .parse(request.body);
      let allowedEmailDomains: string[];
      try {
        allowedEmailDomains = normalizeAllowedEmailDomains(
          body.allowedEmailDomains
        );
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error
              ? error.message
              : "邮箱域名白名单格式不正确",
          code: "EMAIL_DOMAIN_VALIDATION_FAILED"
        });
      }
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (before.version !== body.expectedVersion) {
          throw new BusinessError(
            "系统设置已由其他管理员更新，请刷新后重试",
            409,
            undefined,
            "SETTINGS_VERSION_CONFLICT"
          );
        }
        const updatedAt = nowIso();
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'allowed_email_domains'`
        ).run(JSON.stringify(allowedEmailDomains), updatedAt);
        incrementRegistrationConfigRevision(updatedAt);
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'settings_version'`
        ).run(String(before.version + 1), updatedAt);
        const after = getAdminSettings();
        addAudit(
          auth.user.id,
          "EMAIL_DOMAIN_ALLOWLIST_UPDATE",
          "settings",
          "registration_email",
          { allowedEmailDomains: before.allowedEmailDomains },
          { allowedEmailDomains: after.allowedEmailDomains }
        );
        return after;
      });
      return {
        message: allowedEmailDomains.length
          ? "注册邮箱域名已更新"
          : "注册邮箱域名限制已取消",
        settings
      };
    }
  );

  app.patch(
    "/api/v1/admin/settings/registration-email",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const body = z
        .object({
          allowRegistrationWithoutEmail: z.boolean(),
          expectedVersion: z.number().int().min(1)
        })
        .parse(request.body);
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (before.version !== body.expectedVersion) {
          throw new BusinessError(
            "系统设置已由其他管理员更新，请刷新后重试",
            409,
            undefined,
            "SETTINGS_VERSION_CONFLICT"
          );
        }
        const updatedAt = nowIso();
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at`
        ).run(
          "allow_registration_without_email",
          body.allowRegistrationWithoutEmail ? "1" : "0",
          updatedAt
        );
        incrementRegistrationConfigRevision(updatedAt);
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'settings_version'`
        ).run(String(before.version + 1), updatedAt);
        const after = getAdminSettings();
        addAudit(
          auth.user.id,
          "REGISTRATION_EMAIL_POLICY_UPDATE",
          "settings",
          "registration_email",
          {
            allowRegistrationWithoutEmail:
              before.allowRegistrationWithoutEmail
          },
          {
            allowRegistrationWithoutEmail:
              after.allowRegistrationWithoutEmail
          }
        );
        return after;
      });
      return {
        message: body.allowRegistrationWithoutEmail
          ? "已允许注册时不填写邮箱"
          : "注册时必须填写邮箱",
        settings
      };
    }
  );

  app.patch(
    "/api/v1/admin/settings/site-profile",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const body = z
        .object({
          siteOrigin: z.string().trim().min(1).max(2048),
          icpFilingNumber: z.string().trim().max(100),
          publicSecurityFilingNumber: z.string().trim().max(100),
          expectedVersion: z.number().int().min(1)
        })
        .parse(request.body);
      let siteOrigin: string;
      try {
        siteOrigin = normalizeSiteOrigin(body.siteOrigin);
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error
              ? error.message
              : "站点地址格式不正确",
          code: "SITE_PROFILE_VALIDATION_FAILED",
          fieldErrors: { siteOrigin: "站点地址格式不正确" }
        });
      }
      const icpError = icpFilingValidationError(body.icpFilingNumber);
      const publicSecurityError = publicSecurityFilingValidationError(
        body.publicSecurityFilingNumber
      );
      if (icpError || publicSecurityError) {
        return reply.code(400).send({
          error: "站点信息格式不正确",
          code: "SITE_PROFILE_VALIDATION_FAILED",
          fieldErrors: {
            ...(icpError ? { icpFilingNumber: icpError } : {}),
            ...(publicSecurityError
              ? { publicSecurityFilingNumber: publicSecurityError }
              : {})
          }
        });
      }
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (before.version !== body.expectedVersion) {
          throw new BusinessError(
            "系统设置已由其他管理员更新，请刷新后重试",
            409,
            undefined,
            "SETTINGS_VERSION_CONFLICT"
          );
        }
        const updatedAt = nowIso();
        const upsert = db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        );
        upsert.run("public_site_origin", siteOrigin, updatedAt);
        upsert.run(
          "icp_filing_number",
          body.icpFilingNumber,
          updatedAt
        );
        upsert.run(
          "public_security_filing_number",
          body.publicSecurityFilingNumber,
          updatedAt
        );
        upsert.run(
          "settings_version",
          String(before.version + 1),
          updatedAt
        );
        const after = getAdminSettings();
        addAudit(
          auth.user.id,
          "SITE_PROFILE_UPDATE",
          "settings",
          "site_profile",
          {
            siteOrigin: before.siteOrigin,
            icpFilingNumber: before.icpFilingNumber,
            publicSecurityFilingNumber:
              before.publicSecurityFilingNumber
          },
          {
            siteOrigin: after.siteOrigin,
            icpFilingNumber: after.icpFilingNumber,
            publicSecurityFilingNumber:
              after.publicSecurityFilingNumber
          }
        );
        return after;
      });
      return { message: "站点信息已更新", settings };
    }
  );

  app.patch(
    "/api/v1/admin/settings/site-origin",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const body = z
        .object({
          siteOrigin: z.string().trim().min(1).max(2048),
          expectedVersion: z.number().int().min(1)
        })
        .parse(request.body);
      let siteOrigin: string;
      try {
        siteOrigin = normalizeSiteOrigin(body.siteOrigin);
      } catch (error) {
        return reply.code(400).send({
          error:
            error instanceof Error
              ? error.message
              : "站点地址格式不正确",
          code: "SITE_ORIGIN_VALIDATION_FAILED"
        });
      }
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (before.version !== body.expectedVersion) {
          throw new BusinessError(
            "系统设置已由其他管理员更新，请刷新后重试",
            409,
            undefined,
            "SETTINGS_VERSION_CONFLICT"
          );
        }
        const updatedAt = nowIso();
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(
            'public_site_origin', ?, ?
          )
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`
        ).run(siteOrigin, updatedAt);
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'settings_version'`
        ).run(String(before.version + 1), updatedAt);
        const after = getAdminSettings();
        addAudit(
          auth.user.id,
          "SITE_ORIGIN_UPDATE",
          "settings",
          "site_origin",
          { siteOrigin: before.siteOrigin },
          { siteOrigin: after.siteOrigin }
        );
        return after;
      });
      return { message: "站点地址已更新", settings };
    }
  );

  app.patch(
    "/api/v1/admin/settings/icp-filing",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const body = z
        .object({
          icpFilingNumber: z
            .string()
            .trim()
            .max(100),
          expectedVersion: z.number().int().min(1)
        })
        .parse(request.body);
      const validationError = icpFilingValidationError(
        body.icpFilingNumber
      );
      if (validationError) {
        return reply.code(400).send({
          error: validationError,
          code: "ICP_FILING_VALIDATION_FAILED"
        });
      }
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (before.version !== body.expectedVersion) {
          throw new BusinessError(
            "系统设置已由其他管理员更新，请刷新后重试",
            409,
            undefined,
            "SETTINGS_VERSION_CONFLICT"
          );
        }
        const updatedAt = nowIso();
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(
            'icp_filing_number', ?, ?
          )
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`
        ).run(body.icpFilingNumber, updatedAt);
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'settings_version'`
        ).run(String(before.version + 1), updatedAt);
        const after = getAdminSettings();
        addAudit(
          auth.user.id,
          "ICP_FILING_UPDATE",
          "settings",
          "icp_filing",
          { icpFilingNumber: before.icpFilingNumber },
          { icpFilingNumber: after.icpFilingNumber }
        );
        return after;
      });
      return {
        message: body.icpFilingNumber ? "ICP备案号已更新" : "ICP备案号已清除",
        settings
      };
    }
  );

  app.patch(
    "/api/v1/admin/settings/public-security-filing",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const body = z
        .object({
          publicSecurityFilingNumber: z.string().trim().max(100),
          expectedVersion: z.number().int().min(1)
        })
        .parse(request.body);
      const validationError = publicSecurityFilingValidationError(
        body.publicSecurityFilingNumber
      );
      if (validationError) {
        return reply.code(400).send({
          error: validationError,
          code: "PUBLIC_SECURITY_FILING_VALIDATION_FAILED"
        });
      }
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (before.version !== body.expectedVersion) {
          throw new BusinessError(
            "系统设置已由其他管理员更新，请刷新后重试",
            409,
            undefined,
            "SETTINGS_VERSION_CONFLICT"
          );
        }
        const updatedAt = nowIso();
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(
            'public_security_filing_number', ?, ?
          )
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`
        ).run(body.publicSecurityFilingNumber, updatedAt);
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'settings_version'`
        ).run(String(before.version + 1), updatedAt);
        const after = getAdminSettings();
        addAudit(
          auth.user.id,
          "PUBLIC_SECURITY_FILING_UPDATE",
          "settings",
          "public_security_filing",
          {
            publicSecurityFilingNumber:
              before.publicSecurityFilingNumber
          },
          {
            publicSecurityFilingNumber:
              after.publicSecurityFilingNumber
          }
        );
        return after;
      });
      return {
        message: body.publicSecurityFilingNumber
          ? "公安备案号已更新"
          : "公安备案号已清除",
        settings
      };
    }
  );

  app.get("/api/v1/admin/report", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const query = reportQuery.parse(request.query);
    const machineIds = allowedReportMachineIds(auth.user.id, auth.user.role, query.machineId);
    if (!machineIds.length) return { groups: [], users: [], summary: emptySummary() };
    return buildReport(machineIds, query.from, query.to);
  });

  app.get("/api/v1/admin/report.csv", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const query = reportQuery.parse(request.query);
    const machineIds = allowedReportMachineIds(auth.user.id, auth.user.role, query.machineId);
    const report = buildReport(machineIds, query.from, query.to);
    const lines = [
      ["机器", "资源组", "资源组成", "占用分钟", "可用分钟", "占用率"],
      ...report.groups.map((row) => [
        row.machineName,
        row.groupName,
        row.resourceSummary,
        String(row.reservedMinutes),
        String(row.availableMinutes),
        `${row.utilization}%`
      ])
    ];
    const csv = "\uFEFF" + lines.map((line) => line.map(csvCell).join(",")).join("\r\n");
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", 'attachment; filename="resource-report.csv"');
    return csv;
  });

  app.get("/api/v1/admin/audit", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT a.*, u.display_name AS actor_name,
          api_token.name AS token_name,
          CASE
            WHEN a.entity_type = 'user' THEN COALESCE(
              (SELECT CASE WHEN dut.user_id IS NOT NULL
                THEN '用户已删除' ELSE target.display_name END
               FROM users target
               LEFT JOIN deleted_user_tombstones dut ON dut.user_id = target.id
               WHERE target.id = a.entity_id),
              '用户已删除'
            )
            WHEN a.entity_type = 'machine' THEN COALESCE(
              (SELECT CASE WHEN dmt.machine_id IS NOT NULL
                THEN '机器已删除' ELSE target.name END
               FROM machines target
               LEFT JOIN deleted_machine_tombstones dmt ON dmt.machine_id = target.id
               WHERE target.id = a.entity_id),
              '机器已删除'
            )
            WHEN a.entity_type = 'resource_group' THEN COALESCE(
              (SELECT CASE WHEN drgt.resource_group_id IS NOT NULL
                THEN '资源组已删除' ELSE target.name END
               FROM resource_groups target
               LEFT JOIN deleted_resource_group_tombstones drgt
                 ON drgt.resource_group_id = target.id
               WHERE target.id = a.entity_id),
              '资源组已删除'
            )
            WHEN a.entity_type = 'resource_pool' THEN COALESCE(
              (SELECT CASE WHEN drpt.resource_pool_id IS NOT NULL
                THEN '资源项已删除' ELSE target.name END
               FROM resource_pools target
               LEFT JOIN deleted_resource_pool_tombstones drpt
                 ON drpt.resource_pool_id = target.id
               WHERE target.id = a.entity_id),
              '资源项已删除'
            )
            WHEN a.entity_type = 'announcement' THEN COALESCE(
              (SELECT target.title FROM announcements target
               WHERE target.id = a.entity_id),
              '系统公告'
            )
            ELSE NULL
          END AS entity_name,
          CASE
            WHEN a.entity_type = 'user' THEN EXISTS(
              SELECT 1 FROM deleted_user_tombstones dut
              WHERE dut.user_id = a.entity_id
            )
            WHEN a.entity_type = 'machine' THEN EXISTS(
              SELECT 1 FROM deleted_machine_tombstones dmt
              WHERE dmt.machine_id = a.entity_id
            )
            WHEN a.entity_type = 'resource_group' THEN EXISTS(
              SELECT 1 FROM deleted_resource_group_tombstones drgt
              WHERE drgt.resource_group_id = a.entity_id
            )
            WHEN a.entity_type = 'resource_pool' THEN EXISTS(
              SELECT 1 FROM deleted_resource_pool_tombstones drpt
              WHERE drpt.resource_pool_id = a.entity_id
            )
            ELSE 0
          END AS entity_deleted
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_user_id
         LEFT JOIN api_tokens api_token ON api_token.id = a.actor_api_token_id
         ORDER BY a.created_at DESC LIMIT 300`
      )
      .all() as Array<Record<string, unknown>>;
    return {
      logs: rows.map((row) => {
        const entityDeleted = Boolean(row.entity_deleted);
        return {
          id: row.id,
          actorName: row.actor_name ?? "系统",
          apiTokenId: row.actor_api_token_id,
          apiTokenName: row.token_name,
          apiOperationId: row.api_operation_id,
          entityName: row.entity_name,
          action: row.action,
          entityType: row.entity_type,
          entityId: row.entity_id,
          before:
            !entityDeleted && row.before_json
              ? JSON.parse(String(row.before_json))
              : null,
          after:
            !entityDeleted && row.after_json
              ? JSON.parse(String(row.after_json))
              : null,
          createdAt: row.created_at
        };
      })
    };
  });
}

function requireMachineManager(request: FastifyRequest, reply: FastifyReply) {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  return requireMachineManagerForId(request, reply, id);
}

function requireMachineViewer(request: FastifyRequest, reply: FastifyReply) {
  const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
  return requireMachineViewerForId(request, reply, id);
}

function requireMachineViewerForId(
  request: FastifyRequest,
  reply: FastifyReply,
  machineId: string
) {
  const auth = requireAuth(request, reply);
  if (!auth) return null;
  if (!canAccessMachine(auth.user.id, auth.user.role, machineId)) {
    reply.code(403).send({ error: "你没有这台机器的使用权限" });
    return null;
  }
  return {
    ...auth,
    machineId,
    canManage: canManageMachine(auth.user.id, auth.user.role, machineId)
  };
}

function assignMachineManager(
  reply: FastifyReply,
  machineId: string,
  userId: string,
  actorUserId: string
) {
  const user = db
    .prepare(
      `SELECT u.status
       FROM users u
       JOIN machine_access_memberships mam
         ON mam.user_id = u.id AND mam.machine_id = ?
       WHERE u.id = ? AND u.role = 'USER'`
    )
    .get(machineId, userId) as { status: string } | undefined;
  if (!user || user.status !== "ACTIVE") {
    reply.code(400).send({ error: "只能将这台机器已有的已启用用户设为管理员" });
    return null;
  }
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO machine_admins(
        machine_id, user_id, assigned_by, created_at
      ) VALUES(?, ?, ?, ?)`
    )
    .run(machineId, userId, actorUserId, nowIso());
  if (!result.changes) {
    reply.code(409).send({ error: "该用户已经是这台机器的管理员" });
    return null;
  }
  addAudit(actorUserId, "MACHINE_ADMIN_ASSIGN", "machine", machineId, undefined, {
    userId
  });
  bumpMachineAccessRevision();
  bumpScheduleRevision();
  createNotification(
    userId,
    "MACHINE_ROLE_CHANGED",
    "你已成为机器管理员",
    "你现在可以在资源管理中维护该机器并处理使用权申请。",
    "/admin/machines"
  );
  return { message: "已设为机器管理员" };
}

function machineAuditPayload(
  value: {
    name: string;
    address: string;
    hardwareNotes: string;
    connectionGuide: string;
    tags: string[];
  },
  managementNotesChanged: boolean
) {
  return {
    name: value.name,
    address: value.address,
    hardwareNotes: value.hardwareNotes,
    connectionGuide: value.connectionGuide,
    tags: value.tags,
    managementNotesChanged
  };
}

function machineAuditPayloadFromRow(
  row: Record<string, unknown>,
  managementNotesChanged: boolean
) {
  return {
    name: row.name,
    address: row.address,
    hardwareNotes: row.hardware_notes,
    connectionGuide: row.connection_guide,
    tags: parseTags(String(row.tags_json)),
    managementNotesChanged
  };
}

function requireMachineManagerForId(
  request: FastifyRequest,
  reply: FastifyReply,
  machineId: string
) {
  const auth = requireAuth(request, reply);
  if (!auth) return null;
  if (!canManageMachine(auth.user.id, auth.user.role, machineId)) {
    reply.code(403).send({ error: "无权管理这台机器" });
    return null;
  }
  return { ...auth, machineId };
}

const plannedUnavailabilityPreviewSchema = z
  .object({
    startAt: z.string().datetime(),
    endAt: z.string().datetime()
  })
  .refine((value) => value.startAt < value.endAt, {
    message: "维护结束时间必须晚于开始时间"
  });

const plannedUnavailabilitySchema = plannedUnavailabilityPreviewSchema.and(
  z.object({
    reason: z.string().max(1000).optional().default(""),
    expectedRevision: z.number().int().min(1)
  })
);

const maintenancePreviewSchema = plannedUnavailabilityPreviewSchema.and(
  z.object({
    resourceGroupId: z.string().uuid().nullable().optional()
  })
);

const maintenanceSchema = maintenancePreviewSchema.and(
  z.object({
    reason: z.string().max(1000).optional().default(""),
    expectedRevision: z.number().int().min(1)
  })
);

const versionSchema = z.object({
  expectedVersion: z.number().int().min(1)
});

const longDisableSchema = versionSchema.extend({
  expectedRevision: z.number().int().min(1),
  reason: z.string().max(1000).optional().default("")
});

function countRows(sql: string, ...params: unknown[]) {
  const row = db.prepare(sql).get(...params) as { count: number };
  return Number(row.count);
}

function getCurrentMachineRow(machineId: string) {
  return db
    .prepare(
      `SELECT * FROM machines m
       WHERE m.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )`
    )
    .get(machineId) as Record<string, any> | undefined;
}

function getCurrentResourceGroupRow(groupId: string) {
  return db
    .prepare(
      `SELECT * FROM resource_groups
       WHERE id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = resource_groups.id
         )`
    )
    .get(groupId) as Record<string, any> | undefined;
}

type ManageableUserRow = {
  id: string;
  display_name: string;
  status: string;
  role: string;
  version: number;
  updated_at: string;
  disabled_at: string | null;
  disable_reason: string;
};

function getManageableUser(userId: string) {
  return db
    .prepare(
      `SELECT u.id, u.display_name, u.status, u.role, u.version,
        u.updated_at, u.disabled_at, u.disable_reason
       FROM users u
       WHERE u.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )`
    )
    .get(userId) as ManageableUserRow | undefined;
}

function mapManageableUser(user: ManageableUserRow) {
  return {
    id: user.id,
    displayName: user.display_name,
    status: user.status,
    version: user.version,
    updatedAt: user.updated_at,
    disabledAt: user.disabled_at,
    disableReason: user.disable_reason
  };
}

function userDisableImpact(userId: string, at = nowIso()) {
  return {
    activeReservations: countRows(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE user_id = ? AND status = 'CONFIRMED'
         AND start_at <= ? AND end_at > ?`,
      userId,
      at,
      at
    ),
    futureReservations: countRows(
      `SELECT COUNT(*) AS count FROM reservations
       WHERE user_id = ? AND status = 'CONFIRMED' AND start_at > ?`,
      userId,
      at
    ),
    machineMemberships: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE user_id = ?",
      userId
    ),
    machineAdminRoles: countRows(
      "SELECT COUNT(*) AS count FROM machine_admins WHERE user_id = ?",
      userId
    ),
    pendingProfileChanges: countRows(
      `SELECT COUNT(*) AS count FROM profile_change_requests
       WHERE user_id = ? AND status = 'PENDING'`,
      userId
    )
  };
}

function userDeleteImpact(userId: string) {
  return {
    machineMemberships: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE user_id = ?",
      userId
    ),
    machineAdminRoles: countRows(
      "SELECT COUNT(*) AS count FROM machine_admins WHERE user_id = ?",
      userId
    ),
    accessRequests: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_requests WHERE user_id = ?",
      userId
    ),
    reservations: countRows(
      "SELECT COUNT(*) AS count FROM reservations WHERE user_id = ?",
      userId
    ),
    notifications: countRows(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = ?",
      userId
    ),
    auditLogs: countRows(
      `SELECT COUNT(*) AS count FROM audit_logs
       WHERE actor_user_id = ? OR (entity_type = 'user' AND entity_id = ?)`,
      userId,
      userId
    ),
    feedbackTickets: countRows(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE submitted_by = ?",
      userId
    ),
    feedbackActivities: countRows(
      "SELECT COUNT(*) AS count FROM feedback_activities WHERE actor_user_id = ?",
      userId
    )
  };
}

function deleteUserRecords(
  userId: string,
  actorUserId: string,
  counts: ReturnType<typeof userDeleteImpact>
) {
  const now = nowIso();
  revokeApiTokensForUser(userId, "账号已删除", now);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_verification_challenges WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM username_history WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_history WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM employee_numbers WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM pending_registration_employee_numbers WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM registration_revisions WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM profile_change_requests WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM machine_admins WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM machine_access_memberships WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM machine_access_requests WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM email_outbox WHERE user_id = ?").run(userId);
  db.prepare(
    "UPDATE feedback_tickets SET submitted_by_name = '用户已删除' WHERE submitted_by = ?"
  ).run(userId);
  db.prepare(
    "UPDATE feedback_activities SET actor_name = '用户已删除' WHERE actor_user_id = ?"
  ).run(userId);
  db.prepare(
    `UPDATE audit_logs
     SET before_json = NULL, after_json = NULL
     WHERE actor_user_id = ? OR (entity_type = 'user' AND entity_id = ?)`
  ).run(userId, userId);
  db.prepare(
    `UPDATE users
     SET username = ?, username_normalized = ?, email = NULL,
       display_name = '用户已删除', password_hash = ?,
       password_change_recommended = 0, username_changed_at = NULL,
       last_login_at = NULL, last_login_ip = '', auto_logout_minutes = 0,
       approved_at = NULL, approved_by = NULL,
       version = version + 1, disabled_at = NULL, disabled_by = NULL,
       disable_reason = '', updated_at = ?
     WHERE id = ?`
  ).run(
    `deleted-${userId}`,
    `deleted-${userId}`,
    `!deleted:${userId}`,
    now,
    userId
  );
  db.prepare(
    `INSERT INTO deleted_user_tombstones(
      user_id, deleted_at, deleted_by, cleanup_counts_json
    ) VALUES(?, ?, ?, ?)`
  ).run(userId, now, actorUserId, JSON.stringify(counts));
}

function resourceGroupDeleteImpact(groupId: string) {
  return {
    allocations: countRows(
      "SELECT COUNT(*) AS count FROM resource_group_allocations WHERE resource_group_id = ?",
      groupId
    ),
    reservations: countRows(
      "SELECT COUNT(*) AS count FROM reservations WHERE resource_group_id = ?",
      groupId
    ),
    unavailability: countRows(
      "SELECT COUNT(*) AS count FROM resource_unavailability WHERE resource_group_id = ?",
      groupId
    ),
    revisions: countRows(
      "SELECT COUNT(*) AS count FROM resource_group_revisions WHERE resource_group_id = ?",
      groupId
    )
  };
}

function machineDeleteImpact(machineId: string) {
  return {
    resourcePools: countRows(
      `SELECT COUNT(*) AS count FROM resource_pools rp
       WHERE rp.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_pool_tombstones drpt
           WHERE drpt.resource_pool_id = rp.id
         )`,
      machineId
    ),
    resourceGroups: countRows(
      `SELECT COUNT(*) AS count FROM resource_groups rg
       WHERE rg.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = rg.id
         )`,
      machineId
    ),
    resourceItems: countRows(
      `SELECT COUNT(*) AS count FROM resource_pool_items
       WHERE pool_id IN (
         SELECT rp.id FROM resource_pools rp
         WHERE rp.machine_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deleted_resource_pool_tombstones drpt
             WHERE drpt.resource_pool_id = rp.id
           )
       )`,
      machineId
    ),
    members: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_memberships WHERE machine_id = ?",
      machineId
    ),
    managers: countRows(
      "SELECT COUNT(*) AS count FROM machine_admins WHERE machine_id = ?",
      machineId
    ),
    accessRequests: countRows(
      "SELECT COUNT(*) AS count FROM machine_access_requests WHERE machine_id = ?",
      machineId
    ),
    reservations: countRows(
      "SELECT COUNT(*) AS count FROM reservations WHERE machine_id = ?",
      machineId
    ),
    unavailability: countRows(
      "SELECT COUNT(*) AS count FROM resource_unavailability WHERE machine_id = ?",
      machineId
    )
  };
}

function notifyDeletedResourceGroupUsers(groupId: string, groupName: string) {
  const users = db
    .prepare(
      `SELECT user_id FROM machine_access_memberships
       WHERE machine_id = (
         SELECT machine_id FROM resource_groups WHERE id = ?
       )
       UNION
       SELECT user_id FROM machine_admins
       WHERE machine_id = (
         SELECT machine_id FROM resource_groups WHERE id = ?
       )
       UNION
       SELECT user_id FROM machine_access_requests
       WHERE machine_id = (
         SELECT machine_id FROM resource_groups WHERE id = ?
       ) AND status = 'PENDING'
       UNION
       SELECT DISTINCT user_id FROM reservations WHERE resource_group_id = ?`
    )
    .all(groupId, groupId, groupId, groupId) as Array<{ user_id: string }>;
  for (const user of users) {
    createNotification(
      user.user_id,
      "RESOURCE_GROUP_DELETED",
      "资源组已删除",
      `${groupName}已被永久删除，历史占用记录将显示为“资源组已删除”。`,
      ""
    );
  }
}

function notifyDeletedMachineUsers(machineId: string, machineName: string) {
  const users = db
    .prepare(
      `SELECT user_id FROM machine_access_memberships WHERE machine_id = ?
       UNION
       SELECT user_id FROM machine_admins WHERE machine_id = ?
       UNION
       SELECT user_id FROM machine_access_requests
       WHERE machine_id = ? AND status = 'PENDING'
       UNION
       SELECT user_id FROM reservations WHERE machine_id = ?`
    )
    .all(machineId, machineId, machineId, machineId) as Array<{
    user_id: string;
  }>;
  for (const user of users) {
    createNotification(
      user.user_id,
      "MACHINE_DELETED",
      "机器已删除",
      `${machineName}已被永久删除，历史占用记录将显示为“机器已删除”。`,
      ""
    );
  }
}

function tombstoneResourcePool(
  poolId: string,
  machineId: string,
  actorUserId: string
) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO deleted_resource_pool_tombstones(
      resource_pool_id, machine_id, deleted_at, deleted_by
    ) VALUES(?, ?, ?, ?)`
  ).run(poolId, machineId, now, actorUserId);
  db.prepare(
    `UPDATE resource_pools
     SET name = ?, description = '', sort_order = 0,
       version = version + 1, updated_at = ?
     WHERE id = ?`
  ).run(`deleted-${poolId}`, now, poolId);
}

function deleteResourceGroupRecords(
  groupId: string,
  actorUserId: string,
  counts: ReturnType<typeof resourceGroupDeleteImpact>
) {
  const group = db
    .prepare("SELECT machine_id FROM resource_groups WHERE id = ?")
    .get(groupId) as { machine_id: string };
  const now = nowIso();
  db.prepare(
    `UPDATE resource_unavailability
     SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
     WHERE resource_group_id = ? AND status = 'ACTIVE'`
  ).run(actorUserId, now, groupId);
  db.prepare("DELETE FROM resource_group_allocations WHERE resource_group_id = ?").run(groupId);
  db.prepare(
    `INSERT INTO deleted_resource_group_tombstones(
      resource_group_id, machine_id, deleted_at, deleted_by,
      cleanup_counts_json
    ) VALUES(?, ?, ?, ?, ?)`
  ).run(groupId, group.machine_id, now, actorUserId, JSON.stringify(counts));
  db.prepare(
    `UPDATE resource_groups
     SET name = ?, description = '', tags_json = '[]',
       status = 'DISABLED', disabled_at = NULL, disabled_by = NULL,
       disable_reason = '', sort_order = 0, version = version + 1,
       updated_at = ?
     WHERE id = ?`
  ).run(`deleted-${groupId}`, now, groupId);
}

function deleteMachineRecords(
  machineId: string,
  actorUserId: string,
  counts: ReturnType<typeof machineDeleteImpact>
) {
  const now = nowIso();
  const groups = db
    .prepare(
      `SELECT rg.id FROM resource_groups rg
       WHERE rg.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = rg.id
         )`
    )
    .all(machineId) as Array<{ id: string }>;
  const groupCounts = new Map(
    groups.map((group) => [group.id, resourceGroupDeleteImpact(group.id)])
  );
  const pools = db
    .prepare(
      `SELECT rp.id FROM resource_pools rp
       WHERE rp.machine_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_pool_tombstones drpt
           WHERE drpt.resource_pool_id = rp.id
         )`
    )
    .all(machineId) as Array<{ id: string }>;
  db.prepare("DELETE FROM machine_admins WHERE machine_id = ?").run(machineId);
  db.prepare("DELETE FROM machine_access_memberships WHERE machine_id = ?").run(machineId);
  db.prepare(
    `UPDATE machine_access_requests
     SET status = 'REJECTED', version = version + 1,
       reviewed_by = ?, review_reason = '机器已删除',
       reviewed_at = ?, updated_at = ?
     WHERE machine_id = ? AND status = 'PENDING'`
  ).run(actorUserId, now, now, machineId);
  db.prepare(
    `UPDATE resource_unavailability
     SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
     WHERE machine_id = ? AND status = 'ACTIVE'`
  ).run(actorUserId, now, machineId);
  db.prepare(
    `DELETE FROM resource_group_allocations
     WHERE resource_group_id IN (
       SELECT id FROM resource_groups WHERE machine_id = ?
     )`
  ).run(machineId);
  for (const group of groups) {
    db.prepare(
      `INSERT INTO deleted_resource_group_tombstones(
        resource_group_id, machine_id, deleted_at, deleted_by,
        cleanup_counts_json
      ) VALUES(?, ?, ?, ?, ?)`
    ).run(
      group.id,
      machineId,
      now,
      actorUserId,
      JSON.stringify(groupCounts.get(group.id))
    );
    db.prepare(
      `UPDATE resource_groups
       SET name = ?, description = '', tags_json = '[]',
         status = 'DISABLED', disabled_at = NULL, disabled_by = NULL,
         disable_reason = '', sort_order = 0, version = version + 1,
         updated_at = ?
       WHERE id = ?`
    ).run(`deleted-${group.id}`, now, group.id);
  }
  for (const pool of pools) {
    tombstoneResourcePool(pool.id, machineId, actorUserId);
  }
  db.prepare(
    `INSERT INTO deleted_machine_tombstones(
      machine_id, deleted_at, deleted_by, cleanup_counts_json
    ) VALUES(?, ?, ?, ?)`
  ).run(machineId, now, actorUserId, JSON.stringify(counts));
  db.prepare(
    `UPDATE machines
     SET name = ?, address = '', hardware_notes = '',
       connection_guide = '', management_notes = '', tags_json = '[]',
       status = 'DISABLED', disabled_at = NULL, disabled_by = NULL,
       disable_reason = '', version = version + 1, updated_at = ?
     WHERE id = ?`
  ).run(`deleted-${machineId}`, now, machineId);
}

const reportQuery = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
    machineId: z.string().uuid().optional()
  })
  .refine((value) => value.from < value.to, {
    message: "统计结束时间必须晚于开始时间"
  })
  .refine(
    (value) =>
      new Date(value.to).getTime() - new Date(value.from).getTime() <=
      366 * 24 * 60 * 60 * 1_000,
    { message: "单次统计范围不能超过 366 天" }
  );

function allowedReportMachineIds(userId: string, role: string, machineId?: string) {
  if (machineId) return canAccessMachine(userId, role, machineId) ? [machineId] : [];
  if (role === "SYSTEM_ADMIN") {
    return (db.prepare("SELECT id FROM machines").all() as Array<{ id: string }>).map(
      (row) => row.id
    );
  }
  return (
    db.prepare(
      `SELECT mam.machine_id AS id
       FROM machine_access_memberships mam
       JOIN machines m ON m.id = mam.machine_id
       WHERE mam.user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )`
    ).all(userId) as Array<{ id: string }>
  ).map((row) => row.id);
}

function buildReport(machineIds: string[], from: string, to: string) {
  if (!machineIds.length) return { groups: [], users: [], summary: emptySummary() };
  const placeholders = machineIds.map(() => "?").join(",");
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const rangeMinutes = (toMs - fromMs) / 60000;
  const groups = db
    .prepare(
      `SELECT rg.*,
        CASE WHEN dmt.machine_id IS NOT NULL
          THEN '机器已删除' ELSE m.name END AS machine_name,
        CASE WHEN drgt.resource_group_id IS NOT NULL
          THEN '资源组已删除' ELSE rg.name END AS display_group_name,
        drgt.resource_group_id IS NOT NULL AS group_deleted
       FROM resource_groups rg
       JOIN machines m ON m.id = rg.machine_id
       LEFT JOIN deleted_resource_group_tombstones drgt
         ON drgt.resource_group_id = rg.id
       LEFT JOIN deleted_machine_tombstones dmt
         ON dmt.machine_id = m.id
       WHERE rg.machine_id IN (${placeholders})
       ORDER BY m.name, rg.sort_order, rg.name`
    )
    .all(...machineIds) as Array<Record<string, any>>;
  const reservations = db
    .prepare(
      `SELECT r.*, u.display_name, m.name AS machine_name,
        (SELECT en.employee_number FROM employee_numbers en
         WHERE en.user_id = u.id AND en.status = 'ACTIVE'
         LIMIT 1) AS employee_number
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       JOIN machines m ON m.id = r.machine_id
       WHERE r.machine_id IN (${placeholders}) AND r.status = 'CONFIRMED'
         AND r.start_at < ? AND r.end_at > ?`
    )
    .all(...machineIds, to, from) as Array<Record<string, any>>;
  const unavailability = db
    .prepare(
      `SELECT * FROM resource_unavailability
       WHERE machine_id IN (${placeholders}) AND status = 'ACTIVE'
         AND start_at < ? AND end_at > ?`
    )
    .all(...machineIds, to, from) as Array<Record<string, any>>;

  const groupRows = groups.map((group) => {
    const groupDeleted = Boolean(group.group_deleted);
    const mappedGroup = groupDeleted ? null : mapResourceGroup(group);
    const reservedMinutes = reservations
      .filter(
        (row) =>
          row.resource_group_id === group.id ||
          (row.scope === "MACHINE" && row.machine_id === group.machine_id)
      )
      .reduce((sum, row) => sum + clippedMinutes(row.start_at, row.end_at, fromMs, toMs), 0);
    const unavailableMinutes = unionMinutes(
      unavailability
        .filter(
          (row) =>
            row.machine_id === group.machine_id &&
            (row.resource_group_id === null || row.resource_group_id === group.id)
        )
        .map((row) => [row.start_at, row.end_at] as const),
      fromMs,
      toMs
    );
    const availableMinutes = groupDeleted
      ? 0
      : Math.max(0, rangeMinutes - unavailableMinutes);
    return {
      machineId: group.machine_id,
      machineName: group.machine_name,
      resourceGroupId: group.id,
      groupName: group.display_group_name,
      resourceSummary: groupDeleted ? "资源已删除" : mappedGroup!.resourceSummary,
      reservedMinutes: Math.round(reservedMinutes),
      availableMinutes: Math.round(availableMinutes),
      utilization:
        availableMinutes > 0 ? Number(((reservedMinutes / availableMinutes) * 100).toFixed(1)) : 0,
      deleted: groupDeleted
    };
  }).filter((row) => !row.deleted || row.reservedMinutes > 0);
  const userMap = new Map<
    string,
    {
      userId: string;
      displayName: string;
      employeeNumber: string | null;
      reservedMinutes: number;
    }
  >();
  for (const row of reservations) {
    const minutes = clippedMinutes(row.start_at, row.end_at, fromMs, toMs);
    const current = userMap.get(row.user_id) ?? {
      userId: row.user_id,
      displayName: row.display_name,
      employeeNumber: row.employee_number ?? null,
      reservedMinutes: 0
    };
    current.reservedMinutes += minutes;
    userMap.set(row.user_id, current);
  }
  const availableMinutes = groupRows.reduce(
    (sum, row) => sum + row.availableMinutes,
    0
  );
  const reservedMinutes = groupRows.reduce(
    (sum, row) => sum + row.reservedMinutes,
    0
  );
  return {
    groups: groupRows,
    users: [...userMap.values()]
      .map((row) => ({
        displayName: row.displayName,
        employeeNumber: row.employeeNumber,
        reservedMinutes: Math.round(row.reservedMinutes)
      }))
      .sort((a, b) => b.reservedMinutes - a.reservedMinutes),
    summary: {
      reservationCount: reservations.length,
      reservedMinutes: Math.round(reservedMinutes),
      availableMinutes: Math.round(availableMinutes),
      utilization:
        availableMinutes > 0
          ? Number(((reservedMinutes / availableMinutes) * 100).toFixed(1))
          : 0
    }
  };
}

function clippedMinutes(start: string, end: string, fromMs: number, toMs: number) {
  return Math.max(
    0,
    (Math.min(toMs, new Date(end).getTime()) - Math.max(fromMs, new Date(start).getTime())) /
      60000
  );
}

function unionMinutes(
  values: Array<readonly [string, string]>,
  fromMs: number,
  toMs: number
) {
  const intervals = values
    .map(([start, end]) => [
      Math.max(fromMs, new Date(start).getTime()),
      Math.min(toMs, new Date(end).getTime())
    ])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursorStart = 0;
  let cursorEnd = 0;
  for (const [start, end] of intervals) {
    if (!cursorEnd || start > cursorEnd) {
      total += cursorEnd ? cursorEnd - cursorStart : 0;
      cursorStart = start;
      cursorEnd = end;
    } else {
      cursorEnd = Math.max(cursorEnd, end);
    }
  }
  total += cursorEnd ? cursorEnd - cursorStart : 0;
  return total / 60000;
}

function emptySummary() {
  return {
    reservationCount: 0,
    reservedMinutes: 0,
    availableMinutes: 0,
    utilization: 0
  };
}

export function csvCell(value: string) {
  const safeValue = /^[\s\u0000-\u001f]*[=+\-@]/u.test(value)
    ? `'${value}`
    : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}
