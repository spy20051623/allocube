import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { FINAL_SCHEMA_SQL, FINAL_SCHEMA_VERSION } from "../server/schema.js";

describe("数据库与反馈图片配套备份", () => {
  it("生成包含数量、大小和 SHA-256 的单一时间戳备份集", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-backup-test-"));
    const data = path.join(root, "data");
    const backups = path.join(root, "backups");
    const images = path.join(data, "feedback-images");
    fs.mkdirSync(images, { recursive: true });
    const databasePath = path.join(data, "allocube.sqlite");
    const database = new Database(databasePath);
    database.exec(FINAL_SCHEMA_SQL);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)").run(FINAL_SCHEMA_VERSION, "2026-08-23T00:00:00.000Z");
    database.prepare(
      `INSERT INTO users(
        id, username, username_normalized, display_name, password_hash,
        role, status, created_at, updated_at
      ) VALUES('user-1', 'backup', 'backup', '备份用户', 'hash', 'USER', 'ACTIVE', ?, ?)`
    ).run("2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    database.prepare(
      `INSERT INTO feedback_tickets(
        id, type, level, status, title, body_markdown, submitted_by,
        submitted_by_name, created_at, updated_at
      ) VALUES('ticket-1', 'ISSUE', 'NORMAL', 'SUBMITTED', '备份反馈', '正文',
        'user-1', '备份用户', ?, ?)`
    ).run("2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    fs.writeFileSync(path.join(images, "private.png"), imageBytes);
    database.prepare(
      `INSERT INTO feedback_attachments(
        id, feedback_id, uploaded_by, original_name, stored_name,
        mime_type, byte_size, created_at
      ) VALUES('attachment-1', 'ticket-1', 'user-1', 'evidence.png',
        'private.png', 'image/png', ?, ?)`
    ).run(imageBytes.length, "2026-08-23T00:00:00.000Z");
    database.close();

    const result = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", "backup.mjs")], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        BACKUP_DIR: backups,
        BACKUP_RETENTION_DAYS: "14"
      }
    });
    expect(result.status, result.stderr).toBe(0);
    const sets = fs.readdirSync(backups).filter((name) => name.startsWith("allocube-"));
    expect(sets).toHaveLength(1);
    const setPath = path.join(backups, sets[0]);
    const manifest = JSON.parse(fs.readFileSync(path.join(setPath, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      formatVersion: 1,
      schemaVersion: FINAL_SCHEMA_VERSION,
      feedbackImages: { fileCount: 1, byteSize: imageBytes.length }
    });
    expect(manifest.database.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.feedbackImages.files[0]).toMatchObject({ storedName: "private.png", byteSize: imageBytes.length });
    expect(manifest.feedbackImages.files[0].sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(fs.readFileSync(path.join(setPath, "feedback-images", "private.png"))).toEqual(imageBytes);

    const restoreData = path.join(root, "restore", "data");
    fs.mkdirSync(path.join(restoreData, "feedback-images"), { recursive: true });
    fs.copyFileSync(path.join(setPath, "allocube.sqlite"), path.join(restoreData, "allocube.sqlite"));
    fs.copyFileSync(
      path.join(setPath, "feedback-images", "private.png"),
      path.join(restoreData, "feedback-images", "private.png")
    );
    const restored = new Database(path.join(restoreData, "allocube.sqlite"), { readonly: true });
    expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
    expect(restored.prepare(
      "SELECT stored_name FROM feedback_attachments WHERE feedback_id = 'ticket-1' AND removed_at IS NULL"
    ).get()).toEqual({ stored_name: "private.png" });
    restored.close();
    expect(fs.readFileSync(path.join(restoreData, "feedback-images", "private.png"))).toEqual(imageBytes);
  });
});
