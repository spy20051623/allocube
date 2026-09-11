import { createPublicKey, verify } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  canAccessMachine,
  canManageMachine,
  createOpaqueToken,
  hashToken,
  requireAuth,
} from "./auth.js";
import {
  addAudit,
  db,
  getPublicSiteOrigin,
  nowIso,
  withImmediateTransaction,
} from "./db.js";
import { IdentityError } from "./identity.js";
import { activeMachineKeys } from "./ssh-keys.js";
import { registerSSHKeyRoutes } from "./ssh-key-routes.js";

type Terminal = {
  id: string;
  machine_id: string;
  callback_url: string;
  public_key: string;
  enabled: number;
  certificate_expires_at: string | null;
  last_seen_at: string | null;
};
const tokenPath = "/api/v1/terminal/machine/token";
const assertionLifetimeSeconds = 60;
const assertionClockSkewSeconds = 5;
const expires = (seconds: number) =>
  new Date(Date.now() + seconds * 1000).toISOString();
function fail(message: string, status = 400): never {
  throw new IdentityError(message, status);
}
const opaque = z.string().min(32).max(128);
const machinePaths = new Set(
  ["enroll", "token", "keys", "rotate"].map(
    (x) => `/api/v1/terminal/machine/${x}`,
  ),
);
export function isTerminalProtocolPath(path: string) {
  return machinePaths.has(path);
}

