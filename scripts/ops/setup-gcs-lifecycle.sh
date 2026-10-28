#!/usr/bin/env bash
#
# setup-gcs-lifecycle.sh — apply this repo's Object Lifecycle Management rules
# to `stockbook-content-{env}` (MONEY-979, generalized by MONEY-1309).
#
# The rules themselves live in `scripts/ops/gcs-lifecycle.json`, which carries
# the reasoning for each one. This file is the SAFE way to install them.
#
# ── THE HAZARD: A LIFECYCLE POLICY IS SET ON A BUCKET, NOT ON A PREFIX ────────
#
# `gcloud storage buckets update --lifecycle-file` REPLACES the bucket's entire
# policy. There is no add, no merge, no patch. `stockbook-content-{env}` is a
# shared bucket: it holds `feeds/` (the prod->QA exchange-feed mirror, 66,951
# objects), `candles/` (every cold price shard), learning content, uploaded
# documents and the RAG corpus. A naive apply of a two-rule file would DELETE
# every rule any of those ever acquires, and the failure is silent and slow —
# nothing errors, objects simply stop being tiered or stop being cleaned up, and
# the bill or the outage arrives weeks later.
#
# So: READ the live policy, MERGE, and write the union. A read that fails is
# FATAL. Building a policy from an assumed-empty baseline is exactly how the
# other rules get destroyed, and it is indistinguishable from success.
#
# ── MEASURED, 2026-08-29, AND IT CHANGES THE CODE ────────────────────────────
#
# `gcloud storage buckets describe gs://stockbook-content-prod` (SDK 554.0.0):
#
#   * With NO lifecycle policy — which is the state of BOTH buckets today — the
#     `--format=json` output OMITS the key entirely. Its keys are exactly:
#     creation_time, default_storage_class, generation, location, location_type,
#     metageneration, name, public_access_prevention, satisfies_pzs,
#     soft_delete_policy, storage_url, uniform_bucket_level_access, update_time.
#
#   * `--format="value(lifecycle)"` prints an EMPTY LINE. So does
#     `--format="value(lifecycle_config)"`. A `value()` projection cannot
#     distinguish "there is no policy" from "you asked for a field that does not
#     exist under that name" — both are the empty string, and a script that read
#     the policy that way would ALWAYS believe the baseline is empty and ALWAYS
#     clobber. That is a fail-open read of exactly the kind this repo keeps
#     paying for, so the read is `--format=json`, parsed, where an ABSENT key
#     and an EMPTY list are different values and a failed call is a parse error
#     rather than an empty string.
#
#   * `--lifecycle-file` takes `{"rule": [{"action": …, "condition": …}]}` —
#     the `rule` array at the TOP level, not wrapped in `{"lifecycle": …}` (that
#     is the JSON API's shape and gcloud rejects it).
#
# Because the live key name is a thing we could only observe in its ABSENT form,
# the parser accepts `lifecycle_config`, `lifecycle` or `lifecycleConfig`, and
# accepts either `{rule: [...]}` or a bare array. If a lifecycle-shaped key is
# present but does NOT normalise, it REFUSES rather than treating it as empty.
#
# ── WHAT COUNTS AS "OURS": AN EXPLICIT ALLOW-LIST — MONEY-1309 ───────────────
#
# A live rule is replaced by this script only when EVERY prefix in its
# `condition.matchesPrefix` starts with one of ALLOW_PREFIXES. Anything else —
# including a rule with no prefix at all — is carried through untouched. That
# makes a change to one of our rules (30 days -> 60) an UPDATE rather than a
# second rule, and makes it impossible for this script to remove a rule it did
# not write.
#
# The list was a single hard-coded `edgar/` for two releases. It is an explicit
# list now because a SECOND prefix moved in — `feeds/TIINGO/ws/`, the raw
# websocket ticks — and "generalize it when the second case arrives" is how a
# scope check turns into a scope GUESS. The list is declared once, below, and
# the same array drives the declared-rule check, the live-rule ownership split
# and the operator-facing banner.
#
# ── THE SECOND LOCK: A DELETE RULE MAY NEVER SHORTEN ─────────────────────────
#
# The allow-list is itself a line in a file somebody can edit, so it cannot be
# the only thing standing between us and a whole-prefix delete. The specific
# accident to fear is one deleted path segment:
#
#     "matchesPrefix": ["feeds/TIINGO/ws/"]   ->   ["feeds/"]
#
# That is `Delete @ age 30` over the ENTIRE prod->QA feed mirror (66,951 objects
# at the 2026-08-13 parity check) and, at the same age, every cold candle shard
# under a sibling prefix. It errors NOWHERE. GCS evaluates lifecycle
# asynchronously, so the diff is green, the apply is green, and a month later
# QA's replay starts missing objects — which is a SOFT failure by design
# (`getFeedAsset` re-fetches the exchange on a miss) and therefore silent.
#
# So PROTECTED_ROOTS is a second, independent refusal that does NOT consult the
# allow-list. Any Delete rule whose prefix would SWEEP a protected root is
# refused, where "sweep" is tested as `root.startsWith(prefix)` — the prefix is
# the root itself or SHORTER. That single test catches `feeds/`, `feeds`, `fe`
# and the empty string alike, and it needs no list of bad values.
#
# `edgar/filings/` is on that list for a reason the allow-list never covered: a
# rule with prefix `edgar/` is perfectly allow-listed, and would DELETE the
# permanent SEC filing archive that makes a mapping fix cost zero SEC requests.
#
# Usage:
#   ./scripts/ops/setup-gcs-lifecycle.sh prod --dry-run
#   ./scripts/ops/setup-gcs-lifecycle.sh prod
#   ./scripts/ops/setup-gcs-lifecycle.sh all
#
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'

