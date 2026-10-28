#!/usr/bin/env bash
#
# market-data-smoke.sh — prove a DEPLOYED usemoney-market-data actually serves
# the UDF contract from the edge. READ-ONLY: every request is a GET.
#
#   ./scripts/ops/market-data-smoke.sh qa
#   ./scripts/ops/market-data-smoke.sh prod
#   ./scripts/ops/market-data-smoke.sh qa --base https://1.2.3.4   # pre-DNS
#
# ## WHY THIS EXISTS RATHER THAN A LIST OF curl COMMANDS
#
# Every failure this checks for is SILENT in the product. TradingView renders an
# EMPTY CHART on a shape it does not understand — never an error — so a wrong
# `Cache-Control`, a millisecond clock, or `{s:"no_data"}` where `{s:"error"}`
# was meant all look like "the chart is blank" and nothing else. And the CDN
# check is the one a human gets wrong by hand: the FIRST request is always a
# MISS, so `curl -I` once proves nothing at all.
#
# ## WHAT IT WOULD HAVE CAUGHT
#
# A1's review found that nothing granted `allUsers -> roles/run.invoker`. An
# external ALB reaching Cloud Run through a serverless NEG sends no identity
# token, so every request would have been 403 — from a provisioning ladder that
# printed nothing but green. Check 1 is that, and it is first for a reason.
#
# ## IT CHECKS THE DATADOG SPAN TOO, WHICH NO HTTP RESPONSE CAN SHOW
#
# Check 8 asks Datadog whether the traffic checks 1-6 just generated produced
# any spans. It is the only check here that needs credentials, and it is the
# one silent failure this estate has actually shipped: a dd-trace ESM loader
# that does not take effect leaves the service serving every request correctly
# and emitting nothing, with no error anywhere (MONEY-1380).
#
# ## A SKIPPED CHECK IS NOT A PASSED CHECK
#
# Checks that cannot run are counted SKIPPED and the script still exits
# non-zero, because "not measured" reading as "verified" is the defect class
# this repo keeps paying for (MONEY-1238). Nothing here is allowed to be
# absent and green at the same time.

set -uo pipefail   # deliberately NOT -e: a failing check must be REPORTED, not abort the run

ENV_ARG="${1:-}"
shift || true
BASE_OVERRIDE=""
while [ $# -gt 0 ]; do
    case "$1" in
        --base) BASE_OVERRIDE="$2"; shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

# REQUIRED, never defaulted. A dropped argument must not print a green
# verification for an environment nobody asked about — the same rule
# lake-smoke.ts states for the same reason.
case "$ENV_ARG" in
    qa)   ENV="qa";   HOST="market-data-qa.usemoney.ai" ;;
    prod) ENV="prod"; HOST="market-data.usemoney.ai" ;;
    *)
        cat >&2 <<'USAGE'
