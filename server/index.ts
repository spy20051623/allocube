import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import {
  SESSION_COOKIE,
  assertCsrf,
  getSessionAuth,
  hashToken,
  requireAuth
} from "./auth.js";
import {
  apiTokenFromAuthorization,
  registerApiTokenManagementRoutes
} from "./api-tokens.js";
import { config, validateRuntimeConfig } from "./config.js";
import { requestOriginMatches } from "./request-origin.js";
import {
  bumpScheduleRevision,
  cleanupExpiredSecurityRecords,
  db,
  getScheduleRevision,
  initializeDatabase,
  nowIso
} from "./db.js";
import { processEmailOutbox } from "./mailer.js";
import { registerAdminRoutes } from "./routes-admin.js";
import { registerAnnouncementRoutes } from "./announcements.js";
import { registerAuthRoutes } from "./routes-auth.js";
import { registerScheduleRoutes } from "./routes-schedule.js";
import { registerOpenApiRoutes } from "./open-api.js";
import { cleanupFeedbackAttachments, registerFeedbackRoutes } from "./feedback.js";
import {
  SourceRateLimiter,
  type SourceRateLimitPolicy
} from "./source-rate-limit.js";

validateRuntimeConfig();
if (config.instanceSecretsCreatedForExistingDatabase) {
  console.warn(
    "现有数据库缺少实例密钥文件，已生成新密钥；现有会话、验证码和已保存的 SMTP 密码可能失效"
  );
}
await initializeDatabase();
cleanupFeedbackAttachments();
setInterval(cleanupFeedbackAttachments, 24 * 60 * 60 * 1000).unref();
const passwordReminder = db
  .prepare(
    `SELECT 1 FROM users
     WHERE role = 'SYSTEM_ADMIN' AND password_change_recommended = 1`
  )
  .get();

