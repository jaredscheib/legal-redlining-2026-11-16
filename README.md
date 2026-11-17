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

**Live:** <https://legal-redlining-2026-11-16.vercel.app>. The page footer and `GET /healthz` show the release and commit it runs.

## Where things are

| Topic                                                                             | Where                                                                             |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| API reference, errors, design rationale                                           | [docs/api.md](docs/api.md)                                                        |
| Search design, its limits, and measured performance on 10 MB+                     | [docs/search.md](docs/search.md)                                                  |
| Configuration, make targets, model cost control, logs, tests and coverage, deploy | [docs/operations.md](docs/operations.md)                                          |
| Decisions with the alternatives weighed, how AI was used, what comes next         | [docs/decisions.md](docs/decisions.md)                                            |
| Proposed production infrastructure: tiers, architecture, trade-offs (one page)    | [docs/infrastructure.md](docs/infrastructure.md) ([PDF](docs/infrastructure.pdf)) |
| The plan and decision log; code reviews and what was done about each finding      | issue [#16](../../issues/16); pull request [#19](../../pull/19)                   |
| Roadmap                                                                           | issues labelled [`Later`](../../issues?q=label%3ALater)                           |

## Architecture at a glance

| Decision                                                                                                                                | Where                               |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| A REST API over plain JSON, with each route a small registrar over injected dependencies (`createApp(deps)`)                            | `api/src/app.ts`, `api/src/routes/` |
| Edits are change operations resolved against the original text, applied in one pass, and returned as a word-level redline               | `api/src/changes/`                  |
| A document is its current text, a version and a log of the operations that produced it                                                  | `api/src/store/`                    |
| Search is an in-memory BM25 passage index, rebuilt in a worker thread after an edit while search keeps answering                        | `api/src/search/`                   |
| Claude sits behind one client with record/replay, a spend ledger and a live-call cap: Haiku expands search terms, Sonnet suggests edits | `api/src/llm/`                      |
| Every tunable and environment variable has one home                                                                                     | `api/src/config.ts`                 |
| One small React page for the lawyer's flow, with typed calls to the API                                                                 | `web/src/`                          |

```
api/src/
  app.ts, server.ts      createApp(deps) and the Node entry point
  runtime.ts             the production dependency graph, shared by the server, evals and Vercel
  config.ts              every tunable and environment variable
  routes/                documents, search, suggestions; ETag and If-Match
  changes/               resolve targets, apply operations, word-level redline
  search/                passages, tokenizer, query parser, BM25 index, index worker, search service
  store/                 in-memory document store and seed loader
  llm/                   Claude client, expansion, suggestions, record/replay, spend ledger
  vercel/                the serverless function's entry point
  evals/                 scenario runner
  domain/types.ts        shared types
api/seed/                four synthetic contracts (NDA, SaaS MSA, lease, employment)
api/fixtures/llm/        recorded model responses
api/scripts/             evals, spend, bench and model-comparison entry points
api/test/                large-file (10 MB+) tests and test helpers
web/src/                 App, components (search, results, document, edit panel, redline), API client
scenarios/               labelled search queries and end-to-end flows for make evals
samples/requests.sh      a curl sample for every endpoint
scripts/                 dev, smoke, with-keychain, vercel-build, vercel-verify
docs/decisions.md        decisions with the alternatives weighed, AI use, what comes next
data/                    logs, pids, spend ledger, evals output (git-ignored)
```

## Quick start

Node 22 (`.nvmrc`), bash and make: macOS or Linux, or WSL on Windows.

```sh
make setup                              # npm ci
export ANTHROPIC_API_KEY=sk-ant-...     # optional: without it, search runs unexpanded and suggestions return 503
make dev                                # API on :8787, UI on http://localhost:5173
samples/requests.sh                     # one request per route against the local API
make check                              # format, lint, typecheck, all tests
```

Nothing reads a `.env` file. Configuration, the macOS keychain option and every make target
are in [docs/operations.md](docs/operations.md).

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

## The API at a glance

| Route                                  | What it does                                                                                                                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /documents`, `GET /documents/:id` | List documents; read one with its `ETag`                                                                                                                                                |
| `POST /documents`                      | Add a plain-text document                                                                                                                                                               |
| `PATCH /documents/:id[?dryRun=true]`   | Apply up to 50 changes, all or nothing, by text and occurrence or by range; returns the new text and a word-level redline. `dryRun` previews; `If-Match` guards against a stale version |
| `GET /search?q=&docId=`                | Ranked passages from all, one or several documents, with highlights; quoted text is an exact phrase, and Claude adds synonyms for the rest                                              |
| `POST /documents/:id/suggestions`      | Claude's replacement for a selected range, with a rationale; never writes                                                                                                               |
| `GET /healthz`                         | Status and the running version                                                                                                                                                          |

```sh
curl -sS -X PATCH 'localhost:8787/documents/saas-msa?dryRun=true' -H 'content-type: application/json' \
  -d '{"changes":[{"operation":"replace","target":{"text":"thirty (30) days"},"replacement":"fifteen (15) days"}]}'
```

Every route, the errors and the design rationale: [docs/api.md](docs/api.md).

## Known issues

- On the live deploy, compression turns the `ETag` into `W/"v<n>"`, so echoing it in `If-Match`
  gets a 412; send `"v<n>"` from the document's `version` instead ([#38](../../issues/38)).
- On a cold serverless instance, the first edit's reindex can outlast the UI's refresh, so
  its results stay marked as updating until the next search ([#39](../../issues/39)).
- Documents live in memory per instance, with no sign-in: fine for a demonstration, not for
  client documents.

## What's next

Version history, API hardening, incremental reindexing, a per-firm collaboration policy, and
document import, ranked with reasons in [docs/decisions.md](docs/decisions.md#next).