PROJECT_ID="stock-book-483718"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="${HERE}/gcs-lifecycle.json"

# ── THE ALLOW-LIST — MONEY-1309 ──────────────────────────────────────────────
#
# Every prefix this script is permitted to own, in the policy file AND in the
# live bucket. A declared rule whose prefix is not under one of these is
# REFUSED; a live rule whose prefix is not under one of these is KEPT untouched.
#
# Ordinary indexed arrays, not `declare -A`: macOS ships bash 3.2, which has no
# associative arrays. They are handed to the node block as newline-separated
# strings, which is also why every entry must be a plain prefix with no newline
# in it.
#
#   edgar/            MONEY-979   the SEC filing archive (bulk zips + filings)
#   feeds/TIINGO/ws/  MONEY-1309  raw websocket ticks, JSONL by date
#
# ADDING ONE IS NOT A FORMALITY. `feeds/TIINGO/ws/` sits INSIDE a prefix that
# the prod->QA mirror copies wholesale, so it is only safe because it is (a)
# this specific, four-segment deep, and (b) excluded from that mirror by
# scripts/ops/sync-prod-to-qa.sh. Both halves are pinned by
# packages/core/__tests__/ops/tiingo-realtime-infra.test.ts.
ALLOW_PREFIXES=(
    "edgar/"
    "feeds/TIINGO/ws/"
    # MONEY-1373 — the Databento raw archive (the .csv.zst files a batch job
    # produces, plus their manifest/metadata/condition support files). It gets a
    # SetStorageClass rule and MUST NEVER get a Delete one: these bytes are the
    # only copy of data bought once inside a one-month subscription window, and
    # a re-derivation must never cost a second purchase. `databento/` is on
    # PROTECTED_ROOTS below for exactly that reason.
    "databento/"
)

# ── PROTECTED_ROOTS — the independent second lock ────────────────────────────
#
# A Delete rule whose prefix would SWEEP one of these is refused REGARDLESS of
# the allow-list. See the header for why this cannot be folded into the list
# above: it is the guard against the allow-list itself being widened.
#
#   feeds/            the prod->QA exchange-feed mirror QA replays
#   candles/          the cold price shards CandleRepository reads at request time
#   stocks/           the scraped-PDF prefix the reference sync mirrors
#   edgar/filings/    the permanent SEC archive; a `Delete @ edgar/` is
#                     allow-listed and would take it
#   databento/        MONEY-1373 — the raw vendor archive. It is allow-listed
#                     (it owns a Nearline transition), so nothing else would
#                     stop a Delete rule written against the same prefix — and
#                     that Delete would turn a re-load into a re-BUY of a
#                     $199 Standard month.
PROTECTED_ROOTS=(
    "feeds/"
    "candles/"
    "stocks/"
    "edgar/filings/"
    "databento/"
)

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
        echo "Merges the lifecycle rules in gcs-lifecycle.json into"
        echo "gs://stockbook-content-{env}. Rules outside the allow-list"
        echo "(${ALLOW_PREFIXES[*]}) are preserved untouched."
        exit 1
        ;;
esac

