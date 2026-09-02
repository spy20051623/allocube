import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ConflictItem,
  ReservationPreviewItem,
  ReservationSegmentInput
} from "../src/shared/types.js";
import {
  addAudit,
  bumpScheduleRevision,
  currentMinuteIso,
  db,
  getSettings,
  nowIso,
  withImmediateTransaction
} from "./db.js";
import { BusinessError } from "./business-error.js";
import { createNotification } from "./mailer.js";
import { userCanAccessMachine } from "./machine-access.js";
import { loadGroupAllocations } from "./resources.js";

export { BusinessError } from "./business-error.js";

const minuteDateTimeSchema = z.string().datetime().refine((value) => {
  const date = new Date(value);
  return date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
}, "占用时间只能精确到分钟");

export const segmentSchema = z.object({
  scope: z.enum(["RESOURCE_GROUP", "MACHINE"]).optional().default("RESOURCE_GROUP"),
  machineId: z.string().uuid().optional(),
  resourceGroupId: z.string().uuid(),
  startMode: z.enum(["IMMEDIATE", "SCHEDULED"]).optional().default("SCHEDULED"),
  startAt: minuteDateTimeSchema,
  endAt: minuteDateTimeSchema,
  title: z.string().max(120).optional().default(""),
  purpose: z.string().max(500).optional().default(""),
  note: z.string().max(1000).optional().default("")
});

type GroupRow = {
  id: string;
  machine_id: string;
  name: string;
  version: number;
  status: "ACTIVE" | "DISABLED";
  machine_status: "ACTIVE" | "DISABLED";
};

type BusyInterval = {
  type: "RESERVATION" | "UNAVAILABILITY";
  startAt: string;
  endAt: string;
  label: string;
};

export type ApiAuditContext = {
  apiTokenId?: string;
  apiOperationId?: string;
};

function getGroup(resourceGroupId: string) {
  return db
    .prepare(
      `SELECT g.id, g.machine_id, g.name, g.version, g.status,
              m.status AS machine_status
       FROM resource_groups g
       JOIN machines m ON m.id = g.machine_id
       WHERE g.id = ?
         AND NOT EXISTS (
           SELECT 1 FROM deleted_resource_group_tombstones drgt
           WHERE drgt.resource_group_id = g.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM deleted_machine_tombstones dmt
           WHERE dmt.machine_id = m.id
         )`
    )
    .get(resourceGroupId) as GroupRow | undefined;
}

export function normalizeSegmentStart(
  segment: ReservationSegmentInput,
  serverMinute = currentMinuteIso()
): ReservationSegmentInput & {
  scope: "RESOURCE_GROUP" | "MACHINE";
  startMode: "IMMEDIATE" | "SCHEDULED";
} {
  const scope = segment.scope ?? "RESOURCE_GROUP";
  const start = new Date(segment.startAt).getTime();
  const boundary = new Date(serverMinute).getTime();
  if (
    Number.isFinite(start) &&
    Number.isFinite(boundary) &&
    (segment.startMode === "IMMEDIATE" || start <= boundary)
  ) {
    return {
      ...segment,
      scope,
      startMode: "IMMEDIATE",
      startAt: serverMinute
    };
  }
  return {
    ...segment,
    scope,
    startMode: "SCHEDULED"
  };
}

export function validateSegmentTimes(
  segment: ReservationSegmentInput,
  serverMinute = currentMinuteIso()
) {
  const settings = getSettings();
  const start = new Date(segment.startAt);
  const end = new Date(segment.endAt);
  const current = new Date(serverMinute);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new BusinessError("时间格式无效");
  }
  if (!Number.isFinite(current.getTime())) {
    throw new BusinessError("服务器时间无效");
  }
  const duration = (end.getTime() - start.getTime()) / 60000;
  if (duration < settings.minBookingMinutes) {
    throw new BusinessError(`占用时间至少需要 ${settings.minBookingMinutes} 分钟`);
  }
  if (duration > settings.maxBookingMinutes) {
    throw new BusinessError(`单次占用最长 ${settings.maxBookingMinutes} 分钟`);
  }
  if (start.getTime() < current.getTime()) {
    throw new BusinessError("不能占用已经过去的时间");
  }
  const horizon =
    current.getTime() + settings.advanceDays * 24 * 60 * 60 * 1000;
  if (end.getTime() > horizon) {
    throw new BusinessError(`占用结束时间不能超过未来 ${settings.advanceDays} 天`);
  }
}

