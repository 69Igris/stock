#!/bin/bash
# ============================================
# UseMoney - Sync SCRAPED / REFERENCE data: PROD -> QA
# ============================================
# Part of the "scrape-once-in-prod, copy-down-to-qa" architecture.
#
#   All external-data scraping crons run ONLY in prod. QA never scrapes; it
#   gets its reference data by copying it DOWN from prod. This script is that
#   copy-down tool. It moves the SCRAPER / SEEDER-produced reference dataset
#   (instrument master, prices, fundamentals, scraped docs, corporate actions,
#   news/events, MF master, etc.) plus the GCS stock-document bucket from PROD
#   to QA, overwriting QA's copy.
#
# It copies in TWO parts:
#   1. MongoDB  - an explicit ALLOWLIST of RATE-LIMITED-source collections (below;
#                 MONEY-855). Per collection: count prod first — if it has rows,
#                 DROP QA's stale copy and restore prod's (mongodump | mongorestore
#                 --drop); if prod is EMPTY, SKIP (never wipe QA — the empty-guard).
#                 Drop-then-restore is required because QA's own copies have
#                 different _ids (QA fetched them before), so an _id upsert collides
#                 on the unique natural-key index. The empty-guard keeps the
#                 "don't update empty data" guarantee.
#   2. GCS      - gs://stockbook-content-prod/stocks/  ->
#                 gs://stockbook-content-qa/stocks/   (rsync, diffs only).
#
# ── SAFETY: direction is HARD-CODED prod -> qa ──
#   There is NO environment argument and NO way to flip the direction. The
#   source is ALWAYS prod (read), the destination is ALWAYS qa (written).
#   It is impossible to accidentally clobber prod with this script.
#
# ── NEVER copies user data ──
#   The collection set is an ALLOWLIST (only the explicitly-listed reference
#   collections are touched). A denylist is deliberately NOT used so that any
#   FUTURE new user/account/billing model is excluded by DEFAULT. The user /
#   account / billing / job-scoped collections we explicitly DO NOT copy are
#   enumerated in the EXCLUDED block below for auditability.
#
# Prerequisites:
#   - gcloud CLI installed + authenticated (Secret Manager + GCS access)
#   - mongodb-database-tools (mongodump / mongorestore) + mongosh on PATH
#       brew install mongodb-database-tools mongosh
#   - DATABASE_URL_QA / DATABASE_URL_PROD secrets exist in GCP Secret Manager
#
# ── TIERS (MONEY-1085) ──
#   --tier=reference (default)  The behaviour described above: the 13
#       rate-limited Mongo collections + the scraped-PDF GCS prefix. Weekly
#       (Cloud Run job `sync-prod-to-qa`, Sun 05:00 IST).
#
#   --tier=feeds  Mirrors TWO GCS prefixes and no MongoDB collection:
#       the archived RAW exchange files (gs://…-prod/feeds/ -> …-qa/feeds/)
#       and the candle warehouse's COLD SHARDS (…/candles/ -> …/candles/,
#       MONEY-1373 — the Mongo `candles` table is synced already, so without
#       its shards QA holds a hot window over an empty history and every cold
#       read answers `absent`). Touches NO MongoDB
#       collection, so nothing in QA is dropped. Prod archives each EXCHANGE
#       file it fetches (FEED_ARCHIVE_MODE=archive) — the BSE + NSE bhavcopies,
#       the NSE all-indices close file, the NSE instrument masters and BSE's
#       scrip master; Zerodha's Kite dump is a deliberate exemption (public,
#       unmetered, and instrument_mappings is QA-DIRECT — see the EXCLUDED
#       block). QA replays them (FEED_ARCHIVE_MODE=replay) through its OWN
#       ingest, so QA keeps its own instrument _ids and its ingest code path
#       stays exercised.
#       ONE Cloud Run job (`sync-prod-to-qa-feeds`), TWO triggers:
#         21:15 IST Mon-Fri (`-eod`)   and   00:45 IST daily (`-daily`).
#
#       ── WHY TWO, i.e. the constraint the original single 00:45 slot missed ──
#       00:45 was chosen to clear prod's whole EOD chain (bhavcopy 21:00,
#       instrument-sync 22:00, price-sync 23:00, price-backfill 23:15). That
#       reasons about the PRODUCER only. QA runs that same chain at those same
#       clock times, and the CONSUMER was never in the picture: QA's bhavcopy
#       asked for day D's archived object at 21:00 on day D, 3h45m BEFORE this
#       mirror copied it. The archive key is date-stamped, so yesterday's object
#       cannot answer today's request — QA missed 100% (replayHits=0
#       replayMisses=2, measured 2026-08-13) and fell back to scraping NSE + BSE
#       every weekday, silently, because a replay miss is a soft failure by
#       design. MONEY-1194.
#
#       So the ordering that has to hold, all on ONE IST calendar day, is:
#           21:00  prod bhavcopy-sync ARCHIVES day D
#           21:15  this job (--tier=feeds) MIRRORS it   <- the `-eod` trigger
#           21:30  QA bhavcopy-sync REPLAYS it
#       The 00:45 trigger is KEPT as the catch-all for what prod archives after
#       21:15 (report-archive-night 21:45, instrument-sync 22:00, the NSE/api/*
#       JSONs) and as the only pass at the weekend. Do NOT collapse the two back
#       into one late run, and do NOT "fix" this by moving QA's bhavcopy past
#       midnight: `resolveTargetDay` walks back to the most recent trading IST
#       CALENDAR day, which on a weekday is TODAY, so a 01:30 run would ask for
#       a file the exchange has not published yet — a silent zero-price no-op.
#
#       Both triggers are provisioned by scripts/ops/setup-sync-job.sh and
#       reconciled by scripts/ops/setup-scheduler.sh prod; the two must agree.
#       See packages/core/src/market-data/feed-archive.ts.
#
# Usage:
#   ./scripts/ops/sync-prod-to-qa.sh                  # Mongo + GCS (prompts first)
#   ./scripts/ops/sync-prod-to-qa.sh --yes            # skip the confirmation prompt
#   ./scripts/ops/sync-prod-to-qa.sh --tier=feeds     # archived raw feeds only (no Mongo)
#   ./scripts/ops/sync-prod-to-qa.sh --tier=lake      # BigQuery silver prod -> qa: PLAN (MONEY-1610)
#   ./scripts/ops/sync-prod-to-qa.sh --tier=lake --apply   # ...and run the copy jobs
#   ./scripts/ops/sync-prod-to-qa.sh --collections-only   # Mongo only, skip GCS
#   ./scripts/ops/sync-prod-to-qa.sh --gcs-only       # GCS only, skip Mongo
#   ./scripts/ops/sync-prod-to-qa.sh --dry-run        # print every command, run nothing
#   ./scripts/ops/sync-prod-to-qa.sh --status         # per-collection freshness report (reads QA only)
#
# ── FRESHNESS + ORDER — MONEY-1488 / MONEY-1487 ─────────────────────────────
#
# Every VISITED collection writes an outcome row into QA's `qa_sync_outcomes`
# (`_id` = the collection name). Visited, not written: a collection the
# empty-guard skipped is a healthy no-op and must not keep a stale marker for
# ever, which is MONEY-1255's stamping lesson.
#
# The states are DISTINCT and the distinction is the point (MONEY-1488):
#
#   RESTORED             dump + restore both exited 0. QA holds prod's copy.
#   SKIPPED_EMPTY        prod had 0 rows. QA UNTOUCHED — the empty-guard.
#   SKIPPED_SAMPLE_MISS  --tier=sample matched 0 of N. QA UNTOUCHED.
#   COUNT_FAILED         the prod count itself failed. QA UNTOUCHED, and the
#                        collection was never started — "failed BEFORE
#                        starting", which is not the same as "failed".
#   FAILED               dump or restore exited non-zero. `mongorestore --drop`
#                        drops before it writes, so QA may hold a PARTIAL copy.
#   INDEX_BUILD_FAILED   MONEY-1519. An INDEX could not be built: either the
#                        rows all landed and mongorestore's index build then
#                        failed (for an ordinary collection that leaves ONLY
#                        `_id_` — the createIndexes call is all-or-nothing), or
#                        a UNIQUE_FIRST collection's unique key could not be put
#                        in place, in which case the restore was never started.
#                        Distinct from FAILED because the fix is different: the
#                        data is not the problem, the uniqueness contract is.
#   IN_FLIGHT            written BEFORE the dump and never overwritten. A
#                        process killed at the 3600s task timeout cannot write
#                        "I was killed", so the intent is written first and the
#                        ABSENCE of an overwrite is the signal. QA may hold a
#                        scattered PARTIAL copy.
#
# FAILED and IN_FLIGHT are the two that mean "partially applied", and that is
# what MONEY-1486's future delta bound has to read: `mongorestore` inserts in
# ARBITRARY order, so a killed restore leaves a scattered subset and QA's live
# `max(field)` then advances past rows that never landed — permanently. A delta
# bound must come from a recorded CLEAN completion, never from QA's current max.
#
# The ORDER the loop walks is then derived from that record: least-recently
# VISITED first, ties broken by position in REFERENCE_COLLECTIONS. The manifest
# below stays a static, commented, reviewable array — only the ORDER moves. A
# statically-ordered walk over a population larger than one run can finish means
# the array's line number decides what is ever synced: 34 collections had not
# synced since 2026-08-31 because they sit below the US block (MONEY-1487).
# Keying on VISITED rather than on SUCCEEDED is deliberate — a collection that
# fails every night (`candles` has, since 2026-09-01, burning 25-29 minutes of a
# 60-minute budget) would otherwise sort first for ever and starve the other 53.
#
# Exit codes (MONEY-1238 — this script is the Cloud Run job's ENTRYPOINT, so its
# status IS the job's status; it used to fall off the end and always exit 0):
#   0  every listed collection either copied or was skipped by the empty-guard,
#      and the post-restore re-link resolved every required relation
#   1  at least one collection failed to copy or to build its indexes
#      (INDEX_BUILD_FAILED — MONEY-1519), OR the re-link failed, OR the
#      re-link ran and QA still holds dangling required relations, OR a restored
#      collection is missing every secondary index
# ============================================

# pipefail so a failing mongodump (left side of the pipe) is detected rather
# than masked by a succeeding mongorestore (which would exit 0 on empty input).
set -eo pipefail

# ── Flags ──
DO_MONGO=true
DO_GCS=true
DRY_RUN=false
ASSUME_YES=false
# MONEY-1488 — report mode. Reads QA's freshness record and exits; writes
# nothing, drops nothing, never opens prod.
DO_STATUS=false
# MONEY-1488 — how old a collection's LAST VISIT may be before the report calls
# it stale. 3 days rather than 1: the reference sync runs daily, so 1 would fire
# on a single missed night, and the defect this record exists for was THREE
# WEEKS. The number lives in `packages/core/src/ops/qa-sync-outcomes.ts` too —
# that module is the rule's executable form — and the spawntest drives THIS
# script and compares the two, so a change here that is not made there is red.
STALE_AFTER_DAYS=3
# MONEY-1085: which body of data to move.
#   reference — the 13 rate-limited/expensive scraped Mongo collections + the
#               scraped-PDF GCS prefix. The original behaviour; weekly.
#   feeds     — ONLY the archived raw exchange files (GCS feeds/ prefix). No
#               Mongo at all, so nothing in QA is ever dropped. Daily.
TIER="reference"
# --tier=sample knobs. 500 symbols per market and 2 years of history is the
# founder-specified default; both are overridable because the right size for a
# test environment is an operational judgement, not a constant.
SAMPLE_UNIVERSE=500
SAMPLE_YEARS=2
# MONEY-1610 — the lake tier's arm. `--tier=lake` WITHOUT it is a plan: it reads
# both silver inventories and prints what it would copy, and writes nothing.
# Only the lake tier takes it; the Mongo/GCS tiers keep --yes / --dry-run.
LAKE_APPLY=false

# Parse arguments (while-loop, mirrors scripts/ops/setup-infra.sh)
while [ $# -gt 0 ]; do
    case "$1" in
        --collections-only) DO_GCS=false; shift ;;
        --gcs-only) DO_MONGO=false; shift ;;
        --tier=*) TIER="${1#*=}"; shift ;;
        --universe=*)
            SAMPLE_UNIVERSE="${1#*=}"
            # Validated, not trusted: it was previously accepted, echoed into
            # the banner and documented in --help while being forwarded
            # NOWHERE, so `--universe=abc` printed a confident "universe=abc"
            # and copied the full manifest.
            case "$SAMPLE_UNIVERSE" in
                ''|*[!0-9]*) echo "--universe must be a positive integer (got '$SAMPLE_UNIVERSE')"; exit 1 ;;
            esac
            [ "$SAMPLE_UNIVERSE" -gt 0 ] || { echo "--universe must be > 0"; exit 1; }
            shift ;;
        --years=*)
            SAMPLE_YEARS="${1#*=}"
            # Validated for the same reason as --universe directly above, and
            # missing it here was worse than missing it there. `--years=-5`
            # yields a cutoff FIVE YEARS IN THE FUTURE: all 22 time-bounded
            # collections match zero rows and skip (correctly — QA untouched),
            # the 17 un-bounded ones restore, so RESTORED is non-empty,
            # `sample-matched-nothing` never fires, and the run exits 0 printing
            # "Complete!" with stock_flags, mf_nav_history, slb_positions and 19
            # others silently absent. `--years=abc` was equally quiet:
            # `Number("abc") || 2` in the plan yields a 1.999-year window while
            # the banner confidently echoes "years=abc".
            case "$SAMPLE_YEARS" in
                ''|*[!0-9]*) echo "--years must be a positive integer (got '$SAMPLE_YEARS')"; exit 1 ;;
            esac
            [ "$SAMPLE_YEARS" -gt 0 ] || { echo "--years must be > 0"; exit 1; }
            shift ;;
        --tier)
            # MONEY-1157: `shift 2` with no value left FAILS, and under
            # `set -e` (line 71) that killed the script with exit 1 and ZERO
            # bytes of output — the `*)` validation below never ran, so the
            # operator got no clue what was wrong. Check for the value here so a
            # MISSING one reports in the same shape as an INVALID one.
            #
            # `--tier=` (the sibling form above) yields an empty TIER and falls
            # through to that same `*)` validation; both forms stay identical.
            if [ $# -lt 2 ]; then
                echo "Missing value for --tier (expected 'reference', 'sample', 'feeds' or 'lake')"
                exit 1
            fi
            TIER="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --apply) LAKE_APPLY=true; shift ;;
        # MONEY-1488 — the freshness REPORT. Reads QA's `qa_sync_outcomes` and
        # prints one line per collection; writes nothing, drops nothing, and
        # never opens prod. A MODE rather than a flag: it answers the question
        # the record exists for ("is QA's stock_ratios current?") and then
        # exits, so it can never be combined with a run that would move the
        # very ages it is reporting.
        --status) DO_STATUS=true; shift ;;
        --yes|-y) ASSUME_YES=true; shift ;;
        -h|--help)
            echo "Usage: ./scripts/ops/sync-prod-to-qa.sh [options]"
            echo ""
            echo "Copies SCRAPED / REFERENCE data PROD -> QA (direction is hard-coded)."
            echo ""
            echo "Options:"
            echo "  --tier=reference     (default) Mongo reference collections + scraped PDFs"
            echo "  --tier=sample        Bounded per-segment sample (top N symbols x M years); Mongo only"
            echo "  --tier=feeds         Archived raw exchange files + candle cold shards + chart tiles (GCS feeds/ + candles/ + tiles/); no Mongo"
            echo "  --tier=lake          BigQuery lake_silver_prod -> lake_silver_qa (copy jobs); PLAN unless --apply"
            echo "  --apply              --tier=lake only: actually run the copy jobs"
            echo "  --universe=N         --tier=sample: symbols per market (default 500)"
            echo "  --years=N            --tier=sample: history window in years (default 2)"
            echo "  --collections-only   Sync MongoDB reference collections only (skip GCS)"
            echo "  --gcs-only           Sync the GCS stocks/ bucket only (skip MongoDB)"
            echo "  --dry-run            Print every command without executing (no prompt)"
            echo "  --status             Print QA's per-collection sync freshness and exit (reads QA only)"
            echo "  --yes, -y            Skip the confirmation prompt"
            echo "  -h, --help           Show this help"
            exit 0
            ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

case "$TIER" in
    reference) ;;
    feeds)
        # The feeds tier is GCS-only by construction. QA ingests the replayed
        # files itself with its OWN instrument _ids, which is exactly why this
        # tier touches no collections — see the FK note in the EXCLUDED block.
        DO_MONGO=false
        DO_GCS=true
        ;;
    sample)
        # Mongo only. The GCS half is the scraped-PDF mirror, which is keyed by
        # document id rather than symbol and has no cheap symbol filter — so a
        # "sampled" GCS copy would either be the whole prefix (not a sample) or
        # need a per-object lookup (slower than copying). Left out deliberately;
        # run --tier=reference --gcs-only if QA needs the PDFs.
        #
        # REFUSE rather than override. This block runs AFTER the argument loop,
        # so a bare assignment here silently INVERTS an explicit flag: measured,
        # `--gcs-only --tier=sample` issued 39 drop+restore pairs while the
        # banner printed "MongoDB reference collections only" — the exact
        # opposite of what was asked, on the one tier that drops QA collections.
        # An operator who names two options that cannot both hold must be told.
        if [ "$DO_MONGO" == "false" ]; then
            echo "--gcs-only cannot be combined with --tier=sample (this tier is Mongo-only)."
            echo "  For the scraped-PDF mirror use: --tier=reference --gcs-only"
            exit 1
        fi
        DO_GCS=false
        ;;
    lake)
        # BigQuery only (MONEY-1610). Refuse the flags that name the OTHER
        # halves rather than silently ignoring them — the sample tier's lesson
        # directly above.
        if [ "$DO_MONGO" == "false" ] || [ "$DO_GCS" == "false" ] || [ "$DO_STATUS" == "true" ]; then
            echo "--collections-only / --gcs-only / --status do not apply to --tier=lake (it touches no Mongo and no GCS)."
            exit 1
        fi
        if [ "$LAKE_APPLY" == "true" ] && [ "$DRY_RUN" == "true" ]; then
            echo "--apply and --dry-run contradict each other. --tier=lake without --apply IS the dry run."
            exit 1
        fi
        DO_MONGO=false
        DO_GCS=false
        ;;
    *) echo "Unknown --tier: $TIER (expected 'reference', 'sample', 'feeds' or 'lake')"; exit 1 ;;
esac

# Colors (mirror seed-env.sh)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_ID="stock-book-483718"

