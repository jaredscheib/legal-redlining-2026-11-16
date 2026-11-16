import type { ChangeOp } from "../domain/types.js";
import { ApiError } from "../errors.js";

/**
 * Checks that every op lies inside `text`, matches the text it claims to replace, and that no
 * two ops overlap (or share a start). Returns the ops sorted by start. O(k log k + replaced).
 */
export function validateOps<T extends ChangeOp>(text: string, ops: readonly T[]): T[] {
  for (const op of ops) {
    const inBounds = 0 <= op.start && op.start <= op.end && op.end <= text.length;
    if (!inBounds || text.slice(op.start, op.end) !== op.oldText) {
      throw new ApiError(422, "INVALID_RANGE", "change does not match the document text", {
        start: op.start,
        end: op.end,
      });
    }
  }
  const sorted = [...ops].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as T;
    const cur = sorted[i] as T;
    if (cur.start < prev.end || cur.start === prev.start) {
      throw new ApiError(422, "OVERLAPPING_CHANGES", "changes overlap", {
        ranges: [
          { start: prev.start, end: prev.end },
          { start: cur.start, end: cur.end },
        ],
      });
    }
  }
  return sorted;
}

/**
 * Applies ops whose offsets all refer to the original `text`, in one pass: collect the kept
 * slices and replacements, join once. O(n + k log k).
 */
export function applyOps(text: string, ops: readonly ChangeOp[]): string {
  const sorted = validateOps(text, ops);
  const parts: string[] = [];
  let cursor = 0;
  for (const op of sorted) {
    parts.push(text.slice(cursor, op.start), op.newText);
    cursor = op.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}
