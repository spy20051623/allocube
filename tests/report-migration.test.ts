import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { SCHEMA_V21_SQL, FINAL_SCHEMA_VERSION } from "./helpers/schema-v21";
import { REPORT_SCHEMA_SQL } from "../server/report-schema";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-report-migration-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "legacy.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "ReportsMigration82!";
let database: typeof import("../server/db");
afterAll(() => database?.db.close());
it("版本 19 原地升级保留旧数据，新增统计表可随数据库备份恢复", async () => {
  const legacy = new Database(process.env.DATABASE_PATH!);
  legacy.exec(SCHEMA_V21_SQL.replace(REPORT_SCHEMA_SQL, ""));
  legacy.prepare("INSERT INTO schema_migrations VALUES(19,?)").run(new Date().toISOString());
  legacy.prepare("INSERT INTO app_meta VALUES('retained','original')").run(); legacy.close();
  database = await import("../server/db"); await database.initializeDatabase();
  expect(database.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: FINAL_SCHEMA_VERSION });
  expect(database.db.prepare("SELECT value FROM app_meta WHERE key='retained'").get()).toEqual({ value: "original" });
  await database.initializeDatabase();
  expect(database.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version=20").get()).toEqual({ count: 1 });
  const { ReportStore } = await import("../server/report-store");
  const store = new ReportStore(database.db); store.initialize();
  const admin = (database.db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as { id: string }).id;
  const job = store.requestRebuild(admin);
  await database.db.backup(path.join(directory, "restored.sqlite"));
  const restored = new Database(path.join(directory, "restored.sqlite"));
  try {
    const resumed = new ReportStore(restored);
    expect(resumed.job()?.id).toBe(job.id);
    resumed.step(); expect(resumed.job()?.status).toBe("SUCCEEDED");
    expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
  } finally { restored.close(); }
});
