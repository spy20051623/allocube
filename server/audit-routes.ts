import type { FastifyInstance } from "fastify";
import { requireSystemAdmin } from "./auth.js";
import { db } from "./db.js";
import { config } from "./config.js";
import { AuditStore } from "./audit-store.js";
import { z } from "zod";

export function registerAuditRoutes(app: FastifyInstance) {
  const store = new AuditStore(db, config.sessionSecret);
  app.get("/api/v1/admin/audit", async (request, reply) => {
    if (!requireSystemAdmin(request, reply)) return;
    return store.list(request.query);
  });
  app.get("/api/v1/admin/audit/options", async (request, reply) => {
    if (!requireSystemAdmin(request, reply)) return;
    return store.options();
  });
  app.get("/api/v1/admin/audit/:id", async (request, reply) => {
    if (!requireSystemAdmin(request, reply)) return;
    return store.detail(z.object({ id: z.string().min(1).max(100) }).parse(request.params).id);
  });
}
