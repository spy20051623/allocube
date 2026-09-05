import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

const directories: string[] = [];
const validPassword = "ProductionSetup82!";
const legacyPassword = "Admin12#$";
const loader = import.meta.resolve("tsx");
const serverEntry = fileURLToPath(new URL("../server/index.ts", import.meta.url));
const databaseModule = new URL("../server/db.ts", import.meta.url).href;

function testDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-bootstrap-policy-"));
  directories.push(directory);
  return directory;
}

function runInitialization(
  directory: string,
  password: string | undefined,
  nodeEnv = "production",
  startServer = false
) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("BOOTSTRAP_")) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: nodeEnv,
    DATABASE_PATH: path.join(directory, "allocube.sqlite"),
    HOST: "127.0.0.1",
    PORT: "8787"
  });
  if (password !== undefined) env.BOOTSTRAP_ADMIN_PASSWORD = password;
  const args = startServer
    ? [serverEntry]
    : ["--input-type=module", "--eval", `
        const { db, initializeDatabase } = await import(${JSON.stringify(databaseModule)});
        try { await initializeDatabase(); } finally { db.close(); }
      `];
  return spawnSync(process.execPath, ["--import", loader, ...args], {
    // Prevent the repository's optional .env from filling in missing test values.
    cwd: directory,
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true
  });
}

function snapshot(directory: string) {
  const db = new Database(path.join(directory, "allocube.sqlite"), { readonly: true });
  try {
    return {
      users: db.prepare("SELECT id, username, password_hash FROM users ORDER BY id").all(),
      settings: db.prepare("SELECT * FROM settings ORDER BY key").all(),
      smtp: db.prepare("SELECT * FROM smtp_settings ORDER BY id").all(),
      meta: db.prepare("SELECT * FROM app_meta ORDER BY key").all()
    };
  } finally {
    db.close();
  }
}

afterAll(() => {
  for (const directory of directories) {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("allocube-bootstrap-policy-")
    ) throw new Error("拒绝清理非测试目录");
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

describe("生产首次初始化密码边界", () => {
  it.each([
    ["未设置", undefined],
    ["空字符串", ""],
    ["纯空白", "   "],
    ["旧默认密码", legacyPassword],
    ["缺少数字", "OnlyLetters!"],
    ["缺少字母", "12345678"],
    ["过短", "Ab12!"],
    ["过长", `A1${"b".repeat(63)}`],
    ["常见密码", "password123"],
    ["前后空格", ` ${validPassword} `]
  ])("%s 时拒绝服务启动且不留下初始化数据", (_label, password) => {
    const directory = testDirectory();
    const result = runInitialization(directory, password, "production", true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const logs = result.stdout + result.stderr;
    expect(logs).toContain("BOOTSTRAP_ADMIN_PASSWORD");
    expect(logs).not.toContain("Server listening");
    if (password?.trim()) expect(logs).not.toContain(password);
    expect(snapshot(directory)).toEqual({ users: [], settings: [], smtp: [], meta: [] });
  }, 15_000);

  it("校验失败后可以在原目录重试，成功后不重复初始化或覆盖配置", async () => {
    const directory = testDirectory();
    expect(runInitialization(directory, undefined).status).toBe(1);
    const initialized = runInitialization(directory, validPassword);
    expect(initialized.status, initialized.stderr).toBe(0);
    const original = snapshot(directory);
    expect(original.users).toHaveLength(1);
    const { verify } = await import("@node-rs/argon2");
    const admin = original.users[0] as { password_hash: string };
    expect(await verify(admin.password_hash, validPassword)).toBe(true);
    expect(original.settings.length).toBeGreaterThan(0);
    expect(original.smtp).toHaveLength(1);
    expect(original.meta).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "persistent_configuration_initialized" })
    ]));
    expect(JSON.stringify(original)).not.toContain(validPassword);
    for (const password of [undefined, "", legacyPassword, "ChangedSetup93!", "invalid"]) {
      const restarted = runInitialization(directory, password);
      expect(restarted.status, restarted.stderr).toBe(0);
      expect(snapshot(directory)).toEqual(original);
    }
  }, 20_000);

  it.each(["development", "test"])("%s 默认初始化保持兼容，已有默认密码实例可转为生产启动", async (nodeEnv) => {
    const directory = testDirectory();
    const result = runInitialization(directory, undefined, nodeEnv);
    expect(result.status, result.stderr).toBe(0);
    const original = snapshot(directory);
    expect(original.users).toHaveLength(1);
    const { verify } = await import("@node-rs/argon2");
    const admin = original.users[0] as { password_hash: string };
    expect(await verify(admin.password_hash, legacyPassword)).toBe(true);
    const restarted = runInitialization(directory, undefined);
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(snapshot(directory)).toEqual(original);
  }, 15_000);
});
