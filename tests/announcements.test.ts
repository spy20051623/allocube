import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-announcements-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "announcements.sqlite");
process.env.BOOTSTRAP_ADMIN_NAME = "测试管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "announcement-test-session-secret-at-least-32-characters";

let app: ReturnType<typeof Fastify>;
let database: typeof import("../server/db.js");
let adminCookie = "";
let userCookie = "";
let publishedChanges = 0;
let announcementId = "";
let originalCreatedAt = "";
let originalPublishedAt = "";

async function loginCookie(identifier: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifierType: "USERNAME", identifier, password }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}

beforeAll(async () => {
  database = await import("../server/db.js");
  const { hashPassword } = await import("../server/auth.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerAnnouncementRoutes } = await import("../server/announcements.js");
  await database.initializeDatabase();

  const now = database.nowIso();
  database.db
    .prepare(
      `INSERT INTO users(
        id, username, username_normalized, email, display_name, password_hash,
        role, status, approved_at, created_at, updated_at
      ) VALUES(?, '公告用户', '公告用户', 'announcement-user@example.com',
        '公告用户', ?, 'USER', 'ACTIVE', ?, ?, ?)`
    )
    .run(randomUUID(), await hashPassword("AnnouncementUser123!"), now, now, now);

  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: "输入内容不符合要求" });
    }
    return reply.send(error);
  });
  registerAuthRoutes(app);
  registerAnnouncementRoutes(app, () => {
    publishedChanges += 1;
  });
  await app.ready();
  adminCookie = await loginCookie("Administrator", "Admin12#$");
  userCookie = await loginCookie("公告用户", "AnnouncementUser123!");
});

