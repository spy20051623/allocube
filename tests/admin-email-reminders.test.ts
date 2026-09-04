import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-admin-reminders-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "reminders.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SMTP_SETTINGS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

let database: typeof import("../server/db.js");
let reminders: typeof import("../server/admin-email-reminders.js");

const referenceTime = new Date("2026-09-02T04:30:00.000Z");
const oldTime = "2026-09-02T04:14:59.000Z";

function insertUser(
  id: string,
  role: "SYSTEM_ADMIN" | "USER" = "USER",
  status: "PENDING_APPROVAL" | "ACTIVE" = "ACTIVE",
  email: string | null = `${id}@example.com`
) {
  database.db.prepare(
    `INSERT INTO users(
       id, username, username_normalized, email, display_name, password_hash,
       role, status, created_at, updated_at
     ) VALUES(?, ?, ?, ?, ?, 'hash', ?, ?, ?, ?)`
  ).run(id, id, id, email, id, role, status, oldTime, oldTime);
}

function enableSmtp() {
  const { encryptSmtpPassword } = requireSmtpCrypto;
  database.db.prepare(
    `UPDATE smtp_settings SET enabled = 1, host = 'smtp.example.com',
       username = 'mailer', password_encrypted = ?, from_address = 'mailer@example.com'`
  ).run(encryptSmtpPassword("secret"));
}

let requireSmtpCrypto: typeof import("../server/smtp-crypto.js");

beforeAll(async () => {
  database = await import("../server/db.js");
  requireSmtpCrypto = await import("../server/smtp-crypto.js");
  reminders = await import("../server/admin-email-reminders.js");
  await database.initializeDatabase();
  enableSmtp();

  insertUser("system-admin", "SYSTEM_ADMIN");
  insertUser("machine-admin");
  insertUser("registration-user", "USER", "PENDING_APPROVAL");
  insertUser("profile-user");
  insertUser("access-user");
  database.db.prepare(
    `INSERT INTO machines(
       id, name, status, version, created_at, updated_at
     ) VALUES('machine-1', 'Machine 1', 'ACTIVE', 1, ?, ?)`
  ).run(oldTime, oldTime);
  database.db.prepare(
    `INSERT INTO machine_admins(machine_id, user_id, assigned_by, created_at)
     VALUES('machine-1', 'system-admin', 'system-admin', ?),
           ('machine-1', 'machine-admin', 'system-admin', ?)`
  ).run(oldTime, oldTime);
  database.db.prepare(
    `INSERT INTO user_email_preferences(
       user_id, reservation_updates, machine_access_updates,
       approval_updates, administration_updates, updated_at
     ) VALUES('machine-admin', 1, 1, 1, 0, ?)`
  ).run(oldTime);
  database.db.prepare(
    `INSERT INTO registration_revisions(
       id, user_id, revision, username, display_name, email,
       employee_number, submitted_at
     ) VALUES('registration-revision', 'registration-user', 1,
       'registration-user', 'Registration User', 'registration-user@example.com',
       'EMP-1', ?)`
  ).run(oldTime);
  database.db.prepare(
    `INSERT INTO profile_change_requests(
       id, user_id, current_display_name, current_employee_number,
       requested_display_name, requested_employee_number, status, version,
       requested_at, updated_at
     ) VALUES('profile-request', 'profile-user', 'Old', 'EMP-2',
       'New', 'EMP-3', 'PENDING', 1, ?, ?)`
  ).run(oldTime, oldTime);
  database.db.prepare(
    `INSERT INTO machine_access_requests(
       id, machine_id, user_id, reason, status, version, created_at, updated_at
     ) VALUES('access-request', 'machine-1', 'access-user', '',
       'PENDING', 1, ?, ?)`
  ).run(oldTime, oldTime);
});

describe("管理员超时待办汇总", () => {
  it("对齐北京时间整点和半点", () => {
    expect(
      reminders.millisecondsUntilNextAdminReminderCheck(
        new Date("2026-09-02T04:12:34.000Z")
      )
    ).toBe(17 * 60_000 + 26_000);
    expect(reminders.millisecondsUntilNextAdminReminderCheck(referenceTime)).toBe(
      30 * 60_000
    );
  });

  it("超过十五分钟后每位管理员仅入队一封并按请求版本去重", () => {
    const beforeThreshold = reminders.processAdminRequestEmailReminders(
      new Date("2026-09-02T04:29:58.000Z")
    );
    expect(beforeThreshold).toEqual({ recipients: 0, requests: 0 });

    const first = reminders.processAdminRequestEmailReminders(referenceTime);
    expect(first).toEqual({ recipients: 1, requests: 3 });
    expect(
      database.db.prepare(
        "SELECT COUNT(*) AS count FROM email_outbox WHERE user_id = 'system-admin'"
      ).get()
    ).toEqual({ count: 1 });
    expect(
      database.db.prepare(
        "SELECT COUNT(*) AS count FROM admin_request_email_reminders WHERE admin_user_id = 'system-admin'"
      ).get()
    ).toEqual({ count: 3 });

    database.db.prepare(
      `UPDATE user_email_preferences
       SET administration_updates = 1 WHERE user_id = 'machine-admin'`
    ).run();
    const afterEnabling = reminders.processAdminRequestEmailReminders(referenceTime);
    expect(afterEnabling).toEqual({ recipients: 1, requests: 1 });
    expect(
      database.db.prepare(
        "SELECT COUNT(*) AS count FROM email_outbox WHERE user_id = 'machine-admin'"
      ).get()
    ).toEqual({ count: 1 });
    expect(reminders.processAdminRequestEmailReminders(referenceTime)).toEqual({
      recipients: 0,
      requests: 0
    });
  });

  it("SMTP 不可用时不记提醒，恢复后可重试；新版本可再次提醒", () => {
    database.db.prepare(
      `UPDATE machine_access_requests
       SET version = 2 WHERE id = 'access-request'`
    ).run();
    database.db.prepare("UPDATE smtp_settings SET enabled = 0").run();
    expect(reminders.processAdminRequestEmailReminders(referenceTime)).toEqual({
      recipients: 0,
      requests: 0
    });
    expect(
      database.db.prepare(
        `SELECT COUNT(*) AS count FROM admin_request_email_reminders
         WHERE request_id = 'access-request' AND request_version = 2`
      ).get()
    ).toEqual({ count: 0 });

    enableSmtp();
    expect(reminders.processAdminRequestEmailReminders(referenceTime)).toEqual({
      recipients: 2,
      requests: 2
    });
    expect(
      database.db.prepare(
        `SELECT COUNT(*) AS count FROM admin_request_email_reminders
         WHERE request_id = 'access-request' AND request_version = 2`
      ).get()
    ).toEqual({ count: 2 });
  });
});