function platformOrigin() {
  const origin = getPublicSiteOrigin();
  if (!origin.startsWith("https://")) fail("请先配置 HTTPS 公网站点地址", 503);
  return origin;
}
function terminal(id: string) {
  const row = db
    .prepare(
      `SELECT t.* FROM machine_terminals t JOIN machines m ON m.id=t.machine_id
    WHERE t.id=? AND t.enabled=1 AND m.status='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM deleted_machine_tombstones d WHERE d.machine_id=m.id)`,
    )
    .get(id) as Terminal | undefined;
  if (!row) fail("终端已停用或机器不存在", 403);
  return row;
}
function credential(t: Terminal, kind: "MACHINE" | "ENROLL", seconds: number) {
  const value = createOpaqueToken();
  db.prepare("INSERT INTO terminal_credentials VALUES(?,?,?,?)").run(
    hashToken(value),
    t.id,
    kind,
    expires(seconds),
  );
  return value;
}
function machine(request: FastifyRequest): Terminal {
  const value =
    request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1] ??
    "";
  const row = db
    .prepare(
      "SELECT terminal_id FROM terminal_credentials WHERE token_hash=? AND kind='MACHINE' AND expires_at>?",
    )
    .get(hashToken(value), nowIso()) as { terminal_id: string } | undefined;
  if (!row) fail("机器凭据无效", 401);
  const t = terminal(row.terminal_id);
  db.prepare("UPDATE machine_terminals SET last_seen_at=? WHERE id=?").run(
    nowIso(),
    t.id,
  );
  return t;
}
function publicKey(pem: string) {
  try {
    if (!pem.startsWith("-----BEGIN PUBLIC KEY-----"))
      fail("只接受 Ed25519 公钥");
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") fail("只接受 Ed25519 公钥");
    return key;
  } catch {
    return fail("机器公钥无效");
  }
}
export function verifyClientAssertion(jwt: string, t: Terminal) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) fail("机器签名无效", 401);
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const body = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const now = Math.floor(Date.now() / 1000);
    if (
      header.alg !== "EdDSA" ||
      header.crit ||
      header.jku ||
      header.jwk ||
      header.x5u ||
      body.iss !== t.id ||
      body.sub !== t.id ||
      body.aud !== platformOrigin() + tokenPath ||
      !Number.isInteger(body.exp) ||
      !Number.isInteger(body.iat) ||
      body.exp <= now ||
      body.exp > now + assertionLifetimeSeconds + assertionClockSkewSeconds ||
      body.iat > now + assertionClockSkewSeconds ||
      body.iat < now - assertionLifetimeSeconds - assertionClockSkewSeconds ||
      body.exp <= body.iat ||
      body.exp - body.iat > assertionLifetimeSeconds ||
      typeof body.jti !== "string" ||
      body.jti.length < 24 ||
      body.jti.length > 128 ||
      !verify(
        null,
        Buffer.from(parts.slice(0, 2).join(".")),
        publicKey(t.public_key),
        Buffer.from(parts[2], "base64url"),
      )
    )
      fail("机器签名无效", 401);
    const added = db
      .prepare(
        "INSERT OR IGNORE INTO terminal_credentials VALUES(?,?, 'REPLAY',?)",
      )
      .run(
        hashToken(t.id + ":" + body.jti),
        t.id,
        new Date((body.exp + 10) * 1000).toISOString(),
      );
    if (!added.changes) fail("机器签名已经使用", 401);
  } catch (error) {
    if (error instanceof IdentityError) throw error;
    fail("机器签名无效", 401);
  }
}
export function registerTerminalRoutes(
  app: FastifyInstance,
  _publishRevision: (revision: number) => void = () => {},
) {
  registerSSHKeyRoutes(app);
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    const management =
      /^\/api\/v1\/admin\/machines\/[0-9a-f-]{36}\/terminal$/.test(path) ||
      path === "/api/v1/admin/terminal/ca";
    if (!isTerminalProtocolPath(path) && !management) return;
    reply
      .header("cache-control", "no-store")
      .header("referrer-policy", "no-referrer");
    if (
      request.protocol !== "https" ||
      `https://${request.headers.host}` !== platformOrigin()
    )
      return reply
        .code(400)
        .send({ error: "终端鉴权必须使用配置的 HTTPS 站点" });
    if (
      path.includes("/browser/") &&
      request.method !== "GET" &&
      (request.headers.origin !== platformOrigin() ||
        request.headers["sec-fetch-site"] === "cross-site")
    )
      return reply.code(403).send({ error: "请求来源不受信任" });
  });

  app.get("/api/v1/machines/:id/terminal", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const manager = canManageMachine(auth.user.id, auth.user.role, id);
    if (!manager && !canAccessMachine(auth.user.id, auth.user.role, id))
      return reply.code(403).send({ error: "无机器使用权" });
    const row = db
      .prepare(
        "SELECT id,callback_url,enabled,certificate_expires_at,last_seen_at,public_key FROM machine_terminals WHERE machine_id=?",
      )
      .get(id) as Terminal | undefined;
    return {
      terminal: row
        ? {
            id: row.id,
            mode: "KEY_SYNC",
            enabled: Boolean(row.enabled),
            enrolled: Boolean(row.public_key),
            certificateExpiresAt: row.certificate_expires_at,
            lastSeenAt: row.last_seen_at,
          }
        : null,
    };
  });
  app.post("/api/v1/admin/machines/:id/terminal", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!canManageMachine(auth.user.id, auth.user.role, id))
      return reply.code(403).send({ error: "无管理权限" });
    const origin = platformOrigin();
    return withImmediateTransaction(() => {
      db.prepare("DELETE FROM machine_terminals WHERE machine_id=?").run(id);
      const terminalId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO machine_terminals(id,machine_id,callback_url,created_at) VALUES(?,?,?,?)",
      ).run(terminalId, id, "", nowIso());
      const value = credential({ id: terminalId } as Terminal, "ENROLL", 600);
      addAudit(auth.user.id, "TERMINAL_REGISTER", "machine", id, undefined, {
        terminalId,
        callbackUrl: "",
      });
      return {
        terminalId,
        enrollmentToken: value,
        expiresIn: 600,
        platformOrigin: origin,
        callbackUrl: "",
      };
    });
  });
  app.delete("/api/v1/admin/machines/:id/terminal", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!canManageMachine(auth.user.id, auth.user.role, id))
      fail("无管理权限", 403);
    db.prepare("UPDATE machine_terminals SET enabled=0 WHERE machine_id=?").run(
      id,
    );
    db.prepare(
      "DELETE FROM terminal_authorizations WHERE terminal_id IN(SELECT id FROM machine_terminals WHERE machine_id=?)",
    ).run(id);
    addAudit(auth.user.id, "TERMINAL_DISABLE", "machine", id);
    return { message: "终端接入已停用，已有 SSH 登录不受影响" };
  });

  app.post(
    "/api/v1/terminal/machine/enroll",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request) => {
      const body = z
        .object({
          terminalId: z.string().uuid(),
          enrollmentToken: opaque,
          publicKey: z.string().max(500),
          proof: z.string().max(128),
        })
        .parse(request.body);
      const t = terminal(body.terminalId);
      const key = publicKey(body.publicKey);
      if (
        !verify(
          null,
          Buffer.from(`allocube-enroll:${t.id}:${body.enrollmentToken}`),
          key,
          Buffer.from(body.proof, "base64url"),
        )
      )
        fail("注册签名无效", 401);
      withImmediateTransaction(() => {
        const used = db
          .prepare(
            "DELETE FROM terminal_credentials WHERE token_hash=? AND terminal_id=? AND kind='ENROLL' AND expires_at>?",
          )
          .run(hashToken(body.enrollmentToken), t.id, nowIso());
        if (!used.changes || t.public_key) fail("接入凭据已使用或过期", 401);
        db.prepare(
          "UPDATE machine_terminals SET public_key=?,last_seen_at=? WHERE id=?",
        ).run(key.export({ type: "spki", format: "pem" }), nowIso(), t.id);
      });
      return { machineId: t.machine_id, callbackUrl: t.callback_url };
    },
  );
  app.post(
    tokenPath,
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request) => {
      const body = z
        .object({
          client_id: z.string().uuid(),
          grant_type: z.literal("client_credentials"),
          client_assertion_type: z.literal(
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          ),
          client_assertion: z.string().max(2048),
        })
        .parse(request.body);
      const t = terminal(body.client_id);
      verifyClientAssertion(body.client_assertion, t);
      return {
        access_token: credential(t, "MACHINE", 60),
        token_type: "Bearer",
        expires_in: 60,
      };
    },
  );
  app.post("/api/v1/terminal/machine/rotate", async (request) => {
    const t = machine(request);
    const body = z
      .object({ publicKey: z.string().max(500), proof: z.string().max(128) })
      .parse(request.body);
    const key = publicKey(body.publicKey);
    if (
      !verify(
        null,
        Buffer.from(`allocube-rotate:${t.id}:${hashToken(body.publicKey)}`),
        key,
        Buffer.from(body.proof, "base64url"),
      )
    )
      fail("新密钥持有证明无效", 401);
    withImmediateTransaction(() => {
      db.prepare("UPDATE machine_terminals SET public_key=? WHERE id=?").run(
        body.publicKey,
        t.id,
      );
      db.prepare("DELETE FROM terminal_credentials WHERE terminal_id=?").run(
        t.id,
      );
      db.prepare("DELETE FROM terminal_authorizations WHERE terminal_id=?").run(
        t.id,
      );
    });
    return { message: "身份密钥已轮换" };
  });

  app.post("/api/v1/terminal/machine/keys", async (request) => {
    const t = machine(request);
    const { employees } = z
      .object({
        employees: z
          .array(z.string().regex(/^(\d{8}|wx\d{6,7})$/))
          .min(1)
          .max(32),
      })
      .strict()
      .parse(request.body);
    return {
      terminalId: t.id,
      users: [...new Set(employees)].map((employeeNumber) => {
        const user = db
          .prepare(
            "SELECT u.id,u.role,u.status FROM users u JOIN employee_numbers e ON e.user_id=u.id WHERE e.employee_number=? AND e.status='ACTIVE' AND NOT EXISTS(SELECT 1 FROM deleted_user_tombstones d WHERE d.user_id=u.id)",
          )
          .get(employeeNumber) as
          { id: string; role: string; status: string } | undefined;
        if (!user) return { employeeNumber, status: "NOT_FOUND", keys: [] };
        if (
          user.status !== "ACTIVE" ||
          (!canAccessMachine(user.id, user.role, t.machine_id) &&
            !canManageMachine(user.id, user.role, t.machine_id))
        )
          return { employeeNumber, status: "DENIED", keys: [] };
        return { employeeNumber, status: "OK", keys: activeMachineKeys(user.id, t.machine_id) };
      }),
    };
  });
}