function getBusyIntervals(
  group: GroupRow,
  scope: "RESOURCE_GROUP" | "MACHINE",
  startAt: string,
  endAt: string,
  excludeReservationId?: string
): BusyInterval[] {
  const reservations = db
    .prepare(
      `SELECT start_at, end_at FROM reservations
       WHERE machine_id = ?
         AND (
           ? = 'MACHINE'
           OR resource_group_id = ?
           OR scope = 'MACHINE'
         )
         AND status = 'CONFIRMED'
         AND start_at < ? AND end_at > ?
         AND (? IS NULL OR id != ?)`
    )
    .all(
      group.machine_id,
      scope,
      group.id,
      endAt,
      startAt,
      excludeReservationId ?? null,
      excludeReservationId ?? null
    ) as Array<{ start_at: string; end_at: string }>;
  const unavailability = db
    .prepare(
      `SELECT start_at, end_at FROM resource_unavailability
       WHERE machine_id = ? AND status = 'ACTIVE'
         AND (
           resource_group_id IS NULL
           OR ? = 'MACHINE'
           OR resource_group_id = ?
         )
         AND start_at < ? AND end_at > ?`
    )
    .all(group.machine_id, scope, group.id, endAt, startAt) as Array<{
    start_at: string;
    end_at: string;
  }>;
  return [
    ...reservations.map((row) => ({
      type: "RESERVATION" as const,
      startAt: row.start_at,
      endAt: row.end_at,
      label: "已有占用"
    })),
    ...unavailability.map((row) => ({
      type: "UNAVAILABILITY" as const,
      startAt: row.start_at,
      endAt: row.end_at,
      label: "资源维护"
    }))
  ].sort((a, b) => a.startAt.localeCompare(b.startAt));
}

function splitByBusy(
  segment: ReservationSegmentInput,
  busy: BusyInterval[],
  minMinutes: number,
  serverMinute: string
) {
  const requestedStart = new Date(segment.startAt).getTime();
  const requestedEnd = new Date(segment.endAt).getTime();
  const normalized = busy
    .map((item) => ({
      start: Math.max(requestedStart, new Date(item.startAt).getTime()),
      end: Math.min(requestedEnd, new Date(item.endAt).getTime())
    }))
    .filter((item) => item.start < item.end)
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const item of normalized) {
    const last = merged.at(-1);
    if (last && item.start <= last.end) {
      last.end = Math.max(last.end, item.end);
    } else {
      merged.push({ ...item });
    }
  }

  const result: ReservationSegmentInput[] = [];
  let cursor = requestedStart;
  for (const item of merged) {
    if ((item.start - cursor) / 60000 >= minMinutes) {
      result.push({
        ...segment,
        startMode:
          new Date(cursor).getTime() <= new Date(serverMinute).getTime()
            ? "IMMEDIATE"
            : "SCHEDULED",
        startAt: new Date(cursor).toISOString(),
        endAt: new Date(item.start).toISOString()
      });
    }
    cursor = Math.max(cursor, item.end);
  }
  if ((requestedEnd - cursor) / 60000 >= minMinutes) {
    result.push({
      ...segment,
      startMode:
        new Date(cursor).getTime() <= new Date(serverMinute).getTime()
          ? "IMMEDIATE"
          : "SCHEDULED",
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(requestedEnd).toISOString()
    });
  }
  return result;
}

