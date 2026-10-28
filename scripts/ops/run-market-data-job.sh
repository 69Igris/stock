#!/bin/bash
# ============================================
# Market-data job runner (MONEY-1184)
# ============================================
# One wrapper for the repeatable MONEY-1175/1176/1177 data jobs, so they are
# invoked the way every other data job in this repo is: `{qa|prod|all}`, with
# DATABASE_URL_{ENV} pulled from Secret Manager rather than pasted in by hand.
#
# Hand-pasting the URL is the exact failure the wrappers exist to prevent —
# it is one shell-history recall away from pointing a prod backfill at QA.
#
# ## Why these three share a runner
#
# They are the jobs that must run PER ENVIRONMENT and more than once:
#
#   aliases   backfill-symbol-aliases.ts     QA needs its OWN run —
#                                            `instrument_mappings` is QA-DIRECT,
#                                            so sync-prod-to-qa never carries
#                                            `previousSymbols` across.
#   derive    derive-corporate-actions.ts    Re-run as history deepens or the
#                                            penny-stock guards are tuned.
#   corp      corp-actions-backfill.ts       Re-run to widen the window or with
#                                            --types=ALL.
#   fogap     repair-fo-summary-gap.ts       MONEY-1189 — re-derive the 456 days
#                                            of missing NSE F&O summaries. Runs
#                                            month by month and is idempotent:
#                                            it re-measures the gap each pass,
#                                            so an interrupted run resumes.
#   reclass   reclassify-instruments.ts      MONEY-1093/1099 — retype debt out of
#                                            EQUITY and clear the sector it
#                                            should never have carried.
#   resector  resector-real-estate.ts        MONEY-1093 — move Realty/REIT rows
#                                            out of Financial Services.
#   docqueue  repair-stock-document-queue.ts MONEY-1255 — the 1,211
#                                            `stock_documents` rows the extract
#                                            worker could never select: PDFs
#                                            stored under a parameterised
#                                            content-type, and HTML/MP3/ZIP
#                                            rows sitting PENDING for an
#                                            extractor that will never read
#                                            them. NO NETWORK — it rewrites two
#                                            columns from a value each row
#                                            already carries. Idempotent: a
#                                            second run finds nothing to do.
#   xbrlreparse xbrl-reparse.ts             MONEY-1252 — re-parse every stored
#                                            filing from the XML ALREADY IN
#                                            GCS, so MONEY-1250's two new cash
#                                            concepts reach rows parsed before
#                                            the concepts existed. Makes ZERO
#                                            exchange requests: an archive miss
#                                            is counted and skipped. Also runs
#                                            on CLOUD RUN — see its case below.
#   xbrl      xbrl-backfill.ts               MONEY-1114 P10 F2 — walk NSE's
#                                            results index month by month and
#                                            land each filing's XBRL. Idempotent
#                                            with NO checkpoint table: the job
#                                            skips a filing it already holds
#                                            BEFORE downloading it, so the rows
#                                            themselves are the checkpoint, at
#                                            exactly the granularity that
#                                            matters. Interrupt and re-run
#                                            freely. **This one runs on CLOUD
#                                            RUN, not here** (MONEY-1220) — see
#                                            its case below.
#   dbharvest databento-harvest.ts           MONEY-1373 — buy and load ONE
#                                            manifest entry: submit the batch
#                                            job, wait for Databento to
#                                            materialise it, download the DBN
#                                            and load the loadable schemas.
#                                            Hours to days, so **CLOUD RUN**.
#                                            `--apply` REQUIRES `--entry=<id>`
#                                            — see the guard in
#                                            run_one_cloudrun. Resumable from
#                                            its own Mongo inventory, so an
#                                            interruption costs time, never
#                                            work.
#   dbappend  databento-append.ts            MONEY-1373 — poll an outstanding
#                                            batch job to completion and append
#                                            what it produced. Also **CLOUD
#                                            RUN**: "poll until the vendor
#                                            finishes" is unbounded from our
#                                            side. `--entry=` is optional here
#                                            — it resumes what is owed.
#   dbprobe   databento-probe.ts             MONEY-1373 — quote the manifest
#                                            and read the dataset range. STAYS
#                                            LOCAL and costs NOTHING:
#                                            metadata.get_cost and
#                                            metadata.get_dataset_range are
#                                            free, and it never reaches
#                                            batch.submit_job. Run it before
#                                            arming anything.
#
# ## reclass / resector are INTERACTIVE — that is deliberate
#
# Both refuse to `--apply` unless stdin is a TTY, and neither has a `--yes`
# flag. Their own comments name wrappers, CI runners and cron as the threat: at
# EOF the confirm callback can never fire, `main()` never settles, and node
# exits **0** having written nothing — so a caller using `&&` reads "the
# operator was never asked" as "step completed".
#
# This wrapper does NOT weaken that. It runs the script directly (no pipe), so
# the terminal stays attached and the prompt still works. What it removes is the
# OTHER hazard: hand-pasting a `DATABASE_URL` for a job that retypes instruments
# and clears sectors. Same reason the three jobs above are here — the env comes
# from Secret Manager and the target host is echoed masked before the write.
#
# ## The GCP env is not optional
#
# `aliases` and `corp` read the GCS feed archive, and those scripts deliberately
# do NOT load `.env` (they are Cloud Run jobs in production, where reading a
# developer's .env would be dangerous). So the env is passed explicitly here.
#
# GCP_STORAGE_BUCKET matters most: `.env` carries
# `GCP_STORAGE_BUCKET=stockbook-content-local`, so a runner that forgot it would
# list an EMPTY bucket, find nothing, and report a confident zero. The archive
# bucket is the same for both envs — QA replays PROD's archived bytes through
# its own ingest (FEED_ARCHIVE_MODE=replay), which is the whole scrape-once
# design (MONEY-840/1085).
#
# DRY-RUN by default for every job — `--apply` must always be explicit.
#
# Usage:
#   ./scripts/ops/run-market-data-job.sh aliases qa               # preview
#   ./scripts/ops/run-market-data-job.sh aliases qa --apply
#   ./scripts/ops/run-market-data-job.sh derive prod --apply
#   ./scripts/ops/run-market-data-job.sh corp prod --apply --years=20
#   ./scripts/ops/run-market-data-job.sh aliases all --apply
#
#   # xbrl goes to Cloud Run. Without --apply it executes the job with
#   # --dry-run, which prints the window plan and makes ZERO NSE requests.
#   ./scripts/ops/run-market-data-job.sh xbrl prod
#   ./scripts/ops/run-market-data-job.sh xbrl prod --apply --from=2018-04 --to=2019-03
#
#   # xbrlreparse also goes to Cloud Run. Its dry run is a full REHEARSAL: the
#   # real write path against a no-op upsert, so it reports how many rows would
#   # actually CHANGE, not just how many exist.
#   ./scripts/ops/run-market-data-job.sh xbrlreparse prod --limit=500
#   ./scripts/ops/run-market-data-job.sh xbrlreparse prod --apply --from=2024 --to=2024
#
#   # databento (MONEY-1373). dbprobe is local and free; the other two go to
#   # Cloud Run, and dbharvest --apply REFUSES without --entry= — a bare apply
#   # walks all seven manifest entries in one execution, including the TB-scale
#   # ohlcv-1s-baseline, which cannot fit the 24h task timeout.
#   ./scripts/ops/run-market-data-job.sh dbprobe prod
#   ./scripts/ops/run-market-data-job.sh dbharvest prod --entry=ohlcv-1m-baseline
#   ./scripts/ops/run-market-data-job.sh dbharvest prod --apply --entry=ohlcv-1m-baseline
#   ./scripts/ops/run-market-data-job.sh dbappend prod --apply
# ============================================

