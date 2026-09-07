import type { AdminSettingsPayload } from "../../src/shared/settings.js";
import { addAudit, db, getAdminSettings, nowIso, withImmediateTransaction } from "../db.js";
import { BusinessError } from "../business-error.js";

interface SettingsAudit {
  action: string;
  entityId: string;
  before: unknown;
  after: unknown;
}

/** Keep the version check, section update and audit in one immediate transaction. */
export function updateAdminSettings(
  actorId: string,
  expected: { expectedVersion: number; overwrite: boolean },
  write: (updatedAt: string) => void,
  audit: (before: AdminSettingsPayload, after: AdminSettingsPayload) => SettingsAudit
): AdminSettingsPayload {
  return withImmediateTransaction(() => {
    const before = getAdminSettings();
    if (!expected.overwrite && before.version !== expected.expectedVersion) {
      throw new BusinessError(
        "系统设置已由其他管理员更新，请刷新后重试",
        409,
        undefined,
        "SETTINGS_VERSION_CONFLICT"
      );
    }
    const updatedAt = nowIso();
    write(updatedAt);
    db.prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES('settings_version', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(String(before.version + 1), updatedAt);
    const after = getAdminSettings();
    const record = audit(before, after);
    addAudit(actorId, record.action, "settings", record.entityId, record.before, record.after);
    return after;
  });
}
