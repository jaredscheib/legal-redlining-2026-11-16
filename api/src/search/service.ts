/**
 * BM25 passage search over every document in the store, kept current through `onChange`.
 * Query expansion is an optional hook; phrases are never expanded.
 */
import { EXPANSION_TERM_WEIGHT } from "../config.js";
import type {
  DocumentStore,
  SearchDocumentCount,
  SearchExpansion,
  SearchHit,
  SearchQuery,
  SearchResponse,
  SearchService,
} from "../domain/types.js";
import { notFound } from "../errors.js";
import { log } from "../log.js";
import { SearchIndex, type ScoredPassage, type WeightedTerm } from "./index.js";
import { parseQuery, phraseRegExp } from "./query.js";
import { terms as tokenTerms, tokenize } from "./tokenize.js";

export type ExpandFn = (terms: string[]) => Promise<{ added: string[] } | { skipped: string }>;

export interface SearchServiceHandle extends SearchService {
  readonly index: SearchIndex;
  /** Stops following store changes. */
  close(): void;
}

type Span = { start: number; end: number };

export function createSearchService(opts: {
  store: DocumentStore;
  expand?: ExpandFn;
}): SearchServiceHandle {
  const { store, expand } = opts;
  const index = new SearchIndex();

  const reindex = (id: string, reason: "startup" | "create" | "commit") => {
    const doc = store.get(id);
    if (!doc) return;
    const t0 = performance.now();
    const entry = index.indexDoc(doc);
    log.info("search.index", {
      docId: id,
      version: doc.version,
      reason,
      passages: entry.passages.length,
      ms: Math.round(performance.now() - t0),
    });
  };

  const off = store.onChange((e) => reindex(e.id, e.kind));
  for (const { id } of store.list()) reindex(id, "startup");

  async function expandTerms(
    terms: string[],
    enabled: boolean,
  ): Promise<{ expansion: SearchExpansion; added: string[] }> {
    if (!enabled || !expand) return { expansion: { status: "off", added: [] }, added: [] };
    if (terms.length === 0) {
      return { expansion: { status: "skipped", added: [], reason: "no_terms" }, added: [] };
    }
    try {
      const res = await expand(terms);
      if ("skipped" in res) {
        return { expansion: { status: "skipped", added: [], reason: res.skipped }, added: [] };
      }
      const known = new Set(terms);
      const added = [...new Set(res.added.flatMap((a) => tokenTerms(a)))].filter(
        (t) => !known.has(t),
      );
      return { expansion: { status: "applied", added }, added };
    } catch (err) {
      const reason = err instanceof Error && err.name !== "Error" ? err.name : "expand_failed";
      return { expansion: { status: "skipped", added: [], reason }, added: [] };
    }
  }

  async function search(query: SearchQuery): Promise<SearchResponse> {
    const t0 = performance.now();
    for (const id of query.docIds ?? []) {
      if (!index.has(id)) throw notFound("DOCUMENT_NOT_FOUND", `Document ${id} not found`);
    }
    const docIds = query.docIds ? [...new Set(query.docIds)] : undefined;
    const { terms, phrases } = parseQuery(query.q);
    const { expansion, added } = await expandTerms(terms, query.expand);

    // Phrase words score like query terms; phrases also filter the candidates below.
    const phraseTerms = phrases.flatMap((p) => tokenTerms(p));
    const weighted = new Map<string, number>();
    for (const t of [...terms, ...phraseTerms]) weighted.set(t, 1);
    for (const t of added) if (!weighted.has(t)) weighted.set(t, EXPANSION_TERM_WEIGHT);
    const scoringTerms: WeightedTerm[] = [...weighted].map(([term, weight]) => ({ term, weight }));

    const phraseRes = phrases.map(phraseRegExp);
    const passageText = (s: ScoredPassage) => {
      const p = s.doc.passages[s.passageId];
      return p ? s.doc.text.slice(p.start, p.end) : "";
    };
    const containsAllPhrases = (text: string) =>
      phraseRes.every((re) => {
        re.lastIndex = 0;
        return re.test(text);
      });

    let matches = index.score(scoringTerms, docIds);
    if (phraseRes.length > 0) matches = matches.filter((s) => containsAllPhrases(passageText(s)));
    matches.sort(
      (a, b) =>
        b.score - a.score ||
        (a.doc.id < b.doc.id ? -1 : a.doc.id > b.doc.id ? 1 : 0) ||
        (a.doc.passages[a.passageId]?.start ?? 0) - (b.doc.passages[b.passageId]?.start ?? 0),
    );

    const highlightTerms = new Set([...terms, ...added]);
    const results = matches
      .slice(query.offset, query.offset + query.limit)
      .map((s) => toHit(s, passageText(s), highlightTerms, phraseRes));

    log.info("search", {
      qLen: query.q.length,
      terms: terms.length,
      results: matches.length,
      expansion: expansion.status,
      ms: Math.round((performance.now() - t0) * 10) / 10,
    });
    return {
      query: query.q,
      terms,
      phrases,
      expansion,
      total: matches.length,
      results,
      documents: countByDocument(matches),
    };
  }

  return { index, search, close: off };
}

function toHit(
  s: ScoredPassage,
  snippet: string,
  highlightTerms: Set<string>,
  phraseRes: RegExp[],
): SearchHit {
  const p = s.doc.passages[s.passageId] ?? { start: 0, end: 0 };
  const spans: Span[] = [];
  const matched = new Set<string>();
  for (const tok of tokenize(snippet)) {
    if (!highlightTerms.has(tok.term)) continue;
    matched.add(tok.term);
    spans.push({ start: tok.start, end: tok.end });
  }
  for (const re of phraseRes) {
    re.lastIndex = 0;
    for (const m of snippet.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return {
    docId: s.doc.id,
    title: s.doc.title,
    docVersion: s.doc.version,
    start: p.start,
    end: p.end,
    snippet,
    highlights: mergeSpans(spans),
    matchedTerms: [...highlightTerms].filter((t) => matched.has(t)),
    score: Math.round(s.score * 1e4) / 1e4,
  };
}

/**
 * Passage counts per document over `sorted` (best score first): most passages first, ties by
 * the document's best score. Insertion order is best-score order and the sort is stable.
 */
export function countByDocument(sorted: ScoredPassage[]): SearchDocumentCount[] {
  const byDoc = new Map<string, SearchDocumentCount>();
  for (const s of sorted) {
    const entry = byDoc.get(s.doc.id);
    if (entry) entry.passages += 1;
    else byDoc.set(s.doc.id, { docId: s.doc.id, title: s.doc.title, passages: 1 });
  }
  return [...byDoc.values()].sort((a, b) => b.passages - a.passages);
}

/** Sorted, with overlapping or touching spans merged. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}