set -e

JOB=""
ENV=""
EXTRA_ARGS=""

while [ $# -gt 0 ]; do
    case "$1" in
        aliases|derive|corp|fogap|reclass|resector|docqueue|docfinrecon|bseresults|xbrl|xbrlreparse|xbrlrecon|xbrlratios|dbharvest|dbappend|dbprobe) JOB="$1"; shift ;;
        qa|prod|all)         ENV="$1"; shift ;;
        # Everything else is forwarded verbatim to the underlying script, so
        # --symbols / --years / --limit / --min-confidence keep working without
        # this wrapper needing to know about them.
        *)                   EXTRA_ARGS="$EXTRA_ARGS $1"; shift ;;
    esac
done

if [ -z "$JOB" ] || [ -z "$ENV" ]; then
    echo "Usage: $0 {aliases|derive|corp|fogap|reclass|resector|docqueue|docfinrecon|bseresults|xbrl|xbrlreparse|xbrlrecon|xbrlratios|dbharvest|dbappend|dbprobe} {qa|prod|all} [--apply] [script args…]"
    echo
    echo "  aliases   backfill InstrumentMapping.previousSymbols from the feed archive"
    echo "  docfinrecon grade document-derived financials against the incumbent (--apply writes verdicts only)"
    echo "  bseresults  backfill BSE Result announcements for BSE-only companies (run --probe FIRST)"
    echo "  derive    derive corporate actions from the raw price series"
    echo "  corp      backfill corporate-action history from NSE + BSE"
    echo "  fogap     re-derive missing NSE F&O summaries (MONEY-1189)"
    echo "  reclass   retype debt out of EQUITY + clear its sector (MONEY-1093) — INTERACTIVE"
    echo "  resector  move Realty/REIT out of Financial Services (MONEY-1093) — INTERACTIVE"
    echo "  docqueue  unstick stock_documents rows the extractor could never take (MONEY-1255) — INTERACTIVE"
    echo "            — normalizes parameterised PDF mimeTypes and marks non-PDFs UNSUPPORTED."
    echo "              NO NETWORK. Run on PROD; QA receives the rows by sync-prod-to-qa."
    echo "  xbrl      backfill company financials from NSE's results XBRL (MONEY-1114)"
    echo "            — dispatches to the Cloud Run job xbrl-backfill-{env}, NOT to tsx."
    echo "              Provision it with ./scripts/ops/setup-xbrl-backfill-job.sh {env}."
    echo "              FY-aligned shards, oldest first:"
    echo "                $0 xbrl prod --apply --from=2018-04 --to=2019-03"
    echo "  xbrlreparse re-parse stored filings from the ARCHIVED XML (MONEY-1252)"
    echo "            — dispatches to the Cloud Run job xbrl-reparse-{env}, NOT to tsx."
    echo "              Provision it with ./scripts/ops/setup-xbrl-reparse-job.sh {env}."
    echo "              Makes ZERO exchange requests; an archive miss is skipped."
    echo "                $0 xbrlreparse prod --limit=500          # full rehearsal"
    echo "                $0 xbrlreparse prod --apply --from=2024 --to=2024"
    echo "  xbrlrecon reconcile XBRL against Tickertape before the switchover (MONEY-1115) — READ-ONLY"
    echo "  xbrlratios validate XBRL-DERIVED ratios against Tickertape (MONEY-1204 / 14a.4) — READ-ONLY"
    echo "  dbharvest buy + load one Databento manifest entry (MONEY-1373)"
    echo "            — dispatches to the Cloud Run job databento-harvest-{env}, NOT to tsx."
    echo "              Provision it with ./scripts/ops/setup-databento-jobs.sh {env}."
    echo "              --apply REQUIRES --entry=<id>. The ids:"
    echo "                jq -r '.entries[].id' scripts/data/databento-manifest.json"
    echo "  dbappend  poll an outstanding Databento batch job and append it (MONEY-1373)"
    echo "            — dispatches to the Cloud Run job databento-append-{env}, NOT to tsx."
    echo "              Same setup script; --entry= is optional (it resumes what is owed)."
    echo "  dbprobe   quote the manifest against the FREE metadata endpoints — READ-ONLY here"
    echo "            — runs LOCALLY (tsx). Costs nothing: metadata.get_cost and"
    echo "              metadata.get_dataset_range are free and it never submits a batch job."
    exit 1
