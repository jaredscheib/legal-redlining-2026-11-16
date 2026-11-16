import { describe, expect, it } from "vitest";
import { splitPassages } from "./passages.js";
import { parseQuery, phraseRegExp } from "./query.js";
import { tokenize } from "./tokenize.js";

describe("tokenize", () => {
  it("lowercases letter/digit runs, keeps exact offsets and drops stopwords", () => {
    const text = "The Tenant shall pay 5% of Rent, ÉTÉ-clause.";
    const tokens = tokenize(text);
    expect(tokens.map((t) => t.term)).toEqual([
      "tenant",
      "shall",
      "pay",
      "5",
      "rent",
      "été",
      "clause",
    ]);
    for (const t of tokens) expect(text.slice(t.start, t.end).toLowerCase()).toBe(t.term);
  });

  it("keeps stopwords on request and honours a range", () => {
    const text = "of the deposit and rent";
    expect(tokenize(text, { keepStopwords: true }).map((t) => t.term)).toEqual([
      "of",
      "the",
      "deposit",
      "and",
      "rent",
    ]);
    expect(tokenize(text, { from: 7, to: 15 }).map((t) => [t.term, t.start, t.end])).toEqual([
      ["deposit", 7, 14],
    ]);
  });
});

describe("splitPassages", () => {
  const texts = (text: string) => splitPassages(text).map((p) => text.slice(p.start, p.end));

  it("splits at . ; : before whitespace and at blank lines, trimming offsets", () => {
    const text = "  First one. Second; third: fourth\nline\n\n  Heading\n \nlast v1.2 ok.  ";
    expect(texts(text)).toEqual([
      "First one.",
      "Second;",
      "third:",
      "fourth\nline",
      "Heading",
      "last v1.2 ok.",
    ]);
  });

  it("drops empty passages", () => {
    expect(splitPassages("\n\n \n\n  . ;\n\n")).toEqual([
      { start: 7, end: 8 },
      { start: 9, end: 10 },
    ]);
    expect(splitPassages("   ")).toEqual([]);
  });

  it("cuts a passage over the limit at a word boundary", () => {
    const word = "abcdefghi "; // 10 chars
    const text = word.repeat(100).trim(); // 999 chars, no sentence end
    const parts = splitPassages(text, 400);
    expect(parts.length).toBe(3);
    for (const p of parts) {
      expect(p.end - p.start).toBeLessThanOrEqual(400);
      const s = text.slice(p.start, p.end);
      expect(s).toBe(s.trim());
      expect(s.startsWith("abcdefghi")).toBe(true);
      expect(s.endsWith("abcdefghi")).toBe(true);
    }
    expect(parts.map((p) => text.slice(p.start, p.end)).join(" ")).toBe(text);
  });

  it("hard-cuts a run with no whitespace", () => {
    const parts = splitPassages("x".repeat(900), 400);
    expect(parts).toEqual([
      { start: 0, end: 400 },
      { start: 400, end: 800 },
      { start: 800, end: 900 },
    ]);
  });
});

describe("parseQuery", () => {
  it("separates quoted phrases from tokenized terms", () => {
    expect(parseQuery('"late  charge" rent of the Premises')).toEqual({
      terms: ["rent", "premises"],
      phrases: ["late charge"],
    });
  });

  it("ignores an unbalanced quote and empty phrases", () => {
    expect(parseQuery('"" notice "period')).toEqual({ terms: ["notice", "period"], phrases: [] });
  });

  it("phraseRegExp matches case-insensitively across line wraps, with regex chars escaped", () => {
    const re = phraseRegExp("five percent (5%)");
    expect("a Five\npercent (5%) b".match(re)?.[0]).toBe("Five\npercent (5%)");
    expect(phraseRegExp("a.b").test("axb")).toBe(false);
  });
});
