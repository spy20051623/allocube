import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL, FINAL_SCHEMA_VERSION } from "../server/schema.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-email-v19-"));
const databasePath = path.join(directory, "version-18.sqlite");
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";

let dbModule: typeof import("../server/db.js");

beforeAll(async () => {
  const tableStart = FINAL_SCHEMA_SQL.indexOf(
    "  CREATE TABLE admin_request_email_reminders ("
  );
  const tableEnd = FINAL_SCHEMA_SQL.indexOf("  CREATE TABLE email_outbox (", tableStart);
  if (tableStart < 0 || tableEnd <= tableStart) {
    throw new Error("无法构造版本 18 数据库");
  }
  const version18Schema =
    FINAL_SCHEMA_SQL.slice(0, tableStart) + FINAL_SCHEMA_SQL.slice(tableEnd);
  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(version18Schema);
  legacy.prepare(
    "INSERT INTO schema_migrations(version, applied_at) VALUES(18, ?)"
  ).run("2026-09-01T00:00:00.000Z");
  legacy.prepare(
    `INSERT INTO users(
       id, username, username_normalized, email, display_name, password_hash,
       role, status, created_at, updated_at
     ) VALUES('legacy-user', 'legacy', 'legacy', 'legacy@example.com',
       'Legacy', 'hash', 'SYSTEM_ADMIN', 'ACTIVE', ?, ?)`
  ).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  legacy.prepare(
    `INSERT INTO user_email_preferences(
       user_id, reservation_updates, machine_access_updates,
       approval_updates, administration_updates, updated_at
     ) VALUES('legacy-user', 0, 1, 0, 1, ?)`
  ).run("2026-09-01T00:00:00.000Z");
  legacy.prepare(
    `INSERT INTO notifications(
       id, user_id, type, title, body, link, created_at
     ) VALUES('legacy-notice', 'legacy-user', 'LEGACY', '保留通知',
       '保留正文', '', ?)`
  ).run("2026-09-01T00:00:00.000Z");
  legacy.prepare(
    `INSERT INTO email_outbox(
       id, user_id, to_email, subject, html, next_attempt_at, created_at
     ) VALUES('legacy-email', 'legacy-user', 'legacy@example.com',
       '保留邮件', '<p>保留</p>', ?, ?)`
  ).run("2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
  legacy.close();

  dbModule = await import("../server/db.js");
  await dbModule.initializeDatabase();
});

describe("邮件提醒数据库迁移", () => {
  it("从版本 18 增加提醒记录并保留历史数据和偏好", () => {
    expect(
      dbModule.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()
    ).toEqual({ version: FINAL_SCHEMA_VERSION });
    expect(
      dbModule.db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'admin_request_email_reminders'"
      ).get()
    ).toEqual({ name: "admin_request_email_reminders" });
    expect(
      dbModule.db.prepare(
        `SELECT reservation_updates, machine_access_updates,
                approval_updates, administration_updates
         FROM user_email_preferences WHERE user_id = 'legacy-user'`
      ).get()
    ).toEqual({
      reservation_updates: 0,
      machine_access_updates: 1,
      approval_updates: 0,
      administration_updates: 1
    });
    expect(
      dbModule.db.prepare("SELECT title, body FROM notifications WHERE id = 'legacy-notice'").get()
    ).toEqual({ title: "保留通知", body: "保留正文" });
    expect(
      dbModule.db.prepare("SELECT subject, status FROM email_outbox WHERE id = 'legacy-email'").get()
    ).toEqual({ subject: "保留邮件", status: "PENDING" });
  });
});
