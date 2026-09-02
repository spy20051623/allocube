import { db, getPublicSiteOrigin, withImmediateTransaction } from "./db.js";
import { escapeHtml, queueEmail } from "./mailer.js";

export type AdminRequestKind =
  | "REGISTRATION"
  | "PROFILE_CHANGE"
  | "MACHINE_ACCESS";

type PendingRequest = {
  kind: AdminRequestKind;
  id: string;
  version: number;
  submittedAt: string;
  machineId: string | null;
};

type Recipient = {
  id: string;
  email: string;
};

const OVERDUE_AFTER_MS = 15 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
let processing = false;

function systemAdmins() {
  return db.prepare(
    `SELECT u.id, u.email
     FROM users u
     LEFT JOIN user_email_preferences ep ON ep.user_id = u.id
     WHERE u.role = 'SYSTEM_ADMIN' AND u.status = 'ACTIVE'
       AND u.email IS NOT NULL AND TRIM(u.email) != ''
       AND COALESCE(ep.administration_updates, 1) = 1
       AND NOT EXISTS (
         SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
       )`
  ).all() as Recipient[];
}

function activeMachineAdmins(machineId: string) {
  return db.prepare(
    `SELECT u.id, u.email
     FROM machine_admins ma
     JOIN users u ON u.id = ma.user_id
     LEFT JOIN user_email_preferences ep ON ep.user_id = u.id
     WHERE ma.machine_id = ? AND u.status = 'ACTIVE'
       AND u.email IS NOT NULL AND TRIM(u.email) != ''
       AND COALESCE(ep.administration_updates, 1) = 1
       AND NOT EXISTS (
         SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
       )`
  ).all(machineId) as Recipient[];
}

function pendingRequests(referenceTime: Date) {
  const cutoff = new Date(referenceTime.getTime() - OVERDUE_AFTER_MS).toISOString();
  const registrations = db.prepare(
    `SELECT 'REGISTRATION' AS kind, u.id, u.application_revision AS version,
       rr.submitted_at AS submittedAt, NULL AS machineId
     FROM users u
     JOIN registration_revisions rr
       ON rr.user_id = u.id AND rr.revision = u.application_revision
     WHERE u.status = 'PENDING_APPROVAL' AND rr.submitted_at < ?
       AND NOT EXISTS (
         SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
       )`
  ).all(cutoff) as PendingRequest[];
  const profiles = db.prepare(
    `SELECT 'PROFILE_CHANGE' AS kind, id, version,
       requested_at AS submittedAt, NULL AS machineId
     FROM profile_change_requests
     WHERE status = 'PENDING' AND requested_at < ?`
  ).all(cutoff) as PendingRequest[];
  const access = db.prepare(
    `SELECT 'MACHINE_ACCESS' AS kind, id, version,
       created_at AS submittedAt, machine_id AS machineId
     FROM machine_access_requests
     WHERE status = 'PENDING' AND created_at < ?`
  ).all(cutoff) as PendingRequest[];
  return [...registrations, ...profiles, ...access];
}

function wasReminded(adminId: string, request: PendingRequest) {
  return Boolean(db.prepare(
    `SELECT 1 FROM admin_request_email_reminders
     WHERE admin_user_id = ? AND request_kind = ?
       AND request_id = ? AND request_version = ?`
  ).get(adminId, request.kind, request.id, request.version));
}