fi

PROJECT_ID="stock-book-483718"
REGION="asia-south1"

# THE BUCKET FOLLOWS THE ENV. It was a single `REGION_BUCKET=stockbook-content-prod`
# constant used for every environment, so `dbprobe qa --apply` archived the
# bytes it bought into the PROD bucket — a QA run writing prod objects, silently
# and successfully. `.env` is not consulted here on purpose: its
# GCP_STORAGE_BUCKET points at the LOCAL bucket, which would yield zero rows.
bucket_for_env() {
    case "$1" in
        prod) echo "stockbook-content-prod" ;;
        qa)   echo "stockbook-content-qa" ;;
        *)    echo "ERROR: no bucket for env '$1'" >&2; exit 1 ;;
    esac
}

# How a job is executed. `local` = `npx tsx` here, which is every job but one.
# The `xbrl` case flips this to `cloudrun`; see the note on that case.
RUNNER="local"
# The literal a cloudrun job needs in order to WRITE, when its own default is a
# dry run. Empty means "absence of --dry-run already means apply" — see the
# xbrlreparse row for the two contracts this reconciles.
APPLY_FLAG=""
CLOUD_JOB=""
# Which ops script PROVISIONS the Cloud Run job. Named per job rather than
# hard-coded in the preflight, because a preflight that names the WRONG creator
# is worse than one that names none: it sends the operator to re-run a script
# that deploys a different job, and `--set-env-vars` REPLACES the env list.
SETUP_SCRIPT=""