const app = Fastify({
  bodyLimit: 256 * 1024,
  disableRequestLogging: true,
  logger: {
    level: config.isProduction ? "info" : "warn"
  },
  trustProxy: config.isProduction
    ? ["loopback", "linklocal", "uniquelocal"]
    : false
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(multipart, {
  limits: { files: 5, fileSize: 5 * 1024 * 1024, fields: 5, parts: 10 }
});
await app.register(helmet, {
  strictTransportSecurity: false,
  contentSecurityPolicy: config.isProduction
    ? {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null
        }
      }
    : false
});
await app.register(rateLimit, {
  max: 300,
  timeWindow: "1 minute",
  hook: "preHandler",
  keyGenerator(request) {
    const apiToken = apiTokenFromAuthorization(request);
    if (apiToken) return `api-token:${hashToken(apiToken)}`;
    const sessionToken = request.cookies[SESSION_COOKIE];
    if (sessionToken) return `session:${hashToken(sessionToken)}`;
    const pathname = request.url.split("?")[0];
    const body = request.body as
      | {
          identifierType?: unknown;
          identifier?: unknown;
          email?: unknown;
          token?: unknown;
        }
      | undefined;
    if (
      pathname === "/api/v1/auth/login" &&
      typeof body?.identifier === "string"
    ) {
      const identifierKey = `${String(body.identifierType)}:${body.identifier
        .normalize("NFKC")
        .toLocaleLowerCase("zh-CN")}`;
      return `login:${request.ip}:${hashToken(identifierKey)}`;
    }
    if (typeof body?.email === "string") {
      return `${pathname}:${request.ip}:${hashToken(
        body.email.trim().toLowerCase()
      )}`;
    }
    if (
      pathname === "/api/v1/auth/reset-password" &&
      typeof body?.token === "string"
    ) {
      return `reset:${request.ip}:${hashToken(body.token)}`;
    }
    return `ip:${request.ip}`;
  }
});

const sourceRateLimiter = new SourceRateLimiter();
const sourceRatePolicies = new Map<string, SourceRateLimitPolicy>([
  ["/api/v1/auth/login", { max: 60, windowMs: 15 * 60_000 }],
  ["/api/v1/auth/registration-email-code", { max: 20, windowMs: 60 * 60_000 }],
  ["/api/v1/auth/register", { max: 30, windowMs: 15 * 60_000 }],
  ["/api/v1/auth/forgot-password", { max: 20, windowMs: 60 * 60_000 }],
  ["/api/v1/auth/reset-password", { max: 30, windowMs: 30 * 60_000 }]
]);

app.addHook("preHandler", async (request, reply) => {
  const pathname = request.url.split("?")[0];
  const policy = sourceRatePolicies.get(pathname);
  if (!policy) return;
  const result = sourceRateLimiter.check(`${pathname}:${request.ip}`, policy);
  if (!result.allowed) {
    return reply
      .code(429)
      .header("Retry-After", String(result.retryAfterSeconds))
      .send({ error: "请求过于频繁，请稍后重试" });
  }
});

app.addHook("onSend", async (request, reply, payload) => {
  if (config.isProduction && request.protocol === "https") {
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
  reply.header(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
  );
  if (request.url.startsWith("/api/")) {
    reply.header("Cache-Control", "no-store");
  }
  return payload;
});

const publicMutationPaths = new Set([
  "/api/v1/auth/registration-email-code",
  "/api/v1/auth/register",
  "/api/v1/auth/login",
  "/api/v1/auth/forgot-password",
  "/api/v1/auth/reset-password"
]);

app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/api/")) return;
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.url.split("?")[0].startsWith("/api/open/v1/")) return;
  if (request.headers["sec-fetch-site"] === "cross-site") {
    return reply.code(403).send({ error: "请求来源不受信任" });
  }
  const origin = request.headers.origin;
  if (
    !requestOriginMatches(
      origin,
      request.protocol,
      request.headers.host
    )
  ) {
    return reply.code(403).send({ error: "请求来源不受信任" });
  }
  const pathname = request.url.split("?")[0];
  if (publicMutationPaths.has(pathname)) return;
  const auth = getSessionAuth(request);
  if (!auth) {
    return reply.code(401).send({ error: "请先登录" });
  }
  if (!assertCsrf(request, auth.csrfToken)) {
    return reply.code(403).send({ error: "安全令牌已失效，请刷新页面后重试" });
  }
});

const MAX_EVENT_CLIENTS = 1_000;
const MAX_EVENT_CLIENTS_PER_SESSION = 6;
const eventClients = new Map<NodeJS.WritableStream, string>();
const eventClientCountsBySession = new Map<string, number>();

function removeEventClient(client: NodeJS.WritableStream) {
  const sessionId = eventClients.get(client);
  if (!sessionId) return;
  eventClients.delete(client);
  const remaining = (eventClientCountsBySession.get(sessionId) ?? 1) - 1;
  if (remaining > 0) {
    eventClientCountsBySession.set(sessionId, remaining);
  } else {
    eventClientCountsBySession.delete(sessionId);
  }
}

function eventSessionIsActive(sessionId: string) {
  const row = db
    .prepare(
      `SELECT s.expires_at, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ?`
    )
    .get(sessionId) as
    | {
        expires_at: string;
        status: string;
      }
    | undefined;
  return Boolean(row && row.status === "ACTIVE" && row.expires_at > nowIso());
}

function publishRevision(revision: number) {
  const payload = `event: revision\ndata: ${JSON.stringify({ revision })}\n\n`;
  for (const client of eventClients.keys()) {
    try {
      client.write(payload);
    } catch {
      removeEventClient(client);
    }
  }
}

function publishAnnouncementChange() {
  const payload = `event: announcement\ndata: ${JSON.stringify({
    changedAt: nowIso()
  })}\n\n`;
  for (const client of eventClients.keys()) {
    try {
      client.write(payload);
    } catch {
      removeEventClient(client);
    }
  }
}

