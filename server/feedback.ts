import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  FEEDBACK_LEVELS,
  FEEDBACK_STATUSES,
  FEEDBACK_TERMINAL_STATUSES,
  FEEDBACK_TYPES,
  feedbackLevelLabels,
  feedbackStatusLabels,
  feedbackTypeLabels,
  formatFeedbackNumber,
  isFeedbackCommentable,
  isFeedbackLevelValid,
  isFeedbackStatusValid,
  isFeedbackTerminal,
  type FeedbackLevel,
  type FeedbackStatus,
  type FeedbackType
} from "../src/shared/feedback.js";
import { requireAuth, requireSystemAdmin } from "./auth.js";
import { BusinessError } from "./business-error.js";
import { config } from "./config.js";
import { addAudit, db, nowIso, withImmediateTransaction } from "./db.js";
import { createNotification } from "./mailer.js";

const MAX_FILES_PER_MESSAGE = 5;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGE_BYTES = 20 * 1024 * 1024;
const MAX_TICKET_BYTES = 50 * 1024 * 1024;
const MAX_USER_BYTES = 500 * 1024 * 1024;
const IMAGE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const feedbackImageRoot = path.join(path.dirname(config.databasePath), "feedback-images");
const feedbackTempRoot = path.join(feedbackImageRoot, ".tmp");

type TicketRow = {
  number: number;
  id: string;
  type: FeedbackType;
  level: FeedbackLevel;
  status: FeedbackStatus;
  title: string;
  body_markdown: string;
  submitted_by: string | null;
  submitted_by_name: string;
  version: number;
  created_at: string;
  updated_at: string;
  withdrawn_at: string | null;
};

type AttachmentRow = {
  id: string;
  feedback_id: string;
  activity_id: string | null;
  uploaded_by: string | null;
  original_name: string;
  stored_name: string;
  mime_type: string;
  byte_size: number;
  removed_at: string | null;
  purged_at: string | null;
  created_at: string;
};

type ActivityRow = {
  id: string;
  feedback_id: string;
  actor_user_id: string | null;
  actor_name: string;
  kind: "CREATED" | "CONTENT_UPDATED" | "STATUS_CHANGED" | "LEVEL_CHANGED" | "COMMENT" | "WITHDRAWN";
  body_markdown: string;
  from_status: FeedbackStatus | null;
  to_status: FeedbackStatus | null;
  from_level: FeedbackLevel | null;
  to_level: FeedbackLevel | null;
  changed_fields_json: string;
  created_at: string;
};

type Upload = {
  originalName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Buffer;
};

type StagedUpload = Upload & {
  id: string;
  storedName: string;
  tempPath: string;
  finalPath: string;
};

const typeSchema = z.enum(FEEDBACK_TYPES);
const levelSchema = z.enum(FEEDBACK_LEVELS);
const statusSchema = z.enum(FEEDBACK_STATUSES);
const titleSchema = z.string().trim().min(1, "请输入标题").max(120);
const bodySchema = z.string().max(10_000).refine((value) => value.trim().length > 0, "请输入内容");
const expectedVersionSchema = z.number().int().min(1);

const createInput = z.object({
  type: typeSchema,
  level: levelSchema,
  title: titleSchema,
  bodyMarkdown: bodySchema
}).strict();

const updateInput = z.object({
  expectedVersion: expectedVersionSchema,
  level: levelSchema,
  title: titleSchema,
  bodyMarkdown: bodySchema,
  retainedAttachmentIds: z.array(z.string().uuid()).max(MAX_FILES_PER_MESSAGE).default([])
}).strict();

const commentInput = z.object({ bodyMarkdown: bodySchema }).strict();
const statusInput = z.object({
  expectedVersion: expectedVersionSchema,
  status: statusSchema,
  processingNote: bodySchema
}).strict();
const levelInput = z.object({
  expectedVersion: expectedVersionSchema,
  level: levelSchema
}).strict();

function parseJsonField(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new BusinessError("metadata 必须是有效 JSON");
  }
}

function detectedImageType(bytes: Buffer) {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png" as const;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg" as const;
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp" as const;
  return null;
}