# ============================================
# --tier=lake — BigQuery silver, prod -> qa (MONEY-1610)
# ============================================
# QA's lake was EMPTY (all 14 lake_silver_qa tables at 0 rows, 2026-09-23), so
# nothing that reads the lake — gold, query_lake, releases — could be tested
# before prod. Re-running every loader in QA would repeat 12+ hours of work over
# inputs that are already mirrors of prod's (feeds/, candles/). A BigQuery COPY
# job inside one region is free and takes seconds, so the tier copies instead.
#
# A TIER OF THIS JOB, not a TS script on the workers image: this job's
# service account is already the prod-read / QA-write identity, its image
# already carries `bq` (google/cloud-sdk:slim), and its setup script already
# owns the triggers. A Node job would need a workers deploy, a tsup entry and a
# THIRD identity reading prod (lake-writer-qa@ is a QA-only identity by design).
#
# WHAT IT COPIES, derived and never listed: every BASE TABLE present in BOTH
# lake_silver_prod and lake_silver_qa. A prod-only table (the transient
# `filing_registry_stage_*` tables, or a table QA's DDL has not reached) is
# named and skipped; a QA-only table is named and left alone. Views are never
# copied (a copy job cannot). A derived list is the point: a hand list is a
# second copy of the DDL that drifts.
#
# WHAT IT NEVER WRITES: any *_prod dataset, lake_bronze_* (QA's loaders keep
# their own ledger — a copied ledger would describe prod's loads, not QA's),
# lake_private_*, and every gold dataset. `lake_check_dst` is the one gate, run
# once before any read, and it refuses each by NAME before it checks the
# allowlist of one. It READS exactly three datasets: the two silvers, and
# lake_bronze_prod's `partition_load` (below).
#
# A TABLE MID-LOAD IN PROD IS SKIPPED — for tables written by the LEDGER-CLAIMED
# loaders (lake-replay-in, lake-replay-us, lake-load-databento: price_bar_d1,
# derivatives_eod_in, delivery_daily, index_eod, fund_nav_d1, trade_bar_*,
# spread_cost_daily). Those DELETE a month and then LOAD it
# (packages/lake/src/load.ts — the pair is not atomic), and the 24 h load jobs
# run at night. A copy between the two statements hands QA that month with ZERO
# rows, and the count check below passes, because the copy faithfully copied an
# empty month. So before planning, and again immediately before each table's
# copy, the tier reads prod's ledger for LOADING claims whose lease is still
# live (LAKE_CLAIM_LEASE_MS = the ledger's CLAIM_LEASE_MS, 6 h; a test holds the
# two equal) and skips those tables with
#   WARN SKIPPED_LOADING <table>: <partitions>
# QA keeps last night's complete copy. A skip EXITS 0 — it is expected during a
# backfill and heals the next night. An unreadable ledger is FATAL, before any
# copy: "could not ask" is not "nothing is loading". The residual window is the
# seconds between the per-table re-read and the copy's snapshot.
#
# A claim OLDER than the lease is copied, exactly as decideClaim would reclaim
# it — but it is not silent. Unless a LATER row for the same month shows a load
# completed since, the run prints
#   WARN STALE_LOADING <table>: <partitions> (claim older than the lease — …)
# because a crashed loader may have deleted that month and never loaded it, and
# then QA faithfully receives the hole. Measured 2026-09-23: eight trade_bar_h1
# months (US/H1/2023-05..12) sat LOADING ~8.6 h with no later ACCEPT.
# "A load completed since" is a later ACCEPTED row, or a later REJECTED row
# with row_count > 0: lake-replay-in writes REJECTED only after `replaceMonth`
# has landed the month (a COVERAGE refusal, MONEY-1612 — e.g. delivery_daily
# IN/2019-10's missing weekend session), so its old-hash LOADING row would
# otherwise warn every night. row_count > 0, not any REJECTED: lake-load-databento
# writes REJECTED with row_count 0 after its purge when the load FAILS, and that
# month may be EMPTY — exactly the hole this warning exists to name.
#
# THE UNCLAIMED WRITERS ARE NOT COVERED, and nothing here can see them. Three
# prod-silver writers take no ledger claim, so no skip protects their tables:
#   identity-sync          `DELETE … WHERE TRUE` then chunked INSERTs on
#                          source_instrument_map and symbol_history, and an
#                          UPDATE-then-INSERT pass on listing
#   corp-action-lake-sink  DELETE then INSERT on corporate_action
# (event-lake-sink deletes only rows whose replacement is already present, and
# filing-registry-sync is one MERGE — both safe to copy mid-run.) Both are
# MANUAL today, with no schedule. Running one near 02:30 IST can hand QA an
# empty or partial table while the count check passes — it checks the copy,
# not the source. If either is ever scheduled, keep it clear of 02:30.
#
# SCHEMA DRIFT. `bq cp -f` is WRITE_TRUNCATE, which replaces QA's rows AND its
# schema with prod's. Prod is the source of truth, so a column prod has and QA
# lacks (corporate_action.observed_ratio, measured 2026-09-23) simply arrives,
# and descriptions follow prod. Four shapes are REFUSED per table instead, and
# fail the run — each is either rejected by the copy job anyway or is QA-first
# DDL (the normal rollout order) that a nightly copy would silently undo:
#   PARTITION/CLUSTER DRIFT  a copy job requires matching partitioning.
#   QA_AHEAD                 QA has a column prod lacks; a copy would drop it.
#   SCHEMA_CONFLICT          a same-name column differs in TYPE or MODE. The
#                            direction is named where BigQuery's one-way ALTERs
#                            make it knowable: REQUIRED -> NULLABLE, and
#                            INT64 -> NUMERIC/BIGNUMERIC/FLOAT64,
#                            NUMERIC -> BIGNUMERIC/FLOAT64.
#
# COUNTS. Prod's and QA's row counts are read before; after each copy the QA
# table's count is compared with the rows the COPY JOB reports copying
# (statistics.copy.copiedRows), not with prod's pre-copy count — prod's
# event-lake-sink writes hourly, so prod may legitimately move mid-run. A
# mismatch fails the run, and so does any COPY-planned table the loop did not
# account for (copied + skipped-loading must equal the plan).
#
# instrument_event IN QA IS PROD'S ROWS PLUS QA'S NEWER ONES. The copy replaces
# QA's table with prod's. event-lake-sink-qa (:10 past each hour) then reads
# its watermark as MAX(ingested_at) in QA SILVER — now prod's — minus its 2 h
# overlap, and appends QA-Mongo events newer than that. QA's own events sunk
# BEFORE the copy are gone from QA silver and are not re-sunk. And a QA sink
# INSERT that commits between a copy and its count read makes QA hold MORE rows
# than copiedRows — a false mismatch. At 02:30 no :10 run overlaps; if one ever
# runs long, the job's one retry (max-retries=1) re-copies and re-counts.
#
# This block runs before anything below it and EXITS: the lake tier never
# reaches the Mongo or GCS code.
LAKE_SRC_DATASET="lake_silver_prod"
LAKE_DST_DATASET="lake_silver_qa"
# READ ONLY: prod's ledger, for in-flight loads. Never written (lake_check_dst).
LAKE_LEDGER_DATASET="lake_bronze_prod"
LAKE_LOCATION="asia-south1"
# = CLAIM_LEASE_MS in packages/lake/src/ledger-logic.ts. This image has no Node
# to import it, so the spawntest imports it and fails if the two part.
LAKE_CLAIM_LEASE_MS=21600000

if [ "$LAKE_APPLY" == "true" ] && [ "$TIER" != "lake" ]; then
    echo "--apply is only for --tier=lake. The other tiers mutate after a prompt (or --yes); preview them with --dry-run."
    exit 1
fi

# The ONE write gate. Returns 0 only for the mirror target; otherwise prints the
# reason and returns 1. Order matters: a prod name is refused AS prod, whatever
# else it is.
lake_check_dst() {
    local ds="$1"
    case "$ds" in
        *_prod|*_prod_*) echo "REFUSING to write ${ds}: a *_prod dataset. This tier only ever writes QA."; return 1 ;;
        lake_bronze_*)   echo "REFUSING to write ${ds}: a bronze LEDGER. QA's loaders keep their own."; return 1 ;;
        lake_private_*)  echo "REFUSING to write ${ds}: lake_private_* is never mirrored."; return 1 ;;
    esac
    # A LITERAL, not "$LAKE_DST_DATASET": an allowlist that reads the constant
    # it guards admits whatever that constant is edited to.
    if [ "$ds" != "lake_silver_qa" ]; then
        echo "REFUSING to write ${ds}: the only dataset this tier writes is lake_silver_qa."
        return 1
    fi
    return 0
}

lake_bq() {
    bq --project_id="$PROJECT_ID" --location="$LAKE_LOCATION" --headless --quiet "$@"
}

