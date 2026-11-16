/**
 * In-memory inverted index over passages with BM25 ranking, as one segment per document: each
 * document holds its own passages and postings, and the corpus stats (N, total length,
 * document frequency) span every document. Swapping a document in replaces its segment and
 * adjusts df by its distinct terms; it never tokenizes, so a segment built off the main thread
 * (see index-worker.ts) goes in cheaply.
 */
import { BM25 } from "../config.js";
import type { Document } from "../domain/types.js";
import { buildSegment, type Segment } from "./segment.js";

export interface PostingList {
  /** Indexes into the owning document's `passages`, ascending. */
  passageIds: Uint32Array;
  tfs: Uint32Array;
}

export interface IndexedPassage {
  start: number;
  end: number;
  /** Number of indexed (non-stopword) tokens. */
  length: number;
}

export interface IndexedDoc {
  id: string;
  title: string;
  version: number;
  text: string;
  passages: IndexedPassage[];
  postings: Map<string, PostingList>;
}

export interface WeightedTerm {
  term: string;
  weight: number;
}

export interface ScoredPassage {
  doc: IndexedDoc;
  passageId: number;
  score: number;
}

export class SearchIndex {
  private readonly docs = new Map<string, IndexedDoc>();
  private readonly df = new Map<string, number>();
  private totalLength = 0;
  private passageCount = 0;

  /** Number of passages in the corpus. */
  get N(): number {
    return this.passageCount;
  }

  get avgdl(): number {
    return this.passageCount === 0 ? 0 : this.totalLength / this.passageCount;
  }

  docFreq(term: string): number {
    return this.df.get(term) ?? 0;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get(id: string): IndexedDoc | undefined {
    return this.docs.get(id);
  }

  ids(): string[] {
    return [...this.docs.keys()];
  }

  /** (Re)indexes a document synchronously, replacing any earlier version of it. */
  indexDoc(doc: Document): IndexedDoc {
    return this.swap(doc, buildSegment(doc.text));
  }

  /**
   * Replaces the document's segment with `segment`, built from `doc.text`. Cost is linear in
   * the document's passages and distinct terms; no text is read.
   */
  swap(doc: Document, segment: Segment): IndexedDoc {
    this.removeDoc(doc.id);
    const { starts, ends, lengths, terms, offsets, passageIds, tfs } = segment;
    const passages: IndexedPassage[] = new Array<IndexedPassage>(starts.length);
    for (let i = 0; i < starts.length; i++) {
      const length = lengths[i] ?? 0;
      passages[i] = { start: starts[i] ?? 0, end: ends[i] ?? 0, length };
      this.totalLength += length;
    }
    const postings = new Map<string, PostingList>();
    for (let t = 0; t < terms.length; t++) {
      const term = terms[t] as string;
      const from = offsets[t] ?? 0;
      const to = offsets[t + 1] ?? from;
      postings.set(term, {
        passageIds: passageIds.subarray(from, to),
        tfs: tfs.subarray(from, to),
      });
      this.df.set(term, this.docFreq(term) + (to - from));
    }
    this.passageCount += passages.length;
    const entry: IndexedDoc = {
      id: doc.id,
      title: doc.title,
      version: doc.version,
      text: doc.text,
      passages,
      postings,
    };
    this.docs.set(doc.id, entry);
    return entry;
  }

  removeDoc(id: string): boolean {
    const entry = this.docs.get(id);
    if (!entry) return false;
    for (const [term, list] of entry.postings) {
      const left = this.docFreq(term) - list.passageIds.length;
      if (left > 0) this.df.set(term, left);
      else this.df.delete(term);
    }
    for (const p of entry.passages) this.totalLength -= p.length;
    this.passageCount -= entry.passages.length;
    this.docs.delete(id);
    return true;
  }

  /** BM25 idf, the non-negative variant: ln(1 + (N - df + 0.5) / (df + 0.5)). */
  idf(term: string): number {
    const df = this.docFreq(term);
    return Math.log(1 + (this.passageCount - df + 0.5) / (df + 0.5));
  }

  /** Every passage of `docIds` (default: all) that contains at least one term, with its score. */
  score(terms: WeightedTerm[], docIds?: string[]): ScoredPassage[] {
    const { k1, b } = BM25;
    const avgdl = this.avgdl || 1;
    const out: ScoredPassage[] = [];
    const docs = docIds ? docIds.flatMap((id) => this.docs.get(id) ?? []) : [...this.docs.values()];
    for (const doc of docs) {
      const scores = new Map<number, number>();
      for (const { term, weight } of terms) {
        const list = doc.postings.get(term);
        if (!list) continue;
        const idf = this.idf(term) * weight;
        const { passageIds, tfs } = list;
        for (let i = 0; i < passageIds.length; i++) {
          const passageId = passageIds[i] ?? 0;
          const tf = tfs[i] ?? 0;
          const len = doc.passages[passageId]?.length ?? 0;
          const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / avgdl));
          scores.set(passageId, (scores.get(passageId) ?? 0) + s);
        }
      }
      for (const [passageId, score] of scores) out.push({ doc, passageId, score });
    }
    return out;
  }
}
