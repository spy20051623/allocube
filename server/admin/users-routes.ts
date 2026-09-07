import { checkEditVersion, overwriteRequested } from "../edit-conflict.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, requireSystemAdmin, createAuthToken } from "../auth.js";
import {
  db,
  withImmediateTransaction,
  nowIso,
  addAudit,
  checkpointSensitiveDeletion,
  getScheduleRevision,
  currentMinuteIso,
  bumpMachineAccessRevision,
  bumpScheduleRevision,
  getPublicSiteOrigin
} from "../db.js";
import { createNotification, queueEmail, escapeHtml } from "../mailer.js";
import {
  IdentityError,
  ensureUsernameAvailable,
  ensureEmailAvailable,
  ensureEmployeeNumberAvailable,
  deleteUnapprovedUser
} from "../identity.js";
import { BusinessError } from "../business-error.js";
import { revokeApiTokensForUser } from "../api-tokens.js";
import { buildPasswordResetUrl } from "../security-urls.js";
import {
  getManageableUser,
  mapManageableUser,
  userDisableImpact,
  userDeleteImpact,
  deleteUserRecords
} from "./user-service.js";
import { longDisableSchema, versionSchema } from "./unavailability-schema.js";

export function registerUsersAdminRoutes(app: FastifyInstance, publishRevision: (revision: number) => void) {

  app.get("/api/v1/users/directory", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
           u.username,
           u.display_name,
           u.status,
           (SELECT en.employee_number
              FROM employee_numbers en
             WHERE en.user_id = u.id AND en.status = 'ACTIVE'
             LIMIT 1) AS employee_number
         FROM users u
         WHERE u.status IN ('ACTIVE', 'DISABLED')
           AND NOT EXISTS (
             SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
           )
         ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE`
      )
      .all() as Array<{
        username: string;
        display_name: string;
        status: "ACTIVE" | "DISABLED";
        employee_number: string | null;
      }>;
    return {
      users: rows.map((row) => ({
        username: row.username,
        displayName: row.display_name,
        employeeNumber: row.employee_number,
        status: row.status
      }))
    };
  });

  app.get("/api/v1/admin/users", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT
          u.id, u.username, u.email, u.display_name, u.role, u.status,
          u.version, u.disabled_at, u.disable_reason,
          u.password_change_recommended, u.application_revision,
          u.approved_at, u.created_at, u.updated_at, u.last_login_at,
          (SELECT MAX(rr.submitted_at) FROM registration_revisions rr
           WHERE rr.user_id = u.id) AS last_submitted_at,
          (SELECT en.employee_number FROM employee_numbers en
           WHERE en.user_id = u.id AND en.status = 'ACTIVE'
           LIMIT 1) AS employee_number,
          (SELECT er.employee_number FROM pending_registration_employee_numbers er
           WHERE er.user_id = u.id
           LIMIT 1) AS pending_employee_number,
          (SELECT pcr.id FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS profile_change_id,
          (SELECT pcr.requested_display_name FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS requested_display_name,
          (SELECT pcr.requested_employee_number FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS requested_employee_number,
          (SELECT pcr.requested_at FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS profile_change_requested_at,
          (SELECT pcr.version FROM profile_change_requests pcr
           WHERE pcr.user_id = u.id AND pcr.status = 'PENDING'
           LIMIT 1) AS profile_change_version,
          GROUP_CONCAT(m.name, '、') AS managed_machines
         FROM users u
         LEFT JOIN machine_admins ma ON ma.user_id = u.id
         LEFT JOIN machines m ON m.id = ma.machine_id
         WHERE NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )
         GROUP BY u.id
         ORDER BY
           CASE u.status WHEN 'PENDING_APPROVAL' THEN 0
             WHEN 'CHANGES_REQUESTED' THEN 1 ELSE 2 END,
           u.created_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return {
      users: rows.map((row) => ({
        id: row.id,
        username: row.username,
        email: row.email,
        displayName: row.display_name,
        role: row.role,
        status: row.status,
        version: row.version,
        disabledAt: row.disabled_at,
        disableReason: row.disable_reason,
        passwordChangeRecommended: Boolean(row.password_change_recommended),
        applicationRevision: row.application_revision,
        employeeNumber: row.employee_number,
        pendingEmployeeNumber: row.pending_employee_number,
        pendingProfileChange: row.profile_change_id
          ? {
            id: row.profile_change_id,
            displayName: row.requested_display_name,
            employeeNumber: row.requested_employee_number,
            requestedAt: row.profile_change_requested_at,
            expectedVersion: row.profile_change_version
          }
          : null,
        approvedAt: row.approved_at,
        lastSubmittedAt: row.last_submitted_at,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        managedMachines: row.managed_machines ? String(row.managed_machines).split("、") : []
      }))
    };
  });

  app.post("/api/v1/admin/users/:id/approve", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedRevision } = z
      .object({ expectedRevision: z.number().int().min(1) })
      .parse(request.body);
    withImmediateTransaction(() => {
      const user = db
        .prepare(
          `SELECT status, application_revision, username_normalized, email FROM users
           WHERE id = ?`
        )
        .get(id) as
        | {
          status: string;
          application_revision: number;
          username_normalized: string;
          email: string | null;
        }
        | undefined;
      if (
        !user ||
        user.status !== "PENDING_APPROVAL"
      ) {
        throw new IdentityError("注册信息已被更新，请刷新后重试", 409);
      }
      checkEditVersion(user.application_revision, expectedRevision, overwriteRequested(request));
      ensureUsernameAvailable(user.username_normalized, id);
      if (user.email) ensureEmailAvailable(user.email, id);
      const employeeRequest = db
        .prepare(
          `SELECT user_id AS id, employee_number
           FROM pending_registration_employee_numbers
           WHERE user_id = ?`
        )
        .get(id) as { id: string; employee_number: string } | undefined;
      if (!employeeRequest) throw new IdentityError("待审核的工号不存在", 409);
      ensureEmployeeNumberAvailable(employeeRequest.employee_number, employeeRequest.id);
      const now = nowIso();
      db.prepare(
        `INSERT INTO employee_numbers(
          id, user_id, employee_number, status, assigned_by, assigned_at, updated_at
        ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
      ).run(randomUUID(), id, employeeRequest.employee_number, auth.user.id, now, now);
      db.prepare(
        "DELETE FROM pending_registration_employee_numbers WHERE user_id = ?"
      ).run(id);
      db.prepare(
        `UPDATE users SET status = 'ACTIVE', approved_at = ?, approved_by = ?,
          version = version + 1, updated_at = ? WHERE id = ?`
      ).run(now, auth.user.id, now, id);
    });
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "账号审核已通过",
      "你现在可以使用用户名或有效工号登录并占用机器资源。",
      "/"
    );
    addAudit(auth.user.id, "USER_APPROVE", "user", id, undefined, { expectedRevision });
    return { message: "账号已批准" };
  });

  app.post(
    "/api/v1/admin/profile-change-requests/:id/approve",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { expectedVersion } = z
        .object({ expectedVersion: z.number().int().min(1) })
        .parse(request.body);
      let result:
        | {
          userId: string;
          displayName: string;
          employeeNumber: string;
          displayNameChanged: boolean;
          employeeNumberChanged: boolean;
        }
        | undefined;
      try {
        result = withImmediateTransaction(() => {
          const row = db
            .prepare(
              `SELECT pcr.user_id, pcr.status, pcr.version,
                pcr.requested_display_name, pcr.requested_employee_number,
                u.status AS user_status, u.display_name AS current_display_name,
                en.id AS current_employee_id,
                en.employee_number AS current_employee_number
               FROM profile_change_requests pcr
               JOIN users u ON u.id = pcr.user_id
               JOIN employee_numbers en
                 ON en.user_id = pcr.user_id AND en.status = 'ACTIVE'
               WHERE pcr.id = ?`
            )
            .get(id) as
            | {
              user_id: string;
              status: string;
              version: number;
              requested_display_name: string;
              requested_employee_number: string;
              user_status: string;
              current_display_name: string;
              current_employee_id: string;
              current_employee_number: string;
            }
            | undefined;
          if (
            !row ||
            row.status !== "PENDING" ||
            row.user_status !== "ACTIVE"
          ) {
            throw new IdentityError(
              "该资料修改已被处理，请刷新后重试",
              409
            );
          }
          checkEditVersion(row.version, expectedVersion, overwriteRequested(request));
          const now = nowIso();
          if (row.requested_employee_number !== row.current_employee_number) {
            ensureEmployeeNumberAvailable(
              row.requested_employee_number,
              undefined,
              id
            );
            db.prepare(
              `UPDATE employee_numbers
               SET status = 'INACTIVE', updated_at = ?
               WHERE id = ?`
            ).run(now, row.current_employee_id);
            db.prepare(
              `INSERT INTO employee_numbers(
                id, user_id, employee_number, status,
                assigned_by, assigned_at, updated_at
              ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
            ).run(
              randomUUID(),
              row.user_id,
              row.requested_employee_number,
              auth.user.id,
              now,
              now
            );
          }
          db.prepare(
            `UPDATE users SET display_name = ?,
              version = version + 1, updated_at = ? WHERE id = ?`
          ).run(row.requested_display_name, now, row.user_id);
          db.prepare(
            `UPDATE profile_change_requests
             SET status = 'APPROVED', version = version + 1,
               reviewed_by = ?, reviewed_at = ?, updated_at = ?
             WHERE id = ?`
          ).run(auth.user.id, now, now, id);
          return {
            userId: row.user_id,
            displayName: row.requested_display_name,
            employeeNumber: row.requested_employee_number,
            displayNameChanged:
              row.requested_display_name !== row.current_display_name,
            employeeNumberChanged:
              row.requested_employee_number !== row.current_employee_number
          };
        });
      } catch (error) {
        if (error instanceof IdentityError && error.statusCode === 409) {
          return reply.code(409).send({
            error: error.message,
            code: "PROFILE_CHANGE_ALREADY_PROCESSED"
          });
        }
        throw error;
      }
      createNotification(
        result.userId,
        "PROFILE_CHANGE_APPROVED",
        "资料修改已通过",
        `当前姓名为 ${result.displayName}，工号为 ${result.employeeNumber}。`,
        "/profile"
      );
      addAudit(
        auth.user.id,
        "PROFILE_CHANGE_APPROVE",
        "profile_change_request",
        id,
        undefined,
        {
          displayNameChanged: result.displayNameChanged,
          employeeNumberChanged: result.employeeNumberChanged,
          expectedVersion
        }
      );
      return { message: "资料修改已通过" };
    }
  );

  app.post(
    "/api/v1/admin/profile-change-requests/:id/reject",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          expectedVersion: z.number().int().min(1),
          reason: z.string().trim().max(500).optional().default("")
        })
        .parse(request.body);
      let userId = "";
      try {
        userId = withImmediateTransaction(() => {
          const row = db
            .prepare(
              `SELECT user_id, status, version
               FROM profile_change_requests WHERE id = ?`
            )
            .get(id) as
            | { user_id: string; status: string; version: number }
            | undefined;
          if (
            !row ||
            row.status !== "PENDING"
          ) {
            throw new IdentityError(
              "该资料修改已被处理，请刷新后重试",
              409
            );
          }
          checkEditVersion(row.version, body.expectedVersion, overwriteRequested(request));
          const now = nowIso();
          db.prepare(
            `UPDATE profile_change_requests
             SET status = 'REJECTED', version = version + 1,
               reviewed_by = ?, review_reason = ?, reviewed_at = ?, updated_at = ?
             WHERE id = ?`
          ).run(auth.user.id, body.reason, now, now, id);
          return row.user_id;
        });
      } catch (error) {
        if (error instanceof IdentityError && error.statusCode === 409) {
          return reply.code(409).send({
            error: error.message,
            code: "PROFILE_CHANGE_ALREADY_PROCESSED"
          });
        }
        throw error;
      }
      createNotification(
        userId,
        "PROFILE_CHANGE_REJECTED",
        "资料修改未通过",
        body.reason || "资料修改未通过。",
        "/profile"
      );
      addAudit(
        auth.user.id,
        "PROFILE_CHANGE_REJECT",
        "profile_change_request",
        id,
        undefined,
        {
          expectedVersion: body.expectedVersion,
          reasonProvided: Boolean(body.reason)
        }
      );
      return { message: "资料修改已拒绝" };
    }
  );

  app.post("/api/v1/admin/users/:id/return", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().min(1),
        reason: z.string().trim().max(500).optional().default("")
      })
      .parse(request.body);
    const result = withImmediateTransaction(() => {
      const current = db.prepare("SELECT status, application_revision FROM users WHERE id = ?").get(id) as { status: string; application_revision: number } | undefined;
      if (!current || current.status !== "PENDING_APPROVAL") throw new BusinessError("注册信息已被更新，请刷新后重试", 409);
      checkEditVersion(current.application_revision, body.expectedRevision, overwriteRequested(request));
      return db
        .prepare(
          `UPDATE users SET status = 'CHANGES_REQUESTED',
         version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'PENDING_APPROVAL' AND application_revision = ?`
        )
        .run(nowIso(), id, current.application_revision);
    });
    if (!result.changes) {
      return reply.code(409).send({ error: "注册信息已被更新，请刷新后重试" });
    }
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "注册资料需要修改",
      body.reason || "管理员请你更新注册资料。",
      "/",
      { emailPolicy: "ACCOUNT_BLOCKING" }
    );
    addAudit(auth.user.id, "USER_RETURN", "user", id, undefined, {
      expectedRevision: body.expectedRevision,
      reasonProvided: Boolean(body.reason)
    });
    return { message: "已要求用户修改注册信息" };
  });

  app.post("/api/v1/admin/users/:id/reject", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        expectedRevision: z.number().int().min(1),
        reason: z.string().trim().max(500).optional().default("")
      })
      .parse(request.body);
    const user = withImmediateTransaction(() => {
      const current = db.prepare("SELECT email, status, application_revision FROM users WHERE id = ?").get(id) as { email: string | null; status: string; application_revision: number } | undefined;
      if (!current || !["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(current.status)) throw new BusinessError("注册信息已被更新，请刷新后重试", 409);
      checkEditVersion(current.application_revision, body.expectedRevision, overwriteRequested(request));
      deleteUnapprovedUser(id, "ADMIN_REJECTED", auth.user.id, current.application_revision, true);
      return current;
    });
    checkpointSensitiveDeletion();
    if (user.email) {
      queueEmail(
        user.email,
        "注册审核未通过 / Registration not approved",
        `<p>${escapeHtml(body.reason || "注册审核未通过。")}</p><hr /><p>Your Allocube registration was not approved. Contact an administrator for details.</p>`
      );
    }
    addAudit(auth.user.id, "USER_REJECT", "registration_tombstone", id, undefined, {
      expectedRevision: body.expectedRevision,
      reasonProvided: Boolean(body.reason)
    });
    return { message: "注册已拒绝，用户名、邮箱和工号已释放" };
  });

  app.post(
    "/api/v1/admin/users/:id/disable/preview",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = getManageableUser(id);
      if (!user) return reply.code(404).send({ error: "用户不存在" });
      if (user.role === "SYSTEM_ADMIN") {
        return reply.code(400).send({ error: "系统管理员账号不能停用" });
      }
      if (user.status !== "ACTIVE") {
        return reply.code(409).send({ error: "该账号当前不是启用状态" });
      }
      return {
        user: mapManageableUser(user),
        counts: userDisableImpact(id),
        revision: getScheduleRevision()
      };
    }
  );

  app.post("/api/v1/admin/users/:id/disable", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = longDisableSchema.parse(request.body);
    let result:
      | {
        version: number;
        revision: number;
        counts: ReturnType<typeof userDisableImpact>;
      }
      | undefined;
    result = withImmediateTransaction(() => {
      if (!overwriteRequested(request) && getScheduleRevision() !== body.expectedRevision) {
        throw new BusinessError(
          "占用情况已变化，请重新查看影响",
          409,
          undefined,
          "USER_DISABLE_PREVIEW_STALE"
        );
      }
      const user = getManageableUser(id);
      if (!user) throw new BusinessError("用户不存在", 404);
      if (user.role === "SYSTEM_ADMIN") {
        throw new BusinessError("系统管理员账号不能停用", 400);
      }
      checkEditVersion(user.version, body.expectedVersion, overwriteRequested(request));
      if (user.status !== "ACTIVE") {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      const now = nowIso();
      const counts = userDisableImpact(id, now);
      const changed = db
        .prepare(
          `UPDATE users
           SET status = 'DISABLED', version = version + 1,
             disabled_at = ?, disabled_by = ?, disable_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'ACTIVE' AND version = ?
             AND NOT EXISTS (
               SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = users.id
             )`
        )
        .run(
          now,
          auth.user.id,
          body.reason,
          now,
          id,
          user.version
        );
      if (!changed.changes) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      revokeApiTokensForUser(id, "账号已停用", now);
      db.prepare(
        `UPDATE profile_change_requests
         SET status = 'CANCELLED', version = version + 1,
           review_reason = '账号已停用', reviewed_by = ?,
           reviewed_at = ?, updated_at = ?
         WHERE user_id = ? AND status = 'PENDING'`
      ).run(auth.user.id, now, now, id);
      const currentMinute = currentMinuteIso();
      const justStartedReservations = db
        .prepare(
          `SELECT id, batch_id, machine_id, resource_group_id, scope, start_at
           FROM reservations
           WHERE user_id = ? AND status = 'CONFIRMED'
             AND start_at >= ? AND start_at <= ? AND end_at > ?`
        )
        .all(id, currentMinute, now, now) as Array<{
          id: string;
          batch_id: string;
          machine_id: string;
          resource_group_id: string;
          scope: string;
          start_at: string;
        }>;
      for (const reservation of justStartedReservations) {
        addAudit(
          auth.user.id,
          "RESERVATION_WITHDRAW_FIRST_MINUTE",
          "reservation",
          reservation.id,
          null,
          {
            machineId: reservation.machine_id,
            resourceGroupId: reservation.resource_group_id,
            scope: reservation.scope,
            startedAt: reservation.start_at,
            removedWithinFirstMinute: true,
            source: "USER_DISABLED"
          }
        );
        db.prepare("DELETE FROM reservations WHERE id = ?").run(reservation.id);
        db.prepare(
          `DELETE FROM reservation_batches
           WHERE id = ? AND NOT EXISTS (
             SELECT 1 FROM reservations WHERE batch_id = ?
           )`
        ).run(reservation.batch_id, reservation.batch_id);
      }
      db.prepare(
        `UPDATE reservations SET end_at = ?, updated_at = ?
         WHERE user_id = ? AND status = 'CONFIRMED'
           AND start_at < ? AND end_at > ?`
      ).run(currentMinute, now, id, currentMinute, now);
      db.prepare(
        `UPDATE reservations SET status = 'CANCELLED', cancelled_at = ?,
          cancelled_by = ?, cancellation_reason = '账号停用释放资源', updated_at = ?
         WHERE user_id = ? AND status = 'CONFIRMED' AND start_at > ?`
      ).run(now, auth.user.id, now, id, now);
      addAudit(auth.user.id, "USER_STATUS_CHANGE", "user", id, {
        status: "ACTIVE"
      }, {
        status: "DISABLED",
        reasonProvided: Boolean(body.reason),
        impact: counts
      });
      bumpMachineAccessRevision();
      return {
        version: user.version + 1,
        revision: bumpScheduleRevision(),
        counts
      };
    });
    publishRevision(result.revision);
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "账号已停用",
      body.reason || "账号已停用，当前和未来占用已经释放。",
      "/",
      { emailPolicy: "ACCOUNT_BLOCKING" }
    );
    return { status: "DISABLED", ...result };
  });

  app.post("/api/v1/admin/users/:id/enable", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = versionSchema.parse(request.body);
    let result: { version: number; revision: number } | undefined;
    result = withImmediateTransaction(() => {
      const user = getManageableUser(id);
      if (!user) throw new BusinessError("用户不存在", 404);
      if (user.role === "SYSTEM_ADMIN") {
        throw new BusinessError("系统管理员账号不能重新启用", 400);
      }
      checkEditVersion(user.version, expectedVersion, overwriteRequested(request));
      if (user.status !== "DISABLED") {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      const now = nowIso();
      const changed = db
        .prepare(
          `UPDATE users
           SET status = 'ACTIVE', version = version + 1,
             disabled_at = NULL, disabled_by = NULL,
             disable_reason = '', updated_at = ?
           WHERE id = ? AND status = 'DISABLED' AND version = ?
             AND NOT EXISTS (
               SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = users.id
             )`
        )
        .run(now, id, user.version);
      if (!changed.changes) {
        throw new BusinessError("用户信息已更新，请刷新后重试", 409);
      }
      addAudit(auth.user.id, "USER_STATUS_CHANGE", "user", id, {
        status: "DISABLED"
      }, {
        status: "ACTIVE",
        reservationsRestored: false
      });
      bumpMachineAccessRevision();
      return {
        version: user.version + 1,
        revision: bumpScheduleRevision()
      };
    });
    publishRevision(result.revision);
    createNotification(
      id,
      "ACCOUNT_STATUS",
      "账号已重新启用",
      "你现在可以重新登录并使用系统，之前取消的占用不会恢复。",
      "/"
    );
    return { status: "ACTIVE", ...result };
  });

  app.get(
    "/api/v1/admin/users/:id/deletion-impact",
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = getManageableUser(id);
      if (!user) return reply.code(404).send({ error: "用户不存在" });
      if (user.role === "SYSTEM_ADMIN") {
        return reply.code(400).send({ error: "系统管理员账号不能删除" });
      }
      return {
        user: mapManageableUser(user),
        counts: userDeleteImpact(id)
      };
    }
  );

  app.delete("/api/v1/admin/users/:id", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = versionSchema.parse(request.body);
    if (id === auth.user.id) {
      return reply.code(400).send({ error: "不能删除当前登录的系统管理员" });
    }
    let revision = getScheduleRevision();
    withImmediateTransaction(() => {
      const user = getManageableUser(id);
      if (!user) throw new BusinessError("用户不存在", 404);
      if (user.role === "SYSTEM_ADMIN") {
        throw new BusinessError("系统管理员账号不能删除", 400);
      }
      if (user.status !== "DISABLED") {
        throw new BusinessError("请先停用账号，再进行删除", 409);
      }
      checkEditVersion(user.version, expectedVersion, overwriteRequested(request));
      const counts = userDeleteImpact(id);
      deleteUserRecords(id, auth.user.id, counts);
      addAudit(auth.user.id, "USER_DELETE", "user", id, undefined, {
        displayName: "用户已删除",
        counts
      });
      bumpMachineAccessRevision();
      revision = bumpScheduleRevision();
    });
    checkpointSensitiveDeletion();
    publishRevision(revision);
    return { deleted: true };
  });

  app.post(
    "/api/v1/admin/users/:id/password-reset-link",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const auth = requireSystemAdmin(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const user = db
        .prepare(
          `SELECT u.id FROM users u
         WHERE u.id = ? AND u.role = 'USER' AND u.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
           )`
        )
        .get(id);
      if (!user) {
        return reply.code(404).send({ error: "已启用的普通用户不存在" });
      }
      const siteOrigin = getPublicSiteOrigin();
      if (!siteOrigin) {
        return reply.code(409).send({
          error: "请先在系统设置中配置站点地址",
          code: "PUBLIC_SITE_ORIGIN_REQUIRED"
        });
      }
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      const token = withImmediateTransaction(() => {
        const latestUser = db
          .prepare(
            `SELECT 1 FROM users u
           WHERE u.id = ? AND u.role = 'USER' AND u.status = 'ACTIVE'
             AND NOT EXISTS (
               SELECT 1 FROM deleted_user_tombstones dut
               WHERE dut.user_id = u.id
             )`
          )
          .get(id);
        if (!latestUser) {
          throw new BusinessError("已启用的普通用户不存在", 404);
        }
        db.prepare(
          `DELETE FROM auth_tokens
         WHERE user_id = ? AND kind = 'PASSWORD_RESET' AND used_at IS NULL`
        ).run(id);
        return createAuthToken(id, "PASSWORD_RESET", 30);
      });
      addAudit(
        auth.user.id,
        "PASSWORD_RESET_LINK_CREATE",
        "user",
        id,
        undefined,
        { expiresInMinutes: 30 }
      );
      reply.header("Cache-Control", "no-store");
      return {
        resetUrl: buildPasswordResetUrl(siteOrigin, token),
        expiresAt
      };
    }
  );
}
