import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { db, getPublicSiteOrigin, nowIso } from "./db.js";
import {
  getSavedSmtpSettings,
  getRuntimeSmtpSettings,
  type RuntimeSmtpSettings
} from "./smtp-settings.js";

let cachedTransporter:
  | {
      version: number;
      transporter: nodemailer.Transporter;
    }
  | undefined;
let emailOutboxProcessing = false;

type EmailPreferenceColumn =
  | "reservation_updates"
  | "machine_access_updates"
  | "approval_updates"
  | "administration_updates";

const notificationEmailPreference: Partial<
  Record<string, EmailPreferenceColumn>
> = {
  RESOURCE_UNAVAILABILITY: "reservation_updates",
  RESERVATION_CANCELLED: "reservation_updates",
  RESERVATION_RELEASED_BY_MANAGER: "reservation_updates",
  RESOURCE_GROUP_CHANGED: "reservation_updates",
  RESOURCE_GROUP_DELETED: "reservation_updates",
  MACHINE_DELETED: "reservation_updates",
  MACHINE_ACCESS_GRANTED: "machine_access_updates",
  MACHINE_ACCESS_REJECTED: "machine_access_updates",
  MACHINE_ACCESS_REMOVED: "machine_access_updates",
  MACHINE_ROLE_CHANGED: "machine_access_updates",
  REGISTRATION_SUBMITTED: "approval_updates",
  PROFILE_CHANGE_APPROVED: "approval_updates",
  PROFILE_CHANGE_REJECTED: "approval_updates",
  MACHINE_ACCESS_REQUEST: "administration_updates",
  USER_APPROVAL: "administration_updates",
  PROFILE_CHANGE_REVIEW: "administration_updates"
};

function notificationEmailEnabled(
  type: string,
  preferences: Record<EmailPreferenceColumn, number>
) {
  const preference = notificationEmailPreference[type];
  return preference ? Boolean(preferences[preference]) : true;
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
  sendEmail = true
) {
  const safeLink = normalizeNotificationLink(link);
  const user = db
    .prepare(
      `SELECT u.email,
        COALESCE(ep.reservation_updates, 1) AS reservation_updates,
        COALESCE(ep.machine_access_updates, 1) AS machine_access_updates,
        COALESCE(ep.approval_updates, 1) AS approval_updates,
        COALESCE(ep.administration_updates, 1) AS administration_updates
       FROM users u
       LEFT JOIN user_email_preferences ep ON ep.user_id = u.id
       WHERE u.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )`
    )
    .get(userId) as
    | ({
        email: string | null;
      } & Record<EmailPreferenceColumn, number>)
    | undefined;
  if (!user) return null;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO notifications(
      id, user_id, type, title, body, link, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).run(id, userId, type, title, body, safeLink, nowIso());
  if (sendEmail && notificationEmailEnabled(type, user)) {
    if (user.email) {
      const siteOrigin = getPublicSiteOrigin();
      const detailUrl =
        siteOrigin && safeLink
          ? new URL(safeLink, siteOrigin).toString()
          : "";
      queueEmail(
        user.email,
        title,
        `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2937">
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(body)}</p>
          ${detailUrl ? `<p><a href="${escapeHtml(detailUrl)}">查看详情</a></p>` : ""}
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
      subject: "Allocube 邮件发送测试",
      html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2937">
        <h2>邮件配置正常</h2>
        <p>这是一封由 Allocube 发送的测试邮件。</p>
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
