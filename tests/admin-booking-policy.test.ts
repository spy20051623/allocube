import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAdminFixture } from "./helpers/admin-fixture";

const fixture = createAdminFixture("admin-booking-policy");
let context: Awaited<ReturnType<typeof fixture.start>>;
let scheduling: typeof import("../server/scheduling.js");
let adminId: string, userId: string, machineId: string, groupId: string, userCookie: string;
let token: string;
const future = (minutes: number) => new Date(Math.floor(Date.now() / 60_000 + minutes) * 60_000).toISOString();
const segment = (minutes = 60) => ({ resourceGroupId: groupId, scope: "RESOURCE_GROUP", startAt: future(minutes), endAt: future(minutes + 30), title: "Policy test" });
const write = (blocked: boolean, expectedVersion = context.database.getAdminSettings().version, overwrite = false, cookie = context.adminCookie) => {
  const settings = context.database.getAdminSettings();
  return context.app.inject({ method: "PATCH", url: "/api/v1/admin/settings", headers: { cookie }, payload: {
    advanceDays: settings.advanceDays, blockAdminBookings: blocked, expectedVersion, overwrite
  } });
};
const open = (path: string, payload: unknown) => context.app.inject({ method: "POST", url: `/api/open/v1/reservation-operations/${path}`, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  context = await fixture.start(async app => (await import("../server/open-api.js")).registerOpenApiRoutes(app, () => undefined));
  scheduling = await import("../server/scheduling.js");
  const { db, nowIso } = context.database, now = nowIso();
  adminId = (db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as { id: string }).id;
  userId = randomUUID(); machineId = randomUUID(); groupId = randomUUID();
  db.prepare(`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at)
    SELECT ?,'booking-member','booking-member','Member',password_hash,'USER','ACTIVE',?,? FROM users WHERE id=?`).run(userId, now, now, adminId);
  db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,'Policy machine',?,?)").run(machineId, now, now);
  db.prepare("INSERT INTO resource_groups(id,machine_id,name,created_at,updated_at) VALUES(?,?,'Policy group',?,?)").run(groupId, machineId, now, now);
  db.prepare("INSERT INTO machine_access_memberships(id,machine_id,user_id,source,created_at,updated_at) VALUES(?,?,?,'ADMIN_INVITE',?,?)").run(randomUUID(), machineId, userId, now, now);
  const login = await context.app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { identifierType: "USERNAME", identifier: "booking-member", password: "SettingsConflict82!" } });
  expect(login.statusCode).toBe(200);
  userCookie = login.cookies.map(item => `${item.name}=${item.value}`).join("; ");
  token = `allocube_pat_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const { hashApiSecret } = await import("../server/api-tokens.js");
  db.prepare("INSERT INTO api_tokens(id,user_id,name,token_prefix,token_hash,access_level,created_at) VALUES(?,?,?,?,?,'READ_WRITE',?)").run(randomUUID(), adminId, "Policy token", token.slice(0, 20), hashApiSecret(token), now);
});
afterAll(() => fixture.close());

it("defaults off; only system administrators can change it, with version checks and audit", async () => {
  const { db, getAdminSettings } = context.database;
  expect(getAdminSettings().blockAdminBookings).toBe(false);
  const version = getAdminSettings().version;
  expect((await write(true, version, false, userCookie)).statusCode).toBe(403);
  expect((await write(true)).statusCode).toBe(200);
  expect((await write(false, version)).statusCode).toBe(409);
  expect(getAdminSettings().blockAdminBookings).toBe(true);
  const audit = db.prepare("SELECT after_json FROM audit_logs WHERE action='SETTINGS_UPDATE' ORDER BY rowid DESC LIMIT 1").get() as { after_json: string };
  expect(JSON.parse(audit.after_json).blockAdminBookings).toBe(true);
  const oldClient = await context.app.inject({ method: "PATCH", url: "/api/v1/admin/settings", headers: { cookie: context.adminCookie }, payload: {
    advanceDays: 30, expectedVersion: getAdminSettings().version
  } });
  expect(oldClient.statusCode).toBe(200);
  expect(getAdminSettings().blockAdminBookings).toBe(true);
  expect((await write(false, version, true)).statusCode).toBe(200);
});

it("blocks all own submission paths without changing reservations, audits or revision; release remains available", async () => {
  const existing = scheduling.commitReservationBatch(adminId, [segment()]).reservations[0];
  await write(true);
  const { db, getScheduleRevision } = context.database;
  const before = () => ({ revision: getScheduleRevision(), rows: db.prepare("SELECT * FROM reservations").all(), batches: db.prepare("SELECT * FROM reservation_batches").all(), audits: db.prepare("SELECT * FROM audit_logs").all(), notifications: db.prepare("SELECT * FROM notifications").all() });
  const snapshot = before();
  const { reservationStateToken } = await import("../server/reservation-state.js");
  const row = db.prepare("SELECT * FROM reservations WHERE id=?").get(existing.id) as Record<string, unknown>;
  for (const action of [
    () => scheduling.commitReservationBatch(adminId, [segment(120)]),
    () => scheduling.commitReservationBatch(adminId, [segment(120)], undefined, true),
    () => scheduling.replaceReservationBatch(adminId, existing.id, [segment(120)]),
    () => scheduling.replaceMultipleReservations(adminId, [{ id: existing.id, stateToken: reservationStateToken(row) }], [segment(120)], true),
    () => scheduling.updateReservation(existing.id, adminId, segment()),
    () => scheduling.previewReservationUpdate(adminId, existing.id, segment())
  ]) expect(action).toThrowError("系统管理员账号已禁止提交占用");
  const response = await context.app.inject({ method: "POST", url: "/api/v1/reservations/batch", headers: { cookie: context.adminCookie }, payload: { segments: [segment(120)] } });
  expect(response.statusCode).toBe(403);
  expect(before()).toEqual(snapshot);
  scheduling.cancelReservation(existing.id, adminId, true, "Release still allowed");
  const userBooking = scheduling.commitReservationBatch(userId, [segment(120)]).reservations[0];
  scheduling.cancelReservation(userBooking.id, adminId, true, "Management still allowed");
  // Machine administrators retain the USER role and their booking permissions.
  db.prepare("INSERT INTO machine_admins(machine_id,user_id,assigned_by,created_at) VALUES(?,?,?,?)").run(machineId, userId, adminId, context.database.nowIso());
  const managerBooking = scheduling.commitReservationBatch(userId, [segment(180)]).reservations[0];
  scheduling.cancelReservation(managerBooking.id, adminId, true, "Cleanup");
  await write(false);
  expect(scheduling.commitReservationBatch(adminId, [segment(240)]).reservations).toHaveLength(1);
});

it("rechecks the policy after API preflight and never commits a stale confirmation", async () => {
  await write(false);
  const prepared = await open("prepare", { action: "CREATE", segments: [segment(360)] });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const { db } = context.database;
  const existing = db.prepare("SELECT id FROM reservations WHERE user_id=? AND status='CONFIRMED' ORDER BY start_at DESC LIMIT 1").get(adminId) as { id: string };
  const update = { action: "UPDATE", reservationId: existing.id, segment: segment(240) };
  const preparedUpdate = await open("prepare", update);
  expect(preparedUpdate.statusCode, preparedUpdate.body).toBe(200);
  await write(true);
  const revision = context.database.getScheduleRevision();
  const feedback = { message: "System administrator accounts cannot submit reservations. Please use your personal account.", details: { rejectionCode: "ADMIN_BOOKING_DISABLED" } };
  const denied = await open("prepare", { action: "CREATE", segments: [segment(420)] });
  expect(denied.statusCode, denied.body).toBe(403);
  expect(denied.json().error).toMatchObject({ code: "FORBIDDEN", ...feedback });
  const deniedUpdate = await open("prepare", update);
  expect(deniedUpdate.statusCode).toBe(403);
  expect(deniedUpdate.json().error).toMatchObject({ code: "FORBIDDEN", ...feedback });
  const committed = await open("commit", { confirmationToken: prepared.json().data.confirmationToken });
  expect(committed.statusCode, committed.body).toBe(409);
  expect(committed.json().error).toMatchObject({ code: "OPERATION_REJECTED", ...feedback });
  const committedUpdate = await open("commit", { confirmationToken: preparedUpdate.json().data.confirmationToken });
  expect(committedUpdate.statusCode).toBe(409);
  expect(committedUpdate.json().error).toMatchObject({ code: "OPERATION_REJECTED", ...feedback });
  expect(context.database.getScheduleRevision()).toBe(revision);
  await write(false);
  // Consumed confirmations remain rejected with their original reason even after policy changes.
  const replay = await open("commit", { confirmationToken: prepared.json().data.confirmationToken });
  expect(replay.statusCode).toBe(409);
  expect(replay.json().error).toMatchObject({ code: "OPERATION_REJECTED", ...feedback });
  expect(context.database.getScheduleRevision()).toBe(revision);
  expect((await open("prepare", { action: "CREATE", segments: [segment(420)] })).statusCode).toBe(200);
});

it("keeps successful API replays and release operations available when submissions are blocked", async () => {
  await write(false);
  const prepared = await open("prepare", { action: "CREATE", segments: [segment(600)] });
  const confirmationToken = prepared.json().data.confirmationToken;
  const created = await open("commit", { confirmationToken });
  expect(created.statusCode, created.body).toBe(200);
  const reservationId = created.json().data.reservations[0].id;
  const immediate = await open("prepare", { action: "CREATE", segments: [segment(0)] });
  const active = await open("commit", { confirmationToken: immediate.json().data.confirmationToken });
  expect(active.statusCode, active.body).toBe(200);
  await write(true);
  const revision = context.database.getScheduleRevision();
  const replay = await open("commit", { confirmationToken });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().data).toEqual(created.json().data);
  expect(context.database.getScheduleRevision()).toBe(revision);
  for (const [action, id] of [["CANCEL", reservationId], ["END", active.json().data.reservations[0].id]]) {
    const release = await open("prepare", { action, reservationId: id });
    expect(release.statusCode, release.body).toBe(200);
    const result = await open("commit", { confirmationToken: release.json().data.confirmationToken });
    expect(result.statusCode, result.body).toBe(200);
  }
  await write(false);
});

it("rolls back the policy and version if its audit fails", async () => {
  const { db, getAdminSettings } = context.database, before = getAdminSettings();
  db.exec("CREATE TEMP TRIGGER fail_policy_audit BEFORE INSERT ON audit_logs WHEN NEW.action='SETTINGS_UPDATE' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  try {
    expect((await write(true)).statusCode).toBe(500);
    expect(getAdminSettings()).toEqual(before);
  } finally { db.exec("DROP TRIGGER fail_policy_audit"); }
});
