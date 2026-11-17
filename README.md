# Redline

A redlining service for lawyers. Search across contracts, pick a passage, write a replacement
or ask Claude to suggest one, preview the change as an inline redline, apply it, and find the
new wording by searching again.

It is a TypeScript HTTP API (Hono on Node 22) with an in-memory document store and a BM25
passage index, plus a React UI. Four synthetic contracts are loaded at startup.

**Assumptions.** Documents are plain text (UTF-8 in, JavaScript strings in memory). PDF and
.docx are not supported: they would need an import step that extracts text and keeps a map
from text offsets back to the source (and, for .docx, writes redlines back as tracked
changes). One user, one process; state lives in memory.

## Using the UI

Start everything with `make dev`, then open <http://localhost:5173>.

0. **Start.** The home page lists every contract; open one directly, or search.
1. **Search.** Type what you are looking for, for example `limitation of liability` or a
   quoted phrase such as `"late charge"`. Results are ranked passages from every contract,
   with the matched words highlighted, a "X passages across Y documents" summary, and, when
   **Synonyms** is on, an "Also searching: …" line of the Claude synonyms being used. Plain
   results appear at once; synonym matches merge in a moment later. Clearing the box returns
   to the home page.
2. **Open a result.** The contract opens beside the results with that passage selected. You
   can also pick a contract from the list or menu and select any text yourself (mouse or
   keyboard). The header shows the document's version; **Close document** closes it.
3. **Write the change.** The edit panel shows the selected text. Type the replacement.
4. **Or ask Claude.** Press **Suggest**, optionally with an instruction such as
   "shorten the notice period to fifteen days". The suggestion fills the replacement box with
   a one-line rationale; edit it as you like.
5. **Preview.** Press **Preview** to see the word-level redline: deletions struck through,
   insertions underlined. Nothing is saved yet.
6. **Apply.** Press **Apply**. The page confirms "Applied 1 change. Now version N.", and the
   search runs again so the results match the new text. If someone else changed the document
   since you opened it, the save is refused and you are offered a reload.

## Setup

- Node 22 (see `.nvmrc`). Then `make setup` (runs `npm ci`) and `make hooks` (installs the
  pre-commit hook).
- `ANTHROPIC_API_KEY` (`sk-ant-...`) as a plain environment variable; see `.env.example`.
- On macOS you can keep the key in the keychain instead:
  `security add-generic-password -s legal-redlining-2026-11-16 -a ANTHROPIC_API_KEY -w`.
  `scripts/with-keychain KEY... -- cmd` exports those keys without printing them and runs
  `cmd`; `make dev` and `make evals` use it. A key already in the environment wins.
- **No key?** Everything except the Claude features works: search runs unexpanded (the
  response says why), and suggestions return `503 LLM_UNAVAILABLE`.

To run the built API without `make dev`:

```sh
npm run build -w api
PORT=8787 LLM_MODE=replay npm run start -w api
samples/requests.sh http://localhost:8787    # one sample request per endpoint
```

| Variable             | Default                 | Meaning                                                                          |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `PORT`               | `8787`                  | API port (binds 127.0.0.1)                                                       |
| `ANTHROPIC_API_KEY`  | unset                   | Enables live Claude calls                                                        |
| `LLM_MODE`           | `record`                | `record`, `replay` or `live`; see below                                          |
| `LLM_MAX_LIVE_CALLS` | `200`                   | Live (billed) Claude calls per process; past it they are refused (`cap_reached`) |
| `DATA_DIR`           | `data/`                 | Logs, pids and evals output                                                      |
| `LLM_LEDGER_PATH`    | `data/llm-ledger.jsonl` | Spend ledger; the Makefile points it at the main checkout                        |
| `LOG_STDOUT`         | on                      | `off` silences log lines on stdout                                               |
| `LOG_FILE`           | on                      | `off` stops writing `data/app.log`                                               |

## Make targets

