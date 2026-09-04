import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { firstPasswordError } from "../src/shared/identity-rules.js";
import { hashPassword } from "./password-hashing.js";
import type { BootstrapConfig } from "./config.js";

export async function bootstrapAdministrator(
  db: Database.Database,
  bootstrap: BootstrapConfig,
  nowIso: () => string
) {
  if (
    db.prepare("SELECT 1 FROM users WHERE role = 'SYSTEM_ADMIN' LIMIT 1").get() ||
    !bootstrap.adminPassword
  ) {
    return;
  }
  const passwordError = firstPasswordError(bootstrap.adminPassword, {
    username: "Administrator"
  });
  if (passwordError) {
    throw new Error(`Administrator 初始化密码不符合要求：${passwordError}`);
  }
  const id = randomUUID();
  const now = nowIso();
  db.prepare(
    `INSERT INTO users(
      id, username, username_normalized, email, display_name, password_hash,
      role, status, password_change_recommended, auto_logout_minutes,
      approved_at, created_at, updated_at
    ) VALUES(?, 'Administrator', 'administrator', NULL, ?, ?,
      'SYSTEM_ADMIN', 'ACTIVE', 1, 0, ?, ?, ?)`
  ).run(
    id,
    bootstrap.adminName,
    await hashPassword(bootstrap.adminPassword),
    now,
    now,
    now
  );
}