Usage: ./scripts/ops/market-data-smoke.sh {qa|prod} [--base https://HOST-OR-IP]

Verifies a DEPLOYED usemoney-market-data: reachability (the run.invoker 403),
Cloud CDN actually caching, every route's Cache-Control, the UDF error shape,
/udf/time in SECONDS, the request-id NOT leaking into cached responses, and
that the run.app origin is NOT reachable from the internet.

A4/A5 (MONEY-1469/1470) add the GATES: /quotes refusing an anonymous caller,
the US LICENCE refusing market=US without the `us` claim, India quotes actually
SERVING (a check that only ever sees refusals cannot tell a working gate from a
broken route), intraday refusing as a 200 s:"error" rather than a 401 the widget
cannot parse, daily bars staying public, and X-Bar-Basis being exposed to the
browser — without which the basis badge can never render in production while
working perfectly in local dev.

Exits 0 only when every check passed. A check that could not run is SKIPPED
and still fails the run.
USAGE
        exit 1
        ;;
esac

BASE="${BASE_OVERRIDE:-https://${HOST}}"
PROJECT_ID="stock-book-483718"
GCLOUD_ACCOUNT="founder@disdigital.in"
SERVICE="usemoney-market-data-${ENV}"
REGION="asia-south1"
# A LITERAL, because a shell script cannot import
# packages/datadog/src/constants.ts. That is the same exemption the four
# cloudbuild sidecar specs and workers/scripts/deploy.sh take, and it carries
# the same obligation: this file is listed in site-agreement.test.ts, so the
# next org move turns it red here instead of leaving it answered 403 in silence.
DD_SITE="us5.datadoghq.com"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[0;32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[0;31mFAIL\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[0;33mSKIP\033[0m  %s\n' "$1"; [ $# -gt 1 ] && printf '        %s\n' "$2"; }

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  market-data smoke — ${ENV} · ${BASE}"
echo "╚══════════════════════════════════════════════════════════════════╝"

# Headers are lowercased so the greps below do not depend on the proxy's casing.
fetch_head() { curl -sS -m 20 -o /dev/null -D - "$1" 2>/dev/null | tr 'A-Z' 'a-z'; }
hdr() { printf '%s\n' "$1" | grep -i "^$2:" | head -1 | sed "s/^[^:]*: *//" | tr -d '\r'; }
status_of() { printf '%s\n' "$1" | grep -m1 '^http/' | awk '{print $2}'; }

echo ""
echo "── 1. reachable at all (this is where a missing run.invoker shows) ──"
CONF_H="$(fetch_head "${BASE}/udf/config")"
CONF_STATUS="$(status_of "$CONF_H")"
REACHABLE=0
if [ "$CONF_STATUS" = "200" ]; then
    REACHABLE=1
    ok "/udf/config -> 200"
elif [ "$CONF_STATUS" = "403" ]; then
    bad "/udf/config -> 403" \
        "the ALB sends no identity token; grant allUsers->run.invoker (setup-market-data-lb.sh)"
elif [ -z "$CONF_STATUS" ]; then
    bad "/udf/config -> no response" \
        "DNS not pointed at the reserved IP yet, or the managed cert is still PROVISIONING"
else
    bad "/udf/config -> ${CONF_STATUS}" "expected 200"
fi

echo ""
if [ "$REACHABLE" != "1" ]; then
    # EVERY check below reads a RESPONSE, so with no response they are not
    # failures in their own right — they are one root cause wearing a dozen
    # hats, and two of them would report PASS: "this header is ABSENT" is
    # vacuously true against a service that answered nothing at all. That is
    # exactly the not-measured-reading-as-verified defect this script's header
    # claims to refuse, so they are SKIPPED by name instead. A skip still fails
    # the run.
    echo ""
    skip "checks 2-6 (Cache-Control, CDN, request-id, UDF contract, health)" \
         "nothing answered at ${BASE} — fix check 1 first; these read a response and cannot mean anything without one"
else
    echo "── 2. Cache-Control, per route ──"
    CC="$(hdr "$CONF_H" cache-control)"
    [ "$CC" = "public, max-age=3600" ] \
        && ok "/udf/config Cache-Control: ${CC}" \
        || bad "/udf/config Cache-Control: '${CC:-<absent>}'" \
               "expected 'public, max-age=3600' — a missing header means the CDN caches NOTHING and this service is a slower Vercel function with an extra hop"

    TIME_H="$(fetch_head "${BASE}/udf/time")"
    TCC="$(hdr "$TIME_H" cache-control)"
    [ "$TCC" = "public, max-age=1" ] \
        && ok "/udf/time Cache-Control: ${TCC}" \
        || bad "/udf/time Cache-Control: '${TCC:-<absent>}'" "expected 'public, max-age=1'"

    # A REAL symbol over a REAL window. The old probe was `symbol=RELIANCE`
    # with from=0&to=1: `resolveListing` splits on ":", gets one part, returns
    # null, and the route always answered {"s":"error","errmsg":"unrecognised
    # symbol RELIANCE"} — which the body block below then greps for and calls
    # ok. So a total tile-store outage produced TWO green lines while a WORKING
    # endpoint returning {"s":"ok"} was marked bad. Green exactly when broken.
    HIST_TO="$(date +%s)"
    HIST_FROM="$((HIST_TO - 90 * 24 * 3600))"
    HIST_URL="${BASE}/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=${HIST_FROM}&to=${HIST_TO}"
    HIST_H="$(fetch_head "$HIST_URL")"
    HCC="$(hdr "$HIST_H" cache-control)"
    # THE HEADER IS A VERDICT ABOUT THE BODY, so grade it against the clock.
    #
    # Since MONEY-1475 the route only emits a CDN value when it HAS BARS: a
    # `no_data` (and every error path) now emits `no-store`. So on this probe —
    # NSE:RELIANCE over 90 days, which must have bars — `no-store` means the
    # chart is BLANK, and that is the platform-wide state a tile store left
    # unconfigured produces for every symbol (`readTile` yields `absent`, not
    # `failed`, so no error path runs and nothing else goes red).
    #
    # The check this replaced asserted `no-store` outright, which was the
    # pre-A2 501 policy. Its replacement accepted BOTH CDN values
    # unconditionally, which passed in exactly that blank-chart state — a
    # strict loss of detection. This grades three things instead: that the
    # value is a CDN value at all, that it matches the session the CLOCK says
    # we are in, and that `no-store` is reported as the blank chart it now is.
    #
    # Whitespace and ordering are normalised first: RFC 9111 makes
    # Cache-Control an unordered directive set and RFC 9110 permits OWS, so
    # `public,s-maxage=60,...` and a tab after the colon are the SAME policy and
    # must not fail a healthy service.
    HCC_N="$(printf '%s' "$HCC" | tr -d ' \t' | tr ',' '\n' | sort | paste -sd, -)"
    # In-session = Mon-Fri 09:15-15:30 IST, matching `inIndiaSession`.
    IST_DOW="$(TZ=Asia/Kolkata date +%u)"; IST_HM="$(TZ=Asia/Kolkata date +%H%M)"
    if [ "$IST_DOW" -le 5 ] && [ "$IST_HM" -ge 0915 ] && [ "$IST_HM" -le 1530 ]; then
        WANT_TTL="s-maxage=60";   WANT_LABEL="in-session"
    else
        WANT_TTL="s-maxage=3600"; WANT_LABEL="out-of-session"
    fi
    case "$HCC_N" in
        "no-store")
            bad "/udf/history Cache-Control: no-store" \
                "since MONEY-1475 this means NO BARS — the chart is blank. A tile store left unconfigured answers no_data for EVERY symbol, and nothing else in this script goes red for it. Check 5 below says which" ;;
        *"$WANT_TTL"*)
            ok "/udf/history Cache-Control: ${HCC} (${WANT_LABEL}, clock-checked)" ;;
        *s-maxage=*)
            bad "/udf/history Cache-Control: '${HCC}'" \
                "it is ${WANT_LABEL} in IST (${IST_DOW} ${IST_HM}) so ${WANT_TTL} was expected — inIndiaSession or the revision's clock disagrees with the wall clock, and a still-forming bar pinned for an hour is the staleness that function exists to prevent" ;;
        *)
            bad "/udf/history Cache-Control: '${HCC:-<absent>}'" \
                "expected a cdnCacheControlForHistory value (s-maxage=60 in-session, 3600 outside) or no-store" ;;
    esac
    LIVE_H="$(fetch_head "${BASE}/health/live")"
    LCC="$(hdr "$LIVE_H" cache-control)"
    [ "$LCC" = "no-store" ] \
        && ok "/health/live Cache-Control: no-store" \
        || bad "/health/live Cache-Control: '${LCC:-<absent>}'" "a cached health 200 hides an unhealthy instance"

    echo ""
    echo "── 3. Cloud CDN is actually SERVING FROM THE EDGE ──"
    # The first request is always a MISS, which is why `curl -I` once proves
    # nothing. Cloud CDN stamps `age:` on a hit. Retried a few times because the
    # fill is not instantaneous and a POP may answer before it completes.
    AGE=""
    for attempt in 1 2 3 4; do
        H="$(fetch_head "${BASE}/udf/config")"
        AGE="$(hdr "$H" age)"
        if [ -n "$AGE" ] && [ "$AGE" -gt 0 ] 2>/dev/null; then break; fi
        sleep 2
    done
    if [ -n "$AGE" ] && [ "$AGE" -gt 0 ] 2>/dev/null; then
        ok "/udf/config served from the edge (age: ${AGE}s)"
    else
        bad "/udf/config never reported a cache age" \
            "CDN is off on the backend, or the origin's Cache-Control stops it caching. This is THE A1 acceptance."
    fi

    echo ""
    echo "── 4. the request id must NOT ride a cached response ──"
    # Cloud CDN stores the origin's headers and replays them on every hit, so an id
    # here is handed to every caller for an hour — it correlates one reader's
    # request to a stranger's, on exactly the routes this service exists to cache.
    CACHED_RID="$(hdr "$(curl -sS -m 20 -o /dev/null -D - -H 'x-request-id: smoke-private-id' "${BASE}/udf/config" 2>/dev/null | tr 'A-Z' 'a-z')" x-request-id)"
    [ -z "$CACHED_RID" ] \
        && ok "/udf/config carries no x-request-id (not even an inbound one)" \
        || bad "/udf/config returned x-request-id: ${CACHED_RID}" \
               "the CDN will replay this to every caller for the whole TTL"

    UNCACHED_RID="$(hdr "$(curl -sS -m 20 -o /dev/null -D - -H 'x-request-id: smoke-trace-id' "${BASE}/health/live" 2>/dev/null | tr 'A-Z' 'a-z')" x-request-id)"
    [ "$UNCACHED_RID" = "smoke-trace-id" ] \
        && ok "/health/live echoes an inbound x-request-id" \
        || bad "/health/live x-request-id: '${UNCACHED_RID:-<absent>}'" \
               "expected the inbound id — a trace started at the LB must stay one identity across the hop"

    echo ""
    echo "── 5. the UDF contract (every failure here renders as a BLANK CHART) ──"
    TIME_BODY="$(curl -sS -m 20 "${BASE}/udf/time" 2>/dev/null | tr -d '\r\n ')"
    if printf '%s' "$TIME_BODY" | grep -qE '^[0-9]+$'; then
        NOW="$(date +%s)"
        DRIFT=$(( TIME_BODY > NOW ? TIME_BODY - NOW : NOW - TIME_BODY ))
        if [ "${#TIME_BODY}" -ge 12 ]; then
            bad "/udf/time returned ${TIME_BODY}" \
                "that is MILLISECONDS — it puts the chart ~55,000 years in the future and renders empty, not as an error"
        elif [ "$DRIFT" -lt 120 ]; then
            ok "/udf/time = ${TIME_BODY} (seconds, drift ${DRIFT}s)"
        else
            bad "/udf/time = ${TIME_BODY}, ${DRIFT}s from this machine's clock" "expected seconds near now"
        fi
    else
        bad "/udf/time body: '${TIME_BODY}'" "the UDF spec reads this as PLAIN TEXT; JSON makes the widget parse NaN"
    fi

    HIST_BODY="$(curl -sS -m 20 "$HIST_URL" 2>/dev/null)"
    HIST_STATUS="$(status_of "$HIST_H")"
    # 200, not 501. A2 shipped the tile reader and A3 flipped the chart onto it,
    # so this assertion has been RED on every run since — and a check that is
    # permanently red is a check everyone learns to scroll past, which is worse
    # than not having it. UDF answers 200 for everything, including refusals.
    # NO STATUS ASSERTION. Every return in history.ts is c.json(..., 200) —
    # malformed query, unresolved symbol, tile outage, no_data and real bars
    # alike — so `[ "$HIST_STATUS" = "200" ]` passed for any reachable service
    # and measured nothing. The BODY is the only thing that carries the verdict.
    if printf '%s' "$HIST_BODY" | grep -q '"s":"ok"' \
       && printf '%s' "$HIST_BODY" | grep -q '"t":\[[0-9]'; then
        ok "/udf/history serves D1 bars from tiles (NSE:RELIANCE, 90d)"
    elif printf '%s' "$HIST_BODY" | grep -q '"s":"no_data"'; then
        bad "/udf/history returns {s:\"no_data\"} for NSE:RELIANCE over 90 days" \
            "the widget draws a BLANK CHART with no message — indistinguishable from a delisted instrument. This is the tile-store outage this section exists to catch"
    else
        bad "/udf/history body: $(printf '%s' "$HIST_BODY" | head -c 160)" \
            "expected {\"s\":\"ok\",\"t\":[...]} — status was ${HIST_STATUS:-<none>}"
    fi

    # ── NO UDF ROUTE MAY ANSWER 501 WHILE TRAFFIC IS ROUTED HERE ─────────
    #
    # THE GENERAL FORM OF THE MONEY-1476 OUTAGE, and the check that would have
    # caught it without anyone reasoning about TradingView's call order.
    #
    # `MARKET_DATA_TILES` switches an ORIGIN, not an endpoint. So the blast
    # radius of flipping it is EVERY call the widget makes — but every guard
    # built for the cutover was scoped to the endpoint being migrated:
    # `udf-parity.ts` compares two `/udf/history` endpoints and nothing else,
    # and this script probed config, time and history. `/udf/symbols` sat at 501
    # the whole time, and it is the FIRST call the widget makes.
    #
    # A 501 from any route here means that route is unimplemented, which means
    # the cutover flag must not be on. Enumerated rather than reasoned about, so
    # the NEXT stub is caught by existing code.
    STUBBED=""
    for ROUTE in "/udf/config" "/udf/time" "/udf/symbols?symbol=NSE:RELIANCE" \
                 "/udf/search?query=RELIANCE" "/udf/marks?symbol=NSE:RELIANCE&from=0&to=1&resolution=1D"; do
        RS="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "${BASE}${ROUTE}" 2>/dev/null)"
        [ "$RS" = "501" ] && STUBBED="${STUBBED} ${ROUTE%%\?*}"
    done
    # `/udf/marks` is the ONE route allowed to be 501 today: C4 has not landed.
    # That is only acceptable because `/udf/config` on THIS origin now ships
    # `supports_marks: false`, so the widget never calls it. Whitelisting a 501
    # while ADVERTISING the capability would be the same "asserting the outage
    # as the contract" shape this sweep exists to end — see MONEY-1476.
    UNEXPECTED="$(printf '%s' "$STUBBED" | tr ' ' '\n' | grep -v '^$' | grep -v '^/udf/marks$' | tr '\n' ' ')"
    if [ -z "$UNEXPECTED" ]; then
        ok "no UDF route answers 501 except /udf/marks (C4, expected)"
    else
        bad "UDF routes still stubbed:${UNEXPECTED}" \
            "a 501 means that route is UNIMPLEMENTED — MARKET_DATA_TILES must be OFF until it is not. This is how every chart went blank on 2026-09-18 while /udf/history served correctly"
    fi

    # ── THE ENDPOINT THE WIDGET CALLS FIRST ──────────────────────────────
    #
    # THIS CHECK DID NOT EXIST, AND ITS ABSENCE COST A PROD OUTAGE.
    # `/udf/symbols` and `/udf/search` shipped as 501 stubs while
    # `/udf/history` was completed. On 2026-09-18 `MARKET_DATA_TILES` was set
    # true on prod and every chart went blank with "Symbol Error · invalid
    # symbol" — because TradingView calls `resolveSymbol` FIRST and requests no
    # bars until it succeeds. This suite passed 21/21 throughout, probing
    # /udf/config, /udf/time and /udf/history and never these two.
    #
    # A 501 is the specific shape to catch: it is what the stubs returned, and
    # it renders in the widget as an unexplained "invalid symbol".
    SYM_URL="${BASE}/udf/symbols?symbol=NSE:RELIANCE"
    SYM_STATUS="$(curl -sS -m 20 -o /tmp/mdsmoke-sym.$$ -w '%{http_code}' "$SYM_URL" 2>/dev/null)"
    SYM_BODY="$(cat /tmp/mdsmoke-sym.$$ 2>/dev/null)"; rm -f /tmp/mdsmoke-sym.$$
    if [ "$SYM_STATUS" = "501" ]; then
        bad "/udf/symbols -> 501 (not implemented)" \
            "the chart calls resolveSymbol FIRST and renders 'invalid symbol' — every chart on the platform is dead while /udf/history serves correctly"
    elif printf '%s' "$SYM_BODY" | grep -q '"ticker":"NSE:RELIANCE"'; then
        ok "/udf/symbols resolves NSE:RELIANCE"
    else
        bad "/udf/symbols body: $(printf '%s' "$SYM_BODY" | head -c 140)" \
            "expected a LibrarySymbolInfo carrying \"ticker\":\"NSE:RELIANCE\" — status ${SYM_STATUS:-<none>}"
    fi

    # `supported_resolutions` is what the widget builds its interval picker
    # from. An empty or absent list leaves a chart with no timeframes and no
    # error, which looks like a styling bug rather than a datafeed one.
    printf '%s' "$SYM_BODY" | grep -q '"supported_resolutions":\[' \
        && ok "/udf/symbols carries supported_resolutions" \
        || bad "/udf/symbols has no supported_resolutions" \
               "the widget renders no interval buttons and reports nothing"

    # A NON-EQUITY MUST BE REFUSED, NOT RESOLVED.
    #
    # `tile-build-d1` tiles `instrumentType: "EQUITY"` only, so an ETF or a bond
    # that RESOLVES charts blank for ever — `{s:"no_data"}` with no message,
    # which the user cannot tell from a delisted instrument. ~541 active ETFs
    # and 6,172 NSE DEBT rows are in that population. This is the DB-backed half
    # of the rule; the unit tests cover `isChartable` directly.
    ETF_BODY="$(curl -sS -m 20 "${BASE}/udf/symbols?symbol=NSE:NIFTYBEES" 2>/dev/null)"
    if printf '%s' "$ETF_BODY" | grep -q '"s":"error"'; then
        ok "/udf/symbols refuses a non-equity by name (NSE:NIFTYBEES)"
    else
        bad "/udf/symbols RESOLVED a non-equity: $(printf '%s' "$ETF_BODY" | head -c 90)" \
            "it has no tiles, so the chart blanks with no message — worse than a named refusal"
    fi

    # A regex metacharacter must not reach Mongo unescaped: `(` threw error
    # 51111 and the catch turned it into 200 [], so the box silently said
    # "no results".
    PAREN_BODY="$(curl -sS -m 20 "${BASE}/udf/search?query=%28" 2>/dev/null)"
    printf '%s' "$PAREN_BODY" | grep -qE '^\[' \
        && ok "/udf/search survives a regex metacharacter" \
        || bad "/udf/search on '(' returned: $(printf '%s' "$PAREN_BODY" | head -c 90)" \
               "an unescaped \$regex makes a typed bracket look like 'no results'"

    SRCH_BODY="$(curl -sS -m 20 "${BASE}/udf/search?query=RELIANCE&limit=5" 2>/dev/null)"
    if printf '%s' "$SRCH_BODY" | grep -q '"s":"error"'; then
        bad "/udf/search returns an error shape" \
            "the symbol search box is dead; it must return an ARRAY, empty at worst"
    elif printf '%s' "$SRCH_BODY" | grep -q '"full_name":"NSE:RELIANCE"'; then
        ok "/udf/search finds NSE:RELIANCE"
    else
        bad "/udf/search body: $(printf '%s' "$SRCH_BODY" | head -c 140)" \
            "expected an array containing NSE:RELIANCE"
    fi

    CONF_BODY="$(curl -sS -m 20 "${BASE}/udf/config" 2>/dev/null)"
    MISSING=""
    for field in supports_search supports_marks supported_resolutions exchanges; do
        printf '%s' "$CONF_BODY" | grep -q "\"${field}\"" || MISSING="${MISSING} ${field}"
    done
    [ -z "$MISSING" ] \
        && ok "/udf/config carries the fields the widget reads" \
        || bad "/udf/config is missing:${MISSING}" "a missing supported_resolutions makes every timeframe button inert with no console error"

    echo ""
    echo "── 6. health ──"
    LIVE_STATUS="$(status_of "$LIVE_H")"
    [ "$LIVE_STATUS" = "200" ] && ok "/health/live -> 200" || bad "/health/live -> ${LIVE_STATUS:-<none>}"

    READY_BODY="$(curl -sS -m 20 "${BASE}/health/ready" 2>/dev/null)"
    READY_STATUS="$(status_of "$(fetch_head "${BASE}/health/ready")")"
    case "$READY_STATUS" in
        200) ok "/health/ready -> 200 (Mongo + Redis reachable from the revision)" ;;
        503) skip "/health/ready -> 503 — a dependency is down, and it NAMES it" \
                  "$(printf '%s' "$READY_BODY" | head -c 200)" ;;
        *)   bad "/health/ready -> ${READY_STATUS:-<none>}" "expected 200, or 503 naming the dependency" ;;
    esac

    echo ""
