import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerStaticFiles } from "../server/static-files";

const fixtures: Array<{ root: string; app: ReturnType<typeof Fastify> }> = [];
afterEach(async () => {
  for (const { root, app } of fixtures.splice(0)) {
    await app.close();
    if (!root.startsWith(path.join(os.tmpdir(), "allocube-static-"))) throw new Error("Unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "allocube-static-"));
  const app = Fastify(); fixtures.push({ root, app });
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "index.html"), '<script src="/assets/main-abcdefgh.js"></script>');
  await writeFile(path.join(root, "assets/main-abcdefgh.js"), "window.version = 1;");
  await writeFile(path.join(root, "assets/theme.css"), "body {}");
  await registerStaticFiles(app, root); await app.ready();
  return { root, app };
}

it("HTML 和无版本文件使用条件请求，带哈希的资源长期缓存", async () => {
  const { app } = await fixture();
  for (const url of ["/", "/index.html", "/login", "/calendar", "/docs/api", "/assets/theme.css"]) {
    const initial = await app.inject(url);
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["cache-control"]).toBe("no-cache");
    expect(initial.headers.etag).toBeTruthy();
    const unchanged = await app.inject({ url, headers: { "if-none-match": String(initial.headers.etag) } });
    expect(unchanged.statusCode).toBe(304); expect(unchanged.body).toBe("");
    expect(unchanged.headers["cache-control"]).toBe("no-cache");
  }
  const asset = await app.inject("/assets/main-abcdefgh.js");
  expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
});

it("入口更新后返回新 HTML 和资源地址，旧版本资源不存在时不返回 HTML", async () => {
  const { root, app } = await fixture();
  const initial = await app.inject("/calendar");
  await writeFile(path.join(root, "assets/main-ijklmnop.js"), "window.version = 2;");
  await writeFile(path.join(root, "index.html"), '<!-- new release --><script src="/assets/main-ijklmnop.js"></script>');
  const updated = await app.inject({ url: "/calendar", headers: { "if-none-match": String(initial.headers.etag) } });
  expect(updated.statusCode).toBe(200); expect(updated.body).toContain("main-ijklmnop.js");
  expect(updated.headers.etag).not.toBe(initial.headers.etag);
  expect((await app.inject("/assets/main-ijklmnop.js")).body).toContain("version = 2");
  for (const url of ["/assets/missing-abcdefgh.js", "/assets/missing-abcdefgh.css?retry=1", "/api/v1/missing"]) {
    const missing = await app.inject(url);
    expect(missing.statusCode).toBe(404); expect(missing.headers["cache-control"]).toBe("no-store");
    expect(missing.body).not.toContain("<script");
  }
});