export function previewSegments(
  rawSegments: unknown[],
  excludeReservationId?: string,
  serverMinute = currentMinuteIso()
): ReservationPreviewItem[] {
  const settings = getSettings();
  return rawSegments.map((raw) => {
    const segment = normalizeSegmentStart(
      segmentSchema.parse(raw),
      serverMinute
    );
    validateSegmentTimes(segment, serverMinute);
    const group = getGroup(segment.resourceGroupId);
    if (
      group &&
      segment.scope === "MACHINE" &&
      segment.machineId &&
      segment.machineId !== group.machine_id
    ) {
      throw new BusinessError("整机占用目标无效");
    }
    const normalizedSegment = group
      ? {
          ...segment,
          machineId: group.machine_id
        }
      : segment;
    if (
      !group ||
      group.status !== "ACTIVE" ||
      group.machine_status !== "ACTIVE" ||
      (segment.scope === "MACHINE" &&
        Boolean(
          db
            .prepare(
              `SELECT 1 FROM resource_groups
               WHERE machine_id = ? AND status != 'ACTIVE'
               LIMIT 1`
            )
            .get(group?.machine_id)
        ))
    ) {
      const unavailable: ConflictItem = {
        type: "RESOURCE_UNAVAILABLE",
        startAt: segment.startAt,
        endAt: segment.endAt,
        label:
          segment.scope === "MACHINE" ? "机器不可占用" : "资源组不可占用"
      };
      return {
        input: normalizedSegment,
        available: false,
        conflicts: [unavailable],
        splitSegments: []
      };
    }
    const busy = getBusyIntervals(
      group,
      segment.scope,
      segment.startAt,
      segment.endAt,
      excludeReservationId
    );
    return {
      input: normalizedSegment,
      available: busy.length === 0,
      conflicts: busy.map((item) => ({
        type: item.type,
        startAt: item.startAt,
        endAt: item.endAt,
        label: item.label
      })),
      splitSegments: splitByBusy(
        normalizedSegment,
        busy,
        settings.minBookingMinutes,
        serverMinute
      )
    };
  });
}

export function assertUserCanAccessSegments(userId: string, rawSegments: unknown[]) {
  const checkedMachines = new Set<string>();
  for (const raw of rawSegments) {
    const segment = segmentSchema.parse(raw);
    const group = getGroup(segment.resourceGroupId);
    if (!group) continue;
    if (checkedMachines.has(group.machine_id)) continue;
    if (!userCanAccessMachine(userId, group.machine_id)) {
      throw new BusinessError("你没有这台机器的使用权限", 403);
    }
    checkedMachines.add(group.machine_id);
  }
}

export function previewReservationBatch(userId: string, rawSegments: unknown[]) {
  if (!rawSegments.length || rawSegments.length > 100) {
    throw new BusinessError("一次最多提交 100 条占用");
  }
  const serverMinute = currentMinuteIso();
  const segments = rawSegments.map((item) =>
    normalizeSegmentStart(segmentSchema.parse(item), serverMinute)
  );
  validateSingleReservationScope(segments);
  segments.forEach((segment) => validateSegmentTimes(segment, serverMinute));
  validateNoInternalOverlap(segments);
  assertUserCanAccessSegments(userId, segments);
  return {
    segments,
    items: previewSegments(segments, undefined, serverMinute),
    serverNow: nowIso()
  };
}

function getOwnedConfirmedReservation(reservationId: string, userId: string) {
  const row = db
    .prepare("SELECT * FROM reservations WHERE id = ?")
    .get(reservationId) as Record<string, unknown> | undefined;
  if (!row || row.status !== "CONFIRMED") {
    throw new BusinessError("占用记录不存在或已不可操作", 404);
  }
  if (row.user_id !== userId) {
    throw new BusinessError("只能操作自己的占用", 403);
  }
  if (!userCanAccessMachine(userId, String(row.machine_id))) {
    throw new BusinessError("你没有这台机器的使用权限", 403);
  }
  return row;
}

function reservationOperationSummary(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    scope: row.scope,
    machineId: row.machine_id,
    resourceGroupId: row.resource_group_id,
    startAt: row.start_at,
    endAt: row.end_at,
    title: row.title,
    purpose: row.purpose,
    note: row.note,
    status: row.status
  };
}