# One line per table: name|type|rows|partition|clustering|columns, where
# columns = `name:TYPE:IS_NULLABLE;…` in ordinal order. Commas (in a partition
# or cluster expression, NUMERIC(18, 6), STRUCT<…>) become `;` / `~` so the CSV
# row stays one unquoted field. Descriptions are deliberately NOT read: they
# differ harmlessly and follow prod. A failed read is FATAL: "could not ask"
# must never read as "no tables".
lake_inventory() {
    local ds="$1" out
    out="$(lake_bq query --nouse_legacy_sql --format=csv --max_rows=10000 "
WITH cols AS (
  SELECT table_name,
    STRING_AGG(FORMAT('%s:%s:%s', column_name, REPLACE(data_type, ',', '~'), is_nullable), ';' ORDER BY ordinal_position) AS col_specs
  FROM \`${PROJECT_ID}.${ds}.INFORMATION_SCHEMA.COLUMNS\`
  GROUP BY table_name)
SELECT FORMAT('%s|%s|%d|%s|%s|%s',
  t.table_name, REPLACE(t.table_type, ' ', '_'), IFNULL(m.row_count, -1),
  IFNULL(REPLACE(REGEXP_EXTRACT(t.ddl, r'\nPARTITION BY ([^\n]*)'), ',', ';'), '-'),
  IFNULL(REPLACE(REGEXP_EXTRACT(t.ddl, r'\nCLUSTER BY ([^\n]*)'), ',', ';'), '-'),
  IFNULL(c.col_specs, '-')) AS line
FROM \`${PROJECT_ID}.${ds}.INFORMATION_SCHEMA.TABLES\` t
LEFT JOIN \`${PROJECT_ID}.${ds}.__TABLES__\` m ON m.table_id = t.table_name
LEFT JOIN cols c USING (table_name)
ORDER BY t.table_name")" || return 1
    printf '%s\n' "$out" | tail -n +2 | grep -v '^$' || true
}

# Prod silver LOADING claims from prod's ledger, one line per (state, table):
#   LIVE|table|partition;partition;…    lease holds -> the table is SKIPPED
#   STALE|table|partition;…             lease expired, never reloaded -> WARN
# Same lease arithmetic as decideClaim: a claim is honoured while its age <= the
# lease. ANY live LOADING row counts, even beside a later ACCEPTED one for
# another source hash: two runs on one month is exactly when a delete-then-load
# can be mid-flight. A STALE row is dropped once a later ACCEPTED row — or a
# later REJECTED row that landed rows (row_count > 0) — for the same month shows
# a load completed since. A failed read returns 1.
lake_loading() {
    local out
    out="$(lake_bq query --nouse_legacy_sql --format=csv --max_rows=10000 "
SELECT FORMAT('%s|%s|%s', lease_state, \`table\`, STRING_AGG(DISTINCT partition_key, ';' ORDER BY partition_key)) AS line
FROM (
  SELECT p.\`table\`, p.partition_key,
    IF(TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), p.loaded_at, MILLISECOND) <= ${LAKE_CLAIM_LEASE_MS}, 'LIVE', 'STALE') AS lease_state,
    EXISTS (SELECT 1 FROM \`${PROJECT_ID}.${LAKE_LEDGER_DATASET}.partition_load\` a
            WHERE a.dataset = p.dataset AND a.\`table\` = p.\`table\`
              AND a.partition_key = p.partition_key AND a.loaded_at > p.loaded_at
              AND (a.state = 'ACCEPTED' OR (a.state = 'REJECTED' AND a.row_count > 0))) AS reloaded
  FROM \`${PROJECT_ID}.${LAKE_LEDGER_DATASET}.partition_load\` p
  WHERE p.dataset = '${LAKE_SRC_DATASET}' AND p.state = 'LOADING')
WHERE lease_state = 'LIVE' OR NOT reloaded
GROUP BY lease_state, \`table\`
ORDER BY 1")" || return 1
    printf '%s\n' "$out" | tail -n +2 | grep -v '^$' || true
}

# The derivation, from the two inventories (files). Emits one plan line per
# table in either dataset:
#   COPY|table|prodRows|qaRows|note        REFUSE|table|reason
#   SKIP|table|reason
# POSIX awk only: BSD awk runs the tests, mawk/gawk runs the job.
lake_plan() {
    awk -F'|' '
    # name -> "TYPE:NULLABLE"
    function colmap(s, m,   n, i, parts, f) {
        n = split(s, parts, ";")
        for (i = 1; i <= n; i++) { split(parts[i], f, ":"); m[f[1]] = f[2] ":" f[3] }
    }
    # Is a -> b one of the column type changes BigQuery allows (one-way)?
    function widens(a, b) {
        return (a == "INT64" && (b == "NUMERIC" || b == "BIGNUMERIC" || b == "FLOAT64")) ||
               (a == "NUMERIC" && (b == "BIGNUMERIC" || b == "FLOAT64"))
    }
    # FILENAME, not NR == FNR: with an EMPTY first file NR == FNR holds for
    # the second one too, and every prod table would be read as QA.
    FILENAME == ARGV[1] { q[$1] = $0; next }
    {
        seen[$1] = 1
        if ($1 !~ /^[A-Za-z0-9_]+$/) { print "REFUSE|" $1 "|unsafe table name"; next }
        if ($2 != "BASE_TABLE") { print "SKIP|" $1 "|" $2 " in prod (not a table; copy jobs copy tables)"; next }
        if (!($1 in q)) { print "SKIP|" $1 "|prod-only (not in QA DDL, or a transient stage table)"; next }
        split(q[$1], d, "|")
        if (d[2] != "BASE_TABLE") { print "SKIP|" $1 "|" d[2] " in QA"; next }
        if ($4 != d[4]) { print "REFUSE|" $1 "|PARTITION DRIFT prod=" $4 " qa=" d[4]; next }
        if ($5 != d[5]) { print "REFUSE|" $1 "|CLUSTER DRIFT prod=" $5 " qa=" d[5]; next }
        split("", pc); split("", qc); colmap($6, pc); colmap(d[6], qc)
        ahead = ""; conflict = ""; extra = ""
        for (c in qc) {
            if (!(c in pc)) { ahead = ahead (ahead == "" ? "" : ",") c; continue }
            if (qc[c] == pc[c]) continue
            split(pc[c], p, ":"); split(qc[c], k, ":")
            if (p[1] != k[1]) {
                if (widens(p[1], k[1]))      why = "QA widened " p[1] "->" k[1] " (QA ahead)"
                else if (widens(k[1], p[1])) why = "prod widened " k[1] "->" p[1] " (prod ahead)"
                else                         why = "type prod=" p[1] " qa=" k[1]
            } else if (p[2] == "NO" && k[2] == "YES") why = "QA relaxed REQUIRED->NULLABLE (QA ahead)"
            else if (p[2] == "YES" && k[2] == "NO")   why = "prod relaxed REQUIRED->NULLABLE (prod ahead)"
            else                                       why = "mode prod=" p[2] " qa=" k[2]
            conflict = conflict (conflict == "" ? "" : "; ") c " " why
        }
        if (ahead != "") { print "REFUSE|" $1 "|QA_AHEAD: QA has column(s) prod lacks (" ahead "); a copy would drop them"; next }
        if (conflict != "") { gsub(/~/, ",", conflict); print "REFUSE|" $1 "|SCHEMA_CONFLICT: " conflict "; a copy would overwrite QA'"'"'s"; next }
        for (c in pc) if (!(c in qc)) extra = extra (extra == "" ? "" : ",") c
        note = (extra == "") ? "schema identical" : "prod adds " extra " (prod'"'"'s schema replaces QA'"'"'s)"
        print "COPY|" $1 "|" $3 "|" d[3] "|" note
    }
    END { for (t in q) if (!(t in seen)) print "SKIP|" t "|QA-only (left alone)" }
    ' "$1" "$2"
}

# First numeric value of a JSON string field, e.g. "numRows":"123". bq prints
# int64 fields as strings. Empty when absent.
lake_json_int() {
    grep -o "\"$1\": *\"[0-9]*\"" | head -1 | grep -o '[0-9][0-9]*' || true
}

# Takes NO destination argument: the only dataset it can write is the constant
# run_lake_tier passed through lake_check_dst before anything else ran.
lake_copy_table() {
    local table="$1" job_id="$2"
    lake_bq --job_id="$job_id" cp -f "${PROJECT_ID}:${LAKE_SRC_DATASET}.${table}" "${PROJECT_ID}:${LAKE_DST_DATASET}.${table}"
}

# The LIVE-claimed partitions of one table from a lake_loading result, or nothing.
lake_loading_parts() { printf '%s\n' "$1" | awk -F'|' -v t="$2" '$1 == "LIVE" && $2 == t { gsub(/;/, ", ", $3); print $3 }'; }

run_lake_tier() {
    command -v bq >/dev/null 2>&1 || { echo -e "${RED}Missing required tool: bq (Google Cloud CLI).${NC}"; return 1; }
    local mode="PLAN (no --apply — nothing is written)"
    [ "$LAKE_APPLY" == "true" ] && mode="APPLY"
    echo ""
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║  UseMoney Lake Sync:  ${LAKE_SRC_DATASET} ──> ${LAKE_DST_DATASET}"
    echo "╠════════════════════════════════════════════════════════╣"
    echo "║  Project: ${PROJECT_ID} (${LAKE_LOCATION})"
    echo "║  Mode:    ${mode}"
    echo "╚════════════════════════════════════════════════════════╝"
    echo ""
    # THE write gate, once, BEFORE any read — on a plan as well as an apply.
    # One constant is the only destination lake_copy_table can reach, so one
    # check covers every copy; a second check at the write site could never
    # fire and would only look like a second guard.
    lake_check_dst "$LAKE_DST_DATASET" || return 1

    local work; work="$(mktemp -d -t lake-sync.XXXXXX)"
    # shellcheck disable=SC2064
    trap "rm -rf '$work'" EXIT
    if ! lake_inventory "$LAKE_SRC_DATASET" > "$work/prod.inv"; then
        echo -e "${RED}Could not read ${LAKE_SRC_DATASET}'s inventory — refusing (that is not 'no tables').${NC}"; return 1
    fi
    if ! lake_inventory "$LAKE_DST_DATASET" > "$work/qa.inv"; then
        echo -e "${RED}Could not read ${LAKE_DST_DATASET}'s inventory — refusing (that is not 'no tables').${NC}"; return 1
    fi
    if ! lake_loading > "$work/loading"; then
        echo -e "${RED}Could not read ${LAKE_LEDGER_DATASET}.partition_load — refusing (that is not 'nothing is loading').${NC}"; return 1
    fi
    # A COPY whose table holds a live LOADING claim becomes LOADING|table|parts.
    lake_plan "$work/qa.inv" "$work/prod.inv" \
        | awk -F'|' 'FILENAME == ARGV[1] { if ($1 == "LIVE") l[$2] = $3; next }
                     $1 == "COPY" && ($2 in l) { print "LOADING|" $2 "|" l[$2]; next }
                     { print }' "$work/loading" - \
        | sort -t'|' -k2,2 > "$work/plan"

    local n_copy n_loading
    n_copy="$(grep -c '^COPY|' "$work/plan" || true)"
    n_loading="$(grep -c '^LOADING|' "$work/plan" || true)"
    echo -e "${BLUE}Plan (${n_copy} table(s) to copy, ${n_loading} mid-load in prod):${NC}"
    awk -F'|' '
      $1 == "COPY"    { printf "    COPY    %-24s prod=%-11s qa=%-11s %s\n", $2, $3, $4, $5 }
      $1 == "LOADING" { gsub(/;/, ", ", $3); printf "    SKIPPED_LOADING %s: %s\n", $2, $3 }
      $1 == "REFUSE"  { printf "    REFUSE  %-24s %s\n", $2, $3 }
      $1 == "SKIP"    { printf "    skip    %-24s %s\n", $2, $3 }' "$work/plan"
    # Copied anyway (decideClaim parity), but never silently.
    awk -F'|' '$1 == "STALE" { gsub(/;/, ", ", $3)
        printf "    WARN STALE_LOADING %s: %s (claim older than the lease — possibly a crashed loader holding a deleted month)\n", $2, $3 }' "$work/loading"
    echo ""
    if [ $((n_copy + n_loading)) -eq 0 ]; then
        # Never a successful night — but say WHICH nothing it is.
        local n_refused; n_refused="$(grep -c '^REFUSE|' "$work/plan" || true)"
        if [ "$n_refused" -gt 0 ]; then
            echo -e "${RED}Nothing to copy: ${n_refused} table(s) REFUSED (see the REFUSE lines above) and none left to copy. Resolve the drift; the tables exist.${NC}"
        else
            # An empty intersection: QA's DDL was never applied, or the read saw nothing.
            echo -e "${RED}Nothing to copy: no BASE TABLE exists in both datasets. Apply the lake DDL to QA (scripts/ops/lake-apply-ddl.ts).${NC}"
        fi
        return 1
    fi

    if [ "$LAKE_APPLY" != "true" ]; then
        echo -e "${CYAN}Per-table command (WRITE_TRUNCATE copy, free in-region):${NC}"
        # The argv lake_bq + lake_copy_table issue, with the per-run job id elided.
        awk -F'|' -v p="$PROJECT_ID" -v s="$LAKE_SRC_DATASET" -v d="$LAKE_DST_DATASET" -v l="$LAKE_LOCATION" \
            '$1 == "COPY" { printf "    bq --project_id=%s --location=%s --headless --quiet --job_id=lake_sync_%s_<run> cp -f %s:%s.%s %s:%s.%s\n", p, l, $2, p, s, $2, p, d, $2 }' "$work/plan"
        echo ""
        echo -e "${CYAN}PLAN complete — re-run with --apply to copy.${NC}"
        return 0
    fi

    local failed=() copied=0 skipped=0 recheck_skipped=0 loop_failed=0
    local table prod_rows qa_rows job_id expected after loading_now parts
    local stamp; stamp="$(date -u +%Y%m%d_%H%M%S)"
    while IFS='|' read -r kind table reason; do
        case "$kind" in
            REFUSE)  failed+=("${table} (${reason%%:*})") ;;
            LOADING) echo -e "  ${YELLOW}WARN SKIPPED_LOADING ${table}: ${reason//;/, }${NC}"; skipped=$((skipped + 1)) ;;
        esac
    done < "$work/plan"
    # The plan is read on fd 3, never stdin: a command in the body that reads
    # stdin (a prompt, a tool that drains its input) would otherwise swallow the
    # rest of the plan and end the loop early — which the accounting check after
    # the loop also catches.
    while IFS='|' read -r kind table prod_rows qa_rows _ <&3; do
        [ "$kind" == "COPY" ] || continue
        # Re-read the ledger NOW: a load that claimed this table after the plan
        # was read must not be copied half-done.
        if ! loading_now="$(lake_loading)"; then
            echo -e "  ${RED}✗ ${table}: ledger unreadable — not copied${NC}"
            failed+=("${table} (ledger)"); loop_failed=$((loop_failed + 1)); continue
        fi
        parts="$(lake_loading_parts "$loading_now" "$table")"
        if [ -n "$parts" ]; then
            echo -e "  ${YELLOW}WARN SKIPPED_LOADING ${table}: ${parts}${NC}"
            skipped=$((skipped + 1)); recheck_skipped=$((recheck_skipped + 1)); continue
        fi
        job_id="lake_sync_${table}_${stamp}_$$"
        echo -e "  ${table}: prod=${prod_rows} qa_before=${qa_rows} ..."
        if ! lake_copy_table "$table" "$job_id"; then
            echo -e "  ${RED}✗ ${table}: copy FAILED (job ${job_id})${NC}"
            failed+=("${table} (copy)"); loop_failed=$((loop_failed + 1)); continue
        fi
        expected="$(lake_bq --format=json show -j "$job_id" | lake_json_int copiedRows)"
        after="$(lake_bq --format=json show "${PROJECT_ID}:${LAKE_DST_DATASET}.${table}" | lake_json_int numRows)"
        if [ -z "$expected" ]; then
            # The job reported no copiedRows; prod's pre-copy count is the
            # fallback, and it is named as the fallback.
            expected="$prod_rows"
            echo -e "    (job ${job_id} reported no copiedRows — compared with prod's pre-copy count)"
        fi
        if [ -z "$after" ] || [ "$after" != "$expected" ]; then
            echo -e "  ${RED}✗ ${table}: COUNT MISMATCH — copied=${expected} qa_after=${after:-unreadable}${NC}"
            failed+=("${table} (count ${expected}!=${after:-?})"); loop_failed=$((loop_failed + 1)); continue
        fi
        echo -e "  ${GREEN}✓ ${table}: copied=${expected} qa_after=${after}${NC}"
        copied=$((copied + 1))
    done 3< "$work/plan"

    # Every COPY-planned table must end in exactly one outcome. Fewer means the
    # loop stopped early, and "N copied, 0 failed" would then be a clean-looking
    # report over tables nobody reached.
    local accounted=$((copied + recheck_skipped + loop_failed))
    if [ "$accounted" -ne "$n_copy" ]; then
        echo -e "${RED}  The copy loop accounted for ${accounted} of ${n_copy} planned table(s) — it ended early.${NC}"
        failed+=("loop ($((n_copy - accounted)) unreached)")
    fi

    echo ""
    echo "QA gold: the lake-gold-qa job (Dataform CLI) rebuilds from this silver at 06:45/20:15 IST"
    echo "  once ./scripts/ops/setup-dataform.sh qa has run; the copy triggers nothing."
    if [ ${#failed[@]} -gt 0 ]; then
        echo -e "${RED}Lake sync FAILED: ${copied} copied, ${skipped} skipped (loading), ${#failed[@]} failed: ${failed[*]}${NC}"
        return 1
    fi
    echo -e "${GREEN}Lake sync complete: ${copied} copied, ${skipped} skipped (loading) ${LAKE_SRC_DATASET} -> ${LAKE_DST_DATASET}.${NC}"
    return 0
}

if [ "$TIER" == "lake" ]; then
    # `if` rather than a bare call: under `set -e` a non-zero return would exit
    # before the status could be reported, and the status IS the job's.
    if run_lake_tier; then exit 0; else exit 1; fi
fi

# ── GCS buckets (prod -> qa, hard-coded) ──
# The prefix depends on the tier: scraped PDFs for `reference`, archived raw
# exchange files for `feeds` (MONEY-1085).
#
# ── WHAT THE FEEDS TIER DELIBERATELY DOES NOT MIRROR — MONEY-1309 ────────────
#
# `feeds/TIINGO/ws/{date}/` is raw websocket TICKS written by the always-on
# `tiingo-realtime-{env}` service. It lives under `feeds/` because that is where
# raw upstream bytes live, but it is the one thing under that prefix QA must
# NOT receive, and the reason is structural rather than budgetary:
#
#   - It is not a REPLAY input. Every other object here exists so QA can
#     re-INGEST prod's exact bytes (`DailyPrice` keys on `instrumentId` and QA
#     holds its own ids, so the ROWS are not portable). Ticks are not ingested
#     by any QA job; the bars derived from them land in `candles`, which keys on
#     (symbol, exchange, timeframe, ts), carries no ObjectId, is in
#     REFERENCE_COLLECTIONS, and therefore reaches QA by mongorestore already.
#     Copying the ticks would mirror the INPUT of a computation QA receives the
#     OUTPUT of.
#   - It is deleted at 30 days by scripts/ops/gcs-lifecycle.json, on the PROD
#     bucket. Mirroring it would put a copy in QA's bucket where that rule
#     applies too — but the two buckets' lifecycle passes are independent, so
#     the QA copy is a second, unbounded-by-anything-we-watch growth curve for
#     bytes nothing reads.
#   - It is the largest thing under `feeds/` by a wide margin: a full US session
#     of ticks is orders of magnitude larger than the bars it produces.
#
# ── THE FLAG, AND ITS MEASURED SEMANTICS ─────────────────────────────────────
#
# `gcloud storage rsync --exclude=REGEX` (`-x`). Two properties matter and both
# were MEASURED against SDK 554.0.0 rather than read off the help text, because
# getting either wrong fails silently — a regex that matches nothing copies the
# ticks and says so nowhere:
#
#   1. THE PATH IS RELATIVE TO SOURCE. With SOURCE `gs://…/feeds/`, the object
#      `feeds/TIINGO/ws/2026-08-31/x.jsonl` is matched as
#      `TIINGO/ws/2026-08-31/x.jsonl`. The leading `feeds/` is NOT in the string
#      — an exclude of `^feeds/TIINGO/ws/` matches nothing at all.
#   2. IT IS ANCHORED AT THE START (Python `re.match`, not `re.search`).
#      Measured on a four-object fixture: `ws/` excluded NOTHING, and
#      `TIINGO/ws/` excluded `TIINGO/ws/…` while leaving `xTIINGO/ws/…` alone.
#      The leading `^` is therefore redundant — and it is kept anyway, because
#      "redundant" and "wrong" look identical to a reader and the next person to
#      edit this regex should be able to see the intent without re-running the
#      experiment.
#
# THIS REGEX AND THE LIFECYCLE PREFIX ARE ONE RULE WRITTEN IN TWO FILES, which
# is this repo's most reliable drift shape. `GCS_PREFIX_LABEL` + the regex must
# reconstruct `feeds/TIINGO/ws/` exactly; that reconstruction is asserted by
# packages/core/__tests__/ops/tiingo-realtime-infra.test.ts.
#
# The exclusion is an ARRAY, empty on the non-feeds tier. Not a string: a string
# would have to be interpolated unquoted to vanish, and an empty `--exclude=`
# is a regex that matches every path at position 0. Tier-scoped rather than
# unconditional because the regex is RELATIVE to GCS_SRC — under `stocks/` it
# would mean `stocks/TIINGO/ws/`, a path that does not exist and a rule nobody
# reasoned about.
if [ "$TIER" == "feeds" ]; then
    GCS_SRC="gs://stockbook-content-prod/feeds/"
    GCS_DST="gs://stockbook-content-qa/feeds/"
    GCS_PREFIX_LABEL="feeds/"
    GCS_EXCLUDE_REGEX="^TIINGO/ws/"
    GCS_RSYNC_EXCLUDE=(--exclude="$GCS_EXCLUDE_REGEX")
    # ── THE SECOND PAIR: the candle warehouse's COLD SHARDS (MONEY-1373) ──
    #
    # `candles/{market}/{timeframe}/{symbol}/{year}` — gzipped JSONL with NO
    # file extension (the format is sniffed from magic bytes). This prefix was
    # never mirrored, and the failure is silent in the worst direction: the
    # Mongo `candles` table IS a REFERENCE_COLLECTION, so QA receives the hot
    # window by mongorestore and then answers every COLD read `absent` — which
    # is the shape of "no data in that range", not of an error. Pre-existing
    # for the D1 series; MONEY-1373's M1/H1 harvest widens it to everything
    # older than the 45-day intraday hot window, i.e. almost all of it.
    #
    # NO EXCLUSION ARRAY, deliberately — not an oversight to be tidied up by
    # reusing GCS_RSYNC_EXCLUDE. `--exclude` is RELATIVE to its own SOURCE, so
    # that array means `candles/TIINGO/ws/` here: a path nobody reasoned about,
    # and one that would silently drop any shard whose {market}/{timeframe}
    # segments ever matched it. rsync exits 0 either way. There is nothing
    # under `candles/` QA should be denied — it is DERIVED output, not a raw
    # metered feed, and it is what QA cannot recompute for itself.
    #
    # The `CANDLES_GCS_` prefix is load-bearing, so do NOT shorten it to
    # `CANDLES_`: edgar-monitor-and-scheduler.spawntest.ts enumerates the
    # mirrored prefixes by scraping every GCS_SRC assignment that names the prod
    # bucket, and deep-equals the sorted list — which is how a NEW mirrored
    # prefix is forced to be a deliberate edit there. A name that regex cannot
    # see would evade that guard rather than satisfy it.
    #
    # (And do not spell that pattern out here as a literal. Its `[^"]` runs
    # across newlines, so a comment quoting it becomes a fourth "prefix" and
    # the guard compares garbage. Found by the guard, on this very comment.)
    CANDLES_GCS_SRC="gs://stockbook-content-prod/candles/"
    CANDLES_GCS_DST="gs://stockbook-content-qa/candles/"
    CANDLES_GCS_PREFIX_LABEL="candles/"
    # ── THE THIRD PAIR: the D1 CHART TILES (MONEY-1478) ──────────────────
    #
    # NOTE THE BUCKET. These are the only mirrored objects NOT in
    # `stockbook-content-*` — the tile lake is its own bucket pair,
    # `stockbook-lake-{prod,qa}`. Copying the prefix onto the content bucket
    # would create an empty `tiles/` nobody reads while QA's charts stayed
    # blank, and rsync would exit 0.
    #
    # WHY MIRROR RATHER THAN BUILD. QA has its own `tile-build-d1-{in,us}`
    # jobs, and measured 2026-09-18 the US one is provisioned 2Gi/1CPU/1 task
    # against the 8Gi/2CPU/4 its own script specifies — so it is OOM-killed
    # every night ("Container terminated on signal 9") and
    # `gs://stockbook-lake-qa/tiles/US/` HAS NEVER EXISTED. Re-sizing it would
    # fix the crash and still leave QA recomputing, from `candles`, something
    # prod has already computed correctly.
    #
    # A TILE IS PORTABLE, which is what makes this legal where the feeds are
    # not. `DailyPrice` keys on `instrumentId` and QA holds its OWN ObjectIds,
    # so India's price ROWS cannot be copied and QA must re-INGEST prod's bytes.
    # A tile is keyed by `{market}/d1/{listingId}/` — a symbol, an exchange and
    # a date, no ObjectId anywhere — so QA can receive the OUTPUT directly.
    # Same argument, same conclusion, as `candles` above.
    #
    # NO EXCLUSION ARRAY, for the reason spelled out on the candles pair:
    # `--exclude` is relative to its own SOURCE, so the feeds regex would mean
    # `tiles/TIINGO/ws/` here — a path nobody reasoned about.
    TILES_GCS_SRC="gs://stockbook-lake-prod/tiles/"
    TILES_GCS_DST="gs://stockbook-lake-qa/tiles/"
    TILES_GCS_PREFIX_LABEL="tiles/"
else
    GCS_SRC="gs://stockbook-content-prod/stocks/"
    GCS_DST="gs://stockbook-content-qa/stocks/"
    GCS_PREFIX_LABEL="stocks/"
    GCS_EXCLUDE_REGEX=""
    GCS_RSYNC_EXCLUDE=()
    CANDLES_GCS_SRC=""
    CANDLES_GCS_DST=""
    CANDLES_GCS_PREFIX_LABEL=""
    TILES_GCS_SRC=""
    TILES_GCS_DST=""
    TILES_GCS_PREFIX_LABEL=""
fi

# ============================================
# RATE-LIMITED-source collection ALLOWLIST (prod -> qa) — MONEY-855
# ============================================
# ONLY collections whose data comes from a RATE-LIMITED / IP-blocked / expensive
# source that QA must NOT hit itself (Screener, Tickertape, NSE/BSE per-symbol,
# Kuvera, AI-extraction). QA fetches everything else (instruments, prices, MF
# base, Yahoo, RSS) directly via its own crons — see the QA-DIRECT note in the
# EXCLUDED block below. (Collection names are the Prisma @@map value where present,
# else the model name; verified against workers/src/processors/*-sync.ts +
# packages/*/src.) None carry user PII.
REFERENCE_COLLECTIONS=(
    # ── Scraped documents METADATA (Screener/NSE/Tickertape/BSE) — PDFs live in GCS ──
    "stock_documents"          # StockDocument      - stock-document-sync / bse-announcements-sync
    "upcoming_ipos"          # UpcomingIpo — ipo-sync is PROD_ONLY (MONEY-1098 P5.6)
    "upcoming_events"        # UpcomingEvent — events-sync now NSE-primary, PROD_ONLY (MONEY-1098 P5.3)
    # ── Ownership (NSE corporate-filings APIs, per-symbol weekly fan-out) ──
    # ownership-sync is PROD_ONLY (scrape-once), so these reach QA ONLY here.
    # Both the processor header and the scheduler description already promised
    # this sync existed while the allowlist did not list them — QA's tables
    # would have stayed permanently empty with every comment insisting they
    # were fed (MONEY-1098 P5.4).
    "shareholding_patterns"  # ShareholdingPattern - ownership-sync
    "insider_events"         # InsiderEvent        - ownership-sync (PIT/SAST/pledge)
    # MONEY-1205. Added in the SAME change that gave the processor its first
    # write to this collection, not after — which is the whole lesson of the five
    # instances above, and the guard in
    # packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts caught
    # it on the first run. Two prod-only legs write it: `shpXbrl` (NSE's SHP XBRL
    # filings) and `bse` (api.bseindia.com per scrip), so QA has no writer for it
    # at all and would otherwise sit permanently at 0 rows while both the
    # processor header and two scheduler descriptions insisted it was fed.
    # Index safety, the caveat this list carries: the collection is NEW, so
    # `mongorestore --drop` replacing QA's indexes with prod's is a no-op —
    # both sides get exactly what schema.prisma declares.
    "shareholding_breakdown" # ShareholdingBreakdown - ownership-sync (shpXbrl + bse)
    # ── US price backbone (Tiingo, PROD_ONLY) — MONEY-980 ──
    # Listed in the SAME change that made `us-eod-sync-daily` prod-only, which
    # is the lesson the five instances above are all instances of.
    #
    # These are portable in a way `daily_prices` is NOT: `Candle` keys on
    # (symbol, exchange, timeframe, ts) and holds no ObjectId reference, so a
    # restore lands correctly in an environment with different instrument _ids.
    # That is exactly why the US job can be prod-only while India's bhavcopy
    # cannot, and why QA does not spend a second copy of a metered API quota.
    "candles"                  # Candle             - us-eod-sync / tiingo-us-backfill
    # MONEY-980 — the US master moved OUT of instrument_mappings into its own
    # collection. That is what makes it syncable at all: `instrument_mappings`
    # is QA-DIRECT precisely because it is the FK target every price row points
    # at, so it can never be restored over. `us_instruments` is nothing's FK
    # target — `candles` reaches it by (symbol, exchange) — so it restores
    # cleanly into an environment with different ObjectIds.
    "us_instruments"           # UsInstrument       - us-instrument-master-sync
    "us_fund_nav"              # UsFundNav          - us-eod-sync leg (b)
    "us_stock_news"            # UsStockNews        - us-eod-sync leg (f)
    # MONEY-1309 — the 24x7 `tiingo-news-poll` job's OWN table, and NOT the row
    # above it. That distinction cost a test failure on the way in: the poller
    # is a separate stream with its own model (`UsNewsArticle`), keyed on
    # Tiingo's `tiingoId` rather than on anything of ours, so it does not write
    # `us_stock_news` at all.
    #
    # This row is what makes `tiingo-news-poll` prod-only DEFENSIBLE. The job
    # runs 720 times a day; a QA copy would make it 1,440 against ONE metered
    # Tiingo quota, paced by a per-PROCESS limiter that cannot see the other
    # environment. Prod-only without this line would simply mean "QA has no
    # news".
    #
    # Portable for the same reason as `candles`: the row carries no ObjectId
    # reference — `tiingoId` is upstream's identity claim and the tickers are
    # symbol strings — so a restore lands correctly in an environment holding
    # different instrument _ids.
    #
    # `us_news_cursor` is deliberately NOT here. It is the poller's WATERMARK,
    # and copying operational detection state is the refusal `us_edgar_cursor`
    # already records: prod's watermark restored into QA would make a QA run
    # skip everything prod has seen and report a clean, healthy, entirely empty
    # run. It is exempted WITH that reason in
    # packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts.
    "us_news_articles"         # UsNewsArticle      - tiingo-news-poll (MONEY-1309)
    "fx_rates"                 # FxRate             - us-eod-sync leg (d)
    # MONEY-1263 — the US corporate-actions CALENDAR (forward-dated ex-dates and
    # announcement metadata), written by us-eod-sync leg (e) and the day-walk
    # backfill. Portable for the same reason as `candles`: the row keys on
    # `permaTicker`, not on an ObjectId, so a restore lands correctly in an
    # environment holding different instrument _ids.
    #
    # A SEPARATE collection from `corporate_actions` deliberately — that table's
    # readers scope by symbol with no exchange term (pairing.ts feeds FIFO cost
    # basis), and 214 active Indian symbols collide with a US ticker.
    "us_corporate_actions"     # UsCorporateAction  - us-eod-sync leg (e)
    # ── US intraday backbone + cost model (Databento, PROD_ONLY) — MONEY-1373 ──
    # Portable for exactly the reason `candles` is, and it is worth restating
    # because it is what LETS the two Databento jobs be prod-only: none of these
    # rows carries an ObjectId reference. The cost model joins by `listingId` —
    # a STRING, `{symbol}:{exchange}:{listingStartDate}` — and the batch-job
    # ledger keys on Databento's own job id, so a restore lands correctly in an
    # environment holding different instrument _ids. QA therefore receives what
    # prod harvested instead of buying a second copy of a METERED vendor's data,
    # which is the same trade `candles` makes against Tiingo's quota.
    "databento_batch_jobs"     # DatabentoBatchJob  - databento-harvest / -append
    "us_cost_model_versions"   # UsCostModelVersion - the cost-model builder
    "us_cost_model_rows"       # UsCostModelRow     - the cost-model builder
    # ── US fundamentals (SEC EDGAR, PROD_ONLY) — MONEY-979 ──
    # Written by services/us-fundamentals (Python). PROD fetches, QA receives:
    # Cloud Run has SHARED egress IPs and SEC's fair-access limit is per IP, so
    # two environments scraping the same 10 req/s budget is one environment
    # getting both of them blocked. QA runs with SEC_EGRESS=off and cannot reach
    # sec.gov at all — these rows are the ONLY way US fundamentals exist there.
    #
    # Portable for the same reason `candles` is: every one of these keys on a
    # natural identifier (accession, cik10, cusip) and holds no ObjectId
    # reference, so a restore lands correctly against QA's own instrument ids.
    "us_filers"                # UsFiler                - edgar-bulk-submissions
    "us_filings"               # UsFiling               - edgar-detect + bulk submissions
    "us_fundamentals"          # UsFundamentals         - edgar-parse-financials + bulk companyfacts
    "us_company_facts"         # UsCompanyFact          - edgar-bulk-companyfacts
    "us_insider_transactions"  # UsInsiderTransaction   - edgar-parse-ownership
    "us_13f_filings"           # UsThirteenFFiling      - edgar-parse-13f
    "us_13f_holdings"          # UsThirteenFHolding     - edgar-parse-13f (hot window only)
    "us_beneficial_ownership"  # UsBeneficialOwnership  - edgar-parse-13dg
    "us_filing_documents"      # UsFilingDocument       - edgar-parse-8k
    # MONEY-1324 (P17). The AI reading of the row above, and the ONLY row in
    # this US block whose writer is a TypeScript worker rather than the Python
    # service — `us-filing-insight`, whose sweep is in PROD_ONLY_JOBS.
    #
    # Prod-only for a different reason from its neighbours: the cost is not SEC
    # egress, it is a PAID Gemini call per document. QA's inputs are already
    # prod's by copy (the line above), so a QA run would spend a second reading
    # of identical bytes to reach the identical answer.
    #
    # Portable on the same terms as the rest of the block: the key is
    # (accession, sequence) and the one ObjectId it carries, `documentId`, points
    # at `us_filing_documents` — restored from prod in the SAME pass, so the
    # reference stays valid rather than dangling.
    "us_filing_insights"       # UsFilingInsight        - us-filing-insight (TS worker)
    "us_cusip_map"             # UsCusipMap             - edgar-parse-13f + nightly sweep
    # `us_edgar_cursor` is DELIBERATELY NOT HERE — see QA_DIRECT in
    # packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts.
    # Restoring prod's detection watermark into QA would make a QA detect run
    # skip every filing prod has already seen and report a healthy empty run.
    # ── Corporate actions (NSE/BSE/Screener, market-wide) ──
    "corporate_actions"        # CorporateAction    - corporate-actions-sync
    # ── Fundamentals (Tickertape) ──
    "stock_financials"         # StockFinancials    - financial-data-sync
    "stock_ratios"             # StockRatios        - financial-data-sync
    # ── Screener-scraped sections ──
    "stock_peers"              # StockPeers         - screener full-scraper
    "stock_shareholding"       # StockShareholding  - screener full-scraper
    # ── Scraped news (the RSS news_articles is QA-direct; this is the scrape) ──
    "stock_news"               # StockNews          - news-sync scrape
    # ── Index constituents (NSE/Screener/Tickertape) ──
    "index_constituents"       # IndexConstituent   - index-constituent-sync
    # index_memberships rides the SAME prod-only worker, and leaving it out was
    # the third instance of the bug the shareholding_patterns comment below
    # already describes (MONEY-1098 P5.4). `index-constituent-sync-weekly` is in
    # PROD_ONLY_JOBS, so QA has no worker writing this table; the MONEY-1189
    # backfill seeded both environments to 924 intervals, which made them look
    # identical on the day and would have left QA frozen there forever while
    # prod accrued weekly membership events. Silent — no error, no counter, the
    # table simply stops moving.
    "index_memberships"        # IndexMembership    - index-constituent-sync (MONEY-1189)
    # ── Stock flags (surveillance / bands / F&O ban / 52w) ── MONEY-1196
    # FOURTH instance of the bug the two comments above already record, and the
    # starkest: `stockFlag` has exactly ONE writer in the whole repo
    # (workers/src/processors/surveillance-sync.ts), `surveillance-sync-daily` is
    # in PROD_ONLY_JOBS, and this collection was absent here. Measured
    # 2026-08-13: prod 7,527,076 rows, QA **0**. Not stale — empty since
    # inception, backing a retail warning surface that therefore cannot be
    # exercised on QA at all.
    #
    # SIZE, stated because it is by far the largest thing in this allowlist —
    # ~7.5M rows against corporate_actions' ~55k, two orders of magnitude more.
    # This is a nightly DROP+restore, so the first run is the one to watch:
    # if it stretches the 01:00 IST window unacceptably, the answer is a
    # bounded/incremental copy for this collection, NOT dropping it back out and
    # returning QA to zero.
    #
    # Index-clobber check done before adding (the rule the index_memberships
    # comment sets): listIndexes on both sides returns the identical four
    # (_id_, symbol+kind+date, kind+date, date), so `mongorestore --drop`
    # replaces QA's with prod's as a no-op. With no QA writer there is also
    # nothing QA-generated to lose.
    "stock_flags"              # StockFlag          - surveillance-sync (MONEY-1196)
    # ── Institutional flows (NSE /api/fiidiiTradeReact, market-wide daily) ──
    # institutional-flow-sync-daily is PROD_ONLY (it scrapes nseindia.com), so
    # this line is the ONLY way the table ever reaches QA. Added WITH the
    # feature rather than after it, because the two prior instances of this bug
    # (shareholding_patterns, index_memberships — see the comments above) both
    # shipped a prod-only worker whose header and scheduler description promised
    # a sync that the allowlist did not actually list, leaving QA's table
    # permanently empty with every comment insisting it was fed.
    #
    # Unlike daily_prices this mirrors CLEANLY: InstitutionalFlow is market-wide
    # and carries no instrumentId foreign key, so there is no FK graph to drag
    # along and QA's own ObjectIds are untouched.
    "institutional_flows"      # InstitutionalFlow  - institutional-flow-sync (MONEY-1108 P8d)
    # ── Macro series (RBI NSDP: WSS + MOSPI CPI + OEA WPI) — MONEY-1106 P8b ──
    # `macro-sync-weekly` / `-midweek` are PROD_ONLY (scrape-once against
    # rbi.org.in), so prod is the only environment with a writer. Listed here on
    # the SAME reasoning the index_memberships comment above spells out: without
    # it QA's table stays empty forever while the processor header, the topic
    # comment and the scheduler description all assert it is fed.
    #
    # Safe to copy wholesale, unlike the price tables: `macro_series` keys on
    # (seriesId, period) — two strings-and-a-date — and holds NO instrumentId,
    # so it has none of the QA-mints-its-own-ObjectId hazard that made a
    # DailyPrice mirror the wrong answer (see feed-archive.ts's header).
    "macro_series"             # MacroSeries        - macro-sync (MONEY-1106)
    # ── Company financials from the exchange's own XBRL — MONEY-1113 P10 F1 ──
    # `xbrl-sync-daily` is PROD_ONLY: it walks NSE's corporate-filings API and
    # then downloads one XML per filing, which is a per-filing fan-out against
    # nseindia.com — the same shape as ownership-sync, and the same reason.
    #
    # Carries an `instrumentId`, and that pointer will DANGLE in QA: QA mints its
    # own ObjectIds for `instrument_mappings` (QA-DIRECT), so prod's ids do not
    # resolve there. That is acceptable here and NOT the daily_prices hazard,
    # because identity in this table is (symbol, exchange, periodEnd, periodType,
    # basis, cumulative) — every reader joins on the symbol, and instrumentId is
    # a convenience index. It is the same trade already accepted for
    # `stock_financials` / `stock_ratios` above, stated explicitly here so the
    # next person does not have to re-derive whether it was considered.
    "xbrl_filings"             # XbrlFiling         - xbrl-sync (MONEY-1113 P10 F1)
    # ── AMC monthly portfolio disclosures — MONEY-1105 P8a ──
    # `mf-portfolio-sync-monthly` is PROD_ONLY, and THIS COPY IS THE ONLY PATH
    # THAT FEEDS QA.
    #
    # CORRECTED 2026-09-13 (MONEY-1404 C6). This comment used to claim the
    # fetch "goes through the feed-archive seam (so QA *can* replay the bytes
    # once FEED_ARCHIVE_MODE is switched on)", and that FEED_ARCHIVE_MODE was
    # "still unset in both Cloud Run specs". Both halves were false, and in
    # opposite directions:
    #
    #   - `workers/src/processors/mf-portfolio-sync.ts` calls `fetch(` twice
    #     (:231, :272) and `getFeedAsset` zero times. Nothing about this feed
    #     is archived, so there are no bytes for QA to replay — the switch the
    #     comment was waiting for would change nothing.
    #   - FEED_ARCHIVE_MODE has been `archive` on prod and `replay` on QA since
    #     2026-08-12 (both live in the workers' Cloud Build specs). So the one
    #     stated precondition had been met for a month while the claim that it
    #     had not was the reason nobody looked.
    #
    # Which is the four-comments-above bug once more: a comment describing an
    # arrangement nobody had run. The MF NAV feed itself (AMFI NAVAll, via
    # `amfi-mf-provider.ts`) IS seamed as of MONEY-1404 and prod now archives it
    # under `feeds/AMFI/navall/{YYYY}/{MM}/NAVAll-{YYYY-MM-DD}.txt`; this AMC
    # portfolio leg is NOT, and is tracked as its own migration rather than
    # described as one already done.
    #
    # Volume note: ~5 AMCs x ~110 schemes x ~50 holdings is order 10^4-10^5 rows
    # per month, so this grows steadily. Nothing near stock_flags' 7.5M, but it
    # is not a small reference table either and is worth watching at year two.
    "mf_portfolio_holdings"    # MfPortfolioHolding - mf-portfolio-sync (MONEY-1105 P8a)
    # ── NSE exchange circulars — MONEY-1187 P11 item 7 ──
    # `circulars-sync-daily` is PROD_ONLY (it scrapes nseindia.com). Market-wide
    # with no instrumentId FK, so it mirrors cleanly — same reasoning as
    # institutional_flows above.
    "nse_circulars"            # NseCircular        - circulars-sync (MONEY-1187 P11)
    # ── NSE's OWN published movers + live index snapshot — MONEY-1198 ──
    # `market-movers-sync` is PROD_ONLY (it polls nseindia.com every 3 min
    # during market hours). Market-wide, no instrumentId FK, so both mirror
    # cleanly — same reasoning as institutional_flows and nse_circulars above.
    #
    # These exist because the Discover panel used to RANK OUR OWN
    # `latest_quotes` and nothing refreshed that table intraday, so it served
    # the previous session's move captioned "today". Reading the exchange's own
    # ranked list removes the derivation instead of patching it.
    "market_movers"            # MarketMover        - market-movers-sync (MONEY-1198)
    "index_live_snapshots"     # IndexLiveSnapshot  - market-movers-sync (MONEY-1198)
    # ── Participant-wise F&O positioning — MONEY-1187 P11 item 1 ──
    # Market-wide with no instrumentId FK, so it mirrors cleanly — same reasoning
    # as institutional_flows and nse_circulars above.
    #
    # THIS ENTRY REPLACES A COMMENT THAT WAS FACTUALLY WRONG, and the correction
    # is written down because the wrong version was the DANGEROUS kind: it
    # asserted the gap had been considered and dismissed. It read:
    #
    #   "NOT LISTED, deliberately: `market_positioning`. Its writer is
    #    `feed-parse`, which is NOT prod-only — QA runs its own pass over the
    #    replayed archive and therefore populates the table itself."
    #
    # `feed-parse` is not a worker processor at all — it is a Cloud Run JOB, and
    # its nightly trigger is created ONLY when ENV=prod
    # (setup-feed-backfill-job.sh: `feed-parse-nightly` / `fo-summary-nightly`
    # live inside an `if [ "$ENV" = "prod" ]` block; QA gets the job provisioned
    # with NO schedule). So QA never ran that pass, `market_positioning` was
    # empty forever, and the comment insisted otherwise. Fifth instance of this
    # exact class after shareholding_patterns (MONEY-1098), index_memberships
    # (MONEY-1189), institutional_flows (MONEY-1108) and stock_flags
    # (MONEY-1196).
    #
    # The alternative fix — give QA its own feed-parse-nightly trigger — is now
    # genuinely possible (the feeds/ mirror went live 2026-08-12) and IS the
    # better long-term shape, because a QA that re-derives catches a broken QA
    # parse that a copy of prod's rows would mask. It is deliberately NOT done
    # here: that trigger also writes derivative_eod / derivative_summary, so it
    # changes QA's nightly cost and behaviour well beyond this one table. Copy
    # down now, re-derive later as its own change.
    #
    # Volume: 4 participants x 6 buckets x 2 metrics = 48 rows per trading day,
    # x 1,636 archived days once the P11 backfill lands = ~78k rows. Trivial
    # next to stock_flags' 7.5M.
    "market_positioning"       # MarketPositioning  - feed-parse Cloud Run JOB (MONEY-1187 P11)
    # ── The rest of feed-parse's prod-only output — MONEY-1198 ──
    # Found by EXTENDING the guard test to Cloud Run jobs, not by inspection.
    # `feed-parse` writes EIGHT models; the guard only ever scanned
    # workers/src/processors/, so all eight were invisible to it. Auditing them
    # by hand found `market_positioning` was not alone:
    #
    #   daily_prices           QA_DIRECT, correct (instrumentId FK)
    #   feed_backfill_progress QA_DIRECT, correct (per-env checkpoint)
    #   stock_flags            already synced (MONEY-1196)
    #   index_closes           QA writes it ITSELF via bhavcopy-sync, which is
    #                          NOT prod-only — verified against the LIVE
    #                          scheduler: `bhavcopy-sync-daily-qa` exists and is
    #                          ENABLED. Exempted in the test WITH that reason.
    #   derivative_eod         no QA writer — see ACCEPTED_GAP in the test
    #   derivative_summary     no QA writer — see ACCEPTED_GAP in the test
    #   institutional_deals    no QA writer  <- added below
    #   slb_positions          no QA writer  <- added below
    #
    # Both of the two below key on (symbol, date) with NO instrumentId FK, so
    # they mirror cleanly — identical reasoning to market_positioning above.
    # `deals-backfill.ts` also writes institutional_deals, but it is a MANUAL
    # one-shot with no schedule on either env, so it does not give QA a writer.
    "institutional_deals"      # InstitutionalDeal  - feed-parse Cloud Run JOB (MONEY-1100 P4.4)
    "slb_positions"            # SlbPosition        - feed-parse Cloud Run JOB (MONEY-1100 P4.6)
    # ── Debt master + debt EOD prices — MONEY-1204 P14 14b.1 ──
    # Three more `feed-parse` outputs, listed IN THE SAME COMMIT as the writer
    # rather than after it. The five instances above (shareholding_patterns,
    # index_memberships, institutional_flows, stock_flags, market_positioning)
    # were each found weeks-to-months later by someone working on something
    # else, and every one of them was cheap to add up front and invisible
    # afterwards. The guard that would have caught them —
    # packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts —
    # now covers Cloud Run jobs, and it DID catch these three: it named all
    # three collections as offenders before these lines existed.
    #
    # All three mirror cleanly: identity is ISIN (`bond_master`), (ISIN, date,
    # segment) (`bond_eod`) or (symbol, date) (`mwpl_daily`). NONE carries an
    # instrumentId, so there is no FK into QA's own ObjectIds and none of the
    # daily_prices hazard.
    #
    # Volume, stated because the archive walk is what changes it. TODAY each
    # family has ONE archived object, so all three are near-empty; the history
    # is founder-gated and not yet walked. At full backfill:
    #   bond_master  one row per ISIN, not per day — order 10^4, effectively flat.
    #   bond_eod     ~400 rows/session x ~4,800 sessions back to 2007 -> ~2M.
    #                The one to watch, on the same reasoning the stock_flags
    #                comment above gives: if it stretches the 01:00 IST window,
    #                the answer is a bounded copy for this collection, NOT
    #                dropping it back out and returning QA to zero.
    #   mwpl_daily   ~217 rows/session x 688 archived sessions -> ~150k.
    "bond_master"              # BondMaster         - feed-parse Cloud Run JOB (MONEY-1204 P14 14b.1)
    "bond_eod"                 # BondEOD            - feed-parse Cloud Run JOB (MONEY-1204 P14 14b.1)
    # ── Market-wide F&O open interest — MONEY-1204 P14 14b.2 ──
    # Same reasoning as the three lines above; separated only because it is a
    # different feed. NOTE for anyone reading the table on QA and finding two
    # empty columns: `mwpl` and `utilisationPct` are null in PROD too, by
    # design — only the numerator has a source. That is not a broken sync. See
    # the MwplDaily model comment.
    "mwpl_daily"               # MwplDaily          - feed-parse Cloud Run JOB (MONEY-1204 P14 14b.2)
    # -- Per-underlying F&O headline metrics -- MONEY-1204 P14, F2 --
    # Was an ACCEPTED_GAP, bundled with derivative_eod on the reasoning that it
    # is DERIVED from it, `so it closes with it`. That bundling was the mistake:
    # the two share a WRITER and nothing else. They have different consumers
    # and are not the same size class, and the gap only became load-bearing
    # when 14c.3 turned this table into a GATE -- the market service reads it
    # first and, on null, short-circuits BEFORE slb_positions, mwpl_daily and
    # the F&O-ban flags. So on QA the entire F&O tab rendered nothing for every
    # symbol, RELIANCE included, and /v1/stocks/:symbol/derivatives answered
    # isFno:false platform-wide -- silently, as success:true + emptyOverride.
    # It also stranded mwpl_daily, added to THIS list by THIS branch, behind an
    # unreachable gate.
    #
    # Measured on prod 2026-08-16 rather than projected:
    #   derivative_summary   432,609 rows   189.6 MB   382 symbols, 2000-06-12..2026-08-14
    #   derivative_eod     2,511,193 rows   802.7 MB
    #   stock_flags        7,537,633 rows  1691.2 MB   <- already synced
    # It is ~17x smaller than a collection already in this list, so the size
    # objection recorded against derivative_eod never applied to it.
    #
    # Mirrors cleanly on the same test the four lines above pass: identity is
    # (symbol, exchange, date) with NO instrumentId, so there is no FK into
    # QA's own ObjectIds and none of the daily_prices hazard.
    #
    # derivative_eod stays out, on its own merits (2.5M rows, and no reader).
    "derivative_summary"       # DerivativeSummary  - feed-parse Cloud Run JOB (MONEY-1204 P14 14c.3)
    # ── Mutual fund reference — AMFI base + Kuvera enrichment, kept prod-authoritative ──
    "mutual_fund_masters"      # MutualFundMaster   - mf-sync / mf-metadata-sync / etf-expense-enrichment
    "mf_nav_history"           # MfNavHistory       - MF NAV history
    # ── Fund composition (AI-extracted holdings — expensive) ──
    "fund_holdings"            # FundHolding        - fund-composition-service
    "fund_composition_meta"    # FundCompositionMeta- fund-composition-service
    # NOTE: "financial_data" (FinancialData) was removed from this list on
    # 2026-08-18 — MONEY-1205 T12. The model never had a writer OR a reader in
    # any commit and was superseded by StockFinancials/StockRatios in Mar-2026;
    # prod held 0 rows, every run here logged "prod empty -> skip". The Prisma
    # model is gone too. The empty physical collection survives `db push` in
    # both envs until it is dropped by hand.
)

# ============================================
# Collections whose `instrument` relation is REQUIRED — MONEY-1216 / 1220 / 1238
# ============================================
# The subset of REFERENCE_COLLECTIONS above that Prisma declares with a REQUIRED
# `instrument InstrumentMapping` relation (no `?`). Every one arrives from prod
# carrying PROD's `instrumentId`, and `instrument_mappings` is QA-DIRECT, so
# after each restore those ids exist only in prod.
#
# For an OPTIONAL relation a dangling id is cosmetic — readers join on symbol.
# For a REQUIRED one Prisma does not return null, it THROWS, and the throw kills
# the WHOLE query: one orphaned row blanks every result the caller asked for.
#
# This list is NOT authoritative — `schema.prisma` is. It is pinned to the schema
# by packages/core/__tests__/market-data/sync-relink-required.test.ts, which
# derives the set itself and fails if a sixth model grows a required relation
# without being added here. A note in a ticket cannot fail a build; that is how
# MONEY-1216 fixed one collection and left four (MONEY-1220).
RELINK_COLLECTIONS=(
    "stock_documents"
    "stock_financials"
    "stock_peers"
    "stock_ratios"
    "stock_shareholding"
)

# ============================================
# Collections restored UNIQUE-KEY-FIRST — MONEY-1519
# ============================================
# A reference collection that QA ALSO WRITES. `candles` is the one: the
# `tiingo-realtime-qa` service writes TIINGO_RT M1 bars for SPY/QQQ/DIA/IWM into
# QA's copy around the clock, through `putCandles`' diff-then-create.
#
# `mongorestore --drop` drops the collection and rebuilds its indexes LAST, so
# for the whole restore (~19 min of rows, then ~11 min of index build, measured
# 2026-09-22) QA's `candles` enforced NOTHING. The QA writer re-created the bar
# it was holding seconds after the drop (DIA's 21:25 bar was re-inserted at
# 21:26:27.382Z, three seconds after that leg began at 21:26:24), the dump
# then delivered PROD's copy of the same bars at its tail, and the unique build
# at the end refused the collection: "0 failures" on the data, E11000 on
# `candles_symbol_exchange_timeframe_ts_key`, and — because createIndexes is
# all-or-nothing — QA left holding 29.6M rows and ONLY `_id_`. Every night since
# 2026-09-01. On all five failures whose stderr survives (MONEY-1483), the dup
# key was DIA's M1 bar within five minutes of the minute the leg STARTED (20:00
# on a leg that began 20:00:08; 19:20 on one that began 19:20:05) — the QA
# writer's re-created bar, not anything prod holds twice: prod's own unique
# index is built, and prod counts exactly one row on each key it still holds.
#
# For these the script drops the collection ITSELF, creates it holding prod's
# unique index(es), and only then restores — WITHOUT `--drop`, which would drop
# that key again. The key is therefore enforced for the whole window, a run
# killed mid-restore leaves a partial copy that still enforces it, and a bar the
# QA writer lands first is REFUSED on arrival from the dump (mongorestore counts
# it under "failures" and carries on) instead of detonating the build 30 minutes
# later. Which copy of that bar survives does not matter: both are TIINGO_RT
# bars from the same feed, and the next night's restore replaces both.
#
# NOT every collection, deliberately: the pre-step costs two mongosh boots
# (~5 s) a collection against a budget this job already overruns, and it only
# buys anything where something in QA INSERTS while the restore runs. `candles`
# is the one measured case. A collection that grows a live QA writer belongs in
# this list.
UNIQUE_FIRST_COLLECTIONS=(
    "candles"                  # tiingo-realtime-qa writes TIINGO_RT bars into QA's copy
)

# ============================================
# The freshness record — MONEY-1488
# ============================================
# Lives in QA, because it describes what QA RECEIVED. Putting it in prod would
# make the one script whose entire safety story is "prod is read-only, qa is
# write-only" write to prod, and there is no reading of that which stays safe
# after the next edit.
#
# It has NO Prisma model, deliberately. Nothing in the product reads it; the
# only readers are `--status` and a future delta bound, both of which are
# mongosh inside an image with no Node. A model would mean a `prisma db push`
# in two environments to create a collection mongosh creates on first write,
# and it would enter `index-guard`'s audit for a uniqueness guarantee that
# `_id` already provides — the collection NAME is the `_id`, so the key is the
# document identity rather than an index over it.
#
# It is also, for the same reason `market_data_sync_logs` is, environment-
# specific operational state and must NEVER appear in REFERENCE_COLLECTIONS:
# restoring prod's copy of "what QA received" into QA would overwrite the record
# with a fiction. See the EXCLUDED block below.
SYNC_OUTCOMES_COLLECTION="qa_sync_outcomes"

# One id per run, so a row can be attributed to the run that wrote it. `date`
# is all this image has; the pid disambiguates two runs in the same second.
SYNC_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"

# ============================================
# EXCLUDED (NEVER copied) — auditable record of what the allowlist leaves out
# ============================================
# USER / ACCOUNT / BILLING / JOB-SCOPED (contain user data or env-specific state):
#   User, BrokerConnection, Holding, Position, Order, Trade, PairedTradeView,
#   MutualFund (user-held), PaperPortfolio, PaperOrder, PaperPosition,
#   AnalysisReport, FireScenario, DailyJournal, SyncLog,
#   BrokerIntegrationFailure, ConsentRecord, Subscription, Payment, Coupon,
#   CouponRedemption, InviteToken, GstInvoice, GstCreditNote,
#   GstInvoiceCounter, GstAuditLog, DodoPayoutStaging, DodoProduct,
#   ChatHistory, TokenUsage, ResearchSession, PortfolioRoast,
#   ComparisonSession, AnalysisSession, CreditReservation, CreditUsage,
#   LoginBriefing, Notification, WatchList, WatchlistItem, NewsFeed, Alert,
#   UserDocument, Feedback, FeedbackReply, ResultFeedback, CustomStrategy,
#   CustomIndicator, ScanResult, SavedScreen, ScreenerSnapshot,
#   ScreenerValidation, Enrollment, CourseLessonProgress, LessonProgress,
#   InvestorProfile, AIGenerationLog, DeletedUserAudit, StudioGeneration
#
# DELIBERATELY EXCLUDED REFERENCE-ish collections (with the reason):
#   - document_embeddings (DocumentEmbedding): MIXED collection — scraped
#     stock-doc vectors are stored under SYSTEM_USER_ID, but real per-user
#     holdings/trades/fire_scenario/user_preferences embeddings share the SAME
#     collection. Copying it would drag user PII into QA. QA re-embeds locally
#     from the copied stock_documents instead. EXCLUDE.
#   - glossary_terms (GlossaryTerm): no scraper/seeder populates this model
#     (seed-glossary.ts writes into the Post/Tag CMS collections, not this
#     model). Not part of the scrape-once pipeline. EXCLUDE.
#   - content_posts / content_tags / content_tag_on_post (Post/Tag/TagOnPost):
#     human-authored CMS content keyed to ContentAuthor accounts, not scraped
#     reference data. EXCLUDE.
#   - market_data_sync_logs, screener_snapshots, screener_validations,
#     classification_logs, learned_patterns, content_generations: operational /
#     log / learning state that is environment-specific. EXCLUDE.
#   - qa_sync_outcomes (MONEY-1488): THIS script's own per-collection freshness
#     record, written into QA. The most environment-specific row there is — it
#     records what QA received — so copying prod's copy of it into QA would
#     replace the record with a fiction, and the fiction would read as healthy.
#     It is also what decides the ORDER this loop walks (MONEY-1487), so a
#     restored copy would rotate QA's sync against prod's history. EXCLUDE.
#   - platform_config: environment-specific configuration. EXCLUDE.
#   - MONEY-855 QA-DIRECT collections — instrument_mappings, daily_prices,
#     latest_quotes, intraday_bars, news_articles, stock_profiles:
#     (upcoming_events was in this list and is NOT any more — MONEY-1098 P5.3
#     moved events-sync onto NSE's cookie-gated APIs and made it PROD_ONLY, so
#     its cron no longer "runs on both envs" and it is now SYNCED above.)
#     sourced from CHEAP/PUBLIC/TOLERANT feeds (Zerodha instrument dump, BSE/NSE
#     bhavcopy files, Yahoo, public RSS) that QA fetches ITSELF (those crons run
#     on BOTH envs). NOT synced: there's no rate-limit reason to centralize them.
#     EXCLUDE — and MONEY-1085 makes this permanent rather than incidental:
#       daily_prices, latest_quotes, intraday_bars and stock_profiles all key on
#       `instrumentId`, a foreign ObjectId into instrument_mappings. QA mints its
#       own _ids, so copying prices WITHOUT instrument_mappings points them at
#       the wrong instruments, and copying the whole FK cluster would mean
#       dropping five QA collections and disabling QA's ingest crons.
#       (The older "the _ids would collide on the unique natural-key index"
#       wording was wrong about the mechanism — this script drops the collection
#       before restoring, so an _id collision was never the obstacle. The FK
#       graph is.)
#       Instead, `--tier=feeds` mirrors the ARCHIVED RAW exchange files via GCS
#       and QA replays them through its own ingest, keeping its own _ids. See
#       packages/core/src/market-data/feed-archive.ts.
#
# RULE: when unsure, EXCLUDE (safety beats completeness). A new model is
# excluded by default until it is deliberately added to REFERENCE_COLLECTIONS.

# ============================================
# Helper: mask a Mongo URI for safe logging (mirror seed-env.sh)
# ============================================
# BOTH SCHEMES, and the `+srv` is why this was broken — MONEY-1494.
#
# The old pattern was `mongodb+srv://[^@]*@` only. PROD is Atlas and carries
# `+srv`, so it masked correctly and looked right in every review. QA is
# self-hosted on a GCE address, so its URI is plain `mongodb://`, the pattern
# missed, and the password went to stdout VERBATIM — on the normal run path
# (the "Target (qa)" line), i.e. into Cloud Logging on every scheduled sync
# since MONEY-840, where logs are retained and indexed.
#
# THIS IS THE THIRD SITE OF ONE DEFECT, and the second was already fixed:
# `run-market-data-job.sh:422` diagnoses it exactly — "the first version
# matched only mongodb+srv:// ... against a QA cluster that uses plain
# mongodb://, echoed the full credentials" — and was never swept here or to
# `seed-env.sh`. This is that function, copied rather than re-derived.
#
# It FAILS CLOSED, which a widened regex does not: anything unrecognised is
# reduced to the scheme alone. A redactor that emits the raw secret when its
# pattern misses is worse than no redactor, because the output looks
# deliberate — which is precisely how this went unnoticed since MONEY-840.
# ============================================
# Helper: mask connection strings in a STREAM — MONEY-1494 (fourth site)
# ============================================
# `mask_uri` takes ONE string. This takes a stream, and it exists because the
# restore-stderr tail had a FOURTH inline copy of the redaction regex ~1,000
# lines below the three MONEY-1494 fixed — which I claimed in that commit was
# "the third site of one defect". It was the fourth.
#
# That copy was FAIL-OPEN on a password containing a slash. `[^@/]*` cannot
# cross the `/`, so the match fails and sed prints the line UNCHANGED:
#
#   in   connecting to mongodb://admin:p/w@cluster.example.net/db failed
#   out  connecting to mongodb://admin:p/w@cluster.example.net/db failed
#
# and it ran in the one branch that executes when mongodump/mongorestore FAILS
# — precisely when those tools echo the URI they were handed.
#
# `[^[:space:]]*@` is greedy to the LAST `@` in the non-whitespace run, so a
# password may contain `/` AND `@` and still be redacted. Greedy over-matching
# is the SAFE direction here: at worst it eats part of the host, where the
# alternative is printing the password.
mask_stream() {
    sed -E 's#(mongodb(\+srv)?://)[^[:space:]]*@#\1***:***@#g'
}

mask_uri() {
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

# ============================================
# Helper: why Part 1 (MongoDB) was skipped — MONEY-1157
# ============================================
# ONE definition, called from BOTH the dry-run and the real-run branch, because
# they had already drifted: the dry run was tier-aware while the real run
# hard-coded "(--gcs-only)". The `sync-prod-to-qa-feeds` Cloud Run job runs
# `--yes --tier=feeds` (scripts/ops/setup-sync-job.sh), so EVERY real log line
# for that scheduled job cited a flag it was never passed — and that log is the
# only operator-visible output a scheduled job has.
#
# $1 = optional line prefix (the real run labels its sections "Part 1: ").
mongo_skip_notice() {
    local PREFIX="${1:-}"
    if [ "$TIER" == "feeds" ]; then
        echo -e "${YELLOW}${PREFIX}MongoDB sync SKIPPED — the feeds tier never touches collections.${NC}"
        echo -e "${YELLOW}  QA replays the archived files through its OWN ingest, keeping its own instrument _ids.${NC}"
    else
        echo -e "${YELLOW}${PREFIX}MongoDB sync SKIPPED (--gcs-only).${NC}"
    fi
}

# ============================================
# Helper: fetch DATABASE_URL from GCP Secret Manager
# (mirrors seed-env.sh: status -> stderr, ONLY the URL -> stdout)
# ============================================
get_db_url() {
    local ENV=$1
    local SECRET_NAME=""

    if [ "$ENV" == "qa" ]; then
        SECRET_NAME="DATABASE_URL_QA"
    elif [ "$ENV" == "prod" ]; then
        SECRET_NAME="DATABASE_URL_PROD"
    fi

    echo -e "${BLUE}Fetching ${SECRET_NAME} from GCP Secret Manager...${NC}" >&2
    local DB_URL
    DB_URL=$(gcloud secrets versions access latest --secret="$SECRET_NAME" --project="$PROJECT_ID" 2>/dev/null)

    if [ -z "$DB_URL" ]; then
        echo -e "${RED}Failed to fetch ${SECRET_NAME} from Secret Manager.${NC}" >&2
        echo "Make sure the secret exists:" >&2
        echo "  gcloud secrets versions list ${SECRET_NAME} --project=${PROJECT_ID}" >&2
        exit 1
    fi

    echo -e "${GREEN}Got DATABASE_URL for ${ENV}${NC}" >&2
    # Only the URL goes to stdout
    echo "$DB_URL"
}

# ============================================
# Helper: the freshness record — MONEY-1488
# ============================================
# Three small mongosh programs, all `--eval` rather than `--file`. That is not
# style: the re-link below is located by the tests as "the first line of CODE
# that runs a program via --file", and a second `--file` caller would make that
# locator pick whichever happened to be written higher up the file.
#
# EVERY assignment from one of these is GUARDED. Under `set -eo pipefail` a bare
# `VAR=$(cmd)` whose command fails takes the exit status of the command, and
# `set -e` kills the script on it — so the documented fallback on the next line
# never runs. This script already carries that defect on its empty-guard count
# (fixed in the loop below), and re-introducing it here would mean a hiccup in
# the BOOKKEEPING aborting the DATA COPY, which is the wrong way round.

# Milliseconds since the epoch, portably. `date +%s%3N` is GNU-only and this
# script runs on both Debian (the image) and macOS (a laptop); seconds
# resolution is ample for a job whose unit of work is minutes.
now_ms() { echo "$(( $(date -u +%s) * 1000 ))"; }

# Stamp one collection's outcome. BEST EFFORT, always: a failure here is logged
# and swallowed, because a sync that copied 54 collections correctly must not be
# reported as failed by its own diary.
#
# ── THE REFERENCE TIER ONLY, AND THAT IS A CORRECTNESS RULE ──────────────
#
# `--tier=sample` restores a BOUNDED SLICE — the checked-in symbol manifest x N
# years. Stamping that as RESTORED would tell every reader, and specifically
# MONEY-1486's future delta bound, that QA holds prod's copy of the collection
# when it holds 500 symbols of it. A laptop sample run would also reset the
# freshness clock the SCHEDULED job rotates on, so the collections it happened
# to touch would sink to the back of the real queue.
#
# It is cheaper too, and that matters: mongosh cold start measured 2.6 s, so the
# two writes per collection are ~4.7 min of the job's 60-minute task timeout —
# the same budget MONEY-1487 is about. That is the price of being able to say
# which collection was in flight when the job died, and it is the reason this is
# two writes and not more.
# ponytail: two spawns per collection. If the budget bites, fold the IN_FLIGHT
# write into the empty-guard's existing per-collection mongosh call (a second
# `connect()` to QA inside that program) — halves it to one, at the cost of a
# dual-connection program.
#
# $1 collection  $2 state  $3 prod row count (or "")  $4 started-at ms (or "")
outcome_write() {
    [ "$DO_MONGO" == "true" ] || return 0
    [ "$TIER" == "reference" ] || return 0
    [ -n "${QA_URL:-}" ] || return 0
    SO_ID="$1" SO_STATE="$2" SO_ROWS="${3:-}" SO_STARTED_MS="${4:-}" \
    SO_RUN_ID="$SYNC_RUN_ID" SO_TIER="$TIER" SO_COLL="$SYNC_OUTCOMES_COLLECTION" \
        mongosh "$QA_URL" --quiet --eval '
const s = process.env.SO_STATE;
const now = new Date();
const started = Number(process.env.SO_STARTED_MS);
// The RAW string first, because Number("") is 0 and this field is passed EMPTY
// on COUNT_FAILED — the one state that means we never learned the count. A
// coerced 0 there would record "prod holds no rows", which is a claim about
// prod made by the branch that could not ask it.
const rowsRaw = process.env.SO_ROWS || "";
const rows = rowsRaw === "" ? NaN : Number(rowsRaw);
const set = {
  lastState: s,
  // Stamped on EVERY visit, including IN_FLIGHT and the skips. MONEY-1255:
  // stamping only what was WRITTEN leaves a collection that legitimately had
  // nothing to copy holding a stale marker for ever — and this field is what
  // orders the next run, so a collection that never stamps never rotates.
  lastAttemptAt: now,
  lastRunId: process.env.SO_RUN_ID,
  tier: process.env.SO_TIER,
  startedAt: Number.isFinite(started) && started > 0 ? new Date(started) : now,
  // NULL while in flight, and that is the whole mechanism: a process killed at
  // the task timeout cannot write "I was killed", so the intent is written
  // first and the ABSENCE of an end stamp is what says the run died here.
  endedAt: s === "IN_FLIGHT" ? null : now,
  prodRows: Number.isFinite(rows) && rows >= 0 ? rows : null,
};
// Only a CLEAN completion moves the success marker. This is the field
// MONEY-1486 has to read before it may trust a delta bound: `mongorestore`
// inserts in arbitrary order, so a killed restore leaves a SCATTERED subset
// and QA`s live max() advances past rows that never landed, permanently.
if (s === "RESTORED") { set.lastSuccessAt = now; }
db.getCollection(process.env.SO_COLL).updateOne(
  { _id: process.env.SO_ID }, { $set: set }, { upsert: true },
);
' >/dev/null 2>&1 || {
        echo -e "   ${YELLOW}(freshness record not written for ${1} — the copy itself is unaffected)${NC}"
        return 0
    }
}

# Emit the collection names in the order the loop should walk them, ONE LINE,
# space separated. Empty output (or any output that is not a permutation of the
# manifest) means the caller falls back to manifest order — LOUDLY.
#
# The RULE is: least-recently-VISITED first, ties by manifest position. mongosh
# emits only FACTS (`<lastAttemptMs> <manifestIndex> <name>`); the ordering is
# done by `sort`, so the rule is a sort key rather than a program. Its
# executable form is `planSyncOrder` in packages/core/src/ops/qa-sync-outcomes.ts,
# and sync-prod-to-qa-exit-code.spawntest.ts drives THIS script against canned
# facts and asserts the two agree.
resolve_sync_order() {
    local FACTS ORDERED
    FACTS=$(SO_NAMES="${REFERENCE_COLLECTIONS[*]}" SO_COLL="$SYNC_OUTCOMES_COLLECTION" \
        mongosh "$1" --quiet --eval '
const names = (process.env.SO_NAMES || "").split(/\s+/).filter(Boolean);
const seen = {};
db.getCollection(process.env.SO_COLL)
  .find({}, { _id: 1, lastAttemptAt: 1 })
  .forEach((d) => {
    seen[d._id] = d.lastAttemptAt instanceof Date ? d.lastAttemptAt.getTime() : 0;
  });
// A collection with no record at all sorts at 0, i.e. FIRST. That is the
// correct polarity: never-synced is the most urgent thing in the list, and it
// is exactly the state the 34 starved collections were in.
names.forEach((n, i) => print((seen[n] || 0) + " " + i + " " + n));
' 2>/dev/null) || return 1
    # Guarded for the reason given at the top of this block: this assignment
    # reads a PIPELINE, and an unguarded one aborts the whole script.
    ORDERED=$(printf '%s\n' "$FACTS" \
        | awk 'NF == 3 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ { print }' \
        | sort -k1,1n -k2,2n \
        | awk '{ print $3 }' \
        | tr '\n' ' ') || return 1
    echo "$ORDERED"
}

# `--status`: the report. Reads QA, prints, exits. The verdict vocabulary here
# is the one `classifySyncFreshness` produces, and the spawntest compares them.
print_sync_status() {
    SO_NAMES="${REFERENCE_COLLECTIONS[*]}" SO_COLL="$SYNC_OUTCOMES_COLLECTION" \
    SO_STALE_DAYS="$STALE_AFTER_DAYS" \
        mongosh "$1" --quiet --eval '
const names = (process.env.SO_NAMES || "").split(/\s+/).filter(Boolean);
const staleMs = Number(process.env.SO_STALE_DAYS) * 86400000;
const now = Date.now();
const rec = {};
db.getCollection(process.env.SO_COLL).find({}).forEach((d) => { rec[d._id] = d; });
// FAILED and IN_FLIGHT mean `mongorestore --drop` may have dropped QA`s copy
// and then not finished replacing it; INDEX_BUILD_FAILED (MONEY-1519) means the
// rows landed without the unique key. The SAME set as PARTIALLY_APPLIED_STATES
// in packages/core/src/ops/qa-sync-outcomes.ts — qa-sync-outcomes.test.ts reads
// this line and fails if the two differ.
const PARTIAL = ["FAILED", "INDEX_BUILD_FAILED", "IN_FLIGHT"];
let stale = 0, never = 0, partial = 0, unindexed = 0;
print("COLLECTION                   FRESHNESS  STATE                AGE      LAST SUCCESS");
for (const n of names) {
  const d = rec[n];
  let freshness = "NEVER", age = "-", state = "-", success = "-";
  if (d && d.lastAttemptAt instanceof Date) {
    const ageMs = now - d.lastAttemptAt.getTime();
    freshness = ageMs > staleMs ? "STALE" : "FRESH";
    age = (ageMs / 86400000).toFixed(1) + "d";
    state = d.lastState || "-";
    success = d.lastSuccessAt instanceof Date
      ? d.lastSuccessAt.toISOString().slice(0, 19) + "Z" : "-";
  }
  if (freshness === "NEVER") never++;
  else if (freshness === "STALE") stale++;
  let flag = "";
  if (d && PARTIAL.indexOf(d.lastState) >= 0) { flag = "  <- PARTIALLY APPLIED"; partial++; }
  // MONEY-1519: the rows are whole, the uniqueness contract is not.
  if (d && d.lastState === "INDEX_BUILD_FAILED") { flag = "  <- INDEX BUILD FAILED"; unindexed++; }
  print(
    n.padEnd(29) + freshness.padEnd(11) + state.padEnd(21) +
      age.padEnd(9) + success + flag,
  );
}
print("");
print(
  "SUMMARY " + names.length + " collections: " + never + " never synced, " +
    stale + " stale (> " + process.env.SO_STALE_DAYS + "d), " + partial +
    " partially applied, " + unindexed + " index build failed",
);
if (partial > 0) {
  print("  PARTIALLY APPLIED means `mongorestore --drop` dropped QA`s copy and");
  print("  did not finish replacing it. Those rows are a scattered subset, so a");
  print("  delta bound read from QA`s own max() would skip everything below it.");
}
if (unindexed > 0) {
  print("  INDEX BUILD FAILED means an index could not be built, so the collection");
  print("  may not be enforcing its unique key (MONEY-1519). Writers that assume");
  print("  it, like putCandles, may be taking duplicates until a run reads RESTORED.");
}
'
}

# ============================================
# Helper: re-link REQUIRED `instrument` relations in QA — MONEY-1238
# ============================================
# ── WHY THIS IS mongosh AND NOT `npx tsx repair-instrument-links.ts` ──
#
# It WAS that tsx call, and it could not run once. The Cloud Run image
# (scripts/ops/sync-job/Dockerfile) COPYs exactly ONE file — this script — onto a
# `google/cloud-sdk:slim` base that carries gcloud and the mongo CLIs and NO Node
# at all. `repair-instrument-links.ts` was never in the image. So every scheduled
# run printed "RE-LINK FAILED", printed "Complete!" two lines later, and exited
# 0, which is the status Cloud Run reports.
#
# Making tsx work would mean adding Node + the monorepo node_modules (1.8 GB
# measured) + a generated Prisma client + its platform-matched query engine to an
# image that today is a `wget` and a `tar`. Pre-bundling with esbuild does not
# avoid it either: `@prisma/client` is `external` in every bundler config here
# (workers/tsup.config.ts states why — dynamic require plus native binaries), so
# a bundle still needs the client and the engine at runtime. mongosh is already
# installed, version-pinned, SHA256-verified, and already used for the
# empty-guard count above — and this repair is pure MongoDB.
#
# Keeping the implementation INSIDE this file rather than in a sibling .js is
# deliberate, and it is the actual fix for the defect rather than a workaround:
# the re-link broke because it lived in a file the image did not carry. A script
# that carries its own repair cannot be half-shipped. `repair-instrument-links.ts`
# stays as the BY-HAND remedy for a laptop (where Node exists); the test pins
# both to the same schema-derived list so they cannot drift apart.
#
# Exit codes — the caller branches on all four and they are NOT interchangeable:
#   0  every required relation resolves and every collection holding rows has
#      at least one secondary index
#   2  the repair ran cleanly but rows REMAIN dangling (QA still throws)
#   3  the repair is clean, but a collection holding rows has ONLY `_id_` — a
#      restore was killed before `mongorestore` rebuilt its indexes, so it is
#      accepting duplicates right now (MONEY-1487)
#   1  the repair itself failed (connection, exception, a write that did not land)
relink_required() {
    local QA_TARGET="$1"
    local JS RC

    JS="$(mktemp)"
    cat > "$JS" <<'RELINK_JS'
// Re-link REQUIRED `instrument` relations after a prod -> QA restore.
// Runs under mongosh (the image already ships it). See relink_required() in
// sync-prod-to-qa.sh for why this is not the tsx script.
const TABLES = (process.env.RELINK_TABLES || "").split(/\s+/).filter(Boolean);
if (TABLES.length === 0) {
  print("RELINK ERROR: RELINK_TABLES is empty — nothing was passed in.");
  print("  Refusing to report success over a repair that did not happen.");
  quit(1);
}

// Page size for the forward scan. Bounded memory (the Cloud Run job has 1Gi),
// and paging on _id is immune to the halloween problem: this repair rewrites
// `instrumentId` and never `_id`, so the pagination key cannot move under us and
// every row is visited exactly once.
const PAGE = 5000;

// QA's instrument universe, loaded ONCE. `alive` answers "does this id still
// exist here"; `byKey` answers "which id should (symbol, exchange) point at".
const alive = new Set();
const byKey = new Map();
db.getCollection("instrument_mappings")
  .find({}, { _id: 1, symbol: 1, exchange: 1 })
  .forEach((m) => {
    alive.add(m._id.toString());
    byKey.set(m.symbol + "\u0000" + m.exchange, m._id);
  });

if (alive.size === 0) {
  // Fail CLOSED. An empty instrument table would make every single row look
  // orphaned-and-unrepairable, which is indistinguishable from "nothing to do"
  // if it is not called out.
  print("RELINK ERROR: instrument_mappings is EMPTY in the target database.");
  print("  Every required relation would dangle; not treating that as success.");
  quit(1);
}
print("  instrument universe: " + alive.size + " mappings");

let exitCode = 0;
let grandUnmatched = 0;

for (const table of TABLES) {
  const coll = db.getCollection(table);
  let total = 0;
  let orphans = 0;
  let fixed = 0;
  let unmatched = 0;
  let lastId = null;

  for (;;) {
    const filter = lastId === null ? {} : { _id: { $gt: lastId } };
    const page = coll
      .find(filter, { _id: 1, symbol: 1, exchange: 1, instrumentId: 1 })
      .sort({ _id: 1 })
      .limit(PAGE)
      .toArray();
    if (page.length === 0) break;
    lastId = page[page.length - 1]._id;
    total += page.length;

    const ops = [];
    for (const r of page) {
      if (r.instrumentId && alive.has(r.instrumentId.toString())) continue;
      orphans++;
      const target = byKey.get(r.symbol + "\u0000" + r.exchange);
      if (!target) {
        // Counted, never guessed at: pointing an orphan at a NEAR match would
        // silently attribute one company's financials to another.
        unmatched++;
        continue;
      }
      ops.push({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { instrumentId: target } },
        },
      });
    }

    if (ops.length > 0) {
      const res = coll.bulkWrite(ops, { ordered: false });
      const wrote = res.modifiedCount || 0;
      if (wrote !== ops.length) {
        // Every queued row is an orphan being pointed at a DIFFERENT, live id,
        // so each write must modify exactly one document. A shortfall means a
        // write did not land, and reporting the intent instead of the result is
        // how a repair claims to have happened.
        print(
          "  RELINK ERROR: " + table + " — issued " + ops.length +
            " update(s), " + wrote + " landed.",
        );
        exitCode = 1;
      }
      fixed += wrote;
    }
  }

  print(
    "  " + table.padEnd(22) + " total=" + total + " orphaned=" + orphans +
      " re-linked=" + fixed + " unmatched=" + unmatched,
  );
  grandUnmatched += unmatched;
}

if (grandUnmatched > 0) {
  print("");
  print(
    "RELINK INCOMPLETE: " + grandUnmatched +
      " row(s) still point at an instrument this database does not have.",
  );
  print("  Prisma THROWS on a dangling REQUIRED relation, so those collections");
  print("  still blank every query that selects it. Either this environment is");
  print("  missing instruments (run its instrument sync) or the rows are for");
  print("  symbols it never had, in which case they are unusable here.");
  if (exitCode === 0) exitCode = 2;
}

// ── THE INDEX CHECK — MONEY-1487 ───────────────────────────────────────────
//
// `mongorestore --drop` drops a collection AND its indexes and rebuilds them
// LAST, so for the duration of a restore the collection enforces nothing and a
// run killed at the 3600s task timeout leaves it holding rows with no unique
// index. Observed live 2026-09-19 by scripts/ops/verify-db-indexes.ts, two
// collections on two polls of ONE run:
//
//   [MISSING] StockDocument       -> stock_documents        (mid [1/54])
//   [MISSING] ShareholdingPattern -> shareholding_patterns  (mid [4/54])
//
// It rides THIS program rather than spawning its own: the image has no Node, a
// mongosh boot costs real seconds against a budget this job is already
// exceeding, and the connection is open right here. listIndexes is a metadata
// command, so 54 of them are milliseconds.
//
// THE TEST IS DELIBERATELY THE WEAKEST ONE THAT CANNOT BE WRONG: a collection
// that HAS ROWS and has ONLY `_id_`. Checking against the real schema would
// need Prisma's DMMF, which is the exact dependency this image was designed not
// to carry (MONEY-1238) — and a check that needs a dependency the runtime lacks
// is a check that silently does not run. Every one of these 54 declares a
// natural key, so "rows but no secondary index" is unambiguous damage. A
// collection with no rows is skipped: QA legitimately has never received some
// of them, and an absence is not a broken index.
//
// ALL of them are checked, not just this run's restores, for the same reason
// the re-link above covers all of RELINK_COLLECTIONS: the damage is done by the
// run that was KILLED, which by definition never reached this code, so the only
// run that can report it is a LATER one that may not have touched the
// collection at all.
const INDEX_TABLES = (process.env.SYNC_INDEX_TABLES || "")
  .split(/\s+/)
  .filter(Boolean);
const unindexed = [];
for (const table of INDEX_TABLES) {
  let idx;
  try {
    idx = db.getCollection(table).getIndexes();
  } catch (e) {
    // A collection this database has never held. Not damage — QA simply has
    // not received it yet, which `--status` reports as NEVER.
    continue;
  }
  if (!Array.isArray(idx) || idx.length === 0) continue;
  const secondary = idx.filter((i) => i.name !== "_id_");
  if (secondary.length > 0) continue;
  if (db.getCollection(table).estimatedDocumentCount() === 0) continue;
  unindexed.push(table);
}
if (unindexed.length > 0) {
  print("");
  print(
    "INDEXES MISSING on " + unindexed.length +
      " collection(s) holding rows: " + unindexed.join(", "),
  );
  print("  `mongorestore --drop` rebuilds indexes LAST, so a run killed at the");
  print("  task timeout leaves rows with no unique index — the collection is");
  print("  accepting duplicates right now. Re-run the sync for those");
  print("  collections, or `prisma db push` against this database.");
  // Ranked BELOW the two re-link verdicts because only one exit code fits and
  // a dangling REQUIRED relation makes Prisma THROW, which is louder than a
  // missing index. Both facts are PRINTED unconditionally, so nothing is lost
  // when they coincide; only the machine-readable code has to choose.
  if (exitCode === 0) exitCode = 3;
}

quit(exitCode);
RELINK_JS

    RC=0
    RELINK_TABLES="${RELINK_COLLECTIONS[*]}" \
    SYNC_INDEX_TABLES="${REFERENCE_COLLECTIONS[*]}" \
        mongosh "$QA_TARGET" --quiet --file "$JS" || RC=$?
    rm -f "$JS"
    return "$RC"
}

# ============================================
# Helper: the unique key goes in BEFORE the rows — MONEY-1519
# ============================================
# See UNIQUE_FIRST_COLLECTIONS for why. Two mongosh calls rather than one
# program holding both connections, so the "prod is read, QA is written" split
# stays true per process: the PROD call is a single listIndexes.
#
# The key is copied from PROD, not written down here: prod's metadata is what
# `mongorestore` restores anyway, and a spec kept in this file would be a second
# copy of schema.prisma's `@@unique` free to drift from it.
#
# Exit 0: QA's copy of $1 has been dropped and already enforces every unique
# index prod declares for it — the rows can now arrive. Non-zero: nothing is
# restored and the caller records INDEX_BUILD_FAILED. Exit 2 means QA is
# untouched (prod could not be read, or declares no unique key: a restore that
# cannot enforce the key is exactly the state this exists to prevent); anything
# else means the drop may have happened without the key landing, so QA's copy
# may be EMPTY — loud, and still better than full and unenforced.
is_unique_first() { case " ${UNIQUE_FIRST_COLLECTIONS[*]} " in *" $1 "*) return 0 ;; esac; return 1; }

