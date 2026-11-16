import { describe, expect, it } from "vitest";
import { createSearchService } from "../src/search/service.js";
import { InMemoryDocumentStore } from "../src/store/memory.js";
import { captureLogs } from "./capture-logs.js";
import { buildLargeContract, TEN_MB } from "./large-contract.js";

describe("search over a 10 MB+ contract", () => {
  const text = buildLargeContract(TEN_MB);

  it("indexes and queries within generous ceilings", async () => {
    const store = new InMemoryDocumentStore();
    const search = createSearchService({ store });

    const t0 = performance.now();
    store.create({ id: "large", title: "Large", text });
    const buildMs = performance.now() - t0;
    const entry = search.index.get("large");
    expect(entry?.passages.length).toBeGreaterThan(10_000);

    const queries = ["confidential information", '"late charge" rent', "indemnify infringement"];
    const queryMs: number[] = [];
    for (const q of queries) {
      const t1 = performance.now();
      const res = await search.search({ q, limit: 10, offset: 0, expand: false });
      queryMs.push(performance.now() - t1);
      expect(res.total).toBeGreaterThan(0);
      for (const hit of res.results) expect(text.slice(hit.start, hit.end)).toBe(hit.snippet);
    }

    console.log(
      `search large: ${(text.length / 1024 / 1024).toFixed(1)} MB, ` +
        `${entry?.passages.length} passages, build ${buildMs.toFixed(0)} ms, ` +
        `queries ${queryMs.map((ms) => ms.toFixed(1)).join("/")} ms`,
    );
    // Tripwires for accidental quadratic work, not benchmarks (see `make bench`).
    expect(buildMs).toBeLessThan(4000);
    for (const ms of queryMs) expect(ms).toBeLessThan(200);
  });

  it.each(["worker", "sync"] as const)(
    "%s: search answers at once during the large reindex, then finds the edit",
    async (mode) => {
      const store = new InMemoryDocumentStore();
      const search = createSearchService({ store, mode });
      try {
        store.create({ id: "large", title: "Large", text });
        const query = { q: "confidential information", limit: 10, offset: 0, expand: false };
        let duringMs = 0;
        const { events } = await captureLogs(async () => {
          store.commit("large", `${text}\n999999. Quokka clause.`, []);
          // Let the queued job start: in worker mode the build is now running off-thread.
          await new Promise((r) => setImmediate(r));
          const t0 = performance.now();
          const during = await search.search(query);
          duringMs = performance.now() - t0;
          if (mode === "worker") {
            expect(during.indexing).toEqual([
              { docId: "large", title: "Large", indexedVersion: 1, currentVersion: 2 },
            ]);
            expect(during.results.every((h) => h.stale && h.docVersion === 1)).toBe(true);
          }
          await search.idle();
        });
        const swap = events.find((e) => e.event === "search.index_swap");
        const index = events.find((e) => e.event === "search.index" && e.reason === "commit");
        console.log(
          `search large (${mode}): search during reindex ${duringMs.toFixed(1)} ms, ` +
            `build ${index?.ms} ms, queue ${index?.queueMs} ms, swap ${swap?.ms} ms`,
        );
        expect(index).toMatchObject({ mode, version: 2 });
        expect(swap).toMatchObject({ docId: "large", version: 2 });
        // Generous tripwires, not benchmarks.
        if (mode === "worker") expect(duringMs).toBeLessThan(200);
        expect(swap.ms).toBeLessThan(100);

        const res = await search.search({ q: "quokka", limit: 10, offset: 0, expand: false });
        expect(res).toMatchObject({ total: 1, indexing: [] });
        expect(res.results[0]).toMatchObject({ docVersion: 2, stale: false });
      } finally {
        search.close();
      }
    },
  );
});
