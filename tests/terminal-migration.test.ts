import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL } from "../server/schema";
import { SSH_KEY_SCHEMA_SQL, SSH_KEY_ACTIVATION_SCHEMA_SQL } from "../server/ssh-key-schema";
import { TERMINAL_SCHEMA_SQL } from "../server/terminal-schema";
const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "allocube-terminal-migration-"),
);
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "v22.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "TerminalMigration82!";
let database: typeof import("../server/db");
afterAll(() => {
  database?.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
it("upgrades v22 once, preserves existing verification challenges, and enables terminal purposes", async () => {
  const legacy = new Database(process.env.DATABASE_PATH!);
  legacy.exec(
    FINAL_SCHEMA_SQL.replace(SSH_KEY_ACTIVATION_SCHEMA_SQL, "").replace(SSH_KEY_SCHEMA_SQL, "").replace(TERMINAL_SCHEMA_SQL, "").replace(
      "'REGISTER', 'EMAIL_CHANGE', 'EMAIL_OLD', 'TERMINAL', 'SSH_KEY'",
      "'REGISTER', 'EMAIL_CHANGE'",
    ),
  );
  const now = new Date().toISOString(),
    future = new Date(Date.now() + 600000).toISOString();
  legacy.prepare("INSERT INTO schema_migrations VALUES(22,?)").run(now);
  legacy
    .prepare(
      "INSERT INTO email_verification_challenges(id,email,purpose,code_hash,expires_at,last_sent_at,created_at) VALUES('retained','test@example.com','REGISTER','retained-hash',?,?,?)",
    )
    .run(future, now, now);
  legacy.close();
  database = await import("../server/db");
  await database.initializeDatabase();
  await database.initializeDatabase();
  expect(
    database.db
      .prepare(
        "SELECT purpose,code_hash FROM email_verification_challenges WHERE id='retained'",
      )
      .get(),
  ).toEqual({ purpose: "REGISTER", code_hash: "retained-hash" });
  for (const purpose of ["EMAIL_OLD", "TERMINAL"])
    database.db
      .prepare(
        "INSERT INTO email_verification_challenges(id,email,purpose,code_hash,expires_at,last_sent_at,created_at) VALUES(?,'test@example.com',?,'hash',?,?,?)",
      )
      .run(purpose, purpose, future, now, now);
  expect(
    database.db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE version=23")
      .get(),
  ).toEqual({ n: 1 });
  expect(database.db.pragma("foreign_key_check")).toEqual([]);
});
