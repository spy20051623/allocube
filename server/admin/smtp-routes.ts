import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireSystemAdmin } from "../auth.js";
import { db, nowIso, withImmediateTransaction, incrementRegistrationConfigRevision, addAudit } from "../db.js";
import { invalidateSmtpTransporter, sendSmtpTest } from "../mailer.js";
import { BusinessError } from "../business-error.js";
import {
  decryptSmtpPassword,
  getSmtpSettingsRow,
  getSavedSmtpSettings,
  isMailServiceAvailable,
  encryptSmtpPassword
} from "../smtp-settings.js";

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
    expectedVersion: z.number().int().min(1),
    overwrite: z.boolean().optional().default(false)
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

export function registerSmtpAdminRoutes(app: FastifyInstance) {

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
    if (!body.overwrite && current.version !== body.expectedVersion) {
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
      if (!body.overwrite && latest.version !== body.expectedVersion) {
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
}