case "$JOB" in
    aliases) SCRIPT="scripts/data/backfill-symbol-aliases.ts";   NEEDS_GCS=1 ;;
    derive)  SCRIPT="scripts/data/derive-corporate-actions.ts";  NEEDS_GCS=0 ;;
    corp)    SCRIPT="scripts/jobs/corp-actions-backfill.ts";     NEEDS_GCS=1 ;;
    # Needs GCS: it re-parses archived F&O bhavcopies via feed-parse, and
    # feed-parse deliberately does NOT read .env (see the note above).
    fogap)   SCRIPT="scripts/data/repair-fo-summary-gap.ts";     NEEDS_GCS=1 ;;
    # DB-only: both read `instrument_mappings` and write it back. No GCS, so no
    # bucket to get wrong — but they DO prompt, see the header note.
    reclass)  SCRIPT="scripts/data/reclassify-instruments.ts";   NEEDS_GCS=0 ;;
    resector) SCRIPT="scripts/data/resector-real-estate.ts";     NEEDS_GCS=0 ;;
    # DB-only and INTERACTIVE, same posture as the two above.
    #
    # APPLY_FLAG IS DECLARED EVEN THOUGH THE LOCAL RUNNER DOES NOT READ IT, and
    # that is the point. `run_one` forwards $EXTRA_ARGS to `npx tsx` VERBATIM,
    # so `--apply` reaches the script today whatever this says. `run_one_cloudrun`
    # does the opposite: it CONSUMES `--apply` and re-emits only $APPLY_FLAG.
    #
    # Two opposite contracts already live behind this one wrapper flag —
    # `xbrl-backfill.ts` applies by DEFAULT and takes `--dry-run`, while
    # `xbrl-reparse.ts` is dry-run by default and takes `--apply` — and the day
    # xbrlreparse shipped without this declaration it read 41,924 rows, reported
    # 24,165 as changed, wrote NOTHING, and exited 0 after 54 minutes. It fails
    # SAFE, which is exactly why nobody sees it.
    #
    # This script has the second contract. Declaring it now means the failure
    # cannot be reintroduced by the one-line edit that would cause it (flipping
    # RUNNER to "cloudrun"), and
    # `apps/web/__tests__/meta/run-market-data-job-apply-flag.test.ts` fails if
    # the declaration is removed.
    docqueue) SCRIPT="scripts/data/repair-stock-document-queue.ts"; NEEDS_GCS=0; APPLY_FLAG="--apply" ;;
    # MONEY-1255 — DRY RUN BY DEFAULT, opts in with `--apply` (writes ONE
    # column: DocumentFinancialExtract.reconcileVerdict). Same contract as
    # `docqueue` above and the OPPOSITE of `xbrl-backfill`, which applies by
    # default and opts OUT with `--dry-run`. The wrapper CONSUMES `--apply` and
    # re-emits only $APPLY_FLAG, so omitting this declaration would make the
    # flag reach the job as NEITHER flag: it would read everything, print a full
    # summary of what it would change, write nothing, and exit 0. That is not
    # hypothetical — it happened to xbrl-reparse for 41,924 rows over 54
    # minutes, and the only tell was `apply=false` in a line nobody diffs
    # against the command they typed.
    docfinrecon) SCRIPT="scripts/data/doc-financials-reconcile.ts"; NEEDS_GCS=0; APPLY_FLAG="--apply" ;;
    # MONEY-1255 — DRY RUN BY DEFAULT, opts in with `--apply`. Same contract as
    # docqueue/docfinrecon, OPPOSITE of xbrl-backfill. The wrapper CONSUMES
    # `--apply` and re-emits only $APPLY_FLAG, so omitting this declaration makes
    # the flag reach the job as NEITHER flag: a full walk of BSE, a full summary,
    # zero writes, exit 0. Run `--probe` FIRST — the archive depth is UNMEASURED,
    # and it is unmeasured because the probe that was supposed to measure it went
    # out with the same broken `strCat=-1` this ticket fixed.
    # NEEDS_GCS=1 — MONEY-1258. It was 0, and the job UPLOADS PDFs.
    #
    # The `NEEDS_GCS=0` branch runs the script with DATABASE_URL and nothing
    # else. `uploadFile` (@usemoney/storage) requires GCP_PROJECT_ID and
    # GCP_STORAGE_BUCKET, so every attachment upload threw — into a
    # best-effort `catch` that logged NOTHING. Measured on prod 2026-08-27, an
    # apply run wrote 59 rows: gcsPath "" on 59, fileSize 0 on 59, and the BSE
    # breadcrumb recorded an attachment on all 59. BSE offered a PDF every
    # time and we stored none.
    #
    # The rows are not merely empty: `gcsPath: ""` makes the parse lane
    # terminal-FAIL them on the first `downloadFromGCS("")`, and they occupy
    # `@@unique([symbol, exchange, docType, period])` — so a later correct run
    # must overwrite rows already marked terminal. Prod already carries 1,352
    # of exactly this shape from the nightly job.
    #
    # The declaration and the job disagreed while the job's own confirmation
    # prompt said "This will WRITE to a database AND upload PDFs to GCS".
    # NEEDS_GCS=1 also gates on credentials, so a missing login now fails
    # LOUDLY instead of writing empty paths.
    #
    # That branch additionally exports FEED_ARCHIVE_MODE=replay, which is inert
    # here: this script calls `uploadFile` directly and never routes through
    # `getFeedAsset`, so the replay trap the `xbrl` note below describes does
    # not apply.
    # STAYS LOCAL, unlike `xbrl`. The short interactive shard (one or two
    # years, with the TTY prompt) is the normal operator action and is what
    # this wrapper is for. The LONG historical walk — ~30.6h for 2015-2025 —
    # belongs on the Cloud Run job `bse-backfill-{env}`, provisioned by
    # scripts/ops/setup-bse-backfill-job.sh, because it exceeds both a laptop's
    # attention span and Cloud Run's own 24h task cap (so it runs in shards).
    #
    # Deliberately NOT dispatched to cloudrun here: routing every `bseresults`
    # through a job would take the interactive prompt away from the common
    # case, and that prompt is the guard on a write to prod + GCS.
    bseresults) SCRIPT="scripts/data/backfill-bse-results.ts";      NEEDS_GCS=1; APPLY_FLAG="--apply" ;;
    # RUNS ON CLOUD RUN, not on this machine — MONEY-1220 step E.
    #
    # Every other job here is `npx tsx` on the operator's laptop. This one is
    # not, and the reason is measured: seven years of NSE filings is on the
    # order of 200,000 downloads at 600 ms apiece, over a day of continuous
    # running. Two agents lost a run to machine sleep on 2026-08-19.
    #
    # A local run is also archive-blind. This wrapper's NEEDS_GCS branch sets
    # `FEED_ARCHIVE_MODE=replay`, which is the wrong mode for this job in both
    # directions: MONEY-1204 routed the download through `getFeedAsset`, so a
    # walk in replay fetches every byte from NSE and DROPS it, and
    # `--archive-existing --apply` refuses under replay outright rather than
    # reporting re-fetches it never made.
    #
    # So `xbrl` dispatches to the Cloud Run job `xbrl-backfill-{env}`, which
    # holds the right FEED_ARCHIVE_MODE per env (archive on prod, replay on QA),
    # a 24h task timeout and `--max-retries=0`. Provisioned by
    # scripts/ops/setup-xbrl-backfill-job.sh; walked per
    # docs/reference/xbrl-backfill-report.md.
    #
    # SCRIPT is still recorded because it is what the job runs inside the
    # container — the banner names it so the two never drift apart in the
    # reader's head.
    xbrl)     SCRIPT="scripts/jobs/xbrl-backfill.ts";              NEEDS_GCS=0; RUNNER="cloudrun"; CLOUD_JOB="xbrl-backfill"; SETUP_SCRIPT="scripts/ops/setup-xbrl-backfill-job.sh" ;;
    # ALSO RUNS ON CLOUD RUN — MONEY-1252, and for two reasons the backfill's
    # case only half shares.
    #
    # SCALE: 96,056 stored filings, each one GCS read plus a parse plus two
    # upserts. That is hours, and the two agents who lost an xbrl walk to laptop
    # sleep on 2026-08-19 lost it to exactly this shape.
    #
    # THE BUCKET: the job READS every document from GCS and never fetches, so it
    # is useless without a store — and this wrapper's local NEEDS_GCS branch
    # would hand it `FEED_ARCHIVE_MODE=replay` against the PROD bucket while the
    # DATABASE_URL points wherever the operator said, which is a QA run reading
    # prod bytes. The Cloud Run job spec pairs the bucket with the env instead.
    #
    # Unlike xbrl-backfill this job is NOT a network risk — a miss is counted
    # and skipped — so a bare `--apply` is legal here and deliberately not
    # gated: its scope is every stored filing, bounded by a 20h budget, and it
    # prints a resume cursor.
    # FORWARDS `--apply` — MONEY-1252. Two opposite contracts live behind this
    # one wrapper flag: `xbrl-backfill.ts` DEFAULTS TO APPLYING and takes
    # `--dry-run` to opt out, while `xbrl-reparse.ts` DEFAULTS TO A DRY RUN and
    # takes `--apply` to opt in. The wrapper consumes `--apply` and forwards
    # nothing, which is right for the first and silently WRONG for the second:
    # a `--apply` run reached the job as neither flag and it did what its own
    # default says — 41,924 rows read, 24,165 reported as changed, and nothing
    # written, over 54 minutes. It fails SAFE, which is why it is invisible.
    xbrlreparse) SCRIPT="scripts/jobs/xbrl-reparse.ts";             NEEDS_GCS=0; RUNNER="cloudrun"; CLOUD_JOB="xbrl-reparse"; SETUP_SCRIPT="scripts/ops/setup-xbrl-reparse-job.sh"; APPLY_FLAG="--apply" ;;
    # READ-ONLY. It writes nothing at all, so --apply is meaningless for it and
    # the dry-run banner below is accurate by construction rather than by flag.
    xbrlrecon) SCRIPT="scripts/data/xbrl-reconcile.ts";             NEEDS_GCS=0 ;;
    # MONEY-1204 / 14a.4 — the RATIOS half of the switchover gate. Also
    # READ-ONLY by construction: it issues only findMany/findFirst, so --apply
    # is meaningless for it, exactly like xbrlrecon above.
    xbrlratios) SCRIPT="scripts/data/xbrl-ratios-validate.ts";       NEEDS_GCS=0 ;;
    # ── MONEY-1373, the three Databento cases ────────────────────────────────
    #
    # RUN ON CLOUD RUN, for a reason neither `xbrl` case fully shares. The
    # harvest submits a PAID batch job, waits for Databento to materialise it,
    # and then downloads hundreds of gigabytes — hours to days, per manifest
    # entry. A laptop cannot hold that open, and this repo has lost two walks to
    # machine sleep already (2026-08-19). The append polls one outstanding batch
    # job to completion, which is unbounded from our side by construction.
    #
    # NEEDS_GCS=1 on all three, and it is load-bearing rather than defensive:
    # the raw DBN is archived under `databento/` in the bucket, and a run
    # without GCP_PROJECT_ID / GCP_STORAGE_BUCKET writes nothing there while
    # reporting success — measured on the BSE job, 59 rows with an empty
    # gcsPath (MONEY-1258). Note the `databento/` prefix sits OUTSIDE `feeds/`
    # deliberately, so `FEED_ARCHIVE_MODE` (which this wrapper's GCS branch
    # exports as `replay`) is inert here: these jobs do not route through
    # `getFeedAsset` at all.
    #
    # APPLY_FLAG IS DECLARED because both jobs are DRY-RUN BY DEFAULT and opt in
    # with `--apply` — the same contract as `docqueue`/`xbrlreparse` and the
    # OPPOSITE of `xbrl-backfill`, which applies by default and opts OUT with
    # `--dry-run`. `run_one_cloudrun` CONSUMES `--apply` and re-emits only
    # $APPLY_FLAG, so omitting this declaration would make the flag reach the
    # job as NEITHER flag: it would quote the whole manifest, print a full
    # summary of what it would buy, spend nothing, and exit 0. That is not
    # hypothetical — it happened to xbrl-reparse for 41,924 rows over 54
    # minutes. It fails SAFE, which is exactly why nobody sees it.
    dbharvest) SCRIPT="scripts/jobs/databento-harvest.ts";  NEEDS_GCS=1; RUNNER="cloudrun"; CLOUD_JOB="databento-harvest"; SETUP_SCRIPT="scripts/ops/setup-databento-jobs.sh"; APPLY_FLAG="--apply" ;;
    dbappend)  SCRIPT="scripts/jobs/databento-append.ts";   NEEDS_GCS=1; RUNNER="cloudrun"; CLOUD_JOB="databento-append";  SETUP_SCRIPT="scripts/ops/setup-databento-jobs.sh"; APPLY_FLAG="--apply" ;;
    # STAYS LOCAL, unlike the two above. It only quotes: `metadata.get_cost` and
    # `metadata.get_dataset_range` are FREE on the Databento historical API and
    # it never reaches `batch.submit_job`, so there is no spend to gate and no
    # multi-hour walk to protect from a closed lid. Founder-run, from a laptop,
    # which is the whole point of it existing separately from the harvest's own
    # dry run.
    dbprobe)   SCRIPT="scripts/data/databento-probe.ts";    NEEDS_GCS=1; APPLY_FLAG="--apply" ;;
