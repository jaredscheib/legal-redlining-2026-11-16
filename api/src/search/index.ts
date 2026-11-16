/**
 * In-memory inverted index over passages with BM25 ranking. Postings are kept per document,
 * so re-indexing or removing one document touches only its own postings; the corpus stats
 * (N, average passage length, document frequency) span every document.
 */
import { BM25 } from "../config.js";
import type { Document } from "../domain/types.js";
import { splitPassages } from "./passages.js";
import { forEachToken, isStopword } from "./tokenize.js";

export interface Posting {
  /** Index into the owning document's `passages`. */
  passageId: number;
  tf: number;
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
  postings: Map<string, Posting[]>;
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

  /** (Re)indexes a document, replacing any earlier version of it. */
  indexDoc(doc: Document): IndexedDoc {
    this.removeDoc(doc.id);
    const passages: IndexedPassage[] = [];
    const postings = new Map<string, Posting[]>();
    const tf = new Map<string, number>();
    for (const span of splitPassages(doc.text)) {
      const passageId = passages.length;
      let length = 0;
      tf.clear();
      forEachToken(doc.text, span.start, span.end, (term) => {
        if (isStopword(term)) return;
        length++;
        tf.set(term, (tf.get(term) ?? 0) + 1);
      });
      if (length === 0) continue; // punctuation or stopwords only: nothing can match it
      for (const [term, n] of tf) {
        let list = postings.get(term);
        if (!list) postings.set(term, (list = []));
        list.push({ passageId, tf: n });
      }
      passages.push({ start: span.start, end: span.end, length });
      this.totalLength += length;
    }
    for (const [term, list] of postings) this.df.set(term, this.docFreq(term) + list.length);
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
      const left = this.docFreq(term) - list.length;
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
        for (const { passageId, tf } of list) {
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
