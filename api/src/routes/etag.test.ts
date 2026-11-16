import { describe, expect, it } from "vitest";
import { checkIfMatch, etagFor, ifMatchSatisfied } from "./etag.js";

describe("If-Match", () => {
  it("formats the version as a strong ETag", () => {
    expect(etagFor(3)).toBe('"v3"');
  });

  it.each([
    ['"v3"', true],
    ['W/"v3"', true],
    ["*", true],
    ['"v1", "v3"', true],
    ['W/"v2" , *', true],
    ['"v2"', false],
    ['"v30"', false],
    ["v3", false],
    ['"v1","v2"', false],
  ])("%s against version 3 is %s", (header, expected) => {
    expect(ifMatchSatisfied(header, 3)).toBe(expected);
  });

  it("allows a missing header and throws 412 with the current version on a mismatch", () => {
    expect(() => checkIfMatch(undefined, 3)).not.toThrow();
    expect(() => checkIfMatch('"v2"', 3)).toThrow(
      expect.objectContaining({
        status: 412,
        reason: "VERSION_CONFLICT",
        details: { currentVersion: 3 },
      }),
    );
  });
});
