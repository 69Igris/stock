#!/usr/bin/env bash
#
# setup-lake.sh — provision the lake: one bucket, four datasets, three service
# accounts, their IAM (dataset ACLs, project jobUser, and the writer's grant on
# its own bucket — read back after it is made), and a BigQuery budget alert.
# IDEMPOTENT.
#
#   ./scripts/ops/setup-lake.sh qa
#   ./scripts/ops/setup-lake.sh prod --dry-run
#   ./scripts/ops/setup-lake.sh all
#
# The contract this implements is `docs/reference/lake-layout.md`.
# `packages/core/__tests__/ops/lake-infra-coverage.test.ts` reads BOTH and fails
# when they disagree: a resource named in the doc and absent here is a
# provisioning gap, one created here and absent there is undocumented. Neither
# produces an error at run time, which is why a test has to say it.
#
# ── ONE REGION ───────────────────────────────────────────────────────────────
#
# `asia-south1`, everywhere, decided 14-Sep-2026 (plan v2.3 §2). A BigQuery job
# runs in exactly one location and every dataset it touches must be in that
# location, so a second region buys residency and costs a permanent architecture
# of per-market datasets and cross-region copies. The escape hatch is in the
# contract: a US footprint later is a new bucket plus a `bucketForPrefix` entry
# plus a dataset copy — never a redesign.
#
# ── THE LIFECYCLE HAZARD, AND WHY THIS DOES NOT CALL setup-gcs-lifecycle.sh ───
#
# `gcloud storage buckets update --lifecycle-file` REPLACES a bucket's entire
# policy. There is no add, no merge, no patch. So this script does what
# `setup-gcs-lifecycle.sh` does: READ the live policy, MERGE, write the union,
# and treat a FAILED READ AS FATAL — building from an assumed-empty baseline is
# indistinguishable from success and destroys every rule the bucket acquired.
#
# It does not REUSE that script, and that is deliberate. Its `bucket_for()` is
# hardcoded to `stockbook-content-$1` and its PROTECTED_ROOTS encode
# content-bucket semantics (`feeds/`, `candles/`, the learning content).
# Parameterising a script whose safety argument depends on knowing which bucket
# it guards is how that argument gets lost. The DISCIPLINE is copied; the
# blast radius is not shared.
#
# ── WHAT THIS SCRIPT WILL NOT DO ─────────────────────────────────────────────
#
#   * delete or overwrite anything. Every create is guarded by a read.
#   * grant `stockbook-api@` any BigQuery role. The web request path never
#     queries BigQuery (contract §8) and this is the version of that rule that
#     survives someone not having read it.
#   * touch `billing_export`. It is MONEY-1379's Detailed Usage Cost export,
#     it carries the whole project's spend at resource granularity, and no lake
#     service account is granted on it.
#
set -euo pipefail

PROJECT_ID="stock-book-483718"
# PIN THE ACTOR, not only the project. `setup-gcs-lifecycle.sh` records the
# convention: `--project` says WHERE, and without `--account` the script creates
# service accounts and IAM bindings as whatever identity the active gcloud
# config happens to hold — and then binds THAT identity as tokenCreator below.
# Overridable for CI, which will not be the founder.
GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-founder@disdigital.in}"
# `bq` HAS NO `--account` FLAG, so pinning every gcloud call still left the four
# datasets and all seven ACL bindings created by whatever identity the shell
# held. `CLOUDSDK_CORE_ACCOUNT` is the env equivalent and bq honours it, so the
# actor is pinned for both tools rather than for one.
export CLOUDSDK_CORE_ACCOUNT="$GCLOUD_ACCOUNT"
REGION="asia-south1"
BQ_LOCATION="asia-south1"

# ── argv ─────────────────────────────────────────────────────────────────────
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
Usage: ./scripts/ops/setup-lake.sh {qa|prod|all} [--dry-run]

