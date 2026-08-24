import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { beforeAll, describe, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-open-api-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "open-api.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "open-api-test-session-secret-at-least-32-characters";

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import("../server/db.js");
let hashApiSecret: typeof import("../server/api-tokens.js")["hashApiSecret"];
let revokeApiTokensForUser: typeof import("../server/api-tokens.js")["revokeApiTokensForUser"];
let machineId: string;
let groupId: string;
let firstUserId: string;
let secondUserId: string;
let readSecret: string;
let writeSecret: string;
let createdReservationId: string;

function minuteIso(minutesFromNow: number) {
  return new Date(
    Math.floor((Date.now() + minutesFromNow * 60_000) / 60_000) * 60_000
  ).toISOString();
}

async function addUser(username: string, displayName: string, employeeNumber: string) {
  const { hashPassword } = await import("../server/password-hashing.js");
  const id = randomUUID();
  const now = new Date().toISOString();
  dbModule.db
    .prepare(
      `INSERT INTO users(
         id, username, username_normalized, display_name, password_hash,
         role, status, created_at, updated_at
       ) VALUES(?, ?, ?, ?, ?, 'USER', 'ACTIVE', ?, ?)`
    )
    .run(
      id,
      username,
      username.toLocaleLowerCase("zh-CN"),
      displayName,
      await hashPassword("User12#$password"),
      now,
      now
    );
  dbModule.db
    .prepare(
      `INSERT INTO employee_numbers(
         id, user_id, employee_number, status, assigned_at, updated_at
       ) VALUES(?, ?, ?, 'ACTIVE', ?, ?)`
    )
    .run(randomUUID(), id, employeeNumber, now, now);
  dbModule.db
    .prepare(
      `INSERT INTO machine_access_memberships(
         id, machine_id, user_id, source, created_at, updated_at
       ) VALUES(?, ?, ?, 'ADMIN_INVITE', ?, ?)`
    )
    .run(randomUUID(), machineId, id, now, now);
  return id;
}

function addApiToken(
  userId: string,
  name: string,
  accessLevel: "READ_ONLY" | "READ_WRITE",
  expiresAt: string | null = null
) {
  const secret = `allocube_pat_${randomBytes(32).toString("base64url")}`;
  dbModule.db
    .prepare(
      `INSERT INTO api_tokens(
         id, user_id, name, token_prefix, token_hash, access_level,
         expires_at, created_at
       ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      userId,
      name,
      secret.slice(0, 20),
      hashApiSecret(secret),
      accessLevel,
      expiresAt,
      new Date().toISOString()
    );
  return secret;
}

function authorization(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

function insertOtherReservation() {
  const id = randomUUID();
  const batchId = randomUUID();
  const startAt = minuteIso(120);
  const endAt = minuteIso(180);
  const now = new Date().toISOString();
  dbModule.db
    .prepare("INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)")
    .run(batchId, secondUserId, now);
  dbModule.db
    .prepare(
      `INSERT INTO reservations(
         id, batch_id, scope, resource_group_id, machine_id, user_id,
         start_at, end_at, initial_start_at, initial_end_at,
         title, purpose, note, snapshot_group_name,
         snapshot_resource_config_json, snapshot_group_version,
         created_at, updated_at
       ) VALUES(?, ?, 'RESOURCE_GROUP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 1, ?, ?)`
    )
    .run(
      id,
      batchId,
      groupId,
      machineId,
      secondUserId,
      startAt,
      endAt,
      startAt,
      endAt,
      "共享的任务标题",
      "共享的任务用途",
      "共享的补充备注",
      "默认资源组",
      now,
      now
    );
  return id;
}

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  const tokenModule = await import("../server/api-tokens.js");
  hashApiSecret = tokenModule.hashApiSecret;
  revokeApiTokensForUser = tokenModule.revokeApiTokensForUser;
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerApiTokenManagementRoutes } = tokenModule;
  const { registerOpenApiRoutes } = await import("../server/open-api.js");
  await dbModule.initializeDatabase();

  machineId = randomUUID();
  groupId = randomUUID();
  const now = new Date().toISOString();
  dbModule.db
    .prepare(
      `INSERT INTO machines(
         id, name, address, hardware_notes, connection_guide,
         management_notes, tags_json, status, created_at, updated_at
       ) VALUES(?, 'AI 测试机', 'ssh test', 'ARM64', '联系管理员', '', '["ai"]', 'ACTIVE', ?, ?)`
    )
    .run(machineId, now, now);
  dbModule.db
    .prepare(
      `INSERT INTO resource_groups(
         id, machine_id, name, description, tags_json, status,
         sort_order, version, created_at, updated_at
       ) VALUES(?, ?, '默认资源组', '供 API 测试', '["default"]', 'ACTIVE', 0, 1, ?, ?)`
    )
    .run(groupId, machineId, now, now);

  firstUserId = await addUser("api-user-one", "甲用户", "API0001");
  secondUserId = await addUser("api-user-two", "乙用户", "API0002");
  readSecret = addApiToken(firstUserId, "只读 AI", "READ_ONLY");
  writeSecret = addApiToken(firstUserId, "读写 AI", "READ_WRITE");
  insertOtherReservation();

  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  registerAuthRoutes(app);
  registerApiTokenManagementRoutes(app);
  registerOpenApiRoutes(app, () => undefined);
  await app.ready();
});

