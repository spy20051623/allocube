import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { checkPassword, requireAuth } from "./auth.js";
import { addAudit, db, nowIso, withImmediateTransaction } from "./db.js";

export type ApiAccessLevel = "READ_ONLY" | "READ_WRITE";

export type ApiTokenAuth = {
  token: {
    id: string;
    name: string;
    prefix: string;
    accessLevel: ApiAccessLevel;
    expiresAt: string | null;
  };
  user: {
    id: string;
    username: string;
    displayName: string;
    employeeNumber: string | null;
    role: "SYSTEM_ADMIN" | "USER";
  };
};

const API_TOKEN_PREFIX = "allocube_pat_";
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60_000;
const MAX_ACTIVE_TOKENS = 10;

export function hashApiSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

function publicToken(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name),
    prefix: String(row.token_prefix),
    accessLevel: row.access_level as ApiAccessLevel,
    createdAt: String(row.created_at),
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    lastUsedAt: row.last_used_at ? String(row.last_used_at) : null,
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
    revokedReason: String(row.revoked_reason ?? "")
  };
}

export function apiTokenFromAuthorization(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return null;
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/i);
  if (!match || !match[1].startsWith(API_TOKEN_PREFIX)) return null;
  return match[1];
}

export function authenticateApiToken(request: FastifyRequest): ApiTokenAuth | null {
  const secret = apiTokenFromAuthorization(request);
  if (!secret) return null;
  const at = nowIso();
  const row = db
    .prepare(
      `SELECT
         t.id AS token_id, t.name AS token_name, t.token_prefix,
         t.access_level, t.expires_at, t.last_used_at,
         u.id AS user_id, u.username, u.display_name, u.role,
         (SELECT en.employee_number FROM employee_numbers en
          WHERE en.user_id = u.id AND en.status = 'ACTIVE' LIMIT 1)
           AS employee_number
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?
         AND t.revoked_at IS NULL
         AND (t.expires_at IS NULL OR t.expires_at > ?)
         AND u.status = 'ACTIVE'
         AND NOT EXISTS (
           SELECT 1 FROM deleted_user_tombstones dut WHERE dut.user_id = u.id
         )`
    )
    .get(hashApiSecret(secret), at) as
    | {
        token_id: string;
        token_name: string;
        token_prefix: string;
        access_level: ApiAccessLevel;
        expires_at: string | null;
        last_used_at: string | null;
        user_id: string;
        username: string;
        display_name: string;
        employee_number: string | null;
        role: "SYSTEM_ADMIN" | "USER";
      }
    | undefined;
  if (!row) return null;
  const lastUsedAt = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (!lastUsedAt || lastUsedAt <= Date.now() - LAST_USED_WRITE_INTERVAL_MS) {
    db.prepare(
      `UPDATE api_tokens SET last_used_at = ?
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
    ).run(
      at,
      row.token_id,
      new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS).toISOString()
    );
  }
  return {
    token: {
      id: row.token_id,
      name: row.token_name,
      prefix: row.token_prefix,
      accessLevel: row.access_level,
      expiresAt: row.expires_at
    },
    user: {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      employeeNumber: row.employee_number,
      role: row.role
    }
  };
}

export function revokeApiTokensForUser(
  userId: string,
  reason: string,
  revokedAt = nowIso()
) {
  const revoked = db
    .prepare(
      `UPDATE api_tokens
       SET revoked_at = COALESCE(revoked_at, ?),
           revoked_reason = CASE WHEN revoked_at IS NULL THEN ? ELSE revoked_reason END
       WHERE user_id = ? AND revoked_at IS NULL`
    )
    .run(revokedAt, reason, userId).changes;
  db.prepare(
    `UPDATE prepared_api_operations
     SET status = 'REJECTED', rejection_code = 'API_TOKEN_REVOKED'
     WHERE user_id = ? AND status = 'PENDING'`
  ).run(userId);
  return revoked;
}

function sendManagementError(
  reply: FastifyReply,
  statusCode: number,
  error: string,
  code?: string
) {
  return reply.code(statusCode).send({
    error,
    ...(code ? { code } : {})
  });
}

export function registerApiTokenManagementRoutes(app: FastifyInstance) {
  app.get("/api/v1/auth/api-tokens", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const rows = db
      .prepare(
        `SELECT * FROM api_tokens
         WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
      )
      .all(auth.user.id) as Array<Record<string, unknown>>;
    return { tokens: rows.map(publicToken), maxActiveTokens: MAX_ACTIVE_TOKENS };
  });

  app.post(
    "/api/v1/auth/api-tokens",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const auth = requireAuth(request, reply);
      if (!auth) return;
      const body = z
        .object({
          name: z.string().trim().min(1).max(80),
          accessLevel: z.enum(["READ_ONLY", "READ_WRITE"]),
          expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable().default(null),
          currentPassword: z.string().min(1).max(256)
        })
        .strict()
        .parse(request.body);
      const user = db
        .prepare("SELECT password_hash FROM users WHERE id = ?")
        .get(auth.user.id) as { password_hash: string } | undefined;
      if (!user || !(await checkPassword(user.password_hash, body.currentPassword))) {
        return sendManagementError(
          reply,
          400,
          "当前密码不正确",
          "CURRENT_PASSWORD_INVALID"
        );
      }
      const secret = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const createdAt = nowIso();
      const expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
        : null;
      const id = randomUUID();
      const created = withImmediateTransaction(() => {
        const activeCount = db
          .prepare(
            `SELECT COUNT(*) AS count FROM api_tokens
             WHERE user_id = ? AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > ?)`
          )
          .get(auth.user.id, createdAt) as { count: number };
        if (activeCount.count >= MAX_ACTIVE_TOKENS) return false;
        db.prepare(
          `INSERT INTO api_tokens(
             id, user_id, name, token_prefix, token_hash, access_level,
             expires_at, created_at
           ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          auth.user.id,
          body.name,
          secret.slice(0, API_TOKEN_PREFIX.length + 8),
          hashApiSecret(secret),
          body.accessLevel,
          expiresAt,
          createdAt
        );
        addAudit(auth.user.id, "API_TOKEN_CREATE", "api_token", id, undefined, {
          name: body.name,
          accessLevel: body.accessLevel,
          expiresAt
        });
        return true;
      });
      if (!created) {
        return sendManagementError(
          reply,
          409,
          `最多保留 ${MAX_ACTIVE_TOKENS} 个有效令牌，请先吊销不再使用的令牌`,
          "API_TOKEN_LIMIT_REACHED"
        );
      }
      const row = db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as Record<
        string,
        unknown
      >;
      return reply.code(201).send({ token: publicToken(row), secret });
    }
  );

  app.delete("/api/v1/auth/api-tokens/:id", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(request.params);
    const revokedAt = nowIso();
    const changed = withImmediateTransaction(() => {
      const result = db
        .prepare(
          `UPDATE api_tokens
           SET revoked_at = ?, revoked_reason = '用户主动吊销'
           WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .run(revokedAt, id, auth.user.id);
      if (!result.changes) return false;
      db.prepare(
        `UPDATE prepared_api_operations
         SET status = 'REJECTED', rejection_code = 'API_TOKEN_REVOKED'
         WHERE api_token_id = ? AND status = 'PENDING'`
      ).run(id);
      addAudit(auth.user.id, "API_TOKEN_REVOKE", "api_token", id);
      return true;
    });
    if (!changed) {
      return sendManagementError(reply, 404, "令牌不存在或已经吊销", "API_TOKEN_NOT_FOUND");
    }
    return { revoked: true, revokedAt };
  });

  app.post("/api/v1/auth/api-tokens/revoke-all", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const revokedAt = nowIso();
    const revokedCount = withImmediateTransaction(() => {
      const count = revokeApiTokensForUser(auth.user.id, "用户主动全部吊销", revokedAt);
      if (count) {
        addAudit(auth.user.id, "API_TOKEN_REVOKE_ALL", "user", auth.user.id, undefined, {
          revokedCount: count
        });
      }
      return count;
    });
    return { revokedCount, revokedAt };
  });
}
