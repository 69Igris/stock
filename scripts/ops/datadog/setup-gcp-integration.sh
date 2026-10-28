#!/usr/bin/env bash
#
# Datadog's Google Cloud integration, and Cloud Cost Management — MONEY-1379.
#
#   scripts/ops/datadog/setup-gcp-integration.sh [--dry-run] [--from=STAGE] [--only=STAGE]
#
#     0 apis      enable the eight Google APIs the crawl and the cost export read
#     1 sa        create the integration service account and grant it FOUR roles
#     2 delegate  fetch Datadog's own delegate SA and let it impersonate ours
#     3 register  upsert the service account into the Datadog org
#     4 cost      wire Cloud Cost Management — FAIL-CLOSED on a missing export
#     5 verify    prove gcp.* metrics and the GCE hosts ARRIVED
#
# ## Why impersonation and not a key file
#
# The v1 integration wanted a downloaded JSON key uploaded into Datadog. That is
# a long-lived credential for a project-wide reader, living in two places at
# once, rotatable only by remembering to. v2 uses STS: Datadog holds a delegate
# service account of its own, we grant that delegate
# `roles/iam.serviceAccountTokenCreator` on OUR service account, and Datadog
# mints a short-lived token per crawl. Nothing is downloaded, so nothing can be
# leaked from a laptop, a backup or a screenshot, and revocation is one IAM
# binding rather than a key hunt.
#
# The four roles are the whole grant and they are all READ. A widening to
# `roles/editor` would work identically on day one and hand a third party write
# access to the project forever; `gcp-integration-agreement.test.ts` pins the
# exact four so that edit cannot be made quietly.
#
# ## The one thing this script cannot do
#
# Cloud Cost Management needs the **Detailed Usage Cost** BigQuery export, and
# turning that on is a console action — there is no API, no gcloud surface, no
# Terraform resource. It is also the step where delay is permanent: the export
# is not a query over history, it is a firehose that starts the day it is
# switched on. Every day it stays off is a day of cost data that will never
# exist, for any amount of money, later.
#
# So stage 4 refuses rather than improvising. It lists the dataset and demands a
# `gcp_billing_export_resource_v1_*` table before it writes anything, and exits
# **2** with the exact console path when there is none. A best-effort version
# would register a cost config against an empty dataset, report success, and
# leave someone waiting 72 hours for numbers that were never going to arrive —
# then another 72 after the export is finally enabled. The refusal is the
# faster path.
#
# ## What this costs (D6)
#
# The integration discovers Compute Engine instances and reports them as Datadog
# infrastructure HOSTS. Enumerated against the live project on 2026-09-11 —
# there are SIX, not the four MONEY-1379 estimated:
#
#   usemoney-prod-redis           usemoney-qa-mongodb
#   usemoney-qa-redis             usemoney-prod-datadog-agent  (already billed)
#   algo-prod-worker              algo-research-worker
#
# `usemoney-qa-redis` was in nobody's list, and `usemoney-prod-datadog-agent`
# has been a billable host since MONEY-1377 — so the NEW cost is five hosts,
# not four. Do not restate a count from a ticket here; run
#   gcloud compute instances list --project=stock-book-483718
# which is the only thing that cannot be out of date.
#
# All of them become billable the moment the crawl completes. That is the
# intended trade for GCE, Cloud Run, Pub/Sub and Cloud SQL metrics arriving
# without an agent on anything.
#
# ATTRIBUTION, not exclusion, is how the algo boxes are handled (founder
# decision 2026-09-11). Both carry the GCP label `product=algo-test-module`,
# which the integration imports as the host tag `product:algo-test-module`, so
# their cost and usage separate out in Datadog without dropping their metrics.
# `host_filters` remains EMPTY and is still the lever if exclusion is ever
# wanted instead — a one-field edit to stage 3's body, re-run, no teardown.
#
# ## No monitors here, deliberately
#
# Not an omission and not a follow-up nobody filed. A monitor over a series
# nobody emits renders NO DATA, which after one mute is indistinguishable from
# health — MONEY-1238, shipped four separate times in this directory. The series
# this integration produces have never been seen in our org, so nothing may
# alert on them until stage 5 has watched them arrive. The agreement test
# enforces that by scanning `monitor-*.json` and `dashboards/` for any `gcp.*`
# query.
#
# The two worth having once they are observed, in order:
#
#   1. `gcp.pubsub.subscription.oldest_unacked_message_age` — the 600s ack
#      deadline that sizes every batch in this repo is currently INVISIBLE. A
#      handler running past it gets its message redelivered and a second copy of
#      the job starts concurrently; nothing in the estate can see that today.
#   2. `gcp.run.container.instance_count` against max-instances — Cloud Run
#      saturation, which presents as latency rather than as an error.
#
# ## No {qa|prod} argument
#
# One GCP project and one Datadog org, so there is nothing to choose between.
# Unlike `apply-monitors.sh`, which really does have two estates, an environment
# argument here could only be accepted and ignored — and a silently-ignored
# argument is how a mistyped dry run made 78 live requests against a sibling
# script. It is refused with a usage line instead. Prod credentials only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- what we are pointing at --------------------------------------------------
# The project id is spelled ONCE. Everything derived from it — the service
# account address, the bucket name, the metric scope, the console URLs — is
# interpolated, so pointing this at another project is one line rather than a
# search-and-replace with one survivor left behind.
GCP_PROJECT="stock-book-483718"
GCP_ACCOUNT="founder@disdigital.in"
GCP_REGION="asia-south1"