esac

# Show WHICH database is about to be written to, without leaking the password.
# Reading the target back is the whole point: "am I pointed at prod?" must be
# answerable BEFORE the write, not inferred from the argument list afterwards.
#
# FAILS CLOSED. The first version matched only `mongodb+srv://` and printed the
# string unchanged when it did not match — so the very first real run, against
# a QA cluster that uses plain `mongodb://`, echoed the full credentials. A
# redactor that emits the raw secret when its pattern misses is worse than no
# redactor, because the output looks deliberate. Anything unrecognised is now
# reduced to the scheme alone.
mask_host() {
    local url="$1"
    # scheme://user:pass@host[:port][/db][?params]  ->  scheme://***:***@host
    local masked
    masked=$(printf '%s' "$url" | sed -E 's#^([a-z+]+://)[^:/@]+:[^@]+@([^/?,]+).*#\1***:***@\2#')
    if [ "$masked" != "$url" ]; then
        printf '%s' "$masked"
        return
    fi
    # No credential pattern matched. Echo the SCHEME only if there is one, and
    # otherwise nothing at all — an unrecognised string may still be a
    # connection string in a shape this function does not know, and guessing
    # wrong prints a password.
    case "$url" in
        *://*) printf '%s<redacted>' "${url%%://*}://" ;;
        *)     printf '<redacted>' ;;
    esac
}

