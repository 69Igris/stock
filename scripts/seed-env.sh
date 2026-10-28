#!/bin/bash
# ============================================
# Helper: mask a connection string for safe logging — MONEY-1494.
# FAILS CLOSED. Copied from `scripts/ops/run-market-data-job.sh`, which is
# where this defect was first diagnosed; do not re-derive a fourth spelling.
# ============================================
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
# UseMoney - Full Data Seed (Multi-Environment)
# ============================================
# Runs the complete seeding pipeline against QA, prod, or both.
# Fetches DATABASE_URL from GCP Secret Manager or uses a direct URL.
#
# Pipeline:
#   1. Instruments       - Zerodha dump → InstrumentMapping (~8000 stocks + ETFs)
#   2. Mutual Funds      - AMFI NAV feed → MutualFundMaster (~45000 schemes)
#   3. Sectors           - Yahoo Finance → InstrumentMapping.sector (~8000 instruments)
#   3b. Sector Normalize - Re-map Yahoo GICS → canonical NSE sector names
#   4. MF Metadata       - Kuvera API → MutualFundMaster metadata (full enrichment)
#   5. Prices            - Yahoo Finance → LatestQuote
#   6. Stock Ratios      - Tickertape → StockRatios (ALL active instruments, ~3-4 hours)
#   7. Stock Financials  - Tickertape → StockFinancials (ALL instruments, ~4 hours)
#   8. Stock Profiles    - Yahoo Finance → StockProfile (ALL instruments, ~3 hours)
#   9. MF Data           - Tickertape → MF overview + holdings (~2 hours)
#  10. ETF Data          - Yahoo Finance → ETF profiles + key metrics (~30 min)
#  11-14. Stock Docs     - Tickertape/NSE/Screener → GCS + StockDocument
#  15. Embed Stock Docs  - Gemini text-embedding-004 → DocumentEmbedding (RAG)
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (for qa/prod targets)
#   - DATABASE_URL_QA / DATABASE_URL_PROD secrets exist in GCP Secret Manager
#   - Node.js + tsx available
#
# Usage:
#   ./scripts/seed-env.sh qa                          # Seed QA database
#   ./scripts/seed-env.sh prod                        # Seed Production database
#   ./scripts/seed-env.sh all                         # Seed both QA and Production
#   ./scripts/seed-env.sh prod --step 3               # Run only step 3 (sectors) on prod
#   ./scripts/seed-env.sh prod --from 3               # Run steps 3-5 on prod
#   ./scripts/seed-env.sh --url "mongodb+srv://..."   # Use direct DB URL
#   ./scripts/seed-env.sh --url "mongodb+srv://..." --step 3   # Direct URL + specific step
# ============================================

set -e

TARGET=""
STEP_FLAG=""
STEP_VALUE=""
DIRECT_URL=""

# Parse arguments
while [ $# -gt 0 ]; do
    case "$1" in
        --url) DIRECT_URL="$2"; shift 2 ;;
        --step) STEP_FLAG="step"; STEP_VALUE="$2"; shift 2 ;;
        --from) STEP_FLAG="from"; STEP_VALUE="$2"; shift 2 ;;
        qa|prod|all) TARGET="$1"; shift ;;
        *) echo "Unknown argument: $1"; exit 1 ;;
    esac
done