describe("系统公告", () => {
  it("只允许系统管理员创建，并按发布时间向登录用户展示", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/admin/announcements",
      headers: { cookie: userCookie },
      payload: { title: "无权限", bodyMarkdown: "不应创建" }
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/announcements",
      headers: { cookie: adminCookie },
      payload: {
        title: "维护通知",
        bodyMarkdown:
          "请查看[资源日历](allocube:/calendar)，或阅读[外部说明](https://example.org/help)。"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().announcement).toMatchObject({
      title: "维护通知",
      status: "ACTIVE",
      version: 1,
      createdByName: "测试管理员"
    });
    announcementId = created.json().announcement.id;
    originalCreatedAt = created.json().announcement.createdAt;
    originalPublishedAt = created.json().announcement.publishedAt;
    expect(originalPublishedAt).toBe(originalCreatedAt);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/announcements",
      headers: { cookie: userCookie }
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().announcements).toHaveLength(1);
    expect(active.json().announcements[0].id).toBe(created.json().announcement.id);
  });

  it("拒绝未知站内路径和请求中的未知字段", async () => {
    const invalidPath = await app.inject({
      method: "POST",
      url: "/api/v1/admin/announcements",
      headers: { cookie: adminCookie },
      payload: { title: "错误链接", bodyMarkdown: "[打开](allocube:/unknown)" }
    });
    expect(invalidPath.statusCode).toBe(400);

    const unknownField = await app.inject({
      method: "POST",
      url: "/api/v1/admin/announcements",
      headers: { cookie: adminCookie },
      payload: { title: "未知字段", bodyMarkdown: "内容", extra: true }
    });
    expect(unknownField.statusCode).toBe(400);
  });

  it("编辑公告会生成新版本并更新发布时间", async () => {
    const stale = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/announcements/${announcementId}`,
      headers: { cookie: adminCookie },
      payload: {
        title: "维护通知（错误版本）",
        bodyMarkdown: "内容",
        expectedVersion: 2,
        reactivate: false
      }
    });
    expect(stale.statusCode).toBe(409);

    const invalidReactivate = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/announcements/${announcementId}`,
      headers: { cookie: adminCookie },
      payload: {
        title: "维护通知",
        bodyMarkdown: "内容",
        expectedVersion: 1,
        reactivate: true
      }
    });
    expect(invalidReactivate.statusCode).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const edited = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/announcements/${announcementId}`,
      headers: { cookie: adminCookie },
      payload: {
        title: "维护通知（已更新）",
        bodyMarkdown: "更新后请查看[资源日历](allocube:/calendar)。",
        expectedVersion: 1,
        reactivate: false
      }
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().announcement).toMatchObject({
      id: announcementId,
      title: "维护通知（已更新）",
      status: "ACTIVE",
      version: 2,
      createdAt: originalCreatedAt
    });
    expect(edited.json().announcement.publishedAt).not.toBe(originalPublishedAt);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/announcements",
      headers: { cookie: userCookie }
    });
    expect(active.json().announcements[0]).toMatchObject({
      id: announcementId,
      version: 2
    });
  });

  it("使用版本校验撤下公告并立即从用户列表移除", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/announcements",
      headers: { cookie: adminCookie }
    });
    expect(listed.statusCode).toBe(200);
    const announcement = listed.json().announcements[0];

    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/admin/announcements/${announcement.id}/withdraw`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: announcement.version + 1 }
    });
    expect(stale.statusCode).toBe(409);

    const withdrawn = await app.inject({
      method: "POST",
      url: `/api/v1/admin/announcements/${announcement.id}/withdraw`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: announcement.version }
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().announcement).toMatchObject({
      status: "WITHDRAWN",
      version: announcement.version + 1
    });

    const repeated = await app.inject({
      method: "POST",
      url: `/api/v1/admin/announcements/${announcement.id}/withdraw`,
      headers: { cookie: adminCookie },
      payload: { expectedVersion: announcement.version }
    });
    expect(repeated.statusCode).toBe(409);

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/announcements",
      headers: { cookie: userCookie }
    });
    expect(active.json().announcements).toEqual([]);
    expect(publishedChanges).toBe(3);
  });

  it("撤下公告通过同一编辑接口修改后重新启用", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/api/v1/admin/announcements",
      headers: { cookie: adminCookie }
    });
    const announcement = listed.json().announcements[0];
    expect(announcement).toMatchObject({
      id: announcementId,
      status: "WITHDRAWN",
      version: 3
    });

    const editWithoutReactivation = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/announcements/${announcementId}`,
      headers: { cookie: adminCookie },
      payload: {
        title: "恢复公告",
        bodyMarkdown: "恢复内容",
        expectedVersion: 3,
        reactivate: false
      }
    });
    expect(editWithoutReactivation.statusCode).toBe(409);

    await new Promise((resolve) => setTimeout(resolve, 2));
    const reactivated = await app.inject({
      method: "PUT",
      url: `/api/v1/admin/announcements/${announcementId}`,
      headers: { cookie: adminCookie },
      payload: {
        title: "恢复公告",
        bodyMarkdown: "恢复后请重新阅读。",
        expectedVersion: 3,
        reactivate: true
      }
    });
    expect(reactivated.statusCode).toBe(200);
    expect(reactivated.json().announcement).toMatchObject({
      id: announcementId,
      title: "恢复公告",
      status: "ACTIVE",
      version: 4,
      withdrawnAt: null,
      createdAt: originalCreatedAt
    });
    expect(reactivated.json().announcement.publishedAt).not.toBe(
      announcement.publishedAt
    );

    const active = await app.inject({
      method: "GET",
      url: "/api/v1/announcements",
      headers: { cookie: userCookie }
    });
    expect(active.json().announcements[0]).toMatchObject({
      id: announcementId,
      version: 4
    });
    expect(publishedChanges).toBe(4);

    const actions = (
      database.db
        .prepare(
          "SELECT action FROM audit_logs WHERE entity_type = 'announcement' ORDER BY created_at"
        )
        .all() as Array<{ action: string }>
    ).map((row) => row.action);
    expect(actions).toEqual([
      "ANNOUNCEMENT_CREATE",
      "ANNOUNCEMENT_UPDATE",
      "ANNOUNCEMENT_WITHDRAW",
      "ANNOUNCEMENT_REACTIVATE"
    ]);
  });

  it("拒绝未登录读取公告和普通用户读取管理列表", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/announcements" })).statusCode
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/admin/announcements",
          headers: { cookie: userCookie }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/admin/announcements/${announcementId}`,
          headers: { cookie: userCookie },
          payload: {
            title: "无权编辑",
            bodyMarkdown: "内容",
            expectedVersion: 4,
            reactivate: false
          }
        })
      ).statusCode
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/admin/announcements/${announcementId}/withdraw`,
          headers: { cookie: userCookie },
          payload: { expectedVersion: 4 }
        })
      ).statusCode
    ).toBe(403);
  });
});
