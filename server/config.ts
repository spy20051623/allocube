import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

loadEnvFile();

const isProduction = process.env.NODE_ENV === "production";
const databasePath = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/allocube.sqlite"
);

type InstanceSecrets = {
  version: 1;
  sessionSecret: string;
  smtpSettingsEncryptionKey: string;
};

function validSmtpKey(value: string) {
  try {
    return Buffer.from(value, "base64").length === 32;
  } catch {
    return false;
  }
}

function parseInstanceSecrets(raw: string, source: string): InstanceSecrets {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`实例密钥文件无法解析：${source}`);
  }
  if (
    !value ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { sessionSecret?: unknown }).sessionSecret !== "string" ||
    (value as { sessionSecret: string }).sessionSecret.length < 32 ||
    typeof (value as { smtpSettingsEncryptionKey?: unknown })
      .smtpSettingsEncryptionKey !== "string" ||
    !validSmtpKey(
      (value as { smtpSettingsEncryptionKey: string })
        .smtpSettingsEncryptionKey
    )
  ) {
    throw new Error(`实例密钥文件内容无效：${source}`);
  }
  return value as InstanceSecrets;
}

function createInstanceSecrets(): InstanceSecrets {
  return {
    version: 1,
    sessionSecret: randomBytes(32).toString("base64url"),
    smtpSettingsEncryptionKey: randomBytes(32).toString("base64")
  };
}

function loadOrCreateInstanceSecrets() {
  const secretsPath = path.join(
    path.dirname(databasePath),
    "instance-secrets.json"
  );
  fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
  const existedBefore = fs.existsSync(secretsPath);
  const databaseExistedBefore = fs.existsSync(databasePath);
  if (!existedBefore) {
    const generated = createInstanceSecrets();
    try {
      fs.writeFileSync(
        secretsPath,
        `${JSON.stringify(generated, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 }
      );
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
  try {
    fs.chmodSync(secretsPath, 0o600);
  } catch {
    if (isProduction && process.platform !== "win32") {
      throw new Error("无法限制实例密钥文件权限");
    }
  }
  return {
    path: secretsPath,
    created: !existedBefore,
    databaseExistedBefore,
    value: parseInstanceSecrets(
      fs.readFileSync(secretsPath, "utf8"),
      secretsPath
    )
  };
}

function integerBootstrapValue(
  key: string,
  fallback: number,
  min: number,
  max: number
) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} 必须是 ${min}–${max} 之间的整数`);
  }
  return value;
}

function booleanBootstrapValue(key: string, fallback: boolean) {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${key} 只能为 true 或 false`);
}

function smtpBootstrapSettings() {
  const host = process.env.BOOTSTRAP_SMTP_HOST?.trim() ?? "";
  const username = process.env.BOOTSTRAP_SMTP_USERNAME?.trim() ?? "";
  const password = process.env.BOOTSTRAP_SMTP_PASSWORD ?? "";
  const fromAddress = process.env.BOOTSTRAP_SMTP_FROM_ADDRESS?.trim() ?? "";
  const fromName =
    process.env.BOOTSTRAP_SMTP_FROM_NAME?.trim() || "Allocube";
  const enabled = booleanBootstrapValue("BOOTSTRAP_SMTP_ENABLED", false);
  const configured = Boolean(host || username || password || fromAddress);
  if (!configured && !enabled) return null;
  if (!host || !username || !password || !fromAddress) {
    throw new Error(
      "首次启动 SMTP 配置不完整，请同时填写服务器、账号、密码和发件邮箱"
    );
  }
  if (host.length > 253 || /\s/.test(host)) {
    throw new Error("BOOTSTRAP_SMTP_HOST 格式不正确");
  }
  if (username.length > 320 || password.length > 1024) {
    throw new Error("首次启动 SMTP 账号或密码过长");
  }
  if (fromName.length > 100) {
    throw new Error("BOOTSTRAP_SMTP_FROM_NAME 不能超过100个字符");
  }
  if (
    fromAddress.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(fromAddress)
  ) {
    throw new Error("BOOTSTRAP_SMTP_FROM_ADDRESS 格式不正确");
  }
  const securityValue =
    process.env.BOOTSTRAP_SMTP_SECURITY?.trim() || "IMPLICIT_TLS";
  if (
    securityValue !== "IMPLICIT_TLS" &&
    securityValue !== "STARTTLS"
  ) {
    throw new Error(
      "BOOTSTRAP_SMTP_SECURITY 只能为 IMPLICIT_TLS 或 STARTTLS"
    );
  }
  return {
    enabled,
    host,
    port: integerBootstrapValue("BOOTSTRAP_SMTP_PORT", 465, 1, 65535),
    security: securityValue,
    username,
    password,
    fromName,
    fromAddress
  };
}

const instanceSecrets = loadOrCreateInstanceSecrets();

function loadBootstrapConfig() {
  const bootstrap = {
    adminName:
      process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "系统管理员",
    adminPassword:
      process.env.BOOTSTRAP_ADMIN_PASSWORD || "Admin12#$",
    siteOrigin:
      process.env.BOOTSTRAP_SITE_ORIGIN?.trim() ||
      (isProduction ? "" : "http://localhost:5173"),
    allowedEmailDomains: (
      process.env.BOOTSTRAP_ALLOWED_EMAIL_DOMAINS ?? ""
    )
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
    minBookingMinutes: integerBootstrapValue(
      "BOOTSTRAP_MIN_BOOKING_MINUTES",
      1,
      1,
      1440
    ),
    maxBookingMinutes: integerBootstrapValue(
      "BOOTSTRAP_MAX_BOOKING_MINUTES",
      1440,
      1,
      10080
    ),
    advanceDays: integerBootstrapValue(
      "BOOTSTRAP_ADVANCE_DAYS",
      30,
      1,
      365
    ),
    smtp: smtpBootstrapSettings()
  };
  if (
    bootstrap.maxBookingMinutes <
    bootstrap.minBookingMinutes
  ) {
    throw new Error(
      "BOOTSTRAP_MAX_BOOKING_MINUTES 不能小于最短占用时间"
    );
  }
  return bootstrap;
}

export type BootstrapConfig = ReturnType<typeof loadBootstrapConfig>;

export function getBootstrapConfig() {
  return loadBootstrapConfig();
}

export const config = {
  isProduction,
  host:
    process.env.HOST?.trim() ||
    (isProduction ? "0.0.0.0" : "127.0.0.1"),
  port: Number(process.env.PORT ?? 8787),
  databasePath,
  instanceSecretsPath: instanceSecrets.path,
  instanceSecretsCreated: instanceSecrets.created,
  instanceSecretsCreatedForExistingDatabase:
    instanceSecrets.created && instanceSecrets.databaseExistedBefore,
  sessionSecret: instanceSecrets.value.sessionSecret,
  smtpSettingsEncryptionKey:
    instanceSecrets.value.smtpSettingsEncryptionKey
};

export function validateRuntimeConfig() {
  const issues: string[] = [];
  if (!["127.0.0.1", "0.0.0.0", "::"].includes(config.host)) {
    issues.push("HOST（127.0.0.1、0.0.0.0 或 ::）");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    issues.push("PORT（1–65535）");
  }
  if (issues.length) {
    throw new Error(`启动配置不完整或无效：${issues.join("、")}`);
  }
}
