import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  canManageMachine,
  getAccessibleMachineIds,
  requireAuth,
  requireSession
} from "./auth.js";
import {
  addAudit,
  bumpMachineAccessRevision,
  bumpScheduleRevision,
  db,
  getScheduleRevision,
  getSettings,
  nowIso,
  parseTags,
  withImmediateTransaction
} from "./db.js";
import { createNotification } from "./mailer.js";
import { removeMachineMembership } from "./machine-access.js";
import {
  BusinessError,
  cancelReservation,
  commitReservationBatch,
  endReservationEarly,
  assertUserCanAccessSegments,
  previewReplacementSegments,
  previewSegments,
  replaceReservationBatch,
  updateReservation
} from "./scheduling.js";
import {
  machineResourceSummary,
  mapResourceGroup,
  mapResourceGroups,
  resourceAllocationSummary
} from "./resources.js";
import type { ResourceAllocation } from "../src/shared/types.js";

export function registerScheduleRoutes(
  app: FastifyInstance,
  publishRevision: (revision: number) => void
) {
  app.get("/api/v1/machines/catalog", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const currentAt = nowIso();
    const rows = db
      .prepare(
         `SELECT
           m.id, m.name, m.address, m.tags_json, m.status,
           EXISTS(
             SELECT 1 FROM resource_unavailability ru
             WHERE ru.machine_id = m.id AND ru.resource_group_id IS NULL
               AND ru.kind = 'PLANNED' AND ru.status = 'ACTIVE'
               AND ru.start_at <= ? AND ru.end_at > ?
           ) AS maintenance_now,
           CASE
             WHEN ? = 'SYSTEM_ADMIN' THEN 1
             WHEN mam.id IS NOT NULL THEN 1
             ELSE 0
           END AS has_access,
           CASE
             WHEN ? = 'SYSTEM_ADMIN' THEN 0
             WHEN ma.user_id IS NOT NULL THEN 1
             ELSE 0
           END AS is_manager,
           mar.id AS request_id, mar.status AS request_status,
           mar.reason AS request_reason, mar.created_at AS request_created_at
         FROM machines m
         LEFT JOIN machine_access_memberships mam
           ON mam.machine_id = m.id AND mam.user_id = ?
         LEFT JOIN machine_admins ma
           ON ma.machine_id = m.id AND ma.user_id = ?
         LEFT JOIN machine_access_requests mar
           ON mar.machine_id = m.id AND mar.user_id = ? AND mar.status = 'PENDING'
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt WHERE dmt.machine_id = m.id
         )
         ORDER BY m.name`
      )
      .all(
        currentAt,
        currentAt,
        auth.user.role,
        auth.user.role,
        auth.user.id,
        auth.user.id,
        auth.user.id
      ) as Array<Record<string, unknown>>;
    const managerRows = db
      .prepare(
        `SELECT
           ma.machine_id, u.display_name,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number
         FROM machine_admins ma
         JOIN machines m ON m.id = ma.machine_id
         JOIN users u
           ON u.id = ma.user_id AND u.role = 'USER' AND u.status = 'ACTIVE'
         ORDER BY u.display_name`
      )
      .all() as Array<{
      machine_id: string;
      display_name: string;
      employee_number: string | null;
    }>;
    const managersByMachine = new Map<
      string,
      Array<{ displayName: string; employeeNumber: string | null }>
    >();
    for (const manager of managerRows) {
      const list = managersByMachine.get(manager.machine_id) ?? [];
      list.push({
        displayName: manager.display_name,
        employeeNumber: manager.employee_number
      });
      managersByMachine.set(manager.machine_id, list);
    }
    return {
      machines: rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        status: row.status,
        availabilityStatus:
          row.status === "DISABLED"
            ? "DISABLED"
            : Number(row.maintenance_now)
              ? "MAINTENANCE"
              : "ACTIVE",
        resourceSummary: machineResourceSummary(String(row.id)),
        tags: parseTags(String(row.tags_json)),
        managers: managersByMachine.get(String(row.id)) ?? [],
        hasAccess: Boolean(row.has_access),
        isManager: Boolean(row.is_manager),
        request: row.request_id
          ? {
              id: row.request_id,
              status: row.request_status,
              reason: row.request_reason,
              createdAt: row.request_created_at
            }
          : null
      }))
    };
  });

  app.post("/api/v1/machines/:machineId/access-requests", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    if (auth.user.role === "SYSTEM_ADMIN") {
      return reply.code(409).send({ error: "系统管理员已拥有全部机器权限" });
    }
    const { machineId } = z
      .object({ machineId: z.string().uuid() })
      .parse(request.params);
    const { reason } = z
      .object({ reason: z.string().trim().max(500).optional().default("") })
      .parse(request.body ?? {});
    const requestId = randomUUID();
    let revision = getScheduleRevision();
    try {
      withImmediateTransaction(() => {
        const machine = db
          .prepare(
            `SELECT m.name FROM machines m
             WHERE m.id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM deleted_machine_tombstones dmt
                 WHERE dmt.machine_id = m.id
               )`
          )
          .get(machineId) as { name: string } | undefined;
        if (!machine) throw new BusinessError("机器不存在", 404);
        const member = db
          .prepare(
            "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
          )
          .get(machineId, auth.user.id);
        if (member) {
          throw new BusinessError(
            "你已经拥有这台机器的使用权限",
            409,
            undefined,
            "MACHINE_MEMBER_ALREADY_EXISTS"
          );
        }
        const pending = db
          .prepare(
            `SELECT 1 FROM machine_access_requests
             WHERE machine_id = ? AND user_id = ? AND status = 'PENDING'`
          )
          .get(machineId, auth.user.id);
        if (pending) {
          throw new BusinessError(
            "使用权申请正在等待审核",
            409,
            undefined,
            "MACHINE_ACCESS_REQUEST_PENDING"
          );
        }
        const now = nowIso();
        db.prepare(
          `INSERT INTO machine_access_requests(
            id, machine_id, user_id, reason, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?)`
        ).run(requestId, machineId, auth.user.id, reason, now, now);
        addAudit(
          auth.user.id,
          "MACHINE_ACCESS_REQUEST_CREATE",
          "machine_access_request",
          requestId,
          undefined,
          { machineId, reason }
        );
        bumpMachineAccessRevision();
        revision = bumpScheduleRevision();
      });
    } catch (error) {
      throw error;
    }
    const recipients = db
      .prepare(
        `SELECT user_id AS id FROM machine_admins WHERE machine_id = ?
         UNION
         SELECT id FROM users WHERE role = 'SYSTEM_ADMIN' AND status = 'ACTIVE'`
      )
      .all(machineId) as Array<{ id: string }>;
    for (const recipient of recipients) {
      createNotification(
        recipient.id,
        "MACHINE_ACCESS_REQUEST",
        "收到新的机器使用权申请",
        `${auth.user.displayName} 申请使用机器，请在资源管理中处理。`,
        `/admin/machines/${machineId}/users`
      );
    }
    publishRevision(revision);
    return reply.code(201).send({ id: requestId });
  });

  app.delete("/api/v1/machine-access/requests/:id", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    let revision = getScheduleRevision();
    const changed = withImmediateTransaction(() => {
      const now = nowIso();
      const result = db
        .prepare(
          `UPDATE machine_access_requests
           SET status = 'WITHDRAWN', version = version + 1, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'PENDING'`
        )
        .run(now, id, auth.user.id);
      if (!result.changes) return false;
      addAudit(
        auth.user.id,
        "MACHINE_ACCESS_REQUEST_WITHDRAW",
        "machine_access_request",
        id,
        undefined,
        { status: "WITHDRAWN" }
      );
      bumpMachineAccessRevision();
      revision = bumpScheduleRevision();
      return true;
    });
    if (!changed) {
      return reply.code(409).send({
        error: "申请状态已经变化，请刷新后重试",
        code: "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
      });
    }
    publishRevision(revision);
    return { message: "使用权申请已撤回" };
  });

  app.delete("/api/v1/machines/:machineId/membership", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { machineId } = z
      .object({ machineId: z.string().uuid() })
      .parse(request.params);
    if (auth.user.role === "SYSTEM_ADMIN") {
      return reply.code(400).send({ error: "系统管理员不能退出全局机器权限" });
    }
    let impact:
      | ReturnType<typeof removeMachineMembership>
      | undefined;
    withImmediateTransaction(() => {
      impact = removeMachineMembership(
        machineId,
        auth.user.id,
        auth.user.id,
        "用户主动退出机器"
      );
      if (!impact.removed) throw new BusinessError("你没有这台机器的使用权限", 404);
    });
    const revision = getScheduleRevision();
    publishRevision(revision);
    return {
      message: "已退出机器并释放相关资源",
      impact: {
        activeReservations: impact?.activeReservations ?? 0,
        futureReservations: impact?.futureReservations ?? 0
      },
      revision
    };
  });

  app.get("/api/v1/timeline/machines", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const accessibleIds = getAccessibleMachineIds(auth.user.id, auth.user.role);
    if (!accessibleIds.length) return { machines: [] };
    const rows = db
      .prepare(
        `SELECT * FROM machines
         WHERE id IN (${accessibleIds.map(() => "?").join(",")})
           AND NOT EXISTS (
             SELECT 1 FROM deleted_machine_tombstones dmt
             WHERE dmt.machine_id = machines.id
           )
         ORDER BY name`
      )
      .all(...accessibleIds) as Array<Record<string, unknown>>;
    return {
      machines: rows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        resourceSummary: machineResourceSummary(String(row.id)),
        tags: parseTags(String(row.tags_json)),
        status: row.status,
        isManager: canManageMachine(
          auth.user.id,
          auth.user.role,
          String(row.id)
        )
      }))
    };
  });

  app.get("/api/v1/server-time", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    return { serverNow: nowIso() };
  });

  app.get("/api/v1/timeline", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const query = z
      .object({
        from: z.string().datetime(),
        to: z.string().datetime(),
        machineIds: z.string().max(5_000).optional(),
        search: z.string().max(100).optional()
      })
      .parse(request.query);
    const rangeMs = new Date(query.to).getTime() - new Date(query.from).getTime();
    if (rangeMs <= 0 || rangeMs > 8 * 24 * 60 * 60 * 1000) {
      return reply.code(400).send({ error: "时间轴范围需大于 0 且不超过 8 天" });
    }
    const requestedIds = Array.from(
      new Set(query.machineIds?.split(",").map((id) => id.trim()).filter(Boolean) ?? [])
    );
    if (
      requestedIds.length > 100 ||
      requestedIds.some((id) => !z.string().uuid().safeParse(id).success)
    ) {
      return reply.code(400).send({ error: "机器筛选条件无效" });
    }
    const accessibleIds = getAccessibleMachineIds(auth.user.id, auth.user.role);
    const accessibleSet = new Set(accessibleIds);
    if (requestedIds.some((id) => !accessibleSet.has(id))) {
      return reply.code(403).send({ error: "你没有这台机器的使用权限" });
    }
    const selectedIds = requestedIds.length ? requestedIds : accessibleIds;
    if (!selectedIds.length) {
      return {
        machines: [],
        groups: [],
        reservations: [],
        unavailability: [],
        revision: getScheduleRevision(),
        serverNow: nowIso()
      };
    }
    const machineRows = db
      .prepare(
        `SELECT * FROM machines
         WHERE id IN (${selectedIds.map(() => "?").join(",")})
         ORDER BY name`
      )
      .all(...selectedIds) as Array<Record<string, unknown>>;
    const machineIds = machineRows.map((row) => String(row.id));
    if (!machineIds.length) {
      return {
        machines: [],
        groups: [],
        reservations: [],
        unavailability: [],
        revision: getScheduleRevision(),
        serverNow: nowIso()
      };
    }
    const placeholders = machineIds.map(() => "?").join(",");
    const allGroups = db
      .prepare(
        `SELECT * FROM resource_groups
         WHERE machine_id IN (${placeholders})
           AND NOT EXISTS (
             SELECT 1 FROM deleted_resource_group_tombstones drgt
             WHERE drgt.resource_group_id = resource_groups.id
           )
         ORDER BY machine_id, sort_order, name`
      )
      .all(...machineIds) as Array<Record<string, unknown>>;
    const search = (query.search ?? "").trim().toLowerCase();
    const groupRows = search
      ? allGroups.filter((row) => {
          const content = `${row.name} ${row.description} ${row.tags_json}`.toLowerCase();
          return content.includes(search);
        })
      : allGroups;
    const reservationRows = db
      .prepare(
        `SELECT
          r.*, u.display_name AS applicant_name,
          (SELECT en.employee_number FROM employee_numbers en
           WHERE en.user_id = u.id AND en.status = 'ACTIVE'
           LIMIT 1) AS applicant_employee_number
         FROM reservations r
         JOIN users u ON u.id = r.user_id
         WHERE r.machine_id IN (${placeholders})
           AND r.status = 'CONFIRMED'
           AND r.start_at < ? AND r.end_at > ?
         ORDER BY r.start_at`
      )
      .all(...machineIds, query.to, query.from) as Array<Record<string, unknown>>;
    const managerMap = new Map(
      machineIds.map((id) => [
        id,
        canManageMachine(auth.user.id, auth.user.role, id)
      ])
    );
    const reservations = reservationRows
      .map((row) => {
        const maySeeDetails =
          row.user_id === auth.user.id || managerMap.get(String(row.machine_id));
        return {
          id: row.id,
          scope: row.scope,
          machineId: row.machine_id,
          resourceGroupId: row.resource_group_id,
          applicantName: row.applicant_name,
          applicantEmployeeNumber: row.applicant_employee_number,
          startAt: row.start_at,
          endAt: row.end_at,
          status: row.status,
          adjustmentType: row.adjustment_type,
          mine: row.user_id === auth.user.id,
          ...(maySeeDetails
            ? {
                title: row.title,
                purpose: row.purpose,
                note: row.note,
                initialStartAt: row.initial_start_at,
                initialEndAt: row.initial_end_at,
                adjustmentReason: row.adjustment_reason
              }
            : {})
        };
      });
    const unavailability = db
      .prepare(
        `SELECT * FROM resource_unavailability
         WHERE machine_id IN (${placeholders})
           AND status = 'ACTIVE' AND start_at < ? AND end_at > ?
         ORDER BY start_at`
      )
      .all(...machineIds, query.to, query.from)
      .map((row: any) => ({
        id: row.id,
        machineId: row.machine_id,
        resourceGroupId: row.resource_group_id,
        kind: row.kind,
        startAt: row.start_at,
        endAt: row.end_at,
        reason: row.reason,
        status: row.status
      }));

    return {
      machines: machineRows.map((row) => ({
        id: row.id,
        name: row.name,
        address: row.address,
        resourceSummary: machineResourceSummary(String(row.id)),
        hardwareNotes: row.hardware_notes,
        connectionGuide: row.connection_guide,
        tags: parseTags(String(row.tags_json)),
        status: row.status,
        isManager: managerMap.get(String(row.id))
      })),
      groups: mapResourceGroups(groupRows).map((mappedGroup) => {
        const { version: _version, ...group } = mappedGroup;
        return group;
      }),
      reservations,
      unavailability,
      revision: getScheduleRevision(),
      serverNow: nowIso()
    };
  });

  app.post("/api/v1/reservations/preview", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { segments, replaceReservationId } = z
      .object({
        segments: z.array(z.unknown()).min(1).max(100),
        replaceReservationId: z.string().uuid().optional()
      })
      .parse(request.body);
    assertUserCanAccessSegments(auth.user.id, segments);
    const items = replaceReservationId
        ? previewReplacementSegments(
            auth.user.id,
            replaceReservationId,
            segments
          )
        : previewSegments(segments);
    return { items, serverNow: nowIso() };
  });

  app.post("/api/v1/reservations/batch", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { segments, replaceReservationId } = z
      .object({
        segments: z.array(z.unknown()).min(1).max(100),
        replaceReservationId: z.string().uuid().optional()
      })
      .parse(request.body);
    const result = replaceReservationId
      ? replaceReservationBatch(
          auth.user.id,
          replaceReservationId,
          segments
        )
      : commitReservationBatch(auth.user.id, segments);
    publishRevision(result.revision);
    return reply.code(201).send(result);
  });

  app.patch("/api/v1/reservations/:id", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = updateReservation(id, auth.user.id, request.body);
    publishRevision(result.revision);
    return result;
  });

  app.post("/api/v1/reservations/:id/cancel", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().max(500).optional().default("") }).parse(request.body ?? {});
    const row = db
      .prepare("SELECT machine_id FROM reservations WHERE id = ?")
      .get(id) as { machine_id: string } | undefined;
    const canManage = row
      ? canManageMachine(auth.user.id, auth.user.role, row.machine_id)
      : false;
    cancelReservation(id, auth.user.id, canManage, reason);
    const revision = getScheduleRevision();
    publishRevision(revision);
    return { message: "占用已取消", revision };
  });

  app.post("/api/v1/reservations/:id/end", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { reason } = z
      .object({ reason: z.string().max(500).optional().default("") })
      .parse(request.body ?? {});
    const row = db
      .prepare("SELECT machine_id FROM reservations WHERE id = ?")
      .get(id) as { machine_id: string } | undefined;
    const canManage = row
      ? canManageMachine(auth.user.id, auth.user.role, row.machine_id)
      : false;
    const result = endReservationEarly(
      id,
      auth.user.id,
      canManage,
      reason
    );
    const revision = getScheduleRevision();
    publishRevision(revision);
    return {
      message: result.removed ? "占用已撤销" : "资源已提前释放",
      removed: result.removed,
      revision
    };
  });

  app.get("/api/v1/reservations/mine", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
          r.*,
          CASE WHEN drgt.resource_group_id IS NOT NULL
            THEN '资源组已删除' ELSE rg.name END AS current_group_name,
          CASE WHEN dmt.machine_id IS NOT NULL
            THEN '机器已删除' ELSE m.name END AS machine_name,
          drgt.resource_group_id IS NOT NULL AS resource_group_deleted,
          dmt.machine_id IS NOT NULL AS machine_deleted
         FROM reservations r
         JOIN resource_groups rg ON rg.id = r.resource_group_id
         JOIN machines m ON m.id = r.machine_id
         LEFT JOIN deleted_resource_group_tombstones drgt
           ON drgt.resource_group_id = rg.id
         LEFT JOIN deleted_machine_tombstones dmt
           ON dmt.machine_id = m.id
         WHERE r.user_id = ?
         ORDER BY r.start_at DESC LIMIT 200`
      )
      .all(auth.user.id) as Array<Record<string, unknown>>;
    return {
      reservations: rows.map((row) => {
        const resourceGroupDeleted = Boolean(row.resource_group_deleted);
        const machineDeleted = Boolean(row.machine_deleted);
        const currentRow = resourceGroupDeleted
          ? null
          : db
              .prepare("SELECT * FROM resource_groups WHERE id = ?")
              .get(row.resource_group_id) as Record<string, unknown>;
        const current = currentRow ? mapResourceGroup(currentRow) : null;
        const snapshotAllocations = JSON.parse(
          String(row.snapshot_resource_config_json)
        ) as ResourceAllocation[];
        const snapshotResourceSummary = resourceGroupDeleted
          ? "资源已删除"
          : resourceAllocationSummary(snapshotAllocations);
        const currentResourceSummary = resourceGroupDeleted
          ? "资源已删除"
          : current!.resourceSummary;
        return {
          id: row.id,
          scope: row.scope,
          machineId: row.machine_id,
          machineName: row.machine_name,
          resourceGroupId: row.resource_group_id,
          resourceGroupName:
            row.scope === "MACHINE" ? "整机" : row.current_group_name,
          currentResourceSummary:
            row.scope === "MACHINE" ? "机器全部资源" : currentResourceSummary,
          snapshotGroupName: row.scope === "MACHINE"
            ? "整机"
            : resourceGroupDeleted
            ? "资源组已删除"
            : row.snapshot_group_name,
          snapshotResourceSummary:
            row.scope === "MACHINE" ? "机器全部资源" : snapshotResourceSummary,
          changedSinceBooking:
            machineDeleted ||
            (row.scope !== "MACHINE" &&
              (resourceGroupDeleted ||
                row.snapshot_group_name !== row.current_group_name ||
                snapshotResourceSummary !== currentResourceSummary)),
          resourceGroupDeleted,
          machineDeleted,
          startAt: row.start_at,
          endAt: row.end_at,
          initialStartAt: row.initial_start_at,
          initialEndAt: row.initial_end_at,
          adjustmentType: row.adjustment_type,
          adjustmentReason: row.adjustment_reason,
          title: row.title,
          purpose: row.purpose,
          note: row.note,
          status: row.status,
          cancellationReason: row.cancellation_reason
        };
      })
    };
  });

  app.get("/api/v1/notifications", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT * FROM notifications
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
      )
      .all(auth.user.id) as Array<Record<string, unknown>>;
    const unread = db
      .prepare(
        `SELECT COUNT(*) AS count FROM notifications
         WHERE user_id = ? AND read_at IS NULL`
      )
      .get(auth.user.id) as { count: number };
    return {
      unreadCount: unread.count,
      notifications: rows.map((row) => ({
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        readAt: row.read_at,
        createdAt: row.created_at
      }))
    };
  });

  app.get("/api/v1/notifications/unread-count", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    const row = db
      .prepare(
        `SELECT COUNT(*) AS count FROM notifications
         WHERE user_id = ? AND read_at IS NULL`
      )
      .get(auth.user.id) as { count: number };
    return { unreadCount: row.count };
  });

  app.post("/api/v1/notifications/read-all", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    const readAt = nowIso();
    const result = db
      .prepare(
        `UPDATE notifications
         SET read_at = ?
         WHERE user_id = ? AND read_at IS NULL`
      )
      .run(readAt, auth.user.id);
    return {
      message: "全部通知已标为已读",
      updatedCount: result.changes,
      readAt
    };
  });

  app.post("/api/v1/notifications/:id/read", async (request, reply) => {
    const auth = requireSession(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    db.prepare(
      "UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?"
    ).run(nowIso(), id, auth.user.id);
    return { message: "已读" };
  });

  app.get("/api/v1/settings/public", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    return getSettings();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BusinessError) {
      return reply.code(error.statusCode).send({
        error: error.message,
        details: error.details,
        ...(error.code ? { code: error.code } : {})
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: "输入内容不符合要求",
        details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
      });
    }
    const typedError = error as { statusCode?: unknown; message?: unknown };
    if (
      typeof typedError.statusCode === "number" &&
      typedError.statusCode >= 400 &&
      typedError.statusCode < 500
    ) {
      return reply.code(typedError.statusCode).send({
        error: typeof typedError.message === "string" ? typedError.message : "请求处理失败"
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "服务器处理失败" });
  });
}
