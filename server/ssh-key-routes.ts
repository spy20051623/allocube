import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { canAccessMachine, canManageMachine, requireAuth } from "./auth.js";
import {
  addAudit,
  db,
  getAllowRegistrationWithoutEmail,
  nowIso,
  withImmediateTransaction,
} from "./db.js";
import {
  assertEmailChallengeCanBeSent,
  consumeEmailChallenge,
  createEmailChallenge,
  IdentityError,
  verifyEmailChallenge,
} from "./identity.js";
import { escapeHtml, queueEmail } from "./mailer.js";
import { getSmtpSettingsRow, isMailServiceAvailable } from "./smtp-settings.js";
import { parsePersonalKey, personalKeys } from "./ssh-keys.js";

const addFields = {
  name: z.string().trim().min(1).max(80),
  publicKey: z.string().max(4096),
};
const proofFields = {
  challengeId: z.string().uuid().optional(),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
};
const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ADD"), ...addFields }).strict(),
  z.object({ kind: z.literal("REMOVE"), keyId: z.string().uuid() }).strict(),
]);
type Operation = z.infer<typeof operationSchema>;
function identity(userId: string) {
  return db
    .prepare("SELECT email,password_hash FROM users WHERE id=?")
    .get(userId) as { email: string | null; password_hash: string };
}
function policy(userId: string) {
  const { email } = identity(userId);
  if (!getSmtpSettingsRow().enabled) return "SKIP" as const;
  if (email) return "REQUIRED" as const;
  return getAllowRegistrationWithoutEmail()
    ? ("SKIP" as const)
    : ("BIND_REQUIRED" as const);
}
function stamp(userId: string) {
  const u = identity(userId);
  return createHash("sha256")
    .update(
      JSON.stringify([
        u.email,
        u.password_hash,
        getSmtpSettingsRow().enabled,
        getAllowRegistrationWithoutEmail(),
      ]),
    )
    .digest("hex");
}
function normalizedOperation(userId: string, input: Operation) {
  if (input.kind === "ADD")
    return { ...input, publicKey: parsePersonalKey(input.publicKey).publicKey };
  if (
    !db
      .prepare("SELECT id FROM user_ssh_keys WHERE id=? AND user_id=?")
      .get(input.keyId, userId)
  )
    throw new IdentityError("公钥不存在", 404);
  return input;
}
function operationHash(operation: Operation) {
  return createHash("sha256").update(JSON.stringify(operation)).digest("hex");
}
function checkProof(
  userId: string,
  sessionId: string,
  op: Operation,
  proof: { challengeId?: string; code?: string },
) {
  const current = policy(userId);
  if (current === "BIND_REQUIRED")
    throw new IdentityError(
      "请先在个人资料中绑定邮箱，再重新开始公钥操作",
      409,
    );
  if (current === "SKIP") return null;
  if (!proof.challengeId || !proof.code)
    throw new IdentityError("请先获取并填写邮箱验证码", 403);
  const bound = db
    .prepare(
      "SELECT * FROM ssh_key_challenges WHERE challenge_id=? AND session_id=?",
    )
    .get(proof.challengeId, sessionId) as
    { operation_hash: string; credential_stamp: string } | undefined;
  if (
    !bound ||
    bound.operation_hash !== operationHash(op) ||
    bound.credential_stamp !== stamp(userId)
  )
    throw new IdentityError("操作内容或账号状态已变更，请重新获取验证码", 403);
  verifyEmailChallenge(
    proof.challengeId,
    identity(userId).email!,
    proof.code,
    "SSH_KEY",
    userId,
  );
  return proof.challengeId;
}
function response(userId: string) {
  return {
    keys: personalKeys(userId),
    maxKeys: 10,
    emailVerification: policy(userId),
  };
}
function activationMachines(userId: string, role: string, keyId: string) {
  const rows = db
    .prepare(
      "SELECT m.id,m.name,m.address,m.status,EXISTS(SELECT 1 FROM deleted_machine_tombstones d WHERE d.machine_id=m.id) AS deleted,EXISTS(SELECT 1 FROM machine_ssh_keys a WHERE a.machine_id=m.id AND a.key_id=?) AS active,EXISTS(SELECT 1 FROM machine_terminals t WHERE t.machine_id=m.id AND t.enabled=1 AND t.public_key<>'') AS sync_enabled FROM machines m ORDER BY m.name,m.id",
    )
    .all(keyId) as Array<{
    id: string;
    name: string;
    address: string;
    status: string;
    deleted: number;
    active: number;
    sync_enabled: number;
  }>;
  return rows
    .map((m) => ({
      id: m.id,
      name: m.name,
      address: m.address,
      active: Boolean(m.active),
      syncEnabled: Boolean(m.sync_enabled),
      available:
        m.status === "ACTIVE" &&
        !m.deleted &&
        (canAccessMachine(userId, role, m.id) ||
          canManageMachine(userId, role, m.id)),
    }))
    .filter((m) => m.active || m.available);
}
function ownedKey(userId: string, keyId: string) {
  const key = db
    .prepare("SELECT fingerprint FROM user_ssh_keys WHERE id=? AND user_id=?")
    .get(keyId, userId) as { fingerprint: string } | undefined;
  if (!key) throw new IdentityError("只能管理自己的公钥", 404);
  return key;
}
export function registerSSHKeyRoutes(app: FastifyInstance) {
  app.get("/api/v1/auth/ssh-keys", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    reply.header("cache-control", "no-store");
    return response(auth.user.id);
  });
  app.post(
    "/api/v1/auth/ssh-keys/email-code",
    { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const auth = requireAuth(request, reply);
      if (!auth) return;
      const op = normalizedOperation(
        auth.user.id,
        operationSchema.parse(request.body),
      );
      const current = policy(auth.user.id);
      if (current === "BIND_REQUIRED")
        throw new IdentityError(
          "请先在个人资料中绑定邮箱，再重新开始公钥操作",
          409,
        );
      if (current === "SKIP") return { emailVerification: current };
      if (!isMailServiceAvailable())
        throw new IdentityError("邮件服务暂不可用，请联系管理员", 503);
      const email = identity(auth.user.id).email!;
      assertEmailChallengeCanBeSent(email, "SSH_KEY", auth.user.id);
      return withImmediateTransaction(() => {
        const challenge = createEmailChallenge(email, "SSH_KEY", auth.user.id);
        const key =
          op.kind === "ADD"
            ? parsePersonalKey(op.publicKey)
            : (db
                .prepare(
                  "SELECT fingerprint FROM user_ssh_keys WHERE id=? AND user_id=?",
                )
                .get(op.keyId, auth.user.id) as { fingerprint: string });
        const action =
          op.kind === "ADD" ? "添加个人公钥" : "删除个人公钥及其全部机器激活";
        if (
          !queueEmail(
            email,
            "Allocube 公钥操作验证码",
            `<p>你正在${action}。</p><p>公钥指纹：${escapeHtml(key.fingerprint)}</p><p>验证码：<strong>${challenge.code}</strong>，10 分钟内有效，仅限此次操作。</p>`,
            auth.user.id,
            challenge.expiresAt,
          )
        )
          throw new IdentityError("邮件服务暂不可用，请联系管理员", 503);
        db.prepare("INSERT INTO ssh_key_challenges VALUES(?,?,?,?)").run(
          challenge.id,
          auth.sessionId,
          operationHash(op),
          stamp(auth.user.id),
        );
        return {
          emailVerification: current,
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt,
        };
      });
    },
  );
  app.post(
    "/api/v1/auth/ssh-keys",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const auth = requireAuth(request, reply);
      if (!auth) return;
      const body = z
        .object({ ...addFields, ...proofFields, autoActivateAll: z.boolean().optional().default(false) })
        .strict()
        .parse(request.body);
      const op = normalizedOperation(auth.user.id, {
        kind: "ADD",
        name: body.name,
        publicKey: body.publicKey,
      });
      const challengeId = checkProof(auth.user.id, auth.sessionId, op, body);
      const key = parsePersonalKey(body.publicKey);
      return withImmediateTransaction(() => {
        const keys = personalKeys(auth.user.id) as Array<{
          fingerprint: string;
        }>;
        if (keys.some((k) => k.fingerprint === key.fingerprint))
          throw new IdentityError("这把公钥已经添加", 409);
        if (keys.length >= 10)
          throw new IdentityError("最多保存 10 把公钥", 400);
        if (challengeId) consumeEmailChallenge(challengeId);
        const keyId = randomUUID();
        db.prepare("INSERT INTO user_ssh_keys VALUES(?,?,?,?,?,?)").run(
          keyId,
          auth.user.id,
          body.name,
          key.publicKey,
          key.fingerprint,
          nowIso(),
        );
        addAudit(auth.user.id, "SSH_KEY_ADD", "user", auth.user.id, undefined, {
          keyId,
          name: body.name,
          fingerprint: key.fingerprint,
        });
        const machines = body.autoActivateAll
          ? activationMachines(auth.user.id, auth.user.role, keyId).filter((m) => m.available)
          : [];
        for (const machine of machines) {
          db.prepare("INSERT INTO machine_ssh_keys VALUES(?,?,?,?)").run(machine.id, keyId, auth.user.id, nowIso());
          addAudit(auth.user.id, "SSH_KEY_ACTIVATE", "machine", machine.id, undefined, { keyId, fingerprint: key.fingerprint });
        }
        return { ...response(auth.user.id), createdKeyId: keyId, autoActivatedMachineCount: machines.length };
      });
    },
  );
  app.delete(
    "/api/v1/auth/ssh-keys/:id",
    { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const auth = requireAuth(request, reply);
      if (!auth) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const proof = z.object(proofFields).strict().parse(request.body);
      const op = normalizedOperation(auth.user.id, {
        kind: "REMOVE",
        keyId: id,
      });
      const challengeId = checkProof(auth.user.id, auth.sessionId, op, proof);
      return withImmediateTransaction(() => {
        const key = db
          .prepare(
            "SELECT id AS keyId,name,fingerprint FROM user_ssh_keys WHERE id=? AND user_id=?",
          )
          .get(id, auth.user.id);
        if (challengeId) consumeEmailChallenge(challengeId);
        db.prepare("DELETE FROM user_ssh_keys WHERE id=? AND user_id=?").run(
          id,
          auth.user.id,
        );
        addAudit(
          auth.user.id,
          "SSH_KEY_REMOVE",
          "user",
          auth.user.id,
          undefined,
          key,
        );
        return response(auth.user.id);
      });
    },
  );
  app.get("/api/v1/auth/ssh-keys/:id/activations", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    ownedKey(auth.user.id, id);
    reply.header("cache-control", "no-store");
    return { machines: activationMachines(auth.user.id, auth.user.role, id) };
  });
  app.put("/api/v1/auth/ssh-keys/:id/activations", async (request, reply) => {
    const auth = requireAuth(request, reply);
    if (!auth) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { machineIds } = z
      .object({ machineIds: z.array(z.string().uuid()).max(500) })
      .strict()
      .parse(request.body);
    return withImmediateTransaction(() => {
      const key = ownedKey(auth.user.id, id);
      const machines = activationMachines(auth.user.id, auth.user.role, id);
      const selected = new Set(machineIds);
      for (const machineId of selected) {
        const machine = machines.find((m) => m.id === machineId);
        if (!machine || (!machine.available && !machine.active))
          throw new IdentityError(
            "选中的机器不可用或无使用权，请刷新后重试",
            403,
          );
      }
      for (const m of machines) {
        const activate = selected.has(m.id);
        if (activate === m.active) continue;
        if (activate)
          db.prepare("INSERT INTO machine_ssh_keys VALUES(?,?,?,?)").run(
            m.id,
            id,
            auth.user.id,
            nowIso(),
          );
        else
          db.prepare(
            "DELETE FROM machine_ssh_keys WHERE machine_id=? AND key_id=? AND user_id=?",
          ).run(m.id, id, auth.user.id);
        addAudit(
          auth.user.id,
          activate ? "SSH_KEY_ACTIVATE" : "SSH_KEY_DEACTIVATE",
          "machine",
          m.id,
          undefined,
          { keyId: id, fingerprint: key.fingerprint },
        );
      }
      return {
        ...response(auth.user.id),
        machines: activationMachines(auth.user.id, auth.user.role, id),
      };
    });
  });
}