prepare_unique_first() {
    local SPECS
    # Guarded: a bare assignment from a failing mongosh aborts the whole run
    # under `set -eo pipefail`.
    if ! SPECS=$(UF_COLL="$1" mongosh "$PROD_URL" --quiet --eval '
print(EJSON.stringify(db.getCollection(process.env.UF_COLL).getIndexes()
  .filter((i) => i.unique === true && i.name !== "_id_")));
' 2>/dev/null); then
        echo -e "   ${RED}could not read ${1}'s indexes from prod — not restoring; QA untouched${NC}"
        return 2
    fi
    UF_COLL="$1" UF_SPECS="$SPECS" mongosh "$QA_URL" --quiet --eval '
const name = process.env.UF_COLL;
let specs = null;
try { specs = EJSON.parse(process.env.UF_SPECS || "null"); } catch (e) { specs = null; }
if (!Array.isArray(specs) || specs.length === 0) {
  print("   prod declares NO unique index on " + name + " — not restoring; QA untouched");
  quit(2);
}
db.getCollection(name).drop();
// No createCollection: createIndexes creates it, and a QA write landing between
// the drop and a createCollection would make that call throw NamespaceExists.
db.runCommand({ createIndexes: name, indexes: specs });
// The GATE is this read-back, not the command status above.
const have = db.getCollection(name).getIndexes()
  .filter((i) => i.unique === true).map((i) => i.name);
const missing = specs.map((s) => s.name).filter((n) => have.indexOf(n) < 0);
if (missing.length > 0) {
  print("   unique key NOT in place on " + name + ": " + missing.join(", ") +
    " — not restoring; QA`s copy is EMPTY");
  quit(1);
}
print("   unique key in place before the first row: " + have.join(", "));
'
}

# ============================================
# Preflight: required tools
# ============================================
preflight() {
    local missing=()

    if [ "$DO_MONGO" == "true" ]; then
        command -v mongodump >/dev/null 2>&1 || missing+=("mongodump")
        command -v mongorestore >/dev/null 2>&1 || missing+=("mongorestore")
        # mongosh has TWO consumers, and the second one is the reason this check
        # must fail LOUDLY here rather than at the last step: the empty-guard
        # count, and `relink_required` — the MANDATORY post-restore repair.
        # MONEY-1238: the re-link used to run on `npx tsx`, which preflight never
        # checked and the image never had, so a missing runtime surfaced as one
        # yellow line after every collection had already been dropped and
        # replaced. A missing runtime must stop the run BEFORE it mutates QA.
        command -v mongosh >/dev/null 2>&1 || missing+=("mongosh")
    fi
    command -v gcloud >/dev/null 2>&1 || missing+=("gcloud")

    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}Missing required tool(s): ${missing[*]}${NC}"
        echo ""
        for t in "${missing[@]}"; do
            case "$t" in
                mongodump|mongorestore)
                    echo "  ${t}: install the MongoDB Database Tools"
                    echo "    brew install mongodb-database-tools"
                    ;;
                mongosh)
                    echo "  mongosh: install the MongoDB Shell (empty-guard count + the post-restore re-link)"
                    echo "    brew install mongosh"
                    ;;
                gcloud)
                    echo "  gcloud: install the Google Cloud CLI"
                    echo "    https://cloud.google.com/sdk/docs/install"
                    ;;
            esac
        done
        exit 1
    fi
}