| Target                             | What it does                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `check`                            | Prettier check, ESLint, `tsc --noEmit` (strict), vitest on both workspaces          |
| `lint` `format` `typecheck` `test` | The pieces of `check`                                                               |
| `test-fast`                        | Tests without the `*.large.test.ts` files (the pre-commit hook runs this)           |
| `build`                            | Compile the API to `api/dist/`                                                      |
| `smoke`                            | Build, start the API on a free port, check health, documents and the main edit flow |
| `evals`                            | Run `scenarios/` through the app; table + `data/evals/<timestamp>.json`             |
| `spend`                            | Recorded LLM spend: live calls, tokens and cost from the ledger, plus replays       |
| `bench`                            | Search on a 10 MB+ contract: index build ms, median query ms, heap used             |
| `dev` / `dev-stop`                 | API on :8787 and Vite on :5173 in the background (pids and logs in `data/`)         |
| `hooks`                            | Use `.githooks/` (pre-commit: format check, lint, fast tests)                       |
| `tag V=x.y.z`                      | Annotated tag `vx.y.z` (not pushed)                                                 |

## API reference

JSON in and out. `samples/requests.sh [base-url]` exercises every route below.

**Offsets.** Every `start` and `end` is a **UTF-16 code unit** index into the document text,
the same as a JavaScript string index, and ranges are half-open `[start, end)`:
`text.slice(start, end)` is the passage. Clients in other languages must convert (an emoji
counts as 2, an accented letter as 1 or 2 depending on normalization).

### `GET /healthz`

```json
{ "status": "ok", "version": "ced3a03" }
```

### `GET /documents`

Summaries only, no text.

```json
{
  "documents": [
    {
      "id": "commercial-lease",
      "title": "Commercial Lease Agreement",
      "version": 1,
      "length": 5456
    }
  ]
}
```

### `POST /documents`

Body `{title, text}`: `title` 1 to 500 characters after trimming, `text` non-empty. Returns
`201` with the new document at version 1.

```sh
curl -sS -X POST localhost:8787/documents -H 'content-type: application/json' \
  -d '{"title":"Sample Services Agreement","text":"1. Fees. Client shall pay all invoices within thirty (30) days of receipt."}'
```

```json
{ "id": "e7f4d661-…", "title": "Sample Services Agreement", "text": "1. Fees. …", "version": 1 }
```

### `GET /documents/:id`

`{id, title, text, version}`. `404 DOCUMENT_NOT_FOUND` for an unknown id.

### `PATCH /documents/:id[?dryRun=true]`

Up to 50 changes per request (`MAX_CHANGES_PER_REQUEST`), applied all or nothing: every
change is resolved against the original text, overlaps are rejected, and if any change fails
nothing is stored. Each change targets either

- **text**: `target: {text, occurrence?}`. `occurrence` (1-based, default 1) picks among
  repeated matches, counted left to right without overlaps; exact and case-sensitive.
- **a range**: `range: {start, end, expectedText?}`, UTF-16 offsets, half-open. A wrong
  `expectedText` is refused (`422 EXPECTED_TEXT_MISMATCH`), which catches stale offsets.

With `dryRun=true` nothing is stored and `version` is unchanged; the redline has one hunk per
change (`changeIndex`). `GET` and `PATCH` responses carry `ETag: "v<version>"`. Send
`If-Match: "v<n>"` (or `*`, or a comma list of quoted tags) to refuse the write with
`412 VERSION_CONFLICT` if the document has moved on; without `If-Match` the write is
unconditional. The UI always sends it. Comparison is strong (RFC 9110 §13.1.1): a weak
`W/"v<n>"` never matches, and a value that is neither `*` nor quoted tags (`If-Match: v2`, or
empty) is also a 412, whose `error` says the header is malformed.

```sh
curl -sS -X PATCH 'localhost:8787/documents/e7f4d661-…?dryRun=true' -H 'content-type: application/json' \
  -d '{"changes":[{"operation":"replace","target":{"text":"thirty (30) days"},"replacement":"fifteen (15) days"}]}'
```

```json
{
  "id": "e7f4d661-…",
  "version": 1,
  "dryRun": true,
  "text": "1. Fees. Client shall pay all invoices within fifteen (15) days of receipt. …",
  "redline": [
    {
      "changeIndex": 0,
      "start": 46,
      "end": 62,
      "before": "1. Fees. Client shall pay all invoices within ",
      "after": " of receipt. …",
      "segments": [
        { "type": "delete", "text": "thirty" },
        { "type": "insert", "text": "fifteen" },
        { "type": "equal", "text": " (" },
        { "type": "delete", "text": "30" },
        { "type": "insert", "text": "15" },
        { "type": "equal", "text": ") days" }
      ]
    }
  ]
}
```

