/** Splits a search string into quoted phrases and the free terms around them. */
import { terms } from "./tokenize.js";

export interface ParsedQuery {
  /** Unquoted tokens, lowercased, stopwords removed, deduplicated. */
  terms: string[];
  /** Quoted strings with their inner whitespace collapsed; never expanded. */
  phrases: string[];
}

const QUOTED = /"([^"]*)"/g;

export function parseQuery(q: string): ParsedQuery {
  const phrases: string[] = [];
  const rest = q.replace(QUOTED, (_m, inner: string) => {
    const phrase = inner.trim().replace(/\s+/g, " ");
    if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
    return " ";
  });
  // An unbalanced quote is ignored; the tokenizer drops it with the other punctuation.
  return { terms: terms(rest), phrases };
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A case-insensitive matcher for a phrase. Whitespace inside the phrase matches any run of
 * whitespace, so a phrase still matches across the hard line wraps contracts often have.
 */
export function phraseRegExp(phrase: string): RegExp {
  const pattern = phrase.split(" ").map(escapeRegExp).join("\\s+");
  return new RegExp(pattern, "giu");
}
