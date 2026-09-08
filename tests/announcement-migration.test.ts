import { REPORT_SCHEMA_SQL } from "../server/report-schema.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { SCHEMA_V21_SQL, FINAL_SCHEMA_VERSION } from "./helpers/schema-v21";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-announcement-migration-"));
const databasePath = path.join(directory, "version-15.sqlite");
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = databasePath;
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";

let dbModule: typeof import("../server/db.js");

beforeAll(async () => {
  const version15Schema = SCHEMA_V21_SQL
    .replace("    published_at TEXT NOT NULL,\n", "")
    .replace(
      "  CREATE INDEX announcements_status_published_idx\n    ON announcements(status, published_at, id);",
      "  CREATE INDEX announcements_status_created_idx\n    ON announcements(status, created_at, id);"
    );
  const legacy = new Database(databasePath);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(version15Schema.replace(REPORT_SCHEMA_SQL, ""));
  legacy
    .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(15, ?)")
    .run("2026-01-01T00:00:00.000Z");
  legacy
    .prepare(
      `INSERT INTO announcements(
        id, title, body_markdown, status, version,
        created_at, updated_at, withdrawn_at
      ) VALUES(?, ?, ?, 'WITHDRAWN', 2, ?, ?, ?)`
    )
    .run(
      "00000000-0000-4000-8000-000000000015",
      "迁移前公告",
      "保留正文",
      "2026-01-02T03:04:05.000Z",
      "2026-01-03T03:04:05.000Z",
      "2026-01-03T03:04:05.000Z"
    );
  legacy.close();

  dbModule = await import("../server/db.js");
  await dbModule.initializeDatabase();
});

describe("公告发布时间迁移", () => {
  it("从版本 15 升级并保留公告状态与原始时间", () => {
    expect(
      dbModule.db
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get()
    ).toEqual({ version: FINAL_SCHEMA_VERSION });
    expect(
      dbModule.db
        .prepare(
          `SELECT title, body_markdown, status, version,
                  created_at, published_at, withdrawn_at
           FROM announcements WHERE id = ?`
        )
        .get("00000000-0000-4000-8000-000000000015")
    ).toEqual({
      title: "迁移前公告",
      body_markdown: "保留正文",
      status: "WITHDRAWN",
      version: 2,
      created_at: "2026-01-02T03:04:05.000Z",
      published_at: "2026-01-02T03:04:05.000Z",
      withdrawn_at: "2026-01-03T03:04:05.000Z"
    });
  });
});