# ── Cloud Run execution path (MONEY-1220 step E) ─────────────────────────
#
# Fires `gcloud run jobs execute` instead of `npx tsx`. Deliberately does NOT
# fetch DATABASE_URL: the job already carries `DATABASE_URL={SECRET}:latest` in
# its own spec, so pulling the URL here would put a prod connection string in
# this shell's environment for no reason at all.
run_one_cloudrun() {
    local env="$1"
    local job_name="${CLOUD_JOB}-${env}"

    # PREFLIGHT. Without this, an unprovisioned job surfaces as a raw gcloud
    # NOT_FOUND and the next move ("which script creates it?") is a guess. That
    # is not hypothetical: on 2026-08-19 no xbrl-* job existed in ANY env, while
    # this wrapper documented the walk as if it did.
    if ! gcloud run jobs describe "$job_name" --region="$REGION" \
        --project="$PROJECT_ID" >/dev/null 2>&1; then
        echo "ERROR: Cloud Run job '${job_name}' does not exist in ${REGION}." >&2
        echo "  Provision it first:" >&2
        echo "    ./${SETUP_SCRIPT} ${env}" >&2
        exit 1
    fi

    # DRY-RUN BY DEFAULT, same contract as every other job here — but expressed
    # in the job's own vocabulary. `--apply` is this wrapper's word and means
    # "really do it"; the job's word is `--dry-run`, which prints the window plan
    # and exits WITHOUT touching NSE. So --apply is CONSUMED here, never
    # forwarded: `xbrl-backfill.ts` does not know the flag and would reject it.
    local job_args=()
    local applying=false
    local arg
    for arg in ${EXTRA_ARGS}; do
        case "$arg" in
            --apply) applying=true ;;
            # gcloud splits --args on COMMAS, so an argument containing one
            # would silently become two. Refuse rather than mangle it.
            *,*)
                echo "ERROR: '${arg}' contains a comma; gcloud splits --args on commas." >&2
                echo "  Run this shard with gcloud directly using the alternate delimiter:" >&2
                echo "    gcloud run jobs execute ${job_name} --region=${REGION} --args=^:^${arg}" >&2
                exit 1
                ;;
            *) job_args+=("$arg") ;;
        esac
    done
    if [ "$applying" = false ]; then
        # Only add it if the caller did not already ask for it, so the printed
        # command stays honest rather than showing `--dry-run --dry-run`.
        case " ${job_args[*]} " in
            *" --dry-run "*) ;;
            *) job_args+=("--dry-run") ;;
        esac
    else
        # Forward the job's own opt-in literal when it has one.
        if [ -n "$APPLY_FLAG" ]; then
            case " ${job_args[*]} " in
                *" ${APPLY_FLAG} "*) ;;
                *) job_args+=("$APPLY_FLAG") ;;
            esac
        fi
        # SHARD THE WALK. A bare `--apply` runs xbrl-backfill.ts with its
        # DEFAULTS, which is --from-year=2018 through today — every window in a
        # single execution. That does not fit the 24h task timeout (one FY is
        # ~5h of paced downloads), so it would be killed part-way and surface as
        # a FAILED task rather than as the "you asked for too much" it actually
        # is. Refuse instead, and print the shards.
        #
        # Same guard, same reason, as feed-backfill's "do not execute with no
        # --families".
        #
        # SCOPED TO `xbrl` ONLY. The guard exists because a bare `--apply` there
        # walks NSE for a decade in one execution. `xbrlreparse` has neither
        # property: it makes ZERO exchange requests, its scope defaults to every
        # stored filing deliberately (a hard-coded floor would silently exclude
        # rows and still report DRAINED), and it is bounded by its own 20h
        # budget with a printed resume cursor. Refusing a bare --apply there
        # would be a guard against nothing.
        if [ "$JOB" = "xbrl" ]; then
            case " ${job_args[*]} " in
                *" --from"*|*" --annual-existing "*|*" --archive-existing "*) ;;
                *)
                    echo "ERROR: --apply needs a scope. A bare --apply walks 2018→today in ONE" >&2
                    echo "  execution, which does not fit the 24h task timeout." >&2
                    echo "  Shard it, FY-aligned and OLDEST FIRST (the projection's QoQ/TTM" >&2
                    echo "  derivations need the earlier periods already present):" >&2
                    echo "    --from=2018-04 --to=2019-03      # then 2019-04→2020-03, …" >&2
                    echo "  Full list: ./scripts/ops/setup-xbrl-backfill-job.sh ${env} --dry-run" >&2
                    echo "  Or a repair pass: --annual-existing / --archive-existing" >&2
                    exit 1
                    ;;
            esac
        fi

        # THE SAME GUARD, A DIFFERENT WALL — MONEY-1373.
        #
        # A bare `--apply` on the harvest walks EVERY manifest entry in ONE
        # execution, and the seven entries differ by three orders of magnitude:
        # `definition-baseline` is minutes, `ohlcv-1s-baseline` is TB-scale and
        # cannot fit the 24h task timeout AT ALL. So the execution is not merely
        # slow — it is killed part-way, and it surfaces as a FAILED task rather
        # than as the "you asked for too much" it actually is. Worse than the
        # xbrl case, because the entries before the wall were BOUGHT: a
        # Databento batch job is billed on submission, not on completion.
        #
        # The JOB refuses this too, and deliberately so — a `gcloud run jobs
        # execute` typed by hand never passes through here. This message is the
        # OPERATOR-facing one: it is the only one of the two that can print the
        # entry ids, because it runs beside the manifest.
        #
        # Ids are read FROM THE FILE, never restated, so this cannot go stale
        # the way a hardcoded list would. jq if it is here, a grep fallback if
        # it is not — a missing jq must degrade the message, never the refusal.
        if [ "$JOB" = "dbharvest" ]; then
            case " ${job_args[*]} " in
                *" --entry="*) ;;
                *)
                    local MANIFEST="scripts/data/databento-manifest.json"
                    echo "ERROR: --apply needs --entry=<id>. A bare --apply walks EVERY manifest" >&2
                    echo "  entry in ONE execution, including the TB-scale ohlcv-1s-baseline," >&2
                    echo "  which cannot fit the 24h task timeout — it would be killed part-way" >&2
                    echo "  and surface as a FAILED task, after paying for the entries before it" >&2
                    echo "  (a Databento batch job bills on SUBMISSION, not on completion)." >&2
                    echo "  Name one entry:" >&2
                    echo "    $0 dbharvest ${env} --apply --entry=ohlcv-1m-baseline" >&2
                    echo "  The ids, smallest first is the order in the runbook:" >&2
                    if command -v jq >/dev/null 2>&1 && [ -f "$MANIFEST" ]; then
                        jq -r '.entries[] | "    \(.id)  (order \(.order), \(.schema))"' "$MANIFEST" >&2
                    else
                        echo "    jq -r '.entries[].id' ${MANIFEST}" >&2
                    fi
                    exit 1
                    ;;
            esac
        fi
    fi

    # Comma-JOINED, because that is the separator gcloud expects.
    local joined=""
    for arg in "${job_args[@]}"; do
        joined="${joined:+${joined},}${arg}"
    done

    echo "─────────────────────────────────────────────"
    echo "  job    : ${JOB}  (${SCRIPT}, on Cloud Run)"
    echo "  env    : ${env}"
    echo "  target : Cloud Run job ${job_name} (${REGION})"
    echo "  args   : ${joined}"
    if [ "$applying" = false ]; then
        if [ "$JOB" = "xbrlreparse" ]; then
            # NOT the same kind of dry run. xbrl-backfill's prints a plan;
            # this one runs the REAL write path against a no-op upsert, so it
            # reports how many rows would actually CHANGE. Saying "prints the
            # plan" here would undersell the only rehearsal worth doing.
            echo "  mode   : DRY RUN — real write path, no-op upsert; reports rows that would CHANGE"
        elif [ "$JOB" = "dbharvest" ] || [ "$JOB" = "dbappend" ]; then
            # A DIFFERENT VENDOR ENTIRELY. Both Databento jobs used to fall
            # through to the XBRL wording below, so the last line an operator
            # read before an irreversible, billed-on-submission batch purchase
            # said it walks NSE and writes xbrl_filings. Everything else on the
            # panel is correct, which is what made the wrong line credible.
            echo "  mode   : DRY RUN — quotes via metadata.get_cost (FREE), submits nothing"
        else
            echo "  mode   : DRY RUN — prints the window plan, makes no NSE requests"
        fi
    else
        if [ "$JOB" = "xbrlreparse" ]; then
            echo "  mode   : APPLY — rewrites xbrl_filings from ARCHIVED bytes (no NSE traffic)"
        elif [ "$JOB" = "dbharvest" ] || [ "$JOB" = "dbappend" ]; then
            echo "  mode   : APPLY — SUBMITS a PAID Databento batch job. Billed on"
            echo "           submission; the window cannot be un-bought. Output"
            echo "           expires 30 days from SUBMISSION, not from completion."
        else
            echo "  mode   : APPLY — this walks NSE and writes xbrl_filings"
        fi
    fi
    echo "─────────────────────────────────────────────"

    if [ "$applying" = false ]; then
        # Wait: a dry run prints its plan and exits in seconds, and the plan is
        # the entire reason to run it. Not waiting would hand back an execution
        # id and make the operator go fetch the thing they asked for.
        gcloud run jobs execute "$job_name" --region="$REGION" \
            --project="$PROJECT_ID" --args="${joined}" --wait
    else
        # Do NOT wait: a shard is hours. Hand back the execution and the one
        # command that answers "what is it doing".
        gcloud run jobs execute "$job_name" --region="$REGION" \
            --project="$PROJECT_ID" --args="${joined}"
        echo
        echo "Started. It does not block; watch it with:"
        echo "  gcloud logging read \\"
        echo "    'resource.type=cloud_run_job AND resource.labels.job_name=${job_name}' \\"
        echo "    --limit=100 --freshness=15m --project=${PROJECT_ID}"
        echo
        echo "The FIRST line is [build-provenance]: it names the commit the job is"
        echo "actually running. Cloud Run JOBS pin their image at provision time and"
        echo "a deploy of the SERVICE does not move them (MONEY-1210/MONEY-1205), so"
        echo "that line is the only place the drift is observable. If it is not the"
        echo "commit you expect, re-run ${SETUP_SCRIPT} ${env}."
    fi
}