fi

echo "── 7. the run.app origin must NOT be reachable from the internet ──"
# The other half of the run.invoker grant. `allUsers -> run.invoker` is what
# lets the LB through, and `ingress: internal-and-cloud-load-balancing` is the
# ONLY thing then keeping the origin off the internet. Grant the first without
# the second and the service is genuinely public, bypassing the CDN, the cert
# and any future WAF — with nothing in any log to say so.
RUN_URL="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud run services describe "$SERVICE" \
    --region="$REGION" --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" \
    --format='value(status.url)' 2>/dev/null)"
if [ -z "$RUN_URL" ]; then
    skip "could not read the run.app URL for ${SERVICE}" \
         "needs gcloud auth; this check is the ONLY one that proves ingress is restricted"
else
    RUN_STATUS="$(curl -sS -m 20 -o /dev/null -w '%{http_code}' "${RUN_URL}/udf/config" 2>/dev/null)"
    case "$RUN_STATUS" in
        403|404|000) ok "${RUN_URL} refuses direct traffic (${RUN_STATUS})" ;;
        200) bad "${RUN_URL} served 200 DIRECTLY" \
                 "ingress is not restricted — the origin is public and every request can bypass the CDN and the cert" ;;
        *)   skip "${RUN_URL} answered ${RUN_STATUS}" "expected 403/404; treat anything else as unverified" ;;
    esac
