import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resource-machine-access-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "machine-access.sqlite");
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "machine-access-test-session-secret-at-least-32";

let app: ReturnType<typeof Fastify>;
let dbModule: typeof import("../server/db.js");
let scheduling: typeof import("../server/scheduling.js");
let adminCookie = "";
let managerCookie = "";
let memberCookie = "";
let machineId = "";
let poolId = "";
let groupId = "";
let managerId = "";
let applicantId = "";
let invitedId = "";

async function loginCookie(username: string, password = "ValidPassword123!") {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifierType: "USERNAME", identifier: username, password }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}

function futureDay(days: number) {
  const midnight = Math.floor((Date.now() + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  return new Date(midnight + days * 86400_000).toISOString();
}

beforeAll(async () => {
  dbModule = await import("../server/db.js");
  const authModule = await import("../server/auth.js");
  scheduling = await import("../server/scheduling.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerScheduleRoutes } = await import("../server/routes-schedule.js");
  const { registerAdminRoutes } = await import("../server/routes-admin.js");
  await dbModule.initializeDatabase();
  dbModule.db.prepare("UPDATE settings SET value='365' WHERE key='advance_days'").run();

  const admin = dbModule.db
    .prepare("SELECT id FROM users WHERE role = 'SYSTEM_ADMIN'")
    .get() as { id: string };
  const passwordHash = await authModule.hashPassword("ValidPassword123!");
  const now = dbModule.nowIso();
  const people = [
    ["machine-manager", "机器管理员", "10004001"],
    ["access-applicant", "申请用户", "10004002"],
    ["invited-user", "受邀用户", "10004003"]
  ] as const;
  const insertUser = dbModule.db.prepare(
    `INSERT INTO users(
      id, username, username_normalized, email, display_name, password_hash,
      role, status, approved_at, approved_by, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, ?, 'USER', 'ACTIVE', ?, ?, ?, ?)`
  );
  const insertNumber = dbModule.db.prepare(
    `INSERT INTO employee_numbers(
      id, user_id, employee_number, status, assigned_by, assigned_at, updated_at
    ) VALUES(?, ?, ?, 'ACTIVE', ?, ?, ?)`
  );
  const ids: string[] = [];
  for (const [username, displayName, employeeNumber] of people) {
    const id = randomUUID();
    ids.push(id);
    insertUser.run(
      id,
      username,
      username,
      `${username}@example.com`,
      displayName,
      passwordHash,
      now,
      admin.id,
      now,
      now
    );
    insertNumber.run(randomUUID(), id, employeeNumber, admin.id, now, now);
  }
  [managerId, applicantId, invitedId] = ids;

  machineId = randomUUID();
  poolId = randomUUID();
  groupId = randomUUID();
  dbModule.db
    .prepare(
      `INSERT INTO machines(
        id, name, address, management_notes,
        created_at, updated_at
      ) VALUES(?, 'Access-Test-Machine', '10.40.0.12',
        '仅管理员可见的运维信息', ?, ?)`
    )
    .run(machineId, now, now);
  dbModule.db.prepare(
    `INSERT INTO resource_pools(
      id, machine_id, name, kind, unit, range_start, range_end, created_at, updated_at
    ) VALUES(?, ?, '逻辑核', 'INDEX_RANGE', '核', 0, 31, ?, ?)`
  ).run(poolId, machineId, now, now);
  dbModule.db
    .prepare(
      `INSERT INTO resource_groups(
        id, machine_id, name, created_at, updated_at
      ) VALUES(?, ?, 'Access-Group', ?, ?)`
    )
    .run(groupId, machineId, now, now);
  const allocationId = randomUUID();
  dbModule.db.prepare(
    `INSERT INTO resource_group_allocations(
      id, resource_group_id, resource_pool_id, kind
    ) VALUES(?, ?, ?, 'INDEX_RANGE')`
  ).run(allocationId, groupId, poolId);
  dbModule.db.prepare(
    `INSERT INTO resource_group_allocation_ranges(
      id, allocation_id, range_start, range_end
    ) VALUES(?, ?, 0, 7)`
  ).run(randomUUID(), allocationId);
  dbModule.db
    .prepare(
      `INSERT INTO machine_access_memberships(
        id, machine_id, user_id, source, granted_by, created_at, updated_at
      ) VALUES(?, ?, ?, 'ADMIN_INVITE', ?, ?, ?)`
    )
    .run(randomUUID(), machineId, managerId, admin.id, now, now);
  dbModule.db
    .prepare(
      `INSERT INTO machine_admins(machine_id, user_id, assigned_by, created_at)
       VALUES(?, ?, ?, ?)`
    )
    .run(machineId, managerId, admin.id, now);

  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  registerAuthRoutes(app);
  registerScheduleRoutes(app, () => undefined);
  registerAdminRoutes(app, () => undefined);
  await app.ready();
  adminCookie = await loginCookie("Administrator", "Admin12#$");
  managerCookie = await loginCookie("machine-manager");
  memberCookie = await loginCookie("access-applicant");
});

beforeEach(() => {
  vi.useRealTimers();
  dbModule.db.exec("DELETE FROM reservations; DELETE FROM reservation_batches; DELETE FROM machine_access_requests; DELETE FROM notifications;");
  dbModule.db.prepare("DELETE FROM machine_admins WHERE user_id=?").run(applicantId);
  dbModule.db.prepare("DELETE FROM machine_access_memberships WHERE user_id IN (?,?)").run(applicantId, invitedId);
});
afterAll(async () => { vi.useRealTimers(); await app.close(); dbModule.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

async function apply(expiresAt: string | null | undefined = futureDay(180)) {
  return app.inject({ method: "POST", url: `/api/v1/machines/${machineId}/access-requests`, headers: { cookie: memberCookie }, payload: { reason: "expiry test", expiresAt } });
}
async function list() {
  const result = await app.inject({ method: "GET", url: `/api/v1/admin/machines/${machineId}/access`, headers: { cookie: managerCookie } });
  expect(result.statusCode).toBe(200);
  return result.json();
}
async function invite(expiresAt: string | null = null) {
  const result = await app.inject({ method: "POST", url: `/api/v1/admin/machines/${machineId}/members`, headers: { cookie: managerCookie }, payload: { userId: applicantId, expiresAt } });
  expect(result.statusCode, result.body).toBe(201);
}
async function edit(expiresAt: string | null, version?: number, userId = applicantId) {
  const row = dbModule.db.prepare("SELECT version FROM machine_access_memberships WHERE machine_id=? AND user_id=?").get(machineId, userId) as { version: number };
  return app.inject({ method: "PATCH", url: `/api/v1/admin/machines/${machineId}/members/${userId}/expiry`, headers: { cookie: managerCookie }, payload: { expiresAt, expectedVersion: version ?? row.version } });
}
function requestRow(id: string) { return dbModule.db.prepare("SELECT * FROM machine_access_requests WHERE id=?").get(id) as any; }
function memberRow() { return dbModule.db.prepare("SELECT * FROM machine_access_memberships WHERE machine_id=? AND user_id=?").get(machineId, applicantId) as any; }
function reserve(start: number, end: number, scope: "RESOURCE_GROUP" | "MACHINE" = "RESOURCE_GROUP") {
  return scheduling.commitReservationBatch(applicantId, [{ resourceGroupId: groupId, startAt: futureDay(start), endAt: futureDay(end), scope }]).reservations[0];
}

describe("machine access expiration", () => {
  it("allows members to read resource settings but rejects writes and expired access", async () => {
    const read = (kind: string, cookie = memberCookie) => app.inject({ method: "GET", url: `/api/v1/admin/machines/${machineId}/${kind}`, headers: { cookie } });
    expect((await read("resource-pools", "")).statusCode).toBe(401);
    expect((await read("resource-pools")).statusCode).toBe(403);
    await invite(futureDay(2));
    const pools = await read("resource-pools");
    expect(pools.statusCode).toBe(200);
    expect(pools.json().pools[0]).toMatchObject({ id: poolId, kind: "INDEX_RANGE", rangeStart: 0, rangeEnd: 31 });
    expect((await read("groups")).statusCode).toBe(200);
    for (const [method, path] of [
      ["PUT", `/admin/machines/${machineId}/resource-configuration`],
      ["POST", `/admin/machines/${machineId}/resource-pools`],
      ["POST", `/admin/machines/${machineId}/groups`],
      ["PATCH", `/admin/resource-pools/${poolId}`],
      ["DELETE", `/admin/resource-pools/${poolId}`],
      ["POST", `/admin/groups/${groupId}/disable`]
    ] as const) {
      const response = await app.inject({ method, url: `/api/v1${path}`, headers: { cookie: memberCookie }, payload: {} });
      expect(response.statusCode, `${method} ${path}: ${response.body}`).toBe(403);
    }
    expect((await read("resource-pools", managerCookie)).statusCode).toBe(200);
    dbModule.db.prepare("UPDATE machine_access_memberships SET expires_at=? WHERE machine_id=? AND user_id=?").run(futureDay(-1), machineId, applicantId);
    expect((await read("resource-pools")).statusCode).toBe(403);
    expect((await read("groups")).statusCode).toBe(403);
  });

  it("defaults applications and invitations to 30 days and disallows permanent user applications", async () => {
    expect((await apply(null)).statusCode).toBe(400);
    expect((await apply(futureDay(-1))).statusCode).toBe(400);
    expect((await apply(new Date(Date.parse(futureDay(2)) + 60_000).toISOString())).statusCode).toBe(400);
    expect((await apply("2099-02-30T00:00:00.000Z")).statusCode).toBe(400);
    const result = await apply(undefined);
    expect(result.statusCode).toBe(201);
    // Omit the field explicitly (the helper has a default).
    dbModule.db.exec("DELETE FROM machine_access_requests");
    const created = await app.inject({ method: "POST", url: `/api/v1/machines/${machineId}/access-requests`, headers: { cookie: memberCookie }, payload: {} });
    expect(Date.parse(requestRow(created.json().id).expires_at) - Date.now()).toBeGreaterThan(29 * 86400_000);
    const invitation = await app.inject({ method: "POST", url: `/api/v1/admin/machines/${machineId}/members`, headers: { cookie: managerCookie }, payload: { userId: invitedId } });
    expect(invitation.statusCode).toBe(201);
    expect((await list()).members.find((m: any) => m.id === invitedId).expiresAt).toMatch(/T.*:00.000Z$/);
  });

  it("normalizes equivalent timezone representations to Beijing midnight", async () => {
    const boundary = futureDay(2);
    const beijing = new Date(Date.parse(boundary) + 8 * 3600_000).toISOString().replace("Z", "+08:00");
    const response = await apply(beijing);
    expect(response.statusCode).toBe(201);
    expect(requestRow(response.json().id).expires_at).toBe(boundary);
  });

  it("edits a pending deadline, rejects stale approval, then approves the saved deadline", async () => {
    const id = (await apply()).json().id;
    const expiresAt = futureDay(240);
    const updated = await app.inject({ method: "PATCH", url: `/api/v1/admin/machine-access/requests/${id}/expiry`, headers: { cookie: managerCookie }, payload: { expiresAt, expectedVersion: 1 } });
    expect(updated.statusCode).toBe(200);
    expect(requestRow(id)).toMatchObject({ status: "PENDING", expires_at: expiresAt, version: 2 });
    const approve = (version: number) => app.inject({ method: "POST", url: `/api/v1/admin/machine-access/requests/${id}/approve`, headers: { cookie: managerCookie }, payload: { expectedVersion: version } });
    expect((await approve(1)).statusCode).toBe(409);
    expect((await approve(2)).statusCode).toBe(200);
    expect(memberRow().expires_at).toBe(expiresAt);
    expect((await approve(2)).statusCode).toBe(409);
  });

  it.each(["approve", "expiry", "list", "scan", "withdraw", "reject"])("automatically rejects on deadline through %s, commits the result, and notifies once", async action => {
    const expiresAt = futureDay(2);
    const id = (await apply(expiresAt)).json().id;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(expiresAt);
    if (action === "approve") {
      const response = await app.inject({ method: "POST", url: `/api/v1/admin/machine-access/requests/${id}/approve`, headers: { cookie: managerCookie }, payload: { expectedVersion: 1 } });
      expect(response.statusCode).toBe(409);
    } else if (action === "expiry") {
      const response = await app.inject({ method: "PATCH", url: `/api/v1/admin/machine-access/requests/${id}/expiry`, headers: { cookie: managerCookie }, payload: { expiresAt: futureDay(120), expectedVersion: 1 } });
      expect(response.statusCode).toBe(409);
    } else if (action === "reject") {
      const response = await app.inject({ method: "POST", url: `/api/v1/admin/machine-access/requests/${id}/reject`, headers: { cookie: managerCookie }, payload: { expectedVersion: 1, reason: "manual reason" } });
      expect(response.statusCode).toBe(409);
    } else if (action === "withdraw") {
      const response = await app.inject({ method: "DELETE", url: `/api/v1/machine-access/requests/${id}`, headers: { cookie: memberCookie } });
      expect(response.statusCode).toBe(409);
    } else if (action === "list") expect((await list()).requests).toEqual([]);
    const access = await import("../server/machine-access.js");
    access.expireMachineAccessRequests(); access.expireMachineAccessRequests();
    expect(requestRow(id)).toMatchObject({ status: "REJECTED", version: 2, reviewed_by: null, reviewed_at: expiresAt, review_reason: "申请使用期限已到，未完成审批" });
    expect(dbModule.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type='MACHINE_ACCESS_REJECTED'").get()).toEqual({ n: 1 });
    expect(dbModule.db.prepare("SELECT actor_user_id FROM audit_logs WHERE entity_id=? AND action='MACHINE_ACCESS_REQUEST_EXPIRE'").all(id)).toEqual([{ actor_user_id: null }]);
    expect((await apply()).statusCode).toBe(201);
  });

  it("does not expire permanent pending requests", async () => {
    const id = (await apply()).json().id;
    const response = await app.inject({ method: "PATCH", url: `/api/v1/admin/machine-access/requests/${id}/expiry`, headers: { cookie: managerCookie }, payload: { expiresAt: null, expectedVersion: 1 } });
    expect(response.statusCode).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.now() + 40 * 86400_000));
    (await import("../server/machine-access.js")).expireMachineAccessRequests();
    expect(requestRow(id)).toMatchObject({ status: "PENDING", expires_at: null });
  });

  it("cancels beyond-boundary reservations, truncates overlapping ones and preserves exact ends", async () => {
    await invite();
    const before = reserve(30, 60);
    const crossing = reserve(80, 140, "MACHINE");
    const after = reserve(160, 200);
    const expiresAt = futureDay(100);
    const response = await edit(expiresAt);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().impact).toEqual({ cancelled: 1, truncated: 1 });
    const get = (id: string) => dbModule.db.prepare("SELECT status,end_at FROM reservations WHERE id=?").get(id);
    expect(get(before.id)).toEqual({ status: "CONFIRMED", end_at: futureDay(60) });
    expect(get(crossing.id)).toEqual({ status: "CONFIRMED", end_at: expiresAt });
    expect(get(after.id)).toEqual({ status: "CANCELLED", end_at: futureDay(200) });
    expect((await edit(expiresAt)).json().impact).toEqual({ cancelled: 0, truncated: 0 });
    expect((await edit(null)).statusCode).toBe(200);
    expect(get(after.id)).toMatchObject({ status: "CANCELLED" });
    expect(get(crossing.id)).toMatchObject({ end_at: expiresAt });
  });

  it("truncates an ongoing reservation and rolls back all changes on failure", async () => {
    await invite();
    const ongoing = reserve(1, 80);
    const later = reserve(100, 160);
    dbModule.db.prepare("UPDATE reservations SET start_at=? WHERE id=?").run(futureDay(-2), ongoing.id);
    dbModule.db.exec("CREATE TRIGGER fail_expiry BEFORE UPDATE OF expires_at ON machine_access_memberships BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    expect((await edit(futureDay(40))).statusCode).toBe(500);
    expect(memberRow().expires_at).toBeNull();
    expect(dbModule.db.prepare("SELECT status FROM reservations WHERE id=?").get(later.id)).toEqual({ status: "CONFIRMED" });
    dbModule.db.exec("DROP TRIGGER fail_expiry");
    expect((await edit(futureDay(40))).json().impact).toEqual({ cancelled: 1, truncated: 1 });
    expect(dbModule.db.prepare("SELECT end_at FROM reservations WHERE id=?").get(ongoing.id)).toEqual({ end_at: futureDay(40) });
  });

  it("checks every segment and rechecks after preview, including single reservation updates", async () => {
    await invite(futureDay(120));
    const valid = { resourceGroupId: groupId, startAt: futureDay(30), endAt: futureDay(60) };
    const invalid = { resourceGroupId: groupId, startAt: futureDay(100), endAt: futureDay(140) };
    expect(() => scheduling.assertUserCanAccessSegments(applicantId, [valid, invalid])).toThrow("占用结束时间不能超过");
    expect(() => reserve(100, 120)).not.toThrow();
    const pending = { resourceGroupId: groupId, startAt: futureDay(65), endAt: futureDay(90) };
    scheduling.previewReservationBatch(applicantId, [pending]);
    await edit(futureDay(80));
    expect(() => scheduling.commitReservationBatch(applicantId, [pending])).toThrow("占用结束时间不能超过");
    const created = scheduling.commitReservationBatch(applicantId, [valid]).reservations[0];
    expect(() => scheduling.updateReservation(created.id, applicantId, { ...valid, endAt: futureDay(90) })).toThrow("占用结束时间不能超过");
  });

  it("compares exact expiry instants consistently with or without fractional seconds", async () => {
    const expiresAt = futureDay(120);
    await invite(expiresAt);
    const access = await import("../server/machine-access.js");
    const equivalent = expiresAt.replace(".000Z", "Z");
    expect(() => access.assertMachineAccessEnd(applicantId, machineId, equivalent)).not.toThrow();
    const created = scheduling.commitReservationBatch(applicantId, [{ resourceGroupId: groupId, startAt: futureDay(30), endAt: equivalent }]).reservations[0];
    await edit(null);
    expect((await edit(expiresAt)).json().impact).toEqual({ cancelled: 0, truncated: 0 });
    expect(dbModule.db.prepare("SELECT end_at FROM reservations WHERE id=?").get(created.id)).toEqual({ end_at: equivalent });
  });

  it("expired memberships lose access and can reapply without creating duplicate memberships", async () => {
    const expiresAt = futureDay(2); await invite(expiresAt);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(expiresAt);
    const access = await import("../server/machine-access.js");
    expect(access.userCanAccessMachine(applicantId, machineId)).toBe(false);
    expect(access.getAccessibleMachineIds(applicantId, "USER")).toEqual([]);
    const catalog = await app.inject({ method: "GET", url: "/api/v1/machines/catalog", headers: { cookie: memberCookie } });
    expect(catalog.json().machines[0].hasAccess).toBe(false);
    const id = (await apply()).json().id;
    expect((await edit(futureDay(200))).statusCode).toBe(409);
    const promotion = await app.inject({ method: "PUT", url: `/api/v1/admin/machines/${machineId}/managers/${applicantId}`, headers: { cookie: adminCookie }, payload: {} });
    expect(promotion.statusCode).toBe(409);
    const approved = await app.inject({ method: "POST", url: `/api/v1/admin/machine-access/requests/${id}/approve`, headers: { cookie: managerCookie }, payload: { expectedVersion: 1 } });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(access.userCanAccessMachine(applicantId, machineId)).toBe(true);
    expect(dbModule.db.prepare("SELECT count(*) AS n FROM machine_access_memberships WHERE user_id=?").get(applicantId)).toEqual({ n: 1 });
  });

  it("promotion makes access permanent and guards both API and database updates", async () => {
    await invite(futureDay(100));
    const oldVersion = memberRow().version;
    const promoted = await app.inject({ method: "PUT", url: `/api/v1/admin/machines/${machineId}/managers/${applicantId}`, headers: { cookie: adminCookie }, payload: {} });
    expect(promoted.statusCode).toBe(200);
    expect(memberRow()).toMatchObject({ expires_at: null, version: oldVersion + 1 });
    expect((await edit(futureDay(200), oldVersion)).statusCode).toBe(403);
    expect((await edit(null)).statusCode).toBe(403);
    expect(() => dbModule.db.prepare("UPDATE machine_access_memberships SET expires_at=? WHERE user_id=?").run(futureDay(200), applicantId)).toThrow();
    const demoted = await app.inject({ method: "DELETE", url: `/api/v1/admin/machines/${machineId}/managers/${applicantId}`, headers: { cookie: adminCookie } });
    expect(demoted.statusCode).toBe(200);
    expect(memberRow().expires_at).toBeNull();
    expect((await edit(futureDay(200), oldVersion)).statusCode).toBe(409);
    expect((await edit(futureDay(200))).statusCode).toBe(200);
  });
});


describe("machine access renewal", () => {
  const approve = (id: string, version = 1) => app.inject({ method: "POST", url: `/api/v1/admin/machine-access/requests/${id}/approve`, headers: { cookie: managerCookie }, payload: { expectedVersion: version } });

  it("keeps the original access until approval and rejects duplicate or non-extending requests", async () => {
    const original = futureDay(2), extended = futureDay(5);
    await invite(original);
    expect((await apply(original)).statusCode).toBe(400);
    const request = await apply(extended);
    expect(request.statusCode).toBe(201);
    const id = request.json().id;
    expect(requestRow(id)).toMatchObject({ previous_expires_at: original, expires_at: extended, status: "PENDING" });
    expect(memberRow().expires_at).toBe(original);
    expect((await list()).requests[0]).toMatchObject({ previousExpiresAt: original, expiresAt: extended });
    expect(() => reserve(3, 4)).toThrow("占用结束时间不能超过");
    expect((await apply(futureDay(6))).statusCode).toBe(409);
    expect((await approve(id)).statusCode).toBe(200);
    expect(memberRow().expires_at).toBe(extended);
    expect(() => reserve(3, 4)).not.toThrow();
  });

  it.each(["withdraw", "reject"])("%s leaves the original access unchanged", async action => {
    const original = futureDay(2); await invite(original);
    const id = (await apply(futureDay(5))).json().id;
    const response = action === "withdraw"
      ? await app.inject({ method: "DELETE", url: `/api/v1/machine-access/requests/${id}`, headers: { cookie: memberCookie } })
      : await app.inject({ method: "POST", url: `/api/v1/admin/machine-access/requests/${id}/reject`, headers: { cookie: managerCookie }, payload: { expectedVersion: 1 } });
    expect(response.statusCode).toBe(200);
    expect(memberRow().expires_at).toBe(original);
  });

  it("can approve after original access expires, but auto-rejects only at the requested deadline", async () => {
    const original = futureDay(2), extended = futureDay(5); await invite(original);
    const id = (await apply(extended)).json().id;
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(original);
    const access = await import("../server/machine-access.js");
    access.expireMachineAccessRequests();
    expect(access.userCanAccessMachine(applicantId, machineId)).toBe(false);
    expect(requestRow(id).status).toBe("PENDING");
    expect((await approve(id)).statusCode).toBe(200);
    expect(access.userCanAccessMachine(applicantId, machineId)).toBe(true);
    const next = (await apply(futureDay(5))).json().id;
    vi.setSystemTime(requestRow(next).expires_at);
    access.expireMachineAccessRequests();
    expect(requestRow(next).status).toBe("REJECTED");
    expect(memberRow().expires_at).toBe(extended);
  });

  it("defaults to thirty days after the original deadline and allows an administrator to grant permanent access", async () => {
    const original = futureDay(60); await invite(original);
    const response = await app.inject({ method: "POST", url: `/api/v1/machines/${machineId}/access-requests`, headers: { cookie: memberCookie }, payload: {} });
    expect(response.statusCode).toBe(201);
    const id = response.json().id;
    expect(requestRow(id).expires_at).toBe(futureDay(90));
    const invalid = await app.inject({ method: "PATCH", url: `/api/v1/admin/machine-access/requests/${id}/expiry`, headers: { cookie: managerCookie }, payload: { expectedVersion: 1, expiresAt: futureDay(30) } });
    expect(invalid.statusCode).toBe(400);
    const permanent = await app.inject({ method: "PATCH", url: `/api/v1/admin/machine-access/requests/${id}/expiry`, headers: { cookie: managerCookie }, payload: { expectedVersion: 1, expiresAt: null } });
    expect(permanent.statusCode).toBe(200);
    expect((await approve(id, 2)).statusCode).toBe(200);
    expect(memberRow().expires_at).toBeNull();
  });

  it("never shortens a newer grant or restores truncated reservations", async () => {
    await invite();
    const booked = reserve(1, 5);
    await edit(futureDay(2));
    const id = (await apply(futureDay(5))).json().id;
    dbModule.db.prepare("UPDATE machine_access_memberships SET expires_at=? WHERE user_id=? AND machine_id=?").run(futureDay(6), applicantId, machineId);
    expect((await approve(id)).statusCode).toBe(200);
    expect(memberRow().expires_at).toBe(futureDay(6));
    expect(dbModule.db.prepare("SELECT end_at FROM reservations WHERE id=?").get(booked.id)).toEqual({ end_at: futureDay(2) });
  });

  it("closes pending renewal on exit, preventing approval from regranting removed access", async () => {
    await invite(futureDay(2));
    const id = (await apply(futureDay(5))).json().id;
    const exited = await app.inject({ method: "DELETE", url: `/api/v1/machines/${machineId}/membership`, headers: { cookie: memberCookie } });
    expect(exited.statusCode).toBe(200);
    expect(requestRow(id)).toMatchObject({ status: "REJECTED", review_reason: "使用权已移除，延期申请已结束" });
    expect((await approve(id)).statusCode).toBe(409);
    expect(memberRow()).toBeUndefined();
  });
});
