import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceTree } from "./helpers/source-tree";

const sources = readSourceTree(new URL("../src/", import.meta.url));
function dependencies(file: string, source: string) {
  return [...source.matchAll(/\b(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/g)]
    .map(match => match[1]).filter(specifier => specifier.startsWith("."))
    .map(specifier => path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
}

describe("模块依赖边界", () => {
  it("公共组件和共享规则不反向依赖页面或服务端", () => {
    for (const [file, source] of sources) {
      if (!/^(components|shared)\//.test(file) || !/\.tsx?$/.test(file)) continue;
      for (const dependency of dependencies(file, source)) {
        expect(dependency, `${file} -> ${dependency}`).not.toMatch(/^(features|app|\.\.\/server)\/|^App$/);
      }
    }
  });

  it("业务功能不依赖应用入口和外壳", () => {
    for (const [file, source] of sources) {
      if (!file.startsWith("features/") || !/\.tsx?$/.test(file)) continue;
      for (const dependency of dependencies(file, source)) {
        expect(dependency, `${file} -> ${dependency}`).not.toMatch(/^App$|^app\/AppShell$/);
      }
    }
  });

  it("前端模块没有循环依赖", () => {
    const visiting = new Set<string>(), visited = new Set<string>();
    function visit(file: string, chain: string[]) {
      if (visited.has(file)) return;
      expect(visiting.has(file), [...chain, file].join(" -> ")).toBe(false);
      visiting.add(file);
      for (const dependency of dependencies(file, sources.get(file)!)) {
        const target = [`${dependency}.ts`, `${dependency}.tsx`, `${dependency}/index.ts`, `${dependency}/index.tsx`]
          .find(candidate => sources.has(candidate));
        if (target) visit(target, [...chain, file]);
      }
      visiting.delete(file);
      visited.add(file);
    }
    for (const file of sources.keys()) if (/\.tsx?$/.test(file)) visit(file, []);
  });

  it("管理领域服务不依赖 HTTP 框架或路由", () => {
    for (const [file, source] of readSourceTree(new URL("../server/admin/", import.meta.url))) {
      if (!file.endsWith("-service.ts")) continue;
      expect(source, file).not.toMatch(/from ["']fastify["']|from ["'][^"']*-routes(?:\.js)?["']/);
    }
  });
});
