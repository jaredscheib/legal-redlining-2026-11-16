/**
 * `make evals`: runs scenarios/*.json against the in-process app, prints a table and writes
 * data/evals/<timestamp>.json. Exits 0 even when scenarios fail; non-zero only on a crash.
 */
import fs from "node:fs";
import { dataPath, llmMode } from "../src/config.js";
import { formatReport, loadScenarios, runEvals } from "../src/evals/runner.js";
import { createLlmClient } from "../src/llm/client.js";
import { createRuntime } from "../src/runtime.js";

async function main(): Promise<void> {
  const mode = llmMode();
  const llmClient = createLlmClient({ mode });
  const summary = await runEvals({
    makeDeps: () => createRuntime({ llmClient }).deps,
    llmStats: () => llmClient.stats(),
    llmMode: mode,
    scenarios: loadScenarios(),
  });

  const dir = dataPath("evals");
  fs.mkdirSync(dir, { recursive: true });
  const file = `${dir}/${summary.startedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");

  console.log(formatReport(summary));
  console.log(`\nsummary: ${file}`);
}

main().catch((err: unknown) => {
  console.error("evals runner crashed:", err);
  process.exit(1);
});
