import { createAdminFixture } from "./helpers/admin-fixture";
import { randomUUID } from "node:crypto";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const fixture = createAdminFixture("edit-conflicts");
let app: ReturnType<typeof Fastify>;
let database: typeof import("../server/db.js");
let adminCookie: string;

beforeAll(async () => {
  ({ app, database, adminCookie } = await fixture.start(async app => {
    await app.register(multipart);
    (await import("../server/feedback.js")).registerFeedbackRoutes(app, () => undefined);
    (await import("../server/announcements.js")).registerAnnouncementRoutes(app, () => undefined);
  }));
});

afterAll(() => fixture.close());


const headers = (overwrite = false) => ({ cookie: adminCookie, ...(overwrite ? { "x-allocube-overwrite": "true" } : {}) });
async function machine() {
  const id = randomUUID(), now = database.nowIso();
  database.db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(id, id, now, now);
  return id;
}
const call = (url: string, method: "PUT" | "PATCH" | "POST" | "DELETE", payload: object, overwrite = false) =>
  app.inject({ method, url: `/api/v1${url}`, headers: headers(overwrite), payload });

it("机器过期编辑只在确认后覆盖，权限和字段校验保持，审计及版本单调递增", async () => {
  const id = await machine(), url = `/admin/machines/${id}`;
  const input = { expectedVersion: 1, name: "original" };
  expect((await call(url, "PATCH", input)).statusCode).toBe(200);
  const stale = await call(url, "PATCH", { ...input, name: "draft" });
  expect(stale.statusCode).toBe(409);
  expect(stale.json().code).toBe("MACHINE_SETTINGS_STALE");
  expect((await call(url, "PATCH", { ...input, name: "another device" }, true)).statusCode).toBe(200);
  expect((await call(url, "PATCH", { ...input, name: "draft" }, true)).statusCode).toBe(200);
  expect(database.db.prepare("SELECT name, version FROM machines WHERE id = ?").get(id)).toEqual({ name: "draft", version: 4 });
  const denied = await app.inject({ method: "PATCH", url: `/api/v1${url}`, headers: { "x-allocube-overwrite": "true" }, payload: input });
  expect(denied.statusCode).toBe(401);
  expect((await call(url, "PATCH", { ...input, name: "" }, true)).statusCode).toBe(400);
  expect(database.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'MACHINE_UPDATE' AND entity_id = ?").get(id)).toEqual({ n: 3 });
});

it("公告覆盖只替换提交内容，不绕过撤下状态限制", async () => {
  const created = await call("/admin/announcements", "POST", { title: "initial", bodyMarkdown: "content" });
  const id = created.json().announcement.id, url = `/admin/announcements/${id}`;
  const input = { expectedVersion: 1, title: "remote", bodyMarkdown: "remote body" };
  expect((await call(url, "PUT", input)).statusCode).toBe(200);
  expect((await call(url, "PUT", input)).json().code).toBe("ANNOUNCEMENT_STALE");
  const overwritten = await call(url, "PUT", { ...input, title: "draft" }, true);
  expect(overwritten.statusCode).toBe(200); expect(overwritten.json().announcement.version).toBe(3);
  expect((await call(url + "/withdraw", "POST", { expectedVersion: 1 }, true)).statusCode).toBe(200);
  expect((await call(url, "PUT", input, true)).statusCode).toBe(409);
  expect(database.db.prepare("SELECT status FROM announcements WHERE id = ?").get(id)).toEqual({ status: "WITHDRAWN" });
});

it("资源配置覆盖保留远端新增的资源项及资源组分配，并重新校验容量", async () => {
  const id = await machine(), pool = randomUUID(), group = randomUUID();
  const url = `/admin/machines/${id}/resource-configuration`;
  const draft = { pools: [{ id: pool, expectedVersion: 0, name: "capacity", kind: "CAPACITY", unit: "GB", capacity: 10 }],
    groups: [{ id: group, expectedVersion: 0, name: "draft group", allocations: [{ poolId: pool, kind: "CAPACITY", quantity: 2 }] }] };
  expect((await call(url, "PUT", draft)).statusCode).toBe(200);
  draft.pools[0].expectedVersion = 1; draft.groups[0].expectedVersion = 1;
  const remotePool = randomUUID(), remoteGroup = randomUUID();
  const remote = { pools: [...draft.pools, { id: remotePool, expectedVersion: 0, name: "remote pool", kind: "CAPACITY", unit: "GB", capacity: 20 }],
    groups: [...draft.groups, { id: remoteGroup, expectedVersion: 0, name: "remote group", allocations: [{ poolId: remotePool, kind: "CAPACITY", quantity: 4 }] }] };
  expect((await call(url, "PUT", remote)).statusCode).toBe(200);
  draft.groups[0].name = "local draft";
  expect((await call(url, "PUT", draft)).statusCode).toBe(409);
  const overwritten = await call(url, "PUT", draft, true);
  expect(overwritten.statusCode, overwritten.body).toBe(200);
  expect(database.db.prepare("SELECT quantity_milli FROM resource_group_allocations WHERE resource_group_id = ?").get(remoteGroup)).toEqual({ quantity_milli: 4000 });
  expect(database.db.prepare("SELECT name FROM resource_groups WHERE id = ?").get(group)).toEqual({ name: "local draft" });
  draft.groups[0].allocations[0].quantity = 11;
  const invalid = await call(url, "PUT", draft, true);
  expect(invalid.statusCode).toBe(409);
  expect(database.db.prepare("SELECT quantity_milli FROM resource_group_allocations WHERE resource_group_id = ?").get(group)).toEqual({ quantity_milli: 2000 });
});

it("资源删除后不能通过覆盖复活，跨机器 ID 不能覆盖", async () => {
  const id = await machine(), other = await machine();
  const pool = (await call(`/admin/machines/${other}/resource-pools`, "POST", { kind: "CAPACITY", name: "private", unit: "GB", capacity: 10 })).json().id;
  const response = await call(`/admin/machines/${id}/resource-configuration`, "PUT", { pools: [{ id: pool, expectedVersion: 0, kind: "CAPACITY", name: "stolen", unit: "GB", capacity: 1 }], groups: [] }, true);
  expect(response.statusCode).toBe(409);
  expect(database.db.prepare("SELECT machine_id, name FROM resource_pools WHERE id = ?").get(pool)).toEqual({ machine_id: other, name: "private" });
  expect((await call(`/admin/resource-pools/${pool}`, "DELETE", { expectedVersion: 1 })).statusCode).toBe(200);
  const resurrect = await call(`/admin/machines/${other}/resource-configuration`, "PUT", { pools: [{ id: pool, expectedVersion: 1, kind: "CAPACITY", name: "resurrect", unit: "GB", capacity: 1 }], groups: [] }, true);
  expect(resurrect.statusCode).toBe(409);
});

it("维护、启停和删除允许确认过期版本，但已完成状态不能强制重复", async () => {
  const id = await machine(), url = `/admin/machines/${id}`;
  const startAt = new Date(Math.floor(Date.now() / 60000) * 60000 + 3600000).toISOString(), endAt = new Date(Math.floor(Date.now() / 60000) * 60000 + 7200000).toISOString();
  const maintenance = { startAt, endAt, expectedRevision: database.getScheduleRevision() };
  database.bumpScheduleRevision();
  expect((await call(url + "/unavailability", "POST", maintenance)).statusCode).toBe(409);
  expect((await call(url + "/unavailability", "POST", maintenance, true)).statusCode).toBe(201);
  expect((await call(url + "/unavailability", "POST", maintenance, true)).statusCode).toBe(409);
  const disable = { expectedVersion: 1, expectedRevision: 1, reason: "maintenance" };
  expect((await call(url + "/disable", "POST", disable)).statusCode).toBe(409);
  expect((await call(url + "/disable", "POST", disable, true)).statusCode).toBe(200);
  expect((await call(url + "/disable", "POST", disable, true)).statusCode).toBe(409);
  expect((await call(url + "/enable", "POST", { expectedVersion: 1 }, true)).statusCode).toBe(200);
  expect((await call(url, "DELETE", { expectedVersion: 1 }, true)).statusCode).toBe(409);
  expect((await call(url + "/disable", "POST", disable, true)).statusCode).toBe(200);
  expect((await call(url, "DELETE", { expectedVersion: 1 }, true)).statusCode).toBe(200);
});

it("反馈编辑、等级及状态更新沿用确认覆盖，终态仍只读", async () => {
  const form = (metadata: object) => {
    const boundary = "allocube-edit-boundary";
    return { payload: `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}--\r\n`, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
  };
  const created = await app.inject({ method: "POST", url: "/api/v1/feedback", ...form({ type: "ISSUE", level: "NORMAL", title: "initial", bodyMarkdown: "content" }), headers: { ...headers(), ...form({}).headers } });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().ticket.id;
  expect((await call(`/admin/feedback/${id}/level`, "PUT", { expectedVersion: 1, level: "SERIOUS" })).statusCode).toBe(200);
  const input = { expectedVersion: 1, title: "draft", level: "NORMAL", bodyMarkdown: "draft content", retainedAttachmentIds: [] };
  const edit = (overwrite: boolean) => app.inject({ method: "PUT", url: `/api/v1/feedback/${id}`, ...form(input), headers: { ...headers(overwrite), ...form(input).headers } });
  expect((await edit(false)).json().code).toBe("FEEDBACK_STALE");
  expect((await edit(true)).statusCode).toBe(200);
  const status = await call(`/admin/feedback/${id}/status`, "PUT", { expectedVersion: 1, status: "CONFIRMED", processingNote: "working" }, true);
  expect(status.statusCode, status.body).toBe(200);
  expect((await call(`/feedback/${id}/withdraw`, "POST", { expectedVersion: 1 }, true)).statusCode).toBe(200);
  expect((await edit(true)).statusCode).toBe(409);
  expect((await call(`/admin/feedback/${id}/level`, "PUT", { expectedVersion: 1, level: "NORMAL" }, true)).statusCode).toBe(409);
});
