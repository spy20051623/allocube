import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getAccessibleMachineIds, requireAuth } from "./auth.js";
import { BusinessError } from "./business-error.js";
import { db, getScheduleRevision, nowIso, withImmediateTransaction } from "./db.js";
import { mapResourceGroups, resourceAllocationSummary } from "./resources.js";
import { reservationStateToken } from "./reservation-state.js";
import { cancelReservation } from "./scheduling.js";
import type { ResourceAllocation } from "../src/shared/types.js";
import type {
  BulkCancellationIssue, OwnReservation, OwnReservationPage, ReservationCategory
} from "../src/shared/my-reservations.js";

const iso = z.string().datetime().transform((value) => new Date(value).toISOString());
const querySchema = z.object({
  category: z.enum(["ACTIVE", "UPCOMING", "HISTORY"]).default("UPCOMING"),
  machineId: z.string().uuid().optional(),
  resourceGroupId: z.string().uuid().optional(),
  scope: z.enum(["RESOURCE_GROUP", "MACHINE"]).optional(),
  from: iso.optional(),
  to: iso.optional(),
  historyStatus: z.enum(["ALL", "ENDED", "CANCELLED"]).default("ALL"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(2000).optional()
}).strict().refine((q) => !q.from || !q.to || q.from < q.to, {
  message: "筛选结束时间必须晚于开始时间"
});
const cursorSchema = z.object({
  time: iso, id: z.string().uuid(), key: z.string(), revision: z.number().int(),
  boundary: iso.nullable()
}).strict();
const selectionSchema = z.object({
  id: z.string().uuid(), stateToken: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();
const batchSchema = z.object({
  reservations: z.array(selectionSchema).min(1).max(100),
  reason: z.string().max(500).default("")
}).strict().refine((v) => new Set(v.reservations.map((r) => r.id)).size === v.reservations.length, {
  message: "不能重复选择同一条占用"
});

const selectJoined = `SELECT r.*,
  CASE WHEN dmt.machine_id IS NOT NULL THEN '机器已删除' ELSE m.name END AS machine_name,
  CASE WHEN drgt.resource_group_id IS NOT NULL THEN '资源组已删除' ELSE rg.name END AS group_name,
  dmt.machine_id IS NOT NULL AS machine_deleted,
  drgt.resource_group_id IS NOT NULL AS group_deleted
  FROM reservations r JOIN machines m ON m.id = r.machine_id
  JOIN resource_groups rg ON rg.id = r.resource_group_id
  LEFT JOIN deleted_machine_tombstones dmt ON dmt.machine_id = m.id
  LEFT JOIN deleted_resource_group_tombstones drgt ON drgt.resource_group_id = rg.id`;

function mapRows(rows: Array<Record<string, unknown>>, userId: string, role: string, now: string): OwnReservation[] {
  const ids = [...new Set(rows.filter((r) => !r.group_deleted).map((r) => String(r.resource_group_id)))];
  const groups = ids.length ? db.prepare(
    `SELECT * FROM resource_groups WHERE id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids) as Array<Record<string, unknown>> : [];
  const groupMap = new Map(mapResourceGroups(groups).map((g) => [g.id, g]));
  const accessible = new Set(getAccessibleMachineIds(userId, role));
  return rows.map((r) => {
    const whole = r.scope === "MACHINE";
    const deleted = Boolean(r.group_deleted);
    const current = deleted ? "资源已删除" : groupMap.get(String(r.resource_group_id))!.resourceSummary;
    const snapshot = deleted ? "资源已删除" : resourceAllocationSummary(
      JSON.parse(String(r.snapshot_resource_config_json)) as ResourceAllocation[]
    );
    const canViewCalendar = !r.machine_deleted && !deleted && accessible.has(String(r.machine_id));
    return {
      id: String(r.id), scope: r.scope as OwnReservation["scope"],
      machineId: String(r.machine_id), machineName: String(r.machine_name),
      resourceGroupId: String(r.resource_group_id), resourceGroupName: whole ? "整机" : String(r.group_name),
      currentResourceSummary: whole ? "机器全部资源" : current,
      snapshotGroupName: whole ? "整机" : deleted ? "资源组已删除" : String(r.snapshot_group_name),
      snapshotResourceSummary: whole ? "机器全部资源" : snapshot,
      changedSinceBooking: Boolean(r.machine_deleted) || (!whole && (deleted || r.snapshot_group_name !== r.group_name || snapshot !== current)),
      machineDeleted: Boolean(r.machine_deleted), resourceGroupDeleted: deleted,
      startAt: String(r.start_at), endAt: String(r.end_at),
      initialStartAt: String(r.initial_start_at), initialEndAt: String(r.initial_end_at),
      adjustmentType: r.adjustment_type ? String(r.adjustment_type) : null,
      adjustmentReason: String(r.adjustment_reason), cancellationReason: String(r.cancellation_reason),
      title: String(r.title), purpose: String(r.purpose), note: String(r.note),
      status: r.status as OwnReservation["status"], stateToken: reservationStateToken(r),
      canViewCalendar, canEdit: canViewCalendar && r.status === "CONFIRMED" && String(r.end_at) > now
    };
  });
}

function categoryCondition(category: ReservationCategory) {
  if (category === "ACTIVE") return "r.status = 'CONFIRMED' AND r.start_at <= @now AND r.end_at > @now";
  if (category === "UPCOMING") return "r.status = 'CONFIRMED' AND r.start_at > @now";
  return "(r.status != 'CONFIRMED' OR r.end_at <= @now)";
}

export function listOwnReservations(userId: string, role: string, rawQuery: unknown): OwnReservationPage {
  const query = querySchema.parse(rawQuery);
  const now = nowIso();
  const revision = getScheduleRevision();
  const key = createHash("sha256").update(JSON.stringify([userId, query.category, query.machineId, query.resourceGroupId, query.scope, query.from, query.to, query.historyStatus, query.limit])).digest("hex");
  const params: Record<string, string | number> = { userId, now };
  const conditions = ["r.user_id = @userId", categoryCondition(query.category)];
  if (query.machineId) { conditions.push("r.machine_id = @machineId"); params.machineId = query.machineId; }
  if (query.resourceGroupId) { conditions.push("r.resource_group_id = @resourceGroupId AND r.scope = 'RESOURCE_GROUP'"); params.resourceGroupId = query.resourceGroupId; }
  if (query.scope) { conditions.push("r.scope = @scope"); params.scope = query.scope; }
  if (query.from) { conditions.push("r.end_at > @from"); params.from = query.from; }
  if (query.to) { conditions.push("r.start_at < @to"); params.to = query.to; }
  if (query.category === "HISTORY" && query.historyStatus !== "ALL") {
    conditions.push(query.historyStatus === "ENDED" ? "r.status = 'CONFIRMED'" : "r.status != 'CONFIRMED'");
  }
  const where = conditions.join(" AND ");
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM reservations r WHERE ${where}`).get(params) as { count: number }).count;
  const counts = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status = 'CONFIRMED' AND start_at <= @now AND end_at > @now THEN 1 ELSE 0 END), 0) AS ACTIVE,
    COALESCE(SUM(CASE WHEN status = 'CONFIRMED' AND start_at > @now THEN 1 ELSE 0 END), 0) AS UPCOMING,
    COALESCE(SUM(CASE WHEN status != 'CONFIRMED' OR end_at <= @now THEN 1 ELSE 0 END), 0) AS HISTORY
    FROM reservations WHERE user_id = @userId`).get({ userId, now }) as OwnReservationPage["counts"];
  const { boundary } = db.prepare(`SELECT MIN(time) AS boundary FROM (
    SELECT MIN(start_at) AS time FROM reservations WHERE user_id = ? AND status = 'CONFIRMED' AND start_at > ?
    UNION ALL SELECT MIN(end_at) AS time FROM reservations WHERE user_id = ? AND status = 'CONFIRMED' AND end_at > ?
  )`).get(userId, now, userId, now) as { boundary: string | null };
  const machineOptions = db.prepare(`SELECT DISTINCT m.id,
    CASE WHEN dmt.machine_id IS NOT NULL THEN '机器已删除' ELSE m.name END AS name
    FROM reservations r JOIN machines m ON m.id = r.machine_id
    LEFT JOIN deleted_machine_tombstones dmt ON dmt.machine_id = m.id
    WHERE r.user_id = ? ORDER BY name, m.id`).all(userId) as OwnReservationPage["machineOptions"];
  const resourceGroupOptions = db.prepare(`SELECT DISTINCT
    CASE WHEN r.scope = 'MACHINE' THEN m.id ELSE rg.id END AS id,
    m.id AS machineId, r.scope,
    CASE WHEN r.scope = 'MACHINE' THEN '整机' WHEN drgt.resource_group_id IS NOT NULL THEN '资源组已删除' ELSE rg.name END AS name
    FROM reservations r JOIN machines m ON m.id = r.machine_id
    JOIN resource_groups rg ON rg.id = r.resource_group_id
    LEFT JOIN deleted_resource_group_tombstones drgt ON drgt.resource_group_id = rg.id
    WHERE r.user_id = ? ORDER BY name, m.id, id`).all(userId) as OwnReservationPage["resourceGroupOptions"];
  const sort = query.category === "ACTIVE" ? "r.end_at" : query.category === "UPCOMING" ? "r.start_at" : "COALESCE(r.cancelled_at, r.end_at)";
  const direction = query.category === "HISTORY" ? "DESC" : "ASC";
  let after = "";
  if (query.cursor) {
    let cursor: z.infer<typeof cursorSchema>;
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8"))); }
    catch { throw new BusinessError("分页条件无效，请刷新列表", 400, undefined, "INVALID_CURSOR"); }
    if (cursor.key !== key) throw new BusinessError("分页条件无效，请刷新列表", 400, undefined, "INVALID_CURSOR");
    if (cursor.revision !== revision || (cursor.boundary && cursor.boundary <= now)) {
      throw new BusinessError("占用列表已变化，请刷新列表", 409, undefined, "STALE_CURSOR");
    }
    const op = direction === "DESC" ? "<" : ">";
    after = ` AND (${sort} ${op} @cursorTime OR (${sort} = @cursorTime AND r.id ${op} @cursorId))`;
    params.cursorTime = cursor.time; params.cursorId = cursor.id;
  }
  params.limit = query.limit + 1;
  const rows = db.prepare(`${selectJoined} WHERE ${where}${after} ORDER BY ${sort} ${direction}, r.id ${direction} LIMIT @limit`).all(params) as Array<Record<string, unknown>>;
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const time = last && (query.category === "ACTIVE" ? last.end_at : query.category === "UPCOMING" ? last.start_at : last.cancelled_at ?? last.end_at);
  return {
    reservations: mapRows(page, userId, role, now), total, counts, machineOptions, resourceGroupOptions,
    serverNow: now, revision, nextBoundary: boundary,
    nextCursor: rows.length > query.limit && last ? Buffer.from(JSON.stringify({ time, id: last.id, key, revision, boundary })).toString("base64url") : null
  };
}

export function cancelOwnReservationBatch(userId: string, rawBody: unknown) {
  const body = batchSchema.parse(rawBody);
  return withImmediateTransaction(() => {
    const now = nowIso();
    const issues: BulkCancellationIssue[] = [];
    for (const selected of body.reservations) {
      const row = db.prepare("SELECT * FROM reservations WHERE id = ? AND user_id = ?").get(selected.id, userId) as Record<string, unknown> | undefined;
      const code = !row ? "NOT_AVAILABLE" : row.status !== "CONFIRMED" || String(row.start_at) <= now ? "NOT_UPCOMING" : reservationStateToken(row) !== selected.stateToken ? "CHANGED" : null;
      if (code) issues.push({ id: selected.id, code });
    }
    if (issues.length) throw new BusinessError("所选占用已变化，本次未取消任何记录，请重新确认", 409, { issues }, "BULK_CANCELLATION_STALE");
    for (const selected of body.reservations) {
      try { cancelReservation(selected.id, userId, false, body.reason); }
      catch (error) {
        if (!(error instanceof BusinessError)) throw error;
        throw new BusinessError("所选占用已变化，本次未取消任何记录，请重新确认", 409, {
          issues: [{ id: selected.id, code: "NOT_UPCOMING" }]
        }, "BULK_CANCELLATION_STALE");
      }
    }
    return { cancelledIds: body.reservations.map((r) => r.id), revision: getScheduleRevision(), serverNow: nowIso() };
  });
}

export function registerMyReservationRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {
  app.post("/api/v1/reservations/mine/inspect", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { ids } = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).strict().parse(request.body);
    const unique = [...new Set(ids)];
    const rows = db.prepare(`${selectJoined} WHERE r.user_id = ? AND r.id IN (${unique.map(() => "?").join(",")})`).all(auth.user.id, ...unique) as Array<Record<string, unknown>>;
    const now = nowIso();
    return { reservations: mapRows(rows, auth.user.id, auth.user.role, now), serverNow: now, revision: getScheduleRevision() };
  });
  app.get("/api/v1/reservations/mine", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    return listOwnReservations(auth.user.id, auth.user.role, request.query);
  });
  app.get("/api/v1/reservations/mine/:id", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = db.prepare(`${selectJoined} WHERE r.id = ? AND r.user_id = ?`).get(id, auth.user.id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError("占用记录不存在或不可查看", 404, undefined, "RESERVATION_NOT_FOUND");
    const now = nowIso();
    return { reservation: mapRows([row], auth.user.id, auth.user.role, now)[0], serverNow: now, revision: getScheduleRevision() };
  });
  app.post("/api/v1/reservations/mine/cancel-batch", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const result = cancelOwnReservationBatch(auth.user.id, request.body);
    publishRevision(result.revision);
    return result;
  });
}
