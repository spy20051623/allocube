import { updateAdminSettings } from "./settings-service.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeSiteOrigin } from "../../src/shared/site-origin.js";
import { icpFilingValidationError } from "../../src/shared/icp-filing.js";
import { publicSecurityFilingValidationError } from "../../src/shared/public-security-filing.js";
import { requireSystemAdmin } from "../auth.js";
import { getAdminSettings, db, incrementRegistrationConfigRevision } from "../db.js";
import { normalizeAllowedEmailDomains } from "../../src/shared/email-domain-rules.js";
import { capBookingAdvanceDays } from "../../src/shared/booking-policy.js";

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
        advanceDays: z.number().transform(capBookingAdvanceDays).pipe(z.number().int().min(1)),
        blockAdminBookings: z.boolean().optional(),
        expectedVersion: z.number().int().min(1),
        overwrite: z.boolean().optional().default(false)
      })
      .parse(request.body);
    const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
      const upsert = db.prepare(
        `INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`
      );
      upsert.run("advance_days", String(body.advanceDays), updatedAt);
      // Clients updating the booking window must not reset the administrator policy.
      if (body.blockAdminBookings !== undefined) {
        upsert.run("block_admin_bookings", body.blockAdminBookings ? "1" : "0", updatedAt);
      }
    }, (before, after) => ({
      action: "SETTINGS_UPDATE", entityId: "booking", before: {
        advanceDays: before.advanceDays,
        blockAdminBookings: before.blockAdminBookings
      }, after: {
        advanceDays: after.advanceDays,
        blockAdminBookings: after.blockAdminBookings
      }
    }));
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
      const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
        db.prepare(
          `UPDATE settings SET value = ?, updated_at = ?
           WHERE key = 'allowed_email_domains'`
        ).run(JSON.stringify(allowedEmailDomains), updatedAt);
        incrementRegistrationConfigRevision(updatedAt);
      }, (before, after) => ({ action: "EMAIL_DOMAIN_ALLOWLIST_UPDATE", entityId: "registration_email", before: { allowedEmailDomains: before.allowedEmailDomains }, after: { allowedEmailDomains: after.allowedEmailDomains } }));
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
      const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
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
      }, (before, after) => ({
        action: "REGISTRATION_EMAIL_POLICY_UPDATE", entityId: "registration_email", before: {
          allowRegistrationWithoutEmail:
            before.allowRegistrationWithoutEmail
        }, after: {
          allowRegistrationWithoutEmail:
            after.allowRegistrationWithoutEmail
        }
      }));
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
      const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
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
      }, (before, after) => ({
        action: "SITE_PROFILE_UPDATE", entityId: "site_profile", before: {
          siteOrigin: before.siteOrigin,
          icpFilingNumber: before.icpFilingNumber,
          publicSecurityFilingNumber:
            before.publicSecurityFilingNumber
        }, after: {
          siteOrigin: after.siteOrigin,
          icpFilingNumber: after.icpFilingNumber,
          publicSecurityFilingNumber:
            after.publicSecurityFilingNumber
        }
      }));
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
      const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(
            'public_site_origin', ?, ?
          )
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`
        ).run(siteOrigin, updatedAt);
      }, (before, after) => ({ action: "SITE_ORIGIN_UPDATE", entityId: "site_origin", before: { siteOrigin: before.siteOrigin }, after: { siteOrigin: after.siteOrigin } }));
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
      const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(
            'icp_filing_number', ?, ?
          )
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`
        ).run(body.icpFilingNumber, updatedAt);
      }, (before, after) => ({ action: "ICP_FILING_UPDATE", entityId: "icp_filing", before: { icpFilingNumber: before.icpFilingNumber }, after: { icpFilingNumber: after.icpFilingNumber } }));
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
      const settings = updateAdminSettings(auth.user.id, body, updatedAt => {
        db.prepare(
          `INSERT INTO settings(key, value, updated_at) VALUES(
            'public_security_filing_number', ?, ?
          )
          ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at`
        ).run(body.publicSecurityFilingNumber, updatedAt);
      }, (before, after) => ({
        action: "PUBLIC_SECURITY_FILING_UPDATE", entityId: "public_security_filing", before: {
          publicSecurityFilingNumber:
            before.publicSecurityFilingNumber
        }, after: {
          publicSecurityFilingNumber:
            after.publicSecurityFilingNumber
        }
      }));
      return {
        message: body.publicSecurityFilingNumber
          ? "公安备案号已更新"
          : "公安备案号已清除",
        settings
      };
    }
  );
}
