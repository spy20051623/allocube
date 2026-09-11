import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  EMPLOYEE_NUMBER_MESSAGE,
  isEmployeeNumberValid,
  normalizeEmployeeNumberValue
} from "../src/shared/identity-rules.js";
import { config } from "./config.js";
import {
  checkpointSensitiveDeletion,
  db,
  nowIso,
  withImmediateTransaction
} from "./db.js";

export const EMAIL_CODE_MINUTES = 10;
export type EmailChallengePurpose = "REGISTER" | "EMAIL_CHANGE" | "EMAIL_OLD" | "TERMINAL" | "SSH_KEY";

export class IdentityError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

export function normalizeUsername(value: string) {
  const display = value.trim().normalize("NFKC");
  const length = Array.from(display).length;
  if (length < 2 || length > 32) {
    throw new IdentityError("用户名必须为 2–32 个字符");
  }
  const edge = "[\\p{Script=Han}A-Za-z0-9]";
  const body = "[\\p{Script=Han}A-Za-z0-9._-]";
  const pattern = new RegExp(`^${edge}${body}*${edge}$`, "u");
  if (!pattern.test(display)) {
    throw new IdentityError("用户名仅支持中文、字母、数字、点、下划线和短横线，且首尾须为文字或数字");
  }
  const normalized = display.toLocaleLowerCase("zh-CN");
  if (normalized === "administrator") {
    throw new IdentityError("该用户名为系统保留名称", 409);
  }
  return { display, normalized };
}

export function normalizeEmployeeNumber(value: string) {
  const normalized = normalizeEmployeeNumberValue(value);
  if (!isEmployeeNumberValid(normalized)) {
    throw new IdentityError(EMPLOYEE_NUMBER_MESSAGE);
  }
  return normalized;
}

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function codeDigest(challengeId: string, code: string) {
  return createHmac("sha256", config.sessionSecret)
    .update(`${challengeId}:${code}`)
    .digest();
}

