#!/usr/bin/env bash
#
# setup-market-data-lb.sh — serverless NEG + backend service + Cloud CDN for
# `usemoney-market-data`. IDEMPOTENT.
#
#   ./scripts/ops/setup-market-data-lb.sh {qa|prod} [--dry-run]
#
# ── CDN IS THE POINT, NOT AN OPTIMISATION ────────────────────────────────────
#
# Measured over 14 days before this service existed: `udf/config` and
# `udf/time` — which return CONSTANTS — cost p50 0.26 s through a Vercel
# function. The service sets explicit `Cache-Control` on every route precisely
# so the edge can answer instead of the origin. WITHOUT `--enable-cdn` on the
# backend service those headers are inert, every request is an origin hit, and
# the whole exercise nets one extra network hop. Nothing errors; the latency
# simply does not improve, which is the hardest kind of failure to notice.
#
# ── CACHE_ALL_STATIC IS WRONG HERE ───────────────────────────────────────────
#
# `--cache-mode=USE_ORIGIN_HEADERS` is deliberate. `CACHE_ALL_STATIC` caches by
# file extension and would cache NOTHING from this service (every path is
# extensionless) while looking configured. The service's own headers are the
# contract — including `no-store` on the 501 routes, which a mode that ignores
# origin headers would cache and then keep serving after A2 ships.
#
set -euo pipefail

PROJECT_ID="stock-book-483718"
REGION="asia-south1"
GCLOUD_ACCOUNT="${GCLOUD_ACCOUNT:-founder@disdigital.in}"

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
    qa)   ENV="qa";   HOST="market-data-qa.usemoney.ai" ;;
    prod) ENV="prod"; HOST="market-data.usemoney.ai" ;;
    *)
        cat >&2 <<'USAGE'
Usage: ./scripts/ops/setup-market-data-lb.sh {qa|prod} [--dry-run]

Creates, for one environment:
  a serverless NEG pointing at usemoney-market-data-{env} (asia-south1)
  a backend service with Cloud CDN ENABLED, cache-mode USE_ORIGIN_HEADERS
  a URL map + managed certificate + HTTPS proxy + forwarding rule

DNS is NOT created. Point the host at the printed IP yourself; a managed
certificate stays PROVISIONING until the A record resolves.
USAGE
        exit 1
        ;;
esac

run() { if [ "$DRY_RUN" = "1" ]; then echo "   DRY-RUN: $*"; else "$@"; fi; }
GC=(gcloud --project="$PROJECT_ID" --account="$GCLOUD_ACCOUNT")

SERVICE="usemoney-market-data-${ENV}"
NEG="market-data-neg-${ENV}"
BACKEND="market-data-backend-${ENV}"
URLMAP="market-data-urlmap-${ENV}"
CERT="market-data-cert-${ENV}"
PROXY="market-data-https-proxy-${ENV}"
RULE="market-data-fr-${ENV}"
IP_NAME="market-data-ip-${ENV}"

echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║  market-data LB — ${ENV} · ${HOST} · dry-run ${DRY_RUN}"
echo "╚══════════════════════════════════════════════════════════════════╝"

# The Cloud Run service must exist first: a NEG pointing at an absent service is
# created happily and serves 404s.
if ! "${GC[@]}" run services describe "$SERVICE" --region="$REGION" >/dev/null 2>&1; then
    echo "REFUSING: Cloud Run service ${SERVICE} does not exist." >&2
    echo "Deploy it first (apps/market-data/cloudbuild.${ENV}.yaml); a NEG pointing at" >&2
    echo "an absent service is created without error and serves 404s." >&2
    exit 1
fi

echo "── run.invoker (WITHOUT THIS THE CDN SERVES 403) ────────────────"
# An external ALB reaching Cloud Run through a serverless NEG sends NO identity
# token — the load balancer does not mint one. So Cloud Run applies its own IAM
# and refuses an anonymous request with 403 unless the service allows
# unauthenticated invocations. `gcloud run services replace` never touches the
# IAM policy, so the deploy cannot grant this and nothing else in this ladder
# did: every request through the CDN was 403, which reads like a certificate or
# a CDN fault rather than an IAM one.
#
# This is NOT a public service in the network sense, and the two controls are
# doing different jobs. `ingress: internal-and-cloud-load-balancing` is what
# makes the run.app URL unreachable from the internet — that is REACHABILITY.
# `allUsers -> run.invoker` is AUTHORISATION for the requests that do arrive,
# and they can only arrive through the load balancer. Dropping either one alone
# breaks the service; dropping both would expose it.
#
# Asserted on every run rather than only at create: an IAM binding removed in
# the console produces a 403 with nothing in this script's output to explain it.
run "${GC[@]}" run services add-iam-policy-binding "$SERVICE" \
    --region="$REGION" --member=allUsers --role=roles/run.invoker --quiet