export function previewReservationUpdate(
  userId: string,
  reservationId: string,
  rawSegment: unknown
) {
  const segment = segmentSchema.parse(rawSegment);
  const existing = getOwnedConfirmedReservation(reservationId, userId);
  if (segment.resourceGroupId !== existing.resource_group_id) {
    throw new BusinessError("修改时间时不能更换资源组，请取消后重新占用");
  }
  if (segment.scope !== existing.scope) {
    throw new BusinessError("修改时间时不能改变占用范围，请取消后重新占用");
  }
  const current = nowIso();
  if (String(existing.end_at) <= current) {
    throw new BusinessError("已结束的占用不能修改");
  }
  const started = String(existing.start_at) <= current;
  const timeChanged =
    segment.startAt !== existing.start_at || segment.endAt !== existing.end_at;
  if (started && timeChanged) {
    throw new BusinessError("已经开始的占用不能修改时间");
  }
  const item = started
    ? { input: segment, available: true, conflicts: [], splitSegments: [] }
    : previewSegments([segment], reservationId)[0];
  return {
    reservation: reservationOperationSummary(existing),
    segment,
    item,
    serverNow: nowIso()
  };
}

export function previewOwnReservationAction(
  userId: string,
  reservationId: string,
  action: "CANCEL" | "END"
) {
  const existing = getOwnedConfirmedReservation(reservationId, userId);
  const current = nowIso();
  if (action === "CANCEL") {
    if (String(existing.end_at) <= current) {
      throw new BusinessError("已结束的占用不能取消");
    }
    if (String(existing.start_at) <= current) {
      throw new BusinessError("进行中的占用请使用提前结束");
    }
  } else if (
    String(existing.start_at) > current ||
    String(existing.end_at) <= current
  ) {
    throw new BusinessError("只有进行中的占用可以提前结束");
  }
  return {
    reservation: reservationOperationSummary(existing),
    serverNow: current
  };
}

function getReplaceableReservation(reservationId: string, userId: string) {
  const existing = db
    .prepare("SELECT * FROM reservations WHERE id = ?")
    .get(reservationId) as Record<string, unknown> | undefined;
  if (!existing || existing.status !== "CONFIRMED") {
    throw new BusinessError("占用记录不存在或已不可编辑", 404);
  }
  if (existing.user_id !== userId) {
    throw new BusinessError("只能编辑自己的占用", 403);
  }
  if (!userCanAccessMachine(userId, String(existing.machine_id))) {
    throw new BusinessError("你没有这台机器的使用权限", 403);
  }
  return existing;
}

function validateReplacementScope(
  existing: Record<string, unknown>,
  segments: ReservationSegmentInput[]
) {
  validateSingleReservationScope(segments);
  if (segments.some((segment) => segment.scope !== existing.scope)) {
    throw new BusinessError(
      existing.scope === "MACHINE"
        ? "整机占用只能继续按整机模式编辑"
        : "资源组占用只能继续按资源组模式编辑"
    );
  }
}

export function previewReplacementSegments(
  userId: string,
  reservationId: string,
  rawSegments: unknown[]
) {
  if (!rawSegments.length || rawSegments.length > 100) {
    throw new BusinessError("一次最多提交 100 条占用");
  }
  const segments = rawSegments.map((item) => segmentSchema.parse(item));
  const existing = getReplaceableReservation(reservationId, userId);
  validateReplacementScope(existing, segments);
  assertUserCanAccessSegments(userId, segments);
  return previewSegments(segments, reservationId);
}

function validateNoInternalOverlap(segments: ReservationSegmentInput[]) {
  const resolved = segments.map((segment) => ({
    segment,
    group: getGroup(segment.resourceGroupId)
  }));
  for (let left = 0; left < resolved.length; left += 1) {
    for (let right = left + 1; right < resolved.length; right += 1) {
      const first = resolved[left];
      const second = resolved[right];
      if (!first.group || !second.group) continue;
      const sameTarget =
        first.segment.resourceGroupId === second.segment.resourceGroupId ||
        (first.group.machine_id === second.group.machine_id &&
          (first.segment.scope === "MACHINE" ||
            second.segment.scope === "MACHINE"));
      if (
        sameTarget &&
        first.segment.startAt < second.segment.endAt &&
        second.segment.startAt < first.segment.endAt
      ) {
        const resourceGroupOnly =
          first.segment.scope !== "MACHINE" &&
          second.segment.scope !== "MACHINE" &&
          first.segment.resourceGroupId === second.segment.resourceGroupId;
        throw new BusinessError(
          resourceGroupOnly
            ? "本次提交中，同一资源组存在重叠的占用时段"
            : "本次提交中存在互相重叠的占用时段"
        );
      }
    }
  }
}

