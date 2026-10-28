#!/usr/bin/env bash
#
# setup-cloudbuild-triggers.sh — provision the Cloud Build triggers for
# `services/us-fundamentals` (MONEY-979).
#
# ── WHY THIS SCRIPT EXISTS ────────────────────────────────────────────────────
#
# `setup-infra.sh <env>` SUBMITS a build by hand. A TRIGGER is what builds on a
# push, and until now every trigger in this project was created by hand in the
# console. That is fine exactly once: the second person to need one has no
# record of what the first one did, and a service whose trigger was never
# created deploys only when somebody remembers to run a script — which is the
# same failure shape as a Cloud Run JOB pinned to a stale image, one layer up.
#
# ── A TRIGGER WITH NO `includedFiles` REBUILDS ON EVERY PUSH TO ITS BRANCH ─────
#
# This is the single fact the whole file is arranged around. `includedFiles` is
# a build-time FILTER: absent, Cloud Build fires the trigger for every commit
# that lands on the branch pattern, whatever it touched. That is why the two NEW
# triggers declare `services/us-fundamentals/**` — without it, a one-line change
# to `apps/web` would rebuild and REDEPLOY a Python service that did not change,
# rolling a new Cloud Run revision (and a new DD_VERSION) for no reason, and
# re-pinning four Cloud Run jobs while it was at it.
#
# It is also why the two EXISTING worker triggers arguably need one. They do not
# have one — see MEASURED below — so today a push touching only
# `services/us-fundamentals/**` rebuilds the TypeScript workers too. Adding the
# filter to them is a separate, deliberate change: see DO NOT CLOBBER.
#
# ── MEASURED, 2026-08-29 (`gcloud builds triggers list --format=json`) ─────────
#
#   name                    branch      build-config                     included
#   stockbook-worker-prod   ^release$   workers/cloudbuild.prod.yaml     (none)
#   stockbook-workers-qa    ^main$      workers/cloudbuild.qa.yaml       (none)
#
# Both are 1st-gen GitHub App triggers on `UseMoney-AI/stockbook-monorepo`, both
# in region `global` (their resourceName is `.../locations/global/triggers/…`),
# and both run as `stockbook-api@stock-book-483718.iam.gserviceaccount.com`.
# The constants below are those measurements, not guesses.
#
# A trigger that runs as a user-specified service account MUST have a logging
# option set in its build config, or the build fails at submit time with
# "build.service_account requires logging". Both `services/us-fundamentals`
# specs already carry `options.logging: CLOUD_LOGGING_ONLY`, so this is met —
# but a NEW spec that forgets it will fail on its first trigger fire and not
# before.
#
# ── DO NOT CLOBBER THE TWO EXISTING TRIGGERS ─────────────────────────────────
#
# >>> ADDING A FILTER TO AN EXISTING TRIGGER CHANGES WHEN IT FIRES. <<<
#
# That is a BEHAVIOUR CHANGE to production's release path, not a tidy-up. A
# workers trigger that suddenly ignores commits outside `workers/**` would stop
# rebuilding on a change to `packages/core` — which the workers image bundles —
# and the symptom is a release that appears to succeed while shipping last
# week's business logic. Whether the right filter is `workers/**` or
# `workers/**,packages/**,package.json,yarn.lock,turbo.json` is a question about
# what that Dockerfile actually compiles, and it must be answered and approved
# on its own.
#
# So this script MANAGES ONLY THE TWO NEW TRIGGERS. For the existing two it
# READS their current state and PRINTS the command that would add a filter,
# clearly marked as not executed. Nothing here ever writes to them.
#
# ── IDEMPOTENCY ───────────────────────────────────────────────────────────────
#
# One LIST per run (`--format=json`, shape-validated), then per trigger:
# `update github <name>` when it is already there, `create github` when it is
# not. `create` on an existing name fails with ALREADY_EXISTS, and a script that
# tolerated that would leave the trigger on whatever config it had — so the
# create/update decision is made from the listing rather than from an error.
#
# A listing that FAILS, or that comes back as anything other than a JSON array,
# is FATAL. Read as "no triggers exist", either one would CREATE a second
# trigger with the same name and the same branch pattern, and every push would
# then build twice. That is `apply-monitors.sh`'s bug, one product over.
#
# Usage:
#   ./scripts/ops/setup-cloudbuild-triggers.sh qa
#   ./scripts/ops/setup-cloudbuild-triggers.sh prod
#   ./scripts/ops/setup-cloudbuild-triggers.sh all
#   ./scripts/ops/setup-cloudbuild-triggers.sh all --dry-run
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
# 1st-gen GitHub triggers live in the `global` location. Passed EXPLICITLY on
# every call: `gcloud builds triggers` defaults to global today, but a default
# that changes turns "update the trigger" into "create a second one in another
# region", and the two would both fire.
TRIGGER_REGION="global"
REPO_OWNER="UseMoney-AI"
REPO_NAME="stockbook-monorepo"
TRIGGER_SA="projects/${PROJECT_ID}/serviceAccounts/stockbook-api@${PROJECT_ID}.iam.gserviceaccount.com"

