import { describe, expect, it, vi } from "vitest";
import type { SearchQuery, SearchResponse } from "../domain/types.js";
import { ApiError } from "../errors.js";
import { InMemoryDocumentStore } from "../store/memory.js";
import { SearchIndex } from "./index.js";
import { createSearchService, mergeSpans, type ExpandFn } from "./service.js";

const q = (text: string, extra: Partial<SearchQuery> = {}): SearchQuery => ({
  q: text,
  limit: 10,
  offset: 0,
  expand: true,
  ...extra,
});

function setup(docs: Record<string, string>, expand?: ExpandFn) {
  const store = new InMemoryDocumentStore();
  for (const [id, text] of Object.entries(docs))
    store.create({ id, title: id.toUpperCase(), text });
  return { store, search: createSearchService({ store, expand }) };
}

/** Every highlight must cover text equal (ignoring case) to a term or phrase of the query. */
function expectExactHighlights(res: SearchResponse, needles: string[]) {
  const wanted = needles.map((n) => n.toLowerCase());
  for (const hit of res.results) {
    expect(hit.highlights.length).toBeGreaterThan(0);
    for (const h of hit.highlights) {
      const covered = hit.snippet.slice(h.start, h.end).toLowerCase().replace(/\s+/g, " ");
      expect(wanted).toContain(covered);
    }
  }
}

describe("SearchIndex", () => {
  it("tracks N, avgdl and df across index, reindex and remove", () => {
    const index = new SearchIndex();
    index.indexDoc({ id: "a", title: "A", version: 1, text: "Rent is due. Rent and deposit." });
    index.indexDoc({ id: "b", title: "B", version: 1, text: "Deposit returned." });
    expect(index.N).toBe(3);
    expect(index.docFreq("rent")).toBe(2);
    expect(index.docFreq("deposit")).toBe(2);
    expect(index.avgdl).toBeCloseTo((2 + 2 + 2) / 3);
    index.indexDoc({ id: "a", title: "A", version: 2, text: "Nothing here." });
    expect(index.N).toBe(2);
    expect(index.docFreq("rent")).toBe(0);
    expect(index.removeDoc("b")).toBe(true);
    expect(index.N).toBe(1);
    expect(index.docFreq("deposit")).toBe(0);
    expect(index.removeDoc("b")).toBe(false);
  });

  it("BM25: more matches of a rare term rank higher; idf favours rare terms", () => {
    const index = new SearchIndex();
    index.indexDoc({
      id: "d",
      title: "D",
      version: 1,
      text: [
        "Escrow escrow escrow agent fee.",
        "Escrow agent fee due.",
        "Agent fee due monthly.",
        "Agent fee waived.",
      ].join(" "),
    });
    const scored = index.score([{ term: "escrow", weight: 1 }]);
    expect(scored).toHaveLength(2);
    const [three, one] = [...scored].sort((a, b) => b.score - a.score);
    expect(three?.passageId).toBe(0);
    expect(three?.score).toBeGreaterThan(one?.score ?? Infinity);
    expect(index.idf("escrow")).toBeGreaterThan(index.idf("agent"));
  });
});

