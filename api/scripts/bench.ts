/**
 * `make bench`: index build time for a 10 MB+ contract, median query time and heap used.
 */
import { p50 } from "../src/evals/runner.js";
import { createSearchService } from "../src/search/service.js";
import { InMemoryDocumentStore } from "../src/store/memory.js";
import { buildLargeContract, TEN_MB } from "../test/large-contract.js";

const QUERIES = [
  "confidential information",
  "indemnify infringement claim",
  "return of security deposit",
  '"late charge" rent',
  "limitation of liability cap fees",
];

async function main(): Promise<void> {
  const text = buildLargeContract(TEN_MB);
  const store = new InMemoryDocumentStore();
  const search = createSearchService({ store });

  const t0 = performance.now();
  store.create({ id: "large", title: "Large", text });
  const buildMs = performance.now() - t0;

  const queryMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const q = QUERIES[i % QUERIES.length] ?? "";
    const t1 = performance.now();
    await search.search({ q, limit: 10, offset: 0, expand: false });
    queryMs.push(performance.now() - t1);
  }

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  console.log(`document     ${mb(text.length)} MB, ${search.index.N} passages`);
  console.log(`index build  ${buildMs.toFixed(0)} ms`);
  console.log(`query p50    ${p50(queryMs)} ms (20 queries)`);
  console.log(`heap used    ${mb(process.memoryUsage().heapUsed)} MB`);
}

main().catch((err: unknown) => {
  console.error("bench crashed:", err);
  process.exit(1);
});