fi

echo ""
echo "── 8. APM spans are actually arriving (the SILENT one) ──"
# No HTTP response can reveal this. dd-trace patches ESM through a loader hook
# that must be registered before the process loads anything, and when the
# Dockerfile's `--import dd-trace/register.js` does not take effect the service
# starts, serves every request correctly, and emits NOTHING — with no error in
# any log. The estate already carries that fingerprint (MONEY-1380).
#
# Checks 1-6 above just generated real traffic, so spans MUST exist by now.
DD_API="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions access latest \
    --secret="DD_API_KEY_$(echo "$ENV" | tr 'a-z' 'A-Z')" \
    --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" 2>/dev/null)"
DD_APP="$(CLOUDSDK_ACTIVE_CONFIG_NAME=stockbook gcloud secrets versions access latest \
    --secret="DD_APP_KEY_$(echo "$ENV" | tr 'a-z' 'A-Z')" \
    --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" 2>/dev/null)"

if [ -z "$DD_API" ] || [ -z "$DD_APP" ]; then
    skip "could not read DD_API_KEY_/DD_APP_KEY_ for ${ENV}" \
         "needs gcloud auth; this is the ONLY check that proves instrumentation works at all"
elif [ "$REACHABLE" != "1" ]; then
    skip "no traffic was generated, so an empty span set would prove nothing" \
         "fix check 1 first"
