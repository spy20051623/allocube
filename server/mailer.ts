import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import serverEnglish from "../src/i18n/server-en.json" with { type: "json" };
import { createSystemMessageCatalog } from "../src/shared/system-message.js";
import { db, getPublicSiteOrigin, nowIso } from "./db.js";
import {
  getSavedSmtpSettings,
  getRuntimeSmtpSettings,
  type RuntimeSmtpSettings
} from "./smtp-settings.js";

const systemMessages = createSystemMessageCatalog(serverEnglish);

let cachedTransporter:
  | {
      version: number;
      transporter: nodemailer.Transporter;
    }
  | undefined;
let emailOutboxProcessing = false;

export type NotificationEmailPolicy =
  | "NONE"
  | "REQUIRED_ACTION"
  | "ACCOUNT_BLOCKING"
  | "RESERVATION_IMPACT";

export type NotificationOptions = {
  emailPolicy?: NotificationEmailPolicy;
  entity?: { type: string; id: string };
};

const notificationEnglishCopy: Record<string, { title: string; body: string }> = {
  ACCOUNT_STATUS: { title: "Account status updated", body: "Your Allocube account status has changed." },
  USER_APPROVAL: { title: "Review required", body: "A registration or profile update is awaiting review." },
  REGISTRATION_SUBMITTED: { title: "Registration submitted", body: "Your registration has been submitted for review." },
  USERNAME_CHANGED: { title: "Username updated", body: "Your Allocube username has been updated." },
  PROFILE_CHANGE_REVIEW: { title: "Profile review", body: "A profile update needs review." },
  PROFILE_CHANGE_SUBMITTED: { title: "Profile update submitted", body: "Your profile update has been submitted for review." },
  PROFILE_CHANGE_APPROVED: { title: "Profile update approved", body: "Your profile update was approved." },
  PROFILE_CHANGE_REJECTED: { title: "Profile update rejected", body: "Your profile update was rejected." },
  MACHINE_ACCESS_REQUEST: { title: "Access request", body: "A machine access request needs review." },
  MACHINE_ACCESS_GRANTED: { title: "Machine access granted", body: "You now have access to the requested machine." },
  MACHINE_ACCESS_REJECTED: { title: "Machine access denied", body: "Your machine access request was denied." },
  MACHINE_ACCESS_REMOVED: { title: "Machine access removed", body: "Your access to a machine has been removed." },
  MACHINE_ROLE_CHANGED: { title: "Machine role updated", body: "Your machine administrator role has changed." },
  RESOURCE_UNAVAILABILITY: { title: "Resource availability changed", body: "Maintenance or a disabled resource affects one or more reservations." },
  RESERVATION_CANCELLED: { title: "Reservation cancelled", body: "One of your reservations has been cancelled." },
  RESERVATION_RELEASED_BY_MANAGER: { title: "Reservation ended", body: "A machine administrator released one of your reservations." },
  RESOURCE_GROUP_CHANGED: { title: "Group updated", body: "A group used by your reservation has changed." },
  RESOURCE_GROUP_DELETED: { title: "Group deleted", body: "A group used by your reservation was deleted." },
  MACHINE_DELETED: { title: "Machine deleted", body: "A machine associated with your reservation was deleted." },
  AVAILABILITY_WATCH: { title: "Resource available", body: "A watched resource now has an available time window." },
  FEEDBACK_CREATED: { title: "New feedback", body: "A new feedback ticket was submitted." },
  FEEDBACK_UPDATED: { title: "Feedback updated", body: "A feedback ticket was updated." },
  FEEDBACK_WITHDRAWN: { title: "Feedback withdrawn", body: "A feedback ticket was withdrawn." },
  FEEDBACK_ADMIN_COMMENT: { title: "Administrator replied", body: "An administrator replied to your feedback." },
  FEEDBACK_USER_COMMENT: { title: "New feedback comment", body: "A user added a comment to a feedback ticket." },
  FEEDBACK_STATUS_CHANGED: { title: "Feedback status updated", body: "The status of your feedback has changed." },
  FEEDBACK_LEVEL_CHANGED: { title: "Feedback priority updated", body: "The priority of your feedback has changed." }
};

function englishNotification(type: string) {
  return notificationEnglishCopy[type] ?? {
    title: "Allocube notification",
    body: "Something changed in Allocube. Open it to view the details."
  };
}

