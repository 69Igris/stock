#!/usr/bin/env bash
#
# setup-market-data-sa.sh — the service account for `usemoney-market-data`.
# IDEMPOTENT: every resource is read before it is created.
#
#   ./scripts/ops/setup-market-data-sa.sh {qa|prod|all} [--dry-run]
#
# ── WHY THE GRANTS ARE THIS NARROW ───────────────────────────────────────────
#
# This service is reachable from the public internet through a CDN. Its service
# account is therefore the blast radius of any request-handling bug in it, and
# it needs exactly three things: read the tiles it serves, reach Redis, and
# reach Mongo. It gets no write anywhere and no BigQuery at all — the lake
# contract's §8 prohibition ("the web request path never queries BigQuery")
# applies to this service more than to any other.
#
# ── `tiles/`, NOT `bars/` ────────────────────────────────────────────────────
#
# The A1 brief says `bars/`. `docs/reference/lake-layout.md` §1 and the A2
# prompt — the one that actually WRITES this data — both say `tiles/`, and
# `bucketForPrefix("bars/…")` throws `UnknownPrefixError` today. Granting read
# on `bars/` would have been read access to a path nothing writes, and the
# service would 404 in a way indistinguishable from a cache miss.
#
set -euo pipefail

PROJECT_ID="stock-book-483718"
GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-founder@disdigital.in}"
SA_NAME="market-data"

ENV_ARG="${1:-}"
DRY_RUN=0
shift || true
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=1 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
    shift
done

case "$ENV_ARG" in
    qa|prod) ENVS=("$ENV_ARG") ;;
    all)     ENVS=("qa" "prod") ;;
    *)
        cat >&2 <<'USAGE'
Usage: ./scripts/ops/setup-market-data-sa.sh {qa|prod|all} [--dry-run]

Creates `market-data@` and grants, per environment:
  objectViewer on gs://stockbook-lake-{env}  (the tiles/ prefix)
  secretAccessor on DATABASE_URL_{ENV}, REDIS_URL_{ENV}, MARKET_DATA_TOKEN_SECRET_{ENV}

One service account across environments — Cloud Run services are per-env and
the SECRETS are per-env, so the env boundary is enforced where the data is.
USAGE
        exit 1
        ;;
esac

run() { if [ "$DRY_RUN" = "1" ]; then echo "   DRY-RUN: $*"; else "$@"; fi; }

SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Everything this script could not grant because its target does not exist yet.
# It is a LIST rather than an immediate `exit 1` so one run reports every
# missing prerequisite instead of one per re-run.
declare -a BLOCKERS=()

echo "── service account ──────────────────────────────────────────────────"
if gcloud iam service-accounts describe "$SA" --project="$PROJECT_ID" \
    --account="$GCLOUD_ACCOUNT" >/dev/null 2>&1; then
    echo "   ${SA_NAME} exists"
else
    echo "   creating ${SA_NAME}"
    run gcloud iam service-accounts create "$SA_NAME" \
        --project="$PROJECT_ID" \
        --account="$GCLOUD_ACCOUNT" \
        --display-name="usemoney-market-data: UDF datafeed on Cloud Run"
fi

for ENV in "${ENVS[@]}"; do
    echo ""
    echo "── ${ENV} ───────────────────────────────────────────────────────────"
    UPPER="$(echo "$ENV" | tr '[:lower:]' '[:upper:]')"
    BUCKET="stockbook-lake-${ENV}"

    # Bucket-level objectViewer. A per-PREFIX grant needs IAM Conditions, and a
    # condition written against `resource.name` is silently ineffective if the
    # expression is wrong — it grants everything rather than failing. The
    # bucket holds only lake output, so bucket-level read IS the narrow grant.
    if gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT_ID" \
        --account="$GCLOUD_ACCOUNT" >/dev/null 2>&1; then
        echo "   grant objectViewer on gs://${BUCKET}"
        run gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
            --project="$PROJECT_ID" \
            --account="$GCLOUD_ACCOUNT" \
            --member="serviceAccount:${SA}" \
            --role="roles/storage.objectViewer"
    else
        # NAMED, not silent. The bucket is created by setup-lake.sh, and a
        # missing one here means the lake was never provisioned for this env —
        # which is a different problem from a failed grant.
        echo "   SKIPPED objectViewer — gs://${BUCKET} does not exist."
        echo "   Run ./scripts/ops/setup-lake.sh ${ENV} first."
        BLOCKERS+=("${ENV}: gs://${BUCKET} — run ./scripts/ops/setup-lake.sh ${ENV}")
    fi

    # EVERY secret the cloudbuild specs mount, and that list is machine-checked
    # by market-data-sa-secrets.test.ts. DD_API_KEY was missing here and the
    # deploy is where it surfaced: the image built, the image pushed, and
    # `services replace` refused the revision with "Permission denied on secret
    # ... DD_API_KEY_QA" — after ~6 minutes and a 778 MiB source upload. It
    # belongs to the datadog-agent SIDECAR rather than the app container, which
    # is exactly why a hand-kept list missed it.
    for SECRET in "DATABASE_URL_${UPPER}" "REDIS_URL_${UPPER}" \
                  "MARKET_DATA_TOKEN_SECRET_${UPPER}" "DD_API_KEY_${UPPER}"; do
        if gcloud secrets describe "$SECRET" --project="$PROJECT_ID" \
            --account="$GCLOUD_ACCOUNT" >/dev/null 2>&1; then
            echo "   grant secretAccessor on ${SECRET}"
            run gcloud secrets add-iam-policy-binding "$SECRET" \
                --project="$PROJECT_ID" \
                --account="$GCLOUD_ACCOUNT" \
                --member="serviceAccount:${SA}" \
                --role="roles/secretmanager.secretAccessor" \
                --quiet
        else
            echo "   SKIPPED ${SECRET} — it does not exist yet."
            echo "     printf '%s' '<value>' | gcloud secrets create ${SECRET} --data-file=- --project=${PROJECT_ID}"
            BLOCKERS+=("${ENV}: ${SECRET} — create it, then re-run this script")
        fi
    done
done

echo ""
echo "market-data@ was granted NO BigQuery role and NO write anywhere."
echo "The web request path never queries BigQuery (docs/reference/lake-layout.md §8)."

# EXIT NON-ZERO ON A PARTIAL RUN. This script's only job is to make the deploy
# possible, and `cloudbuild.*.yaml` mounts every secret above by name — a
# `services replace` naming a secret that does not exist FAILS. Exiting 0 having
# skipped one would report success for a state in which the very next step
# cannot work, and the skip is two lines up a long output nobody re-reads.
if [ ${#BLOCKERS[@]} -gt 0 ]; then
    echo ""
    echo "INCOMPLETE — ${#BLOCKERS[@]} prerequisite(s) missing, so the deploy will fail:"
    for B in "${BLOCKERS[@]}"; do echo "  - ${B}"; done
    exit 1
fi
