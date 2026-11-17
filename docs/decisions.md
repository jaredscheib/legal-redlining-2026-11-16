# Decisions

This document covers how the redlining service was designed and built: each decision with the alternatives weighed, how AI was used, and what comes next. The plan, the decision log and each piece of work are in the GitHub issues. The plan is issue [#16](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/16), and the code and its reviews are in pull request [#19](https://github.com/jaredscheib/legal-redlining-2026-11-16/pull/19). For the layout of the code, see [Architecture at a glance](../README.md#architecture-at-a-glance) in the README.

## Implementation and API design

| Decision                                                                                                                                                                                           | Alternatives weighed                                                         | Why this one                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TypeScript throughout:** a Hono API and a React + Vite UI, as npm workspaces                                                                                                                     | Python (FastAPI) with a separate front end                                   | One language and one type system from the change engine to the UI. Hono's `app.request()` lets every route be tested in process.                                                                                                                                                                  |
| **REST, request–response only**, including the model calls                                                                                                                                         | Server-sent events, WebSockets, gRPC                                         | No feature needs a stream yet. A suggestion arrives in seconds as one JSON body, and polling covers the one late result (reindexing).                                                                                                                                                             |
| **Data model:** current text, version, and a log of change operations `{start, end, oldText, newText}`                                                                                             | (A) a full snapshot per version; (C) an operation log only, replayed to read | Reads are a single lookup, and the history is kept. Every change is stored as the exact operation the redline shows, and snapshots for version history ([#25](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/25)) can be added on top.                                          |
| **Change targeting:** text plus a 1-based occurrence, or a UTF-16 range with an `expectedText` guard                                                                                               | Ranges only; regex or context matching                                       | A person or a model knows "the second _thirty days_". The UI knows the exact selection, so it sends a range and the guard. Every change is resolved against the original text before any is applied, so changes never shift each other's offsets, and overlaps are rejected.                      |
| **All or nothing**, up to 50 changes per request                                                                                                                                                   | Partial success with per-change results                                      | A redline that half-applies is worse than one that fails with the index of the bad change.                                                                                                                                                                                                        |
| **Preview is `PATCH ?dryRun=true`**                                                                                                                                                                | A separate preview resource                                                  | The preview runs the same resolve, apply and redline code as the real write, so what you preview is what you apply.                                                                                                                                                                               |
| **Concurrency:** `ETag: "v<n>"`, with an optional `If-Match` compared strictly, as RFC 9110 requires                                                                                               | A required `If-Match`, automatic rebase, or locks                            | This is safe for one editor, and HTTP-standard for clients that opt in. The policy that suits a firm is a per-firm choice ([#37](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/37)).                                                                                           |
| **Strict input:** unknown fields get 400, a non-JSON body gets 415, a wrong method gets 405                                                                                                        | Ignoring unknown fields                                                      | A misspelled `occurence` used to edit the wrong match, and a misspelled guard was silently skipped. On a contract, failing loudly is the safe default.                                                                                                                                            |
| **Search:** an in-memory inverted index over passages of up to 400 characters, ranked with BM25. Quoted text is an exact phrase. Claude expands unquoted terms with synonyms, weighted at 0.5      | Substring scan; embeddings or hybrid search; a database's full-text search   | Ranked snippets in a few milliseconds on 10 MB, with no extra infrastructure. Expansion covers the vocabulary gap ("terminate" against "cancel") that BM25 misses. Embeddings wait until measured misses justify them ([#2](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/2)). |
| **Two-phase search** in the UI: plain results first, synonym hits merge in after                                                                                                                   | Waiting for expansion; no expansion                                          | Expansion adds 1.5–3 s. The lawyer sees results at once, and the "Also searching: …" line says which synonyms are in use. A switch turns synonyms off.                                                                                                                                            |
| **Models:** Claude Haiku for expansion, Claude Sonnet for suggestions                                                                                                                              | Sonnet or Opus for both                                                      | Measured: Haiku's p50 was 1.6 s, against Sonnet's 2.1 s at about 20× the cost, with comparable synonyms. Suggestions need drafting quality: in the evals they kept defined terms and clause numbers.                                                                                              |
| **The model returns replacement text only**                                                                                                                                                        | The model also returns the span to edit, checked against the source          | The span always comes from the user's selection, so there is nothing to verify, and the model cannot edit the wrong place.                                                                                                                                                                        |
| **Reindexing runs in a worker thread.** Search answers from the previous version and says so (`indexing`, and `stale` on each hit), and the UI refreshes until the index is current                | Reindexing inside the write; deferring the reindex on the main thread        | Search never waits. On 10 MB, a search during a reindex took about 24 ms, and the swap about 27 ms.                                                                                                                                                                                               |
| **Model spend:** every call is recorded and replayed, written to a spend ledger, and limited by a per-process cap on live calls (default 200). A $30 limit on the provider account is the backstop | Calling live everywhere                                                      | Tests, CI and the smoke check never pay. A repeated question costs nothing, and the cap is enforced in code.                                                                                                                                                                                      |
| **Plain-text documents**                                                                                                                                                                           | PDF and .docx import                                                         | Import needs an extraction step and an offset map back to the source; it is a feature of its own ([#8](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/8)).                                                                                                                      |
| **Observability:** JSON-lines logs with a request id on every line, holding ids and counts but never contract text; the build version shows on the page and in `/healthz`                          | Tracing infrastructure                                                       | It is enough to follow one request across the access log, search and model calls, locally and in production.                                                                                                                                                                                      |
| **Deploy:** Vercel, with production replaying recordings first and calling the model live up to the cap                                                                                            | A container on a VM                                                          | One stable URL with no infrastructure to run. Documents live in memory per instance, which is acceptable for a demonstration and stated in the README.                                                                                                                                            |

## Core features

A lawyer searches every contract, or a chosen set, for a clause, with synonyms or an exact phrase. They open a result at the passage, write a replacement or ask Claude for one, preview the redline inline (struck-through deletions, underlined insertions), and apply it. The page confirms the new version. If someone else changed the document in the meantime, the save is refused and a reload is offered.

## How AI was used

Claude wrote the code and the reviews under my direction. I set the goals, made the decisions, and checked the results.

- **The start.** I began with a short framing: lawyers as the users, search for clauses by snippet across many documents, an edit to one specific passage (written by hand first, with a Claude suggestion as a nice-to-have), and the redline shown inline. Claude then asked me a set of questions with options, and I chose the data model, the UI principles, how documents enter the store, and how the redline looks.
- **The plan was tested before anything was built.** Two separate Claude sessions that had not seen our discussion read it: one for scope and simplicity, one for whether it could be built as written. I then re-scoped it:
  - Sonnet rather than Opus
  - the optional API items held until the basic flow worked
  - spend tracked against the account's limit, with recordings so no call is paid for twice
  - a skeleton and a first evaluation before features
- **Design checkpoints during the build.** I stopped the work to talk through:
  - the API design (REST only, no streaming)
  - expansion latency, which led to Haiku and the two-phase search
  - observability, which led to request ids everywhere
  - whether the model should return spans (it doesn't)
  - concurrency and ETags, which led to the per-firm policy in [#37](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/37)
- **Parallel work.** I asked what could run at the same time. Up to three Claude sessions each built one piece of work in its own copy of the repository. Another session that had not seen the work reviewed each piece before it was merged.
- **Validation by use.** I used the app after the first UI landed, and walked through the local build, including a conflict test with curl. My feedback became its own piece of work ([#32](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/32)), and I then approved the optional API items ([#33](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/33)).
- **Reviews on request.** I asked for:
  - a refactoring review: five items were done ([#35](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/35)) and eight deferred ([#27](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/27))
  - a final review focused on the API, with no time limit, run as a client would run it

  From the findings of the final review, I chose which fixes landed before the merge ([#36](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/36) holds the rest).

- **Counts.**

  | What                                        | Count                                                                                       |
  | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
  | Pieces of work, each with its own issue     | 12, plus the fixes from the final reviews                                                   |
  | Reviews whose findings needed a second look | 5                                                                                           |
  | Review findings on individual pieces        | 5 high (all in the first draft of the docs, fixed before merge), 8 medium, 15 low, 13 minor |
  | Reviews of the whole change                 | 4                                                                                           |
  | Times I corrected the work or the process   | 9                                                                                           |
  | Model spend in development and evaluations  | about $0.07; production calls are capped per instance and not in that record                |

## Harder than expected

**Searching while reindexing.** Once the first version ran, the problem surfaced in the build rather than in the plan. Rebuilding the index for a 10 MB contract takes about a second.

- Done inside the write, it made every edit wait.
- Deferred on the main thread, it made every search that arrived during the rebuild wait.

It needed a step back to a better design. The rebuild moved to a worker thread and is swapped in when ready. Meanwhile, search answers from the previous version and says which documents are behind, and the UI refreshes until results are current. Rebuilding only the changed passages is the next step ([#26](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/26)).

## Next

In priority order:

1. [#25](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/25) Version history: list versions, view any past version, return to the latest.
2. [#36](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/36) API hardening:
   - a request-size limit (413)
   - indexing new documents off the request path
   - `Location` and `ETag` on create
   - smaller validation edges
3. [#26](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/26) Incremental reindexing of changed passages, with server-sent events instead of polling.
4. [#37](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/37) Per-firm collaboration policy, which needs tenants and identity ([#17](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/17)) and persistence ([#6](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/6)).
5. [#27](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/27) The deferred refactors (error handling, shared wire types, splitting the larger UI components).
6. [#28](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/28) Batch edits in the UI (the API already accepts up to 50 changes per request).
7. [#31](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/31) Running the evaluations in CI with a threshold.
8. [#8](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/8) .docx import and export, and [#2](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/2) embeddings, once measured misses justify them.

Each was cut from the first iteration to keep it small and complete: one user, one main flow, working end to end and tested.
