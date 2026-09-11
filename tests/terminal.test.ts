import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createHash,
  createECDH,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-terminal-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Admin12#$";
let app: ReturnType<typeof Fastify>;
let db: typeof import("../server/db.js");
let auth: typeof import("../server/auth.js");
let identity: typeof import("../server/identity.js");
let adminCookie = "",
  adminId = "",
  userId = "";
const machineId = randomUUID(),
  otherMachine = randomUUID();
const origin = "https://allocube.test";
const headers = { host: "allocube.test", "x-forwarded-proto": "https", origin };
const token = () => randomBytes(32).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
type Client = {
  id: string;
  callback: string;
  key: ReturnType<typeof generateKeyPairSync>;
};
const clients: Client[] = [];

beforeAll(async () => {
  db = await import("../server/db.js");
  auth = await import("../server/auth.js");
  identity = await import("../server/identity.js");
  await db.initializeDatabase();
  db.db
    .prepare("UPDATE settings SET value=? WHERE key='public_site_origin'")
    .run(origin);
  const { encryptSmtpPassword } = await import("../server/smtp-settings.js");
  db.db
    .prepare(
      "UPDATE smtp_settings SET enabled=0,host='smtp.test.local',port=465,security='IMPLICIT_TLS',username='test',password_encrypted=?,from_address='sender@example.com'",
    )
    .run(encryptSmtpPassword("test"));
  adminId = (
    db.db.prepare("SELECT id FROM users WHERE role='SYSTEM_ADMIN'").get() as {
      id: string;
    }
  ).id;
  userId = randomUUID();
  const now = db.nowIso();
  db.db
    .prepare(
      "INSERT INTO users(id,username,username_normalized,email,display_name,password_hash,role,status,created_at,updated_at) VALUES(?, 'worker','worker',NULL,'Worker',?,'USER','ACTIVE',?,?)",
    )
    .run(userId, await auth.hashPassword("Worker123!"), now, now);
  db.db
    .prepare(
      "INSERT INTO employee_numbers(id,user_id,employee_number,status,assigned_at,updated_at) VALUES(?,?,'12345678','ACTIVE',?,?)",
    )
    .run(randomUUID(), userId, now, now);
  for (const id of [machineId, otherMachine])
    db.db
      .prepare(
        "INSERT INTO machines(id,name,address,created_at,updated_at) VALUES(?,?,'10.0.0.1',?,?)",
      )
      .run(id, `Test ${id}`, now, now);
  db.db
    .prepare(
      "INSERT INTO machine_access_memberships(id,machine_id,user_id,source,created_at,updated_at) VALUES(?,?,?,'ADMIN_INVITE',?,?)",
    )
    .run(randomUUID(), machineId, userId, now, now);
  app = Fastify({ trustProxy: true });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const { registerAuthRoutes } = await import("../server/routes-auth.js");
  const { registerTerminalRoutes } = await import("../server/terminal.js");
  registerAuthRoutes(app);
  registerTerminalRoutes(app);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: {
      identifierType: "USERNAME",
      identifier: "administrator",
      password: "Admin12#$",
    },
  });
  expect(login.statusCode).toBe(200);
  adminCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  clients.push(await enroll(machineId), await enroll(otherMachine));
});
afterAll(async () => {
  await app?.close();
  db?.db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
async function enroll(id: string): Promise<Client> {
  const callback = `https://10.0.0.${id === machineId ? "1" : "2"}:8443/callback`;
  const registration = await app.inject({
    method: "POST",
    url: `/api/v1/admin/machines/${id}/terminal`,
    headers: { ...headers, cookie: adminCookie },
    payload: { callbackUrl: callback },
  });
  expect(registration.statusCode).toBe(200);
  const body = registration.json();
  const key = generateKeyPairSync("ed25519");
  const payload = {
    terminalId: body.terminalId,
    enrollmentToken: body.enrollmentToken,
    publicKey: key.publicKey.export({ type: "spki", format: "pem" }),
    proof: sign(
      null,
      Buffer.from(`allocube-enroll:${body.terminalId}:${body.enrollmentToken}`),
      key.privateKey,
    ).toString("base64url"),
  };
  const first = await app.inject({
    method: "POST",
    url: "/api/v1/terminal/machine/enroll",
    headers,
    payload,
  });
  expect(first.statusCode).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/terminal/machine/enroll",
        headers,
        payload,
      })
    ).statusCode,
  ).toBe(401);
  return { id: body.terminalId, key, callback };
}
function assertion(client: Client, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iss: client.id,
    sub: client.id,
    aud: origin + "/api/v1/terminal/machine/token",
    iat: now,
    exp: now + 60,
    jti: token(),
    ...overrides,
  };
  const unsigned =
    Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url") +
    "." +
    Buffer.from(JSON.stringify(body)).toString("base64url");
  return (
    unsigned +
    "." +
    sign(null, Buffer.from(unsigned), client.key.privateKey).toString(
      "base64url",
    )
  );
}
async function machineToken(client: Client, jwt = assertion(client)) {
  return app.inject({
    method: "POST",
    url: "/api/v1/terminal/machine/token",
    headers,
    payload: {
      client_id: client.id,
      grant_type: "client_credentials",
      client_assertion_type:
        "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: jwt,
    },
  });
}
async function machineCall(client: Client, action: string, payload: unknown) {
  const minted = await machineToken(client);
  expect(minted.statusCode).toBe(200);
  return app.inject({
    method: "POST",
    url: `/api/v1/terminal/machine/${action}`,
    headers: {
      ...headers,
      authorization: `Bearer ${minted.json().access_token}`,
    },
    payload: payload as any,
  });
}

