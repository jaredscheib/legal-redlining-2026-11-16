SHELL := /bin/bash
.DEFAULT_GOAL := check

GIT_SHA := $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)
export GIT_SHA

.PHONY: setup check lint format format-check typecheck test test-fast build smoke hooks tag

setup: ## Install exact dependencies from the lockfile
	npm ci

check: format-check lint typecheck test ## Everything CI runs

lint:
	npx eslint . --max-warnings=0

format:
	npx prettier --write .

format-check:
	npx prettier --check .

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

hooks:
	git config core.hooksPath .githooks

tag:
	@test -n "$(V)" || { echo "usage: make tag V=0.1.0" >&2; exit 2; }
	git tag -a v$(V) -m "v$(V)"
