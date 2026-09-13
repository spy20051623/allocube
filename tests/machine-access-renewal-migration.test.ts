import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";

it("upgrades v28 without changing existing grants or pending deadlines", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-renewal-migration-"));
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PATH = path.join(directory, "db.sqlite");
  process.env.BOOTSTRAP_ADMIN_PASSWORD = "Migration234!";
  const old = new Database(process.env.DATABASE_PATH);
  old.exec(FINAL_SCHEMA_SQL.replace("    previous_expires_at TEXT,\n", ""));
  const now = new Date().toISOString();
  old.prepare("INSERT INTO schema_migrations VALUES(28,?)").run(now);
  old.prepare("INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at) VALUES('a','a','a','Admin','hash','SYSTEM_ADMIN','ACTIVE',?,?)").run(now, now);
  old.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES('m','Machine',?,?)").run(now, now);
  old.prepare("INSERT INTO machine_access_requests(id,machine_id,user_id,expires_at,created_at,updated_at) VALUES('r','m','a','2099-01-01T16:00:00.000Z',?,?)").run(now, now);
  old.close();
  const database = await import("../server/db");
  try {
    await database.initializeDatabase();
    expect(database.db.prepare("SELECT previous_expires_at,expires_at,status FROM machine_access_requests WHERE id='r'").get()).toEqual({ previous_expires_at: null, expires_at: "2099-01-01T16:00:00.000Z", status: "PENDING" });
    await database.initializeDatabase();
    expect(database.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=29").get()).toEqual({ n: 1 });
    const fresh = new Database(":memory:"); fresh.exec(FINAL_SCHEMA_SQL);
    const columns = (db: Database.Database) => (db.pragma("table_info(machine_access_requests)") as any[]).map(({name,type,notnull,dflt_value}) => ({name,type,notnull,dflt_value})).sort((a,b) => a.name.localeCompare(b.name));
    expect(columns(database.db)).toEqual(columns(fresh));
    fresh.close();
  } finally { database.db.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
