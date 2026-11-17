import { afterAll, describe, expect, it } from "vitest";
import { SearchIndex, type IndexedDoc } from "./index.js";
import { createSyncIndexer, createWorkerIndexer, workerEntry } from "./indexer.js";
import { splitPassages } from "./passages.js";
import { buildSegment } from "./segment.js";
import { tokenize } from "./tokenize.js";

/** Deterministic PRNG (mulberry32), so a failing case can be reproduced from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "the",
  "Tenant",
  "shall",
  "pay",
  "rent",
  "of",
  "Landlord",
  "indemnify",
  "Ünïcödé",
  "naïve",
  "30",
  "días",
  "a",
  "and",
  "§",
  "—",
  ".",
  ";",
  ":",
  "\n\n",
  " ",
  "  ",
  "\t",
  "\n",
  ",",
  "(",
  ")",
  "x".repeat(450),
  "word ".repeat(120),
  "ﬁle",
  "😀",
  "İstanbul",
];

function randomText(seed: number): string {
  const r = rng(seed);
  const n = Math.floor(r() * 400);
  let s = "";
  for (let i = 0; i < n; i++) {
    s += PIECES[Math.floor(r() * PIECES.length)] ?? "";
    if (r() < 0.6) s += " ";
  }
  return s;
}

/** Independent reference: split, tokenize, count, straight from the spec. */
function reference(text: string) {
  const passages: { start: number; end: number; length: number }[] = [];
  const postings: Record<string, [number, number][]> = {};
  for (const span of splitPassages(text)) {
    const toks = tokenize(text, { from: span.start, to: span.end });
    if (toks.length === 0) continue;
    const id = passages.length;
    passages.push({ ...span, length: toks.length });
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t.term, (tf.get(t.term) ?? 0) + 1);
    for (const [term, n] of tf) (postings[term] ??= []).push([id, n]);
  }
  return { passages, postings };
}

/** A comparable view of an indexed document: passages and every posting as plain arrays. */
function view(doc: IndexedDoc | undefined) {
  if (!doc) return undefined;
  const postings: Record<string, [number, number][]> = {};
  for (const [term, list] of doc.postings) {
    postings[term] = [...list.passageIds].map((id, i) => [id, list.tfs[i] ?? 0]);
  }
  return { passages: doc.passages, postings };
}

describe("buildSegment", () => {
  it("drops stopword-only passages and records tf per passage", () => {
    const s = buildSegment("Rent is due. The of. Rent and rent deposit.");
    expect([...s.starts]).toEqual([0, 21]);
    expect([...s.lengths]).toEqual([2, 3]);
    const at = (term: string) => {
      const t = s.terms.indexOf(term);
      const from = s.offsets[t] ?? 0;
      const to = s.offsets[t + 1] ?? 0;
      return [...s.passageIds.subarray(from, to)].map((id, i) => [id, s.tfs[from + i]]);
    };
    expect(at("rent")).toEqual([
      [0, 1],
      [1, 2],
    ]);
    expect(at("deposit")).toEqual([[1, 1]]);
    expect(s.terms).not.toContain("the");
  });

  it("handles empty text", () => {
    const s = buildSegment("");
    expect(s.starts.length).toBe(0);
    expect(s.terms).toEqual([]);
    expect([...s.offsets]).toEqual([0]);
  });
});

describe("worker indexer", () => {
  const worker = createWorkerIndexer();
  afterAll(() => worker.close());

  it("resolves the worker script beside the module, by extension", () => {
    expect(workerEntry("file:///a/search/indexer.ts")).toEqual({
      url: new URL("file:///a/search/index-worker.ts"),
      execArgv: ["--import", "tsx"],
    });
    expect(workerEntry("file:///a/dist/search/indexer.js").url.href).toBe(
      "file:///a/dist/search/index-worker.js",
    );
    // The Vercel bundle: everything is in index.mjs, the worker is index-worker.mjs beside it.
    expect(workerEntry("file:///var/task/index.mjs")).toEqual({
      url: new URL("file:///var/task/index-worker.mjs"),
      execArgv: [],
    });
  });

  it("property: worker output equals synchronous indexDoc for random texts", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const text = randomText(seed);
      const doc = { id: "d", title: "D", version: seed, text };
      const built = await worker.build(doc);
      expect(built.mode, `seed ${seed}`).toBe("worker");

      const viaWorker = new SearchIndex();
      viaWorker.swap(doc, built.segment);
      const viaSync = new SearchIndex();
      viaSync.indexDoc(doc);
      expect(view(viaWorker.get("d")), `seed ${seed}`).toEqual(view(viaSync.get("d")));
      expect(view(viaWorker.get("d")), `seed ${seed}`).toEqual(reference(text));
      expect(viaWorker.N).toBe(viaSync.N);
      expect(viaWorker.avgdl).toBe(viaSync.avgdl);
      for (const p of viaWorker.get("d")?.passages ?? []) {
        expect(text.slice(p.start, p.end).trim()).toBe(text.slice(p.start, p.end));
      }
    }
  });

  it("answers concurrent builds by request, not by arrival order", async () => {
    const texts = ["Alpha clause.", "Beta clause. Gamma clause.", "Delta."];
    const built = await Promise.all(
      texts.map((text, i) => worker.build({ id: `d${i}`, version: 1, text })),
    );
    expect(built.map((b) => b.segment.starts.length)).toEqual([1, 2, 1]);
  });

  it("falls back to a synchronous build when the worker cannot start", async () => {
    const broken = createWorkerIndexer({
      url: new URL("./no-such-worker.js", import.meta.url),
      execArgv: [],
    });
    try {
      const built = await broken.build({ id: "d", version: 1, text: "Rent is due." });
      expect(built.mode).toBe("sync");
      expect([...built.segment.lengths]).toEqual([2]);
    } finally {
      broken.close();
    }
  });

  it("builds started in the same tick share one worker, so a crash settles every build", async () => {
    // Exits on the document "boom"; answers every other build with an error.
    const source = `import { parentPort } from "node:worker_threads";
parentPort.on("message", (req) => {
  if (req.id === "boom") process.exit(1);
  parentPort.postMessage({ reqId: req.reqId, error: "not_built" });
});`;
    const crashing = createWorkerIndexer({
      url: new URL(`data:text/javascript,${encodeURIComponent(source)}`),
      execArgv: [],
    });
    try {
      const timeout = new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 3000));
      const settle = (id: string) =>
        Promise.race([
          crashing.build({ id, version: 1, text: "Rent is due." }).then((b) => b.mode),
          timeout,
        ]);
      // Both start before the worker module has loaded: the first build must not be stranded
      // on a second, orphaned worker.
      expect(await Promise.all([settle("boom"), settle("other")])).toEqual(["sync", "sync"]);
    } finally {
      crashing.close();
    }
  });

  it("the sync indexer builds the same segment", async () => {
    const text = randomText(7);
    const built = await createSyncIndexer().build({ id: "d", version: 1, text });
    expect(built.mode).toBe("sync");
    expect(built.segment).toEqual(buildSegment(text));
  });
});
