/** Lowercased Unicode letter/digit runs with their offsets. No stemming. */

export interface Token {
  term: string;
  start: number;
  end: number;
}

/** A small English list; legal words such as "not", "shall" and "any" are kept on purpose. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "so",
  "than",
  "that",
  "the",
  "their",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "was",
  "were",
  "which",
  "with",
]);

const WORD = /[\p{L}\p{N}]+/gu;

export function isStopword(term: string): boolean {
  return STOPWORDS.has(term);
}

/**
 * Tokens of `text[from, to)`, offsets into `text`. Stopwords are dropped unless
 * `keepStopwords` is set.
 */
export function tokenize(
  text: string,
  opts: { from?: number; to?: number; keepStopwords?: boolean } = {},
): Token[] {
  const out: Token[] = [];
  forEachToken(text, opts.from ?? 0, opts.to ?? text.length, (term, start, end) => {
    if (opts.keepStopwords || !STOPWORDS.has(term)) out.push({ term, start, end });
  });
  return out;
}

/** Allocation-light walk over the tokens of `text[from, to)`, stopwords included. */
export function forEachToken(
  text: string,
  from: number,
  to: number,
  fn: (term: string, start: number, end: number) => void,
): void {
  const re = new RegExp(WORD.source, WORD.flags);
  re.lastIndex = from;
  for (let m = re.exec(text); m !== null && m.index < to; m = re.exec(text)) {
    const end = Math.min(m.index + m[0].length, to);
    fn(text.slice(m.index, end).toLowerCase(), m.index, end);
  }
}

/** Query-side helper: distinct non-stopword terms, in order of first appearance. */
export function terms(text: string): string[] {
  return [...new Set(tokenize(text).map((t) => t.term))];
}
