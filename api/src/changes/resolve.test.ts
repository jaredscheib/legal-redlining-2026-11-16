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