function createTransporter(settings: RuntimeSmtpSettings) {
  return nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.security === "IMPLICIT_TLS",
    requireTLS: settings.security === "STARTTLS",
    auth: {
      user: settings.username,
      pass: settings.password
    },
    tls: {
      rejectUnauthorized: true
    },
    connectionTimeout: 12_000,
    greetingTimeout: 12_000,
    socketTimeout: 20_000
  });
}

function activeTransporter() {
  const settings = getRuntimeSmtpSettings();
  if (!settings) return null;
  if (!cachedTransporter || cachedTransporter.version !== settings.version) {
    if (cachedTransporter) cachedTransporter.transporter.close();
    cachedTransporter = {
      version: settings.version,
      transporter: createTransporter(settings)
    };
  }
  return { settings, transporter: cachedTransporter.transporter };
}

export function invalidateSmtpTransporter() {
  if (cachedTransporter) cachedTransporter.transporter.close();
  cachedTransporter = undefined;
}

export function queueEmail(
  toEmail: string,
  subject: string,
  html: string,
  userId: string | null = null,
  expiresAt: string | null = null
) {
  if (!toEmail.trim()) return false;
  if (!getRuntimeSmtpSettings()) return false;
  db.prepare(
    `INSERT INTO email_outbox(
      id, user_id, to_email, subject, html, next_attempt_at, expires_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    userId,
    toEmail,
    subject,
    html,
    nowIso(),
    expiresAt,
    nowIso()
  );
  return true;
}

export function normalizeNotificationLink(link: string) {
  let safeLink = "";
  if (
    link.startsWith("/") &&
    !link.startsWith("//") &&
    !link.includes("\\") &&
    !/[\u0000-\u001f\u007f]/u.test(link)
  ) {
    try {
      const baseOrigin = "https://allocube.invalid";
      const resolved = new URL(link, baseOrigin);
      if (resolved.origin === baseOrigin) {
        safeLink = `${resolved.pathname}${resolved.search}${resolved.hash}`;
      }
    } catch {
      safeLink = "";
    }
  }
  return safeLink;
}

export function createNotification(
  userId: string,
  type: string,
  title: string,
  body: string,
  link = "",
  options: NotificationOptions = {}
) {
  const emailPolicy = options.emailPolicy ?? "NONE";
  const safeLink = normalizeNotificationLink(link);
  const user = db
    .prepare(
      `SELECT u.email,
        COALESCE(ep.reservation_updates, 1) AS reservation_updates
       FROM users u
       LEFT JOIN user_email_preferences ep ON ep.user_id = u.id
       WHERE u.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )`
    )
    .get(userId) as
    | { email: string | null; reservation_updates: number }
    | undefined;
  if (!user) return null;
  const id = randomUUID();
  const titleTemplate = systemMessages.resolve(title);
  const bodyTemplate = systemMessages.resolve(body);
  const templateKey = titleTemplate && bodyTemplate
    ? `SYSTEM_MESSAGE_V1:${titleTemplate.code}:${bodyTemplate.code}`
    : `TYPE_V1:${type}`;
  const templateParams = titleTemplate && bodyTemplate
    ? {
        title: titleTemplate,
        body: bodyTemplate
      }
    : {};
  db.prepare(
    `INSERT INTO notifications(
      id, user_id, type, title, body, template_key, template_params_json,
      link, entity_type, entity_id, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    userId,
    type,
    title,
    body,
    templateKey,
    JSON.stringify(templateParams),
    safeLink,
    options.entity?.type ?? null,
    options.entity?.id ?? null,
    nowIso()
  );
  const shouldEmail =
    emailPolicy === "REQUIRED_ACTION" ||
    emailPolicy === "ACCOUNT_BLOCKING" ||
    (emailPolicy === "RESERVATION_IMPACT" && Boolean(user.reservation_updates));
  if (shouldEmail) {
    if (user.email) {
      const siteOrigin = getPublicSiteOrigin();
      const detailUrl =
        siteOrigin && safeLink
          ? new URL(safeLink, siteOrigin).toString()
          : "";
      const fallbackEnglish = englishNotification(type);
      const english = {
        title: titleTemplate
          ? systemMessages.translate(titleTemplate.code, titleTemplate.params) ?? fallbackEnglish.title
          : fallbackEnglish.title,
        body: bodyTemplate
          ? systemMessages.translate(bodyTemplate.code, bodyTemplate.params) ?? fallbackEnglish.body
          : fallbackEnglish.body
      };
      queueEmail(
        user.email,
        `${title} / ${english.title}`,
        `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2937">
          <p style="color:#64748b">简体中文</p>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(body)}</p>
          ${detailUrl ? `<p><a href="${escapeHtml(detailUrl)}">查看详情</a></p>` : ""}
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />
          <p style="color:#64748b">English</p>
          <h2>${escapeHtml(english.title)}</h2>
          <p>${escapeHtml(english.body)}</p>
          ${detailUrl ? `<p><a href="${escapeHtml(detailUrl)}">View details</a></p>` : ""}
        </div>`,
        userId
      );
    }
  }
  return id;
}

