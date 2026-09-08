import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MACHINE_ANNOUNCEMENT_MAX_LENGTH, normalizeMachineAnnouncement } from "../../src/shared/machine-announcement.js";
import { db, nowIso, addAudit, bumpScheduleRevision, withImmediateTransaction } from "../db.js";
import { BusinessError } from "../business-error.js";
import { checkEditVersion, overwriteRequested } from "../edit-conflict.js";
import { requireMachineManager } from "./access-guards.js";
import { getCurrentMachineRow } from "./records.js";

const inputSchema = z.object({
  announcement: z.string().transform(normalizeMachineAnnouncement).pipe(z.string().max(MACHINE_ANNOUNCEMENT_MAX_LENGTH)),
  expectedVersion: z.number().int().min(1)
}).strict();

export function registerMachineAnnouncementRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {
  app.put("/api/v1/admin/machines/:id/announcement", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const input = inputSchema.parse(request.body);
    const result = withImmediateTransaction(() => {
      const before = getCurrentMachineRow(auth.machineId);
      if (!before) throw new BusinessError("机器不存在", 404);
      checkEditVersion(Number(before.version), input.expectedVersion, overwriteRequested(request), "MACHINE_SETTINGS_STALE");
      db.prepare("UPDATE machines SET announcement = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(input.announcement, nowIso(), auth.machineId);
      addAudit(auth.user.id, "MACHINE_ANNOUNCEMENT_UPDATE", "machine", auth.machineId,
        { announcement: before.announcement }, { announcement: input.announcement });
      return { announcement: input.announcement, version: Number(before.version) + 1, revision: bumpScheduleRevision() };
    });
    publishRevision(result.revision);
    return result;
  });
}