else
    SPANS=0
    for attempt in 1 2 3; do
        SPANS="$(curl -sS -m 30 -X POST "https://api.${DD_SITE}/api/v2/spans/events/search" \
            -H "Content-Type: application/json" \
            -H "DD-API-KEY: ${DD_API}" -H "DD-APPLICATION-KEY: ${DD_APP}" \
            -d '{"data":{"attributes":{"filter":{"query":"service:usemoney-market-data","from":"now-30m","to":"now"},"page":{"limit":10}},"type":"search_request"}}' \
            2>/dev/null | grep -o '"span_id"' | wc -l | tr -d ' ')"
        [ "${SPANS:-0}" -gt 0 ] 2>/dev/null && break
        sleep 20   # ingestion lag: a span is not queryable the instant it is emitted
    done
    if [ "${SPANS:-0}" -gt 0 ] 2>/dev/null; then
        ok "APM has ${SPANS} span(s) for usemoney-market-data in the last 30m"
    else
        bad "ZERO spans for usemoney-market-data, despite the traffic above" \
            "the Dockerfile's \`--import dd-trace/register.js\` is not taking effect — the service serves correctly and instruments nothing"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# A4 / A5 — the gates. MONEY-1469 / MONEY-1470.
#
# Every failure here is an OPEN DOOR or a DEAD FEATURE, and both are silent:
#   - `/quotes` shipped once with no auth at all, accepting `market=US`, which
#     resolves to the live Tiingo socket keyspace. Tiingo Commercial is INTERNAL
#     USE ONLY, so that is a licence breach that answers 200.
#   - every intraday refusal is a 200 carrying `s:"error"` (the widget does not
#     parse a 401 body — the chart would spin), so a fully-refused intraday
#     endpoint looks exactly like a quiet one.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "── A4/A5 gates ───────────────────────────────────────────────────"

