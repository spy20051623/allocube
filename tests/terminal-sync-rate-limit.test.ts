import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allocube-sync-limits-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = path.join(directory, "db.sqlite");
process.env.BOOTSTRAP_ADMIN_PASSWORD = "Review234!";
const origin = "https://allocube.test";
const headers = { host: "allocube.test", "x-forwarded-proto": "https" };
const clients = Array.from({ length: 2 }, () => ({ id: randomUUID(), machineId: randomUUID(), key: generateKeyPairSync("ed25519") }));
let database: typeof import("../server/db.js");
let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  database = await import("../server/db.js");
  await database.initializeDatabase();
  database.db.prepare("UPDATE settings SET value=? WHERE key='public_site_origin'").run(origin);
  for (const client of clients) {
    const now = database.nowIso();
    database.db.prepare("INSERT INTO machines(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(client.machineId, client.id, now, now);
    database.db.prepare("INSERT INTO machine_terminals(id,machine_id,callback_url,public_key,created_at) VALUES(?,?,'',?,?)")
      .run(client.id, client.machineId, client.key.publicKey.export({ type: "spki", format: "pem" }), now);
  }
});
beforeEach(async () => {
  database.db.exec("DELETE FROM terminal_machine_challenges; DELETE FROM terminal_credentials; UPDATE machine_terminals SET enabled=1");
  app = Fastify({ trustProxy: true });
  // An intentionally restrictive global policy must not override machine routes.
  await app.register(rateLimit, { max: 1, timeWindow: "1 minute", hook: "preHandler", keyGenerator: () => "global-shared-source" });
  const { registerTerminalRoutes } = await import("../server/terminal.js");
  registerTerminalRoutes(app);
});
afterEach(async () => { await app.close(); });
afterAll(() => { database.db.close(); fs.rmSync(directory, { recursive: true, force: true }); });

async function challenge(client = clients[0]) {
  return app.inject({ method: "POST", url: "/api/v1/terminal/machine/challenge", headers, payload: { terminalId: client.id } });
}
async function exchange(client: typeof clients[number], value: string, signer = client) {
  const message = `allocube-machine-token-v2\n${client.id}\n${origin}/api/v1/terminal/machine/token\n${value}`;
  return app.inject({ method: "POST", url: "/api/v1/terminal/machine/token", headers, payload: {
    client_id: client.id, grant_type: "client_credentials", challenge: value,
    proof: sign(null, Buffer.from(message), signer.key.privateKey).toString("base64url"),
  } });
}
async function credential(client = clients[0]) {
  const issued = await challenge(client);
  expect(issued.statusCode).toBe(200);
  return exchange(client, issued.json().challenge);
}
async function keys(token: string) {
  return app.inject({ method: "POST", url: "/api/v1/terminal/machine/keys", headers: { ...headers, authorization: `Bearer ${token}` }, payload: { employees: ["12345678"] } });
}

it("allows machines sharing an IP to authenticate past 30 and pull past the global IP quota", async () => {
  const tokens: string[] = [];
  for (let i = 0; i < 40; i++) {
    const result = await credential(clients[i % 2]);
    expect(result.statusCode).toBe(200);
    tokens[i % 2] = result.json().access_token;
  }
  for (let i = 0; i < 320; i++) expect((await keys(tokens[i % 2])).statusCode).toBe(200);
});

it("counts verified machine identity across credentials while isolating other machines", async () => {
  const a = (await credential()).json().access_token;
  const b = (await credential()).json().access_token;
  const other = (await credential(clients[1])).json().access_token;
  for (let i = 0; i < 300; i++) expect((await keys(i % 2 ? a : b)).statusCode).toBe(200);
  const blocked = await keys(b);
  expect(blocked.statusCode).toBe(429);
  expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  expect((await keys(other)).statusCode).toBe(200);
  database.db.prepare("UPDATE machine_terminals SET enabled=0 WHERE id=?").run(clients[1].id);
  expect((await keys(other)).statusCode).toBe(403);
  database.db.prepare("UPDATE machine_terminals SET enabled=1 WHERE id=?").run(clients[1].id);
  database.db.prepare("UPDATE terminal_credentials SET expires_at='2000-01-01' WHERE token_hash=?")
    .run(createHash("sha256").update(other).digest("hex"));
  expect((await keys(other)).statusCode).toBe(401);
});

it("charges the authentication identity budget only after verifying a signature", async () => {
  const issued = (await challenge()).json().challenge;
  for (let i = 0; i < 65; i++) expect((await exchange(clients[0], issued, clients[1])).statusCode).toBe(401);
  expect((await exchange(clients[0], issued)).statusCode).toBe(200);
  for (let i = 1; i < 60; i++) expect((await credential()).statusCode).toBe(200);
  const blocked = await credential();
  expect(blocked.statusCode).toBe(429);
  expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  expect((await credential(clients[1])).statusCode).toBe(200);
});

it("keeps an IP abuse budget despite forged IDs, cookies or bearer strings", async () => {
  for (let i = 0; i <= 600; i++) {
    const response = await app.inject({ method: "POST", url: "/api/v1/terminal/machine/challenge", headers: {
      ...headers,
      cookie: `session=${randomUUID()}`, authorization: `Bearer ${randomBytes(32).toString("base64url")}`,
    }, payload: { terminalId: randomUUID() } });
    expect(response.statusCode).toBe(i < 600 ? 403 : 429);
    if (i === 600) expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  }
});
