import { checkEditVersion, overwriteRequested } from "../edit-conflict.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, canManageMachine } from "../auth.js";
import {
  nowIso,
  db,
  getMachineAccessRevision,
  withImmediateTransaction,
  addAudit,
  getScheduleRevision,
  bumpMachineAccessRevision,
  bumpScheduleRevision
} from "../db.js";
import { createNotification } from "../mailer.js";
import { BusinessError } from "../business-error.js";
import { grantMachineAccess, removeMachineMembership, parseAccessExpiry, expireMachineAccessRequests, expireMachineAccessRequestsInTransaction, trimMachineAccessReservations, accessExpiryDescription } from "../machine-access.js";
import { requireMachineViewer, requireMachineManager } from "./access-guards.js";

export function registerAccessAdminRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {
  const expiryBody = z.object({ expiresAt: z.string().nullable(), expectedVersion: z.number().int().min(1) });

  app.patch("/api/v1/admin/machine-access/requests/:id/expiry", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = expiryBody.parse(request.body);
    const result = withImmediateTransaction(() => {
      const row = db.prepare("SELECT * FROM machine_access_requests WHERE id=?").get(id) as Record<string, any> | undefined;
      if (!row || !canManageMachine(auth.user.id, auth.user.role, row.machine_id)) throw new BusinessError("无权处理这条申请", 403);
      if (row.status === "PENDING" && row.expires_at && row.expires_at <= nowIso()) {
        expireMachineAccessRequestsInTransaction();
        return null;
      }
      if (row.status !== "PENDING") throw new BusinessError("该申请已由其他管理员处理，审批列表已刷新", 409, undefined, "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED");
      checkEditVersion(row.version, body.expectedVersion, overwriteRequested(request));
      const expiresAt = parseAccessExpiry(body.expiresAt);
      if (row.previous_expires_at && expiresAt && Date.parse(expiresAt) <= Date.parse(row.previous_expires_at)) {
        throw new BusinessError("延期日期必须晚于当前到期日期", 400, undefined, "MACHINE_ACCESS_RENEWAL_INVALID");
      }
      db.prepare("UPDATE machine_access_requests SET expires_at=?,version=version+1,updated_at=? WHERE id=?").run(expiresAt, nowIso(), id);
      addAudit(auth.user.id, "MACHINE_ACCESS_REQUEST_EXPIRY", "machine_access_request", id, { expiresAt: row.expires_at }, { expiresAt });
      bumpMachineAccessRevision();
      bumpScheduleRevision();
      return { expiresAt, expectedVersion: row.version + 1 };
    });
    publishRevision(getScheduleRevision());
    if (!result) throw new BusinessError("申请使用期限已到，未完成审批", 409, undefined, "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED");
    return result;
  });

  app.patch("/api/v1/admin/machines/:id/members/:userId/expiry", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const body = expiryBody.parse(request.body);
    expireMachineAccessRequests();
    const result = withImmediateTransaction(() => {
      const row = db.prepare("SELECT * FROM machine_access_memberships WHERE machine_id=? AND user_id=?").get(auth.machineId, userId) as Record<string, any> | undefined;
      if (!row) throw new BusinessError("该用户没有这台机器的使用权", 404);
      if (db.prepare("SELECT 1 FROM machine_admins WHERE machine_id=? AND user_id=?").get(auth.machineId, userId)) {
        throw new BusinessError("机器管理员的有效期为长期有效，不允许修改", 403);
      }
      if (db.prepare("SELECT 1 FROM machine_access_requests WHERE machine_id=? AND user_id=? AND status='PENDING'").get(auth.machineId, userId)) {
        throw new BusinessError("该用户已有待审批申请，请直接处理申请", 409, undefined, "MACHINE_ACCESS_REQUEST_PENDING");
      }
      checkEditVersion(row.version, body.expectedVersion, overwriteRequested(request));
      const expiresAt = parseAccessExpiry(body.expiresAt);
      const impact = expiresAt && (!row.expires_at || expiresAt < row.expires_at)
        ? trimMachineAccessReservations(auth.machineId, userId, expiresAt, auth.user.id)
        : { cancelled: 0, truncated: 0 };
      db.prepare("UPDATE machine_access_memberships SET expires_at=?,version=version+1,updated_at=? WHERE machine_id=? AND user_id=?")
        .run(expiresAt, nowIso(), auth.machineId, userId);
      addAudit(auth.user.id, "MACHINE_MEMBER_EXPIRY", "machine", auth.machineId, { userId, expiresAt: row.expires_at }, { userId, expiresAt, ...impact });
      const machine = db.prepare("SELECT name FROM machines WHERE id=?").get(auth.machineId) as { name: string };
      createNotification(userId, "MACHINE_ACCESS_UPDATED", "机器使用权有效期已调整",
        `${machine.name} 到期时间：${accessExpiryDescription(expiresAt)}。取消 ${impact.cancelled} 条占用，截断 ${impact.truncated} 条占用。`, "/resources");
      bumpMachineAccessRevision();
      bumpScheduleRevision();
      return { expiresAt, expectedVersion: row.version + 1, impact };
    });
    publishRevision(getScheduleRevision());
    return result;
  });

  app.get("/api/v1/admin/machines/:id/access", async (request, reply) => {
    const auth = requireMachineViewer(request, reply);
    if (!auth) return;
    expireMachineAccessRequests();
    const now = nowIso();
    const members = db
      .prepare(
        `SELECT
           mam.user_id AS id, u.display_name, u.username,
           mam.source, mam.created_at, mam.expires_at, mam.version,
           CASE WHEN ma.user_id IS NULL THEN 0 ELSE 1 END AS is_manager,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number,
           (SELECT COUNT(*) FROM reservations r
            WHERE r.machine_id = mam.machine_id AND r.user_id = mam.user_id
              AND r.status = 'CONFIRMED' AND r.start_at <= ? AND r.end_at > ?) AS active_count,
           (SELECT COUNT(*) FROM reservations r
            WHERE r.machine_id = mam.machine_id AND r.user_id = mam.user_id
              AND r.status = 'CONFIRMED' AND r.start_at > ?) AS future_count
         FROM machine_access_memberships mam
         JOIN users u
           ON u.id = mam.user_id AND u.role = 'USER' AND u.status = 'ACTIVE'
         LEFT JOIN machine_admins ma
           ON ma.machine_id = mam.machine_id AND ma.user_id = mam.user_id
         WHERE mam.machine_id = ?
         ORDER BY is_manager DESC, u.display_name, u.username`
      )
      .all(now, now, now, auth.machineId) as Array<Record<string, unknown>>;
    const requests = auth.canManage ? db
      .prepare(
        `SELECT
           mar.id, mar.user_id, mar.reason, mar.status, mar.version,
           mar.created_at, mar.expires_at, mar.previous_expires_at, u.display_name, u.username,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number
         FROM machine_access_requests mar
         JOIN users u ON u.id = mar.user_id
         WHERE mar.machine_id = ? AND mar.status = 'PENDING'
         ORDER BY mar.created_at`
      )
      .all(auth.machineId) as Array<Record<string, unknown>> : [];
    return {
      ...(auth.canManage
        ? { accessRevision: getMachineAccessRevision() }
        : {}),
      members: members.map((row) => ({
        displayName: row.display_name,
        username: row.username,
        employeeNumber: row.employee_number,
        role: row.is_manager ? "MACHINE_ADMIN" : "MEMBER",
        grantedAt: row.created_at,
        expiresAt: row.expires_at,
        expired: Boolean(row.expires_at && String(row.expires_at) <= now),
        ...(auth.canManage
          ? {
            id: row.id,
            expectedVersion: row.version,
            source: row.source,
            impact: {
              activeReservations: Number(row.active_count),
              futureReservations: Number(row.future_count)
            }
          }
          : {})
      })),
      requests: requests.map((row) => ({
        id: row.id,
        userId: row.user_id,
        displayName: row.display_name,
        username: row.username,
        employeeNumber: row.employee_number,
        reason: row.reason,
        status: row.status,
        expectedVersion: row.version,
        expiresAt: row.expires_at,
        previousExpiresAt: row.previous_expires_at,
        createdAt: row.created_at
      }))
    };
  });

  app.get("/api/v1/admin/machines/:id/member-candidates", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    expireMachineAccessRequests();
    const { q } = z
      .object({ q: z.string().trim().max(100).optional().default("") })
      .parse(request.query);
    const pattern = `%${q.replace(/[%_]/g, "\\$&")}%`;
    const rows = db
      .prepare(
        `SELECT
           u.id, u.display_name, u.username,
           (SELECT en.employee_number FROM employee_numbers en
            WHERE en.user_id = u.id AND en.status = 'ACTIVE'
            LIMIT 1) AS employee_number
         FROM users u
         WHERE u.role = 'USER' AND u.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM machine_access_memberships mam
             WHERE mam.machine_id = ? AND mam.user_id = u.id
               AND (mam.expires_at IS NULL OR mam.expires_at > ?)
           )
           AND NOT EXISTS (
             SELECT 1 FROM machine_access_requests mar
             WHERE mar.machine_id = ? AND mar.user_id = u.id AND mar.status = 'PENDING'
           )
           AND (
             ? = '' OR u.display_name LIKE ? ESCAPE '\\'
             OR u.username LIKE ? ESCAPE '\\'
             OR EXISTS (
               SELECT 1 FROM employee_numbers en
               WHERE en.user_id = u.id AND en.status = 'ACTIVE'
                 AND en.employee_number LIKE ? ESCAPE '\\'
             )
           )
         ORDER BY u.display_name, u.username LIMIT 30`
      )
      .all(auth.machineId, nowIso(), auth.machineId, q, pattern, pattern, pattern) as Array<
        Record<string, unknown>
      >;
    return {
      users: rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        username: row.username,
        employeeNumber: row.employee_number
      }))
    };
  });

  app.post("/api/v1/admin/machines/:id/members", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const { userId, expiresAt: requestedExpiry } = z.object({ userId: z.string().uuid(), expiresAt: z.string().nullable().optional() }).parse(request.body);
    expireMachineAccessRequests();
    let expiresAt: string | null = null;
    let invitedUser: { display_name: string } | undefined;
    withImmediateTransaction(() => {
      expiresAt = parseAccessExpiry(requestedExpiry);
      invitedUser = db
        .prepare(
          "SELECT display_name FROM users WHERE id = ? AND role = 'USER' AND status = 'ACTIVE'"
        )
        .get(userId) as { display_name: string } | undefined;
      if (!invitedUser) throw new BusinessError("只能邀请已启用用户", 400);
      const pending = db
        .prepare(
          `SELECT 1 FROM machine_access_requests
           WHERE machine_id = ? AND user_id = ? AND status = 'PENDING'`
        )
        .get(auth.machineId, userId);
      if (pending) {
        throw new BusinessError(
          "该用户已有待审批申请，请直接处理申请",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_PENDING"
        );
      }
      const existing = db
        .prepare(
          "SELECT 1 FROM machine_access_memberships WHERE machine_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)"
        )
        .get(auth.machineId, userId, nowIso());
      if (existing) {
        throw new BusinessError(
          "该用户已经获得使用权，成员列表已刷新",
          409,
          undefined,
          "MACHINE_MEMBER_ALREADY_EXISTS"
        );
      }
      grantMachineAccess(auth.machineId, userId, "ADMIN_INVITE", auth.user.id, expiresAt);
      addAudit(
        auth.user.id,
        "MACHINE_MEMBER_INVITE",
        "machine",
        auth.machineId,
        undefined,
        { userId, expiresAt }
      );
    });
    const machine = db
      .prepare("SELECT name FROM machines WHERE id = ?")
      .get(auth.machineId) as { name: string };
    createNotification(
      userId,
      "MACHINE_ACCESS_GRANTED",
      "已获得机器使用权",
      `管理员已将你加入 ${machine.name}，现在可以查看资源并登记占用。到期时间：${accessExpiryDescription(expiresAt)}。`,
      "/calendar"
    );
    publishRevision(getScheduleRevision());
    return reply.code(201).send({ message: `${invitedUser!.display_name} 已加入机器` });
  });

  app.post("/api/v1/admin/machine-access/requests/:id/approve", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .parse(request.body);
    let approved:
      | { userId: string; machineId: string; machineName: string; expiresAt: string | null; renewal: boolean }
      | undefined;
    withImmediateTransaction(() => {
      const row = db
        .prepare(
          `SELECT mar.*, m.name AS machine_name, u.status AS user_status
           FROM machine_access_requests mar
           JOIN machines m ON m.id = mar.machine_id
           JOIN users u ON u.id = mar.user_id
           WHERE mar.id = ?`
        )
        .get(id) as Record<string, any> | undefined;
      if (!row || !canManageMachine(auth.user.id, auth.user.role, row.machine_id)) {
        throw new BusinessError("无权处理这条申请", 403);
      }
      if (row.status === "PENDING" && row.expires_at && row.expires_at <= nowIso()) {
        expireMachineAccessRequestsInTransaction();
        return;
      }
      if (row.status !== "PENDING") {
        throw new BusinessError(
          "该申请已由其他管理员处理，审批列表已刷新",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
        );
      }
      checkEditVersion(row.version, expectedVersion, overwriteRequested(request));
      if (row.user_status !== "ACTIVE") {
        throw new BusinessError("申请人的账号当前不可用", 409);
      }
      const existing = db
        .prepare(
          "SELECT expires_at FROM machine_access_memberships WHERE machine_id = ? AND user_id = ?"
        )
        .get(row.machine_id, row.user_id) as { expires_at: string | null } | undefined;
      const renewal = Boolean(row.previous_expires_at);
      if (!renewal && existing && (!existing.expires_at || existing.expires_at > nowIso())) {
        throw new BusinessError(
          "该用户已经获得使用权，成员列表已刷新",
          409,
          undefined,
          "MACHINE_MEMBER_ALREADY_EXISTS"
        );
      }
      if (renewal && !existing) throw new BusinessError("使用权已被移除，请重新申请", 409);
      const effectiveExpiry = existing && !existing.expires_at ? null
        : !row.expires_at ? null
        : existing?.expires_at && Date.parse(existing.expires_at) > Date.parse(row.expires_at) ? existing.expires_at : row.expires_at;
      const now = nowIso();
      grantMachineAccess(row.machine_id, row.user_id, "APPLICATION", auth.user.id, effectiveExpiry);
      const changed = db
        .prepare(
          `UPDATE machine_access_requests SET
             status = 'APPROVED', version = version + 1,
             reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING' AND version = ?`
        )
        .run(auth.user.id, now, now, id, row.version);
      if (!changed.changes) {
        throw new BusinessError(
          "该申请已由其他管理员处理，审批列表已刷新",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
        );
      }
      addAudit(
        auth.user.id,
        "MACHINE_ACCESS_REQUEST_APPROVE",
        "machine_access_request",
        id,
        undefined,
        { userId: row.user_id, machineId: row.machine_id, expiresAt: effectiveExpiry, previousExpiresAt: row.previous_expires_at }
      );
      approved = {
        userId: row.user_id,
        machineId: row.machine_id,
        machineName: row.machine_name,
        expiresAt: effectiveExpiry,
        renewal
      };
    });
    if (!approved) {
      publishRevision(getScheduleRevision());
      throw new BusinessError("申请使用期限已到，未完成审批", 409, undefined, "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED");
    }
    createNotification(
      approved!.userId,
      "MACHINE_ACCESS_GRANTED",
      approved.renewal ? "机器使用权延期已通过" : "机器使用权申请已通过",
      `你现在可以使用 ${approved!.machineName}。到期时间：${accessExpiryDescription(approved!.expiresAt)}。`,
      "/calendar"
    );
    publishRevision(getScheduleRevision());
    return { message: "使用权申请已通过" };
  });

  app.post("/api/v1/admin/machine-access/requests/:id/reject", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    expireMachineAccessRequests();
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        expectedVersion: z.number().int().min(1),
        reason: z.string().trim().max(500).optional().default("")
      })
      .parse(request.body);
    let rejected: { userId: string; machineName: string } | undefined;
    withImmediateTransaction(() => {
      const row = db
        .prepare(
          `SELECT mar.*, m.name AS machine_name
           FROM machine_access_requests mar
           JOIN machines m ON m.id = mar.machine_id
           WHERE mar.id = ?`
        )
        .get(id) as Record<string, any> | undefined;
      if (!row || !canManageMachine(auth.user.id, auth.user.role, row.machine_id)) {
        throw new BusinessError("无权处理这条申请", 403);
      }
      if (row.status === "PENDING" && row.expires_at && row.expires_at <= nowIso()) {
        expireMachineAccessRequestsInTransaction();
        return;
      }
      if (row.status !== "PENDING") throw new BusinessError("该申请已由其他管理员处理，审批列表已刷新", 409, undefined, "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED");
      checkEditVersion(row.version, body.expectedVersion, overwriteRequested(request));
      const now = nowIso();
      const changed = db
        .prepare(
          `UPDATE machine_access_requests SET
             status = 'REJECTED', version = version + 1, review_reason = ?,
             reviewed_by = ?, reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'PENDING' AND version = ?`
        )
        .run(body.reason, auth.user.id, now, now, id, row.version);
      if (!changed.changes) {
        throw new BusinessError(
          "该申请已由其他管理员处理，审批列表已刷新",
          409,
          undefined,
          "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED"
        );
      }
      addAudit(
        auth.user.id,
        "MACHINE_ACCESS_REQUEST_REJECT",
        "machine_access_request",
        id,
        undefined,
        { reasonProvided: Boolean(body.reason) }
      );
      bumpMachineAccessRevision();
      bumpScheduleRevision();
      rejected = { userId: row.user_id, machineName: row.machine_name };
    });
    if (!rejected) {
      publishRevision(getScheduleRevision());
      throw new BusinessError("申请使用期限已到，未完成审批", 409, undefined, "MACHINE_ACCESS_REQUEST_ALREADY_PROCESSED");
    }
    createNotification(
      rejected.userId,
      "MACHINE_ACCESS_REJECTED",
      "机器使用权申请未通过",
      body.reason
        ? `${rejected!.machineName}：${body.reason}`
        : "机器使用权申请未通过。",
      "/resources"
    );
    publishRevision(getScheduleRevision());
    return { message: "使用权申请已拒绝" };
  });

  app.delete("/api/v1/admin/machines/:id/members/:userId", async (request, reply) => {
    const auth = requireMachineManager(request, reply);
    if (!auth) return;
    const { userId } = z
      .object({ id: z.string().uuid(), userId: z.string().uuid() })
      .parse(request.params);
    const target = db
      .prepare(
        `SELECT u.display_name,
           CASE WHEN ma.user_id IS NULL THEN 0 ELSE 1 END AS is_manager
         FROM machine_access_memberships mam
         JOIN users u ON u.id = mam.user_id
         LEFT JOIN machine_admins ma
           ON ma.machine_id = mam.machine_id AND ma.user_id = mam.user_id
         WHERE mam.machine_id = ? AND mam.user_id = ?`
      )
      .get(auth.machineId, userId) as
      | { display_name: string; is_manager: number }
      | undefined;
    if (!target) return reply.code(404).send({ error: "该用户没有这台机器的使用权" });
    if (target.is_manager && auth.user.role !== "SYSTEM_ADMIN") {
      return reply.code(403).send({ error: "只有系统管理员可以移除机器管理员" });
    }
    let impact!: ReturnType<typeof removeMachineMembership>;
    withImmediateTransaction(() => {
      impact = removeMachineMembership(
        auth.machineId,
        userId,
        auth.user.id,
        "机器管理员移除使用权"
      );
    });
    const machine = db
      .prepare("SELECT name FROM machines WHERE id = ?")
      .get(auth.machineId) as { name: string };
    createNotification(
      userId,
      "MACHINE_ACCESS_REMOVED",
      "机器使用权已被移除",
      `你已被移出 ${machine.name}，相关当前占用和未来占用已经释放。`,
      "/reservations"
    );
    publishRevision(getScheduleRevision());
    return {
      message: `${target.display_name} 已被移出机器`,
      impact: {
        activeReservations: impact.activeReservations,
        futureReservations: impact.futureReservations
      }
    };
  });
}