Without `dryRun` the same body commits the change and returns `"version": 2, "dryRun": false`.
`start`/`end` of a hunk are offsets in the text before the change; `before` and `after` are
up to 80 characters of unchanged context, trimmed to whole words.

### `GET /search`

| Parameter | Default | Meaning                                                     |
| --------- | ------- | ----------------------------------------------------------- |
| `q`       |         | 1 to 500 characters; `"double quotes"` mark an exact phrase |
| `docId`   | all     | Restrict to a document; repeat for several. Unknown id: 404 |
| `limit`   | 10      | 1 to 100                                                    |
| `offset`  | 0       | For paging; `total` is always the full match count          |
| `expand`  | `true`  | `false` never asks Claude for synonyms                      |

```sh
curl -sS 'localhost:8787/search?q=confidential%20information&limit=3'
```

```json
{
  "query": "confidential information",
  "terms": ["confidential", "information"],
  "phrases": [],
  "expansion": { "status": "off", "added": [] },
  "total": 28,
  "results": [
    {
      "docId": "mutual-nda",
      "title": "Mutual Non-Disclosure Agreement",
      "docVersion": 1,
      "start": 3567,
      "end": 3650,
      "snippet": "6.2 ALL CONFIDENTIAL INFORMATION IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.",
      "highlights": [
        { "start": 8, "end": 20 },
        { "start": 21, "end": 32 }
      ],
      "matchedTerms": ["confidential", "information"],
      "score": 5.1223
    }
  ]
}
```

`snippet` is the whole passage, `text.slice(start, end)` of version `docVersion`.
`highlights` are offsets into the snippet. `matchedTerms` lists the query and expansion terms
found in the passage (words inside a quoted phrase are highlighted but not listed).
`expansion.status` is `applied` (with the `added` terms), `skipped` (with a `reason`) or `off`.

### `POST /documents/:id/suggestions`

Body `{range: {start, end}, instruction?}`. The range must be non-empty and at most 400
characters (`400 INVALID_PAYLOAD` otherwise) and inside the document
(`422 RANGE_OUT_OF_BOUNDS` otherwise, as for `PATCH`); `instruction` is
optional, up to 1000 characters. Returns a proposal and never changes the document; apply it
with `PATCH`.

```json
{
  "replacement": "Client shall pay all invoices within fifteen (15) days of receipt.",
  "rationale": "…",
  "model": "claude-sonnet-5-5"
}
```

### Errors

Every non-2xx response has the same shape. `code` repeats the HTTP status and
`details.reason` is the machine-readable reason:

```json
{
  "error": "target text not found in the document",
  "code": 422,
  "details": { "reason": "TARGET_NOT_FOUND", "changeIndex": 0 }
}
```

