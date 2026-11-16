import type { ChangeOp, ReplaceChange } from "../domain/types.js";
import { ApiError } from "../errors.js";

/** A change pinned to offsets in the original text. */
export interface ResolvedChange extends ChangeOp {
  /** Index into the request's `changes` array. */
  changeIndex: number;
}

/**
 * Finds the `occurrence`-th (1-based) match of `needle` in `text`, counting left to right
 * without overlaps, exact and case-sensitive. Returns its start, or the number found if short.
 */
export function findOccurrence(
  text: string,
  needle: string,
  occurrence: number,
): { start: number } | { found: number } {
  let found = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) {
    found++;
    if (found === occurrence) return { start: i };
  }
  return { found };
}

/**
 * Resolves each replace change to `{start, end, oldText, newText}` against `text`.
 * Throws 400 INVALID_PAYLOAD for an empty target, 422 TARGET_NOT_FOUND when there is no
 * occurrence, and 422 OCCURRENCE_OUT_OF_RANGE when there are fewer than requested.
 */
export function resolveChanges(text: string, changes: ReplaceChange[]): ResolvedChange[] {
  return changes.map((change, changeIndex) => {
    const needle = change.target.text;
    const occurrence = change.target.occurrence ?? 1;
    if (needle.length === 0) {
      throw new ApiError(400, "INVALID_PAYLOAD", "target.text must not be empty", { changeIndex });
    }
    const hit = findOccurrence(text, needle, occurrence);
    if ("found" in hit) {
      if (hit.found === 0) {
        throw new ApiError(422, "TARGET_NOT_FOUND", "target text not found in the document", {
          changeIndex,
        });
      }
      throw new ApiError(
        422,
        "OCCURRENCE_OUT_OF_RANGE",
        `occurrence ${occurrence} requested but only ${hit.found} found`,
        { changeIndex, found: hit.found },
      );
    }
    return {
      changeIndex,
      start: hit.start,
      end: hit.start + needle.length,
      oldText: needle,
      newText: change.replacement,
    };
  });
}