# ============================================
# Banner
# ============================================
MODE_DESC="MongoDB reference collections + GCS stocks/"
if [ "$TIER" == "feeds" ]; then
    # Named from the label variables, not re-typed: this line is the only
    # thing a Cloud Run log shows before the work starts, and "feeds/ only"
    # stayed true-looking for exactly as long as it took to add a second pair.
    MODE_DESC="tier=feeds — archived raw exchange files + candle cold shards + chart tiles (GCS ${GCS_PREFIX_LABEL} + ${CANDLES_GCS_PREFIX_LABEL} + ${TILES_GCS_PREFIX_LABEL}, no Mongo)"
elif [ "$DO_MONGO" == "true" ] && [ "$DO_GCS" == "false" ]; then
    MODE_DESC="MongoDB reference collections only"
elif [ "$DO_MONGO" == "false" ] && [ "$DO_GCS" == "true" ]; then
    MODE_DESC="GCS stocks/ only"
fi
if [ "$DRY_RUN" == "true" ]; then
    MODE_DESC="${MODE_DESC} (DRY RUN)"
fi

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  UseMoney Reference-Data Sync:  PROD ──> QA            ║"
echo "╠════════════════════════════════════════════════════════╣"
echo "║  Direction: PROD (read)  ──>  QA (overwrite)  [LOCKED]"
echo "║  Project:   ${PROJECT_ID}"
echo "║  Mode:      ${MODE_DESC}"
echo "╚════════════════════════════════════════════════════════╝"
echo ""