echo "── serverless NEG ───────────────────────────────────────────────"
if "${GC[@]}" compute network-endpoint-groups describe "$NEG" --region="$REGION" >/dev/null 2>&1; then
    echo "   ${NEG} exists"
else
    run "${GC[@]}" compute network-endpoint-groups create "$NEG" \
        --region="$REGION" --network-endpoint-type=serverless \
        --cloud-run-service="$SERVICE"
fi

echo "── backend service (CDN ON) ─────────────────────────────────────"
if "${GC[@]}" compute backend-services describe "$BACKEND" --global >/dev/null 2>&1; then
    echo "   ${BACKEND} exists"
else
    run "${GC[@]}" compute backend-services create "$BACKEND" \
        --global --load-balancing-scheme=EXTERNAL_MANAGED \
        --enable-cdn --cache-mode=USE_ORIGIN_HEADERS
fi

# The BACKEND LIST is asserted separately from the backend service, because the
# create and the add-backend are two API calls and only the first one decides
# which branch the next run takes. If `create` succeeded and `add-backend` then
# failed — quota, a transient error, a Ctrl-C between them — every re-run took
# the `exists` branch, skipped the add, and still reported success. The result
# is a backend service with ZERO backends answering 502 for every request,
# from a script whose output was entirely green.
if [ -z "$("${GC[@]}" compute backend-services describe "$BACKEND" --global \
        --format='value(backends)' 2>/dev/null)" ]; then
    echo "   attaching ${NEG} (backend list was empty)"
    run "${GC[@]}" compute backend-services add-backend "$BACKEND" \
        --global --network-endpoint-group="$NEG" \
        --network-endpoint-group-region="$REGION"
else
    echo "   ${BACKEND} already has a backend attached"
fi
# Asserted on EVERY run, not only at create: CDN can be turned off in the
# console, and a backend serving every request from the origin looks identical
# to one serving from the edge except in the bill and the p95.
run "${GC[@]}" compute backend-services update "$BACKEND" \
    --global --enable-cdn --cache-mode=USE_ORIGIN_HEADERS

echo "── address, cert, url map, proxy, forwarding rule ───────────────"
if "${GC[@]}" compute addresses describe "$IP_NAME" --global >/dev/null 2>&1; then
    echo "   ${IP_NAME} exists"
else
    run "${GC[@]}" compute addresses create "$IP_NAME" --global
fi

if "${GC[@]}" compute url-maps describe "$URLMAP" >/dev/null 2>&1; then
    echo "   ${URLMAP} exists"
else
    run "${GC[@]}" compute url-maps create "$URLMAP" --default-service="$BACKEND"
fi

if "${GC[@]}" compute ssl-certificates describe "$CERT" --global >/dev/null 2>&1; then
    echo "   ${CERT} exists"
else
    run "${GC[@]}" compute ssl-certificates create "$CERT" --global --domains="$HOST"
fi

if "${GC[@]}" compute target-https-proxies describe "$PROXY" >/dev/null 2>&1; then
    echo "   ${PROXY} exists"
else
    run "${GC[@]}" compute target-https-proxies create "$PROXY" \
        --url-map="$URLMAP" --ssl-certificates="$CERT"
fi

if "${GC[@]}" compute forwarding-rules describe "$RULE" --global >/dev/null 2>&1; then
    echo "   ${RULE} exists"
else
    run "${GC[@]}" compute forwarding-rules create "$RULE" \
        --global --load-balancing-scheme=EXTERNAL_MANAGED \
        --address="$IP_NAME" --target-https-proxy="$PROXY" --ports=443
fi

echo ""
IP="$("${GC[@]}" compute addresses describe "$IP_NAME" --global --format='value(address)' 2>/dev/null || echo '<pending>')"
echo "── DNS is YOURS ─────────────────────────────────────────────────"
echo "   A   ${HOST}   ->   ${IP}"
echo ""
echo "The managed certificate stays PROVISIONING until that record resolves —"
echo "which presents as a TLS handshake failure, not as a certificate error."
echo ""
echo "── proof (the A1 acceptance) ────────────────────────────────────"
echo "   curl -I https://${HOST}/udf/config    # twice; the second shows age>0"