# Validate: need either a target (qa/prod/all) or --url
if [ -z "$TARGET" ] && [ -z "$DIRECT_URL" ]; then
    echo "Usage: ./scripts/seed-env.sh [qa|prod|all] [--step N] [--from N]"
    echo "       ./scripts/seed-env.sh --url \"mongodb+srv://...\" [--step N] [--from N]"
    echo ""
    echo "  qa           Seed QA database (fetches URL from GCP Secret Manager)"
    echo "  prod         Seed Production database (fetches URL from GCP Secret Manager)"
    echo "  all          Seed both QA and Production (sequentially)"
    echo "  --url URL    Use a direct MongoDB connection string"
    echo ""
    echo "  --step N     Run only step N (1=instruments, 2=mf, 3=sectors, 4=mf-metadata, 5=prices)"
    echo "  --from N     Run from step N onwards"
    echo ""
    echo "Steps:"
    echo "  1.  Instruments       - Zerodha dump → InstrumentMapping"
    echo "  2.  Mutual Funds      - AMFI NAV feed → MutualFundMaster"
    echo "  3.  Sectors           - Yahoo Finance → InstrumentMapping.sector"
    echo "  3b. Sector Normalize  - Re-map Yahoo GICS → canonical NSE names (runs after step 3)"
    echo "  4.  MF Metadata       - Kuvera API → full MutualFundMaster enrichment"
    echo "  5.  Prices            - Yahoo Finance → LatestQuote"
    exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PROJECT_ID="stock-book-483718"

# ============================================
# Helper: check if step should run
# ============================================
should_run_step() {
    local STEP=$1
    if [ -z "$STEP_FLAG" ]; then
        return 0  # no filter, run all
    elif [ "$STEP_FLAG" == "step" ] && [ "$STEP" == "$STEP_VALUE" ]; then
        return 0
    elif [ "$STEP_FLAG" == "from" ] && [ "$STEP" -ge "$STEP_VALUE" ]; then
        return 0
    fi
    return 1
}