| Status | `reason`                  | When                                                                                                                                                                                                                                 |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `INVALID_PAYLOAD`         | Malformed JSON (`error` is `request body is not valid JSON`) or a failed validation: `error` names the first issue's path and problem, e.g. `instruction: must be at most 1000 characters`, and `details.issues` has every zod issue |
| 404    | `DOCUMENT_NOT_FOUND`      | Unknown document id, in the path or in `docId`                                                                                                                                                                                       |
| 404    | `ROUTE_NOT_FOUND`         | No such path                                                                                                                                                                                                                         |
| 405    | `METHOD_NOT_ALLOWED`      | A known path with an unsupported method, e.g. `DELETE /documents/:id`; the `Allow` header and `details.allowed` list the methods                                                                                                     |
| 422    | `TARGET_NOT_FOUND`        | `target.text` does not occur in the document (`details.changeIndex`)                                                                                                                                                                 |
| 422    | `OCCURRENCE_OUT_OF_RANGE` | Fewer occurrences than requested (`details.found`)                                                                                                                                                                                   |
| 412    | `VERSION_CONFLICT`        | `If-Match` does not strongly match the current version, or is malformed (`details.currentVersion`)                                                                                                                                   |
| 422    | `OVERLAPPING_CHANGES`     | Two changes overlap or start at the same offset (`details.changeIndexes` and `details.ranges` of both)                                                                                                                               |
| 422    | `RANGE_OUT_OF_BOUNDS`     | A `range` change outside the document (`details.changeIndex`), or a suggestion range past its end (`details.length`)                                                                                                                 |
| 422    | `SPLITS_CHARACTER`        | A change would start or end between the two halves of a UTF-16 surrogate pair, e.g. inside an emoji (`details.changeIndex`)                                                                                                          |
| 422    | `EXPECTED_TEXT_MISMATCH`  | A `range` change whose `expectedText` differs (`details.changeIndex`)                                                                                                                                                                |
| 502    | `LLM_ERROR`               | The model answered with unusable output                                                                                                                                                                                              |
| 503    | `LLM_UNAVAILABLE`         | No API key, no recording in replay mode, timeout or API error                                                                                                                                                                        |
| 500    | none                      | Unexpected; the body is generic and the `x-request-id` header matches the `http.unhandled` log line                                                                                                                                  |

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
   (`SEARCH_INDEX_WORKER`, falls back to in-process) and swapped in (about 30 ms at 10 MB);
   repeated edits coalesce and a late result never replaces a newer one. **Search never
   waits:** responses list `indexing: [{docId, title, indexedVersion, currentVersion}]` for
   documents still being rebuilt and mark each hit `stale`, and the UI shows "Updating …"
   and re-queries every 500 ms until the index is current. Measured on 10 MB: a search
   during a reindex answers in about 24 ms. Next: incremental reindexing of only the changed
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

## API design rationale

- **Resource-oriented REST.** `/documents` is the collection and `/documents/{id}` a
  document; suggestions are a sub-resource. URLs name things, methods say what happens.
- **Reads and writes are separate.** GET never changes state; POST creates; PATCH modifies.
  Caching, retries and logs can rely on that.
- **PATCH carries change operations, not the whole text.**
  - Small payloads: a one-word fix on a 10 MB contract sends a few bytes.
  - Intent is kept: "replace X with Y" is exactly what the redline shows.
  - Conflicts are detectable: each change names the text it expects to replace, so a mismatch
    fails with 422 instead of silently overwriting someone else's edit.