SA_NAME="datadog-integration"
SA_EMAIL="${SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"

# EXACTLY these four, all read-only. See the header.
#
#   monitoring.viewer   the metrics themselves
#   compute.viewer      GCE instances, so they can be reported as hosts
#   cloudasset.viewer   resource inventory + tags for Resource Collection
#   browser             project metadata; without it the crawl cannot even
#                       enumerate what it has been given access to
SA_ROLES=(
  "roles/monitoring.viewer"
  "roles/compute.viewer"
  "roles/cloudasset.viewer"
  "roles/browser"
)

# The eight APIs the crawl and the cost export read through. Enabled in one
# call; `services enable` is idempotent and silent on an already-enabled API.
GCP_APIS=(
  "monitoring.googleapis.com"
  "compute.googleapis.com"
  "cloudasset.googleapis.com"
  "cloudresourcemanager.googleapis.com"
  "iam.googleapis.com"
  "cloudbilling.googleapis.com"
  "bigquery.googleapis.com"
  "storage.googleapis.com"
)

# ---- Cloud Cost Management ----------------------------------------------------
# The dataset the Billing console writes the Detailed Usage Cost export into,
# and the staging bucket Datadog writes its own derived tables through. They
# must be CO-LOCATED — BigQuery refuses a load job whose source bucket is in a
# different location, with an error that names neither.
BQ_DATASET="billing_export"
BILLING_BUCKET="${GCP_PROJECT}-billing-export"
EXPORT_PREFIX="datadog_cloud_cost_detailed_usage_export"

# The table prefix the DETAILED export creates. The standard and pricing exports
# produce `gcp_billing_export_v1_*` and `cloud_pricing_export` respectively, and
# neither carries the resource-level rows Cloud Cost Management needs — so this
# is a precondition on the RIGHT export, not merely on some export existing.
BILLING_TABLE_PREFIX="gcp_billing_export_resource_v1"

# Datadog needs to run BigQuery jobs and manage its own data transfer. There is
# no predefined role that is those three permissions and nothing else, so it is
# a custom project role rather than `roles/bigquery.admin`.
COST_ROLE_ID="datadogCloudCostAgent"
COST_ROLE_PERMISSIONS="bigquery.jobs.create,bigquery.transfers.get,bigquery.transfers.update"

# How long `verify` waits, and how often it looks. The GCP crawl is not
# immediate: Datadog polls the Monitoring API on its own schedule and the first
# points typically appear 5-10 minutes after registration. A single check
# straight after stage 3 would report NO DATA against a perfectly healthy
# integration, which is the one wrong answer this stage exists to avoid.
VERIFY_ATTEMPTS=10
VERIFY_INTERVAL_S=60

# `GET /api/v1/hosts` must report MORE than this. The GCE VMs named in the
# header are the arrivals; the floor is deliberately at the PRE-INTEGRATION
# count so that a stale reading from the reporters that were already there
# (the DBM agent VM plus the three Atlas members — 5 before this ran, measured
# 2026-09-11) cannot satisfy it on its own. Observed 10 after the crawl.
HOST_FLOOR=5

DRY_RUN=false
STAGES=(apis sa delegate register cost verify)
FROM=""
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --from=*)  FROM="${1#*=}"
               [[ -n "$FROM" ]] || { echo "--from= needs a stage (${STAGES[*]})" >&2; exit 2; } ;;
    --only=*)  ONLY="${1#*=}"
               # An EMPTY value must not fall through to "run everything" — see
               # setup-dbm-host.sh, where `--only=` once ran every stage
               # including VM creation.
               [[ -n "$ONLY" ]] || { echo "--only= needs a stage (${STAGES[*]})" >&2; exit 2; } ;;
    *) echo "unknown argument: $1" >&2
       echo "usage: $(basename "$0") [--dry-run] [--from=STAGE] [--only=STAGE]" >&2
       echo "       stages: ${STAGES[*]}" >&2
       echo "       (no environment argument — one GCP project, one Datadog org)" >&2
       exit 2 ;;
  esac
  shift
done

for s in ${FROM:+$FROM} ${ONLY:+$ONLY}; do
  # shellcheck disable=SC2076
  [[ " ${STAGES[*]} " == *" $s "* ]] || { echo "unknown stage: $s (want: ${STAGES[*]})" >&2; exit 2; }
done

# shellcheck source=./lib-datadog.sh
source "$HERE/lib-datadog.sh"
dd_resolve_api_host || exit 1

run_stage() {
  local want="$1"
  if [[ -n "$ONLY" ]]; then [[ "$ONLY" == "$want" ]] && return 0 || return 1; fi
  if [[ -n "$FROM" ]]; then
    local hit=false
    for s in "${STAGES[@]}"; do
      [[ "$s" == "$FROM" ]] && hit=true
      [[ "$s" == "$want" ]] && { $hit && return 0 || return 1; }
    done
  fi
  return 0
}

