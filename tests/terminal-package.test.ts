import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
// @ts-expect-error Build script is shared with Node, intentionally plain JavaScript.
import { terminalPackage } from "../scripts/package-terminal.mjs";

it.each(["amd64", "arm64"])("%s 部署压缩包包含脚本、程序和校验文件，构建可重复", (architecture) => {
  const script = readFileSync(new URL("../terminal/deploy/install.sh", import.meta.url), "utf8");
  const binary = Buffer.from("fixture ELF\0\xff");
  const output = terminalPackage(binary, script, architecture) as Buffer;
  expect(output.equals(terminalPackage(binary, script, architecture))).toBe(true);
  const tar = gunzipSync(output);
  const entries: Array<{ name: string; mode: number; data: Buffer }> = [];
  for (let offset = 0; tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const field = (start: number, length: number) => header.subarray(start, start + length).toString().replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12), 8);
    const storedSum = parseInt(field(148, 8), 8);
    const calculatedSum = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
    expect(storedSum).toBe(calculatedSum);
    entries.push({ name: field(0, 100), mode: parseInt(field(100, 8), 8), data: tar.subarray(offset + 512, offset + 512 + size) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(entries.map(({ name, mode }) => ({ name, mode }))).toEqual([
    { name: `allocube-deploy-linux-${architecture}/allocube-terminal`, mode: 0o755 },
    { name: `allocube-deploy-linux-${architecture}/install.sh`, mode: 0o755 },
    { name: `allocube-deploy-linux-${architecture}/SHA256SUMS`, mode: 0o644 },
  ]);
  expect(entries[0].data.equals(binary)).toBe(true);
  const installer = entries[1].data.toString();
  expect(installer).toContain(architecture === "amd64" ? "Linux/x86_64" : "Linux/aarch64");
  expect(installer).not.toContain("__MACHINE__");
  expect(installer).not.toContain("\r");
  expect(installer).toContain("unset ALLOCUBE_ENROLL_TOKEN");
  expect(installer).toContain("sudo --preserve-env=ALLOCUBE_PLATFORM,ALLOCUBE_TERMINAL_ID,ALLOCUBE_ENROLL_TOKEN,ALLOCUBE_CA_CERT,ALLOCUBE_CONFIGURE_SSH");
  expect(installer).toContain("flock -n 9");
  expect(entries[2].data.toString()).toBe(entries.slice(0, 2).map(({ name, data }) => `${createHash("sha256").update(data).digest("hex")}  ${name.split("/").at(-1)}\n`).join(""));
});