run_one() {
    local env="$1"

    if [ "${RUNNER}" = "cloudrun" ]; then
        run_one_cloudrun "$env"
        return
    fi

    local db_secret="DATABASE_URL_$(echo "$env" | tr '[:lower:]' '[:upper:]')"

    echo "Fetching ${db_secret} from GCP Secret Manager..."
    local db_url
    db_url=$(gcloud secrets versions access latest --secret="${db_secret}" --project="${PROJECT_ID}" 2>/dev/null)
    if [ -z "${db_url}" ]; then
        echo "ERROR: Could not fetch ${db_secret}" >&2
        echo "  gcloud secrets versions list ${db_secret} --project=${PROJECT_ID}" >&2
        exit 1
    fi

    echo "─────────────────────────────────────────────"
    echo "  job    : ${JOB}  (${SCRIPT})"
    echo "  env    : ${env}"
    echo "  target : $(mask_host "${db_url}")"
    echo "  args   :${EXTRA_ARGS:- (dry-run — no --apply)}"
    echo "─────────────────────────────────────────────"

    if [ "${NEEDS_GCS}" = "1" ]; then
        # Explicit, because the underlying scripts do not read .env — and .env's
        # GCP_STORAGE_BUCKET points at the LOCAL bucket, which would silently
        # yield zero rows.
        if [ -z "${GOOGLE_APPLICATION_CREDENTIALS}" ] && [ ! -f "${HOME}/.config/gcloud/application_default_credentials.json" ]; then
            echo "ERROR: no GCP credentials. Set GOOGLE_APPLICATION_CREDENTIALS or run:" >&2
            echo "  gcloud auth application-default login" >&2
            exit 1
        fi
        # The Databento probe authenticates per call and reads the key from
        # the environment; nothing here exported it, so `dbprobe` failed at the
        # first request with "DATABENTO_API_KEY is not set" — after the
        # operator had already waited on the Secret Manager round trip. Fetched
        # only for the jobs that need it, and NEVER echoed.
        local db_key=""
        if [ "${JOB}" = "dbprobe" ]; then
            db_key=$(gcloud secrets versions access latest \
                --secret="DATABENTO_API_KEY_$(echo "$env" | tr '[:lower:]' '[:upper:]')" \
                --project="${PROJECT_ID}" 2>/dev/null)
            if [ -z "${db_key}" ]; then
                echo "ERROR: could not fetch DATABENTO_API_KEY_${env}" >&2
                exit 1
            fi
        fi
        DATABASE_URL="${db_url}" \
        GCP_PROJECT_ID="${PROJECT_ID}" \
        GCP_STORAGE_BUCKET="$(bucket_for_env "$env")" \
        DATABENTO_API_KEY="${db_key}" \
        DATABENTO_ENV="${env}" \
        FEED_ARCHIVE_MODE=replay \
            npx tsx "${SCRIPT}" ${EXTRA_ARGS}
    else
        DATABASE_URL="${db_url}" npx tsx "${SCRIPT}" ${EXTRA_ARGS}
    fi
}

if [ "${ENV}" = "all" ]; then
    run_one qa
    run_one prod
else
    run_one "${ENV}"
fi
