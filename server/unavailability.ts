import { randomUUID } from "node:crypto";
import {
  addAudit,
  bumpScheduleRevision,
  currentMinuteIso,
  db,
  getScheduleRevision,
  nowIso,
  withImmediateTransaction
} from "./db.js";
import { BusinessError } from "./business-error.js";
import { createNotification } from "./mailer.js";

export type UnavailabilityTargetType = "MACHINE" | "RESOURCE_GROUP";

export type UnavailabilityTarget = {
  type: UnavailabilityTargetType;
  id: string;
  machineId: string;
  resourceGroupId: string | null;
  name: string;
  machineName: string;
  status: "ACTIVE" | "DISABLED";
  machineStatus: "ACTIVE" | "DISABLED";
  version: number;
};

export type ReservationImpactAction =
  | "CANCEL"
  | "TRIM_START"
  | "TRIM_END"
  | "SPLIT";

export type ReservationImpact = {
  id: string;
  userId: string;
  applicantName: string;
  resourceGroupId: string;
  resourceGroupName: string;
  machineName: string;
  startAt: string;
  endAt: string;
  action: ReservationImpactAction;
  resultingSegments: Array<{ startAt: string; endAt: string }>;
};

export type UnavailabilityPreview = {
  target: UnavailabilityTarget;
  startAt: string;
  endAt: string;
  revision: number;
  affectedReservations: ReservationImpact[];
  summary: {
    total: number;
    cancelled: number;
    trimmed: number;
    split: number;
  };
};

const DISTANT_FUTURE = "9999-12-31T23:59:00.000Z";

export function resolveUnavailabilityTarget(
  type: UnavailabilityTargetType,
  id: string
): UnavailabilityTarget {
  if (type === "MACHINE") {
    const row = db
      .prepare(
        `SELECT m.id, m.name, m.status, m.version FROM machines m
         WHERE m.id = ?
           AND NOT EXISTS (
             SELECT 1 FROM deleted_machine_tombstones dmt
             WHERE dmt.machine_id = m.id
           )`
      )
      .get(id) as
      | {
          id: string;
          name: string;
          status: "ACTIVE" | "DISABLED";
          version: number;
        }
      | undefined;
    if (!row) throw new BusinessError("机器不存在", 404);
    return {
      type,
      id: row.id,
      machineId: row.id,
      resourceGroupId: null,
      name: row.name,
      machineName: row.name,
      status: row.status,
      machineStatus: row.status,
      version: row.version
    };
  }

  const row = db
    .prepare(
      `SELECT g.id, g.machine_id, g.name, g.status, g.version,
              m.name AS machine_name, m.status AS machine_status
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
    .get(id) as
    | {
        id: string;
        machine_id: string;
        name: string;
        status: "ACTIVE" | "DISABLED";
        version: number;
        machine_name: string;
        machine_status: "ACTIVE" | "DISABLED";
      }
    | undefined;
  if (!row) throw new BusinessError("资源组不存在", 404);
  return {
    type,
    id: row.id,
    machineId: row.machine_id,
    resourceGroupId: row.id,
    name: row.name,
    machineName: row.machine_name,
    status: row.status,
    machineStatus: row.machine_status,
    version: row.version
  };
}

function classifyImpact(
  startAt: string,
  endAt: string,
  blockedStartAt: string,
  blockedEndAt: string
): Pick<ReservationImpact, "action" | "resultingSegments"> {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const blockedStart = Date.parse(blockedStartAt);
  const blockedEnd = Date.parse(blockedEndAt);

  if (blockedStart <= start && blockedEnd >= end) {
    return { action: "CANCEL", resultingSegments: [] };
  }
  if (blockedStart <= start) {
    return {
      action: "TRIM_START",
      resultingSegments: [{ startAt: blockedEndAt, endAt }]
    };
  }
  if (blockedEnd >= end) {
    return {
      action: "TRIM_END",
      resultingSegments: [{ startAt, endAt: blockedStartAt }]
    };
  }
  return {
    action: "SPLIT",
    resultingSegments: [
      { startAt, endAt: blockedStartAt },
      { startAt: blockedEndAt, endAt }
    ]
  };
}

function reservationImpacts(
  target: UnavailabilityTarget,
  startAt: string,
  endAt: string
): ReservationImpact[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.user_id, r.resource_group_id, r.start_at, r.end_at,
              u.display_name, g.name AS group_name
       FROM reservations r
       JOIN users u ON u.id = r.user_id
       JOIN resource_groups g ON g.id = r.resource_group_id
       WHERE r.machine_id = ?
         AND (
           ? IS NULL
           OR r.resource_group_id = ?
           OR r.scope = 'MACHINE'
         )
         AND r.status = 'CONFIRMED'
         AND r.start_at < ? AND r.end_at > ?
       ORDER BY r.start_at, r.id`
    )
    .all(
      target.machineId,
      target.resourceGroupId,
      target.resourceGroupId,
      endAt,
      startAt
    ) as Array<{
    id: string;
    user_id: string;
    resource_group_id: string;
    start_at: string;
    end_at: string;
    display_name: string;
    group_name: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    applicantName: row.display_name,
    resourceGroupId: row.resource_group_id,
    resourceGroupName: row.group_name,
    machineName: target.machineName,
    startAt: row.start_at,
    endAt: row.end_at,
    ...classifyImpact(row.start_at, row.end_at, startAt, endAt)
  }));
}

