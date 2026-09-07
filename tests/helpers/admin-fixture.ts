import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";

/** Configure the isolated database before any server module is imported. */
export function createAdminFixture(name: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `allocube-${name}-`));
  const password = "SettingsConflict82!";
  const sessionSecret = "settings-conflicts-test-secret-at-least-32-characters";
  process.env.NODE_ENV = "test";
  process.env.DATABASE_PATH = path.join(directory, "test.sqlite");
  process.env.BOOTSTRAP_ADMIN_PASSWORD = password;
  process.env.SESSION_SECRET = sessionSecret;
  let app: FastifyInstance | undefined;
  let database: typeof import("../../server/db.js") | undefined;

  return {
    async start(register?: (app: FastifyInstance) => Promise<void>) {
      database = await import("../../server/db.js");
      await database.initializeDatabase();
      app = Fastify();
      await app.register(cookie, { secret: sessionSecret });
      await register?.(app);
      (await import("../../server/routes-auth.js")).registerAuthRoutes(app);
      (await import("../../server/routes-schedule.js")).registerScheduleRoutes(app, () => undefined);
      (await import("../../server/routes-admin.js")).registerAdminRoutes(app, () => undefined);
      const login = await app.inject({
        method: "POST", url: "/api/v1/auth/login",
        payload: { identifierType: "USERNAME", identifier: "Administrator", password }
      });
      if (login.statusCode !== 200) throw new Error(`Fixture login failed: ${login.body}`);
      const adminCookie = login.cookies.map(item => `${item.name}=${item.value}`).join("; ");
      return { app, database, adminCookie };
    },
    async close() {
      try {
        await app?.close();
      } finally {
        database?.db.close();
        if (!path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)) {
          throw new Error("Fixture directory is outside the temporary directory");
        }
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  };
}