# ── THE SERVICES THIS SCRIPT OWNS ────────────────────────────────────────────
#
# `key|trigger-prefix|config-dir|included-files`. One row per DEPLOYABLE, so a
# new service is a line rather than a second copy of this file.
#
# `--included-files` is a comma-separated GLOB list, and it is the whole point:
# without it a trigger fires on every push to the branch and redeploys a service
# that did not change.
#
# MONEY-1478 — `market-data` had NO TRIGGER AT ALL. Every deploy of
# `usemoney-market-data-{env}` had been a hand-run `gcloud builds submit`, and
# the drift that produces is not theoretical: measured 2026-09-18, QA was
# running `qa-20c00972` while main was three commits ahead, missing MONEY-1471,
# 1474 and 1475 — all of which touched `apps/market-data` or
# `packages/core/src/market-data`. Prod was current only by coincidence of
# someone having submitted it.
#
# ITS FILTER INCLUDES `packages/**`, and that is deliberate rather than broad:
# the service imports `@usemoney/core` for the tile logic, the UDF contract and
# the quote store, so a core-only change alters what it serves while leaving
# `apps/market-data/**` untouched. That is exactly the shape of the three
# commits QA had missed. `stockbook-workers-*` already filters the same way for
# the same reason.
declare -a SERVICES=(
    "us-fundamentals|us-fundamentals|services/us-fundamentals|services/us-fundamentals/**"
    "market-data|market-data|apps/market-data|apps/market-data/**,packages/**,package.json,yarn.lock,turbo.json"
)

svc_field() {
    # $1 = service key, $2 = 1-based field index
    local row
    for row in "${SERVICES[@]}"; do
        if [ "${row%%|*}" = "$1" ]; then
            echo "$row" | cut -d"|" -f"$2"
            return 0
        fi
    done
    echo "unknown service: $1" >&2
    return 1
}

# Per the repo's GCP isolation rule: never activate a config, always pass the
# account/project explicitly on each call.
GC=(gcloud --project="$PROJECT_ID" --account=founder@disdigital.in)

ENV_ARG=${1:-""}
shift || true
DRY_RUN=false

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

case "$ENV_ARG" in
    qa)   ENVS=("qa") ;;
    prod) ENVS=("prod") ;;
    all)  ENVS=("qa" "prod") ;;
    *)
        echo "Usage: $0 {qa|prod|all} [--dry-run]"
        echo
        echo "Provisions the managed Cloud Build triggers:"
        for ROW in "${SERVICES[@]}"; do
            KEY="${ROW%%|*}"
            echo "  $(svc_field "$KEY" 2)-qa    ^main\$     $(svc_field "$KEY" 3)/cloudbuild.qa.yaml"
            echo "  $(svc_field "$KEY" 2)-prod  ^release\$  $(svc_field "$KEY" 3)/cloudbuild.prod.yaml"
            echo "      included: $(svc_field "$KEY" 4)"
        done
        echo
        echo "The two EXISTING worker triggers are READ and REPORTED, never written."
        exit 1
        ;;
esac

# ── The triggers this script owns ────────────────────────────────────────────
#
# `name|branch-pattern|build-config`. The branch patterns match the two existing
# worker triggers exactly — QA is built from `main`, prod from `release` — so
# one merge builds both deployables of an environment and there is one release
# ritual rather than two.
trigger_name()   { echo "$(svc_field "$2" 2)-$1"; }
branch_pattern() { [ "$1" = "prod" ] && echo '^release$' || echo '^main$'; }
build_config()   { echo "$(svc_field "$2" 3)/cloudbuild.$1.yaml"; }
included_files() { svc_field "$1" 4; }

# The two triggers this script must NEVER write to.
declare -a UNMANAGED_TRIGGERS=("stockbook-worker-prod" "stockbook-workers-qa")

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Cloud Build triggers — managed services   ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Project: ${PROJECT_ID}"
echo "║  Repo:    ${REPO_OWNER}/${REPO_NAME}"
echo "║  Region:  ${TRIGGER_REGION}"
echo "║  Mode:    $([ "$DRY_RUN" = true ] && echo "DRY RUN (no writes)" || echo "APPLY")"
echo "╚════════════════════════════════════════════╝"
echo ""

# ── 1. One listing for the whole run ─────────────────────────────────────────
echo -e "${BLUE}━━━ 1/3: Read the live triggers ━━━${NC}"

