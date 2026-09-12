import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";
import { TERMINAL_HELP_SCHEMA_SQL, TERMINAL_HELP_SCHEMA_V26_SQL } from "../server/terminal-help-schema";
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"terminal-report-migration-"));
process.env.NODE_ENV="test";process.env.DATABASE_PATH=path.join(dir,"db.sqlite");process.env.BOOTSTRAP_ADMIN_PASSWORD="Migration234!";
let mod:typeof import("../server/db");
afterAll(()=>{mod?.db.close();fs.rmSync(dir,{recursive:true,force:true});});
it("migrates v26 reports without losing pending, acknowledged or resolved history",async()=>{
  const old=new Database(process.env.DATABASE_PATH!);
  old.exec(FINAL_SCHEMA_SQL.replace(TERMINAL_HELP_SCHEMA_SQL,TERMINAL_HELP_SCHEMA_V26_SQL));
  old.prepare("INSERT INTO schema_migrations VALUES(26,?)").run(new Date().toISOString());
  old.exec("INSERT INTO machines(id,name,created_at,updated_at) VALUES('m','Kept','t','t'); INSERT INTO machine_terminals(id,machine_id,callback_url,created_at) VALUES('t','m','','t')");
  for(const [id,status,outcome] of [['a','OPEN','UNCHANGED'],['b','OPEN','RECOVERY_REQUIRED'],['c','RESOLVED','RESTORED']]) {
    old.prepare("INSERT INTO terminal_help_requests(terminal_id,event_id,revision,code,scope,outcome,log_path,status,opened_at,updated_at,acknowledged_at) VALUES('t',?,1,'SSH_CONFIGURATION','sshd.service',?,'/var/log/help',?,'old','latest','ack')").run(id,outcome,status);
  }
  old.close();mod=await import("../server/db");await mod.initializeDatabase();await mod.initializeDatabase();
  expect(mod.db.prepare("SELECT event_id,severity,status,resolution_source,resolved_at,acknowledged_at FROM terminal_help_requests ORDER BY event_id").all()).toEqual([
    {event_id:'a',severity:'GENERAL',status:'OPEN',resolution_source:null,resolved_at:null,acknowledged_at:'ack'},
    {event_id:'b',severity:'URGENT',status:'OPEN',resolution_source:null,resolved_at:null,acknowledged_at:'ack'},
    {event_id:'c',severity:'GENERAL',status:'RESOLVED',resolution_source:'MACHINE',resolved_at:'latest',acknowledged_at:'ack'},
  ]);
  expect(mod.db.prepare("SELECT count(*) AS n FROM schema_migrations WHERE version=27").get()).toEqual({n:1});
  expect(mod.db.pragma("foreign_key_check")).toEqual([]);
});