if [ ! -r "$POLICY_FILE" ]; then
    echo -e "${RED}FATAL: cannot read ${POLICY_FILE}${NC}" >&2
    exit 1
fi

bucket_for() { echo "stockbook-content-$1"; }

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  GCS lifecycle — allow-listed prefixes     ║"
echo "╠════════════════════════════════════════════╣"
echo "║  Project: ${PROJECT_ID}"
echo "║  Owns:    ${ALLOW_PREFIXES[*]}"
echo "║  Mode:    $([ "$DRY_RUN" = true ] && echo "DRY RUN (no writes)" || echo "APPLY")"
echo "╚════════════════════════════════════════════╝"
echo ""

APPLIED=0
UNCHANGED=0
declare -a FAILED=()

for ENV in "${ENVS[@]}"; do
    BUCKET="$(bucket_for "$ENV")"
    echo -e "${BLUE}━━━ gs://${BUCKET} ━━━${NC}"

    # ── 1. READ. Fails closed. ────────────────────────────────────────────────
    if ! LIVE_JSON="$("${GC[@]}" storage buckets describe "gs://${BUCKET}" --format=json 2>&1)"; then
        echo -e "   ${RED}FATAL: could not describe gs://${BUCKET}${NC}" >&2
        echo "   ${LIVE_JSON}" >&2
        echo "   Refusing to build a policy from an assumed-empty baseline: an" >&2
        echo "   apply on top of that guess DELETES every rule this bucket has" >&2
        echo "   for feeds/, candles/ and the learning content." >&2
        exit 1
    fi

    # ── 2. MERGE + REPORT, in node. ──────────────────────────────────────────
    #
    # node rather than jq: this is a Node monorepo, so node is the one
    # interpreter guaranteed to exist wherever this runs (the same reasoning
    # apply-monitors.sh records). It writes the merged policy to MERGED_FILE and
    # prints the before/after; exit 0 = write it, 2 = already current, 1 = refuse.
    # PORTABLE mktemp form. `mktemp -t edgar-lifecycle` is BSD/macOS only: GNU
    # coreutils reads -t's operand as a TEMPLATE and requires at least three
    # trailing X's, so it exits `too few X's in template` on Linux and Cloud
    # Shell. It fails SAFE — `set -e` aborts before any bucket write — but it
    # aborts a script whose whole job is to not clobber a shared bucket's
    # lifecycle, and the founder runs darwin so nothing here would have caught
    # it. An explicit template under $TMPDIR is accepted by both.
    MERGED_FILE="$(mktemp "${TMPDIR:-/tmp}/gcs-lifecycle.XXXXXX")"
    set +e
    # The two lists cross the shell/node boundary as NEWLINE-SEPARATED strings.
    # bash 3.2 has no associative arrays and no `${a[@]@Q}`, and a comma- or
    # space-joined list would break on the day a prefix contains one. A prefix
    # containing a newline is the one thing this cannot express, which is why
    # the node side asserts a floor on both lists rather than trusting the split.
    REPORT="$(
        LIVE_JSON="$LIVE_JSON" \
        POLICY_FILE="$POLICY_FILE" \
        BUCKET="$BUCKET" \
        MERGED_FILE="$MERGED_FILE" \
        ALLOW_PREFIXES_NL="$(printf '%s\n' "${ALLOW_PREFIXES[@]}")" \
        PROTECTED_ROOTS_NL="$(printf '%s\n' "${PROTECTED_ROOTS[@]}")" \
        node -e '
          const fs = require("node:fs");

          const fail = (msg) => { console.log(msg); process.exit(1); };

          let live;
          try {
            live = JSON.parse(process.env.LIVE_JSON);
          } catch (err) {
            fail("REFUSE: describe output was not JSON — " + err.message);
          }
          // Falsifiable: prove we read THIS bucket rather than an error blob
          // that happened to parse. Without this, any JSON at all reads as
          // "no rules" and the merge starts from a fabricated baseline.
          if (!live || live.name !== process.env.BUCKET) {
            fail(
              "REFUSE: describe JSON does not name " + process.env.BUCKET +
              " (got " + JSON.stringify(live && live.name) + ")",
            );
          }

          // The key we could only ever observe in its ABSENT form. Accept every
          // spelling gcloud might use; refuse a present-but-unrecognised shape
          // rather than reading it as empty.
          const LIFECYCLE_KEYS = ["lifecycle_config", "lifecycle", "lifecycleConfig"];
          const presentKey = LIFECYCLE_KEYS.find((k) => live[k] != null);
          let liveRules = [];
          if (presentKey !== undefined) {
            const raw = live[presentKey];
            if (Array.isArray(raw)) liveRules = raw;
            else if (raw && Array.isArray(raw.rule)) liveRules = raw.rule;
            else if (raw && Array.isArray(raw.rules)) liveRules = raw.rules;
            else {
              fail(
                "REFUSE: " + presentKey + " is present but not a rule list " +
                "(" + JSON.stringify(raw).slice(0, 200) + "). Treating it as " +
                "empty would DELETE it.",
              );
            }
          }

          // Strip `_`-prefixed documentation keys, recursively. The bucket API
          // rejects unknown fields, and the policy file carries its reasoning
          // inline (same convention as monitor-zero-write.json).
          const strip = (v) =>
            Array.isArray(v)
              ? v.map(strip)
              : v && typeof v === "object"
                ? Object.fromEntries(
                    Object.entries(v)
                      .filter(([k]) => !k.startsWith("_"))
                      .map(([k, x]) => [k, strip(x)]),
                  )
                : v;

          const declaredDoc = JSON.parse(fs.readFileSync(process.env.POLICY_FILE, "utf8"));
          if (!Array.isArray(declaredDoc.rule)) {
            fail("REFUSE: the policy file has no top-level `rule` array");
          }
          const declared = strip(declaredDoc).rule;
          if (declared.length === 0) {
            fail("REFUSE: the policy file declares zero rules");
          }

          // The two lists, as handed over by the shell. A FLOOR on each,
          // because both fail in a direction that looks like success: an empty
          // ALLOW list refuses every rule (loud, safe), but an empty PROTECTED
          // list silently removes the only guard against a Delete rule that
          // shortened onto a shared root. `feeds/` is asserted by name because
          // it is the specific root MONEY-1309 exists to protect — a floor of
          // "at least one" would be satisfied by a list holding only
          // `edgar/filings/`.
          const splitEnv = (name) =>
            String(process.env[name] || "")
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
          const ALLOW = splitEnv("ALLOW_PREFIXES_NL");
          const PROTECTED = splitEnv("PROTECTED_ROOTS_NL");
          if (ALLOW.length === 0) {
            fail("REFUSE: ALLOW_PREFIXES reached node empty — nothing could be owned");
          }
          if (!PROTECTED.includes("feeds/")) {
            fail(
              "REFUSE: PROTECTED_ROOTS reached node without \"feeds/\" (got " +
              JSON.stringify(PROTECTED) + "). That is the root the shorten-guard " +
              "exists for: without it, a Delete rule on `feeds/` would age out " +
              "the whole prod->QA mirror.",
            );
          }

          const prefixes = (r) => {
            const p = r && r.condition && r.condition.matchesPrefix;
            return Array.isArray(p) ? p : [];
          };
          // OWNED = every prefix on the rule is under an allow-listed prefix.
          // A rule with NO prefix is never owned, so it is neither accepted
          // from the policy file nor removed from the live bucket.
          const isOwned = (r) => {
            const p = prefixes(r);
            return (
              p.length > 0 &&
              p.every((x) => ALLOW.some((a) => String(x).startsWith(a)))
            );
          };

          // LOCK 1 — every declared rule must be inside the allow-list. A
          // Delete rule with no prefix empties the bucket, and this is the last
          // place that can say no before the write.
          const unscoped = declared.filter((r) => !isOwned(r));
          if (unscoped.length > 0) {
            fail(
              "REFUSE: " + unscoped.length + " declared rule(s) are not scoped " +
              "to an allow-listed prefix. Every rule needs " +
              "condition.matchesPrefix and every prefix must start with one " +
              "of [" + ALLOW.join(", ") + "]:\n  " +
              unscoped.map((r) => JSON.stringify(r)).join("\n  "),
            );
          }

          // LOCK 2 — INDEPENDENT of the allow-list. A destructive rule may not
          // reach a protected root, in EITHER direction.
          //
          // UPWARD (`root.startsWith(prefix)`) is the original test: true when
          // the prefix IS the root or is SHORTER than it, which is the
          // "somebody deleted a path segment" accident — `feeds/TIINGO/ws/` ->
          // `feeds/` -> `feeds` -> `fe` -> "" all trip it, with no list of bad
          // values to keep current.
          //
          // DOWNWARD (`prefix.startsWith(root)`) was MISSING, and it is the
          // more likely accident now that the allow-list has entries under
          // `feeds/`. Measured: `Delete @ feeds/TIINGO/` passed BOTH locks,
          // because "feeds/".startsWith("feeds/TIINGO/") is false. That prefix
          // is not tick-only — `feeds/TIINGO/` also holds the US instrument
          // master, corporate actions, news and the EOD archives, every one a
          // sibling of `ws/`. So a descendant of a protected root must be named
          // EXPLICITLY here, not merely allow-listed. The narrow rule we do
          // want is one line; a new one should cost a deliberate line too.
          //
          // SetStorageClass counts too, but ONLY to ARCHIVE — and that
          // distinction is the whole of it. LOCK 2 skipped the action entirely,
          // so `SetStorageClass -> ARCHIVE @ candles/` passed; sweeping ALL of
          // SetStorageClass in instead refused the NEARLINE tiering of
          // `edgar/filings/` that we deliberately ship.
          //
          // GCS classes are not a simple colder-is-worse ladder: all four serve
          // first bytes in milliseconds (this is not Glacier). What changes is
          // the MINIMUM STORAGE DURATION and the retrieval fee. NEARLINE on
          // write-once EDGAR bundles is the documented intent and costs
          // nothing to read. ARCHIVE bills a 365-DAY minimum even for an object
          // deleted tomorrow, on top of the highest retrieval fee — so pointing
          // it at a prefix that is read on a request path, such as `candles/`,
          // is a real and silent bill, discovered by users and by the invoice.
          const isDestructive = (a) => {
            const t = String((a && a.type) || "").toLowerCase();
            if (t === "delete") return true;
            return (
              t === "setstorageclass" &&
              String(a.storageClass || "").toUpperCase() === "ARCHIVE"
            );
          };
          const DESTRUCTIVE_ALLOWED_UNDER_PROTECTED = [
            // MONEY-1309 raw websocket ticks: a 30-day re-derivation window,
            // written by tiingo-realtime-{env}, deliberately not mirrored to QA.
            "feeds/TIINGO/ws/",
          ];
          const sweeps = [];
          for (const r of declared) {
            // Case-INSENSITIVE. The GCS API is expected to reject a lowercase
            // action type, but a guard that leans on validation it does not own
            // is not a guard — `{"type":"delete"}` slipped past the
            // exact-literal test.
            if (!isDestructive(r && r.action)) continue;
            const label = r.action.type === "SetStorageClass"
              ? "SetStorageClass -> " + r.action.storageClass
              : String(r.action.type);
            for (const p of prefixes(r)) {
              const prefix = String(p);
              for (const root of PROTECTED) {
                if (root.startsWith(prefix)) {
                  sweeps.push(
                    label + " prefix " + JSON.stringify(prefix) +
                    " would sweep the protected root " + JSON.stringify(root),
                  );
                } else if (
                  prefix.startsWith(root) &&
                  !DESTRUCTIVE_ALLOWED_UNDER_PROTECTED.some((a) => prefix === a)
                ) {
                  sweeps.push(
                    label + " prefix " + JSON.stringify(prefix) +
                    " is INSIDE the protected root " + JSON.stringify(root) +
                    " and is not in DESTRUCTIVE_ALLOWED_UNDER_PROTECTED. Add it there " +
                    "deliberately if that is really intended — being on the " +
                    "allow-list is not enough for a descendant of a protected root",
                  );
                }
              }
            }
          }
          if (sweeps.length > 0) {
            fail(
              "REFUSE: " + sweeps.length + " Delete rule prefix(es) reach a " +
              "protected root. A lifecycle Delete is asynchronous and silent — " +
              "nothing errors, the objects are simply gone 30 days later:\n  " +
              sweeps.join("\n  "),
            );
          }

          const kept = liveRules.filter((r) => !isOwned(r));
          const replaced = liveRules.filter(isOwned);
          const merged = [...kept, ...declared];

          const line = (r) => {
            const a = r.action || {};
            const c = r.condition || {};
            const what = a.type === "SetStorageClass"
              ? "SetStorageClass -> " + a.storageClass
              : String(a.type);
            const px = prefixes(r);
            return what + "  age=" + (c.age ?? "-") +
              "  prefix=" + (px.length ? px.join("|") : "(WHOLE BUCKET)");
          };

          // ORDER-INSENSITIVE. GCS does not order-guarantee the rule list it
          // returns, and a positional comparison would report "changed" on an
          // already-correct bucket and write on every run — which is harmless
          // in itself but makes "no write happened" useless as evidence.
          const canonical = (rules) =>
            JSON.stringify(rules.map((r) => JSON.stringify(strip(r))).sort());
          const same = canonical(liveRules) === canonical(merged);

          const out = [];
          out.push("   BEFORE (" + liveRules.length + " rule(s))" +
            (presentKey === undefined ? "  [no lifecycle key in describe output]" : ""));
          for (const r of liveRules) out.push("     - " + line(r));
          if (liveRules.length === 0) out.push("     (none)");
          out.push("   AFTER  (" + merged.length + " rule(s))");
          for (const r of merged) {
            const tag = kept.includes(r) ? "keep " : "owned";
            out.push("     " + tag + " " + line(r));
          }
          out.push(
            "   preserved=" + kept.length +
            "  replaced-owned=" + replaced.length +
            "  declared-owned=" + declared.length +
            "  allow=[" + ALLOW.join(",") + "]",
          );
          console.log(out.join("\n"));

          fs.writeFileSync(
            process.env.MERGED_FILE,
            JSON.stringify({ rule: merged }, null, 2) + "\n",
          );
          process.exit(same ? 2 : 0);
        '
    )"
    NODE_STATUS=$?
    set -e
    echo "$REPORT"

    case "$NODE_STATUS" in
        2)
            echo -e "   ${GREEN}already current — no write${NC}"
            UNCHANGED=$((UNCHANGED + 1))
            rm -f "$MERGED_FILE"
            continue
            ;;
        0) ;;
        *)
            echo -e "   ${RED}refusing to apply to gs://${BUCKET}${NC}" >&2
            rm -f "$MERGED_FILE"
            exit 1
            ;;
    esac

    # ── 3. WRITE. ────────────────────────────────────────────────────────────
    if [ "$DRY_RUN" = true ]; then
        echo -e "   ${YELLOW}[dry-run]${NC} gcloud storage buckets update gs://${BUCKET} --lifecycle-file=<merged>"
        echo "   merged policy:"
        sed 's/^/     /' "$MERGED_FILE"
        APPLIED=$((APPLIED + 1))
        rm -f "$MERGED_FILE"
        continue
    fi

    if "${GC[@]}" storage buckets update "gs://${BUCKET}" --lifecycle-file="$MERGED_FILE"; then
        echo -e "   ${GREEN}applied${NC}"
        APPLIED=$((APPLIED + 1))
    else
        echo -e "   ${RED}FAILED${NC} gs://${BUCKET}" >&2
        FAILED+=("$BUCKET")
    fi
    rm -f "$MERGED_FILE"
