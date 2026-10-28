#!/usr/bin/env bash
# ============================================
# UseMoney - Document AI processor provisioning (MONEY-783, P3)
# ============================================
# Provisions the Document OCR processor that backs the stock-document-extract
# worker (workers/src/lib/docai.ts → extractWithDocumentAi). The worker WORKS
# pre-provisioning — when DOCUMENT_AI_PROCESSOR_ID is unset, documentAiReady()
# is false and it falls straight to pdf-parse — so this script only UPGRADES
# extraction quality to layout-aware OCR; it does not unblock the pipeline.
#
# DRY-RUN by default — prints the plan. Pass --apply to mutate cloud resources.
#
#   ./scripts/ops/setup-document-ai.sh                # show the plan
#   ./scripts/ops/setup-document-ai.sh --apply        # enable API + create/reuse processor
#
# What it does (in order):
#   1. Enables documentai.googleapis.com on the project.
#   2. Idempotently creates (or reuses) an OCR_PROCESSOR named "stockbook-doc-ocr"
#      in DOCUMENT_AI_LOCATION (default "us"): lists existing processors first and
#      reuses one matching the display name; only creates when none is found.
#   3. Echoes the resolved BARE processor id to set as DOCUMENT_AI_PROCESSOR_ID.
#
# ── AUTH (IMPORTANT) ─────────────────────────────────────────────────────────
# Unlike the Vertex RAG-Engine corpus WRITE methods (which reject end-user
# credentials with ACCESS_TOKEN_TYPE_UNSUPPORTED and need a SERVICE-ACCOUNT
# token), Document AI processors.create / processors.list ACCEPT end-user gcloud
# credentials. So every call — `gcloud services enable`, the gcloud documentai
# subcommands, and the REST fallback's access token — uses the operator's
# end-user creds via the isolated `stockbook` config noted below. No SA key.
#
# Operator gcloud is pinned to an isolated config so this never touches a
# personal default login:
#   CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook \
#     gcloud ... --account=founder@disdigital.in --project=stock-book-483718
#
# This is a DOCUMENTED script for the operator to run by hand. CI never runs it.
# ============================================

set -euo pipefail

# ── config ───────────────────────────────────────────────────────────────────
PROJECT_ID="${DOCAI_PROJECT:-stock-book-483718}"
ACCOUNT="${DOCAI_ACCOUNT:-founder@disdigital.in}"
GCLOUD_CONFIG="${CLOUDSDK_ACTIVE_CONFIG_NAME:-stockbook}"
# Processor region — MUST match DOCUMENT_AI_LOCATION on the worker runtime.
DOCAI_LOCATION="${DOCAI_LOCATION:-us}"
# Display name to find/create. Reused if a processor with this name exists.
DOCAI_PROCESSOR_DISPLAY_NAME="${DOCAI_PROCESSOR_DISPLAY_NAME:-stockbook-doc-ocr}"
# Document OCR processor type (matches lib/docai.ts "Document OCR" expectation).
DOCAI_PROCESSOR_TYPE="OCR_PROCESSOR"

DOCAI_HOST="${DOCAI_LOCATION}-documentai.googleapis.com"
DOCAI_PARENT="projects/${PROJECT_ID}/locations/${DOCAI_LOCATION}"
DOCAI_BASE="https://${DOCAI_HOST}/v1/${DOCAI_PARENT}"

# Optional [qa|prod] positional (default qa). The OCR processor is PROJECT-scoped,
# so qa and prod SHARE one processor in this project; env only selects which
# secret name the guidance references. A `--apply` flag may follow it.
ENV="qa"
case "${1:-}" in qa|prod) ENV="$1"; shift ;; esac
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Operator gcloud, pinned to the isolated `stockbook` config + founder account.
gc() {
  CLOUDSDK_ACTIVE_CONFIG_NAME="$GCLOUD_CONFIG" \
    gcloud "$@" --account="$ACCOUNT" --project="$PROJECT_ID"
}

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  UseMoney Document AI processor setup      ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Project  : ${PROJECT_ID}"
echo "║  Location : ${DOCAI_LOCATION}"
echo "║  Processor: ${DOCAI_PROCESSOR_DISPLAY_NAME}"
echo "║  Type     : ${DOCAI_PROCESSOR_TYPE}"
echo "║  Mode     : $([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry-run (pass --apply to mutate)')"
echo "╚════════════════════════════════════════════╝"
echo ""

