/**
 * The per-document part of the index, built from text alone: passages and their postings.
 * Pure and dependency-light, so the index worker and the synchronous path run the same code.
 * Everything is flat typed arrays plus one string array, so a worker can transfer it whole
 * and the main thread only wraps it (no tokenizing, no per-posting objects).
 */
import { splitPassages } from "./passages.js";
import { forEachToken, isStopword } from "./tokenize.js";

export interface Segment {
  /** Passage i spans text[starts[i], ends[i]) and has lengths[i] indexed tokens. */
  starts: Uint32Array;
  ends: Uint32Array;
  lengths: Uint32Array;
  /** Distinct indexed terms, in order of first appearance. */
  terms: string[];
  /** Postings of terms[t] are passageIds/tfs[offsets[t], offsets[t + 1]), by passage order. */
  offsets: Uint32Array;
  passageIds: Uint32Array;
  tfs: Uint32Array;
}

/** Splits and tokenizes `text`. Passages with no indexed token are dropped. */
export function buildSegment(text: string): Segment {
  const starts: number[] = [];
  const ends: number[] = [];
  const lengths: number[] = [];
  const byTerm = new Map<string, number[]>(); // term -> [passageId, tf, passageId, tf, ...]
  const tf = new Map<string, number>();
  for (const span of splitPassages(text)) {
    const passageId = starts.length;
    let length = 0;
    tf.clear();
    forEachToken(text, span.start, span.end, (term) => {
      if (isStopword(term)) return;
      length++;
      tf.set(term, (tf.get(term) ?? 0) + 1);
    });
    if (length === 0) continue; // punctuation or stopwords only: nothing can match it
    for (const [term, n] of tf) {
      let list = byTerm.get(term);
      if (!list) byTerm.set(term, (list = []));
      list.push(passageId, n);
    }
    starts.push(span.start);
    ends.push(span.end);
    lengths.push(length);
  }
  let total = 0;
  for (const list of byTerm.values()) total += list.length / 2;
  const terms: string[] = [];
  const offsets = new Uint32Array(byTerm.size + 1);
  const passageIds = new Uint32Array(total);
  const tfs = new Uint32Array(total);
  let at = 0;
  for (const [term, list] of byTerm) {
    offsets[terms.length] = at;
    terms.push(term);
    for (let i = 0; i < list.length; i += 2) {
      passageIds[at] = list[i] ?? 0;
      tfs[at] = list[i + 1] ?? 0;
      at++;
    }
  }
  offsets[terms.length] = at;
  return {
    starts: Uint32Array.from(starts),
    ends: Uint32Array.from(ends),
    lengths: Uint32Array.from(lengths),
    terms,
    offsets,
    passageIds,
    tfs,
  };
}

/** The buffers to transfer when posting a segment between threads. */
export function segmentTransferList(s: Segment): ArrayBuffer[] {
  return [s.starts, s.ends, s.lengths, s.offsets, s.passageIds, s.tfs].map(
    (a) => a.buffer as ArrayBuffer,
  );
}