describe("官方 API", () => {
  it("把旧 API 文档入口重定向到统一文档中心", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/open/docs"
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/docs/api");
  });

  it("公开 OpenAPI 3.1 文档并保持 operationId 唯一", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/open/v1/openapi.json"
    });
    expect(response.statusCode).toBe(200);
    const document = response.json();
    expect(document.openapi).toBe("3.1.0");
    const operationIds = Object.values(document.paths).flatMap((pathItem: any) =>
      Object.values(pathItem)
        .map((operation: any) => operation.operationId)
        .filter(Boolean)
    );
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operationIds).toContain("prepareReservationOperation");
    expect(operationIds).toContain("commitReservationOperation");
    expect(document.paths["/reservation-operations/commit"].post.responses[409].description)
      .toContain("必须重新预检");
    expect(
      document.paths["/reservation-operations/commit"].post.requestBody.content[
        "application/json"
      ].examples.commit.value
    ).toEqual({
      confirmationToken: "<CONFIRMATION_TOKEN>"
    });
    expect(
      Object.keys(
        document.paths["/reservation-operations/prepare"].post.requestBody.content[
          "application/json"
        ].examples
      )
    ).toEqual(["create", "update", "cancel", "end"]);
    expect(
      document.paths["/reservation-operations/commit"].post.description
    ).toContain("不需要再次传 action");
    expect(document["x-placeholder-convention"].syntax).toBe(
      "<UPPER_SNAKE_CASE>"
    );
    const serializedDocument = JSON.stringify(document);
    expect(serializedDocument).not.toMatch(/REDACTED|your-company|allocube\.example/u);
    expect(serializedDocument).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu
    );
    for (const match of serializedDocument.matchAll(/<([^>]+)>/g)) {
      expect(match[1]).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    }
    expect(document.paths["/reservations/{id}"].get.responses[404].description)
      .toContain("不属于当前用户");
    expect(document.components.schemas.ScheduleReservation.required).toEqual(
      expect.arrayContaining([
        "title",
        "purpose",
        "note",
        "initialStartAt",
        "initialEndAt",
        "adjustmentType",
        "adjustmentReason"
      ])
    );
    for (const pathItem of Object.values(document.paths) as any[]) {
      for (const operation of Object.values(pathItem) as any[]) {
        if (!operation?.responses) continue;
        for (const [status, responseSchema] of Object.entries(operation.responses) as any[]) {
          if (Number(status) >= 400) {
            expect(responseSchema.description).not.toBe("请求失败");
          }
        }
      }
    }
  });

  it("只接受 Bearer 令牌且不返回 CORS 许可头", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/open/v1/me",
      headers: { cookie: "resource_session=fake" }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("UNAUTHENTICATED");
    expect(unauthenticated.json().error.requestId).toBeTruthy();

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/open/v1/me",
      headers: authorization(readSecret)
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().data.user.id).toBe(firstUserId);
    expect(authenticated.json().data.token.accessLevel).toBe("READ_ONLY");
    expect(authenticated.headers["access-control-allow-origin"]).toBeUndefined();
    expect(authenticated.headers["x-ratelimit-limit"]).toBe("120");
  });

  it("分页查询可访问机器、资源组和本人占用", async () => {
    const machines = await app.inject({
      method: "GET",
      url: "/api/open/v1/machines?limit=1",
      headers: authorization(readSecret)
    });
    expect(machines.statusCode).toBe(200);
    expect(machines.json().data.machines[0]).toMatchObject({
      id: machineId,
      name: "AI 测试机"
    });

    const groups = await app.inject({
      method: "GET",
      url: `/api/open/v1/machines/${machineId}/resource-groups`,
      headers: authorization(readSecret)
    });
    expect(groups.statusCode).toBe(200);
    expect(groups.json().data.resourceGroups[0]).toMatchObject({
      id: groupId,
      machineId
    });

    const reservations = await app.inject({
      method: "GET",
      url: "/api/open/v1/reservations?limit=1",
      headers: authorization(readSecret)
    });
    expect(reservations.statusCode).toBe(200);
    expect(reservations.json().data.reservations).toEqual([]);
  });

  it("排期向机器使用者返回完整占用详情", async () => {
    const schedule = await app.inject({
      method: "GET",
      url: `/api/open/v1/schedule?from=${encodeURIComponent(minuteIso(0))}&to=${encodeURIComponent(minuteIso(240))}&machineIds=${machineId}`,
      headers: authorization(readSecret)
    });
    expect(schedule.statusCode).toBe(200);
    const other = schedule.json().data.reservations.find(
      (reservation: any) => reservation.applicantName === "乙用户"
    );
    expect(other).toMatchObject({
      applicantEmployeeNumber: "API0002",
      mine: false,
      title: "共享的任务标题",
      purpose: "共享的任务用途",
      note: "共享的补充备注",
      adjustmentType: null,
      adjustmentReason: ""
    });
    expect(other.initialStartAt).toBe(other.startAt);
    expect(other.initialEndAt).toBe(other.endAt);
  });

  it("拒绝只读令牌和未知字段执行写入预检", async () => {
    const insufficient = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(readSecret),
      payload: {
        action: "CREATE",
        segments: []
      }
    });
    expect(insufficient.statusCode).toBe(403);
    expect(insufficient.json().error.code).toBe("INSUFFICIENT_SCOPE");

    const invalid = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CANCEL",
        reservationId: randomUUID(),
        unexpected: true
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_REQUEST");
  });

  it("通过预检提交创建操作，并安全重放而不重复占用", async () => {
    const startAt = minuteIso(20);
    const endAt = minuteIso(50);
    const prepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CREATE",
        segments: [
          {
            scope: "RESOURCE_GROUP",
            resourceGroupId: groupId,
            startMode: "SCHEDULED",
            startAt,
            endAt,
            title: "AI 创建的占用",
            purpose: "接口验收"
          }
        ]
      }
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().data.status).toBe("READY");
    const confirmationToken = prepared.json().data.confirmationToken as string;

    const committed = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: { confirmationToken }
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().meta.replayed).toBe(false);
    const reservationId = committed.json().data.reservations[0].id as string;
    createdReservationId = reservationId;

    const replayed = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: { confirmationToken }
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json().meta.replayed).toBe(true);
    expect(replayed.json().data.reservations[0].id).toBe(reservationId);
    expect(
      (
        dbModule.db
          .prepare("SELECT COUNT(*) AS count FROM reservations WHERE id = ?")
          .get(reservationId) as { count: number }
      ).count
    ).toBe(1);
    const audit = dbModule.db
      .prepare(
        `SELECT actor_api_token_id, api_operation_id FROM audit_logs
         WHERE entity_id = ? AND action = 'RESERVATION_CREATE'`
      )
      .get(reservationId) as {
      actor_api_token_id: string;
      api_operation_id: string;
    };
    expect(audit.actor_api_token_id).toBeTruthy();
    expect(audit.api_operation_id).toBe(prepared.json().data.operationId);
  });

  it("预检冲突时不签发确认令牌", async () => {
    const blocked = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CREATE",
        segments: [
          {
            scope: "RESOURCE_GROUP",
            resourceGroupId: groupId,
            startAt: minuteIso(130),
            endAt: minuteIso(140)
          }
        ]
      }
    });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.json().data.status).toBe("BLOCKED");
    expect(blocked.json().data).not.toHaveProperty("confirmationToken");
  });

  it("确认令牌绑定签发它的 API 令牌", async () => {
    const prepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CREATE",
        segments: [
          {
            scope: "RESOURCE_GROUP",
            resourceGroupId: groupId,
            startAt: minuteIso(60),
            endAt: minuteIso(70)
          }
        ]
      }
    });
    const anotherWriteToken = addApiToken(firstUserId, "另一读写令牌", "READ_WRITE");
    const committed = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(anotherWriteToken),
      payload: { confirmationToken: prepared.json().data.confirmationToken }
    });
    expect(committed.statusCode).toBe(404);
    expect(committed.json().error.code).toBe("NOT_FOUND");
  });

  it("修改和取消也必须分别预检后提交", async () => {
    const updatePrepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "UPDATE",
        reservationId: createdReservationId,
        segment: {
          scope: "RESOURCE_GROUP",
          resourceGroupId: groupId,
          startAt: minuteIso(25),
          endAt: minuteIso(55),
          title: "AI 修改后的占用",
          purpose: "修改验收"
        }
      }
    });
    expect(updatePrepared.statusCode).toBe(200);
    expect(updatePrepared.json().data.status).toBe("READY");
    const updated = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: {
        confirmationToken: updatePrepared.json().data.confirmationToken
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(
      (
        dbModule.db
          .prepare("SELECT title FROM reservations WHERE id = ?")
          .get(createdReservationId) as { title: string }
      ).title
    ).toBe("AI 修改后的占用");

    const cancelPrepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CANCEL",
        reservationId: createdReservationId,
        reason: "自动化任务取消"
      }
    });
    expect(cancelPrepared.statusCode).toBe(200);
    const cancelled = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: {
        confirmationToken: cancelPrepared.json().data.confirmationToken
      }
    });
    expect(cancelled.statusCode).toBe(200);
    expect(
      (
        dbModule.db
          .prepare("SELECT status FROM reservations WHERE id = ?")
          .get(createdReservationId) as { status: string }
      ).status
    ).toBe("CANCELLED");
  });

  it("提前结束本人进行中占用必须预检后提交", async () => {
    const reservationId = randomUUID();
    const batchId = randomUUID();
    const startAt = minuteIso(0);
    const endAt = minuteIso(15);
    const now = new Date().toISOString();
    dbModule.db
      .prepare("INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)")
      .run(batchId, firstUserId, now);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
           id, batch_id, scope, resource_group_id, machine_id, user_id,
           start_at, end_at, initial_start_at, initial_end_at,
           snapshot_group_name, snapshot_resource_config_json,
           snapshot_group_version, created_at, updated_at
         ) VALUES(?, ?, 'RESOURCE_GROUP', ?, ?, ?, ?, ?, ?, ?, '默认资源组', '[]', 1, ?, ?)`
      )
      .run(
        reservationId,
        batchId,
        groupId,
        machineId,
        firstUserId,
        startAt,
        endAt,
        startAt,
        endAt,
        now,
        now
      );
    const prepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: { action: "END", reservationId, reason: "任务提前完成" }
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json().data.status).toBe("READY");
    const committed = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: { confirmationToken: prepared.json().data.confirmationToken }
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json().data.ended).toBe(true);
  });

  it("过期或预检后状态变化的确认令牌不能提交", async () => {
    const expiredPrepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CREATE",
        segments: [
          {
            scope: "RESOURCE_GROUP",
            resourceGroupId: groupId,
            startAt: minuteIso(65),
            endAt: minuteIso(75)
          }
        ]
      }
    });
    dbModule.db
      .prepare("UPDATE prepared_api_operations SET expires_at = ? WHERE id = ?")
      .run(minuteIso(-1), expiredPrepared.json().data.operationId);
    const expiredCommit = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: {
        confirmationToken: expiredPrepared.json().data.confirmationToken
      }
    });
    expect(expiredCommit.statusCode).toBe(410);
    expect(expiredCommit.json().error.code).toBe("OPERATION_EXPIRED");

    const stalePrepared = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/prepare",
      headers: authorization(writeSecret),
      payload: {
        action: "CREATE",
        segments: [
          {
            scope: "RESOURCE_GROUP",
            resourceGroupId: groupId,
            startAt: minuteIso(80),
            endAt: minuteIso(90)
          }
        ]
      }
    });
    expect(stalePrepared.json().data.status).toBe("READY");
    const conflictBatchId = randomUUID();
    const conflictId = randomUUID();
    const now = new Date().toISOString();
    dbModule.db
      .prepare("INSERT INTO reservation_batches(id, user_id, created_at) VALUES(?, ?, ?)")
      .run(conflictBatchId, secondUserId, now);
    dbModule.db
      .prepare(
        `INSERT INTO reservations(
           id, batch_id, scope, resource_group_id, machine_id, user_id,
           start_at, end_at, initial_start_at, initial_end_at,
           snapshot_group_name, snapshot_resource_config_json,
           snapshot_group_version, created_at, updated_at
         ) VALUES(?, ?, 'RESOURCE_GROUP', ?, ?, ?, ?, ?, ?, ?, '默认资源组', '[]', 1, ?, ?)`
      )
      .run(
        conflictId,
        conflictBatchId,
        groupId,
        machineId,
        secondUserId,
        minuteIso(80),
        minuteIso(90),
        minuteIso(80),
        minuteIso(90),
        now,
        now
      );
    const staleCommit = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservation-operations/commit",
      headers: authorization(writeSecret),
      payload: { confirmationToken: stalePrepared.json().data.confirmationToken }
    });
    expect(staleCommit.statusCode).toBe(409);
    expect(staleCommit.json().error.code).toBe("OPERATION_REJECTED");
  });

  it("到期令牌立即失效且不存在直接写入端点", async () => {
    const expiredSecret = addApiToken(
      firstUserId,
      "已到期",
      "READ_WRITE",
      minuteIso(-1)
    );
    const expired = await app.inject({
      method: "GET",
      url: "/api/open/v1/me",
      headers: authorization(expiredSecret)
    });
    expect(expired.statusCode).toBe(401);
    const direct = await app.inject({
      method: "POST",
      url: "/api/open/v1/reservations",
      headers: authorization(writeSecret),
      payload: {}
    });
    expect(direct.statusCode).toBe(404);
  });

  it("密码修改不吊销令牌，账号停用会吊销令牌和待提交操作", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "USERNAME",
        identifier: "api-user-one",
        password: "User12#$password"
      }
    });
    expect(login.statusCode).toBe(200);
    const cookieHeader = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const changed = await app.inject({
      method: "POST",
      url: "/api/v1/auth/change-password",
      headers: { cookie: cookieHeader },
      payload: {
        currentPassword: "User12#$password",
        newPassword: "Changed34#$password"
      }
    });
    expect(changed.statusCode).toBe(200);
    const stillValid = await app.inject({
      method: "GET",
      url: "/api/open/v1/me",
      headers: authorization(writeSecret)
    });
    expect(stillValid.statusCode).toBe(200);

    dbModule.withImmediateTransaction(() => {
      dbModule.db
        .prepare("UPDATE users SET status = 'DISABLED' WHERE id = ?")
        .run(firstUserId);
      revokeApiTokensForUser(firstUserId, "测试停用");
    });
    const disabled = await app.inject({
      method: "GET",
      url: "/api/open/v1/me",
      headers: authorization(writeSecret)
    });
    expect(disabled.statusCode).toBe(401);
    expect(
      (
        dbModule.db
          .prepare(
            "SELECT COUNT(*) AS count FROM prepared_api_operations WHERE user_id = ? AND status = 'PENDING'"
          )
          .get(firstUserId) as { count: number }
      ).count
    ).toBe(0);
  });

  it("网页端令牌只存储哈希、明文只返回一次且只能逐个吊销", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        identifierType: "USERNAME",
        identifier: "Administrator",
        password: "Admin12#$"
      }
    });
    const cookieHeader = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join("; ");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/api-tokens",
      headers: { cookie: cookieHeader },
      payload: {
        name: "管理员 AI",
        accessLevel: "READ_ONLY",
        expiresInDays: null,
        currentPassword: "Admin12#$"
      }
    });
    expect(created.statusCode).toBe(201);
    const secret = created.json().secret as string;
    expect(secret).toMatch(/^allocube_pat_/);
    const stored = dbModule.db
      .prepare("SELECT token_hash FROM api_tokens WHERE id = ?")
      .get(created.json().token.id) as { token_hash: string };
    expect(stored.token_hash).toBe(hashApiSecret(secret));
    expect(stored.token_hash).not.toContain(secret);
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/auth/api-tokens",
      headers: { cookie: cookieHeader }
    });
    expect(JSON.stringify(listed.json())).not.toContain(secret);

    const bulkRevoke = await app.inject({
      method: "POST",
      url: "/api/v1/auth/api-tokens/revoke-all",
      headers: { cookie: cookieHeader },
      payload: {}
    });
    expect(bulkRevoke.statusCode).toBe(404);

    const revoked = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/api-tokens/${created.json().token.id}`,
      headers: { cookie: cookieHeader }
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ revoked: true });
  });
});