Provisions the lake described by docs/reference/lake-layout.md:
  bucket    stockbook-lake-{env}                 (asia-south1)
  datasets  lake_bronze/silver/gold/private_{env} (asia-south1)
  SAs       lake-writer-{env}, lake-reader-{env}, lake-private-writer-{env},
            lake-dataform-{env}
  budget    $50/mo on BigQuery SKUs

Idempotent: every resource is read before it is created.
USAGE
        exit 1
        ;;
esac

run() {
    if [ "$DRY_RUN" = "1" ]; then
        echo "   DRY-RUN: $*"
    else
        "$@"
    fi
}

sa_email() { echo "$1@${PROJECT_ID}.iam.gserviceaccount.com"; }

# ── the declared shape. The infra test reads these names out of this file. ───
#
# Written as flat lists rather than associative arrays: bash 3.2 (which macOS
# ships, and the founder runs darwin) has no associative arrays.

# BUCKETS: name-base
LAKE_BUCKET_BASE="stockbook-lake"

# DATASETS: suffixes, in the order the contract lists them
DATASETS=(
    "lake_bronze"
    "lake_silver"
    "lake_gold"
    "lake_private"
)

# SERVICE ACCOUNTS: base names, env-suffixed at use.
#
# ENV-SUFFIXED, and this deviates from the S1 brief's single `lake-writer@` on
# purpose. Service accounts are PROJECT-level while the datasets are
# env-suffixed, so one writer run per environment would accumulate dataEditor on
# BOTH environments' datasets — and a misconfigured QA job would then write
# prod. Separating the blast radius is the reason two environments exist.
SA_WRITER_BASE="lake-writer"
SA_READER_BASE="lake-reader"
SA_PRIVATE_BASE="lake-private-writer"
# MONEY-1506 (B4). Dataform executes SQL held in a source repository; it needs
# gold WRITER and silver READER and nothing else. Reusing `lake-writer-{env}`
# would have cost nothing to set up and handed a bad model in a merged .sqlx
# file the ability to drop the BRONZE LEDGER — the one table that records what
# every loader has already done. Its IAM lives HERE rather than in
# setup-dataform.sh so the lake's service accounts have one home and
# `lake-infra-coverage.test.ts` holds all four in agreement with the contract.
SA_DATAFORM_BASE="lake-dataform"

# LIFECYCLE: prefix|action|age — the lake bucket's own rules.
LAKE_LIFECYCLE_RULES=(
    "lake/stage/|Delete|14"
    "rollback/|Delete|45"
)

# THE BUDGET AMOUNT IS IN THE BILLING ACCOUNT'S CURRENCY, WHICH IS NOT USD.
#
# `--budget-amount=50USD` was rejected with a bare `INVALID_ARGUMENT: Request
# contains an invalid argument` — no field, no detail, and the same error
# whether the service filter and threshold rule were present or absent.
# MEASURED 2026-09-15: this billing account ("DIS Billing Credits") has
# `currencyCode: INR`, and a budget must be denominated in the account's own
# currency. The identical call with an INR amount succeeded immediately.
#
# So the currency is READ from the account rather than assumed, and the amount
# is per-currency. An unmapped currency REFUSES rather than guessing: a budget
# in the wrong currency is off by an exchange rate, which is the kind of wrong
# that still creates an alert and still looks configured.
BQ_BUDGET_INR=4500   # ~USD 50 at ~90 INR/USD; the FX is not tracked anywhere
BQ_BUDGET_USD=50

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║  setup-lake.sh — region ${REGION}, project ${PROJECT_ID}"
echo "║  envs: ${ENVS[*]}   dry-run: ${DRY_RUN}"
echo "╚════════════════════════════════════════════════════════════════════╝"

