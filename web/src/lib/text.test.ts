import { describe, expect, it } from "vitest";
import { computeOccurrence, plural, rangeToOffsets } from "./text";

describe("computeOccurrence", () => {
  const text = "the fee. the fee. the fee.";

  it("is 1 for the first occurrence", () => {
    expect(computeOccurrence(text, "the fee", 0)).toBe(1);
  });

  it("counts earlier occurrences that end at or before the start", () => {
    expect(computeOccurrence(text, "the fee", 9)).toBe(2);
    expect(computeOccurrence(text, "the fee", 18)).toBe(3);
  });

  it("counts an occurrence that ends exactly at the start", () => {
    expect(computeOccurrence("abab", "ab", 2)).toBe(2);
  });

  it("counts non-overlapping occurrences only", () => {
    // "aa" in "aaaa": non-overlapping matches at 0 and 2.
    expect(computeOccurrence("aaaa", "aa", 2)).toBe(2);
    // A selection at 1 overlaps the first match, which ends after 1.
    expect(computeOccurrence("aaaa", "aa", 1)).toBe(1);
  });

  it("is 1 when the text only appears at the selection", () => {
    expect(computeOccurrence("one two three", "three", 8)).toBe(1);
  });
});

describe("rangeToOffsets", () => {
  it("maps a DOM selection across nested nodes to text offsets", () => {
    const pre = document.createElement("pre");
    pre.append("Alpha beta ");
    const mark = document.createElement("mark");
    mark.textContent = "gamma";
    pre.append(mark, " delta");
    document.body.append(pre);

    const range = document.createRange();
    const markText = mark.firstChild;
    const tail = pre.lastChild;
    if (!markText || !tail) throw new Error("missing nodes");
    range.setStart(markText, 2);
    range.setEnd(tail, 3);
    expect(rangeToOffsets(pre, range)).toEqual({ start: 13, end: 19 });
    expect(pre.textContent?.slice(13, 19)).toBe("mma de");
    pre.remove();
  });

  it("ignores collapsed ranges and ranges outside the container", () => {
    const pre = document.createElement("pre");
    pre.textContent = "text";
    const other = document.createElement("p");
    other.textContent = "elsewhere";
    document.body.append(pre, other);
    const collapsed = document.createRange();
    collapsed.setStart(pre.firstChild as Node, 1);
    expect(rangeToOffsets(pre, collapsed)).toBeNull();
    const outside = document.createRange();
    outside.selectNodeContents(other);
    expect(rangeToOffsets(pre, outside)).toBeNull();
    pre.remove();
    other.remove();
  });
});

describe("plural", () => {
  it("uses the singular only for exactly one", () => {
    expect(plural(0, "change")).toBe("0 changes");
    expect(plural(1, "change")).toBe("1 change");
    expect(plural(2, "change")).toBe("2 changes");
    expect(plural(12345, "character")).toBe("12,345 characters");
  });
});