# Four of the six stages talk to Datadog; `apis` and `sa` are pure gcloud. The
# credentials are demanded up front, but only when a stage that needs them is
# actually in the run — requiring them for `--only=apis` fails on something that
# invocation never touches, and re-running one stage is the likeliest reason to
# reach for `--only=`.
needs_datadog_credentials() {
  run_stage delegate || run_stage register || run_stage cost || run_stage verify
}
if ! $DRY_RUN && needs_datadog_credentials; then
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_PROD)}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_PROD)}"
fi

# Per-command isolation, never a global `gcloud config set`. A config switch is
# ambient state that outlives the script and silently repoints the NEXT command
# somebody runs.
gc() { CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud "$@" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT"; }

# `bq` is the same isolation expressed as ENVIRONMENT rather than as flags,
# because it has no `--account`: it reads the active gcloud configuration.
# Passing the identity as CLOUDSDK_CORE_ACCOUNT is the documented equivalent and
# keeps the per-command discipline the repo rule is actually about.
bqx() {
  CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook \
  CLOUDSDK_CORE_ACCOUNT="$GCP_ACCOUNT" \
  CLOUDSDK_CORE_PROJECT="$GCP_PROJECT" \
    bq --project_id="$GCP_PROJECT" "$@"
}

# Datadog's delegate service-account address, dug out of whatever
# `/api/v2/integration/gcp/sts_delegate` answers.
#
# THE FIELD NAME IS UNVERIFIED. Datadog's reference page lists the two endpoints
# and not the response schema, so the documented-looking
# `data.attributes.delegate_account_email` is a guess — and a guess that reads
# `undefined` would otherwise become an empty `--member=serviceAccount:` and a
# binding on nothing. The fallback is a plain scan for a service-account address
# anywhere in the body, which cannot be wrong about the SHAPE of the answer, and
# stage 2 prints the raw body on its first run so the operator can pin the real
# field here and delete this paragraph.
delegate_email_from_body() {
  BODY="$1" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY || ""); } catch { doc = null; }
    const documented = doc?.data?.attributes?.delegate_account_email;
    if (typeof documented === "string" && documented.includes("@")) {
      process.stdout.write(documented);
      process.exit(0);
    }
    const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*gserviceaccount\.com/.exec(process.env.BODY || "");
    if (m) { process.stdout.write(m[0]); process.exit(0); }
    process.exit(1);
  '
}

# ---- 0 apis -------------------------------------------------------------------
stage_apis() {
  echo "── 0 apis ───────────────────────────────────────────────────────────────"

  if $DRY_RUN; then
    echo "  would enable ${#GCP_APIS[@]} APIs on ${GCP_PROJECT}:"
    printf '    %s\n' "${GCP_APIS[@]}"
    return 0
  fi

  gc services enable "${GCP_APIS[@]}" >/dev/null
  echo "  enabled (or already enabled) ${#GCP_APIS[@]} APIs"
  printf '    %s\n' "${GCP_APIS[@]}"
}

# ---- 1 sa ---------------------------------------------------------------------
stage_sa() {
  echo "── 1 sa ─────────────────────────────────────────────────────────────────"

  if $DRY_RUN; then
    echo "  would ensure ${SA_EMAIL} exists and carries:"
    printf '    %s\n' "${SA_ROLES[@]}"
    return 0
  fi

  if gc iam service-accounts describe "$SA_EMAIL" --format="value(email)" >/dev/null 2>&1; then
    echo "  service account ${SA_EMAIL} already exists"
  else
    gc iam service-accounts create "$SA_NAME" \
      --display-name="Datadog GCP integration" \
      --description="Impersonated by Datadog's STS delegate (MONEY-1379). Read-only. No key is ever downloaded for this account — if one exists, it was not created by scripts/ops/datadog/setup-gcp-integration.sh and should be deleted." \
      >/dev/null
    echo "  created ${SA_EMAIL}"
  fi

  # `add-iam-policy-binding` is idempotent — re-granting an existing binding is a
  # no-op rather than a duplicate.
  for role in "${SA_ROLES[@]}"; do
    gc projects add-iam-policy-binding "$GCP_PROJECT" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="$role" \
      --condition=None >/dev/null
    echo "  granted ${role}"
  done
}

# ---- 2 delegate ---------------------------------------------------------------
stage_delegate() {
  echo "── 2 delegate ───────────────────────────────────────────────────────────"

  if $DRY_RUN; then
    echo "  would GET /api/v2/integration/gcp/sts_delegate (and POST it if absent),"
    echo "  then grant roles/iam.serviceAccountTokenCreator on ${SA_EMAIL}"
    return 0
  fi

  # GET first. The delegate is per-ORG and created once; POSTing blind would
  # either 409 or, worse, be accepted and quietly answer with the existing one,
  # which is indistinguishable from having created a second.
  local body=""
  if dd_request GET "https://${DD_API_HOST}/api/v2/integration/gcp/sts_delegate"; then
    body="$RESPONSE_BODY"
  fi

  local email=""
  if [[ -n "$body" ]]; then
    email="$(delegate_email_from_body "$body")" || email=""
  fi

  if [[ -z "$email" ]]; then
    echo "  no delegate yet — creating one"
    if ! dd_request POST "https://${DD_API_HOST}/api/v2/integration/gcp/sts_delegate" "{}"; then
      echo "FATAL: could not create the STS delegate (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    body="$RESPONSE_BODY"
    email="$(delegate_email_from_body "$body")" || email=""
  fi

  # PRINTED IN FULL, always. The response schema is not in Datadog's reference
  # page, so this is the only record of what the field is actually called —
  # see `delegate_email_from_body`.
  echo "  raw sts_delegate response:"
  printf '    %s\n' "$body"

  [[ -n "$email" ]] || {
    echo "FATAL: no service-account address in the sts_delegate response — refusing to bind nothing." >&2
    echo "Read the body above and set the field name in delegate_email_from_body()." >&2
    exit 1
  }
  echo "  delegate: ${email}"

  # THE WHOLE POINT OF V2. This one binding is what replaces a downloaded key.
  gc iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --member="serviceAccount:${email}" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --condition=None >/dev/null
  echo "  granted roles/iam.serviceAccountTokenCreator on ${SA_EMAIL}"
}