for ENV in "${ENVS[@]}"; do
    BUCKET="${LAKE_BUCKET_BASE}-${ENV}"
    echo ""
    echo "── ${ENV} ─────────────────────────────────────────────────────────"

    # ── 1. BUCKET ────────────────────────────────────────────────────────────
    #
    # Uniform bucket-level access: per-object ACLs make "who can read this" a
    # question with a different answer per object, which is unanswerable at
    # audit time. Versioning OFF: the lake's contents are reproducible from the
    # raw bucket and the ledger, so versions would pay to keep a second copy of
    # something regenerable.
    if gcloud storage buckets describe "gs://${BUCKET}" --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" >/dev/null 2>&1; then
        echo "   bucket gs://${BUCKET} exists"
    else
        echo "   creating gs://${BUCKET} (${REGION})"
        run gcloud storage buckets create "gs://${BUCKET}" \
            --project="$PROJECT_ID" \
            --account="$GCLOUD_ACCOUNT" \
            --location="$REGION" \
            --uniform-bucket-level-access \
            --public-access-prevention
    fi
    run gcloud storage buckets update "gs://${BUCKET}" \
        --project="$PROJECT_ID" \
        --account="$GCLOUD_ACCOUNT" \
        --no-versioning \
        --update-labels="component=lake,env=${ENV},managed-by=setup-lake"

    # ── 1b. LIFECYCLE — read, merge, write the union. A failed read is FATAL. ─
    echo "   lifecycle: reading live policy"
    if [ "$DRY_RUN" = "1" ]; then
        echo "   DRY-RUN: would merge ${#LAKE_LIFECYCLE_RULES[@]} rule(s) into gs://${BUCKET}"
    else
        LIVE_JSON="$(gcloud storage buckets describe "gs://${BUCKET}" \
            --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" --format=json 2>/dev/null)" || {
            echo "   REFUSING: could not read the live lifecycle policy for gs://${BUCKET}." >&2
            echo "   Building from an assumed-empty baseline would DELETE every rule the" >&2
            echo "   bucket has acquired, and that failure is silent — objects simply stop" >&2
            echo "   being cleaned up and the bill arrives weeks later." >&2
            exit 1
        }
        # THE WRITE SHAPE IS `{lifecycle:{rule:[...]}}` AND IT IS CORRECT.
        # setup-gcs-lifecycle.sh carries a comment saying gcloud rejects the
        # wrapped form and takes a top-level `{rule:[...]}`. That comment is
        # STALE. VERIFIED 2026-09-15: `gcloud storage buckets update
        # --lifecycle-file` with the wrapped shape returned exit 0 and the rules
        # are live on gs://stockbook-lake-qa, and this script had already
        # applied them three times. Two code reviews have now looked at this —
        # one confirmed the shape, one re-raised the stale comment as a HIGH
        # finding — so the measurement is recorded here rather than left to be
        # re-litigated.
        MERGED="$(mktemp "${TMPDIR:-/tmp}/lake-lifecycle.XXXXXX")"
        LIVE_JSON="$LIVE_JSON" RULES="$(printf '%s\n' "${LAKE_LIFECYCLE_RULES[@]}")" \
            node -e '
              const live = JSON.parse(process.env.LIVE_JSON || "{}");
              // THE KEY IS `lifecycle_config`, NOT `lifecycle`. Verified live
              // 2026-09-15: `gcloud storage buckets describe --format=json`
              // emits `lifecycle_config`, and gcloud maps it that way in
              // api_lib/storage/gcs_json/metadata_util.py. Reading `.lifecycle`
              // returned undefined on EVERY call, so `existing` was always []
              // and the `--lifecycle-file` write two lines down REPLACED the
              // whole policy with just the two declared rules — silently
              // destroying every rule the bucket had acquired. That is exactly
              // the failure this files header swears it prevents, and the
              // failed-READ guard above gave false confidence because the read
              // SUCCEEDS.
              //
              // Accept every spelling, and REFUSE a present-but-unrecognised
              // shape rather than reading it as empty. Same handling as
              // setup-gcs-lifecycle.sh — copied, not re-derived.
              const LIFECYCLE_KEYS = ["lifecycle_config", "lifecycle", "lifecycleConfig"];
              const presentKey = LIFECYCLE_KEYS.find((k) => live[k] != null);
              let existing = [];
              if (presentKey !== undefined) {
                const raw = live[presentKey];
                if (Array.isArray(raw)) existing = raw;
                else if (raw && Array.isArray(raw.rule)) existing = raw.rule;
                else if (raw && Array.isArray(raw.rules)) existing = raw.rules;
                else {
                  console.error(
                    "   REFUSING: " + presentKey + " is present but not a rule list (" +
                      JSON.stringify(raw).slice(0, 200) + "). Treating it as empty would DELETE it.",
                  );
                  process.exit(1);
                }
              }
              const want = (process.env.RULES || "").split("\n").filter(Boolean).map((line) => {
                const [prefix, action, age] = line.split("|");
                return { action: { type: action }, condition: { age: Number(age), matchesPrefix: [prefix] } };
              });
              // NORMALISED key: a raw JSON.stringify is key-ORDER sensitive, so a
              // live rule whose condition serialises differently (or carries an
              // extra field like matchesStorageClass) would be appended again on
              // every run and the IDEMPOTENT claim would quietly break.
              const norm = (v) =>
                Array.isArray(v)
                  ? v.map(norm)
                  : v && typeof v === "object"
                    ? Object.keys(v).sort().reduce((o, k) => ((o[k] = norm(v[k])), o), {})
                    : v;
              const key = (r) => JSON.stringify(norm([r.action, r.condition]));
              const seen = new Set(existing.map(key));
              const merged = existing.concat(want.filter((r) => !seen.has(key(r))));
              require("fs").writeFileSync(process.argv[1], JSON.stringify({ lifecycle: { rule: merged } }, null, 2));
              console.error(`   lifecycle: ${existing.length} live + ${merged.length - existing.length} new = ${merged.length}`);
            ' "$MERGED"
        gcloud storage buckets update "gs://${BUCKET}" \
            --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" --lifecycle-file="$MERGED"
        rm -f "$MERGED"
    fi

    # ── 2. DATASETS ──────────────────────────────────────────────────────────
    #
    # Default table expiration is OFF on all four. A dataset-level default
    # silently attaches an expiry to every table created afterwards, including
    # by a prompt whose author never read the contract — and a table that
    # vanishes fails no test and raises no alert.
    for DS_BASE in "${DATASETS[@]}"; do
        DS="${DS_BASE}_${ENV}"
        if bq --project_id="$PROJECT_ID" show --dataset "${PROJECT_ID}:${DS}" >/dev/null 2>&1; then
            echo "   dataset ${DS} exists"
        else
            echo "   creating dataset ${DS} (${BQ_LOCATION}, no default expiration)"
            run bq --project_id="$PROJECT_ID" mk \
                --dataset \
                --location="$BQ_LOCATION" \
                --description="Lake ${DS_BASE#lake_} tier for ${ENV}. Contract: docs/reference/lake-layout.md" \
                "${PROJECT_ID}:${DS}"
        fi
    done

    # ── 3. SERVICE ACCOUNTS ──────────────────────────────────────────────────
    for PAIR in \
        "${SA_WRITER_BASE}-${ENV}|lake writer (${ENV}): bronze/silver/gold dataEditor + jobUser" \
        "${SA_READER_BASE}-${ENV}|lake reader (${ENV}): silver/gold dataViewer" \
        "${SA_PRIVATE_BASE}-${ENV}|lake private writer (${ENV}): lake_private_${ENV} only" \
        "${SA_DATAFORM_BASE}-${ENV}|lake dataform (${ENV}): gold dataEditor + silver dataViewer"
    do
        SA_NAME="${PAIR%%|*}"
        SA_DESC="${PAIR#*|}"
        SA="$(sa_email "$SA_NAME")"
        if gcloud iam service-accounts describe "$SA" --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" >/dev/null 2>&1; then
            echo "   service account ${SA_NAME} exists"
        else
            echo "   creating service account ${SA_NAME}"
            run gcloud iam service-accounts create "$SA_NAME" \
                --project="$PROJECT_ID" \
                --account="$GCLOUD_ACCOUNT" \
                --display-name="$SA_DESC"
        fi
    done

    WRITER="$(sa_email "${SA_WRITER_BASE}-${ENV}")"
    READER="$(sa_email "${SA_READER_BASE}-${ENV}")"
    PRIVATE="$(sa_email "${SA_PRIVATE_BASE}-${ENV}")"
    DATAFORM="$(sa_email "${SA_DATAFORM_BASE}-${ENV}")"

    # ── 4. IAM — dataset-level, never project-level ──────────────────────────
    #
    # A project-level roles/bigquery.dataEditor would reach `billing_export` and
    # every dataset created afterwards, including the other environment's.
    # Dataset-level bindings are the only ones that express "this env, these
    # tiers".
    grant_dataset() {
        local DS="$1" MEMBER="$2" ROLE="$3"
        echo "   grant ${ROLE} on ${DS} -> ${MEMBER%%@*}"
        if [ "$DRY_RUN" = "1" ]; then
            echo "   DRY-RUN: bq update --dataset (add ${ROLE})"
            return
        fi
        local TMP
        TMP="$(mktemp "${TMPDIR:-/tmp}/lake-ds.XXXXXX")"
        bq --project_id="$PROJECT_ID" show --format=prettyjson "${PROJECT_ID}:${DS}" > "$TMP"
        MEMBER="$MEMBER" ROLE="$ROLE" node -e '
          const fs = require("fs");
          const f = process.argv[1];
          const ds = JSON.parse(fs.readFileSync(f, "utf8"));
          ds.access = ds.access || [];
          const want = { role: process.env.ROLE, userByEmail: process.env.MEMBER };
          // MERGE, never replace: `bq update` rewrites the whole access list, so
          // building it from scratch would drop every binding the dataset has.
          const has = ds.access.some((a) => a.role === want.role && a.userByEmail === want.userByEmail);
          if (!has) ds.access.push(want);
          fs.writeFileSync(f, JSON.stringify(ds));
          console.error(has ? "     (already granted)" : "     (added)");
        ' "$TMP"
        bq --project_id="$PROJECT_ID" update --source "$TMP" "${PROJECT_ID}:${DS}" >/dev/null
        rm -f "$TMP"
    }

    for TIER in bronze silver gold; do
        grant_dataset "lake_${TIER}_${ENV}" "$WRITER" "WRITER"
    done
    for TIER in silver gold; do
        grant_dataset "lake_${TIER}_${ENV}" "$READER" "READER"
    done
    grant_dataset "lake_private_${ENV}" "$PRIVATE" "WRITER"
    # Dataform: WRITER on gold (it creates and replaces the views there) and
    # READER on silver (it reads price_bar_d1 / corporate_action / listing).
    # NEVER bronze — the ledger is a loader's record of what has been done, and
    # a SQL project has no business in it.
    grant_dataset "lake_gold_${ENV}" "$DATAFORM" "WRITER"
    grant_dataset "lake_silver_${ENV}" "$DATAFORM" "READER"

    # ── 4b. IMPERSONATION, scoped to the SA and to the operator ─────────────
    #
    # `lake-smoke.ts` proves the writer can actually run a job in the right
    # location with the right grants, and it can only do that by ACTING AS the
    # writer. Without this binding the smoke test authenticates as the operator
    # and proves nothing about the service account — a SA nobody can act as is a
    # SA whose grants are unverifiable until the first real job fails.
    #
    # Scoped to THIS service account, not granted project-wide: a project-level
    # tokenCreator would confer impersonation of every SA in the project,
    # including `stockbook-api@`.
    OPERATOR="$GCLOUD_ACCOUNT"
    if [ -n "$OPERATOR" ]; then
        echo "   grant roles/iam.serviceAccountTokenCreator on ${SA_WRITER_BASE}-${ENV} -> ${OPERATOR}"
        # BEST-EFFORT, and `|| echo` is load-bearing under `set -e`. The `else`
        # branch already treats a missing operator as skippable, but an
        # unguarded failure here (a service-account credential, for which
        # `user:` is the wrong prefix; or an operator without
        # iam.serviceAccounts.setIamPolicy) would abort the script BEFORE the
        # project-level jobUser grant below — leaving the writer with dataset
        # access and unable to run a job at all.
        run gcloud iam service-accounts add-iam-policy-binding "$WRITER" \
            --project="$PROJECT_ID" \
            --account="$GCLOUD_ACCOUNT" \
            --member="user:${OPERATOR}" \
            --role="roles/iam.serviceAccountTokenCreator" \
            --quiet || echo "   impersonation grant SKIPPED (lake-smoke will not run as the SA)"
    else
        # Unreachable while GCLOUD_ACCOUNT has a default; kept so that setting
        # GCLOUD_ACCOUNT= empty in CI degrades to a named skip rather than
        # binding an empty member.
        echo "   SKIPPED impersonation grant — GCLOUD_ACCOUNT is empty; lake-smoke will not run as the SA."
    fi

    # jobUser is a PROJECT-level role by design — running a query is a project
    # operation, not a dataset one. It confers NO data access on its own, which
    # is why all three get it.
    #
    # ALL THREE, not just the writer. `bigquery.jobs.create` is required to run
    # ANY query or load job, so granting it only to the writer left
    # `lake-reader-{env}` unable to `SELECT` from the silver/gold it can see and
    # `lake-private-writer-{env}` unable to run the load job that would write
    # the dataset it owns. Both were provisioned unusable, and it surfaces as
    # `Access Denied: User does not have bigquery.jobs.create permission` at
    # first real use — `lake-smoke` exercises only the writer, so it certified
    # green over two broken accounts.
    for SA_JOB in "$WRITER" "$READER" "$PRIVATE" "$DATAFORM"; do
        echo "   grant roles/bigquery.jobUser (project) -> ${SA_JOB%%@*}"
        run gcloud projects add-iam-policy-binding "$PROJECT_ID" \
            --account="$GCLOUD_ACCOUNT" \
            --member="serviceAccount:${SA_JOB}" \
            --role="roles/bigquery.jobUser" \
            --condition=None \
            --quiet
    done

    # ── 4c. BUCKET IAM — the writer on its OWN bucket (MONEY-1533 / 1518) ─────
    #
    # Measured 2026-09-23: `lake-writer-{env}@` held NOTHING on
    # gs://stockbook-lake-{env} — the bucket's policy named project
    # owners/editors and read-only grants for market-data@, stockbook-api@ and
    # sync-prod-to-qa@. So every job that actually runs AS the writer failed at
    # its first GCS step: the `lake/stage/` upload of lake-replay-in,
    # lake-replay-us and filing-registry-sync, and lake-release's EXPORT DATA,
    # which BigQuery writes to GCS as the CALLER.
    #
    # objectCreator + objectViewer, NOT objectAdmin:
    #   create    stage uploads, EXPORT DATA's parquet, a release's manifest.json
    #   get/list  a BigQuery LOAD job reads the staged object as the CALLER, and
    #             lake-release lists and re-reads what it exported (sha256, --verify)
    #   delete    NOT granted. Nothing in the design deletes: `lake/stage/` is
    #             cleared by its 14-day lifecycle rule and a stage key carries
    #             the run id. Without delete the writer cannot OVERWRITE either,
    #             which makes a release's immutability an IAM fact on top of
    #             EXPORT DATA's `overwrite = false`.
    # The one open question: BigQuery's export documentation lists
    # storage.objects.delete among the permissions an export may use. If the
    # first release cut refuses on exactly that permission, swap objectCreator
    # for roles/storage.objectUser HERE, knowingly — it adds delete.
    #
    # BUCKET-level, so it covers every prefix of THIS env's bucket and nothing
    # of the other env's: the SA is env-suffixed for exactly that reason.
    for BUCKET_ROLE in roles/storage.objectCreator roles/storage.objectViewer; do
        echo "   grant ${BUCKET_ROLE} on gs://${BUCKET} -> ${SA_WRITER_BASE}-${ENV}"
        run gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
            --project="$PROJECT_ID" \
            --account="$GCLOUD_ACCOUNT" \
            --member="serviceAccount:${WRITER}" \
            --role="$BUCKET_ROLE" \
            --quiet
    done
    # READ IT BACK. A binding call that exits 0 is not a policy that holds the
    # member — the same lesson the lifecycle merge above learned about a read
    # that succeeds. Unconditional bindings only: a CONDITIONED binding may not
    # cover the prefix a job writes, and would pass a name check while failing
    # at the first upload.
    if [ "$DRY_RUN" = "1" ]; then
        echo "   DRY-RUN: would read gs://${BUCKET}'s IAM back and require both roles"
    else
        BUCKET_IAM="$(gcloud storage buckets get-iam-policy "gs://${BUCKET}" \
            --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" --format=json)"
        BUCKET_IAM="$BUCKET_IAM" MEMBER="serviceAccount:${WRITER}" node -e '
          const policy = JSON.parse(process.env.BUCKET_IAM || "{}");
          const want = ["roles/storage.objectCreator", "roles/storage.objectViewer"];
          const holds = (role) => (policy.bindings || []).some(
            (b) => b.role === role && !b.condition && (b.members || []).includes(process.env.MEMBER),
          );
          const missing = want.filter((r) => !holds(r));
          if (missing.length > 0) {
            console.error(`   REFUSING: gs:// bucket IAM read back WITHOUT ${missing.join(", ")} for ${process.env.MEMBER}.`);
            process.exit(1);
          }
          console.error(`   verify: bucket IAM read back — ${process.env.MEMBER} holds ${want.join(" + ")}`);
        '
    fi

    # ── 5. BUDGET ────────────────────────────────────────────────────────────
    #
    # Attempted, and skipped LOUDLY when it cannot be done. Measured 2026-09-15:
    # `billingbudgets.googleapis.com` is NOT enabled, and budget creation needs
    # BILLING ACCOUNT permissions rather than project ones. A budget nobody
    # created is indistinguishable from a budget that never fired, so this
    # prints the exact command rather than failing quietly.
    BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT_ID" \
        --account="$GCLOUD_ACCOUNT" --format='value(billingAccountName)' 2>/dev/null || true)"
    if [ -z "$BILLING_ACCOUNT" ]; then
        echo "   BUDGET SKIPPED — could not read the billing account for ${PROJECT_ID}."
        echo "   FOUNDER STEP (needs Billing Account Administrator):"
        echo "     gcloud services enable billingbudgets.googleapis.com --project=${PROJECT_ID}"
        echo "     gcloud billing budgets create --billing-account=<ACCOUNT> \\"
        echo "       --display-name='BigQuery ${PROJECT_ID} <AMOUNT>/mo' \\"
        # NOT $BUDGET_AMOUNT. It is assigned only in the `else` branch below, so
        # under `set -u` this line ABORTED the script at exit 1 — precisely
        # where it meant to hand the founder a command to run. Worse on `all`:
        # the second environment would inherit the FIRST one's value instead of
        # aborting, printing a currency nobody had read for that account.
        #
        # The amount cannot be resolved here BY DEFINITION — the currency is
        # read from the billing account, and this branch is the one where the
        # billing account could not be read. So both mapped amounts are named
        # and the operator picks; a guess would be off by an exchange rate and
        # still look configured.
        echo "       --budget-amount=${BQ_BUDGET_INR}INR \\"
        echo "       --filter-services=services/24E6-581D-38E5"
        echo "   (that amount is INR; use ${BQ_BUDGET_USD}USD if the account currency is USD —"
        echo "    a budget in the wrong currency is off by an exchange rate and still looks set)"
    else
        echo "   budget: billing account ${BILLING_ACCOUNT##*/} readable"
        # IDEMPOTENT, like every other create here. The budget was the one that
        # was not: re-running `setup-lake.sh prod` made a SECOND $50 budget, and
        # `all` made two that measure the identical thing — qa and prod share
        # one GCP project, the filter carries no `--filter-projects` and no env
        # dimension, so doc §11's "per environment" is not expressible in this
        # call shape at all. One budget, named for the PROJECT, guarded by a
        # list.
        BUDGET_CURRENCY="$(gcloud billing accounts describe "${BILLING_ACCOUNT##*/}" \
            --account="$GCLOUD_ACCOUNT" --format='value(currencyCode)' 2>/dev/null || true)"
        case "$BUDGET_CURRENCY" in
            INR) BUDGET_AMOUNT="${BQ_BUDGET_INR}INR" ;;
            USD) BUDGET_AMOUNT="${BQ_BUDGET_USD}USD" ;;
            *)
                echo "   BUDGET SKIPPED — billing account currency is" \
                     "\"${BUDGET_CURRENCY:-unreadable}\", which has no amount mapped."
                echo "   Add it to the case in setup-lake.sh rather than guessing: a budget in"
                echo "   the wrong currency is off by an exchange rate and still looks configured."
                BUDGET_AMOUNT=""
                ;;
        esac
        BUDGET_NAME="BigQuery ${PROJECT_ID} ${BUDGET_AMOUNT}/mo"
        if [ -z "$BUDGET_AMOUNT" ]; then
            : # currency unmapped — the case above already explained why
        elif gcloud billing budgets list --billing-account="${BILLING_ACCOUNT##*/}" \
            --account="$GCLOUD_ACCOUNT" --format="value(displayName)" 2>/dev/null \
            | grep -qxF "$BUDGET_NAME"; then
            echo "   budget \"$BUDGET_NAME\" exists"
        else
            echo "   creating budget \"$BUDGET_NAME\""
        # ATTEMPTED, because the header, the usage block and lake-layout.md §11
        # all say it is. Three places promising an attempt that never happened is
        # the doc-vs-script drift the coverage test exists for, one layer up —
        # and that test now asserts this call is present.
            # stderr is KEPT. It is the only thing that distinguishes a
            # disabled API from a missing role from a rejected flag from a
            # duplicate name, and the header promises this skips LOUDLY — a
            # hardcoded guess is not loud, it is confident.
            BUDGET_ERR="$(mktemp "${TMPDIR:-/tmp}/lake-budget.XXXXXX")"
            run gcloud billing budgets create \
                --billing-account="${BILLING_ACCOUNT##*/}" \
                --account="$GCLOUD_ACCOUNT" \
                --display-name="$BUDGET_NAME" \
                --budget-amount="$BUDGET_AMOUNT" \
                --threshold-rule=percent=0.5 \
                --threshold-rule=percent=0.9 \
                --threshold-rule=percent=1.0 \
                --filter-services="services/24E6-581D-38E5" \
                --quiet 2>"$BUDGET_ERR" || {
                echo "   BUDGET NOT CREATED. gcloud said:"
                sed 's/^/     /' "$BUDGET_ERR" | head -6
                echo "   FOUNDER STEP (needs the billingbudgets API + Billing Account Administrator):"
                echo "     gcloud services enable billingbudgets.googleapis.com --project=${PROJECT_ID}"
                echo "     gcloud billing budgets create --billing-account=${BILLING_ACCOUNT##*/} \\"
                echo "       --display-name='$BUDGET_NAME' \\"
                echo "       --budget-amount=$BUDGET_AMOUNT --filter-services=services/24E6-581D-38E5"
            }
            rm -f "$BUDGET_ERR"
        fi
    fi
done

echo ""
echo "── verify ───────────────────────────────────────────────────────────"
echo "   bq --project_id=${PROJECT_ID} ls"
echo "   npx tsx scripts/ops/lake-smoke.ts qa"
echo ""
echo "stockbook-api@ was granted NOTHING on BigQuery — the web request path"
echo "never queries it (docs/reference/lake-layout.md §8)."
