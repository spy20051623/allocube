import path from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export async function registerStaticFiles(app: FastifyInstance, root: string) {
  await app.register(fastifyStatic, {
    root,
    prefix: "/",
    setHeaders(response, filePath) {
      const relative = path.relative(root, filePath).split(path.sep).join("/");
      // Only content-addressed build assets are safe to reuse without revalidation.
      const versioned = /^assets\/[^/]+-[\w-]{8,}\.[a-z0-9]+$/i.test(relative);
      response.header("Cache-Control", versioned
        ? "public, max-age=31536000, immutable"
        : "no-cache");
    }
  });
  app.setNotFoundHandler((request, reply) => {
    const pathname = request.url.split("?")[0];
    // A stale chunk URL must fail instead of caching the SPA HTML as JavaScript.
    if (pathname.startsWith("/assets/")) {
      return reply.header("Cache-Control", "no-store").code(404).send({ error: "资源不存在" });
    }
    if (request.method === "GET" && !pathname.startsWith("/api/")) {
      return reply.sendFile("index.html");
    }
    return reply.header("Cache-Control", "no-store").code(404).send({ error: "接口不存在" });
  });
}