function validateSingleReservationScope(
  segments: Array<Pick<ReservationSegmentInput, "scope">>
) {
  if (new Set(segments.map((segment) => segment.scope)).size > 1) {
    throw new BusinessError("整机占用和资源组占用不能同时提交");
  }
}

function insertReservationBatch(
  userId: string,
  segments: ReservationSegmentInput[],
  parentReservationId?: string,
  auditContext?: ApiAuditContext
) {
  const batchId = randomUUID();
  const createdAt = nowIso();
  db.prepare(
    "INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)"
  ).run(batchId, userId, createdAt);
  const insert = db.prepare(
    `INSERT INTO reservations(
      id, batch_id, scope, resource_group_id, machine_id, user_id, start_at, end_at,
      initial_start_at, initial_end_at, parent_reservation_id,
      title, purpose, note, snapshot_group_name, snapshot_resource_config_json,
      snapshot_group_version, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const reservations = segments.map((segment) => {
    const group = getGroup(segment.resourceGroupId)!;
    const id = randomUUID();
    insert.run(
      id,
      batchId,
      segment.scope,
      group.id,
      group.machine_id,
      userId,
      segment.startAt,
      segment.endAt,
      segment.startAt,
      segment.endAt,
      parentReservationId ?? null,
      segment.title ?? "",
      segment.purpose ?? "",
      segment.note ?? "",
      group.name,
      JSON.stringify(loadGroupAllocations(group.id)),
      group.version,
      createdAt,
      createdAt
    );
    addAudit(
      userId,
      "RESERVATION_CREATE",
      "reservation",
      id,
      undefined,
      {
        ...segment,
        ...(parentReservationId
          ? { replacesReservationId: parentReservationId }
          : {})
      },
      auditContext
    );
    return { id, ...segment, machineId: group.machine_id };
  });
  return { batchId, reservations };
}

export function commitReservationBatch(
  userId: string,
  rawSegments: unknown[],
  auditContext?: ApiAuditContext
) {
  if (!rawSegments.length || rawSegments.length > 100) {
    throw new BusinessError("一次最多提交 100 条占用");
  }
  const parsedSegments = rawSegments.map((item) => segmentSchema.parse(item));
  validateSingleReservationScope(parsedSegments);

  return withImmediateTransaction(() => {
    const serverMinute = currentMinuteIso();
    const segments = parsedSegments.map((segment) =>
      normalizeSegmentStart(segment, serverMinute)
    );
    segments.forEach((segment) =>
      validateSegmentTimes(segment, serverMinute)
    );
    validateNoInternalOverlap(segments);
    assertUserCanAccessSegments(userId, segments);
    const preview = previewSegments(segments, undefined, serverMinute);
    if (preview.some((item) => !item.available)) {
      throw new BusinessError("资源可用情况已更新，请根据最新结果重新确认", 409, preview);
    }
    const { batchId, reservations } = insertReservationBatch(
      userId,
      segments,
      undefined,
      auditContext
    );
    const revision = bumpScheduleRevision();
    return { batchId, reservations, revision, serverNow: nowIso() };
  });
}

export function replaceReservationBatch(
  userId: string,
  reservationId: string,
  rawSegments: unknown[]
) {
  if (!rawSegments.length || rawSegments.length > 100) {
    throw new BusinessError("一次最多提交 100 条占用");
  }
  const parsedSegments = rawSegments.map((item) => segmentSchema.parse(item));

  const result = withImmediateTransaction(() => {
    const serverMinute = currentMinuteIso();
    const segments = parsedSegments.map((segment) =>
      normalizeSegmentStart(segment, serverMinute)
    );
    segments.forEach((segment) =>
      validateSegmentTimes(segment, serverMinute)
    );
    validateNoInternalOverlap(segments);
    const existing = getReplaceableReservation(reservationId, userId);
    const actionAt = nowIso();
    const changedAt = serverMinute;
    const originalIsActive =
      String(existing.start_at) <= actionAt &&
      String(existing.end_at) > actionAt;
    const effectiveSegments = originalIsActive
      ? segments.map((segment) =>
          segment.startAt < changedAt
            ? { ...segment, startAt: changedAt }
            : segment
        )
      : segments;
    effectiveSegments.forEach((segment) =>
      validateSegmentTimes(segment, serverMinute)
    );
    validateNoInternalOverlap(effectiveSegments);
    validateReplacementScope(existing, effectiveSegments);
    assertUserCanAccessSegments(userId, effectiveSegments);
    const preview = previewSegments(
      effectiveSegments,
      reservationId,
      serverMinute
    );
    if (preview.some((item) => !item.available)) {
      throw new BusinessError(
        "资源可用情况已更新，原占用保持不变，请重新确认",
        409,
        preview
      );
    }

    const originalAlreadyEnded = String(existing.end_at) <= actionAt;
    if (!originalAlreadyEnded) {
      if (String(existing.start_at) < changedAt) {
        db.prepare(
          `UPDATE reservations
           SET end_at = ?, adjustment_type = 'USER_REPLACED',
               adjustment_reason = ?, updated_at = ?
           WHERE id = ?`
        ).run(changedAt, "用户编辑占用", actionAt, reservationId);
      } else {
        db.prepare(
          `UPDATE reservations
           SET status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
               cancellation_reason = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          actionAt,
          userId,
          "用户编辑占用",
          actionAt,
          reservationId
        );
      }
    }
    addAudit(
      userId,
      "RESERVATION_REPLACE",
      "reservation",
      reservationId,
      existing,
      {
        segmentCount: segments.length,
        originalAlreadyEnded
      }
    );

    const created = insertReservationBatch(
      userId,
      effectiveSegments,
      reservationId
    );
    const revision = bumpScheduleRevision();
    return { ...created, revision, serverNow: nowIso() };
  });
  return {
    batchId: result.batchId,
    reservations: result.reservations,
    revision: result.revision,
    serverNow: result.serverNow
  };
}

