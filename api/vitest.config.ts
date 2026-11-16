import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/worktrees/**"],
    // Show console output from passing tests too (the large-file test logs its timings).
    silent: false,
    env: { LLM_MODE: "replay", LOG_FILE: "off", LOG_STDOUT: "off" },
  },
});
