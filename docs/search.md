# Search and performance

How search works and why, its known limits, and measured performance on 10 MB+ contracts. Back to the [README](../README.md).

## Search

### Options considered

| Option                        | Catches                                    | Latency                            | Cost                                  | Complexity                                   | Failure modes                                                                   |
| ----------------------------- | ------------------------------------------ | ---------------------------------- | ------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| Exact / substring match       | Literal wording only                       | Linear scan; fine when small       | None                                  | Trivial                                      | Misses synonyms and reordered words; no ranking                                 |
| BM25 over passages            | Shared terms, ranked by rarity and density | Milliseconds                       | None                                  | About 500 lines                              | Misses synonyms ("terminate" vs "cancel"); no stemming                          |
| BM25 + Claude query expansion | Above, plus synonyms of unquoted terms     | One short LLM call (2.5 s timeout) | One short call per query              | Small: one prompt, one fallback path         | Off-target synonyms add noise; LLM latency or outage (falls back to plain BM25) |
| BM25 + LLM rerank             | Better ordering of the top N               | One larger LLM call per query      | Grows with N × passage size           | Moderate                                     | Cannot recover passages BM25 missed; slow; costly at volume                     |
| Hybrid BM25 + embeddings      | Paraphrase and concept matches             | Fast at query time once indexed    | Embed every passage, re-embed on edit | High: vector store, chunk sync, score fusion | Opaque "near" matches; stale vectors after edits; extra infrastructure          |

**Why BM25 plus expansion.** Lawyers mostly search with the vocabulary of the contract. BM25
handles that with exact offsets and no infrastructure. Expansion covers the common synonym gap
for the price of one short call, and quoted phrases stay exact so precise searches are never
diluted. When the model is unavailable, search keeps working.

**What would trigger embeddings.** Measured misses on concept queries ("who bears the risk if
the vendor goes bankrupt") that expansion does not fix; a corpus large enough that per-query
LLM calls dominate cost; or a need for cross-document similarity ("find clauses like this").

### How it works

Code in `api/src/search/`.

1. **Passages.** Each document is split at sentence or clause ends (`.`, `;` or `:` followed
   by whitespace) and at blank lines. A passage over 400 characters is cut again at the last
   whitespace that fits. Every passage keeps its `start` and `end` offsets into the document.
2. **Tokenizing.** Lowercased runs of Unicode letters and digits, a short English stopword
   list (legal words such as "not", "shall" and "any" are kept), no stemming.
3. **Inverted index.** Per document, a postings list of `(passageId, termFrequency)` for each
   term, plus passage lengths; corpus statistics (passage count, average length, document
   frequency) span every document.
4. **Ranking.** BM25 with k1 = 1.2 and b = 0.75, over passages, corpus-wide. Ties sort by
   document id, then position.
5. **Quoted phrases.** A quoted part of the query is an exact phrase: case-insensitive, on
   whole-word boundaries, and any run of whitespace in the text matches the space in the
   phrase, so hard line wraps do not break it. A passage must contain every phrase, and the
   phrase words also contribute to its score. Phrases are never expanded.
6. **Expansion.** Unquoted terms go to Claude (`claude-haiku-5-5`, thinking off, 2.5 s
   timeout) for up to 3 contract-language alternatives per term or phrase (9 in total),
   cached per term list; added terms score at weight 0.5 (`EXPANSION_TERM_WEIGHT`). The response
   lists the added terms, or `skipped` with a reason such as `no_api_key`, `timeout` or
   `no_terms`. `expand=false` turns it off. When no expander is configured the status is
   `off`.
7. **Highlights.** Matching tokens and phrase matches inside the snippet, as merged
   `{start, end}` ranges relative to the snippet.
8. **Reindexing.** Documents are indexed as per-document segments. A created document is
   indexed at once. An edited document is rebuilt in a `worker_threads` worker
   (`SEARCH_INDEX_WORKER`, falls back to in-process); the rebuild takes about a second at
   10 MB, off the request path, and the swap about 20–30 ms;
   repeated edits coalesce and a late result never replaces a newer one. **Search never
   waits:** responses list `indexing: [{docId, title, indexedVersion, currentVersion}]` for
   documents still being rebuilt and mark each hit `stale`, and the UI shows "Updating …"
   and re-queries every 500 ms until the index is current. Measured on 10 MB: a search
   during a reindex answers in under 25 ms. Next: incremental reindexing of only the changed
   passages, and streaming late results with server-sent events.

**Complexity.** Building the index is O(n) in document size: one pass to split, one to
tokenize. A query costs time proportional to the total length of the postings lists of its
terms (including expansion terms), plus sorting the matched passages; phrase checks run only
on passages that already matched a term.

### Known limits

- A phrase cannot span a sentence or passage boundary: `"days. Tenant"` matches nothing,
  because each passage is checked on its own.
- A phrase made only of stopwords (`"of the"`) matches nothing: it adds no scoring terms, so
  no passage is a candidate.
- No stemming: `terminate` does not find `termination`.
- **Ranking, measured** (`make evals`, 10 labelled queries): the expected passage is in the
  top 3 for 5 of 10 queries without expansion, and 5 of 10 with it (1 of the 4 synonym-only
  queries). The synonyms are good (terminate → cancel, rescind; indemnify → hold harmless);
  the misses are ranking: one-line headings ("Security Deposit.") outrank their clauses, and
  synonym matches at half weight rarely beat direct matches. Folding headings into the
  clause that follows and tuning the expansion weight are the next experiments.

## Performance

- **Applying changes.** Targets are resolved against the original text, the resulting ranges
  are sorted and checked for overlap, and the new text is built in one pass as an array of
  slices joined once: O(n + k log k) for document length n and k changes.
- **Redline.** Each change is diffed word by word within its own span only, plus up to 80
  characters of context. The whole document is never diffed.
- **Search index memory** grows roughly linearly with text size: per passage, its offsets and
  length, and one postings entry per distinct term.

**Measured** on a generated 10 MB contract (seed clauses repeated; 118,563 passages), Node
24.22 on a 2.0 GHz quad-core Intel Core i5 laptop. Each figure is the range over several runs on a busy development machine.

| Measure                                    | Result       | Source                              |
| ------------------------------------------ | ------------ | ----------------------------------- |
| Index build                                | 821–1,334 ms | `make bench`                        |
| Search, median of 20 queries               | 2.8–5.1 ms   | `make bench`                        |
| Heap used after build and queries          | 78–204 MB    | `make bench`                        |
| `POST`, `GET` and list of a 10 MB document | 366–415 ms   | `api/test/large-file.large.test.ts` |
| `PATCH` near the end of a 10 MB document   | 109–144 ms   | `api/test/large-file.large.test.ts` |
| Index build, in the test                   | 538–1,715 ms | `api/test/search.large.test.ts`     |
| Single queries, in the test                | 0.9–23.9 ms  | `api/test/search.large.test.ts`     |

Heap used varies with garbage collection, and the postings live in typed arrays that it
counts only in part, so treat it as a rough figure. The first query after a build is the slowest (cold caches); later ones take a few
milliseconds. The large tests assert generous ceilings (4 s build, 200 ms per query, 1.5 s
per PATCH) as tripwires for accidental quadratic work, not as benchmarks.

**Known limits.**

- All state is in memory. A restart reloads the seed contracts and loses edits.
- One process, no shared state, so it cannot be scaled out as is.
- The whole document is sent on `GET` and returned by `PATCH`; very large documents would
  want range reads and a response without the full text.
