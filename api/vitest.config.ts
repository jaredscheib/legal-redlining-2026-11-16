import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    env: { LLM_MODE: "replay" },
    passWithNoTests: true,
  },
});