LISTING=""
LISTING_OK=false
if LISTING="$("${GC[@]}" builds triggers list --region="$TRIGGER_REGION" --format=json 2>/dev/null)"; then
    # Validate the SHAPE, not just the exit status. A command that answers 0
    # with an error blob would be read as "no triggers exist" by the lookup
    # below, and every trigger would be CREATED a second time — the duplication
    # this listing exists to prevent, arrived at through the door marked
    # success.
    if LISTING_JSON="$LISTING" node -e '
      const v = JSON.parse(process.env.LISTING_JSON);
      if (!Array.isArray(v)) throw new Error("expected an array of triggers");
    ' 2>/dev/null; then
        LISTING_OK=true
    fi
fi

if [ "$LISTING_OK" != true ]; then
    if [ "$DRY_RUN" = true ]; then
        # A dry run must stay runnable without credentials — it is the form a
        # reviewer runs. It says so rather than pretending it read anything.
        echo -e "   ${YELLOW}Could not read the live triggers (no auth, or the API is unreachable).${NC}"
        echo -e "   ${YELLOW}Printing the CREATE form for every trigger; a live run decides"
        echo -e "   create-vs-update from the real listing.${NC}"
        LISTING="[]"
    else
        # FATAL on a live run, for the reason in the header.
        echo -e "   ${RED}FATAL: could not list Cloud Build triggers.${NC}" >&2
        echo -e "   Refusing to continue: a run that cannot see the existing triggers" >&2
        echo -e "   would CREATE duplicates of them, and every push would build twice." >&2
        exit 1
    fi
else
    COUNT="$(LISTING_JSON="$LISTING" node -e '
      process.stdout.write(String(JSON.parse(process.env.LISTING_JSON).length));
    ')"
    echo -e "   ${GREEN}${COUNT} trigger(s) in ${TRIGGER_REGION}${NC}"
fi

trigger_exists() {
    LISTING_JSON="$LISTING" WANT="$1" node -e '
      const list = JSON.parse(process.env.LISTING_JSON);
      const hit = list.find((t) => t && t.name === process.env.WANT);
      process.stdout.write(hit ? "yes" : "");
    '
}

trigger_field() {
    LISTING_JSON="$LISTING" WANT="$1" FIELD="$2" node -e '
      const list = JSON.parse(process.env.LISTING_JSON);
      const hit = list.find((t) => t && t.name === process.env.WANT);
      let v = hit;
      for (const k of process.env.FIELD.split(".")) {
        v = v == null ? undefined : v[k];
      }
      process.stdout.write(
        v == null ? "" : Array.isArray(v) ? v.join(",") : String(v),
      );
    '
}

# ── 2. Create or update the two NEW triggers ─────────────────────────────────
echo ""
echo -e "${BLUE}━━━ 2/3: managed triggers ━━━${NC}"

APPLIED=0
declare -a FAILED=()

for ROW in "${SERVICES[@]}"; do
  SVC="${ROW%%|*}"
  for ENV in "${ENVS[@]}"; do
    NAME="$(trigger_name "$ENV" "$SVC")"
    BRANCH="$(branch_pattern "$ENV")"
    CONFIG="$(build_config "$ENV" "$SVC")"
    INCLUDED_FILES="$(included_files "$SVC")"

    # The build config must EXIST in the tree this script was run from. Cloud
    # Build resolves the path at fire time against the pushed commit, so a
    # typo here is a trigger that fires and immediately fails — visible only in
    # the build log of a release nobody is watching.
    HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    ROOT_DIR="$(cd "$HERE/../.." && pwd)"
    if [ ! -f "${ROOT_DIR}/${CONFIG}" ]; then
        echo -e "   ${RED}FATAL: ${CONFIG} does not exist in this checkout${NC}" >&2
        exit 1
    fi

    if [ -n "$(trigger_exists "$NAME")" ]; then
        ACTION=(builds triggers update github "$NAME" --region="$TRIGGER_REGION")
        VERB="update"
    else
        ACTION=(builds triggers create github --name="$NAME" --region="$TRIGGER_REGION")
        VERB="create"
    fi

    ACTION+=(
        --repo-owner="$REPO_OWNER"
        --repo-name="$REPO_NAME"
        --branch-pattern="$BRANCH"
        --build-config="$CONFIG"
        # THE WHOLE POINT. Without this the trigger fires on every push to
        # ${BRANCH}, rebuilding and redeploying a service that did not change.
        --included-files="$INCLUDED_FILES"
        # Matches the two existing worker triggers. A trigger with no explicit
        # service account runs as the legacy Cloud Build SA, which is a
        # different principal with different grants — and the difference only
        # shows up as a permission denial on the first fire.
        --service-account="$TRIGGER_SA"
    )

    if [ "$DRY_RUN" = true ]; then
        echo -e "   ${YELLOW}[dry-run] ${VERB}${NC} ${NAME}"
        echo "     gcloud ${ACTION[*]}"
        APPLIED=$((APPLIED + 1))
        continue
    fi

    echo -e "   ${VERB}: ${NAME}  (${BRANCH} -> ${CONFIG})"
    if "${GC[@]}" "${ACTION[@]}" >/dev/null; then
        echo -e "   ${GREEN}OK${NC} ${NAME}"
        APPLIED=$((APPLIED + 1))
    else
        echo -e "   ${RED}FAILED${NC} ${NAME}" >&2
        FAILED+=("$NAME")
    fi
  done
