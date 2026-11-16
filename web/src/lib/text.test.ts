import { describe, expect, it } from "vitest";
import { plural, rangeToOffsets } from "./text";

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