async function readMultipart(request: FastifyRequest) {
  if (!request.isMultipart()) throw new BusinessError("请使用 multipart/form-data 提交");
  let metadata: unknown;
  const uploads: Upload[] = [];
  let totalBytes = 0;
  for await (const part of request.parts({
    limits: { files: MAX_FILES_PER_MESSAGE, fileSize: MAX_FILE_BYTES, fields: 5, parts: 10 }
  })) {
    if (part.type === "field") {
      if (part.fieldname !== "metadata" || typeof part.value !== "string" || metadata !== undefined) {
        throw new BusinessError("表单字段无效");
      }
      metadata = parseJsonField(part.value);
      continue;
    }
    if (part.fieldname !== "images") throw new BusinessError("文件字段必须命名为 images");
    const bytes = await part.toBuffer();
    if (part.file.truncated || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      throw new BusinessError("每张图片不能超过 5 MB");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_MESSAGE_BYTES) throw new BusinessError("每次提交的图片合计不能超过 20 MB");
    const detected = detectedImageType(bytes);
    if (!detected || detected !== part.mimetype) {
      throw new BusinessError("仅支持真实的 PNG、JPEG 或 WebP 图片");
    }
    uploads.push({
      originalName: path.basename(part.filename || "image").slice(0, 255),
      mimeType: detected,
      bytes
    });
  }
  if (metadata === undefined) throw new BusinessError("缺少 metadata 字段");
  return { metadata, uploads };
}

function stageUploads(uploads: Upload[]) {
  fs.mkdirSync(feedbackTempRoot, { recursive: true, mode: 0o700 });
  const staged: StagedUpload[] = [];
  try {
    for (const upload of uploads) {
      const id = randomUUID();
      const extension = upload.mimeType === "image/png" ? ".png" : upload.mimeType === "image/jpeg" ? ".jpg" : ".webp";
      const storedName = `${randomUUID()}${extension}`;
      const tempPath = path.join(feedbackTempRoot, `${storedName}.upload`);
      const finalPath = path.join(feedbackImageRoot, storedName);
      fs.writeFileSync(tempPath, upload.bytes, { flag: "wx", mode: 0o600 });
      staged.push({ ...upload, id, storedName, tempPath, finalPath });
    }
    return staged;
  } catch (error) {
    for (const upload of staged) fs.rmSync(upload.tempPath, { force: true });
    throw error;
  }
}

function discardStaged(staged: StagedUpload[]) {
  for (const upload of staged) {
    fs.rmSync(upload.tempPath, { force: true });
    fs.rmSync(upload.finalPath, { force: true });
  }
}

function installStaged(staged: StagedUpload[]) {
  fs.mkdirSync(feedbackImageRoot, { recursive: true, mode: 0o700 });
  for (const upload of staged) fs.renameSync(upload.tempPath, upload.finalPath);
}

function assertQuota(userId: string, ticketId: string | null, addedBytes: number) {
  if (!addedBytes) return;
  const userBytes = (db.prepare(
    `SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM feedback_attachments
     WHERE uploaded_by = ? AND purged_at IS NULL`
  ).get(userId) as { bytes: number }).bytes;
  if (userBytes + addedBytes > MAX_USER_BYTES) throw new BusinessError("你的反馈图片累计空间已达到 500 MB");
  if (ticketId) {
    const ticketBytes = (db.prepare(
      `SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM feedback_attachments
       WHERE feedback_id = ? AND purged_at IS NULL`
    ).get(ticketId) as { bytes: number }).bytes;
    if (ticketBytes + addedBytes > MAX_TICKET_BYTES) throw new BusinessError("该反馈的图片累计空间不能超过 50 MB");
  }
}