describe("createSearchService", () => {
  const docs = {
    lease: "Tenant shall pay rent monthly. A Late Charge applies to late rent; Rent is due.",
    nda: "Confidential information stays confidential. Late notice is fine.",
  };

  it("returns ranked passages with offsets, terms, highlights and matchedTerms", async () => {
    const { store, search } = setup(docs);
    const res = await search.search(q("the rent"));
    expect(res).toMatchObject({ query: "the rent", terms: ["rent"], phrases: [], total: 3 });
    expect(res.expansion).toEqual({ status: "off", added: [] });
    const text = store.get("lease")?.text ?? "";
    for (const hit of res.results) {
      expect(hit.docId).toBe("lease");
      expect(hit.title).toBe("LEASE");
      expect(hit.docVersion).toBe(1);
      expect(text.slice(hit.start, hit.end)).toBe(hit.snippet);
      expect(hit.matchedTerms).toEqual(["rent"]);
    }
    expectExactHighlights(res, ["rent"]);
    const scores = res.results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("a phrase matches exactly and case-insensitively, and filters candidates", async () => {
    const { search } = setup(docs);
    const res = await search.search(q('"late charge" rent'));
    expect(res.phrases).toEqual(["late charge"]);
    expect(res.terms).toEqual(["rent"]);
    expect(res.total).toBe(1);
    expect(res.results[0]?.snippet).toBe("A Late Charge applies to late rent;");
    expect(res.results[0]?.highlights).toEqual([
      { start: 2, end: 13 },
      { start: 30, end: 34 },
    ]);
    expectExactHighlights(res, ["late charge", "rent"]);

    const only = await search.search(q('"LATE CHARGE"'));
    expect(only.total).toBe(1);
    expect(only.terms).toEqual([]);
    expect(only.results[0]?.score).toBeGreaterThan(0);
  });

  it("a phrase with no exact match returns 0 results even when its words occur", async () => {
    const { search } = setup(docs);
    const res = await search.search(q('"charge late"'));
    expect(res).toMatchObject({ total: 0, results: [] });
  });

  it("filters by docId and 404s an unknown docId", async () => {
    const { search } = setup(docs);
    const res = await search.search(q("late", { docIds: ["nda"] }));
    expect(res.total).toBe(1);
    expect(res.results.every((r) => r.docId === "nda")).toBe(true);
    const all = await search.search(q("late", { docIds: ["nda", "lease"] }));
    expect(all.total).toBe(2);
    await expect(search.search(q("late", { docIds: ["nope"] }))).rejects.toMatchObject({
      status: 404,
      reason: "DOCUMENT_NOT_FOUND",
    });
    await expect(search.search(q("late", { docIds: ["nope"] }))).rejects.toBeInstanceOf(ApiError);
  });

  it("pages after ranking; ties break by docId then start", async () => {
    const same = "Clause about widgets.";
    const { search } = setup({ b: `${same} ${same}`, a: `${same} ${same}` });
    const full = await search.search(q("widgets"));
    expect(full.total).toBe(4);
    expect(full.results.map((r) => [r.docId, r.start])).toEqual([
      ["a", 0],
      ["a", 22],
      ["b", 0],
      ["b", 22],
    ]);
    const page = await search.search(q("widgets", { limit: 2, offset: 1 }));
    expect(page.total).toBe(4);
    expect(page.results).toEqual(full.results.slice(1, 3));
    const past = await search.search(q("widgets", { offset: 10 }));
    expect(past).toMatchObject({ total: 4, results: [] });
  });

  it("reindexes on commit: new words are found, removed words are gone", async () => {
    const { store, search } = setup(docs);
    expect((await search.search(q("monthly"))).total).toBe(1);
    store.commit("lease", "Tenant shall pay rent quarterly.", []);
    expect((await search.search(q("monthly"))).total).toBe(0);
    const res = await search.search(q("quarterly"));
    expect(res.total).toBe(1);
    expect(res.results[0]?.docVersion).toBe(2);
  });

  it("indexes documents created after startup, and stops after close", async () => {
    const { store, search } = setup(docs);
    store.create({ id: "late", title: "Late", text: "Zebra crossing clause." });
    expect((await search.search(q("zebra"))).results[0]?.docId).toBe("late");
    search.close();
    store.create({ id: "later", title: "Later", text: "Giraffe clause." });
    expect((await search.search(q("giraffe"))).total).toBe(0);
  });

  it("logs counts but never the query text", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prev = process.env.LOG_STDOUT;
    process.env.LOG_STDOUT = "on";
    try {
      const { search } = setup(docs);
      await search.search(q("secretword rent"));
      const lines = write.mock.calls.map((c) => String(c[0]));
      const event = lines.map((l) => JSON.parse(l)).find((e) => e.event === "search");
      expect(event).toMatchObject({ qLen: 15, terms: 2, results: 3, expansion: "off" });
      expect(typeof event.ms).toBe("number");
      expect(lines.join("")).not.toContain("secretword");
    } finally {
      process.env.LOG_STDOUT = prev;
      write.mockRestore();
    }
  });
});

describe("expansion hook", () => {
  const docs = { msa: "Customer may cancel this Agreement. Customer may terminate for breach." };

  it("applied: added terms join at half weight and surface in matchedTerms", async () => {
    const expand = vi.fn<ExpandFn>(async () => ({ added: ["Cancel", "terminate"] }));
    const { search } = setup(docs, expand);
    const res = await search.search(q('terminate "for breach"'));
    expect(expand).toHaveBeenCalledWith(["terminate"]);
    expect(res.expansion).toEqual({ status: "applied", added: ["cancel"] });
    expect(res.total).toBe(1); // the phrase still filters: never expanded

    const loose = await search.search(q("terminate"));
    expect(loose.total).toBe(2);
    const [first, second] = loose.results;
    expect(first?.matchedTerms).toEqual(["terminate"]);
    expect(second?.matchedTerms).toEqual(["cancel"]);
    expect(second?.snippet).toBe("Customer may cancel this Agreement.");
    expectExactHighlights(loose, ["terminate", "cancel"]);
    expect(first?.score).toBeGreaterThan(second?.score ?? Infinity);
  });

  it("skipped: runs unexpanded with the reason", async () => {
    const { search } = setup(docs, async () => ({ skipped: "timeout" }));
    const res = await search.search(q("terminate"));
    expect(res.expansion).toEqual({ status: "skipped", added: [], reason: "timeout" });
    expect(res.total).toBe(1);
  });

  it("throws: runs unexpanded, status skipped", async () => {
    const { search } = setup(docs, async () => {
      throw new Error("boom");
    });
    const res = await search.search(q("terminate"));
    expect(res.expansion).toEqual({ status: "skipped", added: [], reason: "expand_failed" });
    expect(res.total).toBe(1);
  });

  it("off when the query says expand=false or there are only phrases", async () => {
    const expand = vi.fn<ExpandFn>(async () => ({ added: ["cancel"] }));
    const { search } = setup(docs, expand);
    const off = await search.search(q("terminate", { expand: false }));
    expect(off.expansion).toEqual({ status: "off", added: [] });
    const phraseOnly = await search.search(q('"may terminate"'));
    expect(phraseOnly.expansion).toMatchObject({ status: "skipped", reason: "no_terms" });
    expect(expand).not.toHaveBeenCalled();
  });
});

describe("mergeSpans", () => {
  it("sorts and merges overlapping and touching spans", () => {
    expect(
      mergeSpans([
        { start: 10, end: 12 },
        { start: 0, end: 4 },
        { start: 2, end: 6 },
        { start: 6, end: 8 },
      ]),
    ).toEqual([
      { start: 0, end: 8 },
      { start: 10, end: 12 },
    ]);
  });
});
