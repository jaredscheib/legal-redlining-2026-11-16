import { ApiError } from "../errors.js";

/** The strong ETag for a document version, e.g. `"v3"`. */
export const etagFor = (version: number) => `"v${version}"`;

/** One `entity-tag` (RFC 9110 §8.8.3): optional `W/`, then a quoted opaque tag. */
const ENTITY_TAG = /^(W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/;

/**
 * An `If-Match` value parsed per RFC 9110 §13.1.1: `*`, or a comma-separated list of entity
 * tags (empty list elements are ignored). Anything else, including an empty value, is
 * malformed.
 */
export type IfMatch = { any: true } | { any: false; tags: string[] } | "malformed";

export function parseIfMatch(header: string): IfMatch {
  const value = header.trim();
  if (value === "*") return { any: true };
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  if (tags.length === 0 || !tags.every((tag) => ENTITY_TAG.test(tag))) return "malformed";
  return { any: false, tags };
}

/**
 * Whether an `If-Match` header value matches `version`, by strong comparison: `*`, or a list
 * holding the strong tag `"v<n>"`. A weak tag `W/"v<n>"` never matches. Malformed: false.
 */
export function ifMatchSatisfied(header: string, version: number): boolean {
  const parsed = parseIfMatch(header);
  if (parsed === "malformed") return false;
  return parsed.any || parsed.tags.includes(etagFor(version));
}

/**
 * Throws 412 VERSION_CONFLICT when an `If-Match` header is present and does not match, with a
 * message that says why: the header is malformed, it names the current version only weakly,
 * or the document has moved on.
 */
export function checkIfMatch(header: string | undefined, version: number): void {
  if (header === undefined || ifMatchSatisfied(header, version)) return;
  const parsed = parseIfMatch(header);
  const current = etagFor(version);
  const message =
    parsed === "malformed"
      ? `If-Match must be * or quoted ETags such as ${current}`
      : !parsed.any && parsed.tags.includes(`W/${current}`)
        ? `If-Match uses strong comparison, so a weak ETag never matches; send ${current}`
        : "the document changed since this version";
  throw new ApiError(412, "VERSION_CONFLICT", message, { currentVersion: version });
}