done

if ((${#FAILED[@]} > 0)); then
    echo >&2
    echo "${#FAILED[@]} bucket(s) did NOT apply:" >&2
    for f in "${FAILED[@]}"; do echo "  - $f" >&2; done
    exit 1
fi

# Count, not absence-of-error: a loop that ended early records no failure and
# would otherwise reach the success line.
if ((APPLIED + UNCHANGED != ${#ENVS[@]})); then
    echo "FATAL: ${APPLIED} applied + ${UNCHANGED} unchanged != ${#ENVS[@]} requested" >&2
    exit 1
fi

cat <<EOF

────────────────────────────────────────────────────────────────
${APPLIED} bucket(s) $([ "$DRY_RUN" = true ] && echo "would be updated" || echo "updated"), ${UNCHANGED} already current.

The rules and the reasoning for each are in
scripts/ops/gcs-lifecycle.json; the sizes the edgar/ ones exist for are in
docs/reference/edgar-engine.md §5.

Rules OUTSIDE the allow-list (${ALLOW_PREFIXES[*]}) were carried through
untouched — this script can only ever replace a rule it owns.

LIFECYCLE IS NOT IMMEDIATE. GCS evaluates rules asynchronously, roughly daily,
so an object past its age can survive for up to 24h after the policy lands.
"Nothing was deleted" an hour later is expected, not evidence the rule is wrong.

VERIFY:
  gcloud storage buckets describe gs://stockbook-content-prod \\
    --project=${PROJECT_ID} --account=founder@disdigital.in \\
    --format=json | node -e 'let s="";process.stdin.on("data",d=>s+=d)
      .on("end",()=>console.log(JSON.stringify(JSON.parse(s).lifecycle_config,null,2)))'
────────────────────────────────────────────────────────────────
EOF
