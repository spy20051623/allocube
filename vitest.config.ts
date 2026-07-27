import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: ["node_modules/**", "dist/**", "dist-server/**"],
    fileParallelism: false,
    sequence: { concurrent: false },
    hookTimeout: 30_000
  }
});