# ============================================
# Helper: fetch DATABASE_URL from GCP Secret Manager
# ============================================
get_db_url() {
    local ENV=$1
    local SECRET_NAME=""

    if [ "$ENV" == "qa" ]; then
        SECRET_NAME="DATABASE_URL_QA"
    elif [ "$ENV" == "prod" ]; then
        SECRET_NAME="DATABASE_URL_PROD"
    fi

    # Status messages go to stderr so stdout is clean for capture
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
# Helper: run a seed step
# ============================================
# Steps that ran and failed — MONEY-1238. Run-to-completion is the DOCUMENTED
# contract here (the script advertises 2-3 hours across 15 steps and offers
# --step/--from to resume), so a failure must not abort the remaining work. But
# "continue" and "report success" are separable, and only the first was ever
# implemented: every failure was announced and then discarded, and the run
# ended on a green "All Seeding Complete!" with exit 0. This list carries the
# failures to the exit code instead.
FAILED_STEPS=()

run_step() {
    local STEP_NUM=$1
    local STEP_NAME=$2
    local SCRIPT=$3
    local DB_URL=$4

    if ! should_run_step "$STEP_NUM"; then
        echo -e "   ${YELLOW}Skipping step ${STEP_NUM}: ${STEP_NAME}${NC}"
        return 0
    fi

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  Step ${STEP_NUM}: ${STEP_NAME}${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # `|| STEP_RC=$?` rather than a bare call — MONEY-1238. This file sets
    # `set -e`, under which a bare failing command aborts the whole script, so
    # the `else` arm below was UNREACHABLE: $? could only ever be 0 by the time
    # the test ran. The script promised "Continuing..." and in fact hard-aborted
    # on the first failure, discarding every completed step's summary. Capturing
    # the code restores the advertised behaviour AND records the failure. Note
    # that the tempting one-character fix, `|| true`, is the dangerous one: it
    # makes the branch reachable while still throwing the failure away.
    local STEP_RC=0
    # shellcheck disable=SC2086
    DATABASE_URL="$DB_URL" npx tsx $SCRIPT || STEP_RC=$?

    if [ "$STEP_RC" -eq 0 ]; then
        echo -e "${GREEN}Step ${STEP_NUM} complete.${NC}"
    else
        echo -e "${RED}Step ${STEP_NUM} FAILED (exit ${STEP_RC}). Continuing...${NC}"
        FAILED_STEPS+=("${STEP_NUM}: ${STEP_NAME}")
    fi
}

# ============================================
# Helper: seed one environment
# ============================================
seed_env() {
    local ENV=$1
    local DB_URL=$2

    echo ""
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║  UseMoney Full Seed: ${ENV}"
    echo "╠════════════════════════════════════════════════════════╣"
    echo "║  Steps: Instruments → MF → Sectors → Normalize → MF Meta → Prices"
    echo "╚════════════════════════════════════════════════════════╝"
    echo ""

    # Mask URL in logs
    local DB_HOST
    # MONEY-1494 — was `sed 's|mongodb+srv://[^@]*@|...'`, which matches Atlas
    # only. QA is self-hosted on a plain `mongodb://` URI, so the pattern missed
    # and this printed the password. Third site of one defect; see
    # `run-market-data-job.sh:422` for the original diagnosis.
    DB_HOST=$(mask_uri "$DB_URL")
    echo -e "  Target DB: ${DB_HOST}"
    echo ""

    # Confirmation for prod
    if [ "$ENV" == "prod" ]; then
        echo -e "${RED}WARNING: This will write to the PRODUCTION database.${NC}"
        read -p "Are you sure? (yes/no): " CONFIRM
        if [ "$CONFIRM" != "yes" ]; then
            echo "Skipping prod seed."
            return 0
        fi
    fi

    # Step 1: Instruments
    run_step 1 "Instruments (Zerodha dump → InstrumentMapping)" \
        "scripts/seed/seed-instruments.ts" "$DB_URL"

    # Step 2: Mutual Funds
    run_step 2 "Mutual Funds (AMFI NAV → MutualFundMaster)" \
        "scripts/seed/seed-mf.ts" "$DB_URL"

    # Step 3: Sectors + Normalization
    run_step 3 "Sector Enrichment (Yahoo Finance → sectors)" \
        "scripts/seed/seed-sectors.ts" "$DB_URL"

    # Step 3b: Normalize sectors (runs automatically after step 3)
    if should_run_step 3; then
        echo ""
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${CYAN}  Step 3b: Sector Normalization (Yahoo GICS → NSE names)${NC}"
        echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo ""
        DATABASE_URL="$DB_URL" npx tsx "scripts/data/normalize-sectors.ts"
        if [ $? -eq 0 ]; then
            echo -e "${GREEN}Step 3b complete.${NC}"
        else
            echo -e "${RED}Step 3b FAILED. Continuing...${NC}"
        fi
    fi

    # Step 4: MF Metadata (full enrichment)
    run_step 4 "MF Metadata Enrichment (Kuvera API → full metadata)" \
        "scripts/seed/seed-mf-metadata.ts" "$DB_URL"

    # Step 5: Prices
    run_step 5 "Price Quotes (Yahoo Finance → LatestQuote)" \
        "scripts/seed/seed-prices.ts" "$DB_URL"

    # Step 6: Stock Ratios (Tickertape → StockRatios for ALL active instruments)
    run_step 6 "Stock Ratios (Tickertape → StockRatios)" \
        "scripts/seed/seed-stock-ratios.ts" "$DB_URL"

    # Step 7: Stock Financials (Tickertape → StockFinancials for ALL instruments)
    run_step 7 "Stock Financials (Tickertape → StockFinancials)" \
        "scripts/seed/seed-stock-financials.ts" "$DB_URL"

    # Step 8: Stock Profiles (Yahoo → StockProfile for ALL instruments)
    run_step 8 "Stock Profiles (Yahoo Finance → StockProfile)" \
        "scripts/seed/seed-stock-profiles.ts" "$DB_URL"

    # Step 9: MF Data (Tickertape → MF overview + holdings enrichment)
    run_step 9 "MF Data (Tickertape → MF overview + holdings)" \
        "scripts/seed/seed-mf-tickertape.ts" "$DB_URL"

    # Step 10: ETF Data (Yahoo Finance → StockProfile + StockRatios for ETFs)
    run_step 10 "ETF Data (Yahoo Finance → ETF profiles + key metrics)" \
        "scripts/seed/seed-etf-data.ts" "$DB_URL"

    # Step 11a: Stock Docs - Tickertape financial statements (fast, can run in parallel)
    run_step 11 "Stock Docs - Tickertape Financials (→ GCS + RAG)" \
        "scripts/seed/seed-stock-documents.ts --source tickertape" "$DB_URL"

    # Step 11b: Stock Docs - NSE quarterly result PDFs
    run_step 12 "Stock Docs - NSE Quarterly Results (→ GCS)" \
        "scripts/seed/seed-stock-documents.ts --source nse-filings" "$DB_URL"

    # Step 11c: Stock Docs - NSE annual report PDFs
    run_step 13 "Stock Docs - NSE Annual Reports (→ GCS)" \
        "scripts/seed/seed-stock-documents.ts --source nse-reports" "$DB_URL"

    # Step 11d: Stock Docs - Screener.in (concall transcripts, annual reports, PPTs)
    run_step 14 "Stock Docs - Screener Concalls & Reports (→ GCS)" \
        "scripts/seed/seed-stock-documents.ts --source screener" "$DB_URL"

    # Step 15: Embed Stock Docs - Generate vector embeddings for RAG
    run_step 15 "Embed Stock Docs (→ DocumentEmbedding for RAG)" \
        "scripts/data/embed-stock-documents.ts --limit 5000" "$DB_URL"

    echo ""
    echo -e "${GREEN}Seed complete for ${ENV}.${NC}"
    echo ""
}

# ============================================
# Main
# ============================================

echo ""
echo "╔════════════════════════════════════════════════════════╗"
echo "║  UseMoney Multi-Environment Seed                      ║"
echo "╠════════════════════════════════════════════════════════╣"
if [ -n "$DIRECT_URL" ]; then
echo "║  Target: Direct URL"
else
echo "║  Target: ${TARGET}"
fi
if [ -n "$STEP_FLAG" ]; then
echo "║  Filter: --${STEP_FLAG} ${STEP_VALUE}"
fi
echo "╚════════════════════════════════════════════════════════╝"

# Direct URL mode - skip GCP, no confirmation prompt
if [ -n "$DIRECT_URL" ]; then
    seed_env "direct" "$DIRECT_URL"
else
    gcloud config set project $PROJECT_ID --quiet

    if [ "$TARGET" == "all" ]; then
        seed_env "qa" "$(get_db_url qa)"
        seed_env "prod" "$(get_db_url prod)"
    else
        seed_env "$TARGET" "$(get_db_url "$TARGET")"
    fi
fi

echo ""
if [ "${#FAILED_STEPS[@]}" -eq 0 ]; then
    echo "╔════════════════════════════════════════════════════════╗"
    echo "║  All Seeding Complete!                                 ║"
    echo "╚════════════════════════════════════════════════════════╝"
else
    echo -e "${RED}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║  Seeding finished with FAILED step(s) — see below      ║${NC}"
    echo -e "${RED}╚════════════════════════════════════════════════════════╝${NC}"
fi
echo ""
echo "Expected times per env:"
echo "  1. Instruments     ~2-5 min"
echo "  2. Mutual Funds    ~3-5 min"
echo "  3. Sectors         ~45-60 min (rate-limited, 500ms/call)"
echo "  3b. Normalize      ~1-2 min"
echo "  4. MF Metadata     ~60-90 min (rate-limited, Kuvera API)"
echo "  5. Prices          ~5-10 min"
echo ""
echo "Total: ~2-3 hours per environment for full seed."
echo ""

# Failures last, so they are what remains on screen after a 2-3 hour run, then
# the exit code — MONEY-1238. Printed AFTER the timings table deliberately:
# whichever block is last is the one the operator actually reads.
if [ "${#FAILED_STEPS[@]}" -ne 0 ]; then
    echo -e "${RED}${#FAILED_STEPS[@]} step(s) FAILED:${NC}"
    for f in "${FAILED_STEPS[@]}"; do
        echo -e "   ${RED}- ${f}${NC}"
    done
    echo ""
    echo -e "${YELLOW}Re-run just a failed step with:  $0 ${TARGET} --step <N>${NC}"
    exit 1
fi
