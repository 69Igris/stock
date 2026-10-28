#!/usr/bin/env bash
#
# grant-qa-worker-access.sh — manage the MINIMAL GCP IAM for running the workers
# locally against QA (`yarn dev` in workers/) with the recipient's OWN Google
# identity via Application Default Credentials — no service-account key handed out.
#
# MODES
#   <email>            Grant the QA-worker role set (default action)
#   <email> --revoke   Revoke that same role set (offboarding)
#   <email> --check    Report which roles <email> has / is missing        (read-only)
#   --list             List everyone who currently has QA-worker access    (read-only)
#   --doctor           Self-test: can the CURRENT ADC identity reach QA     (read-only)
#                      Pub/Sub + GCS? The RECIPIENT runs this after
#                      `gcloud auth application-default login`.
#
# MODIFIERS
#   --with-optional    Include the job-specific roles (embeddings / doc-extract /
#                      public-bucket uploads). Omit for the tightest footprint.
#   --dry-run          Print the gcloud calls without applying (grant/revoke only).
#
# The role set (single source of truth below) is a strict subset of what the
# deployed worker's stockbook-api@ SA holds — NONE of run.admin / storage.admin /
# cloudbuild / secretmanager / serviceAccountUser is granted.
#
set -euo pipefail

PROJECT="stock-book-483718"
CONTENT_BUCKET="gs://stockbook-content-qa"
PUBLIC_BUCKET="gs://stockbook-public-content-dev"

# ---- role set (single source of truth for every mode) ----
REQUIRED_PROJECT_ROLES=(
  roles/serviceusage.serviceUsageConsumer   # quota project for user ADC
  roles/pubsub.editor                       # pull QA jobs + auto-create local subs + publish chains
)
OPTIONAL_PROJECT_ROLES=(
  roles/aiplatform.user                     # Vertex embeddings jobs
  roles/documentai.apiUser                  # stock-document-extract job
)
BUCKET_ROLE="roles/storage.objectAdmin"     # on CONTENT_BUCKET (required) + PUBLIC_BUCKET (optional)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
show_help() { sed -n '2,33p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'; }

require_email() {
  [ -n "$EMAIL" ] || { echo "ERROR: this mode needs a Google account email." >&2; exit 1; }
  case "$EMAIL" in *@*.*) ;; *) echo "ERROR: '$EMAIL' is not an email address." >&2; exit 1 ;; esac
}

preflight() {  # confirm the caller can talk to the project (catches founder re-auth)
  gcloud projects describe "$PROJECT" --format='value(projectId)' >/dev/null 2>&1 && return 0
  echo "ERROR: cannot read project '$PROJECT' as '$(gcloud config get-value account 2>/dev/null)'." >&2
  echo "       Re-authenticate, then retry:  gcloud auth login founder@disdigital.in" >&2
  exit 1
}

# does <bucket> grant <role> to user:<email> ?  (exit 0 = yes)
bucket_has_role() {
  gcloud storage buckets get-iam-policy "$1" --format=json 2>/dev/null | python3 -c '
import sys, json
d = json.load(sys.stdin); member = "user:" + sys.argv[1]; role = sys.argv[2]
sys.exit(0 if any(b.get("role") == role and member in b.get("members", []) for b in d.get("bindings", [])) else 1)
' "$2" "$3"
}

run() {  # apply-or-print one gcloud mutation
  if [ "$DRY_RUN" = 1 ]; then echo "    [dry-run] gcloud $*"; else gcloud "$@" --quiet >/dev/null; fi
}

# ---- read-only helper modes ----
mode_list() {
  echo "== users with QA-worker access on ${PROJECT} (holding roles/pubsub.editor) =="
  local members
  members="$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --filter="bindings.role=roles/pubsub.editor" --format='value(bindings.members)' 2>/dev/null \
    | grep '^user:' | sed 's/^user://' | sort -u || true)"
  if [ -z "$members" ]; then echo "  (none)"; else
    while IFS= read -r m; do [ -n "$m" ] && printf '  • %s\n' "$m"; done <<<"$members"
  fi
  echo
  echo "  Full per-role report:   $0 <email> --check"
}

mode_check() {
  local email="$1" held missing=0
  held="$(gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --filter="bindings.members:${email}" --format='value(bindings.role)' 2>/dev/null || true)"
  echo "== IAM check for ${email} on ${PROJECT} =="
  for role in "${REQUIRED_PROJECT_ROLES[@]}"; do
    if grep -qx "$role" <<<"$held"; then printf '  ✅ %s\n' "$role"
    else printf '  ❌ MISSING   %s  (required)\n' "$role"; missing=1; fi
  done
  if bucket_has_role "$CONTENT_BUCKET" "$email" "$BUCKET_ROLE"; then
    printf '  ✅ %s on %s\n' "$BUCKET_ROLE" "$CONTENT_BUCKET"
  else printf '  ❌ MISSING   %s on %s  (required)\n' "$BUCKET_ROLE" "$CONTENT_BUCKET"; missing=1; fi
  for role in "${OPTIONAL_PROJECT_ROLES[@]}"; do
    if grep -qx "$role" <<<"$held"; then printf '  ➕ %s  (optional, present)\n' "$role"
    else printf '  ·  %s  (optional, not granted)\n' "$role"; fi
  done
  bucket_has_role "$PUBLIC_BUCKET" "$email" "$BUCKET_ROLE" \
    && printf '  ➕ %s on %s  (optional, present)\n' "$BUCKET_ROLE" "$PUBLIC_BUCKET" || true
  echo
  if [ "$missing" = 0 ]; then echo "  RESULT: ✅ has all REQUIRED QA-worker roles"
  else echo "  RESULT: ❌ missing required role(s) — grant with:  $0 ${email}"; fi
}

