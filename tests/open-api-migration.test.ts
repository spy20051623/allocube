import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-api-migration-"));
const databasePath = path.join(directory, "version-13.sqlite");
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";

let dbModule: typeof import("../server/db.js");

beforeAll(async () => {
  const removeSchemaSection = (schema: string, start: string, end: string) => {
    const sectionStart = schema.indexOf(start);
    const sectionEnd = schema.indexOf(end);
    if (sectionStart < 0 || sectionEnd < 0 || sectionEnd <= sectionStart) {
      throw new Error("无法构造旧版数据库结构");
    }
    return schema.slice(0, sectionStart) + schema.slice(sectionEnd);
  };
  let version13Schema = removeSchemaSection(
    FINAL_SCHEMA_SQL,
    "  CREATE TABLE api_tokens (",
    "  CREATE TABLE auth_tokens ("
  );
  version13Schema = removeSchemaSection(
    version13Schema,
    "  CREATE TABLE announcements (",
    "  CREATE TABLE audit_logs ("
  )
    .replace(
      "    actor_api_token_id TEXT REFERENCES api_tokens(id) ON DELETE SET NULL,\n",
      ""
    )
    .replace("    api_operation_id TEXT,\n", "");
  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(version13Schema);
  legacy
    .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(13, ?)")
    .run(new Date().toISOString());
  legacy.close();

  dbModule = await import("../server/db.js");
  await dbModule.initializeDatabase();
});

describe("数据库连续迁移", () => {
  it("从版本 13 原地升级到当前版本", () => {
    expect(
      dbModule.db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get()
    ).toEqual({ version: 18 });
    const tables = new Set(
      (
        dbModule.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as Array<{ name: string }>
      ).map((row) => row.name)
    );
    expect(tables.has("api_tokens")).toBe(true);
    expect(tables.has("prepared_api_operations")).toBe(true);
    expect(tables.has("announcements")).toBe(true);
    const auditColumns = (
      dbModule.db.prepare("PRAGMA table_info(audit_logs)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(auditColumns).toEqual(
      expect.arrayContaining(["actor_api_token_id", "api_operation_id"])
    );
  });
});
