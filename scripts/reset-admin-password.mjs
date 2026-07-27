import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { emitKeypressEvents } from "node:readline";
import Database from "better-sqlite3";
import { Algorithm, hash } from "@node-rs/argon2";
import { firstPasswordError } from "./password-policy.mjs";

function loadEnvFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function readMasked(prompt) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("该命令需要在交互式终端中运行"));
      return;
    }
    process.stdout.write(prompt);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    const onKeypress = (character, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("操作已取消"));
      } else if (key.name === "return") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
      } else if (key.name === "backspace") {
        if (value.length) {
          value = value.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (character && !key.ctrl) {
        value += character;
        process.stdout.write("*");
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

loadEnvFile();
const databasePath = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/allocube.sqlite"
);
if (!fs.existsSync(databasePath)) {
  throw new Error(`数据库不存在：${databasePath}`);
}

const password = await readMasked("新的管理员密码（8–64 位，须含字母和数字）: ");
const confirmation = await readMasked("再次输入: ");
const passwordError = firstPasswordError(password, "Administrator");
if (passwordError) throw new Error(passwordError);
if (password !== confirmation) throw new Error("两次输入不一致");

const passwordHash = await hash(password, {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1
});
const database = new Database(databasePath);
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.pragma("secure_delete = ON");
database.pragma("trusted_schema = OFF");
database.exec("BEGIN IMMEDIATE");
let committed = false;
try {
  const admin = database
    .prepare("SELECT id FROM users WHERE username_normalized = 'administrator'")
    .get();
  if (!admin) throw new Error("Administrator 账号不存在");
  const now = new Date().toISOString();
  database
    .prepare(
      `UPDATE users SET password_hash = ?, password_change_recommended = 1,
        updated_at = ? WHERE id = ?`
    )
    .run(passwordHash, now, admin.id);
  database.prepare("DELETE FROM sessions WHERE user_id = ?").run(admin.id);
  database.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(admin.id);
  database
    .prepare(
      `INSERT INTO audit_logs(
        id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at
      ) VALUES(?, NULL, 'ADMIN_PASSWORD_RECOVERY', 'user', ?, NULL, NULL, ?)`
    )
    .run(randomUUID(), admin.id, now);
  database.exec("COMMIT");
  committed = true;
} catch (error) {
  if (!committed) database.exec("ROLLBACK");
  throw error;
} finally {
  try {
    if (committed) database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
}

console.log("Administrator 密码已恢复，所有旧会话已撤销。");
