import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { config, getBootstrapConfig } from "./config.js";
import { FINAL_SCHEMA_SQL, FINAL_SCHEMA_VERSION } from "./schema.js";
import { seedDatabase } from "./seed-data.js";
import { normalizeAllowedEmailDomains } from "../src/shared/email-domain-rules.js";
import {
  normalizeSiteOrigin,
  siteOriginValidationError
} from "../src/shared/site-origin.js";
import {
  decryptSmtpPassword,
  decryptSmtpPasswordWithKey,
  encryptSmtpPassword
} from "./smtp-crypto.js";

export type Db = Database.Database;

const REQUIRED_TABLES = [
  "schema_migrations",
  "users",
  "sessions",
  "api_tokens",
  "prepared_api_operations",
  "auth_tokens",
  "email_verification_challenges",
  "employee_numbers",
  "pending_registration_employee_numbers",
  "registration_revisions",
  "profile_change_requests",
  "machines",
  "machine_admins",
  "machine_access_memberships",
  "machine_access_requests",
  "resource_pools",
  "resource_pool_items",
  "resource_groups",
  "resource_group_allocations",
  "resource_unavailability",
  "reservation_batches",
  "reservations",
  "notifications",
  "email_outbox",
  "smtp_settings",
  "settings",
  "audit_logs",
  "app_meta"
] as const;

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const db = new Database(config.databasePath, { timeout: 5000 });
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = FULL");
db.pragma("secure_delete = ON");
db.pragma("trusted_schema = OFF");

