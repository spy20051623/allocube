import { REPORT_SCHEMA_SQL } from "../server/report-schema.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL, FINAL_SCHEMA_VERSION } from "../server/schema.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-feedback-migration-"));
const databasePath = path.join(directory, "version-16.sqlite");
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";

let dbModule: typeof import("../server/db.js");

beforeAll(async () => {
  const feedbackStart = FINAL_SCHEMA_SQL.indexOf("  CREATE TABLE feedback_tickets (");
  const auditStart = FINAL_SCHEMA_SQL.indexOf("  CREATE TABLE audit_logs (");
  if (feedbackStart < 0 || auditStart <= feedbackStart) throw new Error("无法构造版本 16 数据库");
  const version16Schema = (
    FINAL_SCHEMA_SQL.slice(0, feedbackStart) + FINAL_SCHEMA_SQL.slice(auditStart)
  )
    .replace("    entity_type TEXT,\n", "")
    .replace("    entity_id TEXT,\n", "")
    .replace(
      "  CREATE INDEX notifications_entity_unread_idx\n    ON notifications(user_id, entity_type, entity_id, read_at);\n",
      ""
    );
  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(version16Schema.replace(REPORT_SCHEMA_SQL, ""));
  legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(16, ?)").run("2026-08-01T00:00:00.000Z");
  legacy.prepare(
    `INSERT INTO users(
      id, username, username_normalized, display_name, password_hash,
      role, status, created_at, updated_at
    ) VALUES('user-16', 'legacy', 'legacy', '旧管理员', 'hash', 'SYSTEM_ADMIN', 'ACTIVE', ?, ?)`
  ).run("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
  legacy.prepare(
    `INSERT INTO notifications(id, user_id, type, title, body, created_at)
     VALUES('notice-16', 'user-16', 'LEGACY', '旧通知', '保留', ?)`
  ).run("2026-08-01T00:00:00.000Z");
  legacy.close();

  dbModule = await import("../server/db.js");
  await dbModule.initializeDatabase();
});

describe("反馈数据库迁移", () => {
  it("从版本 16 原地创建反馈结构并保留既有通知", () => {
    expect(dbModule.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: FINAL_SCHEMA_VERSION });
    const tables = new Set((dbModule.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name));
    expect(tables.has("feedback_tickets")).toBe(true);
    expect(tables.has("feedback_activities")).toBe(true);
    expect(tables.has("feedback_attachments")).toBe(true);
    const columns = (dbModule.db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>).map((row) => row.name);
    expect(columns).toEqual(
      expect.arrayContaining(["entity_type", "entity_id", "template_key", "template_params_json"])
    );
    expect(
      dbModule.db
        .prepare("SELECT title, body, template_key, template_params_json FROM notifications WHERE id = 'notice-16'")
        .get()
    ).toEqual({
      title: "旧通知",
      body: "保留",
      template_key: null,
      template_params_json: null
    });
  });
});
