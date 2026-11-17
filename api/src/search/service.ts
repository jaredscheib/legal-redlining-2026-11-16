/**
 * BM25 passage search over every document in the store, kept current through `onChange`.
 * Query expansion is an optional hook; phrases are never expanded.
 */
import { EXPANSION_TERM_WEIGHT } from "../config.js";
import type {
  Document,
  DocumentStore,
  LlmService,
  SearchDocumentCount,
  SearchExpansion,
  SearchHit,
  SearchIndexing,
  SearchQuery,
  SearchResponse,
  SearchService,
} from "../domain/types.js";
import { notFound } from "../errors.js";
import { elapsedMs, log } from "../log.js";
import { SearchIndex, type IndexedDoc, type ScoredPassage, type WeightedTerm } from "./index.js";
import { createIndexer, type IndexMode, type Indexer } from "./indexer.js";
import { parseQuery, phraseRegExp } from "./query.js";
import type { Segment } from "./segment.js";
import { terms as tokenTerms, tokenize } from "./tokenize.js";

export type ExpandFn = LlmService["expand"];

export interface SearchServiceHandle extends SearchService {
  readonly index: SearchIndex;
  /** Where commit reindexes are built. */
  readonly indexMode: IndexMode;
  /** Resolves once no reindex is queued or running (tests, shutdown). */
  idle(): Promise<void>;
  /** Stops following store changes and stops the index worker. */
  close(): void;
}

type Span = { start: number; end: number };

