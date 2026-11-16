/**
 * `make compare-expansion`: runs five queries through query expansion on each candidate
 * setting, live (LLM_MODE=live bypasses recordings, so timings are real), and prints latency,
 * the alternatives returned and the cost. Each run is 5 billed calls per setting.
 */
import { EXPANSION_MODEL, SUGGESTION_MODEL } from "../src/config.js";
import { createLlmClient } from "../src/llm/client.js";
import { createExpander } from "../src/llm/expand.js";
import type { Thinking } from "../src/llm/types.js";
import { p50 } from "../src/evals/runner.js";

const QUERIES: string[][] = [
  ["terminate", "convenience"],
  ["indemnify"],
  ["confidential", "information"],
  ["late", "payment", "interest"],
  ["assignment", "consent"],
];

interface Setting {
  label: string;
  model: string;
  thinking?: Thinking;
}

const SETTINGS: Setting[] = [
  { label: "haiku, thinking off", model: EXPANSION_MODEL, thinking: "disabled" },
  { label: "haiku, adaptive", model: EXPANSION_MODEL },
  // Sonnet 5.5 rejects thinking: disabled, so it runs with its default.
  { label: "sonnet, adaptive", model: SUGGESTION_MODEL },
];

/** Generous, so a slow model shows its real latency instead of the 2.5 s production cutoff. */
const TIMEOUT_MS = 15000;

async function main(): Promise<void> {
  const only = process.argv[2];
  const settings = only ? SETTINGS.filter((s) => s.label.startsWith(only)) : SETTINGS;
  const rows: string[] = [];
  let total = 0;
  for (const s of settings) {
    const client = createLlmClient({ mode: "live" });
    const expand = createExpander(client, {
      model: s.model,
      thinking: s.thinking,
      timeoutMs: TIMEOUT_MS,
    });
    const ms: number[] = [];
    for (const terms of QUERIES) {
      const t0 = performance.now();
      const res = await expand(terms);
      ms.push(performance.now() - t0);
      const out = "added" in res ? res.added.join(", ") || "(none)" : `skipped: ${res.skipped}`;
      rows.push(`  ${s.label.padEnd(20)} ${terms.join(" ").padEnd(24)} ${out}`);
    }
    const cost = client.stats().costUsd;
    total += cost;
    console.log(
      `${s.label.padEnd(20)} model=${s.model}  p50=${Math.round(p50(ms))}ms  max=${Math.round(Math.max(...ms))}ms  cost=$${cost.toFixed(5)}  failed=${client.stats().failedCalls}`,
    );
  }
  console.log("\nALTERNATIVES");
  for (const r of rows) console.log(r);
  console.log(`\ntotal live cost: $${total.toFixed(5)}`);
}

main().catch((err: unknown) => {
  console.error("compare-expansion crashed:", err instanceof Error ? err.name : "error");
  process.exit(1);
});
