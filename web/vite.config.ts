import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const apiTarget = `http://127.0.0.1:${process.env.API_PORT ?? "8787"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/documents": apiTarget,
      "/search": apiTarget,
      "/healthz": apiTarget,
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
