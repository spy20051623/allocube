import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createAdminFixture } from "./helpers/admin-fixture";

const fixture = createAdminFixture("admin-user-profile");
let ctx: Awaited<ReturnType<typeof fixture.start>>;
beforeAll(async () => { ctx = await fixture.start(); });
afterAll(() => fixture.close());

function user(number = "12345678", status = "ACTIVE") {
  const id = randomUUID(), now = ctx.database.nowIso();
  ctx.database.db.prepare(`INSERT INTO users(id,username,username_normalized,display_name,password_hash,role,status,created_at,updated_at)
    SELECT ?,?,?,?,password_hash,'USER',?,?,? FROM users WHERE role='SYSTEM_ADMIN' LIMIT 1`).run(id,id,id,"Original Name",status,now,now);
  ctx.database.db.prepare("INSERT INTO employee_numbers(id,user_id,employee_number,status,assigned_at,updated_at) VALUES(?,?,?,'ACTIVE',?,?)").run(randomUUID(),id,number,now,now);
  return id;
}
function edit(id: string, employeeNumber: string, expectedVersion = 1, displayName = "Updated Name", cookie = ctx.adminCookie, overwrite = false) {
  return ctx.app.inject({ method: "PATCH", url: `/api/v1/admin/users/${id}/profile`, headers: { cookie, ...(overwrite ? { "x-allocube-overwrite": "true" } : {}) }, payload: { displayName, employeeNumber, expectedVersion } });
}

it("updates identity atomically, retains historical numbers and records audit and notification", async () => {
  const id = user();
  const response = await edit(id, " WX123456 ");
  expect(response.statusCode,response.body).toBe(200);
  expect(response.json()).toEqual({ displayName: "Updated Name", employeeNumber: "wx123456", version: 2 });
  expect(ctx.database.db.prepare("SELECT employee_number,status FROM employee_numbers WHERE user_id=? ORDER BY status").all(id)).toEqual([
    {employee_number:"wx123456",status:"ACTIVE"}, {employee_number:"12345678",status:"INACTIVE"}
  ]);
  expect(ctx.database.db.prepare("SELECT username FROM users WHERE id=?").get(id)).toEqual({username:id});
  expect(ctx.database.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='USER_PROFILE_UPDATE' AND entity_id=?").get(id)).toEqual({n:1});
  expect(ctx.database.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND type='PROFILE_UPDATED_BY_ADMIN'").get(id)).toEqual({n:1});
  expect((await edit(id,"wx123456",1,"Stale Name")).statusCode).toBe(409);
  expect((await edit(id,"wx123456",1,"Confirmed Name",ctx.adminCookie,true)).statusCode).toBe(200);
});

it("rejects ordinary callers, system-admin targets and invalid fields", async () => {
  const id=user("12345679");
  const login=await ctx.app.inject({method:"POST",url:"/api/v1/auth/login",payload:{identifierType:"USERNAME",identifier:id,password:"SettingsConflict82!"}});
  expect(login.statusCode).toBe(200);
  const baseline=ctx.database.db.prepare("SELECT version FROM users WHERE id=?").get(id);
  const cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; ');
  expect((await edit(id,"12345680",1,"Denied",cookie)).statusCode).toBe(403);
  expect((await edit(id,"12345680",1,"Denied","")).statusCode).toBe(401);
  const admin=ctx.database.db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as {id:string};
  expect((await edit(admin.id,"12345680")).statusCode).toBe(403);
  expect((await edit(id,"bad-number")).statusCode).toBe(400);
  expect((await edit(id,"12345680",1,"x")).statusCode).toBe(400);
  expect(ctx.database.db.prepare("SELECT version FROM users WHERE id=?").get(id)).toEqual(baseline);
});

it("rejects reserved numbers and pending profile changes, preserving all original data", async () => {
  const id=user("12345681"), now=ctx.database.nowIso();
  const other=user("12345682");
  expect((await edit(id,"12345682")).statusCode).toBe(409);
  expect((await edit(id,"12345678")).statusCode).toBe(409);
  ctx.database.db.prepare("INSERT INTO profile_change_requests(id,user_id,current_display_name,current_employee_number,requested_display_name,requested_employee_number,status,requested_at,updated_at) VALUES(?,?,'Original Name','12345682',?,?,'PENDING',?,?)").run(randomUUID(),other,"Pending Name","12345683",now,now);
  expect((await edit(id,"12345683")).statusCode).toBe(409);
  expect((await edit(other,"12345684",1,"Admin Name",ctx.adminCookie,true)).statusCode).toBe(409);
  expect(ctx.database.db.prepare("SELECT display_name,version FROM users WHERE id=?").get(id)).toEqual({display_name:"Original Name",version:1});
  expect(ctx.database.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id=?").get(id)).toEqual({n:0});
});

it("supports disabled accounts without enabling them and rolls back if auditing fails", async () => {
  const id=user("12345685","DISABLED");
  expect((await edit(id,"12345686")).statusCode).toBe(200);
  expect(ctx.database.db.prepare("SELECT status FROM users WHERE id=?").get(id)).toEqual({status:"DISABLED"});
  ctx.database.db.exec("CREATE TEMP TRIGGER fail_profile_audit BEFORE INSERT ON audit_logs WHEN NEW.action='USER_PROFILE_UPDATE' BEGIN SELECT RAISE(ABORT,'test audit failure'); END;");
  try { expect((await edit(id,"12345687",2,"Rollback Name")).statusCode).toBe(500); }
  finally { ctx.database.db.exec("DROP TRIGGER fail_profile_audit"); }
  expect(ctx.database.db.prepare("SELECT display_name,version FROM users WHERE id=?").get(id)).toEqual({display_name:"Updated Name",version:2});
  expect(ctx.database.db.prepare("SELECT employee_number FROM employee_numbers WHERE user_id=? AND status='ACTIVE'").get(id)).toEqual({employee_number:"12345686"});
});
