import { readFileSync, readdirSync } from "node:fs";

export function readSourceTree(directory: URL): Map<string, string> {
  const files = new Map<string, string>();
  function visit(base: URL, prefix: string) {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) visit(new URL(`${entry.name}/`, base), `${name}/`);
      else if (/\.(tsx?|css)$/.test(entry.name)) files.set(name, readFileSync(new URL(entry.name, base), "utf8"));
    }
  }
  visit(directory, "");
  return files;
}
