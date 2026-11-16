import { ApiError } from "../errors.js";

/** The strong ETag for a document version, e.g. `"v3"`. */
export const etagFor = (version: number) => `"v${version}"`;

/**
 * Whether an `If-Match` header value matches `version`. Accepts `*`, `"v<n>"` and weak
 * `W/"v<n>"` (compared weakly), and a comma-separated list of those (any may match).
 */
export function ifMatchSatisfied(header: string, version: number): boolean {
  const current = etagFor(version);
  return header
    .split(",")
    .map((tag) => tag.trim())
    .some((tag) => tag === "*" || tag.replace(/^W\//, "") === current);
}

/** Throws 412 VERSION_CONFLICT when an `If-Match` header is present and does not match. */
export function checkIfMatch(header: string | undefined, version: number): void {
  if (header === undefined || ifMatchSatisfied(header, version)) return;
  throw new ApiError(412, "VERSION_CONFLICT", "the document changed since this version", {
    currentVersion: version,
  });
}