function previewSummary(impacts: ReservationImpact[]) {
  return {
    total: impacts.length,
    cancelled: impacts.filter((item) => item.action === "CANCEL").length,
    trimmed: impacts.filter(
      (item) => item.action === "TRIM_START" || item.action === "TRIM_END"
    ).length,
    split: impacts.filter((item) => item.action === "SPLIT").length
  };
}

export function previewUnavailability(
  type: UnavailabilityTargetType,
  id: string,
  startAt: string,
  endAt: string
): UnavailabilityPreview {
  const normalized = normalizePlannedTimes(startAt, endAt);
  const target = resolveUnavailabilityTarget(type, id);
  const impacts = reservationImpacts(
    target,
    normalized.startAt,
    normalized.endAt
  );
  return {
    target,
    startAt: normalized.startAt,
    endAt: normalized.endAt,
    revision: getScheduleRevision(),
    affectedReservations: impacts,
    summary: previewSummary(impacts)
  };
}

function applyReservationImpacts(
  impacts: ReservationImpact[],
  actorUserId: string,
  sourceId: string | null,
  reason: string,
  targetName: string,
  changeType: "MAINTENANCE" | "DISABLE"
) {
  const now = nowIso();
  const users = new Map<string, { name: string; impacts: ReservationImpact[] }>();
  const getReservation = db.prepare("SELECT * FROM reservations WHERE id = ?");
  const cancelReservation = db.prepare(
    `UPDATE reservations SET
      status = 'CANCELLED_UNAVAILABILITY', cancelled_at = ?, cancelled_by = ?,
      cancellation_reason = ?, adjusted_by_unavailability_id = ?,
      adjustment_type = 'CANCEL', adjustment_reason = ?, updated_at = ?
     WHERE id = ? AND status = 'CONFIRMED'`
  );
  const trimReservation = db.prepare(
    `UPDATE reservations SET start_at = ?, end_at = ?,
      adjusted_by_unavailability_id = ?, adjustment_type = ?,
      adjustment_reason = ?, updated_at = ?
     WHERE id = ? AND status = 'CONFIRMED'`
  );
  const insertSplit = db.prepare(
    `INSERT INTO reservations(
      id, batch_id, scope, resource_group_id, machine_id, user_id,
      start_at, end_at, initial_start_at, initial_end_at,
      parent_reservation_id, adjusted_by_unavailability_id,
      adjustment_type, adjustment_reason,
      title, purpose, note, status,
      snapshot_group_name, snapshot_resource_config_json,
      snapshot_group_version, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED',
             ?, ?, ?, ?, ?)`
  );

  for (const impact of impacts) {
    const row = getReservation.get(impact.id) as Record<string, unknown> | undefined;
    if (!row || row.status !== "CONFIRMED") {
      throw new BusinessError("占用情况已变化，请重新查看影响", 409);
    }
    const reasonText =
      reason || `${targetName}${changeType === "MAINTENANCE" ? "维护" : "停用"}`;
    if (impact.action === "CANCEL") {
      cancelReservation.run(
        now,
        actorUserId,
        reasonText,
        sourceId,
        reasonText,
        now,
        impact.id
      );
    } else {
      const first = impact.resultingSegments[0];
      trimReservation.run(
        first.startAt,
        first.endAt,
        sourceId,
        impact.action,
        reasonText,
        now,
        impact.id
      );
      if (impact.action === "SPLIT") {
        const second = impact.resultingSegments[1];
        const childId = randomUUID();
        insertSplit.run(
          childId,
          row.batch_id,
          row.scope,
          row.resource_group_id,
          row.machine_id,
          row.user_id,
          second.startAt,
          second.endAt,
          row.initial_start_at,
          row.initial_end_at,
          impact.id,
          sourceId,
          "SPLIT",
          reasonText,
          row.title,
          row.purpose,
          row.note,
          row.snapshot_group_name,
          row.snapshot_resource_config_json,
          row.snapshot_group_version,
          now,
          now
        );
        addAudit(
          actorUserId,
          "RESERVATION_SPLIT_UNAVAILABILITY",
          "reservation",
          childId,
          undefined,
          {
            parentReservationId: impact.id,
            adjustedByUnavailabilityId: sourceId,
            startAt: second.startAt,
            endAt: second.endAt,
            reason: reasonText
          }
        );
      }
    }
    const user = users.get(impact.userId) ?? {
      name: impact.applicantName,
      impacts: []
    };
    user.impacts.push(impact);
    users.set(impact.userId, user);
    addAudit(
      actorUserId,
      "RESERVATION_ADJUST_UNAVAILABILITY",
      "reservation",
      impact.id,
      { startAt: impact.startAt, endAt: impact.endAt },
      {
        action: impact.action,
        resultingSegments: impact.resultingSegments,
        reason: reasonText
      }
    );
  }

  for (const [userId, user] of users) {
    const cancelled = user.impacts.filter((item) => item.action === "CANCEL").length;
    const adjusted = user.impacts.length - cancelled;
    const details = [
      cancelled ? `${cancelled}条已取消` : "",
      adjusted ? `${adjusted}条已调整` : ""
    ]
      .filter(Boolean)
      .join("，");
    createNotification(
      userId,
      "RESOURCE_UNAVAILABILITY",
      changeType === "MAINTENANCE"
        ? "资源占用因维护发生变化"
        : "资源占用因停用发生变化",
      `${targetName}${changeType === "MAINTENANCE" ? "已安排维护" : "已停用"}，${details}。${reason ? `原因：${reason}` : ""}`,
      "/reservations"
    );
  }
}