# The token is MINTED here from the same secret the service verifies with, so a
# mismatch between Vercel and Secret Manager shows up as a gate failure rather
# than as a mysteriously dead chart.
# THE PREFLIGHT MUST ACCEPT DATADOG RUM'S TRACING HEADERS — MONEY-1483.
#
# DELIBERATELY OUTSIDE THE A4/A5 BLOCK. It lived inside the `else` of the
# MARKET_DATA_TOKEN_SECRET read, so a gcloud session that could not fetch
# that secret — no auth, wrong account, a BASE_OVERRIDE against a local
# host — printed `skip "A4/A5 gates"` and never ran this at all. The one
# instrument written to catch a days-long, browser-level total outage must
# not be gated on an unrelated Secret Manager read. It needs NO token: a
# preflight is unauthenticated by definition.
#
# This is the check that would have caught a days-long, total outage.
# `CORS_ALLOW_HEADERS` was `Authorization,Content-Type`, while `apps/web`
# runs RUM with `allowedTracingUrls` matching *.usemoney.ai and
# `propagatorTypes: ["datadog"]` — so every browser fetch to this origin
# carries four `x-datadog-*` headers, gets preflighted, and is REFUSED. The
# whole service was unreachable from a browser, every route, both envs.
#
# NOTE WHAT IS ASSERTED. This endpoint answers 204 with the SAME static list
# whatever you ask for, so the STATUS proves nothing — an earlier manual
# probe asking for `authorization` "passed" precisely because that was the
# one header already allowed. Only MEMBERSHIP of the returned list is
# evidence, so that is what is checked.
PF_HDRS="$(curl -sS -m 20 -D- -o /dev/null -X OPTIONS \
    -H "Origin: https://usemoney.ai" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: x-datadog-origin" \
    "${BASE}/udf/config" 2>/dev/null \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="access-control-allow-headers"{print tolower($2)}')"