done

# ── 3. The two EXISTING triggers — reported, never written ───────────────────
echo ""
echo -e "${BLUE}━━━ 3/3: existing worker triggers (READ ONLY) ━━━${NC}"

for NAME in "${UNMANAGED_TRIGGERS[@]}"; do
    if [ -z "$(trigger_exists "$NAME")" ]; then
        echo -e "   ${YELLOW}${NAME}: not found in the listing (nothing to report)${NC}"
        continue
    fi
    CUR_BRANCH="$(trigger_field "$NAME" "github.push.branch")"
    CUR_CONFIG="$(trigger_field "$NAME" "filename")"
    CUR_INCLUDED="$(trigger_field "$NAME" "includedFiles")"
    if [ -n "$CUR_INCLUDED" ]; then
        echo -e "   ${GREEN}${NAME}${NC}  ${CUR_BRANCH} -> ${CUR_CONFIG}  included: ${CUR_INCLUDED}"
        continue
    fi
    echo -e "   ${YELLOW}${NAME}${NC}  ${CUR_BRANCH} -> ${CUR_CONFIG}  ${RED}included: NONE${NC}"
    echo -e "   ${YELLOW}   -> fires on EVERY push to ${CUR_BRANCH}, including commits that only"
    echo -e "      touch services/us-fundamentals/**.${NC}"
    echo "      NOT RUN by this script. Adding a filter CHANGES WHEN IT FIRES, which"
    echo "      is a behaviour change to the release path and needs its own approval"
    echo "      (the workers image bundles packages/**, so 'workers/**' alone is"
    echo "      almost certainly too narrow):"
    echo
    echo "        gcloud builds triggers update github ${NAME} \\"
    echo "          --region=${TRIGGER_REGION} --project=${PROJECT_ID} \\"
    echo "          --account=founder@disdigital.in \\"
    echo "          --included-files='workers/**,packages/**,package.json,yarn.lock,turbo.json'"
    echo
done

if ((${#FAILED[@]} > 0)); then
    echo >&2
    echo "${#FAILED[@]} trigger(s) did NOT apply:" >&2
    for f in "${FAILED[@]}"; do echo "  - $f" >&2; done
    exit 1
fi

# Count, not absence-of-error. "No failures recorded" and "every trigger was
# reached" are different facts, and a loop that ended early records nothing.
# EXPECTED is services x envs now, not envs. A count that still assumed one
# service would fire on every healthy run the moment a second one was added —
# and this check exists to catch a loop that DIED half-way, so it has to move
# with the loop or it only ever reports itself.
EXPECTED=$(( ${#SERVICES[@]} * ${#ENVS[@]} ))
if ((APPLIED != EXPECTED)); then
    echo "FATAL: ${APPLIED} applied != ${EXPECTED} requested — the loop did not complete" >&2
    exit 1
fi

cat <<EOF

────────────────────────────────────────────────────────────────
${APPLIED} managed trigger(s) $([ "$DRY_RUN" = true ] && echo "would be applied" || echo "applied").

  us-fundamentals-{qa,prod}  services/us-fundamentals/cloudbuild.{qa,prod}.yaml
  market-data-{qa,prod}      apps/market-data/cloudbuild.{qa,prod}.yaml

WHAT A TRIGGER DOES NOT DO. It builds and deploys the SERVICE. It does not
create the five Cloud Run JOBS — edgar-bulk-submissions, edgar-bulk-companyfacts,
edgar-bulk-ftd, edgar-xbrl-backfill and edgar-ownership-backfill. That is
scripts/ops/setup-us-fundamentals-jobs.sh, once per environment — though each
cloudbuild spec DOES re-pin those jobs' images on every build, so the ordering
is: provision the jobs once, then let the trigger keep them current.

They are NAMED here rather than counted. A bare number drifts silently the
moment a sixth job is added, and a stale count in a comment reads exactly like a
correct one; a stale NAME LIST can at least be diffed against the script.

VERIFY:
  gcloud builds triggers list --region=${TRIGGER_REGION} \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --format='table(name,github.push.branch,filename,includedFiles)'
────────────────────────────────────────────────────────────────
EOF
