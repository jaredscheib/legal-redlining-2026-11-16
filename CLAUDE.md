# CLAUDE.md

- Stack: npm workspaces. `api/` is Hono on Node 22 (ESM, `.js` import suffixes); `web/` is React 18 + Vite.
- Build/test: `make check` (format, lint, typecheck, test) must be green before every commit; `make smoke` for the built server.
- Evals: `make evals` (scenarios/ through createApp in-process); `make spend` for LLM $ against the $30 budget.
- Every tunable lives in `api/src/config.ts`. Read env there, not elsewhere.
- Routes are registrars `(app, deps) => void` in `api/src/routes/`; test them via `createApp(deps).request()`.
- Errors: throw `ApiError(status, REASON, message)`; the body is `{error, code, details:{reason}}`. Never send stacks.
- Logs: `log.info(event, fields)` with ids and counts only, never document, passage or query text.
- LLM: only via `createLlmClient().call()`; tests run with `LLM_MODE=replay` and a fake transport, never the network.
- Commit new cassettes in `api/fixtures/llm/` with the code that needs them.
- Commits: atomic Conventional Commits; tests ship with their code. No push, rebase or stash.
- Dev servers: `make dev` / `make dev-stop` (API 8787, Vite 5173; override with API_PORT / WEB_PORT).
