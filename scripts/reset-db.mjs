import fs from "node:fs";
import path from "node:path";

if (process.env.NODE_ENV === "production") {
  throw new Error("生产环境禁止重置数据库");
}

const workspace = path.resolve(process.cwd());
const databasePath = path.resolve(
  workspace,
  process.env.DATABASE_PATH ?? "./data/allocube.sqlite"
);
const allowedRoot = path.resolve(workspace, "data") + path.sep;
if (!databasePath.startsWith(allowedRoot)) {
  throw new Error(`为避免误删，调试数据库必须位于 ${allowedRoot}`);
}

for (const target of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
  if (fs.existsSync(target)) fs.rmSync(target);
}

console.log(`调试数据库已重置：${databasePath}`);
