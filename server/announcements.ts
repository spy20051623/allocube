import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidAnnouncementInternalLinks } from "../src/shared/announcements.js";
import { requireAuth, requireSystemAdmin } from "./auth.js";
import {
  addAudit,
  db,
  nowIso,
  withImmediateTransaction
} from "./db.js";

type AnnouncementRow = {
  id: string;
  title: string;
  body_markdown: string;
  status: "ACTIVE" | "WITHDRAWN";
  version: number;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  published_at: string;
  updated_at: string;
  withdrawn_at: string | null;
};

const announcementContentFields = {
  title: z.string().trim().min(1).max(120),
  bodyMarkdown: z.string().max(10_000).refine((value) => value.trim().length > 0, {
    message: "请输入公告内容"
  })
};

function validateAnnouncementLinks(
  value: { bodyMarkdown: string },
  context: z.RefinementCtx
) {
    const invalidLinks = invalidAnnouncementInternalLinks(value.bodyMarkdown);
    if (!invalidLinks.length) return;
    context.addIssue({
      code: "custom",
      path: ["bodyMarkdown"],
      message: `站内链接无效：${invalidLinks[0]}`
    });
}

const announcementInput = z
  .object(announcementContentFields)
  .strict()
  .superRefine(validateAnnouncementLinks);

const announcementUpdateInput = z
  .object({
    ...announcementContentFields,
    expectedVersion: z.number().int().min(1),
    reactivate: z.boolean().default(false)
  })
  .strict()
  .superRefine(validateAnnouncementLinks);

function mapAnnouncement(row: AnnouncementRow) {
  return {
    id: row.id,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    status: row.status,
    version: row.version,
    createdByName: row.created_by_name ?? "系统管理员",
    createdAt: row.created_at,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    withdrawnAt: row.withdrawn_at
  };
}

