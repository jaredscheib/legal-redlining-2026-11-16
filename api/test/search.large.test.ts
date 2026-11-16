import { describe, expect, it } from "vitest";
import { createSearchService } from "../src/search/service.js";
import { InMemoryDocumentStore } from "../src/store/memory.js";
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

  it("reindexes the large document on commit", async () => {
    const store = new InMemoryDocumentStore();
    const search = createSearchService({ store });
    store.create({ id: "large", title: "Large", text });
    store.commit("large", `${text}\n999999. Quokka clause.`, []);
    const res = await search.search({ q: "quokka", limit: 10, offset: 0, expand: false });
    expect(res.total).toBe(1);
    expect(res.results[0]?.docVersion).toBe(2);
  });
});