# ---- 3 register ---------------------------------------------------------------
stage_register() {
  echo "── 3 register ───────────────────────────────────────────────────────────"

  # host_filters is EMPTY — every discovered GCE instance becomes a billable
  # Datadog host. See the header: narrowing it is the lever, and it belongs here.
  local payload
  payload="$(EMAIL="$SA_EMAIL" node -e '
    process.stdout.write(JSON.stringify({
      data: {
        type: "gcp_service_account",
        attributes: {
          client_email: process.env.EMAIL,
          automute: true,
          is_cspm_enabled: false,
          resource_collection_enabled: true,
          host_filters: [],
        },
      },
    }));
  ')"

  if $DRY_RUN; then
    echo "  would upsert ${SA_EMAIL} into the org:"
    echo "    ${payload}"
    return 0
  fi

  # LIST THEN DECIDE, never a bare POST. Datadog does not reject a second
  # registration of the same client_email; it keeps both, and the org then
  # crawls the project twice under two ids. The duplicate costs money, doubles
  # the API quota consumed against Google, and nothing downstream shows it.
  if ! dd_request GET "https://${DD_API_HOST}/api/v2/integration/gcp/accounts"; then
    # 404 IS THE EMPTY STATE, not a failure — and conflating the two made the
    # FIRST EVER RUN impossible.
    #
    # With no GCP integration configured, Datadog answers this LIST endpoint
    # with 404 `{"errors":[{"status":"404","detail":"Datadog GCP Integration
    # not found"}]}`. Observed against the live org on 2026-09-11, on exactly
    # the run this script exists to perform. Refusing there means the upsert
    # can only ever run on an org that is already set up.
    #
    # The distinction worth keeping is DETERMINACY, not the status. A 404 is a
    # determinate answer — "there are none" — and it is safe to create. A 401,
    # 403, 429 or 5xx is INDETERMINATE: we do not know whether an account
    # exists, and creating one there is how the org ends up crawling this
    # project twice under two ids, at double the cost and double the Google
    # quota, with nothing downstream showing it. Those still refuse.
    if [[ "$RESPONSE_STATUS" == "404" ]]; then
      echo "  no GCP integration configured yet (404) — this is the first registration"
      RESPONSE_BODY='{"data":[]}'
    else
      echo "FATAL: could not list GCP integration accounts (HTTP ${RESPONSE_STATUS}) — refusing to POST" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
  fi

  local id
  id="$(BODY="$RESPONSE_BODY" EMAIL="$SA_EMAIL" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY || ""); } catch {
      console.error("the account listing was not JSON — refusing to create anything");
      process.exit(1);
    }
    const rows = Array.isArray(doc?.data) ? doc.data : null;
    if (!rows) {
      console.error("the account listing had no data[] — refusing to create anything");
      process.exit(1);
    }
    const hit = rows.find((r) => r?.attributes?.client_email === process.env.EMAIL);
    if (hit?.id) process.stdout.write(String(hit.id));
  ')" || exit 1

  if [[ -n "$id" ]]; then
    local patch
    patch="$(PAYLOAD="$payload" ID="$id" node -e '
      const doc = JSON.parse(process.env.PAYLOAD);
      doc.data.id = process.env.ID;
      process.stdout.write(JSON.stringify(doc));
    ')"
    if ! dd_request PATCH "https://${DD_API_HOST}/api/v2/integration/gcp/accounts/${id}" "$patch"; then
      echo "FATAL: could not update the GCP account ${id} (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    echo "  updated existing registration (${id})"
  else
    if ! dd_request POST "https://${DD_API_HOST}/api/v2/integration/gcp/accounts" "$payload"; then
      echo "FATAL: could not register ${SA_EMAIL} (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    echo "  registered ${SA_EMAIL}"
  fi

  echo ""
  local vm_count
  vm_count="$(gc compute instances list --format="value(name)" 2>/dev/null | grep -c . || true)"
  echo "  ${vm_count:-?} GCE instances will now be reported as billable Datadog hosts."
  echo "  (algo-* carry product=algo-test-module, so they attribute separately.)"
  echo "  Narrow host_filters in this stage if that is not wanted."
}

