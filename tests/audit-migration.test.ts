import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";
import { AUDIT_INDEX_SQL } from "../server/audit-schema";
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"allocube-audit-migration-"));
process.env.NODE_ENV="test";process.env.DATABASE_PATH=path.join(directory,"legacy.sqlite");
let database: typeof import("../server/db");
afterAll(()=>database?.db.close());
it("upgrades version 20 in place, preserves audit payloads and restores a backup",async()=>{
  const legacy=new Database(process.env.DATABASE_PATH!);legacy.exec(FINAL_SCHEMA_SQL.replace(AUDIT_INDEX_SQL,""));
  legacy.prepare("INSERT INTO schema_migrations VALUES(20,?)").run(new Date().toISOString());
  legacy.prepare("INSERT INTO audit_logs(id,action,entity_type,entity_id,after_json,created_at) VALUES('old','OLD','settings','booking','{broken','2020-01-01T00:00:00.000Z')").run();legacy.close();
  database=await import("../server/db");await database.initializeDatabase();await database.initializeDatabase();
  expect(database.db.prepare("SELECT MAX(version) AS n FROM schema_migrations").get()).toEqual({n:21});
  expect(database.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=21").get()).toEqual({n:1});
  expect(database.db.prepare("SELECT after_json FROM audit_logs WHERE id='old'").get()).toEqual({after_json:"{broken"});
  await database.db.backup(path.join(directory,"restored.sqlite"));const restored=new Database(path.join(directory,"restored.sqlite"));
  try { expect(restored.pragma("quick_check",{simple:true})).toBe("ok");expect(restored.prepare("SELECT name FROM sqlite_master WHERE name='audit_time_id_idx'").get()).toBeTruthy(); }
  finally { restored.close(); }
});
