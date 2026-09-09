import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SYSTEM_MAINTENANCE_MAX_LENGTH, normalizeSystemMaintenanceText, type SystemMaintenanceNotice } from "../src/shared/system-maintenance.js";
import { requireSystemAdmin } from "./auth.js";
import { addAudit, db, nowIso, withImmediateTransaction } from "./db.js";
import { checkEditVersion, overwriteRequested } from "./edit-conflict.js";

const settingKey = "system_maintenance";
const inputSchema = z.object({
  text: z.string().transform(normalizeSystemMaintenanceText).pipe(z.string().max(SYSTEM_MAINTENANCE_MAX_LENGTH)),
  expectedVersion: z.number().int().min(1)
}).strict();

export function getSystemMaintenanceNotice(): SystemMaintenanceNotice {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(settingKey) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : { text: "", version: 1 };
}

export function registerSystemMaintenanceRoutes(app: FastifyInstance) {
  app.get("/api/v1/admin/system-maintenance", async (request, reply) => {
    if (!requireSystemAdmin(request, reply)) return;
    return getSystemMaintenanceNotice();
  });
  app.put("/api/v1/admin/system-maintenance", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const input = inputSchema.parse(request.body);
    return withImmediateTransaction(() => {
      const before = getSystemMaintenanceNotice();
      checkEditVersion(before.version, input.expectedVersion, overwriteRequested(request), "EDIT_CONFLICT");
      const after = { text: input.text, version: before.version + 1 };
      db.prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(settingKey, JSON.stringify(after), nowIso());
      addAudit(auth.user.id, "SYSTEM_MAINTENANCE_UPDATE", "settings", settingKey,
        { maintenanceText: before.text }, { maintenanceText: after.text });
      return after;
    });
  });
}
