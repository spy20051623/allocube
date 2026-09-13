import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { SCHEMA_V27_SQL } from "./helpers/schema-v27";
import { FINAL_SCHEMA_SQL } from "../server/schema";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-access-expiry-migration-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "db.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Migration234!";
let database: typeof import("../server/db");
afterAll(() => { database?.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

it("migrates v27 in place, preserves history, and matches a fresh database", async () => {
  const old = new Database(process.env.DATABASE_PATH!);
  const now = new Date().toISOString();
  old.exec(SCHEMA_V27_SQL);
  old.prepare("INSERT INTO schema_migrations VALUES(27,?)").run(now);
  old.prepare("INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at) VALUES('admin','admin','admin','Admin','hash','SYSTEM_ADMIN','ACTIVE',?,?)").run(now, now);
  old.prepare("INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at) VALUES('u','u','u','Member','hash','USER','ACTIVE',?,?)").run(now, now);
  old.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES('m','Machine',?,?)").run(now, now);
  old.prepare("INSERT INTO machine_access_memberships VALUES('member','m','u','SEED',NULL,?,?)").run(now, now);
  old.prepare("INSERT INTO machine_admins VALUES('m','u','u',?)").run(now);
  old.prepare("INSERT INTO machine_access_requests(id,machine_id,user_id,status,created_at,updated_at) VALUES('pending','m','u','PENDING',?,?)").run(now, now);
  old.prepare("INSERT INTO machine_access_requests(id,machine_id,user_id,status,created_at,updated_at) VALUES('done','m','u','REJECTED',?,?)").run(now, now);
  old.close();
  database = await import("../server/db");
  await database.initializeDatabase();
  const request = database.db.prepare("SELECT * FROM machine_access_requests WHERE id='pending'").get() as any;
  expect(Date.parse(request.expires_at) - Date.now()).toBeGreaterThan(29 * 86400_000);
  expect(database.db.prepare("SELECT expires_at,version FROM machine_access_memberships WHERE id='member'").get()).toEqual({ expires_at: null, version: 1 });
  expect(database.db.prepare("SELECT status,expires_at FROM machine_access_requests WHERE id='done'").get()).toEqual({ status: "REJECTED", expires_at: null });
  await database.initializeDatabase();
  expect(database.db.prepare("SELECT expires_at FROM machine_access_requests WHERE id='pending'").get()).toEqual({ expires_at: request.expires_at });
  expect(database.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=28").get()).toEqual({ n: 1 });
  const fresh = new Database(":memory:");
  fresh.exec(FINAL_SCHEMA_SQL);
  for (const table of ["machine_access_memberships", "machine_access_requests"]) {
    const columns = (db: Database.Database) => (db.pragma(`table_info(${table})`) as any[]).map(({ name, type, notnull, dflt_value }) => ({ name, type, notnull, dflt_value })).sort((a, b) => a.name.localeCompare(b.name));
    expect(columns(database.db)).toEqual(columns(fresh));
  }
  expect(database.db.pragma("foreign_key_check")).toEqual([]);
  fresh.close();
});