export function classifySmtpError(error: unknown) {
  const value = error as {
    code?: string;
    responseCode?: number;
    command?: string;
    message?: string;
  };
  if (
    value.code === "EAUTH" ||
    value.responseCode === 535 ||
    value.responseCode === 534
  ) {
    return "SMTP 登录失败，请检查账号和密码";
  }
  if (
    value.code?.startsWith("CERT_") ||
    value.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    /certificate|self[- ]signed|unable to verify/i.test(value.message ?? "")
  ) {
    return "SMTP 服务器证书验证失败";
  }
  if (
    value.code === "ETIMEDOUT" ||
    value.code === "ESOCKET" ||
    value.code === "ECONNECTION"
  ) {
    return "无法连接 SMTP 服务器，请检查地址、端口和网络";
  }
  if (value.code === "EENVELOPE" || value.command === "RCPT TO") {
    return "测试收件地址被 SMTP 服务器拒绝";
  }
  if (value.code === "ESOURCE" || value.command === "MAIL FROM") {
    return "发件人被 SMTP 服务器拒绝";
  }
  if (value.responseCode === 550) {
    return "SMTP 服务器拒绝了这封邮件";
  }
  return "SMTP 发送失败，请检查服务器配置";
}

export async function sendSmtpTest(toEmail: string) {
  const settings = getSavedSmtpSettings();
  if (!settings) throw new Error("SMTP 配置不完整或登录密码不可用");
  const transporter = createTransporter(settings);
  try {
    await transporter.sendMail({
      from: {
        name: settings.fromName,
        address: settings.fromAddress
      },
      to: toEmail,
      subject: "Allocube 邮件发送测试 / Email delivery test",
      html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2937">
        <p style="color:#64748b">简体中文</p><h2>邮件配置正常</h2>
        <p>这是一封由 Allocube 发送的测试邮件。</p><hr />
        <p style="color:#64748b">English</p><h2>Email delivery is working</h2>
        <p>This is a test email sent by Allocube.</p>
      </div>`
    });
  } catch (error) {
    throw new Error(classifySmtpError(error));
  } finally {
    transporter.close();
  }
}

export async function processEmailOutbox() {
  if (emailOutboxProcessing) return;
  emailOutboxProcessing = true;
  try {
    if (!activeTransporter()) return;
    const now = nowIso();
    db.prepare(
      `UPDATE email_outbox
       SET status = 'EXPIRED', cancellation_reason = '邮件内容已过期',
         to_email = '[redacted]', html = '[redacted]'
       WHERE status IN ('PENDING', 'FAILED')
         AND expires_at IS NOT NULL AND expires_at <= ?`
    ).run(now);
    const rows = db
      .prepare(
        `SELECT * FROM email_outbox
         WHERE status IN ('PENDING', 'FAILED') AND next_attempt_at <= ?
         ORDER BY created_at LIMIT 20`
      )
      .all(now) as Array<{
      id: string;
      to_email: string;
      subject: string;
      html: string;
      attempts: number;
    }>;
    for (const row of rows) {
      const active = activeTransporter();
      if (!active) return;
      try {
        await active.transporter.sendMail({
          from: {
            name: active.settings.fromName,
            address: active.settings.fromAddress
          },
          to: row.to_email,
          subject: row.subject,
          html: row.html
        });
        db.prepare(
          `UPDATE email_outbox SET
             status = 'SENT', attempts = attempts + 1, sent_at = ?,
             last_error = '', to_email = '[redacted]', html = '[redacted]'
           WHERE id = ?`
        ).run(nowIso(), row.id);
      } catch (error) {
        const attempts = row.attempts + 1;
        const delayMinutes = Math.min(60, 2 ** Math.min(attempts, 6));
        db.prepare(
          `UPDATE email_outbox
           SET status = 'FAILED', attempts = ?, last_error = ?, next_attempt_at = ?
           WHERE id = ?`
        ).run(
          attempts,
          classifySmtpError(error),
          new Date(Date.now() + delayMinutes * 60 * 1000).toISOString(),
          row.id
        );
      }
    }
  } finally {
    emailOutboxProcessing = false;
  }
}

export function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
      })[character]!
  );
}
