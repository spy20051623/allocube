import { overwriteRequested, checkEditVersion } from "../edit-conflict.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  withImmediateTransaction,
  addAudit,
  bumpScheduleRevision,
  checkpointSensitiveDeletion,
  getScheduleRevision,
  db
} from "../db.js";
import { BusinessError } from "../business-error.js";
import {
  resolveUnavailabilityTarget,
  previewUnavailability,
  listUnavailability,
  createPlannedUnavailability,
  previewLongTermDisable,
  disableLongTerm,
  enableTarget,
  cancelUnavailability
} from "../unavailability.js";
import { requireMachineManagerForId, requireMachineViewer } from "./access-guards.js";
import {
  plannedUnavailabilityPreviewSchema,
  plannedUnavailabilitySchema,
  longDisableSchema,
  maintenancePreviewSchema,
  maintenanceSchema
} from "./unavailability-schema.js";
import { getCurrentResourceGroupRow } from "./records.js";
import {
  resourceGroupDeleteImpact,
  notifyDeletedResourceGroupUsers,
  deleteResourceGroupRecords
} from "./deletion-service.js";

export function registerUnavailabilityAdminRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {

  app.post(
    "/api/v1/admin/groups/:id/unavailability/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      const body = plannedUnavailabilityPreviewSchema.parse(request.body);
      return previewUnavailability(
        "RESOURCE_GROUP",
        id,
        body.startAt,
        body.endAt
      );
    }
  );

  app.get(
    "/api/v1/admin/groups/:id/unavailability",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      return {
        unavailability: listUnavailability(target.machineId, id)
      };
    }
  );

  app.post(
    "/api/v1/admin/groups/:id/unavailability",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      const body = plannedUnavailabilitySchema.parse(request.body);
      const result = createPlannedUnavailability({
        overwrite: overwriteRequested(request),
        type: "RESOURCE_GROUP",
        id,
        startAt: body.startAt,
        endAt: body.endAt,
        reason: body.reason,
        expectedRevision: body.expectedRevision,
        actorUserId: auth.user.id
      });
      publishRevision(result.revision);
      return reply.code(201).send(result);
    }
  );

  app.post(
    "/api/v1/admin/groups/:id/disable/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
      const auth = requireMachineManagerForId(request, reply, target.machineId);
      if (!auth) return;
      return previewLongTermDisable("RESOURCE_GROUP", id);
    }
  );

  app.post("/api/v1/admin/groups/:id/disable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id);
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const body = longDisableSchema.parse(request.body);
    const result = disableLongTerm({
      overwrite: overwriteRequested(request),
      type: "RESOURCE_GROUP",
      id,
      expectedVersion: body.expectedVersion,
      expectedRevision: body.expectedRevision,
      reason: body.reason,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.post("/api/v1/admin/groups/:id/enable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id);
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    const result = enableTarget({
      overwrite: overwriteRequested(request),
      type: "RESOURCE_GROUP",
      id,
      expectedVersion,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.get("/api/v1/admin/groups/:id/deletion-impact", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const target = resolveUnavailabilityTarget("RESOURCE_GROUP", id);
    const auth = requireMachineManagerForId(request, reply, target.machineId);
    if (!auth) return;
    return { group: target, counts: resourceGroupDeleteImpact(id) };
  });

  app.delete("/api/v1/admin/groups/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const group = getCurrentResourceGroupRow(id);
    if (!group) return reply.code(404).send({ error: "资源组不存在" });
    const auth = requireMachineManagerForId(request, reply, group.machine_id);
    if (!auth) return;
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    if (group.status !== "DISABLED") {
      return reply.code(409).send({ error: "请先停用资源组，再进行删除" });
    }
    withImmediateTransaction(() => {
      const fresh = getCurrentResourceGroupRow(id) as
        | { version: number; status: string }
        | undefined;
      if (
        !fresh ||
        fresh.status !== "DISABLED"
      ) {
        throw new BusinessError("资源组已更新，请刷新后重试", 409);
      }
      checkEditVersion(fresh.version, expectedVersion, overwriteRequested(request));
      const counts = resourceGroupDeleteImpact(id);
      notifyDeletedResourceGroupUsers(id, String(group.name));
      deleteResourceGroupRecords(id, auth.user.id, counts);
      addAudit(auth.user.id, "RESOURCE_GROUP_DELETE", "resource_group", id, undefined, {
        name: group.name,
        counts
      });
      bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(getScheduleRevision());
    return { deleted: true };
  });

  app.post(
    "/api/v1/admin/machines/:id/unavailability/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = plannedUnavailabilityPreviewSchema.parse(request.body);
      const auth = requireMachineManagerForId(request, reply, id);
      if (!auth) return;
      return previewUnavailability("MACHINE", id, body.startAt, body.endAt);
    }
  );

  app.get("/api/v1/admin/machines/:id/unavailability", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    return {
      unavailability: listUnavailability(auth.machineId).filter(
        (item) => item.resourceGroupId === null
      )
    };
  });

  app.post("/api/v1/admin/machines/:id/unavailability", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = plannedUnavailabilitySchema.parse(request.body);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    const result = createPlannedUnavailability({
      overwrite: overwriteRequested(request),
      type: "MACHINE",
      id,
      startAt: body.startAt,
      endAt: body.endAt,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return reply.code(201).send(result);
  });

  app.get("/api/v1/admin/machines/:id/maintenance", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    return {
      maintenance: listUnavailability(auth.machineId).filter(
        (item) => item.kind === "PLANNED"
      )
    };
  });

  app.post(
    "/api/v1/admin/machines/:id/maintenance/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = maintenancePreviewSchema.parse(request.body);
      const auth = requireMachineManagerForId(request, reply, id);
      if (!auth) return;
      if (body.resourceGroupId) {
        const target = resolveUnavailabilityTarget(
          "RESOURCE_GROUP",
          body.resourceGroupId
        );
        if (target.machineId !== id) {
          return reply.code(400).send({ error: "资源组不属于当前机器" });
        }
        return previewUnavailability(
          "RESOURCE_GROUP",
          body.resourceGroupId,
          body.startAt,
          body.endAt
        );
      }
      return previewUnavailability("MACHINE", id, body.startAt, body.endAt);
    }
  );

  app.post("/api/v1/admin/machines/:id/maintenance", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = maintenanceSchema.parse(request.body);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    let type: "MACHINE" | "RESOURCE_GROUP" = "MACHINE";
    let targetId = id;
    if (body.resourceGroupId) {
      const target = resolveUnavailabilityTarget(
        "RESOURCE_GROUP",
        body.resourceGroupId
      );
      if (target.machineId !== id) {
        return reply.code(400).send({ error: "资源组不属于当前机器" });
      }
      type = "RESOURCE_GROUP";
      targetId = body.resourceGroupId;
    }
    const result = createPlannedUnavailability({
      overwrite: overwriteRequested(request),
      type,
      id: targetId,
      startAt: body.startAt,
      endAt: body.endAt,
      reason: body.reason,
      expectedRevision: body.expectedRevision,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return reply.code(201).send(result);
  });

  app.delete("/api/v1/admin/maintenance/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const window = db
      .prepare("SELECT * FROM resource_unavailability WHERE id = ?")
      .get(id) as Record<string, any> | undefined;
    if (!window || window.kind !== "PLANNED") {
      return reply.code(404).send({ error: "维护安排不存在" });
    }
    const auth = requireMachineManagerForId(request, reply, window.machine_id);
    if (!auth) return;
    const result = cancelUnavailability(id, auth.user.id);
    publishRevision(result.revision);
    return { message: "维护安排已取消" };
  });

  app.delete("/api/v1/admin/unavailability/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const window = db
      .prepare("SELECT * FROM resource_unavailability WHERE id = ?")
      .get(id) as Record<string, any> | undefined;
    if (!window) return reply.code(404).send({ error: "维护安排不存在" });
    const auth = requireMachineManagerForId(request, reply, window.machine_id);
    if (!auth) return;
    const result = cancelUnavailability(id, auth.user.id);
    publishRevision(result.revision);
    return { message: "维护安排已取消" };
  });
}
