import { checkEditVersion, overwriteRequested } from "../edit-conflict.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, canAccessMachine, canManageMachine, requireSystemAdmin } from "../auth.js";
import {
  db,
  nowIso,
  parseTags,
  addAudit,
  bumpScheduleRevision,
  withImmediateTransaction,
  bumpMachineAccessRevision,
  checkpointSensitiveDeletion,
  getScheduleRevision
} from "../db.js";
import { createNotification } from "../mailer.js";
import { BusinessError } from "../business-error.js";
import { machineResourceSummary } from "../resources.js";
import { previewLongTermDisable, disableLongTerm, enableTarget } from "../unavailability.js";
import { requireMachineViewer, requireMachineManager, requireMachineManagerForId } from "./access-guards.js";
import { machineAuditPayload, machineAuditPayloadFromRow, assignMachineManager } from "./machine-service.js";
import { longDisableSchema, versionSchema } from "./unavailability-schema.js";
import { getCurrentMachineRow } from "./records.js";
import { machineDeleteImpact, notifyDeletedMachineUsers, deleteMachineRecords } from "./deletion-service.js";

const machineSchema = z.object({
  name: z.string().trim().min(1).max(80),
  address: z.string().trim().max(200).optional().default(""),
  hardwareNotes: z.string().max(2000).optional().default(""),
  connectionGuide: z.string().max(5000).optional().default(""),
  managementNotes: z.string().max(5000).optional().default(""),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional().default([])
});

const machineUpdateSchema = machineSchema.extend({
  expectedVersion: z.number().int().min(1)
});

