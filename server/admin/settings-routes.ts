import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeSiteOrigin } from "../../src/shared/site-origin.js";
import { icpFilingValidationError } from "../../src/shared/icp-filing.js";
import { publicSecurityFilingValidationError } from "../../src/shared/public-security-filing.js";
import { requireSystemAdmin } from "../auth.js";
import { getAdminSettings, withImmediateTransaction, nowIso, db, addAudit, incrementRegistrationConfigRevision } from "../db.js";
import { BusinessError } from "../business-error.js";
import { normalizeAllowedEmailDomains } from "../../src/shared/email-domain-rules.js";

export function registerSettingsAdminRoutes(app: FastifyInstance) {
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
        expectedVersion: z.number().int().min(1),
        overwrite: z.boolean().optional().default(false)
      })
      .refine((value) => value.maxBookingMinutes >= value.minBookingMinutes, {
        message: "最长时长不能小于最短时长"
      })
      .parse(request.body);
    const settings = withImmediateTransaction(() => {
      const before = getAdminSettings();
      if (!body.overwrite && before.version !== body.expectedVersion) {
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
          expectedVersion: z.number().int().min(1),
          overwrite: z.boolean().optional().default(false)
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
        if (!body.overwrite && before.version !== body.expectedVersion) {
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
          expectedVersion: z.number().int().min(1),
          overwrite: z.boolean().optional().default(false)
        })
        .parse(request.body);
      const settings = withImmediateTransaction(() => {
        const before = getAdminSettings();
        if (!body.overwrite && before.version !== body.expectedVersion) {
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
          expectedVersion: z.number().int().min(1),
          overwrite: z.boolean().optional().default(false)
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
        if (!body.overwrite && before.version !== body.expectedVersion) {
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
          expectedVersion: z.number().int().min(1),
          overwrite: z.boolean().optional().default(false)
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
        if (!body.overwrite && before.version !== body.expectedVersion) {
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
          expectedVersion: z.number().int().min(1),
          overwrite: z.boolean().optional().default(false)
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
        if (!body.overwrite && before.version !== body.expectedVersion) {
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
          expectedVersion: z.number().int().min(1),
          overwrite: z.boolean().optional().default(false)
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
        if (!body.overwrite && before.version !== body.expectedVersion) {
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
}
