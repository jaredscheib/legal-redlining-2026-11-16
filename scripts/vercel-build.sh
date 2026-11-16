#!/usr/bin/env bash
# Writes .vercel/output/ (Build Output API v3) for `vercel deploy --prebuilt`:
#   static/            the built web app
#   functions/api.func the API bundled into one ESM file, plus seed contracts and recordings
#   config.json        API paths to the function, everything else to the SPA
set -euo pipefail
cd "$(dirname "$0")/.."

GIT_SHA="${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
OUT=".vercel/output"
FUNC="$OUT/functions/api.func"

rm -rf "$OUT"
mkdir -p "$OUT/static" "$FUNC/fixtures"

echo "vercel-build: web (version $GIT_SHA)"
VITE_VERSION="$GIT_SHA" npm run --silent build -w web
cp -R web/dist/. "$OUT/static/"

echo "vercel-build: api function"
npx esbuild api/src/vercel/handler.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile="$FUNC/index.mjs" \
  --define:process.env.GIT_SHA="\"$GIT_SHA\"" \
  --banner:js='import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' \
  --log-level=warning
cp -R api/seed "$FUNC/seed"
cp -R api/fixtures/llm "$FUNC/fixtures/llm"

cat >"$FUNC/.vc-config.json" <<'JSON'
{"runtime":"nodejs22.x","handler":"index.mjs","launcherType":"Nodejs","shouldAddHelpers":false}
JSON

cat >"$OUT/config.json" <<'JSON'
{"version":3,"routes":[{"src":"^/(documents|search|healthz)(/.*)?$","dest":"/api"},{"handle":"filesystem"},{"src":"^/(.*)$","dest":"/index.html"}]}
JSON

echo "vercel-build: OK version=$GIT_SHA"
echo "  $(du -sh "$FUNC/index.mjs" | cut -f1) $FUNC/index.mjs"
echo "  $(ls "$FUNC/seed" | wc -l | tr -d ' ') seed contracts, $(ls "$FUNC/fixtures/llm" | wc -l | tr -d ' ') recordings"
echo "  $(find "$OUT/static" -type f | wc -l | tr -d ' ') static files"
