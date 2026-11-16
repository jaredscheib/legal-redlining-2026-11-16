# Redline

A redlining service for lawyers: search across contracts, pick a passage, get a
Claude-suggested replacement (or write one), preview it as an inline redline, apply it, and
find the new text by searching again.

**Status: skeleton.** Documents can be listed, read, created and edited
(`PATCH /documents/{id}`, with `?dryRun=true` for a preview and a word-level redline).
`GET /search` adds Claude synonyms for unquoted terms (`expansion` in the response says what
was added or why it was skipped; `expand=false` turns it off).
`POST /documents/{id}/suggestions` returns Claude's replacement for a range and a one-line
rationale without writing; 503 `LLM_UNAVAILABLE` or 502 `LLM_ERROR` when the model can't help.
Every response carries `x-request-id`, which the logs carry as `reqId`.

## Setup

- Node 22 (`.nvmrc`), then `make setup` (runs `npm ci`) and `make hooks` (pre-commit hook).
- `ANTHROPIC_API_KEY` (`sk-ant-...`) as a plain environment variable; see `.env.example`.
  On macOS you can keep it in the keychain instead:
  `security add-generic-password -s legal-redlining-2026-11-16 -a ANTHROPIC_API_KEY -w`.
  `scripts/with-keychain KEY... -- cmd` exports those keys (never printing them) and runs
  `cmd`; `make dev` and `make evals` use it. A key already in the environment wins.

## Make targets

| Target                             | What it does                                                                |
| ---------------------------------- | --------------------------------------------------------------------------- |
| `check`                            | Prettier check, ESLint, `tsc --noEmit` (strict), vitest on both workspaces  |
| `lint` `format` `typecheck` `test` | The pieces of `check`                                                       |
| `smoke`                            | Build the API, start it on a free port, curl `/healthz` and `/documents`    |
| `evals`                            | Run `scenarios/` through the app; table + `data/evals/<timestamp>.json`     |
| `spend`                            | LLM $ spent, live calls and replays against the $30 budget                  |
| `bench`                            | Search on a 10 MB+ contract: index build ms, median query ms, heap used     |
| `dev` / `dev-stop`                 | API on :8787 and Vite on :5173 in the background (pids and logs in `data/`) |
| `hooks`                            | Use `.githooks/` (pre-commit: format check, lint, fast tests)               |
| `tag V=x.y.z`                      | Annotated tag `vx.y.z` (not pushed)                                         |

## LLM calls, replay and spend

All model calls go through `api/src/llm/client.ts` with zod-typed structured output: query
expansion on `claude-haiku-5-5`, suggestions on `claude-sonnet-5-5`. `LLM_MODE` picks how:

- `record` (default): replay a recording if one exists, otherwise call the API and save it.
- `replay`: recordings only; a miss fails with `no_recording`. Tests and CI use this.
- `live`: always call the API; save nothing.

Recordings are `api/fixtures/llm/<sha256>.json`, keyed on the model, prompt, messages, output
schema, `maxTokens`, effort and thinking. Commit them so others replay instead of paying again.

Every live call appends tokens and cost at that model's prices (per 1M tokens: Haiku $0.10 in /
$0.50 out, Sonnet $2 in / $10 out) to
`data/llm-ledger.jsonl`. The project has a **$30 budget, enforced as a spend limit on the
Claude platform**; `make spend` is our running record against it. The ledger lives in the
checkout's `data/` folder, so each worktree keeps its own.

## Layout

```
api/src/        Hono app: config, log, errors, routes/, store/, llm/, evals/, domain/types.ts
api/seed/       Four synthetic contracts (NDA, SaaS MSA, lease, employment)
api/fixtures/   LLM recordings
api/test/       Large-file (10 MB+) tests
scenarios/      Labelled search queries and end-to-end flows for make evals
web/            React 18 + Vite shell
scripts/        smoke, dev, with-keychain
data/           Logs, pids, ledger, eval results (git-ignored)
```
