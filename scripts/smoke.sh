#!/usr/bin/env bash
# Build the API, start it on a free port, check /healthz and GET /documents, then the main
# flow (search, dry-run PATCH, PATCH, search again), and stop it. No API key or model calls.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run build -w api >/dev/null

PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
mkdir -p data
LOG="data/smoke.log"

PORT="$PORT" LLM_MODE=replay ANTHROPIC_API_KEY= node api/dist/server.js >"$LOG" 2>&1 &
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

# ---------------------------------------------------------------- Main flow
# search -> dry-run PATCH of the found passage -> real PATCH -> search finds the new wording.
# No model calls: every search runs with expand=false.

DOC="commercial-lease"
TARGET="five percent (5%)"
REPLACEMENT="seven percent (7%)"

# check <step> <json> <node expression returning an error string, or "" when OK>
# The expression sees the parsed JSON as `j` and the env vars passed in as `process.env`.
check() {
  STEP="$1" JSON="$2" node -e '
const j = JSON.parse(process.env.JSON);
const err = (() => { '"$3"' })();
if (err) { console.error(`smoke: FAIL ${process.env.STEP}: ${err}`); process.exit(1); }
console.log(`smoke: OK ${process.env.STEP}`);
'
}

# req <method> <path> [json body]: prints the body; fails unless the status is 200.
req() {
  local out status
  out="$(mktemp)"
  if [[ $# -ge 3 ]]; then
    status="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" -H 'content-type: application/json' \
      --data-binary "$3" "$BASE$2")"
  else
    status="$(curl -sS -o "$out" -w '%{http_code}' -X "$1" "$BASE$2")"
  fi
  if [[ "$status" != "200" ]]; then
    echo "smoke: FAIL $1 $2 returned $status: $(cat "$out")" >&2
    rm -f "$out"
    exit 1
  fi
  cat "$out"
  rm -f "$out"
}

patch_body="$(TARGET="$TARGET" REPLACEMENT="$REPLACEMENT" node -e '
console.log(JSON.stringify({ changes: [{ operation: "replace",
  target: { text: process.env.TARGET }, replacement: process.env.REPLACEMENT }] }));')"

# 1. Search for a seed-contract term.
found="$(req GET "/search?q=%22late%20charge%22&docId=$DOC&expand=false")"
TARGET="$TARGET" check "search finds the late charge clause" "$found" '
  if (!(j.total >= 1) || j.results.length < 1) return "no results";
  const hit = j.results[0];
  if (hit.docId !== "commercial-lease") return "wrong document " + hit.docId;
  if (!hit.snippet.includes(process.env.TARGET)) return "snippet lacks the target text";
  if (j.expansion.status !== "off") return "expansion should be off";
  return "";'
hit_start="$(HIT="$found" node -e 'console.log(JSON.parse(process.env.HIT).results[0].start)')"
hit_end="$(HIT="$found" node -e 'console.log(JSON.parse(process.env.HIT).results[0].end)')"
before="$(req GET "/documents/$DOC")"

# 2. Dry-run PATCH of that passage: a redline with delete and insert, and nothing stored.
dry="$(req PATCH "/documents/$DOC?dryRun=true" "$patch_body")"
HIT_START="$hit_start" HIT_END="$hit_end" REPLACEMENT="$REPLACEMENT" \
  check "dry-run PATCH returns a redline" "$dry" '
  if (j.dryRun !== true || j.version !== 1) return "expected dryRun at version 1";
  if (j.redline.length !== 1) return "expected one redline hunk";
  const h = j.redline[0];
  if (h.start < Number(process.env.HIT_START) || h.end > Number(process.env.HIT_END))
    return "hunk is outside the searched passage";
  const types = new Set(h.segments.map((s) => s.type));
  if (!types.has("delete") || !types.has("insert")) return "missing delete or insert segment";
  if (!j.text.includes(process.env.REPLACEMENT)) return "preview text lacks the replacement";
  return "";'
after_dry="$(req GET "/documents/$DOC")"
BEFORE="$before" check "dry run leaves the document unchanged" "$after_dry" '
  const b = JSON.parse(process.env.BEFORE);
  if (j.version !== b.version || j.text !== b.text) return "document changed after a dry run";
  return "";'

# 3. Real PATCH: the version bumps and the stored text has the replacement.
applied="$(req PATCH "/documents/$DOC" "$patch_body")"
check "PATCH bumps the version" "$applied" '
  if (j.dryRun !== false || j.version !== 2) return "expected version 2, got " + j.version;
  return "";'
stored="$(req GET "/documents/$DOC")"
REPLACEMENT="$REPLACEMENT" TARGET="$TARGET" check "GET shows the new text" "$stored" '
  if (j.version !== 2) return "GET version " + j.version;
  if (!j.text.includes(process.env.REPLACEMENT) || j.text.includes(process.env.TARGET))
    return "stored text not updated";
  return "";'

# 4. Search for a word from the replacement.
again="$(req GET "/search?q=seven&docId=$DOC&expand=false")"
REPLACEMENT="$REPLACEMENT" check "search finds the replacement" "$again" '
  const hit = j.results.find((r) => r.snippet.includes(process.env.REPLACEMENT));
  if (!hit) return "no result contains the replacement";
  if (hit.docVersion !== 2 || !hit.matchedTerms.includes("seven")) return "stale or unmatched hit";
  return "";'

echo "smoke: OK main flow"
