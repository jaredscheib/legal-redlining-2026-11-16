import { describe, expect, it } from "vitest";
import type { ReplaceChange } from "../domain/types.js";
import { ApiError } from "../errors.js";
import { findOccurrence, resolveChanges } from "./resolve.js";

const replace = (text: string, replacement: string, occurrence?: number): ReplaceChange => ({
  operation: "replace",
  target: occurrence === undefined ? { text } : { text, occurrence },
  replacement,
});

function apiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

const TEXT = "Fees are due. Fees are late. Fees are waived.";

describe("resolveChanges", () => {
  it("defaults to the first occurrence", () => {
    expect(resolveChanges(TEXT, [replace("Fees", "Charges")])).toEqual([
      { changeIndex: 0, start: 0, end: 4, oldText: "Fees", newText: "Charges" },
    ]);
  });

  it("resolves the second and nth occurrence", () => {
    expect(resolveChanges(TEXT, [replace("Fees", "X", 2)])[0]?.start).toBe(14);
    expect(resolveChanges(TEXT, [replace("Fees", "X", 3)])[0]?.start).toBe(29);
  });

  it("is exact and case-sensitive", () => {
    const err = apiError(() => resolveChanges(TEXT, [replace("fees", "X")]));
    expect(err.status).toBe(422);
    expect(err.reason).toBe("TARGET_NOT_FOUND");
    expect(err.details).toEqual({ changeIndex: 0 });
  });

  it("reports how many were found when the occurrence is out of range", () => {
    const err = apiError(() => resolveChanges(TEXT, [replace("Fees", "X", 4)]));
    expect(err.status).toBe(422);
    expect(err.reason).toBe("OCCURRENCE_OUT_OF_RANGE");
    expect(err.details).toEqual({ changeIndex: 0, found: 3 });
  });

  it("counts occurrences without overlaps", () => {
    // "aaaa" holds two non-overlapping "aa" (at 0 and 2), not three.
    expect(findOccurrence("aaaa", "aa", 2)).toEqual({ start: 2 });
    expect(findOccurrence("aaaa", "aa", 3)).toEqual({ found: 2 });
  });

  it("rejects an empty target with 400 INVALID_PAYLOAD", () => {
    const err = apiError(() => resolveChanges(TEXT, [replace("", "X")]));
    expect(err.status).toBe(400);
    expect(err.reason).toBe("INVALID_PAYLOAD");
  });

  it("uses UTF-16 offsets for unicode text", () => {
    const text = "Café 🚀 clause — “Party A” agrees.";
    const [r] = resolveChanges(text, [replace("“Party A”", "“Party B”")]);
    expect(r?.start).toBe(text.indexOf("“Party A”"));
    expect(text.slice(r?.start, r?.end)).toBe("“Party A”");
  });

  it("tags each resolved change with its index", () => {
    const resolved = resolveChanges(TEXT, [replace("late", "overdue"), replace("due", "owed")]);
    expect(resolved.map((r) => r.changeIndex)).toEqual([0, 1]);
  });
});

describe("resolveChanges with a range", () => {
  const range = (start: number, end: number, replacement: string, expectedText?: string) =>
    ({
      operation: "replace",
      range: expectedText === undefined ? { start, end } : { start, end, expectedText },
      replacement,
    }) satisfies ReplaceChange;

  it("takes the text at the half-open range", () => {
    expect(resolveChanges(TEXT, [range(14, 18, "Charges", "Fees")])).toEqual([
      { changeIndex: 0, start: 14, end: 18, oldText: "Fees", newText: "Charges" },
    ]);
  });

  it("allows an empty range (an insertion) and the full text", () => {
    expect(resolveChanges(TEXT, [range(0, 0, "All ")])[0]?.oldText).toBe("");
    expect(resolveChanges(TEXT, [range(0, TEXT.length, "x")])[0]?.oldText).toBe(TEXT);
  });

  it("counts UTF-16 code units", () => {
    const text = "a🚀b";
    expect(resolveChanges(text, [range(1, 3, "!", "🚀")])[0]?.oldText).toBe("🚀");
  });

  it.each([
    [-1, 2],
    [5, 3],
    [0, TEXT.length + 1],
  ])("rejects [%i, %i) with 422 RANGE_OUT_OF_BOUNDS", (start, end) => {
    const err = apiError(() => resolveChanges(TEXT, [replace("Fees", "X"), range(start, end, "")]));
    expect(err.status).toBe(422);
    expect(err.reason).toBe("RANGE_OUT_OF_BOUNDS");
    expect(err.details).toMatchObject({ changeIndex: 1 });
  });

  it("rejects a differing expectedText with 422 EXPECTED_TEXT_MISMATCH", () => {
    const err = apiError(() => resolveChanges(TEXT, [range(0, 4, "X", "fees")]));
    expect(err.status).toBe(422);
    expect(err.reason).toBe("EXPECTED_TEXT_MISMATCH");
    expect(err.details).toEqual({ changeIndex: 0 });
  });

  it("mixes with target changes, each keeping its index", () => {
    const resolved = resolveChanges(TEXT, [replace("late", "overdue"), range(0, 4, "Charges")]);
    expect(resolved.map((r) => [r.changeIndex, r.start, r.oldText])).toEqual([
      [0, 23, "late"],
      [1, 0, "Fees"],
    ]);
  });
});