function insertAttachments(ticketId: string, activityId: string | null, userId: string, staged: StagedUpload[], createdAt: string) {
  const statement = db.prepare(
    `INSERT INTO feedback_attachments(
      id, feedback_id, activity_id, uploaded_by, original_name,
      stored_name, mime_type, byte_size, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const upload of staged) {
    statement.run(
      upload.id, ticketId, activityId, userId, upload.originalName,
      upload.storedName, upload.mimeType, upload.bytes.length, createdAt
    );
  }
}

function mapAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    originalName: row.original_name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentUrl: `/api/v1/feedback/attachments/${row.id}/content`,
    createdAt: row.created_at
  };
}

function mapSummary(row: TicketRow) {
  return {
    id: row.id,
    number: row.number,
    displayNumber: formatFeedbackNumber(row.number),
    type: row.type,
    level: row.level,
    status: row.status,
    title: row.title,
    submittedByName: row.submitted_by_name || "已删除用户",
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function loadDetail(row: TicketRow, canManage: boolean) {
  const attachmentRows = db.prepare(
    `SELECT * FROM feedback_attachments
     WHERE feedback_id = ? AND removed_at IS NULL AND purged_at IS NULL
     ORDER BY created_at, id`
  ).all(row.id) as AttachmentRow[];
  const activities = db.prepare(
    `SELECT * FROM feedback_activities WHERE feedback_id = ? ORDER BY created_at, id`
  ).all(row.id) as ActivityRow[];
  const byActivity = new Map<string, AttachmentRow[]>();
  for (const attachment of attachmentRows) {
    if (!attachment.activity_id) continue;
    const values = byActivity.get(attachment.activity_id) ?? [];
    values.push(attachment);
    byActivity.set(attachment.activity_id, values);
  }
  const editable = !isFeedbackTerminal(row.status);
  return {
    ...mapSummary(row),
    bodyMarkdown: row.body_markdown,
    attachments: attachmentRows.filter((item) => item.activity_id === null).map(mapAttachment),
    activities: activities.map((activity) => ({
      id: activity.id,
      kind: activity.kind,
      actorName: activity.actor_name || "已删除用户",
      bodyMarkdown: activity.body_markdown,
      fromStatus: activity.from_status,
      toStatus: activity.to_status,
      fromLevel: activity.from_level,
      toLevel: activity.to_level,
      changedFields: safeStringArray(activity.changed_fields_json),
      attachments: (byActivity.get(activity.id) ?? []).map(mapAttachment),
      createdAt: activity.created_at
    })),
    canEdit: canManage ? row.status !== "WITHDRAWN" : editable,
    canWithdraw: !canManage && editable,
    canComment: isFeedbackCommentable(row.status)
  };
}

function safeStringArray(raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function findTicket(id: string) {
  return db.prepare("SELECT * FROM feedback_tickets WHERE id = ?").get(id) as TicketRow | undefined;
}

function requireOwnedTicket(id: string, userId: string) {
  const row = findTicket(id);
  if (!row || row.submitted_by !== userId) throw new BusinessError("反馈不存在", 404);
  return row;
}

function stale() {
  throw new BusinessError("反馈已被更新，请刷新后重试", 409, undefined, "FEEDBACK_STALE");
}

function activeAdminIds(exceptUserId?: string) {
  return (db.prepare(
    `SELECT id FROM users
     WHERE role = 'SYSTEM_ADMIN' AND status = 'ACTIVE' AND id != COALESCE(?, '')
       AND NOT EXISTS (SELECT 1 FROM deleted_user_tombstones d WHERE d.user_id = users.id)`
  ).all(exceptUserId ?? null) as Array<{ id: string }>).map((row) => row.id);
}

function notifyAdmins(ticket: TicketRow, actorId: string, type: string, title: string, body: string) {
  for (const adminId of activeAdminIds(actorId)) {
    createNotification(
      adminId, type, title, body, `/admin/feedback/${ticket.id}`, false,
      { type: "FEEDBACK", id: ticket.id }
    );
  }
}

function notifyOwner(ticket: TicketRow, actorId: string, type: string, title: string, body: string) {
  if (!ticket.submitted_by || ticket.submitted_by === actorId) return;
  createNotification(
    ticket.submitted_by, type, title, body, `/feedback/${ticket.id}`, false,
    { type: "FEEDBACK", id: ticket.id }
  );
}

function markFeedbackRead(userId: string, ticketId: string) {
  return db.prepare(
    `UPDATE notifications SET read_at = COALESCE(read_at, ?)
     WHERE user_id = ? AND entity_type = 'FEEDBACK' AND entity_id = ? AND read_at IS NULL`
  ).run(nowIso(), userId, ticketId).changes;
}

function decodeCursor(raw: string | undefined) {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    return z.object({ updatedAt: z.string(), number: z.number().int().positive() }).strict().parse(value);
  } catch {
    throw new BusinessError("分页游标无效");
  }
}

function encodeCursor(row: TicketRow) {
  return Buffer.from(JSON.stringify({ updatedAt: row.updated_at, number: row.number })).toString("base64url");
}

function decodeAdminCursor(raw: string | undefined) {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    return z.object({
      terminalRank: z.number().int().min(0).max(1),
      levelRank: z.number().int().min(1).max(4),
      updatedAt: z.string(),
      number: z.number().int().positive()
    }).strict().parse(value);
  } catch {
    throw new BusinessError("分页游标无效");
  }
}

function encodeAdminCursor(row: TicketRow & { terminal_rank: number; level_rank: number }) {
  return Buffer.from(JSON.stringify({
    terminalRank: row.terminal_rank,
    levelRank: row.level_rank,
    updatedAt: row.updated_at,
    number: row.number
  })).toString("base64url");
}

function validateTypeLevel(type: FeedbackType, level: FeedbackLevel) {
  if (!isFeedbackLevelValid(type, level)) throw new BusinessError("反馈类型与等级不匹配");
}

function totalUploadBytes(staged: StagedUpload[]) {
  return staged.reduce((sum, item) => sum + item.bytes.length, 0);
}

export function cleanupFeedbackAttachments() {
  fs.mkdirSync(feedbackImageRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(feedbackTempRoot, { recursive: true, mode: 0o700 });
  const cutoff = new Date(Date.now() - IMAGE_RETENTION_MS).toISOString();
  const rows = db.prepare(
    `SELECT id, stored_name FROM feedback_attachments
     WHERE removed_at IS NOT NULL AND removed_at <= ? AND purged_at IS NULL`
  ).all(cutoff) as Array<{ id: string; stored_name: string }>;
  const purgedAt = nowIso();
  for (const row of rows) {
    fs.rmSync(path.join(feedbackImageRoot, path.basename(row.stored_name)), { force: true });
    db.prepare("UPDATE feedback_attachments SET purged_at = ? WHERE id = ? AND purged_at IS NULL")
      .run(purgedAt, row.id);
  }
  for (const name of fs.readdirSync(feedbackTempRoot)) {
    const candidate = path.join(feedbackTempRoot, name);
    const stat = fs.statSync(candidate);
    if (stat.isFile() && stat.mtimeMs <= Date.now() - 24 * 60 * 60 * 1000) fs.rmSync(candidate, { force: true });
  }
  return rows.length;
}

export function registerFeedbackRoutes(app: FastifyInstance, publishFeedbackChange: () => void) {
  app.get("/api/v1/feedback", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const query = z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      type: typeSchema.optional(), status: statusSchema.optional(), level: levelSchema.optional()
    }).parse(request.query);
    const cursor = decodeCursor(query.cursor);
    const clauses = ["submitted_by = ?"];
    const params: unknown[] = [auth.user.id];
    for (const [column, value] of [["type", query.type], ["status", query.status], ["level", query.level]] as const) {
      if (value) { clauses.push(`${column} = ?`); params.push(value); }
    }
    if (cursor) {
      clauses.push("(updated_at < ? OR (updated_at = ? AND number < ?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.number);
    }
    params.push(query.limit + 1);
    const rows = db.prepare(
      `SELECT * FROM feedback_tickets WHERE ${clauses.join(" AND ")}
       ORDER BY updated_at DESC, number DESC LIMIT ?`
    ).all(...params) as TicketRow[];
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return { tickets: page.map(mapSummary), nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null };
  });

  app.post("/api/v1/feedback", { bodyLimit: MAX_MESSAGE_BYTES + 128 * 1024 }, async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const multipart = await readMultipart(request);
    const input = createInput.parse(multipart.metadata);
    validateTypeLevel(input.type, input.level);
    const staged = stageUploads(multipart.uploads);
    const id = randomUUID();
    const activityId = randomUUID();
    const createdAt = nowIso();
    try {
      const ticket = withImmediateTransaction(() => {
        assertQuota(auth.user.id, null, totalUploadBytes(staged));
        installStaged(staged);
        db.prepare(
          `INSERT INTO feedback_tickets(
            id, type, level, title, body_markdown, submitted_by,
            submitted_by_name, created_at, updated_at
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(id, input.type, input.level, input.title, input.bodyMarkdown, auth.user.id, auth.user.displayName, createdAt, createdAt);
        db.prepare(
          `INSERT INTO feedback_activities(
            id, feedback_id, actor_user_id, actor_name, kind, created_at
          ) VALUES(?, ?, ?, ?, 'CREATED', ?)`
        ).run(activityId, id, auth.user.id, auth.user.displayName, createdAt);
        insertAttachments(id, null, auth.user.id, staged, createdAt);
        const created = findTicket(id)!;
        addAudit(auth.user.id, "FEEDBACK_CREATE", "feedback", id, undefined, {
          number: created.number, type: created.type, status: created.status, level: created.level,
          titleLength: created.title.length, bodyLength: created.body_markdown.length, attachmentCount: staged.length
        });
        notifyAdmins(created, auth.user.id, "FEEDBACK_CREATED", `新反馈 ${formatFeedbackNumber(created.number)}`, `${auth.user.displayName} 提交了${feedbackTypeLabels[created.type]}“${created.title}”`);
        return created;
      });
      publishFeedbackChange();
      return reply.code(201).send({ ticket: loadDetail(ticket, false) });
    } catch (error) {
      discardStaged(staged);
      throw error;
    }
  });

  app.get("/api/v1/feedback/attachments/:id/content", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const row = db.prepare(
      `SELECT fa.*, ft.submitted_by FROM feedback_attachments fa
       JOIN feedback_tickets ft ON ft.id = fa.feedback_id
       WHERE fa.id = ? AND fa.removed_at IS NULL AND fa.purged_at IS NULL`
    ).get(id) as (AttachmentRow & { submitted_by: string | null }) | undefined;
    if (!row || (auth.user.role !== "SYSTEM_ADMIN" && row.submitted_by !== auth.user.id)) {
      return reply.code(404).send({ error: "图片不存在" });
    }
    const filePath = path.join(feedbackImageRoot, path.basename(row.stored_name));
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "图片不存在" });
    return reply
      .type(row.mime_type)
      .header("Cache-Control", "private, max-age=300")
      .header("X-Content-Type-Options", "nosniff")
      .header("Content-Disposition", "inline")
      .send(fs.createReadStream(filePath));
  });

  app.get("/api/v1/feedback/:id", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ticket = requireOwnedTicket(id, auth.user.id);
    markFeedbackRead(auth.user.id, id);
    return { ticket: loadDetail(ticket, false) };
  });

  app.post("/api/v1/feedback/:id/read", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    requireOwnedTicket(id, auth.user.id);
    return { updatedCount: markFeedbackRead(auth.user.id, id) };
  });

  app.put("/api/v1/feedback/:id", { bodyLimit: MAX_MESSAGE_BYTES + 128 * 1024 }, async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const multipart = await readMultipart(request);
    const input = updateInput.parse(multipart.metadata);
    const staged = stageUploads(multipart.uploads);
    try {
      const updated = withImmediateTransaction(() => {
        const current = requireOwnedTicket(id, auth.user.id);
        if (current.version !== input.expectedVersion) stale();
        if (isFeedbackTerminal(current.status)) throw new BusinessError("当前状态不能修改反馈", 409);
        validateTypeLevel(current.type, input.level);
        const currentAttachments = db.prepare(
          `SELECT * FROM feedback_attachments WHERE feedback_id = ? AND activity_id IS NULL
           AND removed_at IS NULL AND purged_at IS NULL`
        ).all(id) as AttachmentRow[];
        const currentIds = new Set(currentAttachments.map((item) => item.id));
        if (input.retainedAttachmentIds.some((attachmentId) => !currentIds.has(attachmentId))) {
          throw new BusinessError("保留的图片已变化，请刷新后重试", 409, undefined, "FEEDBACK_STALE");
        }
        const retained = currentAttachments.filter((item) => input.retainedAttachmentIds.includes(item.id));
        if (retained.length + staged.length > MAX_FILES_PER_MESSAGE) throw new BusinessError("正文最多保留 5 张图片");
        if (retained.reduce((sum, item) => sum + item.byte_size, 0) + totalUploadBytes(staged) > MAX_MESSAGE_BYTES) {
          throw new BusinessError("正文图片合计不能超过 20 MB");
        }
        assertQuota(auth.user.id, id, totalUploadBytes(staged));
        installStaged(staged);
        const changedFields = [
          ...(current.title !== input.title ? ["title"] : []),
          ...(current.body_markdown !== input.bodyMarkdown ? ["bodyMarkdown"] : []),
          ...(current.level !== input.level ? ["level"] : []),
          ...(retained.length !== currentAttachments.length || staged.length ? ["attachments"] : [])
        ];
        const updatedAt = nowIso();
        const result = db.prepare(
          `UPDATE feedback_tickets SET title = ?, body_markdown = ?, level = ?,
             version = version + 1, updated_at = ? WHERE id = ? AND version = ?`
        ).run(input.title, input.bodyMarkdown, input.level, updatedAt, id, input.expectedVersion);
        if (!result.changes) stale();
        if (currentAttachments.length) {
          const removedAt = nowIso();
          for (const attachment of currentAttachments) {
            if (!input.retainedAttachmentIds.includes(attachment.id)) {
              db.prepare("UPDATE feedback_attachments SET removed_at = ? WHERE id = ?").run(removedAt, attachment.id);
            }
          }
        }
        insertAttachments(id, null, auth.user.id, staged, updatedAt);
        const activityId = randomUUID();
        db.prepare(
          `INSERT INTO feedback_activities(
            id, feedback_id, actor_user_id, actor_name, kind,
            from_level, to_level, changed_fields_json, created_at
          ) VALUES(?, ?, ?, ?, 'CONTENT_UPDATED', ?, ?, ?, ?)`
        ).run(activityId, id, auth.user.id, auth.user.displayName, current.level, input.level, JSON.stringify(changedFields), updatedAt);
        const ticket = findTicket(id)!;
        addAudit(auth.user.id, "FEEDBACK_UPDATE", "feedback", id,
          { number: current.number, type: current.type, status: current.status, level: current.level, titleLength: current.title.length, bodyLength: current.body_markdown.length },
          { number: ticket.number, type: ticket.type, status: ticket.status, level: ticket.level, titleLength: ticket.title.length, bodyLength: ticket.body_markdown.length, changedFields });
        notifyAdmins(ticket, auth.user.id, "FEEDBACK_UPDATED", `${formatFeedbackNumber(ticket.number)} 已更新`, `${auth.user.displayName} 更新了反馈“${ticket.title}”`);
        return ticket;
      });
      publishFeedbackChange();
      return { ticket: loadDetail(updated, false) };
    } catch (error) {
      discardStaged(staged);
      throw error;
    }
  });

  app.post("/api/v1/feedback/:id/withdraw", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z.object({ expectedVersion: expectedVersionSchema }).strict().parse(request.body);
    const updated = withImmediateTransaction(() => {
      const current = requireOwnedTicket(id, auth.user.id);
      if (current.version !== expectedVersion) stale();
      if (isFeedbackTerminal(current.status)) throw new BusinessError("当前状态不能撤回", 409);
      const changedAt = nowIso();
      const result = db.prepare(
        `UPDATE feedback_tickets SET status = 'WITHDRAWN', version = version + 1,
         withdrawn_at = ?, updated_at = ? WHERE id = ? AND version = ?`
      ).run(changedAt, changedAt, id, expectedVersion);
      if (!result.changes) stale();
      db.prepare(
        `INSERT INTO feedback_activities(
          id, feedback_id, actor_user_id, actor_name, kind, from_status, to_status, created_at
        ) VALUES(?, ?, ?, ?, 'WITHDRAWN', ?, 'WITHDRAWN', ?)`
      ).run(randomUUID(), id, auth.user.id, auth.user.displayName, current.status, changedAt);
      const ticket = findTicket(id)!;
      addAudit(auth.user.id, "FEEDBACK_WITHDRAW", "feedback", id,
        { number: current.number, type: current.type, status: current.status, level: current.level },
        { number: ticket.number, type: ticket.type, status: ticket.status, level: ticket.level });
      notifyAdmins(ticket, auth.user.id, "FEEDBACK_WITHDRAWN", `${formatFeedbackNumber(ticket.number)} 已撤回`, `${auth.user.displayName} 撤回了反馈“${ticket.title}”`);
      return ticket;
    });
    publishFeedbackChange();
    return { ticket: loadDetail(updated, false) };
  });

  async function addComment(request: FastifyRequest, reply: FastifyReply, admin: boolean) {
    const auth = admin ? requireSystemAdmin(request, reply) : requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const multipart = await readMultipart(request);
    const input = commentInput.parse(multipart.metadata);
    const staged = stageUploads(multipart.uploads);
    try {
      const ticket = withImmediateTransaction(() => {
        const current = admin ? findTicket(id) : requireOwnedTicket(id, auth.user.id);
        if (!current) throw new BusinessError("反馈不存在", 404);
        if (!isFeedbackCommentable(current.status)) throw new BusinessError("已撤回反馈不能评论", 409);
        assertQuota(auth.user.id, id, totalUploadBytes(staged));
        installStaged(staged);
        const activityId = randomUUID();
        const createdAt = nowIso();
        db.prepare(
          `INSERT INTO feedback_activities(
            id, feedback_id, actor_user_id, actor_name, kind, body_markdown, created_at
          ) VALUES(?, ?, ?, ?, 'COMMENT', ?, ?)`
        ).run(activityId, id, auth.user.id, auth.user.displayName, input.bodyMarkdown, createdAt);
        insertAttachments(id, activityId, auth.user.id, staged, createdAt);
        db.prepare("UPDATE feedback_tickets SET updated_at = ? WHERE id = ?").run(createdAt, id);
        const updated = findTicket(id)!;
        addAudit(auth.user.id, admin ? "FEEDBACK_ADMIN_COMMENT" : "FEEDBACK_USER_COMMENT", "feedback", id, undefined, {
          number: updated.number, type: updated.type, status: updated.status, level: updated.level,
          commentLength: input.bodyMarkdown.length, attachmentCount: staged.length
        });
        if (admin) {
          notifyOwner(updated, auth.user.id, "FEEDBACK_ADMIN_COMMENT", `${formatFeedbackNumber(updated.number)} 有管理员回复`, `${auth.user.displayName} 回复了你的反馈“${updated.title}”`);
        } else {
          notifyAdmins(updated, auth.user.id, "FEEDBACK_USER_COMMENT", `${formatFeedbackNumber(updated.number)} 有新评论`, `${auth.user.displayName} 追加了评论`);
        }
        return updated;
      });
      publishFeedbackChange();
      return { ticket: loadDetail(ticket, admin) };
    } catch (error) {
      discardStaged(staged);
      throw error;
    }
  }

  app.post("/api/v1/feedback/:id/comments", { bodyLimit: MAX_MESSAGE_BYTES + 128 * 1024 }, (request, reply) => addComment(request, reply, false));

  app.get("/api/v1/admin/feedback/summary", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const placeholders = FEEDBACK_TERMINAL_STATUSES.map(() => "?").join(", ");
    const open = db.prepare(
      `SELECT COUNT(*) AS count FROM feedback_tickets WHERE status NOT IN (${placeholders})`
    ).get(...FEEDBACK_TERMINAL_STATUSES) as { count: number };
    return { openCount: open.count };
  });

  app.get("/api/v1/admin/feedback", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const query = z.object({
      cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
      search: z.string().trim().max(120).optional(), type: typeSchema.optional(),
      status: statusSchema.optional(), level: levelSchema.optional()
    }).parse(request.query);
    const cursor = decodeAdminCursor(query.cursor);
    const clauses = ["1 = 1"];
    const params: unknown[] = [];
    if (query.search) {
      const number = /^FB-(\d+)$/iu.exec(query.search)?.[1];
      clauses.push(number ? "number = ?" : "title LIKE ? ESCAPE '\\'");
      params.push(number ? Number(number) : `%${query.search.replace(/[\\%_]/gu, "\\$&")}%`);
    }
    for (const [column, value] of [["type", query.type], ["status", query.status], ["level", query.level]] as const) {
      if (value) { clauses.push(`${column} = ?`); params.push(value); }
    }
    const terminalExpression = "CASE WHEN status IN ('FIXED','IMPLEMENTED','REJECTED','WITHDRAWN') THEN 1 ELSE 0 END";
    const levelExpression = "CASE level WHEN 'FATAL' THEN 4 WHEN 'VERY_URGENT' THEN 4 WHEN 'SERIOUS' THEN 3 WHEN 'URGENT' THEN 3 WHEN 'NORMAL' THEN 2 ELSE 1 END";
    if (cursor) {
      clauses.push(`(
        ${terminalExpression} > ? OR
        (${terminalExpression} = ? AND ${levelExpression} < ?) OR
        (${terminalExpression} = ? AND ${levelExpression} = ? AND updated_at < ?) OR
        (${terminalExpression} = ? AND ${levelExpression} = ? AND updated_at = ? AND number < ?)
      )`);
      params.push(
        cursor.terminalRank,
        cursor.terminalRank, cursor.levelRank,
        cursor.terminalRank, cursor.levelRank, cursor.updatedAt,
        cursor.terminalRank, cursor.levelRank, cursor.updatedAt, cursor.number
      );
    }
    params.push(query.limit + 1);
    const rows = db.prepare(
      `SELECT *, ${terminalExpression} AS terminal_rank, ${levelExpression} AS level_rank
       FROM feedback_tickets WHERE ${clauses.join(" AND ")}
       ORDER BY
         terminal_rank,
         level_rank DESC,
         updated_at DESC, number DESC LIMIT ?`
    ).all(...params) as Array<TicketRow & { terminal_rank: number; level_rank: number }>;
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return { tickets: page.map(mapSummary), nextCursor: hasMore ? encodeAdminCursor(page[page.length - 1]) : null };
  });

  app.get("/api/v1/admin/feedback/:id", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const ticket = findTicket(id);
    if (!ticket) return reply.code(404).send({ error: "反馈不存在" });
    markFeedbackRead(auth.user.id, id);
    return { ticket: loadDetail(ticket, true) };
  });

  app.put("/api/v1/admin/feedback/:id/status", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = statusInput.parse(request.body);
    const ticket = withImmediateTransaction(() => {
      const current = findTicket(id);
      if (!current) throw new BusinessError("反馈不存在", 404);
      if (current.version !== input.expectedVersion) stale();
      if (current.status === "WITHDRAWN") throw new BusinessError("已撤回反馈完全只读", 409);
      if (!isFeedbackStatusValid(current.type, input.status)) throw new BusinessError("反馈类型与状态不匹配");
      if (current.status === input.status) throw new BusinessError("请选择不同的状态");
      const changedAt = nowIso();
      const result = db.prepare(
        `UPDATE feedback_tickets SET status = ?, version = version + 1,
           withdrawn_at = CASE WHEN ? = 'WITHDRAWN' THEN ? ELSE NULL END,
           updated_at = ? WHERE id = ? AND version = ?`
      ).run(input.status, input.status, changedAt, changedAt, id, input.expectedVersion);
      if (!result.changes) stale();
      db.prepare(
        `INSERT INTO feedback_activities(
          id, feedback_id, actor_user_id, actor_name, kind, body_markdown,
          from_status, to_status, created_at
        ) VALUES(?, ?, ?, ?, 'STATUS_CHANGED', ?, ?, ?, ?)`
      ).run(randomUUID(), id, auth.user.id, auth.user.displayName, input.processingNote, current.status, input.status, changedAt);
      const updated = findTicket(id)!;
      addAudit(auth.user.id, "FEEDBACK_STATUS_CHANGE", "feedback", id,
        { number: current.number, type: current.type, status: current.status, level: current.level },
        { number: updated.number, type: updated.type, status: updated.status, level: updated.level, noteLength: input.processingNote.length });
      notifyOwner(updated, auth.user.id, "FEEDBACK_STATUS_CHANGED", `${formatFeedbackNumber(updated.number)} 状态已更新`, `状态已变更为“${feedbackStatusLabels[updated.status]}”`);
      return updated;
    });
    publishFeedbackChange();
    return { ticket: loadDetail(ticket, true) };
  });

  app.put("/api/v1/admin/feedback/:id/level", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = levelInput.parse(request.body);
    const ticket = withImmediateTransaction(() => {
      const current = findTicket(id);
      if (!current) throw new BusinessError("反馈不存在", 404);
      if (current.version !== input.expectedVersion) stale();
      if (current.status === "WITHDRAWN") throw new BusinessError("已撤回反馈完全只读", 409);
      validateTypeLevel(current.type, input.level);
      if (current.level === input.level) throw new BusinessError("请选择不同的等级");
      const changedAt = nowIso();
      const result = db.prepare(
        "UPDATE feedback_tickets SET level = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?"
      ).run(input.level, changedAt, id, input.expectedVersion);
      if (!result.changes) stale();
      db.prepare(
        `INSERT INTO feedback_activities(
          id, feedback_id, actor_user_id, actor_name, kind, from_level, to_level, created_at
        ) VALUES(?, ?, ?, ?, 'LEVEL_CHANGED', ?, ?, ?)`
      ).run(randomUUID(), id, auth.user.id, auth.user.displayName, current.level, input.level, changedAt);
      const updated = findTicket(id)!;
      addAudit(auth.user.id, "FEEDBACK_LEVEL_CHANGE", "feedback", id,
        { number: current.number, type: current.type, status: current.status, level: current.level },
        { number: updated.number, type: updated.type, status: updated.status, level: updated.level });
      notifyOwner(updated, auth.user.id, "FEEDBACK_LEVEL_CHANGED", `${formatFeedbackNumber(updated.number)} 等级已更新`, `等级已变更为“${feedbackLevelLabels[updated.level]}”`);
      return updated;
    });
    publishFeedbackChange();
    return { ticket: loadDetail(ticket, true) };
  });

  app.post("/api/v1/admin/feedback/:id/comments", { bodyLimit: MAX_MESSAGE_BYTES + 128 * 1024 }, (request, reply) => addComment(request, reply, true));
}
