import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type ApiTokenAuth,
  authenticateApiToken,
  hashApiSecret
} from "./api-tokens.js";
import { canManageMachine, getAccessibleMachineIds } from "./auth.js";
import { BusinessError } from "./business-error.js";
import {
  db,
  getScheduleRevision,
  nowIso,
  parseTags,
  withImmediateTransaction
} from "./db.js";
import { machineResourceSummary, mapResourceGroups } from "./resources.js";
import {
  cancelReservation,
  commitReservationBatch,
  endReservationEarly,
  previewOwnReservationAction,
  previewReservationBatch,
  previewReservationUpdate,
  updateReservation
} from "./scheduling.js";
import { SourceRateLimiter } from "./source-rate-limit.js";
import { OPEN_API_DOCUMENT } from "./openapi-document.js";

const OPEN_API_PREFIX = "/api/open/v1";
const CONFIRMATION_PREFIX = "allocube_confirm_";
const PREPARED_OPERATION_TTL_MS = 5 * 60_000;
const PREPARED_OPERATION_RETENTION_MS = 24 * 60 * 60_000;
const overallLimiter = new SourceRateLimiter();
const operationLimiter = new SourceRateLimiter();

type OpenApiErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "INSUFFICIENT_SCOPE"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "OPERATION_EXPIRED"
  | "OPERATION_REJECTED"
  | "INTERNAL_ERROR";

class OpenApiError extends Error {
  constructor(
    public statusCode: number,
    public code: OpenApiErrorCode,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

const limitSchema = z.coerce.number().int().min(1).max(200).optional().default(50);
const uuidParamSchema = z.object({ id: z.string().uuid() }).strict();
const openSegmentSchema = z
  .object({
    scope: z.enum(["RESOURCE_GROUP", "MACHINE"]),
    machineId: z.string().uuid().optional(),
    resourceGroupId: z.string().uuid(),
    startMode: z.enum(["IMMEDIATE", "SCHEDULED"]).optional().default("SCHEDULED"),
    startAt: z.string().datetime(),
    endAt: z.string().datetime(),
    title: z.string().max(120).optional().default(""),
    purpose: z.string().max(500).optional().default(""),
    note: z.string().max(1000).optional().default("")
  })
  .strict();

const prepareOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("CREATE"),
      segments: z.array(openSegmentSchema).min(1).max(100)
    })
    .strict(),
  z
    .object({
      action: z.literal("UPDATE"),
      reservationId: z.string().uuid(),
      segment: openSegmentSchema
    })
    .strict(),
  z
    .object({
      action: z.literal("CANCEL"),
      reservationId: z.string().uuid(),
      reason: z.string().max(500).optional().default("")
    })
    .strict(),
  z
    .object({
      action: z.literal("END"),
      reservationId: z.string().uuid(),
      reason: z.string().max(500).optional().default("")
    })
    .strict()
]);

type PreparedRequest = z.infer<typeof prepareOperationSchema>;

function success<T>(data: T, meta: Record<string, unknown> = {}) {
  return { data, meta: { serverTime: nowIso(), ...meta } };
}

function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor<T>(value: string | undefined, schema: z.ZodType<T>): T | null {
  if (!value) return null;
  try {
    return schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new OpenApiError(400, "INVALID_REQUEST", "分页游标无效");
  }
}