preflight

# ============================================
# --status: the freshness report, then exit — MONEY-1488
# ============================================
# Placed BEFORE the confirmation and before anything that opens prod: it reads
# QA and only QA. The whole point of the record is that "is QA's stock_ratios
# current?" should be answerable in one command instead of by diffing row counts
# against prod by hand.
if [ "$DO_STATUS" == "true" ]; then
    echo -e "${CYAN}QA reference-data freshness (stale after ${STALE_AFTER_DAYS}d)${NC}"
    echo ""
    STATUS_QA_URL="$(get_db_url qa)"
    echo -e "  Target (qa): $(mask_uri "$STATUS_QA_URL")"
    echo ""
    # Guarded: an unguarded assignment or call whose mongosh fails would abort
    # under `set -e` with no explanation at all, which is the failure shape this
    # whole ticket is about.
    if ! print_sync_status "$STATUS_QA_URL"; then
        echo -e "${RED}Could not read ${SYNC_OUTCOMES_COLLECTION} from QA.${NC}"
        echo -e "${RED}  That is DISTINCT from 'nothing has ever synced' — it is 'we could not ask'.${NC}"
        exit 1
    fi
    exit 0
fi

# ============================================
# Dry-run: print the resolved plan + commands, then exit (no prompt, no exec)
# ============================================
# ── --tier=sample: build the per-collection query plan ──────────────────────
#
# ONE function, called by BOTH the dry run and the real run. Deliberately not
# two descriptions of the same thing: the dry run's whole job is to tell the
# operator what the real run will do, and a dry run that reasons independently
# is a second copy of the rule that can disagree with the first. It did, in the
# first cut of this change — `--tier=sample --dry-run` printed the FULL
# per-collection dumps because the dry-run path had never heard of the sample
# tier, which is worse than no dry run at all.
SAMPLE_PLAN_FILE=""
build_sample_plan() {
    [ "$TIER" == "sample" ] || return 0
    # `.XXXXXX` is REQUIRED, not decoration: BSD mktemp (macOS) appends a suffix
    # to a bare template, GNU coreutils (Debian — which is what
    # `google/cloud-sdk:slim` runs, and that image COPYs this script) rejects
    # it. The repo's own sibling uses the portable form.
    SAMPLE_PLAN_FILE="$(mktemp -t qa-sample-plan.XXXXXX)"
    # Cleanup on EXIT; a SEPARATE handler for the signals.
    #
    # `trap '...' EXIT INT TERM` whose body neither exits nor re-raises HANDLES
    # the signal, so Ctrl-C did not stop the run: it deleted the plan file and
    # let the loop continue, the next `awk` then died under `set -e` reading a
    # file that no longer existed, the MANDATORY post-restore re-link never ran
    # (leaving collections holding prod's ObjectIds — which this script's own
    # header calls strictly worse than not running at all), and it exited 2,
    # outside the documented {0,1} contract the Cloud Run job reads.
    trap 'rm -f "$SAMPLE_PLAN_FILE"' EXIT
    trap 'rm -f "$SAMPLE_PLAN_FILE"; echo; echo "Interrupted — QA may be partially restored; re-run to finish."; exit 130' INT TERM
    echo -e "${BLUE}Building the sample plan (universe=${SAMPLE_UNIVERSE}, years=${SAMPLE_YEARS})…${NC}"
    if ! npx tsx "$(dirname "$0")/qa-sample-plan.ts" --emit --years="$SAMPLE_YEARS" --universe="$SAMPLE_UNIVERSE" > "$SAMPLE_PLAN_FILE"; then
        echo -e "${RED}Sample plan generation FAILED — refusing to run.${NC}"
        echo -e "${RED}  Nothing has been dropped; QA is untouched.${NC}"
        exit 1
    fi
    echo -e "  ${GREEN}plan ready${NC}: $(wc -l < "$SAMPLE_PLAN_FILE" | tr -d ' ') collections"
    echo ""
}

