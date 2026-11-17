#!/usr/bin/env bash
# Writes .vercel/output/ (Build Output API v3) for `vercel deploy --prebuilt`:
#   static/            the built web app
#   functions/api.func the API bundled into one ESM file, plus seed contracts and recordings
#   config.json        API paths to the function, everything else to the SPA
set -euo pipefail
cd "$(dirname "$0")/.."

GIT_SHA="${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
# A release deploy sets APP_RELEASE (e.g. v0.1.0); the page then shows "v0.1.0 (abc1234)".
APP_RELEASE="${APP_RELEASE:-}"
DISPLAY_VERSION="$GIT_SHA"
if [ -n "$APP_RELEASE" ]; then DISPLAY_VERSION="$APP_RELEASE ($GIT_SHA)"; fi
OUT=".vercel/output"
FUNC="$OUT/functions/api.func"

rm -rf "$OUT"
mkdir -p "$OUT/static" "$FUNC/fixtures"

echo "vercel-build: web (version $DISPLAY_VERSION)"
VITE_VERSION="$DISPLAY_VERSION" npm run --silent build -w web
cp -R web/dist/. "$OUT/static/"

echo "vercel-build: api function"
npx esbuild api/src/vercel/handler.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile="$FUNC/index.mjs" \
  --define:process.env.GIT_SHA="\"$GIT_SHA\"" \
  --define:process.env.APP_RELEASE="\"$APP_RELEASE\"" \
  --banner:js='import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' \
  --log-level=warning
# The search index worker is a second entry; indexer.ts finds it beside index.mjs.
npx esbuild api/src/search/index-worker.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile="$FUNC/index-worker.mjs" \
  --log-level=warning
# Copy only files git tracks, so a local document or a recording of one never uploads. Outside
# a git work tree (a clean export of a tagged commit) every file present is tracked.
bundle_files() {
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git ls-files -z -- "$@"
  else
    find "$@" -type f -print0
  fi
}
bundle_files api/seed api/fixtures/llm | while IFS= read -r -d '' f; do
  dest="$FUNC/${f#api/}"
  mkdir -p "$(dirname "$dest")"
  cp "$f" "$dest"
done

cat >"$FUNC/.vc-config.json" <<'JSON'
{"runtime":"nodejs22.x","handler":"index.mjs","launcherType":"Nodejs","shouldAddHelpers":false}
JSON

cat >"$OUT/config.json" <<'JSON'
{"version":3,"routes":[{"src":"^/(documents|search|healthz)(/.*)?$","dest":"/api"},{"handle":"filesystem"},{"src":"^/(.*)$","dest":"/index.html"}]}
JSON

echo "vercel-build: OK version=$DISPLAY_VERSION"
echo "  $(du -sh "$FUNC/index.mjs" | cut -f1) $FUNC/index.mjs"
echo "  $(du -sh "$FUNC/index-worker.mjs" | cut -f1) $FUNC/index-worker.mjs"
echo "  $(ls "$FUNC/seed" | wc -l | tr -d ' ') seed contracts, $(ls "$FUNC/fixtures/llm" | wc -l | tr -d ' ') recordings"
echo "  $(find "$OUT/static" -type f | wc -l | tr -d ' ') static files"