function normalizePlannedTimes(startAt: string, endAt: string) {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new BusinessError("维护时间格式不正确");
  }
  if (start % 60_000 !== 0 || end % 60_000 !== 0) {
    throw new BusinessError("维护时间只能精确到分钟");
  }
  const normalizedStart = Math.max(start, currentMinute);
  if (normalizedStart >= end) {
    throw new BusinessError("维护结束时间必须晚于开始时间");
  }
  return {
    startAt: new Date(normalizedStart).toISOString(),
    endAt: new Date(end).toISOString()
  };
}

export function createPlannedUnavailability(input: {
  type: UnavailabilityTargetType;
  id: string;
  startAt: string;
  endAt: string;
  reason?: string;
  expectedRevision: number;
  actorUserId: string;
}) {
  const recordId = randomUUID();
  const result = withImmediateTransaction(() => {
    const normalized = normalizePlannedTimes(input.startAt, input.endAt);
    if (getScheduleRevision() !== input.expectedRevision) {
      throw new BusinessError(
        "占用情况已变化，请重新查看影响",
        409,
        undefined,
        "UNAVAILABILITY_PREVIEW_STALE"
      );
    }
    const target = resolveUnavailabilityTarget(input.type, input.id);
    if (target.status !== "ACTIVE" || target.machineStatus !== "ACTIVE") {
      throw new BusinessError("已停用的资源不能安排维护", 409);
    }
    const overlap = db
      .prepare(
        `SELECT 1 FROM resource_unavailability
         WHERE machine_id = ? AND status = 'ACTIVE'
           AND (
             (? IS NULL AND resource_group_id IS NULL)
             OR resource_group_id = ?
           )
           AND start_at < ? AND end_at > ?
         LIMIT 1`
      )
      .get(
        target.machineId,
        target.resourceGroupId,
        target.resourceGroupId,
        normalized.endAt,
        normalized.startAt
      );
    if (overlap) {
      throw new BusinessError("该对象已有重叠的维护时段", 409);
    }
    db.prepare(
      `INSERT INTO resource_unavailability(
        id, machine_id, resource_group_id, kind, start_at, end_at,
        reason, created_by, created_at
      ) VALUES(?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?)`
    ).run(
      recordId,
      target.machineId,
      target.resourceGroupId,
      normalized.startAt,
      normalized.endAt,
      input.reason?.trim() ?? "",
      input.actorUserId,
      nowIso()
    );
    const impacts = reservationImpacts(
      target,
      normalized.startAt,
      normalized.endAt
    );
    applyReservationImpacts(
      impacts,
      input.actorUserId,
      recordId,
      input.reason?.trim() ?? "",
      target.name,
      "MAINTENANCE"
    );
    addAudit(
      input.actorUserId,
      "UNAVAILABILITY_CREATE",
      "resource_unavailability",
      recordId,
      undefined,
      {
        targetType: target.type,
        targetId: target.id,
        startAt: normalized.startAt,
        endAt: normalized.endAt,
        reasonProvided: Boolean(input.reason?.trim()),
        impact: previewSummary(impacts)
      }
    );
    const revision = bumpScheduleRevision();
    return {
      id: recordId,
      startAt: normalized.startAt,
      endAt: normalized.endAt,
      revision,
      impact: previewSummary(impacts)
    };
  });
  return result;
}