describe("public key synchronization", () => {
  let workerCookie = "", keyId = "";
  const pair = generateKeyPairSync("ed25519");
  const raw = pair.publicKey.export({format:"jwk"}).x!;
  const field = (value:Buffer) => {const n=Buffer.alloc(4);n.writeUInt32BE(value.length);return Buffer.concat([n,value])};
  const publicKey = "ssh-ed25519 " + Buffer.concat([field(Buffer.from("ssh-ed25519")),field(Buffer.from(raw,"base64url"))]).toString("base64") + " laptop";
  it("authenticates machine signatures and rejects replay, expired and wrong audience assertions", async () => {
    const jwt=assertion(clients[0]);expect((await machineToken(clients[0],jwt)).statusCode).toBe(200);
    expect((await machineToken(clients[0],jwt)).statusCode).toBe(401);
    expect((await machineToken(clients[0],assertion(clients[0],{aud:"https://wrong.test"}))).statusCode).toBe(401);
    expect((await machineToken(clients[0],assertion(clients[0],{exp:1}))).statusCode).toBe(401);
    expect((await machineToken(clients[1],assertion(clients[0]))).statusCode).toBe(401);
  });
  it.each([[-60,401],[-59,200],[-1,200],[0,200],[1,200],[5,200],[6,401]])(
    "checks 60-second machine assertions with a clock offset of %i seconds",
    async (offset, status) => {
      const now = Math.floor(Date.now() / 1000);
      const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      try {
        const jwt = assertion(clients[0], { iat: now + offset, exp: now + offset + 60 });
        expect((await machineToken(clients[0], jwt)).statusCode).toBe(status);
        if (status === 200) expect((await machineToken(clients[0], jwt)).statusCode).toBe(401);
      } finally { clock.mockRestore(); }
    },
  );
  it("rejects nonpositive and oversized assertion lifetimes even within clock tolerance", async () => {
    const now = Math.floor(Date.now() / 1000);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    try {
      for (const [iat, exp] of [[5,5],[5,4],[0,61]]) {
        expect((await machineToken(clients[0], assertion(clients[0], { iat: now + iat, exp: now + exp }))).statusCode).toBe(401);
      }
    } finally { clock.mockRestore(); }
  });
  it("keeps only machine key routes outside browser CSRF protection", async () => {
    const {isTerminalProtocolPath}=await import("../server/terminal");
    expect(isTerminalProtocolPath("/api/v1/terminal/machine/keys")).toBe(true);
    for(const path of ["/api/v1/auth/ssh-keys","/api/v1/terminal/machine/begin","/api/v1/terminal/machine/exchange","/api/v1/terminal/browser/123/password"])expect(isTerminalProtocolPath(path)).toBe(false);
    expect((await app.inject({method:"POST",url:"/api/v1/terminal/machine/keys",headers,payload:{employees:["12345678"]}})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/api/v1/terminal/machine/begin",headers,payload:{}})).statusCode).toBe(404);
  });
  it("adds personal public keys when email is disabled and rejects duplicate or unsafe keys", async () => {
    const login=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{identifierType:"USERNAME",identifier:"worker",password:"Worker123!"}});
    expect(login.statusCode).toBe(200);workerCookie=login.cookies.map(c=>`${c.name}=${c.value}`).join("; ");
    const add=(key:string)=>app.inject({method:"POST",url:"/api/v1/auth/ssh-keys",headers:{...headers,cookie:workerCookie},payload:{name:"Laptop",publicKey:key}});
    const added=await add(publicKey);expect(added.statusCode).toBe(200);keyId=added.json().keys[0].id;
    expect(added.body).not.toContain("Worker123!");expect((await add(publicKey)).statusCode).toBe(409);
    const {parsePersonalKey}=await import("../server/ssh-keys");
    for(const invalid of ["command=\"sh\" "+publicKey,publicKey+"\n"+publicKey,"-----BEGIN PRIVATE KEY-----","ssh-ed25519 AAAA",publicKey.replace("ssh-ed25519 ","ssh-rsa ")])expect(()=>parsePersonalKey(invalid)).toThrow();
  });
  it.each([
    ["nistp256", "prime256v1"], ["nistp384", "secp384r1"], ["nistp521", "secp521r1"],
  ])("rejects non-SSH ECDSA encodings for %s before storing a key", async (curve, opensslCurve) => {
    const { parsePersonalKey } = await import("../server/ssh-keys");
    const ecdh = createECDH(opensslCurve); ecdh.generateKeys();
    const field = (value: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); return Buffer.concat([size, value]); };
    const encode = (point: Buffer) => `ecdsa-sha2-${curve} ${Buffer.concat([field(Buffer.from(`ecdsa-sha2-${curve}`)), field(Buffer.from(curve)), field(point)]).toString("base64")}`;
    const valid = encode(ecdh.getPublicKey(undefined, "uncompressed"));
    expect(parsePersonalKey(valid).publicKey).toBe(valid);
    const before = db.db.prepare("SELECT COUNT(*) AS n FROM user_ssh_keys WHERE user_id=?").get(userId);
    for (const point of [ecdh.getPublicKey(undefined, "compressed"), ecdh.getPublicKey(undefined, "hybrid"), Buffer.from([4, 0])]) {
      const key = encode(point);
      expect(() => parsePersonalKey(key)).toThrow();
      const result = await app.inject({ method: "POST", url: "/api/v1/auth/ssh-keys", headers: { ...headers, cookie: workerCookie }, payload: { name: "Invalid curve encoding", publicKey: key } });
      expect(result.statusCode).toBe(400);
    }
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM user_ssh_keys WHERE user_id=?").get(userId)).toEqual(before);
  });
  it("requires per-machine activation, prevents ownership bypass and isolates machines", async () => {
    expect((await machineCall(clients[0],"keys",{employees:["12345678"]})).json().users[0].keys).toEqual([]);
    const url=`/api/v1/auth/ssh-keys/${keyId}/activations`;
    const toggle=(active:boolean,cookie=workerCookie)=>app.inject({method:"PUT",url,headers:{...headers,cookie},payload:{machineIds:active?[machineId]:[]}});
    expect((await toggle(true,adminCookie)).statusCode).toBe(404);
    expect((await app.inject({method:"PUT",url:`/api/v1/auth/ssh-keys/${keyId}/activations`,headers:{...headers,cookie:workerCookie},payload:{machineIds:[machineId,otherMachine]}})).statusCode).toBe(403);
    expect((await toggle(true)).statusCode).toBe(200);
    expect((await toggle(true)).statusCode).toBe(200);
    expect((await machineCall(clients[0],"keys",{employees:["12345678"]})).json().users[0].keys[0].id).toBe(keyId);
    expect((await toggle(false)).statusCode).toBe(200);
    expect((await machineCall(clients[0],"keys",{employees:["12345678"]})).json().users[0].keys).toEqual([]);
    expect((await app.inject({method:"GET",url:"/api/v1/auth/ssh-keys",headers:{cookie:workerCookie}})).json().keys).toHaveLength(1);
    const now=db.nowIso();
    db.db.prepare("INSERT INTO machine_access_memberships(id,machine_id,user_id,source,created_at,updated_at) VALUES(?,?,?,'ADMIN_INVITE',?,?)").run(randomUUID(),otherMachine,userId,now,now);
    const batch=(machineIds:string[])=>app.inject({method:"PUT",url,headers:{...headers,cookie:workerCookie},payload:{machineIds}});
    expect((await batch([machineId,otherMachine])).statusCode).toBe(200);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM machine_ssh_keys WHERE key_id=?").get(keyId)).toEqual({n:2});
    expect((await batch([otherMachine])).statusCode).toBe(200);
    expect((await machineCall(clients[0],"keys",{employees:["12345678"]})).json().users[0].keys).toEqual([]);
    expect((await machineCall(clients[1],"keys",{employees:["12345678"]})).json().users[0].keys[0].id).toBe(keyId);
    expect((await batch([machineId,randomUUID()])).statusCode).toBe(403);
    expect(db.db.prepare("SELECT machine_id FROM machine_ssh_keys WHERE key_id=?").all(keyId)).toEqual([{machine_id:otherMachine}]);
    await batch([machineId]);
    db.db.prepare("DELETE FROM machine_access_memberships WHERE machine_id=? AND user_id=?").run(otherMachine,userId);

  });
  it("marks machines without enabled enrollment as preconfiguration without blocking activation", async () => {
    const id=randomUUID(), terminalId=randomUUID(), now=db.nowIso();
    db.db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(id,"Pending sync",now,now);
    db.db.prepare("INSERT INTO machine_access_memberships(id,machine_id,user_id,source,created_at,updated_at) VALUES(?,?,?,'ADMIN_INVITE',?,?)").run(randomUUID(),id,userId,now,now);
    const url=`/api/v1/auth/ssh-keys/${keyId}/activations`;
    const get=async()=> (await app.inject({method:"GET",url,headers:{...headers,cookie:workerCookie}})).json().machines.find((m:{id:string})=>m.id===id);
    try {
      expect(await get()).toMatchObject({available:true,syncEnabled:false});
      const activate=await app.inject({method:"PUT",url,headers:{...headers,cookie:workerCookie},payload:{machineIds:[machineId,id]}});
      expect(activate.statusCode).toBe(200);
      expect(await get()).toMatchObject({active:true,syncEnabled:false});
      db.db.prepare("INSERT INTO machine_terminals(id,machine_id,callback_url,created_at) VALUES(?,?,'',?)").run(terminalId,id,now);
      expect(await get()).toMatchObject({syncEnabled:false});
      db.db.prepare("UPDATE machine_terminals SET public_key=? WHERE id=?").run(pair.publicKey.export({type:"spki",format:"pem"}),terminalId);
      expect(await get()).toMatchObject({syncEnabled:true});
      db.db.prepare("UPDATE machine_terminals SET enabled=0 WHERE id=?").run(terminalId);
      expect(await get()).toMatchObject({active:true,available:true,syncEnabled:false});
    } finally { db.db.prepare("DELETE FROM machines WHERE id=?").run(id); }
  });
  it("pulls exact authorized employee lists, distinguishes missing users and denies other machines", async () => {
    const result=await machineCall(clients[0],"keys",{employees:["12345678","87654321"]});expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({terminalId:clients[0].id,users:[{employeeNumber:"12345678",status:"OK",keys:[{id:keyId,publicKey}]},{employeeNumber:"87654321",status:"NOT_FOUND",keys:[]}]});
    const other=await machineCall(clients[1],"keys",{employees:["12345678"]});expect(other.json().users).toEqual([{employeeNumber:"12345678",status:"DENIED",keys:[]}]);
    db.db.prepare("DELETE FROM machine_access_memberships WHERE machine_id=? AND user_id=?").run(machineId,userId);
    expect((await machineCall(clients[0],"keys",{employees:["12345678"]})).json().users[0]).toEqual({employeeNumber:"12345678",status:"DENIED",keys:[]});
    const now=db.nowIso();db.db.prepare("INSERT INTO machine_access_memberships(id,machine_id,user_id,source,created_at,updated_at) VALUES(?,?,?,'ADMIN_INVITE',?,?)").run(randomUUID(),machineId,userId,now,now);
  });
  it("deletes only owned keys and returns an explicit successful empty set", async () => {
    const url=`/api/v1/auth/ssh-keys/${keyId}`;
    expect((await app.inject({method:"DELETE",url,headers:{...headers,cookie:adminCookie},payload:{}})).statusCode).toBe(404);
    expect((await app.inject({method:"DELETE",url,headers:{...headers,cookie:workerCookie},payload:{}})).statusCode).toBe(200);
    expect((await machineCall(clients[0],"keys",{employees:["12345678"]})).json().users).toEqual([{employeeNumber:"12345678",status:"OK",keys:[]}]);
    const logs=JSON.stringify(db.db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'SSH_KEY_%'").all());expect(logs).not.toContain("Worker123!");expect(logs).not.toContain(publicKey);
  });
  it("optionally activates new keys only on currently available machines and rolls back failed activation", async () => {
    const h = {...headers, cookie: workerCookie, "x-forwarded-for": "192.0.2.91"};
    const add = () => app.inject({method:"POST",url:"/api/v1/auth/ssh-keys",headers:h,payload:{name:"Auto activation",publicKey,autoActivateAll:true}});
    const remove = (id:string) => app.inject({method:"DELETE",url:`/api/v1/auth/ssh-keys/${id}`,headers:h,payload:{}});
    const activations = (id:string) => db.db.prepare("SELECT machine_id FROM machine_ssh_keys WHERE key_id=? ORDER BY machine_id").all(id);
    const first = await add();
    expect(first.statusCode).toBe(200);
    expect(first.json().autoActivatedMachineCount).toBe(1);
    expect(activations(first.json().createdKeyId)).toEqual([{machine_id:machineId}]);
    expect((await add()).statusCode).toBe(409);
    await remove(first.json().createdKeyId);
    const now=db.nowIso();
    db.db.prepare("INSERT INTO machine_access_memberships(id,machine_id,user_id,source,created_at,updated_at) VALUES(?,?,?,'ADMIN_INVITE',?,?)").run(randomUUID(),otherMachine,userId,now,now);
    try {
      const both=await add();expect(both.statusCode).toBe(200);expect(both.json().autoActivatedMachineCount).toBe(2);
      expect(activations(both.json().createdKeyId)).toHaveLength(2);
      expect(db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action='SSH_KEY_ACTIVATE' AND after_json LIKE ?").get(`%${both.json().createdKeyId}%`)).toEqual({n:2});
      await remove(both.json().createdKeyId);
      db.db.prepare("UPDATE machines SET status='DISABLED' WHERE id=?").run(machineId);
      const one=await add();expect(one.statusCode).toBe(200);expect(activations(one.json().createdKeyId)).toEqual([{machine_id:otherMachine}]);await remove(one.json().createdKeyId);
      db.db.prepare("UPDATE machines SET status='DISABLED' WHERE id=?").run(otherMachine);
      const none=await add();expect(none.statusCode).toBe(200);expect(none.json().autoActivatedMachineCount).toBe(0);await remove(none.json().createdKeyId);
      db.db.prepare("UPDATE machines SET status='ACTIVE' WHERE id IN (?,?)").run(machineId,otherMachine);
      const before=db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get();
      db.db.exec("CREATE TEMP TRIGGER fail_test_key_activation BEFORE INSERT ON machine_ssh_keys BEGIN SELECT RAISE(ABORT,'test activation failure'); END");
      try {
        expect((await add()).statusCode).toBe(500);
        expect(db.db.prepare("SELECT id FROM user_ssh_keys WHERE user_id=?").all(userId)).toEqual([]);
        expect(db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs").get()).toEqual(before);
      } finally { db.db.exec("DROP TRIGGER fail_test_key_activation"); }
    } finally {
      db.db.prepare("UPDATE machines SET status='ACTIVE' WHERE id IN (?,?)").run(machineId,otherMachine);
      db.db.prepare("DELETE FROM machine_access_memberships WHERE machine_id=? AND user_id=?").run(otherMachine,userId);
      db.db.prepare("DELETE FROM user_ssh_keys WHERE user_id=?").run(userId);
    }
  });
  it("enforces all email-policy branches, single-use operation-bound codes and email failures", async () => {
    const get=()=>app.inject({method:"GET",url:"/api/v1/auth/ssh-keys",headers:{cookie:workerCookie}});
    const add=(proof:Record<string,string>={},name="Verified laptop",cookie=workerCookie)=>app.inject({method:"POST",url:"/api/v1/auth/ssh-keys",headers:{...headers,cookie},payload:{name,publicKey,...proof}});
    const send=async(operation:unknown)=>{
      db.db.prepare("UPDATE email_verification_challenges SET last_sent_at='2000-01-01T00:00:00Z' WHERE purpose='SSH_KEY'").run();
      const result=await app.inject({method:"POST",url:"/api/v1/auth/ssh-keys/email-code",headers:{...headers,cookie:workerCookie},payload:operation as any});
      expect(result.statusCode).toBe(200);
      const row=db.db.prepare("SELECT html FROM email_outbox WHERE subject='Allocube 公钥操作验证码' ORDER BY rowid DESC LIMIT 1").get() as {html:string};
      const code=row.html.match(/<strong>(\d{6})<\/strong>/)![1];
      expect(result.body).not.toContain(code);
      return {challengeId:result.json().challengeId as string,code};
    };
    expect((await get()).json().emailVerification).toBe("SKIP");
    db.db.prepare("UPDATE smtp_settings SET enabled=1,version=version+1").run();
    db.db.prepare("UPDATE settings SET value='1' WHERE key='allow_registration_without_email'").run();
    expect((await get()).json().emailVerification).toBe("SKIP");
    const skipped=await add();expect(skipped.statusCode).toBe(200);
    await app.inject({method:"DELETE",url:`/api/v1/auth/ssh-keys/${skipped.json().keys[0].id}`,headers:{...headers,cookie:workerCookie},payload:{}});
    db.db.prepare("UPDATE settings SET value='0' WHERE key='allow_registration_without_email'").run();
    expect((await get()).json().emailVerification).toBe("BIND_REQUIRED");
    expect((await add()).statusCode).toBe(409);
    db.db.prepare("UPDATE users SET email='ssh@example.com' WHERE id=?").run(userId);
    expect((await get()).json().emailVerification).toBe("REQUIRED");
    expect((await add()).statusCode).toBe(403);
    const op={kind:"ADD",name:"Verified laptop",publicKey};
    const proof=await send(op);
    const wrong={...proof,code:String((Number(proof.code)+1)%1000000).padStart(6,"0")};
    expect((await add(wrong)).statusCode).toBe(400);
    expect(db.db.prepare("SELECT attempts FROM email_verification_challenges WHERE id=?").get(proof.challengeId)).toEqual({attempts:1});
    expect((await add(proof,"Changed name")).statusCode).toBe(403);
    const another=await app.inject({method:"POST",url:"/api/v1/auth/login",payload:{identifierType:"USERNAME",identifier:"worker",password:"Worker123!"}});
    const otherCookie=another.cookies.map(c=>`${c.name}=${c.value}`).join("; ");
    expect((await add(proof,"Verified laptop",otherCookie)).statusCode).toBe(403);
    const created=await app.inject({method:"POST",url:"/api/v1/auth/ssh-keys",headers:{...headers,cookie:workerCookie},payload:{name:"Verified laptop",publicKey,autoActivateAll:true,...proof}});expect(created.statusCode).toBe(200);expect(created.json().autoActivatedMachineCount).toBe(1);const id=created.json().keys[0].id;
    expect((await add(proof)).statusCode).toBe(400);
    await app.inject({method:"PUT",url:`/api/v1/auth/ssh-keys/${id}/activations`,headers:{...headers,cookie:workerCookie},payload:{machineIds:[machineId]}});
    const remove=(p:Record<string,string>)=>app.inject({method:"DELETE",url:`/api/v1/auth/ssh-keys/${id}`,headers:{...headers,cookie:workerCookie},payload:p});
    const removal=await send({kind:"REMOVE",keyId:id});
    db.db.prepare("UPDATE users SET email='changed@example.com' WHERE id=?").run(userId);
    expect((await remove(removal)).statusCode).toBe(403);
    db.db.prepare("UPDATE users SET email='ssh@example.com' WHERE id=?").run(userId);
    db.db.prepare("UPDATE email_verification_challenges SET expires_at='2000-01-01' WHERE id=?").run(removal.challengeId);
    expect((await remove(removal)).statusCode).toBe(400);
    const finalProof=await send({kind:"REMOVE",keyId:id});expect((await remove(finalProof)).statusCode).toBe(200);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM machine_ssh_keys WHERE key_id=?").get(id)).toEqual({n:0});
    const logs=JSON.stringify(db.db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'SSH_KEY_%'").all());expect(logs).not.toContain(proof.code);expect(logs).not.toContain(finalProof.code);
    db.db.prepare("UPDATE smtp_settings SET host='',version=version+1").run();
    expect((await app.inject({method:"POST",url:"/api/v1/auth/ssh-keys/email-code",headers:{...headers,cookie:workerCookie},payload:op})).statusCode).toBe(503);
    expect((await add()).statusCode).toBe(403);
    db.db.prepare("UPDATE smtp_settings SET enabled=0,host='smtp.test.local',version=version+1").run();
    db.db.prepare("UPDATE users SET email=NULL WHERE id=?").run(userId);
    db.db.prepare("UPDATE settings SET value='1' WHERE key='allow_registration_without_email'").run();
  });
  it("disabling an enrollment rejects already issued machine credentials", async () => {
    const token=(await machineToken(clients[1])).json().access_token;
    db.db.prepare("UPDATE machine_terminals SET enabled=0 WHERE id=?").run(clients[1].id);
    expect((await app.inject({method:"POST",url:"/api/v1/terminal/machine/keys",headers:{...headers,authorization:`Bearer ${token}`},payload:{employees:["12345678"]}})).statusCode).toBe(403);
  });
});
