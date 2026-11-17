import type { ChangeOp, ReplaceChange, ReplaceRangeChange } from "../domain/types.js";
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

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Whether `offset` falls between the two halves of a UTF-16 surrogate pair in `text`. */
export function splitsSurrogatePair(text: string, offset: number): boolean {
  return (
    offset > 0 &&
    offset < text.length &&
    isHighSurrogate(text.charCodeAt(offset - 1)) &&
    isLowSurrogate(text.charCodeAt(offset))
  );
}

/** 422 SPLITS_CHARACTER when a resolved change would cut a character in half. */
function checkWholeCharacters(text: string, resolved: ResolvedChange): ResolvedChange {
  const { start, end, changeIndex } = resolved;
  if (splitsSurrogatePair(text, start) || splitsSurrogatePair(text, end)) {
    throw new ApiError(
      422,
      "SPLITS_CHARACTER",
      "the change starts or ends between the two halves of a character (a UTF-16 surrogate pair)",
      { changeIndex, start, end },
    );
  }
  return resolved;
}

function resolveRange(
  text: string,
  change: ReplaceRangeChange,
  changeIndex: number,
): ResolvedChange {
  const { start, end, expectedText } = change.range;
  if (!(0 <= start && start <= end && end <= text.length)) {
    throw new ApiError(422, "RANGE_OUT_OF_BOUNDS", "range is outside the document", {
      changeIndex,
      start,
      end,
      length: text.length,
    });
  }
  const oldText = text.slice(start, end);
  if (expectedText !== undefined && expectedText !== oldText) {
    throw new ApiError(
      422,
      "EXPECTED_TEXT_MISMATCH",
      "the text at the range differs from expectedText",
      { changeIndex },
    );
  }
  return checkWholeCharacters(text, {
    changeIndex,
    start,
    end,
    oldText,
    newText: change.replacement,
  });
}

/**
 * Resolves each replace change to `{start, end, oldText, newText}` against `text`.
 * Target changes: 400 INVALID_PAYLOAD for an empty target, 422 TARGET_NOT_FOUND when there is
 * no occurrence, and 422 OCCURRENCE_OUT_OF_RANGE when there are fewer than requested.
 * Range changes: 422 RANGE_OUT_OF_BOUNDS and 422 EXPECTED_TEXT_MISMATCH.
 * Either form: 422 SPLITS_CHARACTER when `start` or `end` falls inside a surrogate pair.
 */
export function resolveChanges(text: string, changes: ReplaceChange[]): ResolvedChange[] {
  return changes.map((change, changeIndex) => {
    if (change.range !== undefined) return resolveRange(text, change, changeIndex);
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
    return checkWholeCharacters(text, {
      changeIndex,
      start: hit.start,
      end: hit.start + needle.length,
      oldText: needle,
      newText: change.replacement,
    });
  });
}