function summaryEmail(requests: PendingRequest[], referenceTime: Date) {
  const count = (kind: AdminRequestKind) =>
    requests.filter((request) => request.kind === kind).length;
  const registrationCount = count("REGISTRATION");
  const profileCount = count("PROFILE_CHANGE");
  const accessCount = count("MACHINE_ACCESS");
  const oldestSubmittedAt = Math.min(
    ...requests.map((request) => Date.parse(request.submittedAt))
  );
  const oldestMinutes = Math.max(
    15,
    Math.floor((referenceTime.getTime() - oldestSubmittedAt) / 60_000)
  );
  const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
    `${count} ${count === 1 ? singular : pluralForm}`;
  const siteOrigin = getPublicSiteOrigin();
  const usersUrl = siteOrigin ? new URL("/admin/users", siteOrigin).toString() : "";
  const machinesUrl = siteOrigin ? new URL("/admin/machines", siteOrigin).toString() : "";
  const link = (url: string, zh: string, en: string) =>
    url ? `<p><a href="${escapeHtml(url)}">${zh} / ${en}</a></p>` : "";
  return {
    subject: `Allocube 超时待办（${requests.length}） / Pending reviews (${requests.length})`,
    html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2937">
      <p style="color:#64748b">简体中文</p>
      <h2>有 ${requests.length} 项审核待办已超时</h2>
      <p>注册审核 ${registrationCount} 项，资料修改 ${profileCount} 项，机器使用权 ${accessCount} 项；最早已等待 ${oldestMinutes} 分钟。</p>
      ${registrationCount || profileCount ? link(usersUrl, "处理用户审核", "Review users") : ""}
      ${accessCount ? link(machinesUrl, "处理机器使用权", "Review machine access") : ""}
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0" />
      <p style="color:#64748b">English</p>
      <h2>${requests.length} review item${requests.length === 1 ? " is" : "s are"} overdue</h2>
      <p>${plural(registrationCount, "registration")}, ${plural(profileCount, "profile update")}, and ${plural(accessCount, "machine access request")}. The oldest has waited ${oldestMinutes} minutes.</p>
      ${registrationCount || profileCount ? link(usersUrl, "处理用户审核", "Review users") : ""}
      ${accessCount ? link(machinesUrl, "处理机器使用权", "Review machine access") : ""}
    </div>`
  };
}

export function millisecondsUntilNextAdminReminderCheck(now = new Date()) {
  const remainder = now.getTime() % HALF_HOUR_MS;
  return remainder === 0 ? HALF_HOUR_MS : HALF_HOUR_MS - remainder;
}

export function processAdminRequestEmailReminders(referenceTime = new Date()) {
  if (processing) return { recipients: 0, requests: 0 };
  processing = true;
  try {
    const requests = pendingRequests(referenceTime);
    if (!requests.length) return { recipients: 0, requests: 0 };

    const recipients = new Map<string, { recipient: Recipient; requests: PendingRequest[] }>();
    const add = (recipient: Recipient, request: PendingRequest) => {
      if (wasReminded(recipient.id, request)) return;
      const entry = recipients.get(recipient.id) ?? { recipient, requests: [] };
      entry.requests.push(request);
      recipients.set(recipient.id, entry);
    };
    const admins = systemAdmins();
    for (const request of requests) {
      for (const admin of admins) add(admin, request);
      if (request.kind === "MACHINE_ACCESS" && request.machineId) {
        for (const admin of activeMachineAdmins(request.machineId)) add(admin, request);
      }
    }

    let queuedRecipients = 0;
    let queuedRequests = 0;
    for (const { recipient, requests: recipientRequests } of recipients.values()) {
      const uniqueRequests = [...new Map(
        recipientRequests.map((request) => [
          `${request.kind}:${request.id}:${request.version}`,
          request
        ])
      ).values()];
      const email = summaryEmail(uniqueRequests, referenceTime);
      const queued = withImmediateTransaction(() => {
        if (!queueEmail(recipient.email, email.subject, email.html, recipient.id)) {
          return false;
        }
        const queuedAt = referenceTime.toISOString();
        const insert = db.prepare(
          `INSERT OR IGNORE INTO admin_request_email_reminders(
             admin_user_id, request_kind, request_id, request_version, queued_at
           ) VALUES(?, ?, ?, ?, ?)`
        );
        for (const request of uniqueRequests) {
          insert.run(
            recipient.id,
            request.kind,
            request.id,
            request.version,
            queuedAt
          );
        }
        return true;
      });
      if (queued) {
        queuedRecipients += 1;
        queuedRequests += uniqueRequests.length;
      }
    }
    return { recipients: queuedRecipients, requests: queuedRequests };
  } finally {
    processing = false;
  }
}
