import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FINAL_SCHEMA_VERSION } from "../server/schema.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-schema-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "schema.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";

let dbModule: typeof import("../server/db.js");

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  await dbModule.initializeDatabase();
});

describe("最终数据库结构", () => {
  it("启用删除覆写并禁用不受信任的数据库结构", () => {
    expect(
      dbModule.db.pragma("secure_delete", { simple: true })
    ).toBe(1);
    expect(
      dbModule.db.pragma("trusted_schema", { simple: true })
    ).toBe(0);
  });

  it("只创建一份最终结构版本和当前领域表", () => {
    const tables = (
      dbModule.db
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toContain("resource_pools");
    expect(tables).toContain("resource_group_allocations");
    expect(tables).toContain("resource_unavailability");
    expect(tables).toContain("pending_registration_employee_numbers");
    expect(tables).toContain("deleted_user_tombstones");
    expect(tables).toContain("deleted_machine_tombstones");
    expect(tables).toContain("deleted_resource_group_tombstones");
    expect(tables).toContain("deleted_resource_pool_tombstones");
    expect(tables).toContain("user_email_preferences");
    expect(tables).toContain("api_tokens");
    expect(tables).toContain("prepared_api_operations");
    expect(tables).toContain("announcements");
    expect(tables).toEqual(expect.arrayContaining([
      "feedback_tickets",
      "feedback_activities",
      "feedback_attachments"
    ]));
    const notificationColumns = (
      dbModule.db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(notificationColumns).toEqual(
      expect.arrayContaining(["entity_type", "entity_id", "template_key", "template_params_json"])
    );
    const announcementColumns = (
      dbModule.db.prepare("PRAGMA table_info(announcements)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(announcementColumns).toContain("published_at");
    expect(tables).toContain("schema_migrations");
    expect(tables).not.toContain("availability_watches");
    expect(tables).not.toContain("employee_number_requests");
    expect(tables).not.toContain("email_outbox_v1");
    expect(
      dbModule.db.prepare("SELECT version FROM schema_migrations").all()
    ).toEqual([{ version: FINAL_SCHEMA_VERSION }]);
  });

  it("已删除身份和 CPU 专用遗留列", () => {
    const columns = (table: string) =>
      (
        dbModule.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
    expect(columns("users")).not.toEqual(
      expect.arrayContaining(["change_deadline_at", "review_note"])
    );
    expect(columns("users")).toEqual(
      expect.arrayContaining([
        "last_login_at",
        "last_login_ip",
        "auto_logout_minutes",
        "version",
        "disabled_at",
        "disabled_by",
        "disable_reason"
      ])
    );
    const autoLogoutColumn = (
      dbModule.db.prepare("PRAGMA table_info(users)").all() as Array<{
        name: string;
        dflt_value: string | null;
      }>
    ).find((column) => column.name === "auto_logout_minutes");
    expect(autoLogoutColumn?.dflt_value).toBe("0");
    expect(columns("employee_numbers")).not.toContain("is_primary");
    expect(columns("machines")).not.toEqual(
      expect.arrayContaining(["logical_core_count", "cpu_model"])
    );
    expect(columns("resource_groups")).not.toEqual(
      expect.arrayContaining(["core_start", "core_end", "numa_label"])
    );
    expect(columns("resource_groups")).toContain("sort_order");
    expect(columns("reservations")).not.toEqual(
      expect.arrayContaining(["snapshot_core_start", "snapshot_core_end"])
    );
    expect(columns("reservations")).toContain("snapshot_resource_config_json");
    expect(columns("reservations")).toContain("scope");
    expect(columns("reservations")).toEqual(
      expect.arrayContaining([
        "initial_start_at",
        "initial_end_at",
        "adjusted_by_unavailability_id",
        "adjustment_type"
      ])
    );
    expect(columns("resource_pools")).not.toContain("status");
    expect(columns("resource_pools")).toContain("sharing_mode");
    expect(columns("resource_pool_items")).not.toContain("status");
    expect(columns("resource_unavailability")).toEqual(
      expect.arrayContaining([
        "machine_id",
        "resource_group_id",
        "kind",
        "start_at",
        "end_at",
        "status"
      ])
    );
    expect(columns("audit_logs")).toEqual(
      expect.arrayContaining(["actor_api_token_id", "api_operation_id"])
    );
    const unavailabilitySchema = dbModule.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resource_unavailability'"
      )
      .get() as { sql: string };
    expect(unavailabilitySchema.sql).not.toContain(
      "resource_group_id IS NULL OR kind = 'LONG_TERM'"
    );
  });
});
