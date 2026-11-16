/** Splits a document into clause-sized passages, in one linear pass. */
import { PASSAGE_MAX_CHARS } from "../config.js";

export interface PassageSpan {
  start: number;
  end: number;
}

/** A sentence end (`.`, `;` or `:` before whitespace) or a blank line. */
const BOUNDARY = /[.;:](?=\s)|\n[ \t\r\f\v]*\n/g;
const SPACE = /\s/;

const isSpace = (text: string, i: number) => SPACE.test(text.charAt(i));

/**
 * Passages of `text` with trimmed offsets. A sentence keeps its closing punctuation; a
 * passage longer than `maxChars` is cut at the last whitespace that fits (or hard-cut when
 * there is none). Empty passages are dropped.
 */
export function splitPassages(text: string, maxChars: number = PASSAGE_MAX_CHARS): PassageSpan[] {
  const out: PassageSpan[] = [];
  const re = new RegExp(BOUNDARY.source, BOUNDARY.flags);
  let segStart = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const isPunct = m[0].length === 1;
    pushSegment(text, segStart, m.index + (isPunct ? 1 : 0), maxChars, out);
    segStart = m.index + m[0].length;
  }
  pushSegment(text, segStart, text.length, maxChars, out);
  return out;
}

function pushSegment(
  text: string,
  from: number,
  to: number,
  maxChars: number,
  out: PassageSpan[],
): void {
  let start = from;
  while (start < to) {
    while (start < to && isSpace(text, start)) start++;
    if (start >= to) return;
    let end = to;
    if (end - start > maxChars) {
      // Cut after the last whitespace within the limit; scanning back is bounded by maxChars.
      let cut = start + maxChars;
      while (cut > start && !isSpace(text, cut)) cut--;
      end = cut > start ? cut : start + maxChars;
    }
    let e = end;
    while (e > start && isSpace(text, e - 1)) e--;
    out.push({ start, end: e });
    start = end;
  }
}
