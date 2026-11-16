SHELL := /bin/bash
.DEFAULT_GOAL := check

GIT_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
export GIT_SHA
# Every worktree writes to the main checkout's ledger, so recorded spend outlives a worktree.
LLM_LEDGER_PATH ?= $(dir $(shell git rev-parse --path-format=absolute --git-common-dir 2>/dev/null))data/llm-ledger.jsonl
export LLM_LEDGER_PATH

.PHONY: setup check lint format format-check typecheck test test-fast build smoke evals compare-expansion spend bench dev dev-stop hooks tag

setup: ## Install exact dependencies from the lockfile
	npm ci

check: format-check lint typecheck test ## Everything CI runs

lint:
	npx eslint . --max-warnings=0

# Tracked files only, so local untracked files (notes, editor settings) never fail the check.
format:
	git ls-files -z | xargs -0 npx prettier --write --ignore-unknown

format-check:
	git ls-files -z | xargs -0 npx prettier --check --ignore-unknown

typecheck:
	npm run typecheck --workspaces

test:
	LLM_MODE=replay npm run test --workspaces

test-fast: ## Used by the pre-commit hook: skips *.large.test.ts
	LLM_MODE=replay npm run test --workspaces -- --exclude '**/*.large.test.ts' --exclude '**/node_modules/**'

build:
	npm run build -w api

smoke: ## Build the API, start it on a free port, curl /healthz and /documents, stop it
	./scripts/smoke.sh

evals: ## Run scenarios/ through the in-process app; table + data/evals/<ts>.json (LLM_MODE, default record)
	@LOG_STDOUT=off ./scripts/with-keychain ANTHROPIC_API_KEY -- npm run --silent evals -w api

compare-expansion: ## LIVE, billed (~15 calls, < $0.05): expansion latency and synonyms per model
	@LOG_STDOUT=off LLM_MODE=live ./scripts/with-keychain ANTHROPIC_API_KEY -- npm run --silent compare-expansion -w api

spend: ## $ spent on live LLM calls vs the $30 project budget
	@npm run --silent spend -w api

bench: ## Search over a 10 MB+ contract: index build ms, median query ms, heap used
	@LOG_STDOUT=off LOG_FILE=off npm run --silent bench -w api

dev: ## API on 8787 + Vite on 5173 in the background (override with API_PORT / WEB_PORT)
	@./scripts/dev.sh start

dev-stop:
	@./scripts/dev.sh stop

hooks:
	git config core.hooksPath .githooks

tag:
	@test -n "$(V)" || { echo "usage: make tag V=0.1.0" >&2; exit 2; }
	git tag -a v$(V) -m "v$(V)"
