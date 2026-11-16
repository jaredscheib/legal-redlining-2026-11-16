import { diffWords, diffWordsWithSpace, type ChangeObject } from "diff";
import { REDLINE_CONTEXT_CHARS } from "../config.js";
import type { RedlineHunk, Segment } from "../domain/types.js";
import type { ResolvedChange } from "./resolve.js";

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

/**
 * Up to `maxChars` of `text` ending at `end`. If the window cuts into a word, the partial word
 * is dropped (unless the window holds no whitespace at all).
 */
export function contextBefore(text: string, end: number, maxChars: number): string {
  const from = Math.max(0, end - maxChars);
  const window = text.slice(from, end);
  if (from === 0 || isSpace(text[from - 1])) return window;
  const cut = window.search(/\s/);
  return cut === -1 ? window : window.slice(cut + 1);
}

/**
 * Up to `maxChars` of `text` starting at `start`. If the window cuts into a word, the partial
 * word is dropped (unless the window holds no whitespace at all).
 */
export function contextAfter(text: string, start: number, maxChars: number): string {
  const to = Math.min(text.length, start + maxChars);
  const window = text.slice(start, to);
  if (to === text.length || isSpace(text[to])) return window;
  let cut = window.length - 1;
  while (cut >= 0 && !isSpace(window[cut])) cut--;
  return cut === -1 ? window : window.slice(0, cut);
}

function toSegments(parts: ChangeObject<string>[]): Segment[] {
  const out: Segment[] = [];
  for (const p of parts) {
    if (p.value === "") continue;
    const type: Segment["type"] = p.added ? "insert" : p.removed ? "delete" : "equal";
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += p.value;
    else out.push({ type, text: p.value });
  }
  return out;
}

function reconstructs(segments: Segment[], oldText: string, newText: string): boolean {
  const join = (skip: Segment["type"]) =>
    segments
      .filter((s) => s.type !== skip)
      .map((s) => s.text)
      .join("");
  return join("insert") === oldText && join("delete") === newText;
}

/**
 * Word-level delete/insert/equal segments of `oldText` against `newText`, with adjacent
 * same-type segments merged. `diffWords` ignores whitespace-only differences, so if its
 * segments do not rebuild both texts exactly we fall back to whitespace-significant diffing.
 */
export function wordSegments(oldText: string, newText: string): Segment[] {
  const segments = toSegments(diffWords(oldText, newText));
  if (reconstructs(segments, oldText, newText)) return segments;
  return toSegments(diffWordsWithSpace(oldText, newText));
}

/**
 * One hunk per resolved change: the replaced span's offsets in the original text, a little
 * surrounding context, and the word diff of the span only.
 */
export function buildRedline(text: string, changes: readonly ResolvedChange[]): RedlineHunk[] {
  return changes.map((c) => ({
    changeIndex: c.changeIndex,
    start: c.start,
    end: c.end,
    before: contextBefore(text, c.start, REDLINE_CONTEXT_CHARS),
    after: contextAfter(text, c.end, REDLINE_CONTEXT_CHARS),
    segments: wordSegments(c.oldText, c.newText),
  }));
}