if [ "$DRY_RUN" == "true" ]; then
    echo -e "${CYAN}DRY RUN — no commands will be executed.${NC}"
    echo ""

    if [ "$DO_MONGO" == "true" ]; then
        build_sample_plan
        echo -e "${BLUE}MongoDB collections (${#REFERENCE_COLLECTIONS[@]}) to copy prod -> qa:${NC}"
        # MANIFEST order here, which is NOT the order the real run walks: that
        # is derived from QA's freshness record (least-recently-visited first,
        # MONEY-1487) and would need a live QA connection to print. Said out
        # loud rather than left implied — a dry run that shows a sequence the
        # real run does not use is the MONEY-1157 stale-copy class, and this
        # file has already paid for that twice.
        echo "    (manifest order; the real run re-orders by freshness — see --status)"
        for C in "${REFERENCE_COLLECTIONS[@]}"; do
            echo "    - ${C}"
        done
        echo ""
        echo -e "${BLUE}Per-collection command (drop + empty-guard; URIs masked):${NC}"
        for C in "${REFERENCE_COLLECTIONS[@]}"; do
            DRY_Q=""
            if [ "$TIER" == "sample" ]; then
                DRY_Q=$(awk -F"\t" -v c="$C" '$1 == c { print $2; exit }' "$SAMPLE_PLAN_FILE")
                if [ -z "$DRY_Q" ]; then
                    echo "    # ${C}: NOT IN THE SAMPLE PLAN — the real run would skip it and mark it failed"
                    continue
                fi
            fi
            echo "    cnt=\$(mongosh \"<PROD_URL>\" --quiet --eval 'db.getCollection(\"${C}\").estimatedDocumentCount()')"
            # The same fork the real run takes (MONEY-1519), so the dry run
            # never shows a `--drop` the real run does not issue.
            DRY_DROP="--drop "
            DRY_GUARD="cnt"
            [ -n "$DRY_Q" ] && DRY_GUARD="scnt"
            if [ -n "$DRY_Q" ]; then
                echo "    scnt=\$(mongosh \"<PROD_URL>\" --quiet --eval 'db.getCollection(\"${C}\").countDocuments(EJSON.parse(${DRY_Q}))')"
            fi
            if is_unique_first "$C"; then
                DRY_DROP=""
                echo "    # ${C}: UNIQUE KEY FIRST (MONEY-1519) — drop + create with prod's unique index(es), THEN the rows"
                echo "    [ \"\$${DRY_GUARD}\" -gt 0 ] && mongosh \"<QA_URL>\" --eval '<drop ${C}; createIndexes(prod unique specs); verify>'"
            fi
            if [ -n "$DRY_Q" ]; then
                echo "    [ \"\$scnt\" -gt 0 ] && mongodump --uri=\"<PROD_URL>\" --collection=\"${C}\" --archive \\"
                echo "        --query='${DRY_Q}' \\"
                echo "      | mongorestore --uri=\"<QA_URL>\" ${DRY_DROP}--archive    # else skip (0 sampled — QA untouched)"
            else
                echo "    [ \"\$cnt\" -gt 0 ] && mongodump --uri=\"<PROD_URL>\" --collection=\"${C}\" --archive \\"
                echo "      | mongorestore --uri=\"<QA_URL>\" ${DRY_DROP}--archive    # else skip (empty-guard)"
            fi
        done
        echo ""
    else
        mongo_skip_notice
        echo ""
    fi

    if [ "$DO_GCS" == "true" ]; then
        echo -e "${BLUE}GCS rsync (recursive, diffs only):${NC}"
        # PRINTS THE SAME ARGV THE REAL RUN USES. The exclusion is expanded from
        # the same array, not re-typed: a dry-run that shows a command the real
        # run does not issue is the MONEY-1157 stale-copy class, and this file
        # has already paid for it once (the GCS_PREFIX_LABEL comment in Part 2).
        echo "    gcloud storage rsync -r ${GCS_RSYNC_EXCLUDE[*]} ${GCS_SRC} ${GCS_DST}"
        if [ -n "$GCS_EXCLUDE_REGEX" ]; then
            echo "    (excluded: ${GCS_PREFIX_LABEL}TIINGO/ws/ — raw ticks, MONEY-1309)"
        fi
        # The second pair, same rule: print the argv the real run issues.
        if [ -n "$CANDLES_GCS_SRC" ]; then
            echo "    gcloud storage rsync -r ${CANDLES_GCS_SRC} ${CANDLES_GCS_DST}"
            echo "    (no --exclude: ${CANDLES_GCS_PREFIX_LABEL} cold shards mirror whole — MONEY-1373)"
        fi
        # The third pair LAST, because that is the order the real run issues
        # them in. A dry run that prints the commands in a different sequence
        # than it executes is the MONEY-1157 stale-copy class this file has
        # already paid for once.
        if [ -n "$TILES_GCS_SRC" ]; then
            echo "    gcloud storage rsync -r ${TILES_GCS_SRC} ${TILES_GCS_DST}"
            echo "    (no --exclude: ${TILES_GCS_PREFIX_LABEL} are DERIVED output — MONEY-1478)"
        fi
        echo ""
    else
        if [ "$TIER" == "sample" ]; then
            echo -e "${YELLOW}GCS sync SKIPPED (--tier=sample is Mongo-only; use --tier=reference --gcs-only for the PDFs).${NC}"
        else
            if [ "$TIER" == "sample" ]; then
            # Name the REAL reason. This line used to cite --collections-only
            # under --tier=sample, which is the MONEY-1157 stale-copy class
            # rebuilt in the GCS half: the dry-run branch said the right thing
            # while the real run — the only one a scheduled job's log shows —
            # said the wrong one.
            echo -e "${YELLOW}GCS sync SKIPPED (--tier=sample is Mongo-only; use --tier=reference --gcs-only for the PDFs).${NC}"
        else
            echo -e "${YELLOW}GCS sync SKIPPED (--collections-only).${NC}"
        fi
        fi
        echo ""
    fi

    echo -e "${CYAN}DRY RUN complete.${NC}"
    exit 0
fi

# ============================================
# Confirmation (mutates QA) — skippable with --yes
# ============================================
if [ "$ASSUME_YES" != "true" ]; then
    if [ "$TIER" == "feeds" ]; then
        echo -e "${YELLOW}This mirrors PROD's ARCHIVED RAW EXCHANGE FILES into QA (GCS rsync, adds/updates only).${NC}"
        echo -e "${YELLOW}  - NO MongoDB collection is read or dropped by this tier.${NC}"
        echo -e "${YELLOW}  - QA replays the files through its own ingest, so QA keeps its own instrument _ids.${NC}"
    else
        if [ "$TIER" == "sample" ]; then
            # The sample tier's operative guard is NOT the empty-guard, and
            # saying so mattered: prod being full while the SAMPLE matches
            # nothing is the case that can wipe a QA table, and it is exactly
            # the one the whole-collection wording tells the operator cannot
            # happen.
            echo -e "${YELLOW}This REPLACES QA's copy of ${#REFERENCE_COLLECTIONS[@]} collections with a BOUNDED SLICE of PROD's (drop + restore, per collection).${NC}"
            echo -e "${YELLOW}  - Slice = the checked-in symbol manifest x ${SAMPLE_YEARS} year(s) of history (universe cap: ${SAMPLE_UNIVERSE}).${NC}"
            echo -e "${YELLOW}  - The guard is the SAMPLED count, not the collection count: a slice matching 0 rows is SKIPPED, because --drop would otherwise delete QA's table and restore nothing.${NC}"
            echo -e "${YELLOW}  - A collection in the allowlist but missing from the plan is REFUSED, never copied whole.${NC}"
        else
            echo -e "${YELLOW}This REPLACES QA's copy of ${#REFERENCE_COLLECTIONS[@]} rate-limited-source collections with PROD's (drop + restore, per collection).${NC}"
            echo -e "${YELLOW}  - A collection that is EMPTY in prod is SKIPPED — it can never wipe QA (the empty-guard).${NC}"
        fi
        echo -e "${YELLOW}  - Only rate-limited data is synced; QA fetches instruments / prices / MF-base / Yahoo / RSS itself.${NC}"
    fi
    [ "$DO_GCS" == "true" ] && echo -e "${YELLOW}  - ${GCS_DST} synced from ${GCS_SRC} (rsync adds/updates).${NC}"
    [ -n "$CANDLES_GCS_SRC" ] && echo -e "${YELLOW}  - ${CANDLES_GCS_DST} synced from ${CANDLES_GCS_SRC} (rsync adds/updates).${NC}"
    [ -n "$TILES_GCS_SRC" ] && echo -e "${YELLOW}  - ${TILES_GCS_DST} synced from ${TILES_GCS_SRC} (rsync adds/updates).${NC}"
    echo ""
    read -p "Continue? (yes/no): " CONFIRM
    if [ "$CONFIRM" != "yes" ]; then
        echo "Aborted."
        exit 0
    fi
fi

# Pin the gcloud project (used by Secret Manager + GCS)
gcloud config set project "$PROJECT_ID" --quiet

# ── Run-level outcome, declared HERE and not inside Part 1 — MONEY-1238 ──
# The final block reads FAILED to pick the exit code, and that block is outside
# the `if [ "$DO_MONGO" == "true" ]` branch. Declaring the arrays at top level
# means the exit decision does not depend on which branch happened to run, and
# keeps working if `set -u` is ever added (this script runs `set -eo pipefail`).
#   FAILED    steps that did not do what they were asked to do -> exit 1
#   RESTORED  collections whose drop+restore SUCCEEDED this run
FAILED=()
RESTORED=()

