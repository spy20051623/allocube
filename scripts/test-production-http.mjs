import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const TEST_PASSWORD = "LocalProduction123!";

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port =
    address && typeof address === "object"
      ? address.port
      : 0;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!port) throw new Error("无法分配本地测试端口");
  return port;
}

async function waitForHealth(origin, child, readLogs) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`生产服务提前退出\n${readLogs()}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.status === 200) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`生产服务未在预期时间内启动\n${readLogs()}`);
}

async function main() {
  const testRoot = await mkdtemp(
    path.join(tmpdir(), "allocube-production-http-")
  );
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let output = "";
  const child = spawn(
    process.execPath,
    ["dist-server/server/index.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        DATABASE_PATH: path.join(testRoot, "allocube.sqlite"),
        BOOTSTRAP_SITE_ORIGIN: origin,
        BOOTSTRAP_ADMIN_PASSWORD: TEST_PASSWORD,
        BOOTSTRAP_DEMO_DATA: "false"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  try {
    await waitForHealth(origin, child, () => output);

    const page = await fetch(`${origin}/login`);
    const html = await page.text();
    if (page.status !== 200 || !html.includes('<div id="root"></div>')) {
      throw new Error(`登录页检查失败：HTTP ${page.status}`);
    }

    for (const docsPath of ["/docs", "/docs/api", "/docs/troubleshooting/"]) {
      const docsPage = await fetch(`${origin}${docsPath}`);
      const docsHtml = await docsPage.text();
      if (docsPage.status !== 200 || !docsHtml.includes('<div id="root"></div>')) {
        throw new Error(`公开文档页不可用：${docsPath} HTTP ${docsPage.status}`);
      }
      if (docsPage.headers.has("access-control-allow-origin")) {
        throw new Error(`公开文档页意外开放了 CORS：${docsPath}`);
      }
    }

    const legacyDocs = await fetch(`${origin}/api/open/docs`, { redirect: "manual" });
    if (legacyDocs.status !== 302 || legacyDocs.headers.get("location") !== "/docs/api") {
      throw new Error("旧 API 文档入口没有重定向到统一文档中心");
    }

    const login = await fetch(`${origin}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin
      },
      body: JSON.stringify({
        identifierType: "USERNAME",
        identifier: "Administrator",
        password: TEST_PASSWORD
      })
    });
    const loginBody = await login.json();
    if (login.status !== 200) {
      throw new Error(
        `登录失败：HTTP ${login.status} ${JSON.stringify(loginBody)}`
      );
    }

    const setCookie = login.headers.get("set-cookie") ?? "";
    if (!setCookie.startsWith("resource_session=")) {
      throw new Error("生产 HTTP 登录没有返回预期会话 Cookie");
    }
    if (/;\s*Secure(?:;|$)/iu.test(setCookie)) {
      throw new Error("生产 HTTP 会话 Cookie 被错误设置为 Secure");
    }
    const cookie = setCookie.split(";", 1)[0];

    const session = await fetch(`${origin}/api/v1/auth/me`, {
      headers: { cookie }
    });
    if (session.status !== 200) {
      throw new Error(`会话读取失败：HTTP ${session.status}`);
    }

    const tokenCreation = await fetch(`${origin}/api/v1/auth/api-tokens`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/json",
        "x-csrf-token": loginBody.csrfToken
      },
      body: JSON.stringify({
        name: "生产 HTTP 验收",
        accessLevel: "READ_WRITE",
        expiresInDays: null,
        currentPassword: TEST_PASSWORD
      })
    });
    const tokenBody = await tokenCreation.json();
    if (
      tokenCreation.status !== 201 ||
      typeof tokenBody.secret !== "string" ||
      !tokenBody.secret.startsWith("allocube_pat_")
    ) {
      throw new Error(
        `个人访问令牌创建失败：HTTP ${tokenCreation.status} ${JSON.stringify(tokenBody)}`
      );
    }

    const openIdentity = await fetch(`${origin}/api/open/v1/me`, {
      headers: { authorization: `Bearer ${tokenBody.secret}` }
    });
    const openIdentityBody = await openIdentity.json();
    if (
      openIdentity.status !== 200 ||
      openIdentityBody.data?.token?.accessLevel !== "READ_WRITE"
    ) {
      throw new Error(`官方 API Bearer 鉴权失败：HTTP ${openIdentity.status}`);
    }
    if (openIdentity.headers.has("access-control-allow-origin")) {
      throw new Error("官方 API 意外开放了 CORS");
    }

    const cookieOnlyOpenApi = await fetch(`${origin}/api/open/v1/me`, {
      headers: { cookie }
    });
    if (cookieOnlyOpenApi.status !== 401) {
      throw new Error("官方 API 错误接受了 Cookie 会话");
    }

    const bearerMutationWithoutBrowserHeaders = await fetch(
      `${origin}/api/open/v1/reservation-operations/prepare`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.secret}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          action: "CANCEL",
          reservationId: "00000000-0000-4000-8000-000000000001"
        })
      }
    );
    const mutationBody = await bearerMutationWithoutBrowserHeaders.json();
    if (
      bearerMutationWithoutBrowserHeaders.status !== 404 ||
      mutationBody.error?.code !== "NOT_FOUND"
    ) {
      throw new Error(
        `Bearer 写请求未越过浏览器 CSRF 边界：HTTP ${bearerMutationWithoutBrowserHeaders.status}`
      );
    }

    const openApiDocument = await fetch(`${origin}/api/open/v1/openapi.json`);
    if (openApiDocument.status !== 200 || (await openApiDocument.json()).openapi !== "3.1.0") {
      throw new Error("OpenAPI 3.1 文档不可用");
    }
    if (openApiDocument.headers.has("access-control-allow-origin")) {
      throw new Error("OpenAPI 文档意外开放了 CORS");
    }

    const logout = await fetch(`${origin}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "x-csrf-token": loginBody.csrfToken
      }
    });
    if (logout.status !== 200) {
      throw new Error(`退出登录失败：HTTP ${logout.status}`);
    }

    const secureOrigin = origin.replace("http://", "https://");
    const secureLogin = await fetch(`${origin}/api/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: secureOrigin,
        "x-forwarded-proto": "https"
      },
      body: JSON.stringify({
        identifierType: "USERNAME",
        identifier: "Administrator",
        password: TEST_PASSWORD
      })
    });
    const secureCookie = secureLogin.headers.get("set-cookie") ?? "";
    if (secureLogin.status !== 200 || !/;\s*Secure(?:;|$)/iu.test(secureCookie)) {
      throw new Error("HTTPS 代理请求没有返回 Secure 会话 Cookie");
    }
    if (!secureLogin.headers.has("strict-transport-security")) {
      throw new Error("HTTPS 代理请求缺少 HSTS 响应头");
    }

    console.log(
      JSON.stringify({
        health: 200,
        page: page.status,
        docs: 200,
        legacyDocsRedirect: legacyDocs.status,
        login: login.status,
        session: session.status,
        tokenCreation: tokenCreation.status,
        openApiIdentity: openIdentity.status,
        openApiBearerMutation: bearerMutationWithoutBrowserHeaders.status,
        logout: logout.status,
        httpCookieSecure: false,
        httpsCookieSecure: true,
        httpsHsts: true
      })
    );
  } finally {
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", resolve);
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 3_000).unref();
    });
    const expectedPrefix = path.join(
      tmpdir(),
      "allocube-production-http-"
    );
    if (!testRoot.startsWith(expectedPrefix)) {
      throw new Error("拒绝清理非测试目录");
    }
    await rm(testRoot, { recursive: true, force: true });
  }
}

await main();
