import { describe, expect, it } from "vitest";
import type { LlmService, SearchService } from "../domain/types.js";
import { createSearchService } from "../search/service.js";
import { InMemoryDocumentStore } from "../store/memory.js";
import { readSeedFiles, seedStore } from "../store/seed.js";
import { loadScenarios, p50, probeWord, runEvals } from "./runner.js";

const scenarios = loadScenarios();
const noLlm = () => ({ liveCalls: 0, replayedCalls: 0, failedCalls: 0, costUsd: 0 });

function seeded() {
  const store = new InMemoryDocumentStore();
  seedStore(store);
  return store;
}

describe("scenarios", () => {
  it("has ~10 search cases (4 synonym-only, 2 quoted) and 3 flows", () => {
    expect(scenarios.search).toHaveLength(10);
    expect(scenarios.search.filter((s) => s.needsExpansion)).toHaveLength(4);
    expect(scenarios.search.filter((s) => s.query.includes('"'))).toHaveLength(2);
    expect(scenarios.flow).toHaveLength(3);
  });

  it("every expected substring exists verbatim in exactly one seed contract", () => {
    const texts = readSeedFiles().map((f) => f.text);
    for (const s of scenarios.search) {
      const where = texts.filter((t) => t.includes(s.mustFindInTop3));
      expect(where, s.id).toHaveLength(1);
    }
  });

  it("synonym-only cases do not contain their query words in the target clause", () => {
    // e.g. "terminate for convenience" must not lexically match the "cancel" clause.
    for (const s of scenarios.search.filter((x) => x.needsExpansion)) {
      const target = s.mustFindInTop3.toLowerCase();
      const content = s.query
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length > 4);
      const shared = content.filter((w) => target.includes(w));
      expect(shared, s.id).toEqual([]);
    }
  });
});

describe("runEvals", () => {
  it("baseline: every step that hits a stub fails as not_implemented", async () => {
    const summary = await runEvals({
      makeDeps: () => ({ store: seeded() }),
      llmStats: noLlm,
      llmMode: "replay",
      scenarios,
    });
    expect(summary.search.hitAt3).toBe(0);
    expect(summary.search.cases.every((c) => c.reason === "not_implemented")).toBe(true);
    expect(summary.flow.passRate).toBe(0);
    expect(summary.flow.failedAt).toEqual({ search: 3 });
    expect(summary.latencyP50Ms.search).toBeGreaterThanOrEqual(0);
  });

  it("scores hit@3 and walks the flow until the first unimplemented step", async () => {
    // Oracle search: returns the clause containing the expected text, by scenario.
    const store = seeded();
    const search: SearchService = {
      async search({ q }) {
        const sc = [...scenarios.search, ...scenarios.flow].find((s) => s.query === q);
        const needle = sc && "mustFindInTop3" in sc ? sc.mustFindInTop3 : "LIABILITY ARISING";
        const doc = store.list().find((d) => store.get(d.id)?.text.includes(needle));
        const text = doc ? (store.get(doc.id)?.text ?? "") : "";
        const start = text.indexOf(needle);
        const results =
          doc && start >= 0
            ? [
                {
                  docId: doc.id,
                  title: doc.title,
                  docVersion: doc.version,
                  start,
                  end: start + needle.length,
                  snippet: needle,
                  highlights: [],
                  matchedTerms: [],
                  score: 1,
                },
              ]
            : [];
        return {
          query: q,
          terms: [],
          phrases: [],
          expansion: { status: "off", added: [] },
          total: results.length,
          results,
          documents: results.map((r) => ({ docId: r.docId, title: r.title, passages: 1 })),
        };
      },
    };
    const llm: LlmService = {
      expand: async () => ({ added: [] }),
      suggest: async ({ text }) => ({
        replacement: `${text} within twelve six fifteen days`,
        rationale: "test",
        model: "fake",
      }),
    };
    const summary = await runEvals({
      makeDeps: () => ({ store, search, llm }),
      llmStats: noLlm,
      llmMode: "replay",
      scenarios,
    });
    expect(summary.search.hitAt3).toBe(1);
    expect(summary.search.hitAt3Expansion).toBe(1);
    // dry_run, redline, apply and verify_text pass; the oracle only knows scenario queries, so
    // the re-search for the new wording is the first step that fails.
    expect(summary.flow.failedAt).toEqual({ search_again: 3 });
    for (const c of summary.flow.cases) expect(c.reason).toMatch(/^not_found:/);
    expect(Object.keys(summary.latencyP50Ms)).toEqual(
      expect.arrayContaining([
        "search",
        "pick",
        "suggest",
        "expectations",
        "dry_run",
        "redline",
        "apply",
        "verify_text",
        "search_again",
      ]),
    );
  });
});

describe("runEvals with the BM25 search service (no expansion)", () => {
  it("scores the search scenarios and reaches the suggest step", async () => {
    const summary = await runEvals({
      makeDeps: () => {
        const store = seeded();
        return { store, search: createSearchService({ store }) };
      },
      llmStats: noLlm,
      llmMode: "replay",
      scenarios,
    });
    const lexical = summary.search.cases.filter((c) => !c.needsExpansion);
    const hits = summary.search.cases.filter((c) => c.pass);
    console.log(
      `search hit@3 without expansion: ${hits.length}/${summary.search.total} ` +
        `(lexical ${lexical.filter((c) => c.pass).length}/${lexical.length}); ` +
        summary.search.cases.map((c) => `${c.id}=${c.rank ?? c.reason}`).join(" "),
    );
    // A floor, not a target: synonym-only cases need expansion, and s03 currently ranks 4th
    // behind its own "Security Deposit." heading and two sibling clauses.
    expect(hits.length).toBeGreaterThanOrEqual(5);
    const quoted = summary.search.cases.filter((c) => c.id.includes("quoted"));
    expect(quoted.map((c) => c.rank)).toEqual([1, 1]);
    expect(summary.flow.failedAt).toEqual({ suggest: 3 });
  });
});

describe("helpers", () => {
  it("p50", () => {
    expect(p50([])).toBe(0);
    expect(p50([3, 1, 2])).toBe(2);
    expect(p50([1, 2, 3, 4])).toBe(2.5);
  });

  it("probeWord picks the longest word the replacement added", () => {
    expect(
      probeWord("Customer may terminate this Agreement", "Customer may cancel this Agreement"),
    ).toBe("terminate");
  });
});
