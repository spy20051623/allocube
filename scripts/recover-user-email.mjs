import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
const userId = args[0];
const apply = args[1] === "--apply";
const expectedEmail = args[2];
if (!userId || args.length > 3 || (args[1] && !apply) || (apply && !expectedEmail)) {
  throw new Error("用法：npm run admin:recover-email -- USER_ID [--apply EXPECTED_EMAIL]；默认只预览。");
}
const database = new Database(path.resolve(process.env.DATABASE_PATH ?? "./data/allocube.sqlite"), { fileMustExist: true });
database.pragma("foreign_keys = ON");
database.pragma("busy_timeout = 5000");
database.pragma("secure_delete = ON");
database.pragma("trusted_schema = OFF");
try {
  const user = database.prepare(`SELECT id,username,email FROM users WHERE id=? AND status='ACTIVE'
    AND NOT EXISTS(SELECT 1 FROM deleted_user_tombstones d WHERE d.user_id=users.id)`).get(userId);
  if (!user?.email) throw new Error("有效用户不存在或尚未绑定邮箱");
  if (!apply) {
    process.stdout.write(JSON.stringify({ user, effect: "清空失效邮箱，注销全部会话和重置凭据；用户重新登录后绑定新邮箱。请先通过团队可信流程核实身份。" }, null, 2) + "\n");
  } else {
    database.transaction(() => {
      const now = new Date().toISOString();
      const changed = database.prepare("UPDATE users SET email=NULL,version=version+1,updated_at=? WHERE id=? AND email=? AND status='ACTIVE'").run(now,userId,expectedEmail);
      if (!changed.changes) throw new Error("邮箱与预览不一致，请重新检查");
      database.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
      database.prepare("DELETE FROM auth_tokens WHERE user_id=?").run(userId);
      database.prepare("DELETE FROM email_verification_challenges WHERE user_id=?").run(userId);
      database.prepare("DELETE FROM email_outbox WHERE user_id=? AND status!='SENT'").run(userId);
      database.prepare("INSERT INTO audit_logs(id,actor_user_id,action,entity_type,entity_id,before_json,after_json,created_at) VALUES(?,NULL,'EMAIL_RECOVERY','user',?,?,?,?)")
        .run(randomUUID(),userId,JSON.stringify({ email:expectedEmail }),JSON.stringify({ email:null }),now);
    }).immediate();
    process.stdout.write("邮箱恢复已完成。请让用户重新登录并绑定、验证新邮箱。\n");
  }
} finally { database.close(); }