PF_MISSING=""
for h in x-datadog-origin x-datadog-trace-id x-datadog-parent-id x-datadog-sampling-priority; do
    case ",${PF_HDRS// /}," in
        *",$h,"*) ;;
        *) PF_MISSING="$PF_MISSING $h" ;;
    esac
done
if [ -z "$PF_MISSING" ]; then
    ok "CORS preflight accepts Datadog RUM's x-datadog-* headers"
else
    bad "CORS preflight REFUSES:${PF_MISSING}" \
        "RUM sends these from every page; the browser then cannot reach ANY route on this origin (allow-headers: ${PF_HDRS:-<none>})"
fi

MD_SECRET="$(gcloud secrets versions access latest \
    --secret="MARKET_DATA_TOKEN_SECRET_$(printf '%s' "$ENV" | tr 'a-z' 'A-Z')" \
    --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT" 2>/dev/null || true)"

mint_token() {
    # $1 = extra claims JSON fragment, e.g. '"us":true,'
    python3 - "$MD_SECRET" "$1" <<'PYEOF'
import base64, hashlib, hmac, json, sys, time
secret, extra = sys.argv[1], sys.argv[2]
b64 = lambda b: base64.urlsafe_b64encode(b).decode().rstrip("=")
now = int(time.time())
head = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
body = b64(("{" + extra + json.dumps({"sub": "smoke", "aud": "usemoney-market-data",
     "iat": now, "exp": now + 300})[1:]).encode())
sig = b64(hmac.new(secret.encode(), f"{head}.{body}".encode(), hashlib.sha256).digest())
print(f"{head}.{body}.{sig}")
PYEOF
}

status_only() { curl -sS -m 20 -o /dev/null -w '%{http_code}' "$@" 2>/dev/null; }

if [ -z "$MD_SECRET" ]; then
    skip "A4/A5 gates" \
         "could not read MARKET_DATA_TOKEN_SECRET_$(printf '%s' "$ENV" | tr 'a-z' 'A-Z') — run gcloud auth login"
