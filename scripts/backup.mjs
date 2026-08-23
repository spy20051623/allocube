import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const databasePath = path.resolve(
  process.cwd(),
  process.env.DATABASE_PATH ?? "./data/allocube.sqlite"
);
const feedbackImageDirectory = path.resolve(
  process.env.FEEDBACK_IMAGE_DIR ?? path.join(path.dirname(databasePath), "feedback-images")
);
const backupDirectory = path.resolve(
  process.cwd(),
  process.env.BACKUP_DIR ?? "./backups"
);
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS ?? 14);

if (!Number.isInteger(retentionDays) || retentionDays < 1) {
  throw new Error("BACKUP_RETENTION_DAYS 必须是大于 0 的整数");
}
if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

fs.mkdirSync(backupDirectory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const setName = `allocube-${stamp}`;
const temporarySet = path.join(backupDirectory, `.${setName}.tmp`);
const destinationSet = path.join(backupDirectory, setName);
const destinationDatabase = path.join(temporarySet, "allocube.sqlite");
const destinationImages = path.join(temporarySet, "feedback-images");
const database = new Database(databasePath, { readonly: true });

fs.mkdirSync(destinationImages, { recursive: true });
try {
  await database.backup(destinationDatabase);
  let backup;
  try {
    backup = new Database(destinationDatabase, { readonly: true, fileMustExist: true });
    const quickCheck = backup.pragma("quick_check");
    const messages = quickCheck.flatMap((row) => Object.values(row));
    if (messages.length !== 1 || messages[0] !== "ok") {
      throw new Error(`完整性检查失败：${messages.join("；")}`);
    }
    const schemaVersion = backup
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get()?.version;
    if (!schemaVersion) throw new Error("缺少数据库结构版本");

    const hasFeedbackAttachments = Boolean(
      backup.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_attachments'"
      ).get()
    );
    const imageRows = hasFeedbackAttachments
      ? backup.prepare(
          `SELECT stored_name, byte_size FROM feedback_attachments
           WHERE removed_at IS NULL AND purged_at IS NULL ORDER BY stored_name`
        ).all()
      : [];
    const images = [];
    let imageBytes = 0;
    for (const row of imageRows) {
      const storedName = path.basename(String(row.stored_name));
      if (storedName !== row.stored_name) throw new Error(`附件存储名无效：${row.stored_name}`);
      const source = path.join(feedbackImageDirectory, storedName);
      if (!fs.existsSync(source)) throw new Error(`有效反馈图片缺失：${storedName}`);
      const destination = path.join(destinationImages, storedName);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const size = fs.statSync(destination).size;
      if (size !== Number(row.byte_size)) throw new Error(`反馈图片大小不匹配：${storedName}`);
      imageBytes += size;
      images.push({ storedName, byteSize: size, sha256: sha256(destination) });
    }
    const manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      schemaVersion,
      database: {
        file: "allocube.sqlite",
        byteSize: fs.statSync(destinationDatabase).size,
        sha256: sha256(destinationDatabase)
      },
      feedbackImages: {
        directory: "feedback-images",
        fileCount: images.length,
        byteSize: imageBytes,
        files: images
      }
    };
    fs.writeFileSync(
      path.join(temporarySet, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );
  } finally {
    backup?.close();
  }

  for (const suffix of ["-shm", "-wal"]) {
    const sidecar = `${destinationDatabase}${suffix}`;
    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
  }
  fs.renameSync(temporarySet, destinationSet);

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  for (const item of fs.readdirSync(backupDirectory, { withFileTypes: true })) {
    if (!item.name.startsWith("allocube-")) continue;
    const itemPath = path.join(backupDirectory, item.name);
    if (fs.statSync(itemPath).mtimeMs >= cutoff) continue;
    if (item.isDirectory()) fs.rmSync(itemPath, { recursive: true, force: true });
    else if (item.isFile() && item.name.endsWith(".sqlite")) fs.unlinkSync(itemPath);
  }
  console.log(`备份完成：${destinationSet}`);
} catch (error) {
  fs.rmSync(temporarySet, { recursive: true, force: true });
  throw new Error(`备份失败：${error instanceof Error ? error.message : String(error)}`);
} finally {
  database.close();
}