# ---- 4 cost -------------------------------------------------------------------
stage_cost() {
  echo "── 4 cost ───────────────────────────────────────────────────────────────"

  # The billing account is resolved FIRST so the refusal below can print the
  # exact console URL rather than a generic "go to billing".
  local billing_ref billing_id console_url
  billing_ref="$(gc billing projects describe "$GCP_PROJECT" --format="value(billingAccountName)" 2>/dev/null || true)"
  billing_id="${billing_ref##*/}"
  if [[ -n "$billing_id" ]]; then
    console_url="https://console.cloud.google.com/billing/${billing_id}/export/bigquery"
  else
    console_url="https://console.cloud.google.com/billing"
  fi

  # ---- FAIL-CLOSED PRECONDITION ------------------------------------------------
  # No detailed export, no cost config. See the header: a config written over an
  # empty dataset reports success and waits forever.
  local tables
  tables="$(bqx --format=json ls --max_results=1000 "$BQ_DATASET" 2>/dev/null || true)"
  if ! printf '%s' "$tables" | grep -q "$BILLING_TABLE_PREFIX"; then
    echo "" >&2
    echo "FATAL: no ${BILLING_TABLE_PREFIX}_* table in ${GCP_PROJECT}:${BQ_DATASET}." >&2
    echo "" >&2
    echo "Cloud Cost Management reads the DETAILED usage cost export, and only the" >&2
    echo "console can switch it on — there is no API for it. Enable it here:" >&2
    echo "" >&2
    echo "  ${console_url}" >&2
    echo "" >&2
    echo "    Billing export -> BigQuery export -> Detailed usage cost -> Edit settings" >&2
    echo "    Project: ${GCP_PROJECT}   Dataset: ${BQ_DATASET}   Location: ${GCP_REGION}" >&2
    echo "" >&2
    echo "The export is a firehose, not a query over history: it accumulates only" >&2
    echo "from the day it is enabled, so every day of delay is cost data that will" >&2
    echo "never exist. Re-run --only=cost once the first table appears (allow an" >&2
    echo "hour). NOTHING was written." >&2
    # A DRY RUN must PRINT THE PLAN, not refuse it. `--dry-run` exists to be
    # run before anything is provisioned, which is precisely when the export is
    # least likely to be on — so aborting here would make the flag useless in
    # its main use case, and would hide stage 5 (verify) from the operator
    # entirely. The refusal above is still reported; it just does not stop a
    # run that was never going to write anything.
    if $DRY_RUN; then
      echo "  (dry-run: a real run would STOP here — nothing further in stage 4)" >&2
      return 0
    fi
    exit 2
  fi
  echo "  found the detailed usage cost export in ${GCP_PROJECT}:${BQ_DATASET}"

  # ---- co-location -------------------------------------------------------------
  # BigQuery refuses a load job whose source bucket sits in a different location,
  # with an error that names neither the bucket nor the dataset.
  local dataset_json dataset_location
  dataset_json="$(bqx --format=prettyjson show "$BQ_DATASET" 2>/dev/null || true)"
  dataset_location="$(BODY="$dataset_json" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY || ""); } catch { process.exit(1); }
    process.stdout.write(String(doc?.location ?? ""));
  ' 2>/dev/null || true)"
  dataset_location="$(printf '%s' "$dataset_location" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$dataset_location" ]]; then
    echo "FATAL: could not read ${BQ_DATASET}'s location" >&2
    if $DRY_RUN; then
      echo "  (dry-run: a real run would STOP here)" >&2
      return 0
    fi
    exit 1
  fi
  if [[ "$dataset_location" != "$GCP_REGION" ]]; then
    echo "FATAL: dataset ${BQ_DATASET} is in ${dataset_location}, but the staging bucket" >&2
    echo "is created in ${GCP_REGION}. They must be co-located or every load job fails." >&2
    if $DRY_RUN; then
      echo "  (dry-run: a real run would STOP here)" >&2
      return 0
    fi
    exit 1
  fi

  if $DRY_RUN; then
    echo "  would create gs://${BILLING_BUCKET} in ${GCP_REGION}, the ${COST_ROLE_ID} role,"
    echo "  the dataset-level WRITER ACL, the bucket bindings, and upsert the cost config"
    return 0
  fi

  # ---- staging bucket ----------------------------------------------------------
  if gc storage buckets describe "gs://${BILLING_BUCKET}" --format="value(name)" >/dev/null 2>&1; then
    echo "  gs://${BILLING_BUCKET} already exists"
  else
    gc storage buckets create "gs://${BILLING_BUCKET}" \
      --location="$GCP_REGION" --uniform-bucket-level-access >/dev/null
    echo "  created gs://${BILLING_BUCKET} in ${GCP_REGION}"
  fi

  # ---- the custom project role -------------------------------------------------
  # Three permissions and nothing else. `roles/bigquery.admin` would cover them
  # and also hand a third party the ability to delete every dataset here.
  if gc iam roles describe "$COST_ROLE_ID" --format="value(name)" >/dev/null 2>&1; then
    gc iam roles update "$COST_ROLE_ID" --permissions="$COST_ROLE_PERMISSIONS" --quiet >/dev/null
    echo "  updated custom role ${COST_ROLE_ID}"
  else
    gc iam roles create "$COST_ROLE_ID" \
      --title="Datadog Cloud Cost agent" \
      --description="BigQuery job + transfer permissions for Datadog Cloud Cost Management (MONEY-1379)" \
      --permissions="$COST_ROLE_PERMISSIONS" \
      --stage=GA >/dev/null
    echo "  created custom role ${COST_ROLE_ID}"
  fi
  gc projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="projects/${GCP_PROJECT}/roles/${COST_ROLE_ID}" \
    --condition=None >/dev/null

  # ---- dataset-level dataEditor ------------------------------------------------
  # DATASET level, not project level: Datadog writes its own tables INTO this
  # dataset, and a project-wide `roles/bigquery.dataEditor` would hand it write
  # access to every other dataset here too.
  #
  # Done with `bq show`/`bq update --source` rather than gcloud, because gcloud's
  # dataset-IAM surface is `alpha` and a provisioning script should not depend on
  # a command that can change under it. The cost is that `bq update` REPLACES
  # the whole access list — so this is a read-modify-write that adds one entry,
  # never a write of one entry. Posting just ours would revoke the project's own
  # owners and lock the dataset.
  #
  # `WRITER` is BigQuery's legacy ACL spelling of roles/bigquery.dataEditor; the
  # two are the same grant through two APIs.
  local tmp; tmp="$(mktemp -d)"; chmod 700 "$tmp"
  TMP_DIR="$tmp"
  trap 'rm -rf "${TMP_DIR:-}"' EXIT
  trap 'rm -rf "${TMP_DIR:-}"; exit 130' INT TERM

  # rc 0 = an entry was added and must be written back, 3 = already present,
  # anything else = we could not read the list. Captured explicitly rather than
  # read from `$?` in an else branch, where the next command to run changes it.
  local acl_rc=0
  BODY="$dataset_json" EMAIL="$SA_EMAIL" OUT="$tmp/dataset.json" node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(process.env.BODY);
    const access = Array.isArray(doc.access) ? doc.access : [];
    const already = access.some(
      (a) => a?.userByEmail === process.env.EMAIL && a?.role === "WRITER",
    );
    if (already) process.exit(3);
    access.push({ role: "WRITER", userByEmail: process.env.EMAIL });
    doc.access = access;
    fs.writeFileSync(process.env.OUT, JSON.stringify(doc));
  ' || acl_rc=$?
  if (( acl_rc == 0 )); then
    bqx update --source "$tmp/dataset.json" "$BQ_DATASET" >/dev/null
    echo "  granted dataset-level WRITER (roles/bigquery.dataEditor) on ${BQ_DATASET}"
  elif (( acl_rc == 3 )); then
    echo "  ${SA_EMAIL} already holds dataset-level WRITER on ${BQ_DATASET}"
  else
    echo "FATAL: could not read the access list of ${BQ_DATASET} (node exited ${acl_rc})" >&2
    exit 1
  fi

  rm -rf "$tmp"; TMP_DIR=""

  # ---- bucket bindings ---------------------------------------------------------
  # The legacy pair, because that is what Datadog's own setup asks for: read the
  # objects it stages, and write new ones without being able to delete the
  # bucket.
  for role in "roles/storage.legacyObjectReader" "roles/storage.legacyBucketWriter"; do
    gc storage buckets add-iam-policy-binding "gs://${BILLING_BUCKET}" \
      --member="serviceAccount:${SA_EMAIL}" \
      --role="$role" >/dev/null
    echo "  granted ${role} on gs://${BILLING_BUCKET}"
  done

  [[ -n "$billing_id" ]] || { echo "FATAL: could not resolve the billing account for ${GCP_PROJECT}" >&2; exit 1; }

  # ---- the BigQuery Data Transfer service agent -------------------------------
  #
  # THE STEP THAT IS NOT IN ANY DOC WE READ, and the one that makes the cost
  # config creatable at all. Learned from the live 400 on 2026-09-11:
  #
  #   [key=CROSS_ACCOUNT_TOKEN_ACCCESS] Missing Cross Account Token Creator
  #   access on the Google Cloud Bigquery Data Transfer service account.
  #
  # Datadog does not read the export table itself. It creates a BigQuery Data
  # TRANSFER that copies the billing export into the staging bucket, and that
  # transfer runs as Google's own service agent
  # `service-<PROJECT_NUMBER>@gcp-sa-bigquerydatatransfer.iam.gserviceaccount.com`,
  # which must be able to IMPERSONATE our integration SA. So there are TWO
  # token-creator grants on `$SA_EMAIL`, for two different callers: Datadog's
  # STS delegate (stage 2) and this one.
  #
  # The agent is created LAZILY on first use, so a fresh project does not have
  # it and the binding would fail with "does not exist". `services identity
  # create` is idempotent and returns the existing one, so it is safe every run.
  #
  # Nothing local could have found this: the agreement test stubs `curl`, so it
  # asserts the REQUEST shape and never the vendor's validation. It is the third
  # defect in this script found only by running it (after the 404-as-empty-state
  # and the wrong VM count).
  local bq_agent project_number
  project_number="$(gc projects describe "$GCP_PROJECT" --format="value(projectNumber)" 2>/dev/null || true)"
  [[ -n "$project_number" ]] || { echo "FATAL: could not resolve the project NUMBER (not the id) for ${GCP_PROJECT}" >&2; exit 1; }
  bq_agent="service-${project_number}@gcp-sa-bigquerydatatransfer.iam.gserviceaccount.com"

  gc beta services identity create --service=bigquerydatatransfer.googleapis.com >/dev/null 2>&1 || true
  gc iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
    --member="serviceAccount:${bq_agent}" \
    --role="roles/iam.serviceAccountTokenCreator" >/dev/null
  echo "  granted roles/iam.serviceAccountTokenCreator to the BigQuery Data Transfer agent"

  # ---- the cost config, upserted ----------------------------------------------
  local payload
  payload="$(BILLING="$billing_id" BUCKET="$BILLING_BUCKET" DATASET="$BQ_DATASET" \
    PREFIX="$EXPORT_PREFIX" PROJECT="$GCP_PROJECT" EMAIL="$SA_EMAIL" node -e '
    process.stdout.write(JSON.stringify({
      data: {
        // UNVERIFIED against a live response: the reference page documents the
        // attributes and not this discriminator. It follows the AWS CUR config
        // naming, and a wrong value is answered with a 400 that names the
        // field — loud, not silent.
        type: "gcp_uc_config_post_request",
        attributes: {
          billing_account_id: process.env.BILLING,
          bucket_name: process.env.BUCKET,
          export_dataset_name: process.env.DATASET,
          export_prefix: process.env.PREFIX,
          export_project_name: process.env.PROJECT,
          service_account: process.env.EMAIL,
        },
      },
    }));
  ')"

  # Same GET-then-decide as stage 3. A second config over one billing account
  # bills the same data twice and there is no error anywhere.
  if ! dd_request GET "https://${DD_API_HOST}/api/v2/cost/gcp_uc_config"; then
    echo "FATAL: could not list cost configs (HTTP ${RESPONSE_STATUS}) — refusing to POST" >&2
    echo "${RESPONSE_BODY}" >&2
    exit 1
  fi

  local config_id
  config_id="$(BODY="$RESPONSE_BODY" EMAIL="$SA_EMAIL" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY || ""); } catch {
      console.error("the cost-config listing was not JSON — refusing to create anything");
      process.exit(1);
    }
    const rows = Array.isArray(doc?.data) ? doc.data : null;
    if (!rows) {
      console.error("the cost-config listing had no data[] — refusing to create anything");
      process.exit(1);
    }
    const hit = rows.find((r) => r?.attributes?.service_account === process.env.EMAIL);
    if (hit?.id) process.stdout.write(String(hit.id));
  ')" || exit 1

  if [[ -n "$config_id" ]]; then
    # PATCH carries `is_enabled` only — the other attributes are set at creation
    # and the endpoint does not take them back.
    if ! dd_request PATCH "https://${DD_API_HOST}/api/v2/cost/gcp_uc_config/${config_id}" \
      '{"data":{"type":"gcp_uc_config_patch_request","attributes":{"is_enabled":true}}}'; then
      echo "FATAL: could not enable cost config ${config_id} (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    echo "  re-enabled existing cost config (${config_id})"
  else
    # IAM PROPAGATION: the binding above is not visible to Google's token
    # service immediately, and Datadog validates by trying to impersonate. The
    # first attempt after a fresh grant is expected to 400 with
    # CROSS_ACCOUNT_TOKEN_ACCCESS; it cleared within a minute when measured.
    # Retried rather than slept blindly, so an already-propagated run costs
    # nothing and a genuinely wrong binding still fails with the real message.
    local cost_try=1
    while (( cost_try <= 5 )); do
      dd_request POST "https://${DD_API_HOST}/api/v2/cost/gcp_uc_config" "$payload" && break
      if ! printf '%s' "$RESPONSE_BODY" | grep -q "CROSS_ACCOUNT_TOKEN_ACCCESS"; then break; fi
      echo "  attempt ${cost_try}/5: token-creator grant has not propagated yet; waiting 30s"
      sleep 30
      cost_try=$((cost_try + 1))
    done
    if [[ "${RESPONSE_STATUS}" != "2"* ]]; then
      echo "FATAL: could not create the cost config (HTTP ${RESPONSE_STATUS})" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
    echo "  created the cost config for billing account ${billing_id}"
  fi

  echo ""
  echo "  cost data takes 48-72 hours to stabilise. Nothing is wrong before then."
}

