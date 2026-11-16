/**
 * `make spend`: total $ of live LLM calls (data/llm-ledger.jsonl) and the replay count
 * (llm.call lines in data/app.log), against the project budget enforced on the Claude platform.
 */
import fs from "node:fs";
import { PROJECT_BUDGET_USD, dataPath } from "../src/config.js";
import { readLedger, summarizeLedger } from "../src/llm/ledger.js";

function countReplays(file: string): number {
  if (!fs.existsSync(file)) return 0;
  let n = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"llm.call"')) continue;
    try {
      const rec = JSON.parse(line) as { event?: string; replayed?: boolean };
      if (rec.event === "llm.call" && rec.replayed === true) n++;
    } catch {
      // ignore a torn line
    }
  }
  return n;
}

const entries = readLedger();
const s = summarizeLedger(entries);
const replays = countReplays(dataPath("app.log"));
const pct = (s.totalUsd / PROJECT_BUDGET_USD) * 100;
const byOp = new Map<string, { calls: number; usd: number }>();
for (const e of entries) {
  const cur = byOp.get(e.op) ?? { calls: 0, usd: 0 };
  byOp.set(e.op, { calls: cur.calls + 1, usd: cur.usd + e.costUsd });
}

console.log(`LLM spend (ledger: ${dataPath("llm-ledger.jsonl")})`);
console.log(
  `  spent:        $${s.totalUsd.toFixed(4)} of $${PROJECT_BUDGET_USD} (${pct.toFixed(2)}%)`,
);
console.log(`  remaining:    $${(PROJECT_BUDGET_USD - s.totalUsd).toFixed(4)}`);
console.log(`  live calls:   ${s.liveCalls}  (${s.inputTokens} in / ${s.outputTokens} out tokens)`);
console.log(`  replays:      ${replays}  (from data/app.log)`);
for (const [op, v] of byOp) {
  console.log(`    ${op.padEnd(12)} ${String(v.calls).padStart(4)} calls  $${v.usd.toFixed(4)}`);
}
console.log("  The hard cap is enforced on the Claude platform; this ledger is the local record.");
