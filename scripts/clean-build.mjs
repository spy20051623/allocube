import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
for (const name of ["dist", "dist-server"]) {
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    throw new Error(`拒绝清理工作区外路径：${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
