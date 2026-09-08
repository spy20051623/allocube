import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { SCHEMA_V21_SQL, FINAL_SCHEMA_VERSION } from "./helpers/schema-v21";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-machine-announcement-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "legacy.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "AnnouncementMigration82!";
let database: typeof import("../server/db");
afterAll(() => { database?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

it("版本 21 升级保留机器信息，公告默认空，重复启动不重复迁移", async () => {
  const legacy = new Database(process.env.DATABASE_PATH!);
  legacy.exec(SCHEMA_V21_SQL);
  legacy.prepare("INSERT INTO schema_migrations VALUES(21,?)").run(new Date().toISOString());
  legacy.prepare("INSERT INTO machines(id,name,version,created_at,updated_at) VALUES('retained','保留机器',7,'before','before')").run();
  legacy.close();
  database = await import("../server/db");
  await database.initializeDatabase();
  expect(database.db.prepare("SELECT name,version,announcement,updated_at FROM machines WHERE id='retained'").get())
    .toEqual({ name: "保留机器", version: 7, announcement: "", updated_at: "before" });
  await database.initializeDatabase();
  expect(database.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: FINAL_SCHEMA_VERSION });
  expect(database.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=22").get()).toEqual({ n: 1 });
});