# ============================================
# Part 1: MongoDB reference collections (prod -> qa)
# ============================================
if [ "$DO_MONGO" == "true" ]; then
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  Part 1: MongoDB reference collections (PROD -> QA)${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    PROD_URL="$(get_db_url prod)"
    QA_URL="$(get_db_url qa)"

    echo -e "  Source (prod): $(mask_uri "$PROD_URL")"
    echo -e "  Target (qa):   $(mask_uri "$QA_URL")"
    echo ""

    # Direction is structurally locked — the target is whatever DATABASE_URL_QA
    # holds and the source whatever DATABASE_URL_PROD holds, and neither is
    # reachable from an argument. The one way that lock fails is at the SECRET:
    # if both names resolve to the same cluster, every `mongorestore --drop`
    # below drops and rewrites PROD. Checked by IDENTITY rather than by looking
    # for "qa" in the string, so it cannot refuse a correctly-configured run.
    if [ "$PROD_URL" == "$QA_URL" ]; then
        echo -e "${RED}REFUSING TO RUN: DATABASE_URL_PROD and DATABASE_URL_QA resolve to the SAME database.${NC}"
        echo -e "${RED}  This script drops and restores the target; running it here would destroy prod.${NC}"
        exit 1
    fi

    # ── --tier=sample: build the per-collection query plan ─────────────────
    #
    # The plan lives in scripts/ops/qa-sample-plan.ts (pure + unit-tested), not
    # here, for the reason every bash-embedded rule in this repo has eventually
    # needed: a query built by string concatenation in shell cannot be tested,
    # and the failure mode is a query that parses fine and matches nothing.
    #
    # It emits "collection<TAB>queryJSON" and EXITS NON-ZERO if the manifest is
    # missing or would produce an empty slice, so a broken plan stops the run
    # here rather than dropping QA collections one at a time.
    build_sample_plan

    # ── THE ORDER — MONEY-1487 ─────────────────────────────────────────────
    #
    # `REFERENCE_COLLECTIONS` stays exactly what it was: a static, commented,
    # reviewable manifest. What changes is the ORDER this loop walks it in.
    #
    # The array grew 21 -> 54 when the US backbone landed and the US block sits
    # above the India one, so for three weeks every India reference collection
    # was below the point a 3600s-killed run could reach. The array's LINE
    # NUMBER was the sort key, which is MONEY-1211 (a sort key constant across
    # the population) and MONEY-1255 (`fetchedAt: "desc"` over a growing queue)
    # at a new layer: a class that always sorts last is always the one a
    # truncation drops.
    #
    # The new key is least-recently-VISITED first. Visited, not SUCCEEDED:
    # `candles` (29M rows) has failed every run since 2026-09-01 after burning
    # 25-29 minutes of a 60-minute budget, and a success-keyed order would park
    # it at the front for ever and starve the other 53 — MONEY-1255's stamping
    # lesson, arrived at from the other direction.
    SYNC_ORDER=()
    ORDER_SOURCE="freshness (least-recently-visited first)"
    # GUARDED. `ORDER_LINE=$(resolve_sync_order …)` unguarded would abort the
    # whole sync under `set -eo pipefail` the moment the bookkeeping query
    # hiccupped — a diary outage cancelling the data copy.
    #
    # `if VAR=$(cmd); then` is the guarded form: `set -e` is suspended for a
    # command in an `if` CONDITION, so a failure lands in the else-branch
    # instead of killing the script. A bare `VAR=$(cmd)` does not get that.
    ORDER_LINE=""
    if ! ORDER_LINE="$(resolve_sync_order "$QA_URL" 2>/dev/null)"; then
        ORDER_LINE=""
    fi
    # `read -a` rather than a `while read` loop, deliberately: collection names
    # cannot contain whitespace, and a loop here would put a second 4-space
    # `done` above the restore loop that the re-link tests locate structurally.
    [ -n "$ORDER_LINE" ] && read -r -a SYNC_ORDER <<< "$ORDER_LINE"
    # NOT-MEASURED-IS-NOT-PASSED: the result must be a full permutation of the
    # manifest. A short list means the query answered partially, and silently
    # syncing a SUBSET because the ordering query was unhappy is a worse bug
    # than the one being fixed.
    if [ ${#SYNC_ORDER[@]} -ne ${#REFERENCE_COLLECTIONS[@]} ]; then
        SYNC_ORDER=("${REFERENCE_COLLECTIONS[@]}")
        ORDER_SOURCE="manifest order (FALLBACK — the freshness record could not be read)"
        echo -e "${YELLOW}Could not order by freshness; falling back to the static manifest order.${NC}"
        echo -e "${YELLOW}  This run is correct but does NOT rotate — the tail stays the tail.${NC}"
    fi
    echo -e "${BLUE}Collection order: ${ORDER_SOURCE}${NC}"
    echo ""

    TOTAL=${#SYNC_ORDER[@]}
    IDX=0
    SKIPPED_EMPTY=()
    SKIPPED_SAMPLE_MISS=()

    for C in "${SYNC_ORDER[@]}"; do
        IDX=$((IDX + 1))
        C_STARTED_MS="$(now_ms)"

        # Empty-guard: count prod FIRST (estimatedDocumentCount is O(1) metadata,
        # no scan). If prod is empty we SKIP — never drop/wipe QA's copy. This is
        # the "don't update empty data" guarantee.
        #
        # ── THE GUARD ON THE ASSIGNMENT — MONEY-1487 ───────────────────────
        #
        # This was a BARE `CNT=$(mongosh … | tr -dc '0-9')`, and under
        # `set -eo pipefail` (line 112) that is fatal rather than merely
        # unhandled: pipefail gives the pipeline mongosh's non-zero status, a
        # bare assignment takes the status of its command substitution, and
        # `set -e` kills the script on it. So the `if [ -z "$CNT" ]` fallback
        # directly below — a documented behaviour, written to handle exactly
        # this — was UNREACHABLE, and one flaky count against Atlas aborted the
        # whole sync mid-list with no message, leaving every collection after it
        # unvisited. Verified by execution, not by reading.
        #
        # `if ! CNT=$(…)` suspends `set -e` for the condition, so a failed count
        # becomes a NAMED per-collection outcome (COUNT_FAILED — failed BEFORE
        # starting, QA untouched) and the loop carries on to the other 53.
        CNT=""
        if ! CNT=$(mongosh "$PROD_URL" --quiet \
            --eval "db.getCollection('$C').estimatedDocumentCount()" 2>/dev/null \
            | tr -dc '0-9'); then
            echo -e "${RED}[${IDX}/${TOTAL}] ${C}${NC}  prod count FAILED → ${RED}skip${NC} (QA untouched)"
            FAILED+=("$C")
            outcome_write "$C" "COUNT_FAILED" "" "$C_STARTED_MS"
            continue
        fi
        # An UNREADABLE count is not an EMPTY prod, and this used to treat them
        # as one: `[ -z "$CNT" ] || [ "$CNT" -eq 0 ]` skipped quietly and left
        # the run green, so a collection nobody could count looked exactly like
        # a collection that had nothing to copy. That is the session's recurring
        # shape — a safe fallback that works and, by working, removes the only
        # evidence anything was wrong. QA is untouched either way; only the
        # verdict differs, and the verdict is the deliverable.
        if [ -z "$CNT" ]; then
            echo -e "${RED}[${IDX}/${TOTAL}] ${C}${NC}  prod count unreadable → ${RED}skip${NC} (QA untouched)"
            FAILED+=("$C")
            outcome_write "$C" "COUNT_FAILED" "" "$C_STARTED_MS"
            continue
        fi
        if [ "$CNT" -eq 0 ]; then
            echo -e "${YELLOW}[${IDX}/${TOTAL}] ${C}${NC}  prod empty → ${YELLOW}skip${NC} (guard; QA untouched)"
            SKIPPED_EMPTY+=("$C")
            outcome_write "$C" "SKIPPED_EMPTY" "0" "$C_STARTED_MS"
            continue
        fi

        # ── --tier=sample: narrow to the planned slice ─────────────────────
        #
        # THE GUARD BELOW IS THE POINT. `mongorestore --drop` drops the target
        # collection BEFORE restoring, so a query that matches zero rows does
        # not copy nothing — it DELETES QA's table and replaces it with nothing.
        # A whole-collection sync could never do that (the empty-guard above
        # catches an empty prod), but a sampled one can: prod is full, the
        # sample simply misses. So the sampled count is taken FIRST and a zero
        # skips, exactly like the empty-guard.
        SAMPLE_QUERY=""
        if [ "$TIER" == "sample" ]; then
            SAMPLE_QUERY=$(awk -F"\t" -v c="$C" '$1 == c { print $2; exit }' "$SAMPLE_PLAN_FILE")
            if [ -z "$SAMPLE_QUERY" ]; then
                # In the allowlist but not in the plan. Refuse rather than fall
                # back to copying everything: an unplanned collection reaching
                # QA whole is how a "sample" quietly becomes a full sync.
                echo -e "${RED}[${IDX}/${TOTAL}] ${C}${NC}  no entry in the sample plan → ${RED}skip${NC} (add it to SAMPLE_PLAN)"
                FAILED+=("$C")
                outcome_write "$C" "COUNT_FAILED" "$CNT" "$C_STARTED_MS"
                continue
            fi
            case "$SAMPLE_QUERY" in
                *"'"*)
                    # Interpolated into a single-quoted JS string below. A
                    # symbol containing an apostrophe would break out of it and
                    # change what runs, so refuse instead of guessing.
                    echo -e "${RED}[${IDX}/${TOTAL}] ${C}${NC}  sample query contains a single quote → ${RED}skip${NC}"
                    FAILED+=("$C")
                    outcome_write "$C" "COUNT_FAILED" "$CNT" "$C_STARTED_MS"
                    continue ;;
            esac
            # Guarded for the same reason the empty-guard count above is: a bare
            # assignment from a failing pipeline aborts the whole run under
            # `set -eo pipefail` and makes the `-z` fallback below unreachable.
            SCNT=""
            if ! SCNT=$(mongosh "$PROD_URL" --quiet \
                --eval "db.getCollection('$C').countDocuments(EJSON.parse('$SAMPLE_QUERY'))" 2>/dev/null \
                | tr -dc '0-9'); then
                echo -e "${RED}[${IDX}/${TOTAL}] ${C}${NC}  sample count FAILED → ${RED}skip${NC} (QA untouched)"
                FAILED+=("$C")
                outcome_write "$C" "COUNT_FAILED" "$CNT" "$C_STARTED_MS"
                continue
            fi
            if [ -z "$SCNT" ] || [ "$SCNT" -eq 0 ]; then
                echo -e "${YELLOW}[${IDX}/${TOTAL}] ${C}${NC}  sample matched 0 of ${CNT} rows → ${YELLOW}skip${NC} (guard; QA untouched)"
                # A DIFFERENT fact from "prod is empty", and it must not share
                # that counter. Prod having no rows is a healthy no-op; prod
                # being FULL while the sample matches none of it means the
                # manifest is stale, a field name is wrong, or a date is the
                # wrong BSON type — and with one counter that run printed
                # "Skipped 39 empty-in-prod collection(s)" and exited 0.
                SKIPPED_SAMPLE_MISS+=("$C")
                outcome_write "$C" "SKIPPED_SAMPLE_MISS" "$CNT" "$C_STARTED_MS"
                continue
            fi
            echo -e "${BLUE}[${IDX}/${TOTAL}] ${C}${NC}  (prod -> qa, drop + restore, ${SCNT} of ${CNT} rows sampled)"
        else
            echo -e "${BLUE}[${IDX}/${TOTAL}] ${C}${NC}  (prod -> qa, drop + restore, ${CNT} rows)"
        fi
        # Drop-then-restore: QA's own copy has different _ids (QA fetched these
        # before scrape-once), so an _id upsert collides on the unique natural-key
        # index. Drop clears QA's stale copy, then restore prod's. --drop drops
        # ONLY this collection (the archive holds just $C), never the whole DB.
        # Streamed via --archive (no temp disk); pipefail surfaces a dump failure.
        DUMP_ARGS=(--uri="$PROD_URL" --collection="$C" --archive)
        if [ -n "$SAMPLE_QUERY" ]; then
            DUMP_ARGS+=(--query="$SAMPLE_QUERY")
        fi
        # STDERR IS KEPT, NOT DISCARDED. MONEY-1483.
        #
        # Both streams went to /dev/null, so a collection that failed said
        # exactly "FAILED (continuing)" and nothing else, for ever. Measured on
        # prod: `candles` (29,112,639 rows) has failed on EVERY run since
        # 2026-09-01 after burning 25-29 minutes of a 60-minute budget, and the
        # cause is not recoverable from any log, because the only process that
        # knew it was told to throw it away. A job that discards its own
        # diagnostic cannot be debugged from the outside, and this one has 18
        # consecutive nightly failures nobody could act on.
        #
        # REDACTED BEFORE IT IS PRINTED: mongo tools echo the connection string
        # on several error paths, and that string carries credentials into Cloud
        # Logging, where it is retained and indexed. The same class this repo
        # fixed at the worker console boundary (MONEY-1209).
        #
        # Bounded to the last 20 lines. A mongorestore failure mid-stream can
        # emit thousands of per-document errors, and the useful part is the end.
        DUMP_ERR="$(mktemp)"
        RESTORE_ERR="$(mktemp)"
        # ── THE INTENT IS WRITTEN FIRST — MONEY-1488 ───────────────────────
        #
        # This is the only line that can record "the run died here". Everything
        # past this point can be killed at the 3600s task timeout, and a killed
        # process writes nothing — so IN_FLIGHT is stamped BEFORE the pipeline
        # and the ABSENCE of the overwrite below is the signal. Without it a
        # truncated run is indistinguishable from one that never reached the
        # collection, and the two need opposite responses: `mongorestore --drop`
        # drops QA's copy before it writes, so a kill leaves a SCATTERED partial
        # subset, which is precisely the state a delta bound must never trust.
        outcome_write "$C" "IN_FLIGHT" "$CNT" "$C_STARTED_MS"
        # ── UNIQUE KEY FIRST — MONEY-1519 ──────────────────────────────────
        #
        # For a collection QA also writes, the key goes in BEFORE the rows and
        # `--drop` stays OFF: it would drop the key the pre-step just built and
        # reopen the window the QA writer filled with duplicates every night.
        # Stamped IN_FLIGHT first because the pre-step DROPS — a kill here is a
        # kill mid-restore and must read as one.
        RESTORE_DROP=(--drop)
        if is_unique_first "$C"; then
            UF_RC=0
            prepare_unique_first "$C" || UF_RC=$?
            if [ "$UF_RC" -ne 0 ]; then
                echo -e "   ${RED}INDEX_BUILD_FAILED${NC} (continuing) — the unique key is not in place, so the rows were NOT restored"
                FAILED+=("${C}:INDEX_BUILD_FAILED")
                outcome_write "$C" "INDEX_BUILD_FAILED" "$CNT" "$C_STARTED_MS"
                rm -f "$DUMP_ERR" "$RESTORE_ERR"
                continue
            fi
            RESTORE_DROP=()
        fi
        if mongodump "${DUMP_ARGS[@]}" 2>"$DUMP_ERR" \
            | mongorestore --uri="$QA_URL" "${RESTORE_DROP[@]}" --archive 2>"$RESTORE_ERR"; then
            echo -e "   ${GREEN}done${NC}"
            # Its "failures" are the bars QA's own writer landed first, REFUSED
            # by the key on arrival — by design, and printed so that it is never
            # silent. `|| true`: a summary line missing must not kill the run.
            if is_unique_first "$C"; then
                grep -o 'finished restoring .*' "$RESTORE_ERR" | tail -1 | sed 's/^/     /' || true
            fi
            RESTORED+=("$C")
            outcome_write "$C" "RESTORED" "$CNT" "$C_STARTED_MS"
        else
            # ── THE ROWS LANDED AND AN INDEX DID NOT — MONEY-1519 ────────
            #
            # `mongorestore` builds indexes after the last row, in ONE
            # createIndexes call that is all-or-nothing, and says so in a
            # line of its own. That is not FAILED: the data is whole and the
            # uniqueness contract is not, which needs a different fix — and
            # for 21 nights it read as a plain FAILED while QA kept 29.6M
            # `candles` rows with nothing but `_id_`.
            if grep -q 'error creating indexes for' "$RESTORE_ERR"; then
                C_STATE="INDEX_BUILD_FAILED"
                if is_unique_first "$C"; then
                    echo -e "   ${RED}INDEX_BUILD_FAILED${NC} (continuing) — the rows landed; the unique key built first still holds, the other indexes did not build"
                else
                    echo -e "   ${RED}INDEX_BUILD_FAILED${NC} (continuing) — the rows landed and QA holds them WITHOUT their indexes, unique key included"
                fi
                FAILED+=("${C}:INDEX_BUILD_FAILED")
            else
                C_STATE="FAILED"
                echo -e "   ${RED}FAILED${NC} (continuing)"
                FAILED+=("$C")
            fi
            # DISTINCT from IN_FLIGHT: the pipeline ran to completion and
            # reported an error, so we know it finished. Both mean QA may hold
            # a partial copy; only one of them means the job is still alive.
            outcome_write "$C" "$C_STATE" "$CNT" "$C_STARTED_MS"
            for STREAM in "dump:$DUMP_ERR" "restore:$RESTORE_ERR"; do
                LABEL="${STREAM%%:*}"
                FILE="${STREAM#*:}"
                if [ -s "$FILE" ]; then
                    echo -e "   ${YELLOW}${C} ${LABEL} stderr (last 20 lines):${NC}"
                    tail -20 "$FILE" \
                        | mask_stream \
                        | sed 's/^/     /'
                fi
            done
        fi
        rm -f "$DUMP_ERR" "$RESTORE_ERR"
    done

    echo ""
    if [ ${#SKIPPED_SAMPLE_MISS[@]} -gt 0 ]; then
        echo -e "${YELLOW}Sample matched 0 rows in ${#SKIPPED_SAMPLE_MISS[@]} NON-EMPTY collection(s) (QA untouched): ${SKIPPED_SAMPLE_MISS[*]}${NC}"
        # Every sampled slice missing a populated prod is not a partial result,
        # it is a broken manifest — and it is indistinguishable from a clean run
        # unless it is said here and carried into the exit code.
        if [ ${#RESTORED[@]} -eq 0 ]; then
            echo -e "${RED}NO collection was restored and prod is NOT empty — the manifest or the plan is wrong.${NC}"
            FAILED+=("sample-matched-nothing")
        fi
    fi
    if [ ${#SKIPPED_EMPTY[@]} -gt 0 ]; then
        echo -e "${YELLOW}Skipped ${#SKIPPED_EMPTY[@]} empty-in-prod collection(s) (QA untouched): ${SKIPPED_EMPTY[*]}${NC}"
    fi
    # ── MANDATORY post-restore: re-link StockRatios -> InstrumentMapping ──
    #
    # MONEY-1219. `stock_ratios` carries an `instrumentId`, and the ids it
    # arrives with are PROD's. `instrument_mappings` is QA-DIRECT — QA mints its
    # own ObjectIds and is never overwritten by this script — so after every
    # single restore, all ~2,135 copied rows point at ids that exist only in
    # prod.
    #
    # For most collections a dangling `instrumentId` is cosmetic (see the note
    # further up: readers join on symbol). Here it is FATAL, because
    # `StockRatios.instrument` is a REQUIRED Prisma relation: Prisma does not
    # return null for it, it THROWS —
    #
    #     Inconsistent query result: Field instrument is required to return
    #     data, got `null` instead.
    #
    # The screener's `ratiosFirstPath` selects that relation, so the throw takes
    # out the whole query, `screenStocksAction` returns { success: false }, and
    # the UI silently shows every fundamental column as "-" with no error. That
    # is exactly what was observed on QA on 2026-08-19: 2,135 of 2,135 rows
    # orphaned, and the screener rendering blank M-CAP / P/E / ROE for everything.
    #
    # So this is NOT optional cleanup — it is part of the restore. Running the
    # sync without it leaves QA's screener broken every time.
    # ── Re-link EVERY required-relation collection — MONEY-1220 ─────────────
    #
    # Was stock_ratios only (MONEY-1216). Measured against the schema, FIVE
    # REFERENCE collections carry a REQUIRED `instrument` relation:
    # stock_ratios, stock_financials, stock_documents, stock_peers,
    # stock_shareholding. On a required relation Prisma does not return null for
    # a dangling id — it THROWS, and the throw kills the whole query, so one
    # orphan takes out every result the caller asked for. 1216's own note
    # predicted this ("any future collection ... has this same defect"); four
    # already did.
    #
    # `sync-relink-required.test.ts` derives that list FROM schema.prisma, so a
    # sixth cannot be added without either being covered or failing the suite.
    #
    # ── ORDER: RE-LINK FIRST, VERDICT SECOND — MONEY-1238 ───────────────────
    #
    # This used to read `if [ ${#FAILED[@]} -eq 0 ]`, i.e. it re-linked only when
    # NOTHING had failed — flatly against the paragraph above, which calls the
    # re-link part of the restore. One unrelated collection failing (say
    # `mf_nav_history` timing out) skipped the repair for the five that had just
    # been replaced with prod rows, leaving QA in exactly the state the repair
    # exists to prevent. That is backwards: a PARTIAL restore needs its restored
    # collections re-linked MORE than a clean one does, and bailing out early is
    # the one option that guarantees a broken QA.
    #
    # So the gate is now "did anything that carries a required relation actually
    # get restored", which is the only condition under which there is new
    # breakage to repair. Failures are evaluated afterwards, at the end of the
    # script, where they pick the EXIT CODE.
    #
    # The repair covers ALL of RELINK_COLLECTIONS, not just the ones restored on
    # this run: it is idempotent (a collection with no orphans costs one indexed
    # scan and writes nothing) and repairing the whole set also heals rows left
    # dangling by an earlier run that skipped the re-link — which, before this
    # change, was every run.
    RELINK_NEEDED=false
    for R in "${RESTORED[@]}"; do
        for C in "${RELINK_COLLECTIONS[@]}"; do
            if [ "$R" == "$C" ]; then
                RELINK_NEEDED=true
            fi
        done
    done

    if [ "$RELINK_NEEDED" == "true" ]; then
        echo ""
        echo -e "${BLUE}Re-linking required-relation collections -> instrument_mappings (QA mints its own ids)…${NC}"
        # `|| RELINK_RC=$?` and not a bare call: under `set -e` a bare failure
        # would kill the script here, skipping the summary AND the GCS half. The
        # status is captured so the decision below is explicit rather than a side
        # effect of where the failure happened.
        RELINK_RC=0
        relink_required "$QA_URL" || RELINK_RC=$?

        # ── DOES A FAILED RE-LINK FAIL THE RUN? YES — both flavours. ──
        # The header above calls this part of the restore, and it means it: with
        # a dangling REQUIRED relation Prisma THROWS rather than returning null,
        # so one orphaned row blanks every query that selects it. A run that
        # copies fresh rows and leaves them unlinked has not left QA stale, it
        # has left QA BROKEN — strictly worse than not running at all, because
        # before the run QA was consistent. Reporting SUCCEEDED over that is the
        # defect this whole block was rewritten to end.
        #
        # The two failures are recorded under DIFFERENT names because they need
        # different actions: `relink` means the repair could not run (re-run the
        # job / check connectivity); `relink-orphans-remain` means it ran fine
        # and QA still has dangling ids (this environment is missing instruments,
        # or holds rows for symbols it never had).
        #
        # The counter-argument, written down so a future reader can weigh it
        # rather than rediscover it: `relink-orphans-remain` can in principle go
        # PERMANENTLY red — a symbol delisted before QA's instrument-sync ever
        # ran has no mapping here and never will, and an alarm that is red every
        # night gets muted, which lands us back at green-over-broken. It is still
        # the honest verdict, because that is precisely the state in which QA's
        # screener throws. If it does turn out to be permanently non-zero, the
        # fix is to delete those unusable rows in QA, NOT to downgrade this to a
        # warning.
        if [ "$RELINK_RC" -eq 0 ]; then
            echo -e "${GREEN}   re-link complete${NC}"
        elif [ "$RELINK_RC" -eq 2 ]; then
            echo -e "${RED}   RE-LINK INCOMPLETE — rows still point at instruments QA does not have.${NC}"
            echo -e "${RED}   QA's screener, stock tabs and peers will throw on those collections.${NC}"
            FAILED+=("relink-orphans-remain")
        elif [ "$RELINK_RC" -eq 3 ]; then
            # MONEY-1487. A THIRD distinct verdict, and it needs a third action:
            # the re-link worked, nothing dangles, and a collection is holding
            # rows with no unique index because an earlier run was killed before
            # `mongorestore` rebuilt them. Re-run the sync for it, or
            # `prisma db push`. Collapsing it into `relink` would send an
            # operator to check connectivity for a healthy connection.
            echo -e "${RED}   INDEXES MISSING — a collection holds rows with only _id_.${NC}"
            echo -e "${RED}   A killed restore left it enforcing nothing; it is taking duplicates now.${NC}"
            FAILED+=("missing-indexes")
        else
            echo -e "${RED}   RE-LINK FAILED (exit ${RELINK_RC}) — QA's screener, stock tabs and peers will throw${NC}"
            echo -e "${RED}   until this is run by hand:${NC}"
            echo -e "${RED}     DATABASE_URL=<qa> npx tsx scripts/ops/repair-instrument-links.ts --apply${NC}"
            FAILED+=("relink")
        fi
    elif [ ${#RESTORED[@]} -eq 0 ]; then
        echo ""
        echo -e "${YELLOW}Re-link SKIPPED — nothing was restored, so no new rows carry prod's ids.${NC}"
    else
        echo ""
        echo -e "${YELLOW}Re-link SKIPPED — no required-relation collection was restored this run.${NC}"
    fi

    if [ ${#FAILED[@]} -eq 0 ]; then
        echo -e "${GREEN}MongoDB sync complete — ${#RESTORED[@]} copied, ${#SKIPPED_EMPTY[@]} skipped.${NC}"
    else
        echo -e "${YELLOW}MongoDB sync finished with ${#FAILED[@]} failure(s): ${FAILED[*]}${NC}"
    fi
else
    mongo_skip_notice "Part 1: "
fi

# ============================================
# Part 2: GCS bucket prefixes (prod -> qa) — stocks/, or feeds/ + candles/
# ============================================
if [ "$DO_GCS" == "true" ]; then
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    # MONEY-1157: this said "stocks/" unconditionally, so the feeds job's only
    # operator-visible log named the wrong prefix while rsyncing feeds/. The
    # label is derived where GCS_SRC/GCS_DST are chosen, so it cannot drift.
    # `${VAR:+ + …}` so the second prefix appears only on the tier that moves
    # it, and from the SAME variable the rsync below uses.
    echo -e "${CYAN}  Part 2: GCS ${GCS_PREFIX_LABEL}${CANDLES_GCS_PREFIX_LABEL:+ + ${CANDLES_GCS_PREFIX_LABEL}} bucket (PROD -> QA)${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${GCS_SRC}  ->  ${GCS_DST}"
    echo ""

    # `gcloud storage rsync -r` is the modern command: -r recurses into the
    # prefix and rsync transfers ONLY the diffs (new/changed objects).
    #
    # `"${GCS_RSYNC_EXCLUDE[@]}"` is EMPTY on the non-feeds tier and expands to
    # nothing. Safe here because this script runs `set -eo pipefail` and NOT
    # `set -u` — under `set -u`, bash 3.2 (which is what macOS ships) treats
    # `${arr[@]}` on an empty array as unbound and would abort. If `-u` is ever
    # added to the set line above, this must become
    # `${GCS_RSYNC_EXCLUDE[@]+"${GCS_RSYNC_EXCLUDE[@]}"}`.
    gcloud storage rsync -r "${GCS_RSYNC_EXCLUDE[@]}" "$GCS_SRC" "$GCS_DST"

    # The second pair (MONEY-1373). Empty on every tier but `feeds`, and passed
    # with NO exclusion array — see the tier block for why reusing the feeds
    # one would be wrong rather than merely redundant.
    if [ -n "$CANDLES_GCS_SRC" ]; then
        echo ""
        echo -e "  ${CANDLES_GCS_SRC}  ->  ${CANDLES_GCS_DST}"
        echo ""
        gcloud storage rsync -r "$CANDLES_GCS_SRC" "$CANDLES_GCS_DST"
    fi

    # The chart tiles — a DIFFERENT BUCKET PAIR (stockbook-lake-*), see above.
    if [ -n "$TILES_GCS_SRC" ]; then
        echo ""
        echo -e "  ${TILES_GCS_SRC}  ->  ${TILES_GCS_DST}"
        echo ""
        gcloud storage rsync -r "$TILES_GCS_SRC" "$TILES_GCS_DST"
    fi

    echo ""
    echo -e "${GREEN}GCS sync complete.${NC}"
else
    echo -e "${YELLOW}Part 2: GCS sync SKIPPED (--collections-only).${NC}"
fi

# ============================================
# Done — and the EXIT CODE is the whole point of this block (MONEY-1238)
# ============================================
# `scripts/ops/sync-job/Dockerfile` sets ENTRYPOINT to this script, so THIS
# script's exit status is what Cloud Run reports for `sync-prod-to-qa-daily`.
# Until now the last executable statement was the green banner below, so the
# script fell off the end and exited 0 — the job was reported SUCCEEDED with
# reference collections missing from QA and, since the re-link could not run at
# all in the image, with the restored ones pointing at prod's ObjectIds.
#
# Everything that can go wrong and be survived appends to FAILED (a collection
# whose dump/restore failed, and the two re-link verdicts). Anything that cannot
# be survived has already exited non-zero on its own: `set -eo pipefail` makes
# the GCS rsync in Part 2 fatal where it stands.
if [ ${#FAILED[@]} -gt 0 ]; then
    echo ""
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║  Reference-Data Sync FAILED  (PROD -> QA)             ║"
    echo "╚════════════════════════════════════════════════════════╝"
    echo -e "${RED}${#FAILED[@]} step(s) failed: ${FAILED[*]}${NC}"
    echo ""
    exit 1
fi

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  Reference-Data Sync Complete!  (PROD -> QA)          ║"
echo "╚════════════════════════════════════════════════════════╝"
echo ""
exit 0