function publishFeedbackChange() {
  const payload = `event: feedback\ndata: ${JSON.stringify({
    changedAt: nowIso()
  })}\n\n`;
  for (const client of eventClients.keys()) {
    try {
      client.write(payload);
    } catch {
      removeEventClient(client);
    }
  }
}

registerAuthRoutes(app);
registerApiTokenManagementRoutes(app);
registerScheduleRoutes(app, publishRevision);
registerAdminRoutes(app, publishRevision);
registerAnnouncementRoutes(app, publishAnnouncementChange);
registerFeedbackRoutes(app, publishFeedbackChange);
registerOpenApiRoutes(app, publishRevision);

app.get("/api/v1/events", async (request, reply) => {
  const auth = requireAuth(request, reply);
  if (!auth) return;
  if (eventClients.size >= MAX_EVENT_CLIENTS) {
    return reply.code(503).send({ error: "实时连接暂时繁忙，请稍后重试" });
  }
  const sessionClientCount = eventClientCountsBySession.get(auth.sessionId) ?? 0;
  if (sessionClientCount >= MAX_EVENT_CLIENTS_PER_SESSION) {
    return reply.code(429).send({ error: "实时连接过多，请关闭重复页面后重试" });
  }
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no"
  });
  reply.raw.write(
    `event: revision\ndata: ${JSON.stringify({ revision: getScheduleRevision() })}\n\n`
  );
  eventClients.set(reply.raw, auth.sessionId);
  eventClientCountsBySession.set(auth.sessionId, sessionClientCount + 1);
  const heartbeat = setInterval(() => {
    try {
      if (!eventSessionIsActive(auth.sessionId)) {
        clearInterval(heartbeat);
        removeEventClient(reply.raw);
        reply.raw.end();
        return;
      }
      reply.raw.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      removeEventClient(reply.raw);
    }
  }, 25_000);
  request.raw.on("close", () => {
    clearInterval(heartbeat);
    removeEventClient(reply.raw);
  });
});

app.get("/health", async (_request, reply) => {
  try {
    db.prepare("SELECT 1").get();
    return { status: "ok" };
  } catch {
    return reply.code(503).send({ status: "unhealthy" });
  }
});

if (config.isProduction) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const staticRoot = path.resolve(currentDir, "../../dist");
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: "/"
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "接口不存在" });
  });
}

function effectiveUnavailabilityKey() {
  const now = nowIso();
  return (
    db
      .prepare(
        `SELECT id FROM resource_unavailability
         WHERE status = 'ACTIVE' AND start_at <= ? AND end_at > ?
         ORDER BY id`
      )
      .all(now, now) as Array<{ id: string }>
  )
    .map((row) => row.id)
    .join(",");
}

let currentUnavailabilityKey = effectiveUnavailabilityKey();
const unavailabilityBoundaryTimer = setInterval(() => {
  try {
    const nextKey = effectiveUnavailabilityKey();
    if (nextKey === currentUnavailabilityKey) return;
    currentUnavailabilityKey = nextKey;
    publishRevision(bumpScheduleRevision());
  } catch (error) {
    app.log.error(error);
  }
}, 15_000);
unavailabilityBoundaryTimer.unref();

const emailTimer = setInterval(() => {
  void processEmailOutbox().catch((error) => app.log.error(error));
}, 10_000);
emailTimer.unref();
void processEmailOutbox().catch((error) => app.log.error(error));

const securityCleanupTimer = setInterval(() => {
  try {
    cleanupExpiredSecurityRecords();
  } catch (error) {
    app.log.error(error);
  }
}, 60 * 60 * 1000);
securityCleanupTimer.unref();

if (passwordReminder) {
  app.log.warn("Administrator 仍在使用初始化或恢复密码，建议尽快修改");
}

await app.listen({
  host: config.host,
  port: config.port
});
