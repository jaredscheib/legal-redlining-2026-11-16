# API

The HTTP API in full: every route with a curl sample and real output, the error catalogue, and the design rationale. Back to the [README](../README.md).

## API reference

JSON in and out. `samples/requests.sh [base-url]` exercises every route below.

**Request validation.** Validation is strict:

- Every body and query object rejects keys it does not know with `400 INVALID_PAYLOAD`, at
  every level, so a misspelled `occurence`, `expected_text` or `?dryrun=true` fails instead of
  being ignored. `error` names the first problem, e.g.
  `changes[0].target: unrecognized key "occurence"`.
- A `POST` or `PATCH` body must be sent as `Content-Type: application/json` (parameters such
  as `; charset=utf-8` are fine). Any other type, or a body with no `Content-Type` (curl's
  `-d` without `-H` sends form-urlencoded), is `415 UNSUPPORTED_MEDIA_TYPE`.
- Checks run in this order: `415` media type, `400` body (syntax, then schema), `400` query,
  `404` document, `412` `If-Match`, then the `422` checks against the text.

**Offsets.** Every `start` and `end` is a **UTF-16 code unit** index into the document text,
the same as a JavaScript string index, and ranges are half-open `[start, end)`:
`text.slice(start, end)` is the passage. Clients in other languages must convert (an emoji
counts as 2, an accented letter as 1 or 2 depending on normalization).

### `GET /healthz`

```json
{ "status": "ok", "version": "v0.1.0 (d1bb838)" }
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
{
  "id": "2e9c4074-1ec9-430a-9022-bc43c068e9d3",
  "title": "Sample Services Agreement",
  "text": "1. Fees. …",
  "version": 1
}
```

The seed contracts have readable ids, `commercial-lease`, `employment-agreement`,
`mutual-nda` and `saas-msa`, and the UI shows the open document's id in its header.

### `GET /documents/:id`

`{id, title, text, version}`. `404 DOCUMENT_NOT_FOUND` for an unknown id.

### `PATCH /documents/:id[?dryRun=true]`

Up to 50 changes per request (`MAX_CHANGES_PER_REQUEST`), applied all or nothing: every
change is resolved against the original text, overlaps are rejected, and if any change fails
nothing is stored. Each change targets either

- **text**: `target: {text, occurrence?}`. `occurrence` (1-based, default 1) picks among
  repeated matches, counted left to right without overlaps; exact and case-sensitive.
- **a range**: `range: {start, end, expectedText?}`, UTF-16 offsets, half-open. The new text
  is `replacement` in both forms, e.g.
  `{"operation":"replace","range":{"start":100,"end":108,"expectedText":"30 days"},"replacement":"15 days"}`. A wrong
  `expectedText` is refused (`422 EXPECTED_TEXT_MISMATCH`), which catches stale offsets.

With `dryRun=true` nothing is stored and `version` is unchanged; the redline has one hunk per
change (`changeIndex`). `GET` and `PATCH` responses carry `ETag: "v<version>"`. Send
`If-Match: "v<n>"` (or `*`, or a comma list of quoted tags) to refuse the write with
`412 VERSION_CONFLICT` if the document has moved on; without `If-Match` the write is
unconditional. The UI always sends it. Comparison is strong (RFC 9110 §13.1.1): a weak
`W/"v<n>"` never matches, and a value that is neither `*` nor quoted tags (`If-Match: v2`, or
empty) is also a 412, whose `error` says the header is malformed.

