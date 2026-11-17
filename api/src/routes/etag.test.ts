import { describe, expect, it } from "vitest";
import { checkIfMatch, etagFor, ifMatchSatisfied, parseIfMatch } from "./etag.js";

describe("If-Match", () => {
  it("formats the version as a strong ETag", () => {
    expect(etagFor(3)).toBe('"v3"');
  });

  it.each([
    ['"v3"', true],
    ["*", true],
    [" * ", true],
    ['"v1", "v3"', true],
    ['"v1",,"v3"', true],
    ['W/"v3"', false],
    ['W/"v1", W/"v3"', false],
    ['"v2"', false],
    ['"v30"', false],
    ['"v1","v2"', false],
    ["v3", false],
    ["", false],
    ['"v3", *', false],
    ['"v3", v4', false],
  ])("%j against version 3 is %s (strong comparison)", (header, expected) => {
    expect(ifMatchSatisfied(header, 3)).toBe(expected);
  });

  it.each(["v3", "", "  ", ",", '"v3', 'w/"v3"', '"v3", *', '"v3", v4'])(
    "%j is malformed",
    (header) => {
      expect(parseIfMatch(header)).toBe("malformed");
    },
  );

  it("allows a missing header and throws 412 with the current version on a mismatch", () => {
    expect(() => checkIfMatch(undefined, 3)).not.toThrow();
    expect(() => checkIfMatch('"v2"', 3)).toThrow(
      expect.objectContaining({
        status: 412,
        reason: "VERSION_CONFLICT",
        message: "the document changed since this version",
        details: { currentVersion: 3 },
      }),
    );
  });

  it("a weak tag for the current version is a 412 that explains strong comparison", () => {
    expect(() => checkIfMatch('W/"v3"', 3)).toThrow(
      expect.objectContaining({
        status: 412,
        reason: "VERSION_CONFLICT",
        message: 'If-Match uses strong comparison, so a weak ETag never matches; send "v3"',
        details: { currentVersion: 3 },
      }),
    );
  });

  it("a malformed header is a 412 that says so, not that the document changed", () => {
    expect(() => checkIfMatch("v3", 3)).toThrow(
      expect.objectContaining({
        status: 412,
        reason: "VERSION_CONFLICT",
        message: 'If-Match must be * or quoted ETags such as "v3"',
        details: { currentVersion: 3 },
      }),
    );
  });
});