export function createEmailChallenge(
  email: string,
  purpose: EmailChallengePurpose,
  userId: string | null
) {
  const normalizedEmail = normalizeEmail(email);
  const id = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = nowIso();
  const expiresAt = new Date(Date.now() + EMAIL_CODE_MINUTES * 60_000).toISOString();
  db.prepare(
    `INSERT INTO email_verification_challenges(
      id, email, purpose, user_id, code_hash, expires_at, last_sent_at, created_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, normalizedEmail, purpose, userId, codeDigest(id, code).toString("hex"), expiresAt, now, now);
  return { id, code, email: normalizedEmail, expiresAt };
}

export function assertEmailChallengeCanBeSent(
  email: string,
  purpose: EmailChallengePurpose,
  userId: string | null
) {
  const recent = db
    .prepare(
      `SELECT last_sent_at FROM email_verification_challenges
       WHERE email = ? AND purpose = ?
         AND ((user_id IS NULL AND ? IS NULL) OR user_id = ?)
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(normalizeEmail(email), purpose, userId, userId) as
    | { last_sent_at: string }
    | undefined;
  if (recent && Date.now() - new Date(recent.last_sent_at).getTime() < 60_000) {
    throw new IdentityError("请等待 60 秒后再获取验证码", 429);
  }
}

export function verifyEmailChallenge(
  challengeId: string,
  email: string,
  code: string,
  purpose: EmailChallengePurpose,
  userId: string | null
) {
  const row = db
    .prepare(
      `SELECT id, email, purpose, user_id, code_hash, attempts, expires_at, used_at
       FROM email_verification_challenges WHERE id = ?`
    )
    .get(challengeId) as
    | {
        id: string;
        email: string;
        purpose: string;
        user_id: string | null;
        code_hash: string;
        attempts: number;
        expires_at: string;
        used_at: string | null;
      }
    | undefined;
  const expectedUser = userId ?? null;
  if (
    !row ||
    row.email !== normalizeEmail(email) ||
    row.purpose !== purpose ||
    row.user_id !== expectedUser ||
    row.used_at ||
    row.expires_at <= nowIso() ||
    row.attempts >= 5
  ) {
    throw new IdentityError("验证码无效，请重新输入");
  }
  const supplied = codeDigest(challengeId, code);
  const expected = Buffer.from(row.code_hash, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    db.prepare(
      "UPDATE email_verification_challenges SET attempts = attempts + 1 WHERE id = ?"
    ).run(challengeId);
    throw new IdentityError("验证码无效，请重新输入");
  }
  return row;
}

export function consumeEmailChallenge(challengeId: string) {
  const result = db
    .prepare(
      `UPDATE email_verification_challenges SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?`
    )
    .run(nowIso(), challengeId, nowIso());
  if (!result.changes) throw new IdentityError("验证码无效，请重新输入");
}

export function ensureUsernameAvailable(normalized: string, excludeUserId?: string) {
  const row = db
    .prepare(
      `SELECT id FROM users WHERE username_normalized = ?
       ${excludeUserId ? "AND id != ?" : ""}`
    )
    .get(...(excludeUserId ? [normalized, excludeUserId] : [normalized]));
  if (row) throw new IdentityError("该用户名已被占用", 409);
}

export function ensureEmailAvailable(email: string, excludeUserId?: string) {
  const row = db
    .prepare(
      `SELECT id FROM users WHERE email = ?
       ${excludeUserId ? "AND id != ?" : ""}`
    )
    .get(...(excludeUserId ? [normalizeEmail(email), excludeUserId] : [normalizeEmail(email)]));
  if (row) throw new IdentityError("该邮箱已被占用", 409);
}

export function ensureEmployeeNumberAvailable(
  employeeNumber: string,
  excludeRequestId?: string,
  excludeProfileRequestId?: string
) {
  const normalized = normalizeEmployeeNumber(employeeNumber);
  if (
    db.prepare("SELECT 1 FROM employee_numbers WHERE employee_number = ?").get(normalized)
  ) {
    throw new IdentityError("该工号已经归属其他账号", 409);
  }
  const pending = db
    .prepare(
      `SELECT user_id AS id FROM pending_registration_employee_numbers
       WHERE employee_number = ?
       ${excludeRequestId ? "AND user_id != ?" : ""}`
    )
    .get(...(excludeRequestId ? [normalized, excludeRequestId] : [normalized]));
  if (pending) throw new IdentityError("该工号正在审核中", 409);
  const pendingProfile = db
    .prepare(
      `SELECT id FROM profile_change_requests
       WHERE requested_employee_number = ? AND status = 'PENDING'
       ${excludeProfileRequestId ? "AND id != ?" : ""}`
    )
    .get(
      ...(excludeProfileRequestId
        ? [normalized, excludeProfileRequestId]
        : [normalized])
    );
  if (pendingProfile) throw new IdentityError("该工号正在审核中", 409);
  return normalized;
}

export function insertRegistrationRevision(userId: string, revision: number) {
  const row = db
    .prepare(
      `SELECT u.username, u.display_name, u.email, er.employee_number
       FROM users u
       JOIN pending_registration_employee_numbers er ON er.user_id = u.id
       WHERE u.id = ?`
    )
    .get(userId) as
    | {
        username: string;
        display_name: string;
        email: string | null;
        employee_number: string;
      }
    | undefined;
  if (!row) throw new IdentityError("注册资料不完整", 409);
  db.prepare(
    `INSERT INTO registration_revisions(
      id, user_id, revision, username, display_name, email, employee_number, submitted_at
    ) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    userId,
    revision,
    row.username,
    row.display_name,
    row.email,
    row.employee_number,
    nowIso()
  );
}

export function deleteUnapprovedUser(
  userId: string,
  reasonCode: string,
  actorUserId: string | null,
  expectedRevision?: number,
  deferCheckpoint = false
) {
  const result = withImmediateTransaction(() => {
    const user = db
      .prepare("SELECT id, status, application_revision, created_at FROM users WHERE id = ?")
      .get(userId) as
      | { id: string; status: string; application_revision: number; created_at: string }
      | undefined;
    if (
      !user ||
      !["PENDING_APPROVAL", "CHANGES_REQUESTED"].includes(user.status) ||
      (expectedRevision !== undefined && user.application_revision !== expectedRevision)
    ) {
      throw new IdentityError("账号状态已经变化", 409);
    }
    db.prepare(
      `INSERT INTO registration_tombstones(
        user_id, reason_code, actor_user_id,
        registered_at, terminated_at
      ) VALUES(?, ?, ?, ?, ?)`
    ).run(
      userId,
      reasonCode,
      actorUserId,
      user.created_at,
      nowIso()
    );
    db.prepare("DELETE FROM email_outbox WHERE user_id = ? AND status != 'SENT'").run(userId);
    db.prepare(
      `UPDATE email_outbox
       SET user_id = NULL, to_email = '[redacted]', html = '[redacted]'
       WHERE user_id = ? AND status = 'SENT'`
    ).run(userId);
    db.prepare("DELETE FROM users WHERE id = ?").run(userId);
    return { userId };
  });
  if (!deferCheckpoint) checkpointSensitiveDeletion();
  return result;
}