else
    # 1. /quotes REFUSES an anonymous caller. It once did not.
    Q_ANON="$(status_only "${BASE}/quotes?symbols=TCS")"
    if [ "$Q_ANON" = "401" ]; then
        ok "/quotes refuses an anonymous caller (401)"
    else
        bad "/quotes answered ${Q_ANON} with no token — expected 401" \
            "this route reads rt:*:quote:* directly; unauthenticated it is an open quote feed"
    fi

    # 2. The US LICENCE is enforced, and is NOT the plan tier.
    TOK_IN="$(mint_token '')"
    Q_US="$(status_only -H "Authorization: Bearer ${TOK_IN}" "${BASE}/quotes?symbols=AAPL&market=US")"
    if [ "$Q_US" = "403" ]; then
        ok "/quotes refuses market=US without the licence claim (403)"
    else
        bad "/quotes answered ${Q_US} for market=US on a token with no \`us\` claim" \
            "Tiingo Commercial is INTERNAL USE ONLY — serving a US price to a user needs MONEY-1262"
    fi

    # 2b. /udf/symbols enforces the SAME US licence — MONEY-1478.
    #
    # The refusal moved from "US listing, by name" to the `us` claim, and this
    # is the probe that proves BOTH polarities against the real service. A unit
    # test cannot: a US listing needs a `us_instruments` row, and mocking it
    # would only assert the mock.
    #
    # ANONYMOUS FIRST, because `/udf/symbols` takes no token for India — so
    # "no Authorization header at all" is the shape that must be refused, and
    # it is the shape a CDN is most likely to have cached.
    S_ANON="$(curl -sS -m 20 "${BASE}/udf/symbols?symbol=AAPL%3ANASDAQ%3A1980-12-12" 2>/dev/null)"
    if printf '%s' "$S_ANON" | grep -q '"s":"error"'; then
        ok "/udf/symbols refuses a US listing anonymously"
    else
        bad "/udf/symbols resolved a US listing with NO token" \
            "Tiingo Commercial is INTERNAL USE ONLY — resolving it hands the widget a symbol it will then request bars for"
    fi

    # A token WITHOUT the claim must be refused exactly like an anonymous one:
    # holding *a* token is not holding the licence.
    S_NOCLAIM="$(curl -sS -m 20 -H "Authorization: Bearer ${TOK_IN}" \
        "${BASE}/udf/symbols?symbol=AAPL%3ANASDAQ%3A1980-12-12" 2>/dev/null)"
    if printf '%s' "$S_NOCLAIM" | grep -q '"s":"error"'; then
        ok "/udf/symbols refuses a US listing on a token with no \`us\` claim"
    else
        bad "/udf/symbols resolved a US listing for a token carrying no \`us\` claim" \
            "the claim is a LICENCE, stamped at mint time — never derived from a plan tier"
    fi

    # And the other polarity. A gate that refuses everything is not a gate, and
    # this is the half that proves the licensed lane is actually REACHABLE.
    TOK_US="$(mint_token '"us":true,')"
    S_US="$(curl -sS -m 20 -H "Authorization: Bearer ${TOK_US}" \
        "${BASE}/udf/symbols?symbol=AAPL%3ANASDAQ%3A1980-12-12" 2>/dev/null)"
    if printf '%s' "$S_US" | grep -q '"ticker":"AAPL:NASDAQ:1980-12-12"'; then
        ok "/udf/symbols resolves a US listing for a LICENSED caller"
    elif printf '%s' "$S_US" | grep -q '"s":"error"'; then
        bad "/udf/symbols refused a US listing to a caller holding the \`us\` claim" \
            "answer: $(printf '%s' "$S_US" | head -c 160)"
    else
        # The ticker MUST be the 3-part listing id. TradingView caches it and
        # requests every bar under it, and a 2-part ticker resolves as an INDIA
        # listing on a non-existent exchange — resolve-then-blank.
        bad "/udf/symbols resolved a US listing under the WRONG ticker" \
            "expected ticker AAPL:NASDAQ:1980-12-12, got: $(printf '%s' "$S_US" | head -c 160)"
    fi

    # 3. India quotes SUCCEED for a signed-in caller, so the gate is not simply
    #    refusing everything — a check that only ever sees refusals cannot tell
    #    a working gate from a broken route.
    Q_IN="$(status_only -H "Authorization: Bearer ${TOK_IN}" "${BASE}/quotes?symbols=RELIANCE&exchange=NSE")"
    if [ "$Q_IN" = "200" ]; then
        ok "/quotes serves India for a valid token (200)"
    elif [ "$Q_IN" = "503" ]; then
        bad "/quotes answered 503 — the quote store is unreachable" \
            "REDIS_URL is set on the service but the client could not be built"
    else
        bad "/quotes answered ${Q_IN} for a valid India request — expected 200"
    fi

    # 4. Intraday refuses ANONYMOUSLY as a 200 s:"error", never a 401.
    I_BODY="$(curl -sS -m 20 "${BASE}/udf/history?symbol=NSE:RELIANCE&resolution=5&from=1&to=2" 2>/dev/null)"
    I_CODE="$(status_only "${BASE}/udf/history?symbol=NSE:RELIANCE&resolution=5&from=1&to=2")"
    if [ "$I_CODE" = "200" ] && printf '%s' "$I_BODY" | grep -q '"s":"error"'; then
        ok "intraday refuses anonymously as 200 s:\"error\" (the widget cannot parse a 401)"
    else
        bad "intraday answered ${I_CODE} ${I_BODY}" \
            "a UDF refusal must be a 200 carrying s:\"error\", or the chart spins instead of reporting"
    fi

    # 5. DAILY bars stay PUBLIC — the whole point of gating per resolution.
    D_CODE="$(status_only "${BASE}/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1&to=2")"
    D_BODY="$(curl -sS -m 20 "${BASE}/udf/history?symbol=NSE:RELIANCE&resolution=1D&from=1&to=2" 2>/dev/null)"
    if [ "$D_CODE" = "200" ] && ! printf '%s' "$D_BODY" | grep -qi 'token\|plan'; then
        ok "daily bars still need no token"
    else
        bad "daily bars were refused for AUTH — ${D_BODY}" \
            "A2's public D1 path must not have been swept into A5's gate"
    fi

    # 6. X-Bar-Basis is EXPOSED to the browser. Without
    #    Access-Control-Expose-Headers the browser strips it cross-origin, the
    #    chart reads null, and null means "clear the badge" — byte-identical to
    #    correct daily behaviour, and perfect in local dev against same-origin.
    CORS_HEAD="$(curl -sS -m 20 -o /dev/null -D - -X OPTIONS \
        -H "Origin: https://usemoney.ai" \
        -H "Access-Control-Request-Method: GET" \
        "${BASE}/udf/history" 2>/dev/null | tr 'A-Z' 'a-z')"
    if printf '%s' "$CORS_HEAD" | grep -q "x-bar-basis"; then
        ok "X-Bar-Basis is in access-control-expose-headers"
    else
        bad "X-Bar-Basis is NOT exposed to the browser" \
            "the basis badge can never render in production; it works in local dev because that is same-origin"
    fi
fi

echo ""
echo "══════════════════════════════════════════════════════════════════"
printf 'passed %d · failed %d · skipped %d\n' "$PASS" "$FAIL" "$SKIP"

# A SKIP fails the run. "Could not measure" must never read as "verified".
if [ "$FAIL" -gt 0 ] || [ "$SKIP" -gt 0 ]; then
    exit 1
fi
echo "ALL CHECKS PASSED — ${ENV} is serving the UDF contract from the edge."