# ── capability probe: do the gcloud documentai subcommands exist? ─────────────
# Newer gcloud SDKs ship `gcloud documentai processors {list,create}`. When they
# are absent we fall back to the Document AI REST API (end-user token, which
# Document AI accepts). Probe is read-only and config-isolated.
HAVE_GCLOUD_DOCAI=0
if CLOUDSDK_ACTIVE_CONFIG_NAME="$GCLOUD_CONFIG" \
    gcloud documentai processors list --help >/dev/null 2>&1; then
  HAVE_GCLOUD_DOCAI=1
fi
echo "   documentai gcloud subcommands: $([ "$HAVE_GCLOUD_DOCAI" -eq 1 ] && echo available || echo 'absent → REST fallback')"
echo ""

# ── end-user access token (REST fallback only) ───────────────────────────────
# Minted from the isolated config; Document AI accepts end-user tokens. Never
# printed. Only needed when the gcloud documentai subcommands are unavailable.
EU_TOKEN=""
mint_eu_token() {
  CLOUDSDK_ACTIVE_CONFIG_NAME="$GCLOUD_CONFIG" \
    gcloud auth print-access-token --account="$ACCOUNT" 2>/dev/null || true
}

# REST helper: dry-run prints the call (token masked); apply runs it.
docai_rest() {
  local method="$1" url="$2" body="${3:-}"
  if [ "$APPLY" -ne 1 ]; then
    echo "[dry-run] curl -X ${method} -H 'Authorization: Bearer <eu-token>' ${body:+-d '${body}' }${url}"
    return 0
  fi
  echo "+ curl -X ${method} -H 'Authorization: Bearer <redacted>' ${body:+-d '<body>' }${url}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Authorization: Bearer ${EU_TOKEN}" \
      -H "Content-Type: application/json" -d "$body" "$url" || true
  else
    curl -sS -X "$method" -H "Authorization: Bearer ${EU_TOKEN}" "$url" || true
  fi
}

# ── 1) Enable the Document AI API ────────────────────────────────────────────
echo "1) Enable documentai.googleapis.com"
if [ "$APPLY" -eq 1 ]; then
  gc services enable documentai.googleapis.com
else
  echo "[dry-run] gc services enable documentai.googleapis.com"
fi
echo ""

# ── 2) Idempotently create-or-reuse the OCR processor ────────────────────────
# Resolve the BARE processor id. The worker (lib/docai.ts processorName())
# prefixes projects/{p}/locations/{l}/processors/ itself, so we echo ONLY the id.
echo "2) Find-or-create '${DOCAI_PROCESSOR_DISPLAY_NAME}' (${DOCAI_PROCESSOR_TYPE}) in '${DOCAI_LOCATION}'"

PROCESSOR_ID=""

# Extract the bare id from a "projects/.../processors/{id}" resource name.
processor_id_from_name() {
  # shellcheck disable=SC2001
  echo "$1" | sed 's#.*/processors/##'
}

if [ "$APPLY" -eq 1 ]; then
  if [ "$HAVE_GCLOUD_DOCAI" -eq 1 ]; then
    # 2a) Reuse: list processors, match on displayName, take the bare id.
    echo "+ gc documentai processors list --location=${DOCAI_LOCATION} (match displayName)"
    PROCESSOR_ID="$(gc documentai processors list \
      --location="$DOCAI_LOCATION" \
      --filter="displayName=${DOCAI_PROCESSOR_DISPLAY_NAME}" \
      --format="value(name)" 2>/dev/null | head -n1 | sed 's#.*/processors/##' || true)"

    if [ -n "$PROCESSOR_ID" ]; then
      echo "   Reusing existing processor id: ${PROCESSOR_ID}"
    else
      # 2b) Create: only when none matched.
      echo "+ gc documentai processors create --location=${DOCAI_LOCATION} --display-name=${DOCAI_PROCESSOR_DISPLAY_NAME} --type=${DOCAI_PROCESSOR_TYPE}"
      PROCESSOR_ID="$(gc documentai processors create \
        --location="$DOCAI_LOCATION" \
        --display-name="$DOCAI_PROCESSOR_DISPLAY_NAME" \
        --type="$DOCAI_PROCESSOR_TYPE" \
        --format="value(name)" 2>/dev/null | head -n1 | sed 's#.*/processors/##' || true)"
      echo "   Created processor id: ${PROCESSOR_ID:-<create failed — inspect output above>}"
    fi
  else
    # REST fallback (gcloud documentai subcommands absent). End-user token.
    EU_TOKEN="$(mint_eu_token)"
    if [ -z "$EU_TOKEN" ]; then
      echo "ERROR: could not mint an end-user access token from the '${GCLOUD_CONFIG}' config." >&2
      echo "       Run a one-time interactive login for ${ACCOUNT} under that config, e.g.:" >&2
      echo "       CLOUDSDK_ACTIVE_CONFIG_NAME=${GCLOUD_CONFIG} gcloud auth login ${ACCOUNT}" >&2
      exit 1
    fi

    # 2a) Reuse: list processors, match displayName, take the bare id.
    echo "+ GET ${DOCAI_BASE}/processors (match displayName)"
    PROCESSOR_NAME="$(curl -sS -H "Authorization: Bearer ${EU_TOKEN}" \
      "${DOCAI_BASE}/processors" 2>/dev/null \
      | DN="$DOCAI_PROCESSOR_DISPLAY_NAME" python3 -c "import sys,os,json