function requireOpenAuth(
  request: FastifyRequest,
  requiredAccess: "READ_ONLY" | "READ_WRITE",
  authByRequest: WeakMap<FastifyRequest, ApiTokenAuth>
) {
  const auth = authenticateApiToken(request);
  if (!auth) {
    throw new OpenApiError(401, "UNAUTHENTICATED", "个人访问令牌无效、已到期或已吊销");
  }
  if (requiredAccess === "READ_WRITE" && auth.token.accessLevel !== "READ_WRITE") {
    throw new OpenApiError(403, "INSUFFICIENT_SCOPE", "此操作需要读写令牌");
  }
  const overall = overallLimiter.check(`open:${auth.token.id}`, {
    max: 120,
    windowMs: 60_000
  });
  if (!overall.allowed) {
    throw new OpenApiError(429, "RATE_LIMITED", "请求过于频繁", {
      retryAfterSeconds: overall.retryAfterSeconds
    });
  }
  if (requiredAccess === "READ_WRITE") {
    const operations = operationLimiter.check(`operation:${auth.token.id}`, {
      max: 30,
      windowMs: 60_000
    });
    if (!operations.allowed) {
      throw new OpenApiError(429, "RATE_LIMITED", "占用操作过于频繁", {
        retryAfterSeconds: operations.retryAfterSeconds
      });
    }
  }
  authByRequest.set(request, auth);
  return auth;
}

function ensureMachineAccess(auth: ApiTokenAuth, machineId: string) {
  const accessible = new Set(getAccessibleMachineIds(auth.user.id, auth.user.role));
  if (!accessible.has(machineId)) {
    throw new OpenApiError(403, "FORBIDDEN", "你没有这台机器的使用权限");
  }
}

function machineRows(auth: ApiTokenAuth) {
  const ids = getAccessibleMachineIds(auth.user.id, auth.user.role);
  if (!ids.length) return [];
  return db
    .prepare(
      `SELECT * FROM machines
       WHERE id IN (${ids.map(() => "?").join(",")})
         AND NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = machines.id
         )
       ORDER BY name COLLATE NOCASE, id`
    )
    .all(...ids) as Array<Record<string, unknown>>;
}

function mapMachine(auth: ApiTokenAuth, row: Record<string, unknown>) {
  const id = String(row.id);
  return {
    id,
    name: String(row.name),
    address: String(row.address ?? ""),
    hardwareNotes: String(row.hardware_notes ?? ""),
    connectionGuide: String(row.connection_guide ?? ""),
    resourceSummary: machineResourceSummary(id),
    tags: parseTags(String(row.tags_json)),
    status: row.status,
    isManager: canManageMachine(auth.user.id, auth.user.role, id)
  };
}