export async function initializeDatabase() {
  const hasMigrationTable = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    )
    .get();
  const schemaWasCreated = !hasMigrationTable;
  if (!hasMigrationTable) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(FINAL_SCHEMA_SQL);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)"
      ).run(FINAL_SCHEMA_VERSION, nowIso());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  let schemaVersion = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number | null };
  if (schemaVersion.version === 5 && FINAL_SCHEMA_VERSION >= 6) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        CREATE TABLE deleted_user_tombstones (
          user_id TEXT PRIMARY KEY REFERENCES users(id),
          deleted_at TEXT NOT NULL,
          deleted_by TEXT REFERENCES users(id),
          cleanup_counts_json TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(6, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 6 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 6 && FINAL_SCHEMA_VERSION >= 7) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE users ADD COLUMN disabled_at TEXT;
        ALTER TABLE users ADD COLUMN disabled_by TEXT REFERENCES users(id);
        ALTER TABLE users ADD COLUMN disable_reason TEXT NOT NULL DEFAULT '';
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(7, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 7 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 7 && FINAL_SCHEMA_VERSION >= 8) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        CREATE TABLE deleted_machine_tombstones (
          machine_id TEXT PRIMARY KEY REFERENCES machines(id),
          deleted_at TEXT NOT NULL,
          deleted_by TEXT REFERENCES users(id),
          cleanup_counts_json TEXT NOT NULL
        );
        CREATE TABLE deleted_resource_pool_tombstones (
          resource_pool_id TEXT PRIMARY KEY REFERENCES resource_pools(id),
          machine_id TEXT NOT NULL REFERENCES machines(id),
          deleted_at TEXT NOT NULL,
          deleted_by TEXT REFERENCES users(id)
        );
        CREATE TABLE deleted_resource_group_tombstones (
          resource_group_id TEXT PRIMARY KEY REFERENCES resource_groups(id),
          machine_id TEXT NOT NULL REFERENCES machines(id),
          deleted_at TEXT NOT NULL,
          deleted_by TEXT REFERENCES users(id),
          cleanup_counts_json TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(8, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 8 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 8 && FINAL_SCHEMA_VERSION >= 9) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        ALTER TABLE reservations ADD COLUMN scope TEXT NOT NULL
          DEFAULT 'RESOURCE_GROUP'
          CHECK(scope IN ('RESOURCE_GROUP', 'MACHINE'));
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(9, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 9 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 9 && FINAL_SCHEMA_VERSION >= 10) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        CREATE TABLE user_email_preferences (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          reservation_updates INTEGER NOT NULL DEFAULT 1
            CHECK(reservation_updates IN (0, 1)),
          machine_access_updates INTEGER NOT NULL DEFAULT 1
            CHECK(machine_access_updates IN (0, 1)),
          approval_updates INTEGER NOT NULL DEFAULT 1
            CHECK(approval_updates IN (0, 1)),
          administration_updates INTEGER NOT NULL DEFAULT 1
            CHECK(administration_updates IN (0, 1)),
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(10, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 10 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 10 && FINAL_SCHEMA_VERSION >= 11) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        DELETE FROM notifications WHERE type = 'AVAILABILITY_WATCH';
        DELETE FROM email_outbox WHERE subject = '订阅时段已经空闲';
        DELETE FROM audit_logs
          WHERE action = 'WATCH_CREATE'
             OR entity_type = 'availability_watch';
        DROP TABLE availability_watches;
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(11, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 11 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 11 && FINAL_SCHEMA_VERSION >= 12) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        DELETE FROM reservations
        WHERE unixepoch(end_at) - unixepoch(start_at) < 60;
        DELETE FROM reservation_batches
        WHERE NOT EXISTS (
          SELECT 1 FROM reservations WHERE batch_id = reservation_batches.id
        );
        UPDATE reservations SET
          start_at = strftime('%Y-%m-%dT%H:%M:00.000Z', start_at),
          end_at = strftime('%Y-%m-%dT%H:%M:00.000Z', end_at),
          initial_start_at = strftime('%Y-%m-%dT%H:%M:00.000Z', initial_start_at),
          initial_end_at = strftime('%Y-%m-%dT%H:%M:00.000Z', initial_end_at)
        WHERE strftime('%S', start_at) != '00'
           OR strftime('%S', end_at) != '00'
           OR strftime('%S', initial_start_at) != '00'
           OR strftime('%S', initial_end_at) != '00';
        UPDATE resource_unavailability
        SET status = 'CANCELLED'
        WHERE status = 'ACTIVE'
          AND strftime('%Y-%m-%dT%H:%M:00.000Z', end_at)
              <= strftime('%Y-%m-%dT%H:%M:00.000Z', start_at);
        UPDATE resource_unavailability SET
          start_at = strftime('%Y-%m-%dT%H:%M:00.000Z', start_at),
          end_at = strftime('%Y-%m-%dT%H:%M:00.000Z', end_at)
        WHERE strftime('%S', start_at) != '00'
           OR strftime('%S', end_at) != '00';
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(12, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 12 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 12 && FINAL_SCHEMA_VERSION >= 13) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        ALTER TABLE registration_revisions
          RENAME TO registration_revisions_v12;
        CREATE TABLE registration_revisions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          revision INTEGER NOT NULL,
          username TEXT NOT NULL,
          display_name TEXT NOT NULL,
          email TEXT,
          employee_number TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          UNIQUE(user_id, revision)
        );
        INSERT INTO registration_revisions(
          id, user_id, revision, username, display_name, email,
          employee_number, submitted_at
        )
        SELECT
          id, user_id, revision, username, display_name, email,
          employee_number, submitted_at
        FROM registration_revisions_v12;
        DROP TABLE registration_revisions_v12;
      `);
      db.prepare(
        `INSERT OR IGNORE INTO settings(key, value, updated_at)
         VALUES('registration_config_revision', '1', ?)`
      ).run(nowIso());
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(13, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 13 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version === 13 && FINAL_SCHEMA_VERSION >= 14) {
    db.exec("BEGIN EXCLUSIVE");
    try {
      db.exec(`
        CREATE TABLE api_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          access_level TEXT NOT NULL CHECK(access_level IN ('READ_ONLY', 'READ_WRITE')),
          expires_at TEXT,
          last_used_at TEXT,
          revoked_at TEXT,
          revoked_reason TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
        CREATE INDEX api_tokens_user_idx
          ON api_tokens(user_id, created_at DESC);
        CREATE INDEX api_tokens_active_idx
          ON api_tokens(token_hash, revoked_at, expires_at);

        CREATE TABLE prepared_api_operations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          api_token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
          confirmation_token_hash TEXT NOT NULL UNIQUE,
          action TEXT NOT NULL CHECK(action IN ('CREATE', 'UPDATE', 'CANCEL', 'END')),
          request_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'PENDING'
            CHECK(status IN ('PENDING', 'COMMITTED', 'REJECTED')),
          result_json TEXT,
          rejection_code TEXT,
          expires_at TEXT NOT NULL,
          retain_until TEXT NOT NULL,
          created_at TEXT NOT NULL,
          committed_at TEXT
        );
        CREATE INDEX prepared_api_operations_owner_idx
          ON prepared_api_operations(api_token_id, user_id, status, expires_at);
        CREATE INDEX prepared_api_operations_cleanup_idx
          ON prepared_api_operations(retain_until);

        ALTER TABLE audit_logs ADD COLUMN actor_api_token_id TEXT
          REFERENCES api_tokens(id) ON DELETE SET NULL;
        ALTER TABLE audit_logs ADD COLUMN api_operation_id TEXT;
      `);
      db.prepare(
        "INSERT INTO schema_migrations(version, applied_at) VALUES(14, ?)"
      ).run(nowIso());
      db.exec("COMMIT");
      schemaVersion = { version: 14 };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (schemaVersion.version !== FINAL_SCHEMA_VERSION) {
    throw new Error(
      `数据库结构版本不匹配：当前 ${schemaVersion.version ?? 0}，需要 ${FINAL_SCHEMA_VERSION}。开发阶段请先重置数据库。`
    );
  }
  const existingTables = new Set(
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name)
  );
  const missingTables = REQUIRED_TABLES.filter((table) => !existingTables.has(table));
  if (missingTables.length) {
    throw new Error(`数据库结构不完整，缺少数据表：${missingTables.join("、")}`);
  }

  const configurationMarker = db
    .prepare(
      "SELECT value FROM app_meta WHERE key = 'persistent_configuration_initialized'"
    )
    .get() as { value: string } | undefined;
  if (!configurationMarker) {
    const rowCounts = {
      users: (
        db.prepare("SELECT COUNT(*) AS count FROM users").get() as {
          count: number;
        }
      ).count,
      settings: (
        db.prepare("SELECT COUNT(*) AS count FROM settings").get() as {
          count: number;
        }
      ).count,
      smtp: (
        db.prepare("SELECT COUNT(*) AS count FROM smtp_settings").get() as {
          count: number;
        }
      ).count
    };
    const shouldApplyBootstrap =
      schemaWasCreated ||
      (rowCounts.users === 0 &&
        rowCounts.settings === 0 &&
        rowCounts.smtp === 0);
    if (shouldApplyBootstrap) {
      await initializePersistentConfiguration();
    } else {
      adoptExistingPersistentConfiguration();
    }
  }
  db.prepare(
    `INSERT OR IGNORE INTO settings(key, value, updated_at)
     VALUES('registration_config_revision', '1', ?)`
  ).run(nowIso());
  db.prepare(
    `INSERT OR IGNORE INTO settings(key, value, updated_at)
     VALUES('allow_registration_without_email', '1', ?)`
  ).run(nowIso());
  assertPersistentConfiguration();
  migrateDevelopmentSmtpKey();
  cleanupExpiredSecurityRecords();
  assertDatabaseIntegrity();
}

function migrateDevelopmentSmtpKey() {
  if (config.isProduction) return;
  const row = db
    .prepare(
      "SELECT password_encrypted AS password FROM smtp_settings WHERE id = 1"
    )
    .get() as { password: string | null } | undefined;
  if (!row?.password) return;
  try {
    decryptSmtpPassword(row.password);
    return;
  } catch {
    // 开发阶段早期版本使用固定密钥；仅在本机将其一次性换成实例密钥。
  }
  try {
    const password = decryptSmtpPasswordWithKey(
      row.password,
      Buffer.alloc(32, 7).toString("base64")
    );
    db.prepare(
      `UPDATE smtp_settings
       SET password_encrypted = ?, version = version + 1, updated_at = ?
       WHERE id = 1`
    ).run(encryptSmtpPassword(password), nowIso());
  } catch {
    // 不是旧开发密钥时保留原密文，由管理员重新输入密码。
  }
}

async function initializePersistentConfiguration() {
  const bootstrap = getBootstrapConfig();
  const allowedEmailDomains = normalizeAllowedEmailDomains(
    bootstrap.allowedEmailDomains
  );
  const siteOrigin = bootstrap.siteOrigin
    ? normalizeSiteOrigin(bootstrap.siteOrigin)
    : "";
  const initializedAt = nowIso();
  db.exec("BEGIN EXCLUSIVE");
  try {
    const insertSetting = db.prepare(
      "INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)"
    );
    for (const [key, value] of Object.entries({
      min_booking_minutes: String(
        bootstrap.minBookingMinutes
      ),
      max_booking_minutes: String(
        bootstrap.maxBookingMinutes
      ),
      advance_days: String(bootstrap.advanceDays),
      timezone: "Asia/Shanghai",
      public_site_origin: siteOrigin,
      allowed_email_domains: JSON.stringify(allowedEmailDomains),
      allow_registration_without_email: "1",
      registration_config_revision: "1",
      settings_version: "1"
    })) {
      insertSetting.run(key, value, initializedAt);
    }
    const smtp = bootstrap.smtp;
    db.prepare(
      `INSERT INTO smtp_settings(
        id, enabled, host, port, security, username,
        password_encrypted, from_name, from_address,
        version, updated_at
      ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).run(
      smtp?.enabled ? 1 : 0,
      smtp?.host ?? "",
      smtp?.port ?? 465,
      smtp?.security ?? "IMPLICIT_TLS",
      smtp?.username ?? "",
      smtp ? encryptSmtpPassword(smtp.password) : null,
      smtp?.fromName ?? "Allocube",
      smtp?.fromAddress ?? "",
      initializedAt
    );
    db.prepare(
      "INSERT INTO app_meta(key, value) VALUES('schedule_revision', '1')"
    ).run();
    db.prepare(
      "INSERT INTO app_meta(key, value) VALUES('machine_access_revision', '1')"
    ).run();
    await seedDatabase(db, bootstrap, nowIso);
    db.prepare(
      `INSERT INTO app_meta(key, value)
       VALUES('persistent_configuration_initialized', ?)`
    ).run(
      JSON.stringify({
        version: 1,
        initializedAt,
        source: "bootstrap"
      })
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function adoptExistingPersistentConfiguration() {
  const adoptedAt = nowIso();
  withImmediateTransaction(() => {
    const insertSetting = db.prepare(
      "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES(?, ?, ?)"
    );
    const compatibilityDefaults: Record<string, string> = {
      min_booking_minutes: "1",
      max_booking_minutes: "1440",
      advance_days: "30",
      timezone: "Asia/Shanghai",
      public_site_origin: config.isProduction
        ? ""
        : "http://localhost:5173",
      allowed_email_domains: "[]",
      allow_registration_without_email: "1",
      registration_config_revision: "1",
      settings_version: "1"
    };
    for (const [key, value] of Object.entries(compatibilityDefaults)) {
      insertSetting.run(key, value, adoptedAt);
    }
    db.prepare(
      `INSERT OR IGNORE INTO smtp_settings(
        id, enabled, host, port, security, username, from_name, from_address,
        version, updated_at
      ) VALUES(1, 0, '', 465, 'IMPLICIT_TLS', '', 'Allocube', '', 1, ?)`
    ).run(adoptedAt);
    db.prepare(
      "INSERT OR IGNORE INTO app_meta(key, value) VALUES('schedule_revision', '1')"
    ).run();
    db.prepare(
      "INSERT OR IGNORE INTO app_meta(key, value) VALUES('machine_access_revision', '1')"
    ).run();
    db.prepare(
      `INSERT INTO app_meta(key, value)
       VALUES('persistent_configuration_initialized', ?)`
    ).run(
      JSON.stringify({
        version: 1,
        initializedAt: adoptedAt,
        source: "existing_database"
      })
    );
  });
}

function assertPersistentConfiguration() {
  const requiredSettingKeys = [
    "min_booking_minutes",
    "max_booking_minutes",
    "advance_days",
    "timezone",
    "public_site_origin",
    "allowed_email_domains",
    "allow_registration_without_email",
    "registration_config_revision",
    "settings_version"
  ];
  const rows = db
    .prepare("SELECT key FROM settings")
    .all() as Array<{ key: string }>;
  const keys = new Set(rows.map((row) => row.key));
  const missing = requiredSettingKeys.filter((key) => !keys.has(key));
  if (missing.length) {
    throw new Error(`持久配置不完整，缺少：${missing.join("、")}`);
  }
  if (
    !db
      .prepare("SELECT 1 FROM smtp_settings WHERE id = 1")
      .get()
  ) {
    throw new Error("持久配置不完整，缺少邮件发送配置");
  }
  if (
    !db
      .prepare(
        "SELECT 1 FROM users WHERE role = 'SYSTEM_ADMIN' LIMIT 1"
      )
      .get()
  ) {
    throw new Error("持久配置不完整，缺少系统管理员");
  }
}

export function cleanupExpiredSecurityRecords(at = nowIso()) {
  return withImmediateTransaction(() => ({
    sessions: db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at).changes,
    authTokens: db
      .prepare("DELETE FROM auth_tokens WHERE expires_at <= ? OR used_at IS NOT NULL")
      .run(at).changes,
    emailChallenges: db
      .prepare(
        `DELETE FROM email_verification_challenges
         WHERE expires_at <= ? OR used_at IS NOT NULL`
      )
      .run(at).changes,
    preparedApiOperations: db
      .prepare("DELETE FROM prepared_api_operations WHERE retain_until <= ?")
      .run(at).changes
  }));
}

function assertDatabaseIntegrity() {
  const quickCheck = db.pragma("quick_check") as Array<Record<string, string>>;
  const quickCheckMessages = quickCheck.flatMap((row) => Object.values(row));
  if (quickCheckMessages.length !== 1 || quickCheckMessages[0] !== "ok") {
    throw new Error(`数据库完整性检查失败：${quickCheckMessages.join("；")}`);
  }
  const foreignKeyErrors = db.pragma("foreign_key_check") as Array<
    Record<string, string | number>
  >;
  if (foreignKeyErrors.length) {
    throw new Error(`数据库外键检查失败，共发现 ${foreignKeyErrors.length} 项异常`);
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function currentMinuteIso(now = Date.now()) {
  return new Date(Math.floor(now / 60_000) * 60_000).toISOString();
}

export function checkpointSensitiveDeletion() {
  db.pragma("wal_checkpoint(TRUNCATE)");
}

export function getSettingNumber(key: string, fallback: number) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : fallback;
}

export function getAllowedEmailDomains() {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'allowed_email_domains'")
    .get() as { value: string } | undefined;
  if (!row) return [];
  const parsed = JSON.parse(row.value) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((value): value is string => typeof value === "string")
  ) {
    throw new Error("邮箱域名白名单配置已损坏");
  }
  return normalizeAllowedEmailDomains(parsed);
}

export function getRegistrationConfigRevision() {
  return getSettingNumber("registration_config_revision", 1);
}

export function getAllowRegistrationWithoutEmail() {
  return getSettingNumber("allow_registration_without_email", 1) === 1;
}

export function incrementRegistrationConfigRevision(at = nowIso()) {
  db.prepare(
    `UPDATE settings
     SET value = CAST(value AS INTEGER) + 1, updated_at = ?
     WHERE key = 'registration_config_revision'`
  ).run(at);
  return getRegistrationConfigRevision();
}

export function getSettings() {
  return {
    minBookingMinutes: getSettingNumber("min_booking_minutes", 1),
    maxBookingMinutes: getSettingNumber("max_booking_minutes", 1440),
    advanceDays: getSettingNumber("advance_days", 30),
    timezone: "Asia/Shanghai"
  };
}

export function getPublicSiteOrigin() {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'public_site_origin'")
    .get() as { value: string } | undefined;
  const value = row?.value.trim() ?? "";
  if (
    !value ||
    siteOriginValidationError(value)
  ) {
    return "";
  }
  return normalizeSiteOrigin(value);
}

export function getAdminSettings() {
  return {
    ...getSettings(),
    allowedEmailDomains: getAllowedEmailDomains(),
    allowRegistrationWithoutEmail: getAllowRegistrationWithoutEmail(),
    siteOrigin: getPublicSiteOrigin(),
    version: getSettingNumber("settings_version", 1)
  };
}

let transactionSavepointSequence = 0;

export function withImmediateTransaction<T>(action: () => T): T {
  if (db.inTransaction) {
    transactionSavepointSequence += 1;
    const savepoint = `allocube_nested_${transactionSavepointSequence}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = action();
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function addAudit(
  actorUserId: string | null,
  action: string,
  entityType: string,
  entityId: string | null,
  before?: unknown,
  after?: unknown,
  apiContext?: {
    apiTokenId?: string;
    apiOperationId?: string;
  }
) {
  db.prepare(
    `INSERT INTO audit_logs(
      id, actor_user_id, action, entity_type, entity_id,
      before_json, after_json, actor_api_token_id, api_operation_id, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    actorUserId,
    action,
    entityType,
    entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    apiContext?.apiTokenId ?? null,
    apiContext?.apiOperationId ?? null,
    nowIso()
  );
}

export function bumpScheduleRevision() {
  db.prepare(
    `INSERT INTO app_meta(key, value) VALUES('schedule_revision', '2')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  ).run();
  return getScheduleRevision();
}

export function getScheduleRevision() {
  const row = db
    .prepare("SELECT value FROM app_meta WHERE key = 'schedule_revision'")
    .get() as { value: string } | undefined;
  return Number(row?.value ?? 1);
}

export function bumpMachineAccessRevision() {
  db.prepare(
    `INSERT INTO app_meta(key, value) VALUES('machine_access_revision', '2')
     ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1`
  ).run();
  return getMachineAccessRevision();
}

export function getMachineAccessRevision() {
  const row = db
    .prepare("SELECT value FROM app_meta WHERE key = 'machine_access_revision'")
    .get() as { value: string } | undefined;
  return Number(row?.value ?? 1);
}

export function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}
