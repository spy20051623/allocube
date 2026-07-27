import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false
      },
      "/health": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false
      }
    }
  },
  build: {
    outDir: "dist",
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("react") || id.includes("scheduler")) return "react";
          if (id.includes("@tanstack")) return "router";
          if (id.includes("lucide-react")) return "icons";
          return "vendor";
        }
      }
    }
  }
});