**Known issue on the live deploy ([#38](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/38)).** Vercel compresses responses, and
on a compressed response it rewrites the ETag to `W/"v<n>"`, so echoing that ETag in
`If-Match` gets a 412. Until that is fixed, send `If-Match: "v<n>"` built from the document's
`version`, as the UI does, or fetch with `accept-encoding: identity`.

```sh
curl -sS -X PATCH 'localhost:8787/documents/saas-msa?dryRun=true' -H 'content-type: application/json' \
  -d '{"changes":[{"operation":"replace","target":{"text":"thirty (30) days"},"replacement":"fifteen (15) days"}]}'
```

```json
{
  "id": "saas-msa",
  "version": 1,
  "dryRun": true,
  "text": "SaaS Master Services Agreement\n\nThis Master Services Agreement …",
  "redline": [
    {
      "changeIndex": 0,
      "start": 2007,
      "end": 2023,
      "before": "in each Order Form. Fees are invoiced annually in\nadvance and are due within ",
      "after": " of the invoice date.\n4.2 Overdue amounts accrue interest at the lesser of one",
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
curl -sS 'localhost:8787/search?q=confidential%20information&limit=1&expand=false'
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
      "score": 5.0988,
      "stale": false
    }
  ],
  "documents": [
    { "docId": "mutual-nda", "title": "Mutual Non-Disclosure Agreement", "passages": 15 },
    { "docId": "employment-agreement", "title": "Employment Agreement", "passages": 5 },
    { "docId": "saas-msa", "title": "SaaS Master Services Agreement", "passages": 4 },
    { "docId": "commercial-lease", "title": "Commercial Lease Agreement", "passages": 4 }
  ],
  "indexing": []
}
```

`snippet` is the whole passage, `text.slice(start, end)` of version `docVersion`.
`highlights` are offsets into the snippet. `matchedTerms` lists the query and expansion terms
found in the passage (words inside a quoted phrase are highlighted but not listed).
`expansion.status` is `applied` (with the `added` terms), `skipped` (with a `reason`) or `off`.
`documents` counts the matching passages per document, across all pages. `indexing` lists
documents whose latest edit is still being reindexed, and `stale: true` marks a hit from such
a document's previous version (see [Reindexing](search.md#how-it-works)).

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

Every 4xx response has the same shape. `code` repeats the HTTP status and `details.reason`
is the machine-readable reason. A 500 is `{"error": "Internal error", "code": 500}`, with no
`details`:

```json
{
  "error": "target text not found in the document",
  "code": 422,
  "details": { "reason": "TARGET_NOT_FOUND", "changeIndex": 0 }
}
```

| Status | `reason`                  | When                                                                                                                                                                                                                                                           |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_PAYLOAD`         | Malformed JSON (`error` is `request body is not valid JSON`) or a failed validation, including an unknown key: `error` names the first issue's path and problem, e.g. `instruction: must be at most 1000 characters`, and `details.issues` has every zod issue |
| 404    | `DOCUMENT_NOT_FOUND`      | Unknown document id, in the path or in `docId`                                                                                                                                                                                                                 |
| 404    | `ROUTE_NOT_FOUND`         | No such path                                                                                                                                                                                                                                                   |
| 405    | `METHOD_NOT_ALLOWED`      | A known path with an unsupported method, e.g. `DELETE /documents/:id`; the `Allow` header and `details.allowed` list the methods                                                                                                                               |
| 422    | `TARGET_NOT_FOUND`        | `target.text` does not occur in the document (`details.changeIndex`)                                                                                                                                                                                           |
| 422    | `OCCURRENCE_OUT_OF_RANGE` | Fewer occurrences than requested (`details.found`)                                                                                                                                                                                                             |
| 412    | `VERSION_CONFLICT`        | `If-Match` does not strongly match the current version, or is malformed (`details.currentVersion`)                                                                                                                                                             |
| 415    | `UNSUPPORTED_MEDIA_TYPE`  | A `POST` or `PATCH` body that is not `Content-Type: application/json`, or has no `Content-Type`                                                                                                                                                                |
| 422    | `OVERLAPPING_CHANGES`     | Two changes overlap or start at the same offset (`details.changeIndexes` and `details.ranges` of both)                                                                                                                                                         |
| 422    | `RANGE_OUT_OF_BOUNDS`     | A `range` change outside the document (`details.changeIndex`), or a suggestion range past its end (`details.length`)                                                                                                                                           |
| 422    | `SPLITS_CHARACTER`        | A change would start or end between the two halves of a UTF-16 surrogate pair, e.g. inside an emoji (`details.changeIndex`)                                                                                                                                    |
| 422    | `EXPECTED_TEXT_MISMATCH`  | A `range` change whose `expectedText` differs (`details.changeIndex`)                                                                                                                                                                                          |
| 502    | `LLM_ERROR`               | The model answered with unusable output                                                                                                                                                                                                                        |
| 503    | `LLM_UNAVAILABLE`         | No API key, no recording in replay mode, timeout or API error                                                                                                                                                                                                  |
| 500    | none                      | Unexpected; the body is generic and the `x-request-id` header matches the `http.unhandled` log line                                                                                                                                                            |

## API design rationale

- **Resource-oriented REST.** `/documents` is the collection and `/documents/{id}` a
  document; suggestions are a sub-resource. URLs name things, methods say what happens.
- **Search is its own resource.** `GET /search?q=` spans every document, and `docId` (repeatable)
  narrows it to one or several, so one route and one response shape cover all three cases.
  Nested routes (`/documents/{id}/search`) would need a second route for cross-document
  search, and an action endpoint (`POST /search`) would make a read look like a write.
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