# ---- 5 verify -----------------------------------------------------------------
stage_verify() {
  echo "── 5 verify ─────────────────────────────────────────────────────────────"

  if $DRY_RUN; then
    echo "  would poll for gcp.* points, the GCE hosts, and the cost config"
    return 0
  fi

  export DD_API_KEY DD_APP_KEY

  # The series the integration must produce. Both are scoped to THIS project:
  # an unscoped `gcp.*` query would be satisfied by any other integration in the
  # org, which is the same shape of false pass as querying a 24h window after a
  # config change.
  local metrics
  metrics=(
    "avg:gcp.run.container.instance_count{project_id:${GCP_PROJECT}}"
    "avg:gcp.pubsub.subscription.oldest_unacked_message_age{project_id:${GCP_PROJECT}}"
  )

  # A ONE-HOUR window, not the helper's 24h default. This stage is re-runnable
  # (`--only=verify`), and over 24h a re-run passes on YESTERDAY's points no
  # matter what the crawl is doing today — the same false-pass-from-a-wide-
  # window shape the comment above warns about. An hour is far longer than the
  # 5-10 minute crawl interval and still means "currently flowing".
  local attempt=1 ok=false rc
  while (( attempt <= VERIFY_ATTEMPTS )); do
    local missing=0
    for q in "${metrics[@]}"; do
      dd_metric_has_points "$q" 3600; rc=$?
      # 2 is "the query did not run" — auth, transport, an unparsable body.
      # Retrying it burns the whole window and then blames the crawl, the
      # delegate binding or the org, none of which is the cause. Stop and name
      # the real one.
      if (( rc == 2 )); then
        echo "" >&2
        echo "  FATAL: the metric query itself did not run (HTTP ${RESPONSE_STATUS:-?})." >&2
        echo "  This is NOT the crawl. Check DD_APP_KEY (it needs metrics read), the" >&2
        echo "  API host, and whether the request was rate limited. Body:" >&2
        echo "  ${RESPONSE_BODY}" >&2
        return 1
      fi
      (( rc != 0 )) && missing=$((missing + 1))
    done
    if (( missing == 0 )); then ok=true; break; fi
    echo "  attempt ${attempt}/${VERIFY_ATTEMPTS}: ${missing} of ${#metrics[@]} metric(s) still absent — the crawl takes 5-10 min"
    attempt=$((attempt + 1))
    if (( attempt <= VERIFY_ATTEMPTS )); then sleep "$VERIFY_INTERVAL_S"; fi
  done

  if ! $ok; then
    echo "" >&2
    echo "  no gcp.* points in the last hour, after $(( VERIFY_ATTEMPTS * VERIFY_INTERVAL_S / 60 )) minutes of polling." >&2
    echo "  The queries RAN — this is genuinely no data, not an auth or transport" >&2
    echo "  failure (those stop the stage above with a different message)." >&2
    echo "  Usual causes, in order: the delegate binding (stage 2) never landed, the" >&2
    echo "  monitoring API is not enabled (stage 0), or the account was registered" >&2
    echo "  into a different org. A blocked crawl looks exactly like an idle project." >&2
    return 1
  fi
  for q in "${metrics[@]}"; do echo "  ARRIVED  ${q}"; done

  # The hosts half. Metrics can arrive from Cloud Run and Pub/Sub without a
  # single GCE instance being discovered, so this is a separate claim.
  if ! dd_request GET "https://${DD_API_HOST}/api/v1/hosts?count=200"; then
    echo "  ERROR    could not list hosts (HTTP ${RESPONSE_STATUS})" >&2
    return 1
  fi
  local hosts
  hosts="$(BODY="$RESPONSE_BODY" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY || ""); } catch { process.exit(1); }
    const n = typeof doc?.total_matching === "number"
      ? doc.total_matching
      : Array.isArray(doc?.host_list) ? doc.host_list.length : null;
    if (n === null) process.exit(1);
    process.stdout.write(String(n));
  ')" || { echo "  ERROR    the host listing was not readable" >&2; return 1; }

  if (( hosts > HOST_FLOOR )); then
    echo "  ARRIVED  ${hosts} hosts (floor ${HOST_FLOOR}) — every discovered GCE VM is billable from here"
  else
    echo "  MISSING  only ${hosts} hosts, expected more than ${HOST_FLOOR}" >&2
    echo "           compute.viewer (stage 1) is what discovers GCE instances." >&2
    return 1
  fi

  # COST IS NOT A FAILURE CONDITION. It lags 48-72h behind everything above, so
  # a missing row on the day of setup is the EXPECTED state — failing the stage
  # for it would train everyone to ignore this stage's exit code.
  if dd_request GET "https://${DD_API_HOST}/api/v2/cost/gcp_uc_config" \
    && BODY="$RESPONSE_BODY" node -e '
      const d = JSON.parse(process.env.BODY || "null");
      process.exit(Array.isArray(d?.data) && d.data.length > 0 ? 0 : 1);
    ' 2>/dev/null; then
    echo "  ARRIVED  cost config is registered"
  else
    echo "  cost: pending — re-run --only=verify after 72h"
  fi

  echo ""
  echo "  Do NOT add gcp.* monitors until the series you intend to alert on have"
  echo "  been seen here. A monitor over a metric nobody emits renders NO DATA, and"
  echo "  once muted that is indistinguishable from health (MONEY-1238)."
}

# ---- run ----------------------------------------------------------------------
$DRY_RUN && echo "DRY RUN — no API is enabled, no binding is granted, nothing is registered." && echo ""

# `if run_stage X; then stage_X; fi`, NEVER `run_stage X && stage_X` — a function
# called in a `&&` list is exempt from errexit for its whole dynamic extent, so
# every `return 1` below would be swallowed and the script would exit 0 no matter
# what happened. Measured on bash 3.2 in setup-dbm-host.sh.
if run_stage apis;     then stage_apis;     echo ""; fi
if run_stage sa;       then stage_sa;       echo ""; fi
if run_stage delegate; then stage_delegate; echo ""; fi
if run_stage register; then stage_register; echo ""; fi
if run_stage cost;     then stage_cost;     echo ""; fi
if run_stage verify;   then stage_verify;   echo ""; fi

echo "done."