try: d=json.load(sys.stdin)
except Exception: d={}
for p in d.get('processors', []):
    if p.get('displayName') == os.environ['DN']:
        print(p.get('name','')); break" 2>/dev/null || true)"

    if [ -n "$PROCESSOR_NAME" ]; then
      PROCESSOR_ID="$(processor_id_from_name "$PROCESSOR_NAME")"
      echo "   Reusing existing processor id: ${PROCESSOR_ID}"
    else
      # 2b) Create: only when none matched.
      docai_rest POST "${DOCAI_BASE}/processors" \
        "{\"type\":\"${DOCAI_PROCESSOR_TYPE}\",\"displayName\":\"${DOCAI_PROCESSOR_DISPLAY_NAME}\"}"
      echo ""
      # Re-list to resolve the bare id of the freshly-created processor.
      PROCESSOR_NAME="$(curl -sS -H "Authorization: Bearer ${EU_TOKEN}" \
        "${DOCAI_BASE}/processors" 2>/dev/null \
        | DN="$DOCAI_PROCESSOR_DISPLAY_NAME" python3 -c "import sys,os,json
try: d=json.load(sys.stdin)
except Exception: d={}
for p in d.get('processors', []):
    if p.get('displayName') == os.environ['DN']:
        print(p.get('name','')); break" 2>/dev/null || true)"
      PROCESSOR_ID="$(processor_id_from_name "$PROCESSOR_NAME")"
      echo "   Created processor id: ${PROCESSOR_ID:-<create failed — inspect output above>}"
    fi
  fi
else
  echo "[dry-run] reuse-or-create flow:"
  if [ "$HAVE_GCLOUD_DOCAI" -eq 1 ]; then
    echo "[dry-run] gc documentai processors list --location=${DOCAI_LOCATION} --filter='displayName=${DOCAI_PROCESSOR_DISPLAY_NAME}' --format='value(name)'"
    echo "[dry-run]   → if empty: gc documentai processors create --location=${DOCAI_LOCATION} --display-name=${DOCAI_PROCESSOR_DISPLAY_NAME} --type=${DOCAI_PROCESSOR_TYPE}"
  else
    echo "[dry-run] GET  ${DOCAI_BASE}/processors  (match displayName=${DOCAI_PROCESSOR_DISPLAY_NAME})"
    echo "[dry-run]   → if not found: POST ${DOCAI_BASE}/processors  -d '{\"type\":\"${DOCAI_PROCESSOR_TYPE}\",\"displayName\":\"${DOCAI_PROCESSOR_DISPLAY_NAME}\"}'"
  fi
  PROCESSOR_ID="PROCESSOR_ID"
fi
echo ""

# ── 3) Echo the env block to set on the runtime ──────────────────────────────
# DOCUMENT_AI_PROCESSOR_ID is the BARE id — the worker's processorName() builds
# projects/${GCP_PROJECT_ID}/locations/${DOCUMENT_AI_LOCATION}/processors/{id}.
echo "3) Set this on the runtime (the workers Cloud Run service):"
echo ""
echo "   DOCUMENT_AI_PROCESSOR_ID=${PROCESSOR_ID}"
echo "   DOCUMENT_AI_LOCATION=${DOCAI_LOCATION}"
echo ""
echo "   (GCP_PROJECT_ID is already set on the worker; documentAiReady() flips true"
echo "    once DOCUMENT_AI_PROCESSOR_ID is non-empty. Until then the extract worker"
echo "    falls back to pdf-parse, so the pipeline works pre-provisioning.)"
echo ""
echo "   GCP Secret Manager (per the project CLAUDE.md): store the id under"
echo "   DOCUMENT_AI_PROCESSOR_ID_QA and DOCUMENT_AI_PROCESSOR_ID_PROD"
echo "   (qa+prod share one processor in this project; active env=${ENV})."
echo ""
