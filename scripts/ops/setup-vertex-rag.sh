#!/usr/bin/env bash
# ============================================
# UseMoney - Vertex AI RAG Engine provisioning (MONEY-782, P2b)
# ============================================
# Provisions the managed Vertex AI RAG Engine corpus that backs the optional
# Vertex retriever (packages/core/src/rag/vertex-rag.ts). Atlas stays the
# DEFAULT — this corpus is only consulted once VERTEX_RAG_ENABLED=true AND
# VERTEX_RAG_CORPUS is set on the runtime.
#
# DRY-RUN by default — prints the plan. Pass --apply to mutate cloud resources.
#
#   ./scripts/ops/setup-vertex-rag.sh                 # show the plan
#   ./scripts/ops/setup-vertex-rag.sh --apply         # enable API + create corpus + import bucket
#
# What it does (in order):
#   1. Enables aiplatform.googleapis.com on the project.
#   2. Creates a Vertex AI RAG Engine corpus (managed vector store) via REST.
#   3. (OPT-IN) Imports gs://stockbook-content-qa/stocks into the corpus —
#      SKIPPED by default. See the MONEY-804 note below.
#   4. Echoes the resolved corpus id to set as VERTEX_RAG_CORPUS.
#
# ── MONEY-804: the raw-PDF import is OFF by default ───────────────────────────
# The SOURCE_BUCKET default (gs://stockbook-content-${ENV}/stocks) holds the RAW
# stock-filing PDFs. The StockSage 2.0 ingestion strategy is to embed the
# Document-AI-EXTRACTED text (per-docType smart chunks in Atlas), NOT to import
# raw PDFs into the Vertex corpus — importing raw PDFs would double-ingest and
# bypass the layout-aware extraction. So step 3 is gated behind an explicit
# opt-in: it only runs when VERTEX_RAG_IMPORT_RAW_PDFS=1 (or SOURCE_BUCKET is
# repointed at an extracted-text prefix). Default = corpus is created empty and
# populated later from the extracted-text pipeline.
#
# ── AUTH (IMPORTANT) ─────────────────────────────────────────────────────────
# RAG-Engine corpus WRITE methods (ragCorpora create / ragFiles:import) REJECT
# end-user gcloud credentials with ACCESS_TOKEN_TYPE_UNSUPPORTED — they require a
# SERVICE-ACCOUNT token (per orvi scripts/setup-rag.sh). So:
#   - Project ops (gcloud services enable) use the operator's end-user creds via
#     the isolated `stockbook` config noted below.
#   - RAG REST writes use an aiplatform token minted from a SERVICE-ACCOUNT key
#     ($VERTEX_RAG_SA_KEY, default ./gcp-sa.json), inside a throwaway gcloud
#     config so the operator's personal login is never disturbed.
#
# Operator gcloud is pinned to an isolated config so this never touches a
# personal default login:
#   CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook \
#     gcloud ... --account=founder@disdigital.in --project=stock-book-483718
#
# This is a DOCUMENTED script for the operator to run by hand. CI never runs it.
# ============================================

set -euo pipefail

# Optional [qa|prod] positional (default qa) — selects the content bucket + corpus
# name so this can provision EITHER environment. A `--apply` flag may follow it.
ENV="qa"
case "${1:-}" in qa|prod) ENV="$1"; shift ;; esac

