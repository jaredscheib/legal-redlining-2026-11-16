# Running and operating

Configuration, make targets, model cost control, logs, tests and deploy. Back to the [README](../README.md).

## Configuration

- Node 22 (see `.nvmrc`), bash and make: macOS or Linux, or WSL on Windows. Then `make setup` (runs `npm ci`) and `make hooks` (installs the
  pre-commit hook).
- `ANTHROPIC_API_KEY` (`sk-ant-...`) exported in your shell (`export ANTHROPIC_API_KEY=...`).
  Nothing reads a `.env` file; `.env.example` only lists the variables.
- On macOS you can keep the key in the keychain instead:
  `security add-generic-password -s legal-redlining-2026-11-16 -a ANTHROPIC_API_KEY -w`.
  `scripts/with-keychain KEY... -- cmd` exports those keys without printing them and runs
  `cmd`; `make dev` and `make evals` use it. A key already in the environment wins.
- **No key?** Everything except the Claude features works: search runs unexpanded (the
  response says why), and suggestions return `503 LLM_UNAVAILABLE`.

To run the built API without `make dev`:

```sh
npm run build -w api
GIT_SHA=$(git rev-parse --short HEAD) PORT=8787 LLM_MODE=replay npm run start -w api
samples/requests.sh http://localhost:8787    # one sample request per endpoint
```

| Variable                   | Default                        | Meaning                                                                                 |
| -------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `PORT`                     | `8787`                         | API port (binds 127.0.0.1)                                                              |
| `ANTHROPIC_API_KEY`        | unset                          | Enables live Claude calls                                                               |
| `LLM_MODE`                 | `record`                       | `record`, `replay` or `live`; see below                                                 |
| `LLM_MAX_LIVE_CALLS`       | `200`                          | Live (billed) Claude calls per process; past it they are refused (`cap_reached`)        |
| `DATA_DIR`                 | `data/`                        | Logs, pids and evals output                                                             |
| `LLM_LEDGER_PATH`          | `data/llm-ledger.jsonl`        | Spend ledger; the Makefile points it at the main checkout                               |
| `LOG_STDOUT`               | on                             | `off` silences log lines on stdout                                                      |
| `LOG_FILE`                 | on                             | `off` stops writing `data/app.log`                                                      |
| `SEARCH_INDEX_WORKER`      | on                             | `off` rebuilds edited documents in process instead of in a worker thread                |
| `GIT_SHA`                  | `dev`                          | Build commit shown by `/healthz` and the page; the Makefile sets it                     |
| `APP_RELEASE`              | unset                          | Release name baked in by `make vercel-build`; the version then reads `v0.1.0 (abc1234)` |
| `SEED_DIR`, `FIXTURES_DIR` | `api/seed`, `api/fixtures/llm` | Seed contracts and recordings, for a bundled build                                      |

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
| `coverage`                         | Full test suites with coverage; a summary per workspace, HTML in `*/coverage/`      |
| `compare-expansion`                | Live and billed (under $0.05): expansion latency and synonyms per model             |
| `vercel-build` / `vercel-verify`   | Build the Vercel output, then serve it locally in replay mode and check it          |
| `dev` / `dev-stop`                 | API on :8787 and Vite on :5173 in the background (pids and logs in `data/`)         |
| `hooks`                            | Use `.githooks/` (pre-commit: format check, lint, fast tests)                       |
| `tag V=x.y.z`                      | Annotated tag `vx.y.z` (not pushed)                                                 |

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
  messages, output schema, `maxTokens`, thinking and effort, so any prompt change is a new recording.
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
fields. Every line written while handling a request carries its `reqId`, which is also returned
as the `x-request-id` header (a safe incoming `x-request-id` is reused). They carry ids, counts and timings only, never document, passage or query text.

| Event                                                              | Fields                                                                                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `server.start`                                                     | `version`, `port`, `docs` (seeded), `llmMode`                                                                          |
| `server.stop`                                                      | `signal`                                                                                                               |
| `document.create`                                                  | `docId`, `length`                                                                                                      |
| `doc.patched`                                                      | `docId`, `version`, `changes`, `dryRun`, `ms`                                                                          |
| `http.request`                                                     | `reqId`, `method`, `route` (the pattern, never the raw path), `status`, `ms`                                           |
| `search.index`                                                     | `docId`, `version`, `reason` (`startup`, `create`, `commit`), `passages`, `mode` (`worker` or `sync`), `queueMs`, `ms` |
| `search.index_swap`, `search.index_discard`, `search.index_failed` | `docId`, `version`: a rebuilt index swapped in, a late result dropped, a failed rebuild                                |
| `search.index_worker_*`                                            | the worker failing to start, erroring, or a build falling back to in-process                                           |
| `search`                                                           | `reqId`, `qLen`, `terms`, `results`, `expansion` (status), `added`, `indexing`, `ms`                                   |
| `llm.call`                                                         | `op`, `model`, `inputTokens`, `outputTokens`, `ms`, `replayed`, `status`, `key`                                        |
| `http.unhandled`                                                   | `reqId` (also the `x-request-id` header), `method`, `route`, `errorName`                                               |
| `llm.ledger_unwritable`, `llm.cassette_unwritable`                 | the spend ledger or a recording could not be written (read-only disk)                                                  |
| `function.start`                                                   | the Vercel function's cold start: `version`, `docs`, `llmMode`                                                         |

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
  a measurement; no threshold gates `make check`. Measured at `5afbaf3` (the API figures vary
  by a few tenths of a percent between runs):

  | Workspace | Lines  | Branches | Functions |
  | --------- | ------ | -------- | --------- |
  | `api`     | 91.93% | 78.67%   | 93.79%    |
  | `web`     | 95.28% | 84.45%   | 95.09%    |

## Deploy (Vercel)

`make vercel-build` writes `.vercel/output/` (Build Output API v3): the web app as static
files and the API bundled into one Node 22 function with the seed contracts and recordings.
`make vercel-verify` serves that function locally on :8794 in replay mode and checks it. Then
`vercel deploy --prebuilt --prod`. A release build names itself with
`APP_RELEASE=v0.1.0 make vercel-build`: the value is baked in at build time, so setting it in
the Vercel project has no effect. Set these in the Vercel project:

- `ANTHROPIC_API_KEY`
- `LLM_MODE=record`: replay a recording first, call the API on a miss. The function's disk is
  read-only, so the result is not saved, and each miss logs `llm.cassette_unwritable`.
- `LLM_MAX_LIVE_CALLS` (default 200): live calls per instance. Search expansion and
  suggestions share the count; past it, suggestions return 503 and searches run unexpanded
  (`cap_reached`). The count resets on each cold start, so the account's spending limit is
  the backstop across instances.

Documents live in memory per instance and reset on a cold start. There is no sign-in: every
visitor shares one store, and two requests can reach different instances, so an applied edit
can seem to vanish. That is acceptable for a demonstration, not for client documents. Vercel rejects request
bodies over 4.5 MB.
On Vercel, an unknown path outside `/documents`, `/search` and `/healthz` serves the web page
(200), not `404 ROUTE_NOT_FOUND`.
Compression on Vercel weakens ETags; see the known issue under [PATCH](api.md#patch-documentsiddryruntrue) ([#38](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/38)).
On a cold instance the first edit's reindex can take several seconds, longer than the UI keeps
refreshing, so that edit's search results stay marked as updating until the next search
([#39](https://github.com/jaredscheib/legal-redlining-2026-11-16/issues/39)).
