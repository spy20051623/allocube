import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const databasePath = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/allocube.sqlite"
);
const backupDirectory = path.resolve(
  process.cwd(),
  process.env.BACKUP_DIR ?? "./backups"
);
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);

if (!Number.isInteger(retentionDays) || retentionDays < 1) {
  throw new Error("BACKUP_RETENTION_DAYS 必须是大于 0 的整数");
}

if (!fs.existsSync(databasePath)) {
  throw new Error(`数据库不存在：${databasePath}`);
}

fs.mkdirSync(backupDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const destination = path.join(backupDirectory, `allocube-${stamp}.sqlite`);
const database = new Database(databasePath, { readonly: true });

try {
  await database.backup(destination);
  let backup;
  let validationError;
  try {
    backup = new Database(destination, { readonly: true, fileMustExist: true });
    const quickCheck = backup.pragma("quick_check");
    const messages = quickCheck.flatMap((row) => Object.values(row));
    if (messages.length !== 1 || messages[0] !== "ok") {
      throw new Error(`完整性检查失败：${messages.join("；")}`);
    }
    const schemaVersion = backup
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get();
    if (!schemaVersion?.version) {
      throw new Error("缺少数据库结构版本");
    }
  } catch (error) {
    validationError = error;
  } finally {
    backup?.close();
  }
  for (const suffix of ["-shm", "-wal"]) {
    const sidecar = `${destination}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  if (validationError) {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    throw new Error(
      `备份校验失败：${
        validationError instanceof Error
          ? validationError.message
          : String(validationError)
      }`
    );
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const item of fs.readdirSync(backupDirectory, { withFileTypes: true })) {
    if (
      item.isFile() &&
      item.name.startsWith("allocube-") &&
      item.name.endsWith(".sqlite")
    ) {
      const filePath = path.join(backupDirectory, item.name);
      if (fs.statSync(filePath).mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  }
  console.log(`备份完成：${destination}`);
} finally {
  database.close();
}
