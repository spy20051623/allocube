import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-feedback-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "feedback.sqlite");
process.env.SEED_DEMO_DATA = "false";
process.env.BOOTSTRAP_ADMIN_NAME = "反馈管理员";
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
process.env.SESSION_SECRET = "feedback-test-session-secret-at-least-32-characters";

let app: ReturnType<typeof Fastify>;
let database: typeof import("../server/db.js");
let adminCookie = "";
let userCookie = "";
let otherCookie = "";
let ticketId = "";
let attachmentId = "";
let revisionEvents = 0;

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function multipartRequest(
  metadata: unknown,
  files: Array<{ name: string; mime: string; bytes: Buffer }> = []
) {
  const boundary = `----allocube-${randomUUID()}`;
  const chunks: Buffer[] = [];
  const append = (value: string | Buffer) => chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  append(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n`);
  for (const file of files) {
    append(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${file.name}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
    append(file.bytes);
    append("\r\n");
  }
  append(`--${boundary}--\r\n`);
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  };
}

async function loginCookie(identifier: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { identifierType: "USERNAME", identifier, password }
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
}

async function createUser(username: string, displayName: string, password: string) {
  const { hashPassword } = await import("../server/auth.js");
  const now = database.nowIso();
  database.db.prepare(
    `INSERT INTO users(
      id, username, username_normalized, display_name, password_hash,
      role, status, approved_at, created_at, updated_at
    ) VALUES(?, ?, ?, ?, ?, 'USER', 'ACTIVE', ?, ?, ?)`
  ).run(randomUUID(), username, username.toLocaleLowerCase("zh-CN"), displayName, await hashPassword(password), now, now, now);
}

beforeAll(async () => {
  database = await import("../server/db.js");
  const { BusinessError } = await import("../server/business-error.js");
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerFeedbackRoutes } = await import("../server/feedback.js");
  await database.initializeDatabase();
  await createUser("反馈用户", "反馈用户", "FeedbackUser123!");
  await createUser("其他用户", "其他用户", "OtherUser123!");

  app = Fastify();
  await app.register(cookie, { secret: process.env.SESSION_SECRET! });
  await app.register(multipart, { limits: { files: 5, fileSize: 5 * 1024 * 1024 } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof BusinessError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "输入内容不符合要求" });
    return reply.send(error);
  });
  registerAuthRoutes(app);
  registerFeedbackRoutes(app, () => { revisionEvents += 1; });
  await app.ready();
  adminCookie = await loginCookie("Administrator", "Admin12#$");
  userCookie = await loginCookie("反馈用户", "FeedbackUser123!");
  otherCookie = await loginCookie("其他用户", "OtherUser123!");
});

describe("反馈系统", () => {
  it("创建私有问题单并通知共享管理员队列", async () => {
    const form = multipartRequest(
      { type: "ISSUE", level: "SERIOUS", title: "无法启动任务", bodyMarkdown: "## 问题描述\n启动失败" },
      [{ name: "evidence.png", mime: "image/png", bytes: png }]
    );
    const response = await app.inject({
      method: "POST", url: "/api/v1/feedback", headers: { cookie: userCookie, ...form.headers }, payload: form.payload
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().ticket).toMatchObject({
      displayNumber: "FB-000001", type: "ISSUE", level: "SERIOUS", status: "SUBMITTED", version: 1
    });
    ticketId = response.json().ticket.id;
    attachmentId = response.json().ticket.attachments[0].id;
    expect(revisionEvents).toBe(1);

    const adminQueue = await app.inject({ method: "GET", url: "/api/v1/admin/feedback", headers: { cookie: adminCookie } });
    expect(adminQueue.statusCode).toBe(200);
    expect(adminQueue.json().tickets[0].id).toBe(ticketId);
    const summary = await app.inject({ method: "GET", url: "/api/v1/admin/feedback/summary", headers: { cookie: adminCookie } });
    expect(summary.statusCode).toBe(200);
    expect(summary.json()).toEqual({ openCount: 1 });
    expect(database.db.prepare(
      "SELECT entity_type, entity_id FROM notifications WHERE type = 'FEEDBACK_CREATED'"
    ).get()).toEqual({ entity_type: "FEEDBACK", entity_id: ticketId });
  });

  it("隔离所有者并保护私有图片读取", async () => {
    expect((await app.inject({ method: "GET", url: `/api/v1/feedback/${ticketId}`, headers: { cookie: otherCookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/feedback/attachments/${attachmentId}/content`, headers: { cookie: otherCookie } })).statusCode).toBe(404);

    const ownerImage = await app.inject({ method: "GET", url: `/api/v1/feedback/attachments/${attachmentId}/content`, headers: { cookie: userCookie } });
    expect(ownerImage.statusCode).toBe(200);
    expect(ownerImage.headers["cache-control"]).toContain("private");
    expect(ownerImage.headers["x-content-type-options"]).toBe("nosniff");
    expect((await app.inject({ method: "GET", url: `/api/v1/feedback/attachments/${attachmentId}/content`, headers: { cookie: adminCookie } })).statusCode).toBe(200);
  });

  it("拒绝类型等级错配和伪装图片", async () => {
    const invalidLevel = multipartRequest({
      type: "REQUIREMENT", level: "FATAL", title: "错配等级", bodyMarkdown: "内容"
    });
    expect((await app.inject({
      method: "POST", url: "/api/v1/feedback", headers: { cookie: userCookie, ...invalidLevel.headers }, payload: invalidLevel.payload
    })).statusCode).toBe(400);

    const disguised = multipartRequest(
      { type: "ISSUE", level: "NORMAL", title: "伪装图片", bodyMarkdown: "内容" },
      [{ name: "fake.jpg", mime: "image/jpeg", bytes: png }]
    );
    const response = await app.inject({
      method: "POST", url: "/api/v1/feedback", headers: { cookie: userCookie, ...disguised.headers }, payload: disguised.payload
    });
    expect(response.statusCode).toBe(400);
  });

  it("使用版本号编辑并返回 FEEDBACK_STALE 冲突", async () => {
    const stale = multipartRequest({
      expectedVersion: 9, level: "NORMAL", title: "错误版本", bodyMarkdown: "内容", retainedAttachmentIds: [attachmentId]
    });
    const staleResponse = await app.inject({
      method: "PUT", url: `/api/v1/feedback/${ticketId}`, headers: { cookie: userCookie, ...stale.headers }, payload: stale.payload
    });
    expect(staleResponse.statusCode).toBe(409);
    expect(staleResponse.json().code).toBe("FEEDBACK_STALE");

    const valid = multipartRequest({
      expectedVersion: 1, level: "NORMAL", title: "启动任务失败", bodyMarkdown: "更新后的问题描述", retainedAttachmentIds: [attachmentId]
    });
    const response = await app.inject({
      method: "PUT", url: `/api/v1/feedback/${ticketId}`, headers: { cookie: userCookie, ...valid.headers }, payload: valid.payload
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ticket).toMatchObject({ title: "启动任务失败", level: "NORMAL", status: "SUBMITTED", version: 2 });
  });

  it("管理员状态说明必填，终态仍可评论并可重新打开", async () => {
    const missingNote = await app.inject({
      method: "PUT", url: `/api/v1/admin/feedback/${ticketId}/status`, headers: { cookie: adminCookie },
      payload: { expectedVersion: 2, status: "FIXED", processingNote: "" }
    });
    expect(missingNote.statusCode).toBe(400);

    const fixed = await app.inject({
      method: "PUT", url: `/api/v1/admin/feedback/${ticketId}/status`, headers: { cookie: adminCookie },
      payload: { expectedVersion: 2, status: "FIXED", processingNote: "已在新版本修复" }
    });
    expect(fixed.statusCode).toBe(200);
    expect(fixed.json().ticket).toMatchObject({ status: "FIXED", version: 3 });
    expect((await app.inject({
      method: "GET", url: "/api/v1/admin/feedback/summary", headers: { cookie: adminCookie }
    })).json()).toEqual({ openCount: 0 });

    const blockedEdit = multipartRequest({
      expectedVersion: 3, level: "NORMAL", title: "不能修改", bodyMarkdown: "内容", retainedAttachmentIds: [attachmentId]
    });
    expect((await app.inject({
      method: "PUT", url: `/api/v1/feedback/${ticketId}`, headers: { cookie: userCookie, ...blockedEdit.headers }, payload: blockedEdit.payload
    })).statusCode).toBe(409);

    const comment = multipartRequest({ bodyMarkdown: "已确认恢复正常" });
    expect((await app.inject({
      method: "POST", url: `/api/v1/feedback/${ticketId}/comments`, headers: { cookie: userCookie, ...comment.headers }, payload: comment.payload
    })).statusCode).toBe(200);

    const reopened = await app.inject({
      method: "PUT", url: `/api/v1/admin/feedback/${ticketId}/status`, headers: { cookie: adminCookie },
      payload: { expectedVersion: 3, status: "CONFIRMED", processingNote: "问题再次出现，重新打开" }
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().ticket).toMatchObject({ status: "CONFIRMED", version: 4 });
    expect((await app.inject({
      method: "GET", url: "/api/v1/admin/feedback/summary", headers: { cookie: adminCookie }
    })).json()).toEqual({ openCount: 1 });
  });

  it("撤回后完全只读且不能由管理员恢复", async () => {
    const form = multipartRequest({ type: "REQUIREMENT", level: "URGENT", title: "增加批量操作", bodyMarkdown: "## 需求描述\n批量操作" });
    const created = await app.inject({
      method: "POST", url: "/api/v1/feedback", headers: { cookie: userCookie, ...form.headers }, payload: form.payload
    });
    const id = created.json().ticket.id;
    const withdrawn = await app.inject({
      method: "POST", url: `/api/v1/feedback/${id}/withdraw`, headers: { cookie: userCookie }, payload: { expectedVersion: 1 }
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(withdrawn.json().ticket).toMatchObject({ status: "WITHDRAWN", canComment: false });

    const adminComment = multipartRequest({ bodyMarkdown: "不能评论" });
    expect((await app.inject({
      method: "POST", url: `/api/v1/admin/feedback/${id}/comments`, headers: { cookie: adminCookie, ...adminComment.headers }, payload: adminComment.payload
    })).statusCode).toBe(409);
    expect((await app.inject({
      method: "PUT", url: `/api/v1/admin/feedback/${id}/status`, headers: { cookie: adminCookie },
      payload: { expectedVersion: 2, status: "ADOPTED", processingNote: "尝试恢复" }
    })).statusCode).toBe(409);
  });

  it("打开反馈详情会按实体同步清除反馈通知", async () => {
    const before = database.db.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = '反馈用户') AND entity_id = ? AND read_at IS NULL"
    ).get(ticketId) as { count: number };
    expect(before.count).toBeGreaterThan(0);
    const detail = await app.inject({ method: "GET", url: `/api/v1/feedback/${ticketId}`, headers: { cookie: userCookie } });
    expect(detail.statusCode).toBe(200);
    const after = database.db.prepare(
      "SELECT COUNT(*) AS count FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = '反馈用户') AND entity_id = ? AND read_at IS NULL"
    ).get(ticketId) as { count: number };
    expect(after.count).toBe(0);
  });
});
