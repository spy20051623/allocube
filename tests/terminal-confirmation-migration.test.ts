import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";
import { TERMINAL_CONFIRMATION_MIGRATION_SQL, TERMINAL_CHALLENGE_MIGRATION_SQL } from "../server/terminal-schema";

it("migrates existing contacted terminals without inferring a completed installation", async () => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(), "allocube-confirmation-"));
  process.env.NODE_ENV="test";
  process.env.DATABASE_PATH=path.join(directory,"db.sqlite");
  process.env.BOOTSTRAP_ADMIN_PASSWORD="Migration234!";
  const old=new Database(process.env.DATABASE_PATH);
  old.exec(FINAL_SCHEMA_SQL.replace(TERMINAL_CONFIRMATION_MIGRATION_SQL,"").replace(TERMINAL_CHALLENGE_MIGRATION_SQL,""));
  const now=new Date().toISOString();
  old.prepare("INSERT INTO schema_migrations VALUES(29,?)").run(now);
  old.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES('m','Machine',?,?)").run(now,now);
  old.prepare("INSERT INTO machine_terminals(id,machine_id,callback_url,public_key,last_seen_at,created_at) VALUES('t','m','','key',?,?)").run(now,now);
  old.close();
  const database=await import("../server/db");
  try {
    await database.initializeDatabase();
    await database.initializeDatabase();
    expect(database.db.prepare("SELECT public_key,last_seen_at,confirmed_at FROM machine_terminals WHERE id='t'").get()).toEqual({public_key:"key",last_seen_at:now,confirmed_at:null});
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=30").get()).toEqual({n:1});
    expect(database.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=31").get()).toEqual({n:1});
    expect(database.db.pragma("foreign_key_check")).toEqual([]);
  } finally { database.db.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});