- **Targeting by text and occurrence.** That is what a person or a model actually knows ("the
  second 'thirty days'"). The engine resolves every change against the original text before
  applying any, so changes never shift each other's offsets. The UI knows the exact selection,
  so it sends ranges with `expectedText` instead; a stale selection fails with 422.
- **Preview is `PATCH ?dryRun=true`.** The preview runs the same resolve, validate and apply
  path as the real write and only skips the commit, so what you preview is what you apply. The
  trade-off against a separate preview resource (say `POST /documents/{id}/previews`): a flag
  on a mutating method is less obviously safe when reading logs, and a dedicated resource
  could be cached or shared. One code path was judged worth more.
- **Suggestions are `POST /documents/{id}/suggestions`.** It creates a proposal, not a change:
  it returns text and a rationale and never writes. The client applies it through the normal
  PATCH, so every write goes through one path.
- **One error shape** everywhere: `{error, code, details}` with a stable `reason`, plus the
  failing `changeIndex` where it applies.
- **History is recorded but not yet exposed.** The store keeps every commit's operations;
  a `GET /documents/{id}/changes` route would publish it.

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

| Measure                                    | Result         | Source                              |
| ------------------------------------------ | -------------- | ----------------------------------- |
| Index build                                | 1,029–1,334 ms | `make bench`                        |
| Search, median of 20 queries               | 3.9–5.1 ms     | `make bench`                        |
| Heap used after build and queries          | 151–204 MB     | `make bench`                        |
| `POST`, `GET` and list of a 10 MB document | 366–415 ms     | `api/test/large-file.large.test.ts` |
| `PATCH` near the end of a 10 MB document   | 109–144 ms     | `api/test/large-file.large.test.ts` |
| Index build, in the test                   | 1,302–1,715 ms | `api/test/search.large.test.ts`     |
| Single queries, in the test                | 1.7–23.9 ms    | `api/test/search.large.test.ts`     |

The first query after a build is the slowest (cold caches); later ones take a few
milliseconds. The large tests assert generous ceilings (4 s build, 200 ms per query, 1.5 s
per PATCH) as tripwires for accidental quadratic work, not as benchmarks.

**Known limits.**

- All state is in memory. A restart reloads the seed contracts and loses edits.
- One process, no shared state, so it cannot be scaled out as is.
- The whole document is sent on `GET` and returned by `PATCH`; very large documents would
  want range reads and a response without the full text.

## LLM usage and cost control

- **Models.** Query expansion uses `claude-haiku-5-5`: short, cheap and on the
  search latency path. Suggestions use `claude-sonnet-5-5` for drafting quality. Both are set
  in `api/src/config.ts` together with the timeouts (2.5 s for expansion, 20 s for a
  suggestion) and the token prices used for the ledger.
- **One path to the model.** Every call goes through `createLlmClient().call()` in
  `api/src/llm/client.ts`, with zod-typed structured output and no SDK retries, so one call is
  one billed request.
- **Record and replay.** `LLM_MODE` picks the behaviour:

  | Mode     | Behaviour                                            | Used for              |
  | -------- | ---------------------------------------------------- | --------------------- |
  | `record` | Replay a recording if one exists, else call and save | Development (default) |
  | `replay` | Recordings only; a miss fails with `no_recording`    | Tests, CI, smoke      |
  | `live`   | Always call; save nothing                            | Checking fresh output |

  Recordings are `api/fixtures/llm/<sha256>.json`, keyed on the model, system prompt,
  messages, output schema, `maxTokens` and effort, so any prompt change is a new recording.
  They contain only synthetic contract text. Commit them so others replay instead of paying.

- **Spend ledger.** Every live call appends its model, token counts and cost to
  `llm-ledger.jsonl`. The Makefile points `LLM_LEDGER_PATH` at the main checkout's `data/`, so
  every git worktree adds to one ledger. A call is billed before its output is parsed, because
  the tokens are spent either way.
- **`make spend`** totals the ledger (cost, live calls, tokens, by operation) and counts
  replays from `data/app.log`.
- **Budget.** The project's spending limit is enforced on the Claude platform, which is the
  hard backstop; `make spend` is the running local record against it.
- **Prompt caching** is not used: the prompts are below the minimum cacheable length.
- **Measured** (live, effort low): expansion on Haiku p50 1.6 s (max 2.8 s, about $0.0001
  per call) versus Sonnet p50 2.1 s at about 20× the cost, with comparable synonyms
  (`make compare-expansion`). Suggestions on Sonnet keep defined terms (2/2) and clause
  numbers (3/3) in the eval flows, and all 3 end-to-end flows pass.
- **When the model is unavailable** (no key, timeout, API error, refusal): search runs
  unexpanded and says why; suggestions return `503 LLM_UNAVAILABLE` (`502 LLM_ERROR` for
  unusable output), and the UI asks the user to write the change themselves.

## Observability

Logs are JSON lines on stdout and appended to `data/app.log`: `ts`, `level`, `event`, then
fields. They carry ids, counts and timings only, never document, passage or query text.

| Event             | Fields                                                                          |
| ----------------- | ------------------------------------------------------------------------------- |
| `server.start`    | `version`, `port`, `docs` (seeded), `llmMode`                                   |
| `server.stop`     | `signal`                                                                        |
| `document.create` | `docId`, `length`                                                               |
| `doc.patched`     | `docId`, `version`, `changes`, `dryRun`, `ms`                                   |
| `search.index`    | `docId`, `version`, `reason` (`startup`, `create`, `commit`), `passages`, `ms`  |
| `search`          | `qLen`, `terms`, `results`, `expansion` (status), `ms`                          |
| `llm.call`        | `op`, `model`, `inputTokens`, `outputTokens`, `ms`, `replayed`, `status`, `key` |
| `http.unhandled`  | `requestId` (also the `x-request-id` header), `method`, `route`, `errorName`    |

For example, `grep '"event":"llm.call"' data/app.log` shows every model call and whether it
was replayed. `make dev` also writes `data/api.log` and `data/web.log`.

## Testing and evals

- **`make check`** is the gate: Prettier, ESLint with zero warnings, strict `tsc`, and vitest
  in both workspaces. Routes are tested in process through `createApp(deps).request()`;
  model calls use fakes or `LLM_MODE=replay`, never the network.
- **Large-file tests** (`api/test/*.large.test.ts`) build a 10 MB+ contract and check it
  round-trips byte for byte, that a PATCH near the end applies, and that search indexes,
  queries and reindexes it. The pre-commit hook skips them (`make test-fast`).
- **`make smoke`** builds the API, starts it on a free port with no API key in replay mode,
  and runs the main flow over HTTP: search for a clause, dry-run a PATCH of that passage
  (redline has delete and insert segments, document unchanged), apply it (version 2), and
  search for the new wording.
- **`make evals`** runs `scenarios/` through the same app the server builds: 10 labelled
  search queries (hit in top 3, flagged when they need expansion) and 3 full flows (search,
  pick, suggest, check the suggestion, dry run, redline, apply, verify, search again). Results
  are printed as a table and saved to `data/evals/<timestamp>.json`. It is a measurement, not
  a gate. It defaults to `LLM_MODE=record`, which can make billed calls; use
  `LLM_MODE=replay make evals` to stay on recordings.
- **CI** (`.github/workflows/ci.yml`) runs `make check` in replay mode and is started by hand.
- **`make coverage`** runs both workspaces' full suites (replay mode, large tests included)
  with v8 coverage over `src/` (tests excluded), prints a summary per workspace, and writes
  HTML and `coverage-summary.json` to `api/coverage/` and `web/coverage/` (git-ignored). It is
  a measurement; no threshold gates `make check`. Measured at `c92de29`:

  | Workspace | Lines  | Branches | Functions |
  | --------- | ------ | -------- | --------- |
  | `api`     | 91.41% | 76.54%   | 93.18%    |
  | `web`     | 95.27% | 84.45%   | 95.09%    |

## Deploy (Vercel)

`make vercel-build` writes `.vercel/output/` (Build Output API v3): the web app as static
files and the API bundled into one Node 22 function with the seed contracts and recordings.
`make vercel-verify` serves that function locally on :8794 in replay mode and checks it. Then
`vercel deploy --prebuilt --prod`. Set these in the Vercel project:

- `ANTHROPIC_API_KEY`
- `LLM_MODE=record`: replay a recording first, call the API on a miss (nothing is saved)
- `LLM_MAX_LIVE_CALLS` (default 200): live calls per instance before suggestions return 503

Documents live in memory per instance and reset on a cold start. Vercel rejects request
bodies over 4.5 MB.

## Project layout

```
api/src/
  app.ts            createApp(deps): routes, error handling
  server.ts         Node entry point
  runtime.ts        Production dependency graph, shared by the server and the evals
  config.ts         Every tunable and environment variable
  routes/           documents, search, suggestions (registrars over AppDeps)
  changes/          resolve targets, apply ops, word-level redline
  search/           passages, tokenizer, query parser, BM25 index, search service
  store/            In-memory document store and seed loader
  llm/              Claude client, record/replay, spend ledger
  evals/            Scenario runner
  domain/types.ts   Shared types
api/seed/           Four synthetic contracts (NDA, SaaS MSA, lease, employment)
api/fixtures/llm/   LLM recordings
api/scripts/        evals, spend and bench entry points
api/test/           Large-file (10 MB+) tests
scenarios/          Labelled search queries and end-to-end flows
samples/            requests.sh: a curl sample for every endpoint
scripts/            smoke, dev, with-keychain
web/                React 18 + Vite UI
data/               Logs, pids, ledger, evals output (git-ignored)
```

## What's next

- **Reindexing**: stream late results with server-sent events instead of polling; rebuild
  only the changed passages.
- **Collaboration policy per firm**: today writes are optimistic (`If-Match` optional); auto-
  rebase on conflict, required `If-Match`, or check-out locks are a per-firm choice.
- **Ranking**: fold heading passages into their clauses; tune the synonym weight.
- **Version history**: list versions and view any past version read-only.
- **Document import** for PDF and .docx.
- **Embeddings** for concept queries, when measured misses justify the extra infrastructure.