# self-test run BY the recipient after ADC login — exercises the exact credential
# path (ADC token) against the exact APIs the worker calls.
mode_doctor() {
  echo "== QA-worker ADC self-test =="
  local token
  if ! token="$(gcloud auth application-default print-access-token 2>/dev/null)"; then
    echo "  ❌ No Application Default Credentials on this machine."
    echo "     Run:  gcloud auth application-default login"
    echo "           gcloud auth application-default set-quota-project ${PROJECT}"
    exit 1
  fi
  local who fails=0 code
  who="$(curl -s "https://oauth2.googleapis.com/tokeninfo?access_token=${token}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("email","?"))' 2>/dev/null || echo '?')"
  echo "  ADC identity: ${who}"
  echo "  Project     : ${PROJECT}"
  echo
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" \
    "https://pubsub.googleapis.com/v1/projects/${PROJECT}/topics?pageSize=1")"
  if [ "$code" = 200 ]; then echo "  ✅ Pub/Sub reachable (list topics → 200)"
  else echo "  ❌ Pub/Sub list topics → HTTP ${code} (need roles/pubsub.editor)"; fails=1; fi
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" \
    "https://storage.googleapis.com/storage/v1/b/stockbook-content-qa/o?maxResults=1")"
  if [ "$code" = 200 ]; then echo "  ✅ GCS stockbook-content-qa readable (→ 200)"
  else echo "  ❌ GCS bucket → HTTP ${code} (need roles/storage.objectAdmin on the bucket)"; fails=1; fi
  echo
  if [ "$fails" = 0 ]; then echo "  RESULT: ✅ ADC reaches QA Pub/Sub + GCS — worker credentials are good."
  else echo "  RESULT: ❌ ask the admin to grant access:  $0 ${who}"; fi
}

# ---------------------------------------------------------------------------
# arg parse + dispatch
# ---------------------------------------------------------------------------
EMAIL="" MODE="grant" WITH_OPTIONAL=0 DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --revoke)        MODE="revoke" ;;
    --check)         MODE="check" ;;
    --list)          MODE="list" ;;
    --doctor)        MODE="doctor" ;;
    --with-optional) WITH_OPTIONAL=1 ;;
    --dry-run)       DRY_RUN=1 ;;
    -h|--help)       show_help; exit 0 ;;
    --*)             echo "ERROR: unknown flag '$arg'" >&2; exit 1 ;;
    *)               EMAIL="$arg" ;;
  esac
done

case "$MODE" in
  doctor) mode_doctor; exit 0 ;;
  list)   preflight; mode_list; exit 0 ;;
  check)  require_email; preflight; mode_check "$EMAIL"; exit 0 ;;
esac

# ---- grant / revoke ----
require_email
preflight
MEMBER="user:${EMAIL}"
if [ "$MODE" = revoke ]; then OP="remove"; VERB="Revoke"; else OP="add"; VERB="Grant"; fi

project_roles=("${REQUIRED_PROJECT_ROLES[@]}")
[ "$WITH_OPTIONAL" = 1 ] && project_roles+=("${OPTIONAL_PROJECT_ROLES[@]}")

echo "== ${VERB} QA-worker access for ${MEMBER} on ${PROJECT} =="
[ "$WITH_OPTIONAL" = 1 ] && echo "   (including optional embeddings / doc-extract / public-bucket roles)"
[ "$DRY_RUN" = 1 ] && echo "   (dry run — nothing will change)"
echo

for role in "${project_roles[@]}"; do
  printf '  %-7s %s (project)\n' "$VERB" "$role"
  run projects "${OP}-iam-policy-binding" "$PROJECT" --member="$MEMBER" --role="$role" --condition=None
done
printf '  %-7s %s on %s\n' "$VERB" "$BUCKET_ROLE" "$CONTENT_BUCKET"
run storage buckets "${OP}-iam-policy-binding" "$CONTENT_BUCKET" --member="$MEMBER" --role="$BUCKET_ROLE"
if [ "$WITH_OPTIONAL" = 1 ]; then
  printf '  %-7s %s on %s\n' "$VERB" "$BUCKET_ROLE" "$PUBLIC_BUCKET"
  run storage buckets "${OP}-iam-policy-binding" "$PUBLIC_BUCKET" --member="$MEMBER" --role="$BUCKET_ROLE"
fi

if [ "$MODE" = grant ] && [ "$DRY_RUN" = 0 ]; then
  echo
  cat <<EOF
Done. Tell ${EMAIL} to run on their machine:
  gcloud auth application-default login
  gcloud auth application-default set-quota-project ${PROJECT}
  $0 --doctor            # verify their access before wrestling with .env

Then in workers/.env.local (leave GCP_SERVICE_ACCOUNT_KEY_BASE64 UNSET → ADC):
  GCP_PROJECT_ID=${PROJECT}
  PUBSUB_ENV=qa
  ENABLE_PULL_SUBSCRIBER=true
  NODE_ENV=development
  GCP_STORAGE_BUCKET=stockbook-content-qa
  GCP_PUBLIC_STORAGE_BUCKET=stockbook-public-content-dev
  GCP_LOCATION=us-central1
EOF
fi