export function updateReservation(
  reservationId: string,
  actorUserId: string,
  rawSegment: unknown,
  auditContext?: ApiAuditContext
) {
  const segment = segmentSchema.parse(rawSegment);
  const result = withImmediateTransaction(() => {
    const existing = db
      .prepare("SELECT * FROM reservations WHERE id = ?")
      .get(reservationId) as Record<string, unknown> | undefined;
    if (!existing || existing.status !== "CONFIRMED") {
      throw new BusinessError("占用记录不存在或不可修改", 404);
    }
    if (existing.user_id !== actorUserId) {
      throw new BusinessError("只能修改自己的占用", 403);
    }
    if (!userCanAccessMachine(actorUserId, String(existing.machine_id))) {
      throw new BusinessError("你没有这台机器的使用权限", 403);
    }
    if (segment.resourceGroupId !== existing.resource_group_id) {
      throw new BusinessError("修改时间时不能更换资源组，请取消后重新占用");
    }
    if (segment.scope !== existing.scope) {
      throw new BusinessError("修改时间时不能改变占用范围，请取消后重新占用");
    }
    const current = nowIso();
    if (String(existing.end_at) <= current) {
      throw new BusinessError("已结束的占用不能修改");
    }
    const started = String(existing.start_at) <= current;
    const timeChanged =
      segment.startAt !== existing.start_at ||
      segment.endAt !== existing.end_at;
    if (started && timeChanged) {
      throw new BusinessError("已经开始的占用不能修改时间");
    }
    if (!started) {
      validateSegmentTimes(segment);
      const preview = previewSegments([segment], reservationId);
      if (!preview[0].available) {
        throw new BusinessError("新时段不可用，原占用保持不变", 409, preview);
      }
    }
    db.prepare(
      `UPDATE reservations SET
        start_at = ?, end_at = ?, title = ?, purpose = ?, note = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      segment.startAt,
      segment.endAt,
      segment.title ?? "",
      segment.purpose ?? "",
      segment.note ?? "",
      nowIso(),
      reservationId
    );
    addAudit(
      actorUserId,
      "RESERVATION_UPDATE",
      "reservation",
      reservationId,
      existing,
      segment,
      auditContext
    );
    const revision = bumpScheduleRevision();
    return { id: reservationId, revision };
  });
  return { id: result.id, revision: result.revision };
}

export function cancelReservation(
  reservationId: string,
  actorUserId: string,
  canManage: boolean,
  reason = "",
  auditContext?: ApiAuditContext
) {
  withImmediateTransaction(() => {
    const existing = db
      .prepare("SELECT * FROM reservations WHERE id = ?")
      .get(reservationId) as Record<string, unknown> | undefined;
    if (!existing || existing.status !== "CONFIRMED") {
      throw new BusinessError("占用记录不存在或已取消", 404);
    }
    if (existing.user_id !== actorUserId && !canManage) {
      throw new BusinessError("无权取消此占用", 403);
    }
    const now = nowIso();
    if (String(existing.end_at) <= now) {
      throw new BusinessError("已结束的占用不能取消");
    }
    if (String(existing.start_at) <= now) {
      throw new BusinessError("进行中的占用请使用提前结束");
    }
    db.prepare(
      `UPDATE reservations SET
        status = 'CANCELLED', cancelled_at = ?, cancelled_by = ?,
        cancellation_reason = ?, updated_at = ?
       WHERE id = ?`
    ).run(now, actorUserId, reason, now, reservationId);
    if (existing.user_id !== actorUserId) {
      createNotification(
        String(existing.user_id),
        "RESERVATION_CANCELLED",
        "占用已被管理员取消",
        reason || "机器管理员取消了你的资源占用。",
        "/reservations",
        { emailPolicy: "RESERVATION_IMPACT" }
      );
    }
    addAudit(
      actorUserId,
      "RESERVATION_CANCEL",
      "reservation",
      reservationId,
      existing,
      { reason },
      auditContext
    );
    bumpScheduleRevision();
  });
}

export function endReservationEarly(
  reservationId: string,
  actorUserId: string,
  canManage = false,
  reason = "",
  auditContext?: ApiAuditContext
) {
  const result = withImmediateTransaction(() => {
    const existing = db
      .prepare("SELECT * FROM reservations WHERE id = ?")
      .get(reservationId) as Record<string, unknown> | undefined;
    if (!existing || existing.status !== "CONFIRMED") {
      throw new BusinessError("占用记录不存在或已取消", 404);
    }
    const releasedByManager = existing.user_id !== actorUserId;
    if (releasedByManager && !canManage) {
      throw new BusinessError("无权释放此占用", 403);
    }
    const now = nowIso();
    if (String(existing.start_at) > now || String(existing.end_at) <= now) {
      throw new BusinessError("只有进行中的占用可以提前结束");
    }
    const elapsedMilliseconds =
      new Date(now).getTime() - new Date(String(existing.start_at)).getTime();
    const removed = elapsedMilliseconds < 60_000;
    if (removed) {
      const batchId = String(existing.batch_id);
      addAudit(
        actorUserId,
        "RESERVATION_WITHDRAW_FIRST_MINUTE",
        "reservation",
        reservationId,
        undefined,
        {
          machineId: existing.machine_id,
          resourceGroupId: existing.resource_group_id,
          scope: existing.scope,
          startedAt: existing.start_at,
          removedWithinFirstMinute: true,
          releasedByManager,
          reason
        },
        auditContext
      );
      db.prepare("DELETE FROM reservations WHERE id = ?").run(reservationId);
      db.prepare(
        `DELETE FROM reservation_batches
         WHERE id = ?
           AND NOT EXISTS (
             SELECT 1 FROM reservations WHERE batch_id = ?
           )`
      ).run(batchId, batchId);
    } else {
      const endAt = currentMinuteIso(new Date(now).getTime());
      db.prepare(
        `UPDATE reservations
         SET end_at = ?, updated_at = ?
         WHERE id = ?`
      ).run(endAt, now, reservationId);
      addAudit(
        actorUserId,
        "RESERVATION_END_EARLY",
        "reservation",
        reservationId,
        existing,
        { endAt, releasedByManager, reason },
        auditContext
      );
    }
    if (releasedByManager) {
      createNotification(
        String(existing.user_id),
        "RESERVATION_RELEASED_BY_MANAGER",
        "占用已被管理员释放",
        reason || "机器管理员释放了你的资源占用。",
        "/reservations",
        { emailPolicy: "RESERVATION_IMPACT" }
      );
    }
    bumpScheduleRevision();
    return { removed };
  });
  return { removed: result.removed };
}