export function listUnavailability(machineId: string, resourceGroupId?: string) {
  const rows = db
    .prepare(
      `SELECT u.*, g.name AS resource_group_name
       FROM resource_unavailability u
       LEFT JOIN resource_groups g ON g.id = u.resource_group_id
       WHERE u.machine_id = ?
         AND (? IS NULL OR u.resource_group_id = ?)
       ORDER BY u.start_at DESC`
    )
    .all(machineId, resourceGroupId ?? null, resourceGroupId ?? null) as Array<
    Record<string, unknown>
  >;
  return rows.map((row) => ({
    id: row.id,
    machineId: row.machine_id,
    resourceGroupId: row.resource_group_id,
    resourceGroupName: row.resource_group_name,
    kind: row.kind,
    startAt: row.start_at,
    endAt: row.end_at,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at
  }));
}

export function cancelUnavailability(id: string, actorUserId: string) {
  return withImmediateTransaction(() => {
    const row = db
      .prepare("SELECT * FROM resource_unavailability WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    if (!row) throw new BusinessError("维护安排不存在", 404);
    if (row.status !== "ACTIVE") {
      throw new BusinessError("维护安排已经取消", 409);
    }
    if (row.kind !== "PLANNED") {
      throw new BusinessError("停用状态只能通过重新启用结束", 409);
    }
    if (Date.parse(String(row.end_at)) <= Date.now()) {
      throw new BusinessError("已经结束的维护不能取消", 409);
    }
    const changed = db
      .prepare(
        `UPDATE resource_unavailability
         SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
         WHERE id = ? AND status = 'ACTIVE'`
      )
      .run(actorUserId, nowIso(), id);
    if (!changed.changes) {
      throw new BusinessError("维护安排已经更新，请刷新后重试", 409);
    }
    addAudit(
      actorUserId,
      "UNAVAILABILITY_CANCEL",
      "resource_unavailability",
      id,
      row,
      undefined
    );
    return {
      machineId: String(row.machine_id),
      resourceGroupId: row.resource_group_id
        ? String(row.resource_group_id)
        : null,
      revision: bumpScheduleRevision()
    };
  });
}

export function previewLongTermDisable(
  type: UnavailabilityTargetType,
  id: string
) {
  return previewUnavailability(type, id, currentMinuteIso(), DISTANT_FUTURE);
}

function stopPlannedMaintenanceForDisable(
  target: UnavailabilityTarget,
  stoppedAt: string,
  actorUserId: string
) {
  const selectAffected = db.prepare(
    `SELECT id, start_at, end_at, status
     FROM resource_unavailability
     WHERE machine_id = ?
       AND (? IS NULL OR resource_group_id = ?)
       AND kind = 'PLANNED' AND status = 'ACTIVE'
       AND start_at < ? AND end_at > ?`
  );
  const interruptedRows = selectAffected.all(
    target.machineId,
    target.resourceGroupId,
    target.resourceGroupId,
    stoppedAt,
    stoppedAt
  ) as Array<{
    id: string;
    start_at: string;
    end_at: string;
    status: string;
  }>;
  const futureRows = db
    .prepare(
      `SELECT id, start_at, end_at, status
       FROM resource_unavailability
       WHERE machine_id = ?
         AND (? IS NULL OR resource_group_id = ?)
         AND kind = 'PLANNED' AND status = 'ACTIVE'
         AND start_at >= ? AND end_at > ?`
    )
    .all(
      target.machineId,
      target.resourceGroupId,
      target.resourceGroupId,
      stoppedAt,
      stoppedAt
    ) as Array<{
    id: string;
    start_at: string;
    end_at: string;
    status: string;
  }>;
  const interrupted = db
    .prepare(
      `UPDATE resource_unavailability
       SET end_at = ?
       WHERE machine_id = ?
         AND (? IS NULL OR resource_group_id = ?)
         AND kind = 'PLANNED' AND status = 'ACTIVE'
         AND start_at < ? AND end_at > ?`
    )
    .run(
      stoppedAt,
      target.machineId,
      target.resourceGroupId,
      target.resourceGroupId,
      stoppedAt,
      stoppedAt
    ).changes;
  if (interrupted !== interruptedRows.length) {
    throw new BusinessError("维护安排已经更新，请刷新后重试", 409);
  }
  for (const row of interruptedRows) {
    addAudit(
      actorUserId,
      "UNAVAILABILITY_INTERRUPT_DISABLE",
      "resource_unavailability",
      row.id,
      {
        status: row.status,
        startAt: row.start_at,
        endAt: row.end_at
      },
      {
        status: "ACTIVE",
        startAt: row.start_at,
        endAt: stoppedAt,
        disabledTargetType: target.type,
        disabledTargetId: target.id
      }
    );
  }
  const cancelled = db
    .prepare(
      `UPDATE resource_unavailability
       SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
       WHERE machine_id = ?
         AND (? IS NULL OR resource_group_id = ?)
         AND kind = 'PLANNED' AND status = 'ACTIVE'
         AND start_at >= ? AND end_at > ?`
    )
    .run(
      actorUserId,
      stoppedAt,
      target.machineId,
      target.resourceGroupId,
      target.resourceGroupId,
      stoppedAt,
      stoppedAt
    ).changes;
  if (cancelled !== futureRows.length) {
    throw new BusinessError("维护安排已经更新，请刷新后重试", 409);
  }
  for (const row of futureRows) {
    addAudit(
      actorUserId,
      "UNAVAILABILITY_CANCEL_DISABLE",
      "resource_unavailability",
      row.id,
      {
        status: row.status,
        startAt: row.start_at,
        endAt: row.end_at
      },
      {
        status: "CANCELLED",
        startAt: row.start_at,
        endAt: row.end_at,
        cancelledAt: stoppedAt,
        disabledTargetType: target.type,
        disabledTargetId: target.id
      }
    );
  }
  return { interrupted, cancelled };
}

export function disableLongTerm(input: {
  type: UnavailabilityTargetType;
  id: string;
  expectedVersion: number;
  expectedRevision: number;
  actorUserId: string;
  reason?: string;
}) {
  const startAt = currentMinuteIso();
  const sourceId = randomUUID();
  return withImmediateTransaction(() => {
    if (getScheduleRevision() !== input.expectedRevision) {
      throw new BusinessError(
        "占用情况已变化，请重新查看影响",
        409,
        undefined,
        "UNAVAILABILITY_PREVIEW_STALE"
      );
    }
    const target = resolveUnavailabilityTarget(input.type, input.id);
    if (target.status !== "ACTIVE" || target.version !== input.expectedVersion) {
      throw new BusinessError("资源状态已经更新，请刷新后重试", 409);
    }
    const table =
      input.type === "MACHINE" ? "machines" : "resource_groups";
    const changed = db
      .prepare(
        `UPDATE ${table}
         SET status = 'DISABLED', disabled_at = ?, disabled_by = ?,
             disable_reason = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE' AND version = ?`
      )
      .run(
        startAt,
        input.actorUserId,
        input.reason?.trim() ?? "",
        startAt,
        input.id,
        input.expectedVersion
      );
    if (!changed.changes) {
      throw new BusinessError("资源状态已经更新，请刷新后重试", 409);
    }
    const maintenance = stopPlannedMaintenanceForDisable(
      target,
      startAt,
      input.actorUserId
    );
    db.prepare(
      `INSERT INTO resource_unavailability(
        id, machine_id, resource_group_id, kind, start_at, end_at,
        reason, created_by, created_at
      ) VALUES(?, ?, ?, 'LONG_TERM', ?, ?, ?, ?, ?)`
    ).run(
      sourceId,
      target.machineId,
      target.resourceGroupId,
      startAt,
      DISTANT_FUTURE,
      input.reason?.trim() ?? "",
      input.actorUserId,
      startAt
    );
    addAudit(
      input.actorUserId,
      "RESOURCE_DISABLE_WINDOW_CREATE",
      "resource_unavailability",
      sourceId,
      undefined,
      {
        targetType: target.type,
        targetId: target.id,
        machineId: target.machineId,
        resourceGroupId: target.resourceGroupId,
        startAt,
        endAt: DISTANT_FUTURE
      }
    );
    const impacts = reservationImpacts(target, startAt, DISTANT_FUTURE);
    applyReservationImpacts(
      impacts,
      input.actorUserId,
      sourceId,
      input.reason?.trim() ?? "",
      target.name,
      "DISABLE"
    );
    addAudit(
      input.actorUserId,
      input.type === "MACHINE"
        ? "MACHINE_DISABLE_LONG_TERM"
        : "RESOURCE_GROUP_DISABLE_LONG_TERM",
      input.type === "MACHINE" ? "machine" : "resource_group",
      input.id,
      { status: "ACTIVE" },
      {
        status: "DISABLED",
        reasonProvided: Boolean(input.reason?.trim()),
        maintenance,
        impact: previewSummary(impacts)
      }
    );
    return {
      status: "DISABLED" as const,
      revision: bumpScheduleRevision(),
      maintenance,
      impact: previewSummary(impacts)
    };
  });
}

export function enableTarget(input: {
  type: UnavailabilityTargetType;
  id: string;
  expectedVersion: number;
  actorUserId: string;
}) {
  return withImmediateTransaction(() => {
    const target = resolveUnavailabilityTarget(input.type, input.id);
    if (target.status !== "DISABLED" || target.version !== input.expectedVersion) {
      throw new BusinessError("资源状态已经更新，请刷新后重试", 409);
    }
    const table =
      input.type === "MACHINE" ? "machines" : "resource_groups";
    const changed = db
      .prepare(
        `UPDATE ${table}
         SET status = 'ACTIVE', disabled_at = NULL, disabled_by = NULL,
             disable_reason = '', version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'DISABLED' AND version = ?`
      )
      .run(nowIso(), input.id, input.expectedVersion);
    if (!changed.changes) {
      throw new BusinessError("资源状态已经更新，请刷新后重试", 409);
    }
    const openWindows = db
      .prepare(
        `SELECT id, start_at, end_at, status
         FROM resource_unavailability
         WHERE machine_id = ?
           AND (
             (? IS NULL AND resource_group_id IS NULL)
             OR resource_group_id = ?
           )
           AND kind = 'LONG_TERM' AND status = 'ACTIVE'
         ORDER BY start_at`
      )
      .all(
        target.machineId,
        target.resourceGroupId,
        target.resourceGroupId
      ) as Array<{
      id: string;
      start_at: string;
      end_at: string;
      status: string;
    }>;
    const currentMinute = currentMinuteIso();
    const cancelledAt = nowIso();
    for (const window of openWindows) {
      const cancelled = window.start_at >= currentMinute;
      const changed = cancelled
        ? db
            .prepare(
              `UPDATE resource_unavailability
               SET status = 'CANCELLED', cancelled_by = ?, cancelled_at = ?
               WHERE id = ? AND status = 'ACTIVE'`
            )
            .run(input.actorUserId, cancelledAt, window.id)
        : db
            .prepare(
              `UPDATE resource_unavailability
               SET end_at = ?
               WHERE id = ? AND status = 'ACTIVE' AND end_at > ?`
            )
            .run(currentMinute, window.id, currentMinute);
      if (!changed.changes) {
        throw new BusinessError("停用记录已经更新，请刷新后重试", 409);
      }
      addAudit(
        input.actorUserId,
        "RESOURCE_DISABLE_WINDOW_END",
        "resource_unavailability",
        window.id,
        {
          status: window.status,
          startAt: window.start_at,
          endAt: window.end_at
        },
        cancelled
          ? {
              status: "CANCELLED",
              startAt: window.start_at,
              endAt: window.end_at,
              cancelledAt
            }
          : {
              status: "ACTIVE",
              startAt: window.start_at,
              endAt: currentMinute
            }
      );
    }
    addAudit(
      input.actorUserId,
      input.type === "MACHINE"
        ? "MACHINE_ENABLE"
        : "RESOURCE_GROUP_ENABLE",
      input.type === "MACHINE" ? "machine" : "resource_group",
      input.id,
      { status: "DISABLED" },
      { status: "ACTIVE", endedDisableWindows: openWindows.length }
    );
    return { status: "ACTIVE" as const, revision: bumpScheduleRevision() };
  });
}
