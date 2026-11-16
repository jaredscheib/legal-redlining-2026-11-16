#!/usr/bin/env bash
# Sample requests for every endpoint of the Redline API.
#
#   samples/requests.sh [base-url]        default base url: http://localhost:8787
#
# Start the API first, e.g. `make dev`, or `npm run build -w api` then
# `PORT=8787 LLM_MODE=replay npm run start -w api`.
# Each request prints a one-line description, the HTTP status, then the body (through jq when
# it is installed, raw otherwise). Edits go to a document this script creates, so the seed
# contracts stay as they are and the script can be run again.
set -euo pipefail

BASE="${1:-http://localhost:8787}"
BASE="${BASE%/}"
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT

show() {
  if command -v jq >/dev/null 2>&1; then
    jq . "$BODY" 2>/dev/null || cat "$BODY"
  else
    cat "$BODY"
    echo
  fi
}

# call <method> <path> [json body]
call() {
  local status
  if [[ $# -ge 3 ]]; then
    status="$(curl -sS -o "$BODY" -w '%{http_code}' -X "$1" \
      -H 'content-type: application/json' --data-binary "$3" "$BASE$2")"
  else
    status="$(curl -sS -o "$BODY" -w '%{http_code}' -X "$1" "$BASE$2")"
  fi
  echo "-> $1 $2  HTTP $status"
  show
  echo
}

echo "== Health"
echo "# Liveness and the running version."
call GET /healthz

echo "== Documents"
echo "# List every document: id, title, version and length (no text)."
call GET /documents

echo "# Create a document; the response has its new id and version 1."
call POST /documents '{"title":"Sample Services Agreement","text":"1. Fees. Client shall pay all invoices within thirty (30) days of receipt.\n\n2. Term. This Agreement continues for one (1) year and renews for successive one-year terms unless either party gives sixty (60) days notice."}'
DOC_ID="$(node -e 'const fs=require("fs");try{console.log(JSON.parse(fs.readFileSync(process.argv[1],"utf8")).id??"")}catch{console.log("")}' "$BODY")"
if [[ -z "$DOC_ID" ]]; then
  echo "Could not create a document; is the API running at $BASE?" >&2
  exit 1
fi

echo "# Get one document with its full text."
call GET "/documents/$DOC_ID"

echo "# Get a document that does not exist: 404 DOCUMENT_NOT_FOUND."
call GET /documents/no-such-document

echo "== Edits"
PATCH_BODY='{"changes":[{"operation":"replace","target":{"text":"thirty (30) days"},"replacement":"fifteen (15) days"}]}'

echo "# Dry run: the would-be text and a word-level redline; nothing is stored (version stays 1)."
call PATCH "/documents/$DOC_ID?dryRun=true" "$PATCH_BODY"

echo "# Apply the same change: the text is stored and the version becomes 2."
call PATCH "/documents/$DOC_ID" "$PATCH_BODY"

echo "# Target the second occurrence of a repeated phrase with \"occurrence\": 2."
call PATCH "/documents/$DOC_ID?dryRun=true" '{"changes":[{"operation":"replace","target":{"text":"one","occurrence":2},"replacement":"two"}]}'

echo "# PATCH a document that does not exist: 404 DOCUMENT_NOT_FOUND."
call PATCH /documents/no-such-document "$PATCH_BODY"

echo "# Empty target text: 400 INVALID_PAYLOAD with the validation issues."
call PATCH "/documents/$DOC_ID" '{"changes":[{"operation":"replace","target":{"text":""},"replacement":"x"}]}'

echo "# Target text that is not in the document: 422 TARGET_NOT_FOUND."
call PATCH "/documents/$DOC_ID" '{"changes":[{"operation":"replace","target":{"text":"ninety (90) days"},"replacement":"x"}]}'

echo "== Search"
echo "# Plain search: BM25-ranked passages with offsets, highlights and matchedTerms."
call GET "/search?q=confidential%20information&limit=3"

echo "# Quoted phrase: only passages containing exactly \"late charge\"."
call GET "/search?q=%22late%20charge%22"

echo "# Restrict to one document with docId (repeat docId for several)."
call GET "/search?q=terminate&docId=saas-msa&limit=3"

echo "# Paging: the second page of two results; total stays the full count."
call GET "/search?q=agreement&limit=2&offset=2"

echo "# expand=false: never ask Claude for synonyms (expansion.status is \"off\")."
call GET "/search?q=indemnify&expand=false&limit=3"

echo "# The edit above is searchable at once."
call GET "/search?q=fifteen&docId=$DOC_ID"

echo "== Suggestions"
echo "# Ask Claude to rewrite a range; needs ANTHROPIC_API_KEY or a recorded replay, else 503 LLM_UNAVAILABLE."
call POST "/documents/$DOC_ID/suggestions" '{"range":{"start":0,"end":75},"instruction":"Make the payment window more favourable to the client."}'