# ── config ───────────────────────────────────────────────────────────────────
PROJECT_ID="${VERTEX_RAG_PROJECT:-stock-book-483718}"
ACCOUNT="${VERTEX_RAG_ACCOUNT:-founder@disdigital.in}"
GCLOUD_CONFIG="${CLOUDSDK_ACTIVE_CONFIG_NAME:-stockbook}"
RAG_LOCATION="${VERTEX_RAG_LOCATION:-us-central1}"
RAG_DISPLAY_NAME="${VERTEX_RAG_DISPLAY_NAME:-stockbook-filings-${ENV}}"
# Service-account key for the RAG REST writes (write methods reject user tokens).
VERTEX_RAG_SA_KEY="${VERTEX_RAG_SA_KEY:-./gcp-sa.json}"
# Source GCS prefix to import (the stock filing corpus) — per-env content bucket.
SOURCE_BUCKET="${VERTEX_RAG_SOURCE:-gs://stockbook-content-${ENV}/stocks}"
# MONEY-804: the raw-PDF import (step 3) is OFF unless explicitly opted in. The
# default SOURCE_BUCKET points at raw PDFs; embedding extracted text is the
# strategy. Set VERTEX_RAG_IMPORT_RAW_PDFS=1 (or repoint VERTEX_RAG_SOURCE at an
# extracted-text prefix and set the flag) to actually run the import.
IMPORT_RAW_PDFS="${VERTEX_RAG_IMPORT_RAW_PDFS:-0}"

AIPLATFORM_HOST="${RAG_LOCATION}-aiplatform.googleapis.com"
RAG_PARENT="projects/${PROJECT_ID}/locations/${RAG_LOCATION}"
RAG_BASE="https://${AIPLATFORM_HOST}/v1/${RAG_PARENT}"

APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Operator gcloud, pinned to the isolated `stockbook` config + founder account.
gc() {
  CLOUDSDK_ACTIVE_CONFIG_NAME="$GCLOUD_CONFIG" \
    gcloud "$@" --account="$ACCOUNT" --project="$PROJECT_ID"
}

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Vertex AI RAG Engine setup       ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Project : ${PROJECT_ID}"
echo "║  Location: ${RAG_LOCATION}"
echo "║  Corpus  : ${RAG_DISPLAY_NAME}"
echo "║  Source  : ${SOURCE_BUCKET}"
echo "║  Import  : $([ "$IMPORT_RAW_PDFS" = "1" ] && echo 'ON (raw-PDF import opted in)' || echo 'OFF (MONEY-804: extracted text, not raw PDFs)')"
echo "║  Mode    : $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry-run (pass --apply to mutate)')"
echo "╚════════════════════════════════════════════╝"
echo ""

# ── service-account token (RAG REST writes) ──────────────────────────────────
# Minted in a throwaway CLOUDSDK_CONFIG so it never disturbs the operator login.
mint_sa_token() {
  [ -f "$VERTEX_RAG_SA_KEY" ] || return 0
  local cfg
  cfg="$(mktemp -d)"
  (
    unset CLOUDSDK_ACTIVE_CONFIG_NAME
    export CLOUDSDK_CONFIG="$cfg"
    gcloud auth activate-service-account --key-file="$VERTEX_RAG_SA_KEY" --quiet >/dev/null 2>&1 || true
    gcloud auth print-access-token 2>/dev/null || true
  )
  rm -rf "$cfg"
}

SA_TOKEN=""
if [ "$APPLY" -eq 1 ]; then
  SA_TOKEN="$(mint_sa_token)"
  if [ -z "$SA_TOKEN" ]; then
    echo "ERROR: could not mint a service-account token from '${VERTEX_RAG_SA_KEY}'." >&2
    echo "       RAG corpus writes require a SERVICE-ACCOUNT credential — set" >&2
    echo "       VERTEX_RAG_SA_KEY=/path/to/sa-key.json (an aiplatform-enabled SA)." >&2
    exit 1
  fi
fi

# REST helper: dry-run prints the call (token masked); apply runs it.
rag_rest() {
  local method="$1" url="$2" body="${3:-}"
  if [ "$APPLY" -ne 1 ]; then
    echo "[dry-run] curl -X ${method} -H 'Authorization: Bearer <sa-token>' ${body:+-d '${body}' }${url}"
    return 0
  fi
  echo "+ curl -X ${method} -H 'Authorization: Bearer <redacted>' ${body:+-d '<body>' }${url}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer ${SA_TOKEN}" \
      -H "Content-Type: application/json" -d "$body" "$url" || true
  else
    curl -sS -X "$method" -H "Authorization: Bearer ${SA_TOKEN}" "$url" || true
  fi
}

