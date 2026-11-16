#!/usr/bin/env bash
# Build the API, start it on a free port, check /healthz and GET /documents, stop it.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build -w api >/dev/null

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
mkdir -p data
LOG="data/smoke.log"

PORT="$PORT" LLM_MODE=replay node api/dist/server.js >"$LOG" 2>&1 &
PID=$!
trap 'kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true' EXIT

BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 50); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "smoke: server exited early" >&2
    cat "$LOG" >&2
    exit 1
  fi
  node -e 'setTimeout(()=>{},100)'
done

health="$(curl -fsS "$BASE/healthz")"
docs="$(curl -fsS "$BASE/documents")"

HEALTH="$health" DOCS="$docs" node -e '
const h = JSON.parse(process.env.HEALTH);
const d = JSON.parse(process.env.DOCS);
const fail = (m) => { console.error("smoke: FAIL " + m); process.exit(1); };
if (h.status !== "ok" || typeof h.version !== "string") fail("healthz " + process.env.HEALTH);
if (!Array.isArray(d.documents) || d.documents.length < 4) fail("documents count");
for (const doc of d.documents) {
  if (!doc.id || !doc.title || doc.version !== 1 || !(doc.length > 0)) fail("document shape");
}
console.log(`smoke: OK version=${h.version} documents=${d.documents.length}`);
'
grep -q '"event":"server.start"' "$LOG" || { echo "smoke: no server.start log line" >&2; exit 1; }