export function createSearchService(opts: {
  store: DocumentStore;
  expand?: ExpandFn;
  /** Default: worker unless SEARCH_INDEX_WORKER=off. */
  mode?: IndexMode;
  /** Overrides `mode` (tests). */
  indexer?: Indexer;
}): SearchServiceHandle {
  const { store, expand } = opts;
  const index = new SearchIndex();
  const indexer = opts.indexer ?? createIndexer(opts.mode);

  /** Puts a built segment in, unless the index already holds this version or a newer one. */
  const swapIn = (doc: Document, segment: Segment): IndexedDoc | null => {
    const indexed = index.get(doc.id)?.version ?? 0;
    if (index.has(doc.id) && indexed >= doc.version) {
      log.info("search.index_discard", { docId: doc.id, version: doc.version, indexed });
      return null;
    }
    const t0 = performance.now();
    const entry = index.swap(doc, segment);
    log.info("search.index_swap", {
      docId: doc.id,
      version: doc.version,
      ms: elapsedMs(t0),
    });
    return entry;
  };

  /** Startup and create index synchronously, so a new document is searchable at once. */
  const indexNow = (id: string, reason: "startup" | "create") => {
    const doc = store.get(id);
    if (!doc) return;
    const t0 = performance.now();
    const entry = index.indexDoc(doc);
    log.info("search.index", {
      docId: id,
      version: doc.version,
      reason,
      mode: "sync",
      passages: entry.passages.length,
      queueMs: 0,
      ms: elapsedMs(t0),
    });
  };

  /**
   * A commit's reindex is built off the request path (in the worker, or after setImmediate in
   * sync mode) while search keeps answering from the previous version and says so. Commits in
   * the same tick coalesce: the queued job reads the latest version when it starts. Jobs may
   * overlap; a result is swapped in only if it is newer than what the index holds, so a late
   * result for an older version never overwrites a newer one.
   */
  const queued = new Set<string>();
  const pending = new Set<Promise<void>>();
  /** Documents whose latest reindex failed, by the version that failed. */
  const failed = new Map<string, number>();

  const scheduleReindex = (id: string) => {
    if (queued.has(id)) return;
    queued.add(id);
    const scheduledAt = performance.now();
    /** The version this job builds, read when it starts; a failure is recorded against it. */
    let building: number | undefined;
    const job = new Promise<void>((resolve) => setImmediate(resolve))
      .then(async () => {
        queued.delete(id);
        const doc = store.get(id);
        if (!doc) return;
        building = doc.version;
        const built = await indexer.build(doc);
        const arrived = performance.now();
        const entry = swapIn(doc, built.segment);
        if (!entry) return;
        log.info("search.index", {
          docId: id,
          version: doc.version,
          reason: "commit",
          mode: built.mode,
          passages: entry.passages.length,
          queueMs: Math.max(0, Math.round(arrived - scheduledAt - built.buildMs)),
          ms: Math.round(built.buildMs),
        });
      })
      .catch((err: unknown) => {
        // Stop reporting the failed version as "indexing" (clients would poll forever); its
        // hits stay marked stale until a later commit indexes successfully. A newer version
        // whose job is still pending keeps being reported.
        if (building !== undefined) failed.set(id, building);
        log.error("search.index_failed", {
          docId: id,
          version: building,
          reason: err instanceof Error ? err.name : "unknown",
        });
      })
      .finally(() => pending.delete(job));
    pending.add(job);
  };

  /** Resolves once no reindex is queued or running. */
  const idle = async (): Promise<void> => {
    while (pending.size > 0) await Promise.all(pending);
  };

  const off = store.onChange((e) =>
    e.kind === "commit" ? scheduleReindex(e.id) : indexNow(e.id, e.kind),
  );
  for (const { id } of store.list()) indexNow(id, "startup");

  /** Documents in `ids` whose index is behind the store, and the store's current versions. */
  const freshness = (ids: string[]) => {
    const current = new Map<string, number>();
    const indexing: SearchIndexing[] = [];
    for (const id of ids) {
      const entry = index.get(id);
      const version = store.get(id)?.version;
      if (!entry || version === undefined) continue;
      current.set(id, version);
      if (entry.version < version && failed.get(id) !== version) {
        indexing.push({
          docId: id,
          title: entry.title,
          indexedVersion: entry.version,
          currentVersion: version,
        });
      }
    }
    return { current, indexing };
  };

  /**
   * `added` is what the response reports: single words and multi-word synonyms ("hold
   * harmless"), normalized to lowercase words. A multi-word synonym scores through its words
   * like any other added term, but highlights only where the whole phrase occurs.
   */
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
      const normalized = res.added.map((a) =>
        tokenize(a, { keepStopwords: true })
          .map((t) => t.term)
          .join(" "),
      );
      const added = [...new Set(normalized)].filter((a) => {
        const words = tokenTerms(a);
        return words.length > 0 && !words.every((w) => known.has(w));
      });
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
    for (const t of added.flatMap((a) => tokenTerms(a))) {
      if (!weighted.has(t)) weighted.set(t, EXPANSION_TERM_WEIGHT);
    }
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

    const addedPhrases = added.filter((a) => a.includes(" "));
    const highlightTerms = new Set([...terms, ...added.filter((a) => !a.includes(" "))]);
    const synonymPhrases = addedPhrases.map((p) => ({ phrase: p, re: phraseRegExp(p) }));
    // Read after the (async) expansion, so staleness reflects the index the hits came from.
    const { current, indexing } = freshness(docIds ?? index.ids());
    const results = matches.slice(query.offset, query.offset + query.limit).map((s) => ({
      ...toHit(s, passageText(s), highlightTerms, phraseRes, synonymPhrases),
      stale: s.doc.version < (current.get(s.doc.id) ?? s.doc.version),
    }));

    log.info("search", {
      qLen: query.q.length,
      terms: terms.length,
      results: matches.length,
      expansion: expansion.status,
      added: added.length,
      indexing: indexing.length,
      ms: elapsedMs(t0),
    });
    return {
      query: query.q,
      terms,
      phrases,
      expansion,
      total: matches.length,
      results,
      documents: countByDocument(matches),
      indexing,
    };
  }

  return {
    index,
    search,
    idle,
    indexMode: indexer.mode,
    close: () => {
      off();
      indexer.close();
    },
  };
}

function toHit(
  s: ScoredPassage,
  snippet: string,
  highlightTerms: Set<string>,
  phraseRes: RegExp[],
  synonymPhrases: { phrase: string; re: RegExp }[],
): Omit<SearchHit, "stale"> {
  const p = s.doc.passages[s.passageId] ?? { start: 0, end: 0 };
  const spans: Span[] = [];
  const matched = new Set<string>();
  for (const tok of tokenize(snippet)) {
    if (!highlightTerms.has(tok.term)) continue;
    matched.add(tok.term);
    spans.push({ start: tok.start, end: tok.end });
  }
  const addSpans = (re: RegExp): boolean => {
    re.lastIndex = 0;
    let found = false;
    for (const m of snippet.matchAll(re)) {
      spans.push({ start: m.index, end: m.index + m[0].length });
      found = true;
    }
    return found;
  };
  for (const re of phraseRes) addSpans(re);
  const matchedPhrases = synonymPhrases.filter(({ re }) => addSpans(re)).map((x) => x.phrase);
  return {
    docId: s.doc.id,
    title: s.doc.title,
    docVersion: s.doc.version,
    start: p.start,
    end: p.end,
    snippet,
    highlights: mergeSpans(spans),
    matchedTerms: [...[...highlightTerms].filter((t) => matched.has(t)), ...matchedPhrases],
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