# ── 1) Enable the Vertex AI API ──────────────────────────────────────────────
echo "1) Enable aiplatform.googleapis.com"
if [ "$APPLY" -eq 1 ]; then
  gc services enable aiplatform.googleapis.com
else
  echo "[dry-run] gc services enable aiplatform.googleapis.com"
fi
echo ""

# ── 2) Create the RAG corpus (SA token) ──────────────────────────────────────
echo "2) Create the RAG Engine corpus '${RAG_DISPLAY_NAME}'"
# Request RagManagedDb in KNN (Serverless) mode explicitly. The default now
# provisions ANN/Spanner mode, which is allowlist-restricted for NEW projects in
# us-central1/us-east1/us-east4 ("INVALID_ARGUMENT: switch to Serverless mode").
# KNN scales to zero and is the right fit for our filing corpus size.
rag_rest POST "${RAG_BASE}/ragCorpora" "{\"displayName\":\"${RAG_DISPLAY_NAME}\",\"vectorDbConfig\":{\"ragManagedDb\":{\"knn\":{}}}}"
echo ""
echo ""

# ── resolve the corpus name (create is an LRO; poll the list) ─────────────────
CORPUS_NAME=""
if [ "$APPLY" -eq 1 ]; then
  echo "+ resolving corpus '${RAG_DISPLAY_NAME}' (create is async; polling)…"
  for _ in $(seq 1 15); do
    CORPUS_NAME="$(curl -sS -H "Authorization: Bearer ${SA_TOKEN}" "${RAG_BASE}/ragCorpora" 2>/dev/null \
      | DN="$RAG_DISPLAY_NAME" python3 -c "import sys,os,json
try: d=json.load(sys.stdin)
except Exception: d={}
for c in d.get('ragCorpora', []):
    if c.get('displayName') == os.environ['DN']:
        print(c.get('name','')); break" 2>/dev/null || true)"
    [ -n "$CORPUS_NAME" ] && break
    sleep 4
  done
  echo "   Resolved corpus: ${CORPUS_NAME:-<not ready yet — re-run --apply to import once it appears>}"
else
  CORPUS_NAME="${RAG_PARENT}/ragCorpora/CORPUS_ID"
fi
echo ""

# ── 3) Import the source bucket into the corpus (OPT-IN, MONEY-804) ───────────
echo "3) Import ${SOURCE_BUCKET} into the corpus"
if [ "$IMPORT_RAW_PDFS" != "1" ]; then
  # MONEY-804: default = DON'T import. The default SOURCE_BUCKET holds raw PDFs;
  # the strategy is to embed Document-AI-extracted text via the extraction
  # pipeline, not to import raw PDFs into the Vertex corpus. Opt in explicitly.
  echo "   Skipping import — VERTEX_RAG_IMPORT_RAW_PDFS != 1 (MONEY-804: embed"
  echo "   extracted text, NOT raw PDFs). To import anyway, repoint"
  echo "   VERTEX_RAG_SOURCE at an extracted-text prefix and set"
  echo "   VERTEX_RAG_IMPORT_RAW_PDFS=1."
elif [ "$APPLY" -eq 1 ] && [ -z "$CORPUS_NAME" ]; then
  echo "   Skipping import — corpus not resolved yet (re-run --apply)."
else
  rag_rest POST \
    "https://${AIPLATFORM_HOST}/v1/${CORPUS_NAME}/ragFiles:import" \
    "{\"importRagFilesConfig\":{\"gcsSource\":{\"uris\":[\"${SOURCE_BUCKET}\"]}}}"
  echo ""
fi
echo ""

# ── 4) Echo the corpus id to set as VERTEX_RAG_CORPUS ────────────────────────
echo "4) Set this on the runtime (Vercel web + the research worker):"
echo ""
echo "   VERTEX_RAG_ENABLED=true"
echo "   VERTEX_RAG_LOCATION=${RAG_LOCATION}"
echo "   VERTEX_RAG_CORPUS=${CORPUS_NAME}"
echo ""
echo "   (Atlas stays the default until VERTEX_RAG_ENABLED=true AND the corpus is set.)"
echo ""