function mapOwnReservation(row: Record<string, unknown>) {
  return {
    id: row.id,
    batchId: row.batch_id,
    scope: row.scope,
    machineId: row.machine_id,
    machineName: row.machine_name,
    resourceGroupId: row.resource_group_id,
    resourceGroupName: row.scope === "MACHINE" ? "整机" : row.resource_group_name,
    startAt: row.start_at,
    endAt: row.end_at,
    initialStartAt: row.initial_start_at,
    initialEndAt: row.initial_end_at,
    title: row.title,
    purpose: row.purpose,
    note: row.note,
    status: row.status,
    adjustmentType: row.adjustment_type,
    adjustmentReason: row.adjustment_reason,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function reservationSelect() {
  return `SELECT r.*, m.name AS machine_name, rg.name AS resource_group_name
          FROM reservations r
          JOIN machines m ON m.id = r.machine_id
          JOIN resource_groups rg ON rg.id = r.resource_group_id`;
}

function createPreparedOperation(
  auth: ApiTokenAuth,
  request: PreparedRequest,
  preview: unknown
) {
  const confirmationToken = `${CONFIRMATION_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + PREPARED_OPERATION_TTL_MS).toISOString();
  const retainUntil = new Date(
    Date.now() + PREPARED_OPERATION_RETENTION_MS
  ).toISOString();
  db.prepare(
    `INSERT INTO prepared_api_operations(
       id, user_id, api_token_id, confirmation_token_hash, action,
       request_json, expires_at, retain_until, created_at
     ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    auth.user.id,
    auth.token.id,
    hashApiSecret(confirmationToken),
    request.action,
    JSON.stringify(request),
    expiresAt,
    retainUntil,
    createdAt
  );
  return {
    operationId: id,
    action: request.action,
    status: "READY" as const,
    preview,
    confirmationToken,
    expiresAt
  };
}

function executePreparedOperation(
  auth: ApiTokenAuth,
  confirmationToken: string
) {
  type CommitOutcome =
    | { kind: "SUCCESS"; result: unknown; replayed: boolean; revision?: number }
    | { kind: "ERROR"; error: OpenApiError };

  const outcome = withImmediateTransaction<CommitOutcome>(() => {
    const operation = db
      .prepare(
        `SELECT * FROM prepared_api_operations
         WHERE confirmation_token_hash = ? AND user_id = ? AND api_token_id = ?`
      )
      .get(
        hashApiSecret(confirmationToken),
        auth.user.id,
        auth.token.id
      ) as Record<string, unknown> | undefined;
    if (!operation) {
      return {
        kind: "ERROR",
        error: new OpenApiError(404, "NOT_FOUND", "确认令牌不存在")
      };
    }
    if (operation.status === "COMMITTED" && operation.result_json) {
      const result = JSON.parse(String(operation.result_json)) as Record<string, unknown>;
      return {
        kind: "SUCCESS",
        result,
        replayed: true,
        revision: typeof result.revision === "number" ? result.revision : undefined
      };
    }
    if (operation.status === "REJECTED") {
      return {
        kind: "ERROR",
        error: new OpenApiError(
          409,
          "OPERATION_REJECTED",
          "此预检操作已经失效，请重新预检",
          { rejectionCode: operation.rejection_code }
        )
      };
    }
    if (String(operation.expires_at) <= nowIso()) {
      db.prepare(
        `UPDATE prepared_api_operations
         SET status = 'REJECTED', rejection_code = 'OPERATION_EXPIRED'
         WHERE id = ?`
      ).run(operation.id);
      return {
        kind: "ERROR",
        error: new OpenApiError(410, "OPERATION_EXPIRED", "确认令牌已经过期，请重新预检")
      };
    }
    const prepared = prepareOperationSchema.parse(
      JSON.parse(String(operation.request_json))
    );
    const auditContext = {
      apiTokenId: auth.token.id,
      apiOperationId: String(operation.id)
    };
    try {
      let result: Record<string, unknown>;
      if (prepared.action === "CREATE") {
        result = commitReservationBatch(
          auth.user.id,
          prepared.segments,
          auditContext
        );
      } else if (prepared.action === "UPDATE") {
        result = updateReservation(
          prepared.reservationId,
          auth.user.id,
          prepared.segment,
          auditContext
        );
      } else if (prepared.action === "CANCEL") {
        cancelReservation(
          prepared.reservationId,
          auth.user.id,
          false,
          prepared.reason,
          auditContext
        );
        result = {
          id: prepared.reservationId,
          cancelled: true,
          revision: getScheduleRevision()
        };
      } else {
        const ended = endReservationEarly(
          prepared.reservationId,
          auth.user.id,
          false,
          prepared.reason,
          auditContext
        );
        result = {
          id: prepared.reservationId,
          ended: true,
          removed: ended.removed,
          revision: getScheduleRevision()
        };
      }
      const committedAt = nowIso();
      db.prepare(
        `UPDATE prepared_api_operations
         SET status = 'COMMITTED', result_json = ?, committed_at = ?
         WHERE id = ? AND status = 'PENDING'`
      ).run(JSON.stringify(result), committedAt, operation.id);
      return {
        kind: "SUCCESS",
        result,
        replayed: false,
        revision: typeof result.revision === "number" ? result.revision : undefined
      };
    } catch (error) {
      if (!(error instanceof BusinessError) && !(error instanceof z.ZodError)) {
        throw error;
      }
      db.prepare(
        `UPDATE prepared_api_operations
         SET status = 'REJECTED', rejection_code = 'STATE_CHANGED'
         WHERE id = ?`
      ).run(operation.id);
      return {
        kind: "ERROR",
        error: new OpenApiError(
          409,
          "OPERATION_REJECTED",
          "资源或占用状态已经变化，请重新预检",
          error instanceof BusinessError ? error.details : error.issues
        )
      };
    }
  });
  if (outcome.kind === "ERROR") throw outcome.error;
  return outcome;
}

export function registerOpenApiRoutes(
  app: FastifyInstance,
  publishRevision: (revision: number) => void
) {
  app.register(async (openApp) => {
    const authByRequest = new WeakMap<FastifyRequest, ApiTokenAuth>();

    openApp.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith(OPEN_API_PREFIX)) {
        reply.header("X-Request-Id", request.id);
      }
    });

    openApp.addHook("onResponse", async (request, reply) => {
      if (!request.url.startsWith(OPEN_API_PREFIX)) return;
      const auth = authByRequest.get(request);
      openApp.log.info(
        {
          requestId: request.id,
          method: request.method,
          route: request.routeOptions.url,
          statusCode: reply.statusCode,
          responseTimeMs: reply.elapsedTime,
          userId: auth?.user.id,
          apiTokenId: auth?.token.id
        },
        "open api request"
      );
    });

    openApp.get(`${OPEN_API_PREFIX}/openapi.json`, async (_request, reply) => {
      reply.header("content-type", "application/json; charset=utf-8");
      return OPEN_API_DOCUMENT;
    });

    openApp.get("/api/open/docs", async (_request, reply) => {
      return reply
        .code(302)
        .header("location", "/docs/api")
        .send();
    });

    openApp.get(`${OPEN_API_PREFIX}/me`, async (request, reply) => {
      const auth = requireOpenAuth(request, "READ_ONLY", authByRequest);
      reply.header("X-RateLimit-Limit", "120");
      return success({ user: auth.user, token: auth.token });
    });

    openApp.get(`${OPEN_API_PREFIX}/machines`, async (request, reply) => {
      const auth = requireOpenAuth(request, "READ_ONLY", authByRequest);
      const query = z
        .object({ limit: limitSchema, cursor: z.string().max(2000).optional() })
        .strict()
        .parse(request.query);
      const cursor = decodeCursor(
        query.cursor,
        z.object({ name: z.string(), id: z.string().uuid() }).strict()
      );
      const all = machineRows(auth);
      const cursorIndex = cursor
        ? all.findIndex(
            (row) => String(row.id) === cursor.id && String(row.name) === cursor.name
          )
        : -1;
      if (cursor && cursorIndex < 0) {
        throw new OpenApiError(400, "INVALID_REQUEST", "分页游标已经失效");
      }
      const start = cursor ? cursorIndex + 1 : 0;
      const page = all.slice(start, start + query.limit);
      const hasMore = start + page.length < all.length;
      const last = page.at(-1);
      reply.header("X-RateLimit-Limit", "120");
      return success(
        { machines: page.map((row) => mapMachine(auth, row)) },
        {
          nextCursor:
            hasMore && last
              ? encodeCursor({ name: String(last.name), id: String(last.id) })
              : null
        }
      );
    });

    openApp.get(
      `${OPEN_API_PREFIX}/machines/:id/resource-groups`,
      async (request, reply) => {
        const auth = requireOpenAuth(request, "READ_ONLY", authByRequest);
        const { id } = uuidParamSchema.parse(request.params);
        ensureMachineAccess(auth, id);
        const query = z
          .object({ limit: limitSchema, cursor: z.string().max(2000).optional() })
          .strict()
          .parse(request.query);
        const cursor = decodeCursor(
          query.cursor,
          z.object({ id: z.string().uuid() }).strict()
        );
        const rows = db
          .prepare(
            `SELECT * FROM resource_groups
             WHERE machine_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM deleted_resource_group_tombstones drgt
                 WHERE drgt.resource_group_id = resource_groups.id
               )
             ORDER BY sort_order, name COLLATE NOCASE, id`
          )
          .all(id) as Array<Record<string, unknown>>;
        const cursorIndex = cursor
          ? rows.findIndex((row) => String(row.id) === cursor.id)
          : -1;
        if (cursor && cursorIndex < 0) {
          throw new OpenApiError(400, "INVALID_REQUEST", "分页游标已经失效");
        }
        const start = cursor ? cursorIndex + 1 : 0;
        const page = rows.slice(start, start + query.limit);
        const hasMore = start + page.length < rows.length;
        reply.header("X-RateLimit-Limit", "120");
        return success(
          { resourceGroups: mapResourceGroups(page) },
          {
            nextCursor:
              hasMore && page.length
                ? encodeCursor({ id: String(page.at(-1)!.id) })
                : null
          }
        );
      }
    );

    openApp.get(`${OPEN_API_PREFIX}/schedule`, async (request, reply) => {
      const auth = requireOpenAuth(request, "READ_ONLY", authByRequest);
      const query = z
        .object({
          from: z.string().datetime(),
          to: z.string().datetime(),
          machineIds: z.string().max(5000).optional()
        })
        .strict()
        .parse(request.query);
      const range = new Date(query.to).getTime() - new Date(query.from).getTime();
      if (range <= 0 || range > 8 * 24 * 60 * 60 * 1000) {
        throw new OpenApiError(400, "INVALID_REQUEST", "排期范围必须大于 0 且不超过 8 天");
      }
      const accessibleIds = getAccessibleMachineIds(auth.user.id, auth.user.role);
      const accessibleSet = new Set(accessibleIds);
      const requestedIds = Array.from(
        new Set(
          query.machineIds?.split(",").map((item) => item.trim()).filter(Boolean) ?? []
        )
      );
      if (
        requestedIds.some((id) => !z.string().uuid().safeParse(id).success) ||
        requestedIds.length > 100
      ) {
        throw new OpenApiError(400, "INVALID_REQUEST", "机器筛选条件无效");
      }
      if (requestedIds.some((id) => !accessibleSet.has(id))) {
        throw new OpenApiError(403, "FORBIDDEN", "你没有所请求机器的使用权限");
      }
      const selectedIds = requestedIds.length ? requestedIds : accessibleIds;
      if (selectedIds.length > 100) {
        throw new OpenApiError(400, "INVALID_REQUEST", "机器数量超过 100，请明确指定 machineIds");
      }
      if (!selectedIds.length) {
        return success(
          { machines: [], resourceGroups: [], reservations: [], unavailability: [] },
          { scheduleRevision: getScheduleRevision() }
        );
      }
      const placeholders = selectedIds.map(() => "?").join(",");
      const machines = db
        .prepare(`SELECT * FROM machines WHERE id IN (${placeholders}) ORDER BY name`)
        .all(...selectedIds) as Array<Record<string, unknown>>;
      const groups = db
        .prepare(
          `SELECT * FROM resource_groups
           WHERE machine_id IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1 FROM deleted_resource_group_tombstones drgt
               WHERE drgt.resource_group_id = resource_groups.id
             )
           ORDER BY machine_id, sort_order, name`
        )
        .all(...selectedIds) as Array<Record<string, unknown>>;
      const reservations = (
        db
          .prepare(
            `SELECT r.*, u.display_name AS applicant_name,
              (SELECT en.employee_number FROM employee_numbers en
               WHERE en.user_id = u.id AND en.status = 'ACTIVE' LIMIT 1)
                 AS applicant_employee_number
             FROM reservations r JOIN users u ON u.id = r.user_id
             WHERE r.machine_id IN (${placeholders})
               AND r.status = 'CONFIRMED' AND r.start_at < ? AND r.end_at > ?
             ORDER BY r.start_at, r.id`
          )
          .all(...selectedIds, query.to, query.from) as Array<Record<string, unknown>>
      ).map((row) => {
        const mine = row.user_id === auth.user.id;
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
          mine,
          title: row.title,
          purpose: row.purpose,
          note: row.note,
          initialStartAt: row.initial_start_at,
          initialEndAt: row.initial_end_at,
          adjustmentReason: row.adjustment_reason
        };
      });
      const unavailability = (
        db
          .prepare(
            `SELECT * FROM resource_unavailability
             WHERE machine_id IN (${placeholders}) AND status = 'ACTIVE'
               AND start_at < ? AND end_at > ? ORDER BY start_at, id`
          )
          .all(...selectedIds, query.to, query.from) as Array<Record<string, unknown>>
      ).map((row) => ({
        id: row.id,
        machineId: row.machine_id,
        resourceGroupId: row.resource_group_id,
        kind: row.kind,
        startAt: row.start_at,
        endAt: row.end_at,
        reason: row.reason,
        status: row.status
      }));
      reply.header("X-RateLimit-Limit", "120");
      return success(
        {
          machines: machines.map((row) => mapMachine(auth, row)),
          resourceGroups: mapResourceGroups(groups).map(({ version: _version, ...group }) => group),
          reservations,
          unavailability
        },
        { scheduleRevision: getScheduleRevision() }
      );
    });

    openApp.get(`${OPEN_API_PREFIX}/reservations`, async (request, reply) => {
      const auth = requireOpenAuth(request, "READ_ONLY", authByRequest);
      const query = z
        .object({
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          status: z.enum(["CONFIRMED", "CANCELLED", "CANCELLED_UNAVAILABILITY"]).optional(),
          limit: limitSchema,
          cursor: z.string().max(2000).optional()
        })
        .strict()
        .parse(request.query);
      const cursor = decodeCursor(
        query.cursor,
        z.object({ startAt: z.string().datetime(), id: z.string().uuid() }).strict()
      );
      if (
        query.from &&
        query.to &&
        new Date(query.to).getTime() <= new Date(query.from).getTime()
      ) {
        throw new OpenApiError(400, "INVALID_REQUEST", "to 必须晚于 from");
      }
      const where = ["r.user_id = ?"];
      const params: unknown[] = [auth.user.id];
      if (query.from) {
        where.push("r.end_at > ?");
        params.push(query.from);
      }
      if (query.to) {
        where.push("r.start_at < ?");
        params.push(query.to);
      }
      if (query.status) {
        where.push("r.status = ?");
        params.push(query.status);
      }
      if (cursor) {
        where.push("(r.start_at < ? OR (r.start_at = ? AND r.id < ?))");
        params.push(cursor.startAt, cursor.startAt, cursor.id);
      }
      params.push(query.limit + 1);
      const rows = db
        .prepare(
          `${reservationSelect()} WHERE ${where.join(" AND ")}
           ORDER BY r.start_at DESC, r.id DESC LIMIT ?`
        )
        .all(...params) as Array<Record<string, unknown>>;
      const hasMore = rows.length > query.limit;
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      reply.header("X-RateLimit-Limit", "120");
      return success(
        { reservations: page.map(mapOwnReservation) },
        {
          nextCursor:
            hasMore && last
              ? encodeCursor({ startAt: String(last.start_at), id: String(last.id) })
              : null
        }
      );
    });

    openApp.get(`${OPEN_API_PREFIX}/reservations/:id`, async (request, reply) => {
      const auth = requireOpenAuth(request, "READ_ONLY", authByRequest);
      const { id } = uuidParamSchema.parse(request.params);
      const row = db
        .prepare(`${reservationSelect()} WHERE r.id = ? AND r.user_id = ?`)
        .get(id, auth.user.id) as Record<string, unknown> | undefined;
      if (!row) throw new OpenApiError(404, "NOT_FOUND", "占用记录不存在");
      reply.header("X-RateLimit-Limit", "120");
      return success({ reservation: mapOwnReservation(row) });
    });

    openApp.post(
      `${OPEN_API_PREFIX}/reservation-operations/prepare`,
      async (request, reply) => {
        const auth = requireOpenAuth(request, "READ_WRITE", authByRequest);
        const body = prepareOperationSchema.parse(request.body);
        let normalizedRequest: PreparedRequest = body;
        let preview: unknown;
        let blocked = false;
        if (body.action === "CREATE") {
          const result = previewReservationBatch(auth.user.id, body.segments);
          normalizedRequest = {
            action: "CREATE",
            segments: result.segments.map((segment) => openSegmentSchema.parse(segment))
          };
          preview = { items: result.items, serverNow: result.serverNow };
          blocked = result.items.some((item) => !item.available);
        } else if (body.action === "UPDATE") {
          const result = previewReservationUpdate(
            auth.user.id,
            body.reservationId,
            body.segment
          );
          normalizedRequest = {
            action: "UPDATE",
            reservationId: body.reservationId,
            segment: result.segment
          };
          preview = result;
          blocked = !result.item.available;
        } else {
          preview = previewOwnReservationAction(
            auth.user.id,
            body.reservationId,
            body.action
          );
        }
        reply.header("X-RateLimit-Limit", "30");
        if (blocked) {
          return success({ action: body.action, status: "BLOCKED", preview });
        }
        return success(createPreparedOperation(auth, normalizedRequest, preview));
      }
    );

    openApp.post(
      `${OPEN_API_PREFIX}/reservation-operations/commit`,
      async (request, reply) => {
        const auth = requireOpenAuth(request, "READ_WRITE", authByRequest);
        const { confirmationToken } = z
          .object({
            confirmationToken: z
              .string()
              .min(CONFIRMATION_PREFIX.length + 32)
              .max(CONFIRMATION_PREFIX.length + 128)
              .refine((value) => value.startsWith(CONFIRMATION_PREFIX))
          })
          .strict()
          .parse(request.body);
        const committed = executePreparedOperation(auth, confirmationToken);
        if (!committed.replayed && committed.revision !== undefined) {
          publishRevision(committed.revision);
        }
        reply.header("X-RateLimit-Limit", "30");
        return success(committed.result, { replayed: committed.replayed });
      }
    );

    openApp.all(`${OPEN_API_PREFIX}/*`, async () => {
      throw new OpenApiError(404, "NOT_FOUND", "接口不存在");
    });

    openApp.setErrorHandler((error, request, reply) => {
      let statusCode = 500;
      let code: OpenApiErrorCode = "INTERNAL_ERROR";
      let message = "服务器处理失败";
      let details: unknown;
      if (error instanceof OpenApiError) {
        statusCode = error.statusCode;
        code = error.code;
        message = error.message;
        details = error.details;
      } else if (error instanceof BusinessError) {
        statusCode = error.statusCode;
        code =
          statusCode === 403
            ? "FORBIDDEN"
            : statusCode === 404
              ? "NOT_FOUND"
              : statusCode === 409
                ? "CONFLICT"
                : "INVALID_REQUEST";
        message = error.message;
        details = error.details;
      } else if (error instanceof z.ZodError) {
        statusCode = 400;
        code = "INVALID_REQUEST";
        message = "请求参数不符合接口约定";
        details = error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }));
      } else {
        const typed = error as { statusCode?: unknown; message?: unknown };
        if (
          typeof typed.statusCode === "number" &&
          typed.statusCode >= 400 &&
          typed.statusCode < 500
        ) {
          statusCode = typed.statusCode;
          code = "INVALID_REQUEST";
          message = typeof typed.message === "string" ? typed.message : "请求无效";
        } else {
          openApp.log.error(error);
        }
      }
      const retryAfterSeconds =
        details &&
        typeof details === "object" &&
        "retryAfterSeconds" in details &&
        typeof (details as { retryAfterSeconds?: unknown }).retryAfterSeconds === "number"
          ? (details as { retryAfterSeconds: number }).retryAfterSeconds
          : null;
      if (retryAfterSeconds !== null) {
        reply.header("Retry-After", String(retryAfterSeconds));
      }
      reply.header("X-Request-Id", request.id);
      return reply.code(statusCode).send({
        error: {
          code,
          message,
          ...(details === undefined ? {} : { details }),
          requestId: request.id
        }
      });
    });
  });
}