export function registerMachinesAdminRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {

  app.get("/api/v1/admin/machines", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
          m.*,
          (
            SELECT COUNT(*)
            FROM machine_access_requests mar
            WHERE mar.machine_id = m.id AND mar.status = 'PENDING'
          ) AS pending_access_request_count,
          EXISTS(
            SELECT 1 FROM resource_unavailability ru
            WHERE ru.machine_id = m.id AND ru.resource_group_id IS NULL
              AND ru.kind = 'PLANNED' AND ru.status = 'ACTIVE'
              AND ru.start_at <= ? AND ru.end_at > ?
          ) AS planned_unavailable_now
         FROM machines m
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt WHERE dmt.machine_id = m.id
         )
         ORDER BY m.name`
      )
      .all(nowIso(), nowIso()) as Array<Record<string, unknown>>;
    const managerRows = db
      .prepare(
        `SELECT ma.machine_id, u.id, u.display_name
         FROM machine_admins ma
         JOIN machines m ON m.id = ma.machine_id
         JOIN users u ON u.id = ma.user_id AND u.status = 'ACTIVE'
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )
         ORDER BY u.display_name COLLATE NOCASE, u.id`
      )
      .all() as Array<{
        machine_id: string;
        id: string;
        display_name: string;
      }>;
    const managersByMachine = new Map<
      string,
      Array<{ id: string; displayName: string }>
    >();
    for (const manager of managerRows) {
      const managers = managersByMachine.get(manager.machine_id) ?? [];
      managers.push({ id: manager.id, displayName: manager.display_name });
      managersByMachine.set(manager.machine_id, managers);
    }
    return {
      machines: rows
        .filter((row) =>
          canAccessMachine(auth.user.id, auth.user.role, String(row.id))
        )
        .map((row) => {
          const canManage = canManageMachine(
            auth.user.id,
            auth.user.role,
            String(row.id)
          );
          return {
            id: row.id,
            name: row.name,
            address: row.address,
            resourceSummary: machineResourceSummary(String(row.id)),
            status: row.status,
            availabilityStatus:
              row.status === "DISABLED"
                ? "LONG_TERM"
                : Number(row.planned_unavailable_now)
                  ? "PLANNED"
                  : "ACTIVE",
            managers: (managersByMachine.get(String(row.id)) ?? []).map(
              (manager) =>
                canManage
                  ? manager
                  : { displayName: manager.displayName }
            ),
            canManage,
            ...(canManage
              ? {
                version: row.version,
                pendingAccessRequestCount: Number(
                  row.pending_access_request_count ?? 0
                )
              }
              : {})
          };
        })
    };
  });

  app.get("/api/v1/admin/machines/:id", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    const row = db
      .prepare("SELECT * FROM machines WHERE id = ?")
      .get(auth.machineId) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: "机器不存在" });
    const machine = {
      id: row.id,
      name: row.name,
      address: row.address,
      resourceSummary: machineResourceSummary(String(row.id)),
      hardwareNotes: row.hardware_notes,
      connectionGuide: row.connection_guide,
      tags: parseTags(String(row.tags_json)),
      status: row.status,
      canManage: auth.canManage,
      ...(auth.canManage
        ? {
          managementNotes: row.management_notes,
          version: row.version
        }
        : {})
    };
    return {
      machine
    };
  });

  app.post("/api/v1/admin/machines", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const body = machineSchema.parse(request.body);
    const id = randomUUID();
    const now = nowIso();
    try {
      db.prepare(
        `INSERT INTO machines(
          id, name, address, hardware_notes,
          connection_guide, management_notes, tags_json, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        body.name,
        body.address,
        body.hardwareNotes,
        body.connectionGuide,
        body.managementNotes,
        JSON.stringify(body.tags),
        now,
        now
      );
    } catch (error) {
      if (String(error).includes("UNIQUE")) {
        return reply.code(409).send({ error: "机器名称已经存在" });
      }
      throw error;
    }
    addAudit(
      auth.user.id,
      "MACHINE_CREATE",
      "machine",
      id,
      undefined,
      machineAuditPayload(body, Boolean(body.managementNotes))
    );
    publishRevision(bumpScheduleRevision());
    return reply.code(201).send({ id });
  });

  app.patch("/api/v1/admin/machines/:id", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const body = machineUpdateSchema.parse(request.body);
    const result = withImmediateTransaction(() => {
      const before = db.prepare("SELECT * FROM machines WHERE id = ?").get(auth.machineId) as
        | Record<string, unknown>
        | undefined;
      if (!before) throw new BusinessError("机器不存在", 404);
      checkEditVersion(Number(before.version), body.expectedVersion, overwriteRequested(request), "MACHINE_SETTINGS_STALE");
      let updateResult;
      try {
        updateResult = db.prepare(
          `UPDATE machines SET
            name = ?, address = ?, hardware_notes = ?,
            connection_guide = ?, management_notes = ?,
            tags_json = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND version = ?`
        ).run(
          body.name,
          body.address,
          body.hardwareNotes,
          body.connectionGuide,
          body.managementNotes,
          JSON.stringify(body.tags),
          nowIso(),
          auth.machineId,
          Number(before.version)
        );
      } catch (error) {
        if (String(error).includes("UNIQUE")) {
          throw new BusinessError("机器名称已经存在", 409);
        }
        throw error;
      }
      if (!updateResult.changes) throw new BusinessError("机器信息已由其他管理员更新，请刷新后重试", 409, undefined, "MACHINE_SETTINGS_STALE");
      const notesChanged = String(before.management_notes ?? "") !== body.managementNotes;
      addAudit(
        auth.user.id,
        "MACHINE_UPDATE",
        "machine",
        auth.machineId,
        machineAuditPayloadFromRow(before, notesChanged),
        machineAuditPayload(body, notesChanged)
      );
      return { message: "机器资料已更新", revision: bumpScheduleRevision() };
    });
    publishRevision(result.revision);
    return result;
  });

  app.post(
    "/api/v1/admin/machines/:id/disable/preview",
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const auth = requireMachineManagerForId(request, reply, id);
      if (!auth) return;
      return previewLongTermDisable("MACHINE", id);
    }
  );

  app.post("/api/v1/admin/machines/:id/disable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    const body = longDisableSchema.parse(request.body);
    const result = disableLongTerm({
      overwrite: overwriteRequested(request),
      type: "MACHINE",
      id,
      expectedVersion: body.expectedVersion,
      expectedRevision: body.expectedRevision,
      reason: body.reason,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.post("/api/v1/admin/machines/:id/enable", async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const auth = requireMachineManagerForId(request, reply, id);
    if (!auth) return;
    const { expectedVersion } = versionSchema.parse(request.body);
    const result = enableTarget({
      overwrite: overwriteRequested(request),
      type: "MACHINE",
      id,
      expectedVersion,
      actorUserId: auth.user.id
    });
    publishRevision(result.revision);
    return result;
  });

  app.get(
    "/api/v1/admin/machines/:id/deletion-impact",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const machine = getCurrentMachineRow(id);
      if (!machine) return reply.code(404).send({ error: "机器不存在" });
      return { machine, counts: machineDeleteImpact(id) };
    }
  );

  app.delete("/api/v1/admin/machines/:id", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = versionSchema.parse(request.body);
    withImmediateTransaction(() => {
      const machine = getCurrentMachineRow(id) as
        | { id: string; name: string; status: string; version: number }
        | undefined;
      if (!machine) throw new BusinessError("机器不存在", 404);
      if (machine.status !== "DISABLED") {
        throw new BusinessError("请先停用机器，再进行删除", 409);
      }
      checkEditVersion(machine.version, expectedVersion, overwriteRequested(request));
      const counts = machineDeleteImpact(id);
      notifyDeletedMachineUsers(id, machine.name);
      deleteMachineRecords(id, auth.user.id, counts);
      addAudit(auth.user.id, "MACHINE_DELETE", "machine", id, undefined, {
        name: machine.name,
        counts
      });
      bumpMachineAccessRevision();
      bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(getScheduleRevision());
    return { deleted: true };
  });

  app.post("/api/v1/admin/machines/:id/managers", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.body);
    const result = assignMachineManager(reply, id, userId, auth.user.id);
    if (result) publishRevision(getScheduleRevision());
    return result;
  });

  app.put("/api/v1/admin/machines/:id/managers/:userId", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    const result = assignMachineManager(reply, params.id, params.userId, auth.user.id);
    if (result) publishRevision(getScheduleRevision());
    return result;
  });

  app.delete("/api/v1/admin/machines/:id/managers/:userId", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const params = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    const removed = db
      .prepare("DELETE FROM machine_admins WHERE machine_id = ? AND user_id = ?")
      .run(params.id, params.userId);
    if (!removed.changes) {
      return reply.code(404).send({ error: "该用户不是这台机器的管理员" });
    }
    addAudit(auth.user.id, "MACHINE_ADMIN_REMOVE", "machine", params.id, {
      userId: params.userId
    }, undefined);
    bumpMachineAccessRevision();
    createNotification(
      params.userId,
      "MACHINE_ROLE_CHANGED",
      "机器管理员身份已取消",
      "你仍然保留这台机器的普通使用权。",
      "/"
    );
    publishRevision(bumpScheduleRevision());
    return { message: "机器管理员授权已移除" };
  });
}
