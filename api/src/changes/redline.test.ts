import { describe, expect, it } from "vitest";
import { buildRedline, contextAfter, contextBefore, wordSegments } from "./redline.js";
import { resolveChanges } from "./resolve.js";

describe("wordSegments", () => {
  it("shows a word swap as word-level delete/insert around equal text", () => {
    expect(wordSegments("thirty (30) days", "fifteen (15) days")).toEqual([
      { type: "delete", text: "thirty" },
      { type: "insert", text: "fifteen" },
      { type: "equal", text: " (" },
      { type: "delete", text: "30" },
      { type: "insert", text: "15" },
      { type: "equal", text: ") days" },
    ]);
  });

  it("is a single delete for a deletion and a single insert-heavy diff for an addition", () => {
    expect(wordSegments("within thirty days", "")).toEqual([
      { type: "delete", text: "within thirty days" },
    ]);
    const added = wordSegments("days", "business days");
    expect(added.filter((s) => s.type === "delete")).toEqual([]);
    expect(added.map((s) => s.text).join("")).toBe("business days");
  });

  it("merges adjacent same-type segments", () => {
    const segs = wordSegments("one two three", "four five six");
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i]?.type).not.toBe(segs[i - 1]?.type);
    }
  });

  it("always rebuilds both texts exactly, whitespace included", () => {
    const pairs: [string, string][] = [
      ["a  b c", "a b  d"],
      ["Party  A\nshall", "Party A shall"],
      ["Café 🚀 “x”", "Café 🛸 “y”"],
    ];
    for (const [oldText, newText] of pairs) {
      const segs = wordSegments(oldText, newText);
      const join = (skip: string) =>
        segs
          .filter((s) => s.type !== skip)
          .map((s) => s.text)
          .join("");
      expect(join("insert")).toBe(oldText);
      expect(join("delete")).toBe(newText);
    }
  });
});

describe("context", () => {
  const text = "The Customer shall pay all undisputed invoices within thirty days of receipt.";

  it("stops at the document edges without trimming", () => {
    expect(contextBefore(text, 4, 80)).toBe("The ");
    expect(contextAfter(text, text.length - 9, 80)).toBe(" receipt.");
    expect(contextBefore(text, 0, 80)).toBe("");
    expect(contextAfter(text, text.length, 80)).toBe("");
  });

  it("drops a partial word where the window cuts one", () => {
    const at = text.indexOf("within");
    // 12 chars before "within" is "d invoices " (cut inside "undisputed").
    expect(contextBefore(text, at, 12)).toBe("invoices ");
    const end = at + "within".length;
    // 10 chars after is " thirty da" (cut inside "days").
    expect(contextAfter(text, end, 10)).toBe(" thirty");
  });

  it("keeps a whole-word window as is", () => {
    const at = text.indexOf("within");
    expect(contextBefore(text, at, 9)).toBe("invoices ");
    expect(contextAfter(text, at + 6, 7)).toBe(" thirty");
  });

  it("keeps a window with no whitespace rather than returning nothing", () => {
    expect(contextBefore("abcdefghij", 10, 4)).toBe("ghij");
    expect(contextAfter("abcdefghij", 0, 4)).toBe("abcd");
  });
});

describe("buildRedline", () => {
  it("builds one hunk per change with offsets in the original text", () => {
    const text = "Payment is due within thirty (30) days of the invoice date.";
    const resolved = resolveChanges(text, [
      {
        operation: "replace",
        target: { text: "thirty (30) days" },
        replacement: "fifteen (15) days",
      },
    ]);
    const [hunk] = buildRedline(text, resolved);
    expect(hunk).toMatchObject({
      changeIndex: 0,
      start: text.indexOf("thirty"),
      end: text.indexOf("thirty") + "thirty (30) days".length,
      before: "Payment is due within ",
      after: " of the invoice date.",
    });
    expect(hunk?.segments[0]).toEqual({ type: "delete", text: "thirty" });
  });
});
