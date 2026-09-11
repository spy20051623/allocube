import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { registerTerminalDownloads } from "../server/terminal-downloads";
import { terminalInstallCommand, type TerminalRelease } from "../src/features/terminal/install-command";

const fixtures: Array<{ root: string; app: ReturnType<typeof Fastify> }> = [];
afterEach(async () => {
  for (const { root, app } of fixtures.splice(0)) {
    await app.close();
    if (!root.startsWith(path.join(os.tmpdir(), "allocube-download-"))) throw new Error("Unexpected fixture path");
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "allocube-download-"));
  const app = Fastify(); fixtures.push({ root, app });
  registerTerminalDownloads(app, root); await app.ready();
  return { root, app };
}
it("只发布已构建的架构；下载绑定版本且不要求机器凭据", async () => {
  const { root, app } = await fixture();
  expect((await app.inject("/api/v1/terminal/downloads")).json()).toEqual({ releases: [] });
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff]);
  await writeFile(path.join(root, "allocube-deploy-linux-amd64.tar.gz"), binary);
  const manifest = await app.inject("/api/v1/terminal/downloads");
  expect(manifest.headers["cache-control"]).toBe("no-store");
  const releases = manifest.json().releases as TerminalRelease[];
  expect(releases).toHaveLength(1);
  expect(releases[0].architecture).toBe("amd64");
  expect(releases[0].path).toBe(`/api/v1/terminal/downloads/amd64/${releases[0].sha256}/allocube-deploy-linux-amd64.tar.gz`);
  const download = await app.inject(releases[0].path);
  expect(download.statusCode).toBe(200);
  expect(download.rawPayload).toEqual(binary);
  expect(download.headers["content-type"]).toBe("application/gzip");
  expect(download.headers["content-disposition"]).toBe('attachment; filename="allocube-deploy-linux-amd64.tar.gz"');
  const legacyPath = releases[0].path.slice(0, releases[0].path.lastIndexOf("/"));
  expect((await app.inject(legacyPath)).rawPayload).toEqual(binary);
  for (const filename of ["allocube-deploy-linux-arm64.tar.gz", "other.tar.gz", "config.json"]) {
    expect((await app.inject(`${legacyPath}/${filename}`)).statusCode).toBe(404);
  }
  await writeFile(path.join(root, "allocube-deploy-linux-amd64.tar.gz"), Buffer.from("new release"));
  expect((await app.inject(releases[0].path)).statusCode).toBe(404);
  expect((await app.inject(legacyPath)).statusCode).toBe(404);
  for (const url of ["/api/v1/terminal/downloads/mips/" + "a".repeat(64), "/api/v1/terminal/downloads/amd64/bad"]) {
    expect((await app.inject(url)).statusCode).toBe(404);
  }
});

const enrollment = { platformOrigin: "https://allocube.example.com:8443", terminalId: "12345678-1234-1234-1234-123456789012", enrollmentToken: "a".repeat(43), expiresIn: 600 };
const release: TerminalRelease = { architecture: "amd64", sha256: "b".repeat(64), path: `/api/v1/terminal/downloads/amd64/${"b".repeat(64)}/allocube-deploy-linux-amd64.tar.gz`, size: 42, format: "deployment-tar-v1" };
it("页面仅生成环境变量和本地脚本命令，架构由下载的包决定", () => {
  const x86 = terminalInstallCommand(enrollment, release);
  const arm = terminalInstallCommand(enrollment, { ...release, architecture: "arm64", path: release.path.replaceAll("amd64", "arm64") });
  expect(arm).toBe(x86);
  expect(x86.split("\n")).toEqual([
    `ALLOCUBE_PLATFORM='${enrollment.platformOrigin}' \\`,
    `ALLOCUBE_TERMINAL_ID='${enrollment.terminalId}' \\`,
    `ALLOCUBE_ENROLL_TOKEN='${enrollment.enrollmentToken}' \\`,
    "bash ./install.sh",
  ]);
});
it("无效来源、架构、摘要或注入内容不能生成可执行命令", () => {
  for (const bad of [ { ...enrollment, platformOrigin: "http://allocube.test" }, { ...enrollment, enrollmentToken: "a'; reboot #" }, { ...enrollment, terminalId: "\nALLOCUBE_INSTALL\n" } ]) {
    expect(() => terminalInstallCommand(bad, release)).toThrow();
  }
  for (const bad of [ { ...release, path: "https://attacker.test/file" }, { ...release, sha256: "$(reboot)" }, { ...release, architecture: "mips" as "amd64" } ]) {
    expect(() => terminalInstallCommand(enrollment, bad)).toThrow();
  }
});

it("内部 CA 仅通过环境变量交给包内脚本，且不更改系统信任", () => {
  const certificate = "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----";
  const command = terminalInstallCommand(enrollment, { ...release, caCertificate: certificate, caSha256: "c".repeat(64) });
  expect(command.split("\n").slice(-2)).toEqual([
    `ALLOCUBE_CA_CERT='${btoa(certificate + "\n")}' \\`,
    "bash ./install.sh",
  ]);
  expect(command).not.toContain("update-ca");
  expect(command).not.toContain("--insecure");
  expect(() => terminalInstallCommand(enrollment, { ...release, caCertificate: certificate + "\nALLOCUBE_INSTALL\nreboot", caSha256: "c".repeat(64) })).toThrow();
});

it("错误或夹带私钥的 CA 配置拒绝发布", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "allocube-download-"));
  const app = Fastify(); fixtures.push({ root, app });
  const ca = path.join(root, "ca.pem");
  await writeFile(ca, "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----");
  registerTerminalDownloads(app, root, ca); await app.ready();
  expect((await app.inject("/api/v1/terminal/downloads")).statusCode).toBe(503);
});
