import { describe, expect, it } from "vitest";
import type { ChangeOp } from "../domain/types.js";
import { ApiError } from "../errors.js";
import { applyOps } from "./apply.js";

function op(text: string, start: number, end: number, newText: string): ChangeOp {
  return { start, end, oldText: text.slice(start, end), newText };
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err.reason;
    throw err;
  }
  return "no error";
}

const TEXT = "The term is thirty (30) days.";

describe("applyOps", () => {
  it("replaces a span", () => {
    expect(applyOps(TEXT, [op(TEXT, 12, 23, "fifteen (15)")])).toBe(
      "The term is fifteen (15) days.",
    );
  });

  it("deletes with an empty replacement", () => {
    expect(applyOps(TEXT, [op(TEXT, 11, 23, "")])).toBe("The term is days.");
  });

  it("inserts by replacing a word with a longer phrase that keeps it", () => {
    const start = TEXT.indexOf("days");
    expect(applyOps(TEXT, [op(TEXT, start, start + 4, "business days")])).toBe(
      "The term is thirty (30) business days.",
    );
  });

  it("applies several non-overlapping ops given in any order", () => {
    const ops = [op(TEXT, 24, 28, "weeks"), op(TEXT, 0, 3, "A")];
    expect(applyOps(TEXT, ops)).toBe("A term is thirty (30) weeks.");
  });

  it("handles unicode text", () => {
    const text = "Café 🚀 — “Party A”.";
    const start = text.indexOf("A”");
    expect(applyOps(text, [op(text, start, start + 1, "Β")])).toBe("Café 🚀 — “Party Β”.");
  });

  it("rejects overlapping ops", () => {
    expect(reasonOf(() => applyOps(TEXT, [op(TEXT, 0, 8, "x"), op(TEXT, 4, 12, "y")]))).toBe(
      "OVERLAPPING_CHANGES",
    );
    expect(reasonOf(() => applyOps(TEXT, [op(TEXT, 4, 4, "x"), op(TEXT, 4, 4, "y")]))).toBe(
      "OVERLAPPING_CHANGES",
    );
  });

  it("names both colliding changes' indexes and ranges when ops carry a changeIndex", () => {
    const tagged = (changeIndex: number, start: number, end: number) => ({
      ...op(TEXT, start, end, "x"),
      changeIndex,
    });
    let details: unknown;
    try {
      applyOps(TEXT, [tagged(0, 20, 22), tagged(1, 4, 12), tagged(2, 0, 8)]);
    } catch (err) {
      details = (err as ApiError).details;
    }
    expect(details).toEqual({
      changeIndexes: [2, 1],
      ranges: [
        { start: 0, end: 8 },
        { start: 4, end: 12 },
      ],
    });
  });

  it("allows adjacent ops", () => {
    expect(applyOps("abcd", [op("abcd", 0, 2, "X"), op("abcd", 2, 4, "Y")])).toBe("XY");
  });

  it("rejects ops out of bounds or not matching the text", () => {
    expect(
      reasonOf(() => applyOps(TEXT, [{ start: 0, end: 999, oldText: "x", newText: "" }])),
    ).toBe("INVALID_RANGE");
    expect(
      reasonOf(() => applyOps(TEXT, [{ start: 0, end: 3, oldText: "Thx", newText: "" }])),
    ).toBe("INVALID_RANGE");
  });
});

/** Small deterministic PRNG (mulberry32), so failures reproduce. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: all at once equals one at a time, descending by start", () => {
  const alphabet = "ab cd\n—é🚀";
  it("holds for 500 random non-overlapping change sets", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rand = rng(seed);
      const int = (n: number) => Math.floor(rand() * n);
      const word = (n: number) => Array.from({ length: n }, () => alphabet[int(10)]).join("");
      const text = word(int(60));

      // Random sorted cut points, paired into disjoint (possibly empty/adjacent) ranges.
      const cuts = Array.from({ length: int(10) * 2 }, () => int(text.length + 1)).sort(
        (a, b) => a - b,
      );
      const ops: ChangeOp[] = [];
      for (let i = 0; i + 1 < cuts.length; i += 2) {
        const start = cuts[i] as number;
        const end = cuts[i + 1] as number;
        const prev = ops[ops.length - 1];
        if (prev && prev.start === start) continue; // two ops at one point have no defined order
        ops.push(op(text, start, end, word(int(6))));
      }
      const shuffled = [...ops].sort(() => rand() - 0.5);

      const atOnce = applyOps(text, shuffled);
      let sequential = text;
      for (const o of [...ops].sort((a, b) => b.start - a.start)) {
        sequential = applyOps(sequential, [o]);
      }
      expect(atOnce, `seed ${seed}`).toBe(sequential);
    }
  });
});