const announcementSelect = `
  SELECT a.*, creator.display_name AS created_by_name
  FROM announcements a
  LEFT JOIN users creator ON creator.id = a.created_by
`;

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  publishAnnouncementChange: () => void
) {
  app.get("/api/v1/announcements", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `${announcementSelect}
         WHERE a.status = 'ACTIVE'
         ORDER BY a.published_at, a.id`
      )
      .all() as AnnouncementRow[];
    return { announcements: rows.map(mapAnnouncement) };
  });

  app.get("/api/v1/admin/announcements", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `${announcementSelect}
         ORDER BY a.published_at DESC, a.id DESC`
      )
      .all() as AnnouncementRow[];
    return { announcements: rows.map(mapAnnouncement) };
  });

  app.post("/api/v1/admin/announcements", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const input = announcementInput.parse(request.body);
    const id = randomUUID();
    const createdAt = nowIso();
    const announcement = withImmediateTransaction(() => {
      db.prepare(
        `INSERT INTO announcements(
           id, title, body_markdown, created_by,
           created_at, published_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.title,
        input.bodyMarkdown,
        auth.user.id,
        createdAt,
        createdAt,
        createdAt
      );
      addAudit(
        auth.user.id,
        "ANNOUNCEMENT_CREATE",
        "announcement",
        id,
        undefined,
        { title: input.title, bodyLength: input.bodyMarkdown.length }
      );
      return db
        .prepare(`${announcementSelect} WHERE a.id = ?`)
        .get(id) as AnnouncementRow;
    });
    publishAnnouncementChange();
    return reply.code(201).send({ announcement: mapAnnouncement(announcement) });
  });

  app.put("/api/v1/admin/announcements/:id", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = announcementUpdateInput.parse(request.body);
    const result = withImmediateTransaction(() => {
      const current = db
        .prepare(`${announcementSelect} WHERE a.id = ?`)
        .get(id) as AnnouncementRow | undefined;
      if (!current) return { kind: "NOT_FOUND" as const };
      if (current.version !== input.expectedVersion) {
        return { kind: "STALE" as const };
      }
      if (current.status === "WITHDRAWN" && !input.reactivate) {
        return { kind: "WITHDRAWN" as const };
      }
      if (current.status === "ACTIVE" && input.reactivate) {
        return { kind: "ACTIVE" as const };
      }

      const publishedAt = nowIso();
      db.prepare(
        `UPDATE announcements
         SET title = ?, body_markdown = ?, status = 'ACTIVE',
             version = version + 1, published_at = ?, updated_at = ?,
             withdrawn_at = NULL, withdrawn_by = NULL
         WHERE id = ? AND version = ?`
      ).run(
        input.title,
        input.bodyMarkdown,
        publishedAt,
        publishedAt,
        id,
        input.expectedVersion
      );
      addAudit(
        auth.user.id,
        input.reactivate ? "ANNOUNCEMENT_REACTIVATE" : "ANNOUNCEMENT_UPDATE",
        "announcement",
        id,
        {
          title: current.title,
          bodyLength: current.body_markdown.length,
          status: current.status,
          publishedAt: current.published_at
        },
        {
          title: input.title,
          bodyLength: input.bodyMarkdown.length,
          status: "ACTIVE",
          publishedAt
        }
      );
      const updated = db
        .prepare(`${announcementSelect} WHERE a.id = ?`)
        .get(id) as AnnouncementRow;
      return { kind: "OK" as const, announcement: updated };
    });

    if (result.kind === "NOT_FOUND") {
      return reply.code(404).send({ error: "公告不存在" });
    }
    if (result.kind === "STALE") {
      return reply.code(409).send({ error: "公告状态已变化，请刷新后重试" });
    }
    if (result.kind === "WITHDRAWN") {
      return reply.code(409).send({ error: "公告已经撤下，请使用重新启用" });
    }
    if (result.kind === "ACTIVE") {
      return reply.code(409).send({ error: "公告仍在展示中，请使用编辑" });
    }
    publishAnnouncementChange();
    return { announcement: mapAnnouncement(result.announcement) };
  });

  app.post("/api/v1/admin/announcements/:id/withdraw", async (request, reply) => {
    const auth = requireSystemAdmin(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { expectedVersion } = z
      .object({ expectedVersion: z.number().int().min(1) })
      .strict()
      .parse(request.body);
    const result = withImmediateTransaction(() => {
      const current = db
        .prepare(`${announcementSelect} WHERE a.id = ?`)
        .get(id) as AnnouncementRow | undefined;
      if (!current) return { kind: "NOT_FOUND" as const };
      if (current.status === "WITHDRAWN") {
        return { kind: "WITHDRAWN" as const };
      }
      if (current.version !== expectedVersion) {
        return { kind: "STALE" as const };
      }
      const withdrawnAt = nowIso();
      db.prepare(
        `UPDATE announcements
         SET status = 'WITHDRAWN', version = version + 1,
             withdrawn_at = ?, withdrawn_by = ?, updated_at = ?
         WHERE id = ? AND status = 'ACTIVE' AND version = ?`
      ).run(withdrawnAt, auth.user.id, withdrawnAt, id, expectedVersion);
      addAudit(
        auth.user.id,
        "ANNOUNCEMENT_WITHDRAW",
        "announcement",
        id,
        { title: current.title, status: current.status },
        { title: current.title, status: "WITHDRAWN" }
      );
      const updated = db
        .prepare(`${announcementSelect} WHERE a.id = ?`)
        .get(id) as AnnouncementRow;
      return { kind: "OK" as const, announcement: updated };
    });
    if (result.kind === "NOT_FOUND") {
      return reply.code(404).send({ error: "公告不存在" });
    }
    if (result.kind === "WITHDRAWN") {
      return reply.code(409).send({ error: "公告已经撤下" });
    }
    if (result.kind === "STALE") {
      return reply.code(409).send({ error: "公告状态已变化，请刷新后重试" });
    }
    publishAnnouncementChange();
    return { announcement: mapAnnouncement(result.announcement) };
  });
}
