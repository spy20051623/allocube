import { createHash, X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";

const architectures = ["amd64", "arm64"] as const;
type Architecture = typeof architectures[number];

// Public release artifacts contain no machine credentials or configuration.
export function registerTerminalDownloads(app: FastifyInstance, root = path.resolve("terminal/dist"), caFile = process.env.TERMINAL_CA_CERT_FILE) {
  const cache = new Map<Architecture, { stamp: string; data: Buffer; sha256: string }>();
  async function artifact(architecture: Architecture) {
    const file = path.join(root, `allocube-deploy-linux-${architecture}.tar.gz`);
    try {
      const info = await stat(file);
      const stamp = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
      let entry = cache.get(architecture);
      if (entry?.stamp !== stamp) {
        const data = await readFile(file);
        entry = { stamp, data, sha256: createHash("sha256").update(data).digest("hex") };
        cache.set(architecture, entry);
      }
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  app.get("/api/v1/terminal/downloads", async (_request, reply) => {
    let caCertificate: string | undefined;
    if (caFile) {
      try {
        const text = await readFile(caFile, "utf8");
        const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
        if (text.length > 65536 || !blocks?.length || blocks.reduce((rest, block) => rest.replace(block, ""), text).trim()) throw new Error("Invalid CA bundle");
        caCertificate = blocks.map((block) => new X509Certificate(block).toString()).join("\n");
      } catch {
        return reply.code(503).send({ error: "平台接入证书配置无效，请联系管理员" });
      }
    }
    const releases = await Promise.all(architectures.map(async (architecture) => {
      const file = await artifact(architecture);
      return file ? { architecture, format: "deployment-tar-v1", sha256: file.sha256, size: file.data.length, ...(caCertificate ? { caCertificate, caSha256: createHash("sha256").update(caCertificate).digest("hex") } : {}),
        path: `/api/v1/terminal/downloads/${architecture}/${file.sha256}/allocube-deploy-linux-${architecture}.tar.gz` } : null;
    }));
    return reply.header("Cache-Control", "no-store").send({ releases: releases.filter(Boolean) });
  });
  // Keep existing hash-only links usable for the same published package.
  for (const route of ["/api/v1/terminal/downloads/:architecture/:sha256", "/api/v1/terminal/downloads/:architecture/:sha256/:filename"]) {
    app.get<{ Params: { architecture: string; sha256: string; filename?: string } }>(route, async (request, reply) => {
      const { architecture, sha256, filename } = request.params;
      if (!architectures.includes(architecture as Architecture) || !/^[a-f0-9]{64}$/.test(sha256) ||
          (filename !== undefined && filename !== `allocube-deploy-linux-${architecture}.tar.gz`)) {
        return reply.code(404).send({ error: "安装程序不存在" });
      }
      const file = await artifact(architecture as Architecture);
      if (!file || file.sha256 !== sha256) {
        return reply.code(404).send({ error: "安装程序版本已变化，请重新打开接入页面" });
      }
      return reply.type("application/gzip")
        .header("Content-Disposition", `attachment; filename="allocube-deploy-linux-${architecture}.tar.gz"`)
        .header("Cache-Control", "no-store").send(file.data);
    });
  }
}
