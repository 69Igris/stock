#!/usr/bin/env bash
#
# Apply the zero-write monitors — MONEY-1220, repaired by MONEY-1238.
#
# One monitor per data-writing job.
#
# ## Idempotency — what this actually does now
#
# The header used to claim "monitors are matched by NAME, so a re-run updates
# rather than duplicating". Nothing in the script matched anything: there was
# one unconditional `POST /api/v1/monitor`, so the second run created a second
# set of eight monitors, the third a third, and each duplicate alerts
# independently. That claim was the only thing standing between this script and
# an operator running it twice.
#
# It is true now, and it is true because of code rather than assertion:
#
#   1. LIST the monitors tagged `managed-by:apply-monitors` (one request)
#   2. match this job's rendered NAME exactly, in that list
#   3. PUT /api/v1/monitor/{id} when found, POST /api/v1/monitor when not
#
# The `managed-by:apply-monitors` tag is written by the template and is what
# keeps step 1 from listing every monitor in the org.
#
# ## Failure is loud
#
# The old loop ran `curl -sS` with no `-f` and no status check, then piped the
# body into a parser. A 403 (wrong key), a 429 (rate limit) or a 400 (rejected
# query) printed its error body and the loop moved on; `set -euo pipefail` never
# saw a non-zero status because curl's own exit code is 0 for an HTTP error. The
# script exited 0 having applied nothing.
#
# Every request now checks the HTTP status explicitly (rather than `curl -f`,
# which would suppress the error body that says WHY), failures are accumulated,
# and the script exits non-zero listing every job that did not apply.
#
# ## Where the names come from
#
# The metric names and the API host are READ OUT of packages/datadog/src rather
# than retyped here. Both had already drifted:
#
#   * the query asked for `job.written`; metrics.ts prepends `METRIC_PREFIX`
#     ("stockbook."), so the series is `stockbook.job.written`
#   * the POST went to api.datadoghq.com (US1); DD_SITE was `us3.datadoghq.com` (us5 since MONEY-1229),
#     so the monitor was being created in an org that never receives the metric
#
# Needs DD_API_KEY and DD_APP_KEY (not for --dry-run). Both live in GCP Secret
# Manager (DD_API_KEY_PROD / DD_APP_KEY_PROD). This script does NOT read them
# itself — export them first, so a CI runner and a laptop take the same path and
# neither gets a credential it did not ask for.
#
#   ./scripts/ops/datadog/apply-monitors.sh prod
#   ./scripts/ops/datadog/apply-monitors.sh prod --dry-run
#   ./scripts/ops/datadog/apply-monitors.sh prod --only=verify
#
set -euo pipefail

ENV_ARG="${1:-}"
DRY_RUN=false
# MONEY-1379. `--only=verify` RENDERS every row and writes nothing, then asks
# Datadog what it actually holds under the managed tag. It is deliberately NOT
# `--dry-run`: a dry run has no credentials and never lists, and a comparison
# against a listing it did not make would be a claim with no evidence behind it.
# Verify needs the network precisely because the ORG is the half of the
# comparison that cannot be read out of this repo.
ONLY=""

# UNKNOWN ARGUMENTS ARE REJECTED, they do not fall through to a live run.
#
# This used to be `[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true`, which reads
# ONE position and tests it for ONE exact string. Everything else — `--dryrun`,
# `-n`, `--dry_run`, and `prod --json --dry-run` where the flag simply is not
# $2 — left DRY_RUN false and the script went on to LIST and then PUT/POST
# against Datadog for real. The operator typed a flag whose whole purpose is
# "change nothing" and got a write.
#
# It survived review while every monitor here was a query over counters, where
# the worst case was a re-applied monitor. MONEY-979 added a monitor that PAGES,
# which changes what a mistyped dry-run costs. Cheap to close, so closed.
for ARG in "${@:2}"; do
  case "$ARG" in
    --dry-run) DRY_RUN=true ;;
    --only=verify) ONLY=verify ;;
    *)
      echo "apply-monitors: unrecognised argument '${ARG}'" >&2
      echo "Usage: $0 {qa|prod} [--dry-run|--only=verify]" >&2
      exit 1
      ;;
  esac
done

# The CLI argument is an ENVIRONMENT, not a tag value. Mapping it here is the
# whole of MONEY-1238's fault (b): the workers tag their metrics with
# `env:${getDatadogEnv()}`, and workers/cloudbuild.prod.yaml sets
# DD_ENV=production — so `env:prod` matched nothing on prod, ever. QA matched by
# coincidence, which is why the mismatch survived review: the environment it was
# tested in was the one environment where it worked.
#
# Kept identical to `toDatadogEnv` in packages/datadog/src/constants.ts, and
# packages/datadog/__tests__/monitor-agreement.test.ts fails if the two ever
# disagree — it renders this script and compares against that function.
case "$ENV_ARG" in
  prod) DD_ENV_TAG="production" ;;
  qa) DD_ENV_TAG="qa" ;;
  *)
    echo "Usage: $0 {qa|prod} [--dry-run|--only=verify]" >&2
    exit 1
    ;;
esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# PROD-ONLY JOBS — do not create a QA monitor for a job QA never runs.
#
# `notify_no_data: true` means such a monitor sits in NO DATA from birth. That is
# finding #1(d) of MONEY-1238 verbatim, and it was already true of TWENTY of the
# monitors this script creates — every scrape-once-in-prod job in
# PROD_ONLY_JOBS. A monitor that has never once been green is a monitor somebody
# mutes, and muting it removes the only alert on the job that is actually broken.
#
# DERIVED from setup-scheduler.sh at run time rather than restated here. A second
# hand-maintained copy of "which jobs are prod-only" is precisely the drift this
# repo keeps paying for; the scheduler owns that fact.
#
# NOTE the two namespaces do not match: PROD_ONLY_JOBS holds SCHEDULER ENTRY
# names (`market-movers-sync-intraday`) while MONITORED_JOBS holds JOB IDS
# (`market-movers-sync`). An exact-match check between them silently answers
# "nothing is prod-only" — which is how this was missed. The mapping goes
# through the scheduler row's own topic field.
# ---------------------------------------------------------------------------
SCHEDULER_FILE="${HERE}/../setup-scheduler.sh"
if [[ ! -r "$SCHEDULER_FILE" ]]; then
  echo "FATAL: cannot read ${SCHEDULER_FILE} — the prod-only set is derived from it" >&2
  exit 1
fi
PROD_ONLY_SCHED="$(sed -n '/^PROD_ONLY_JOBS=(/,/^)/p' "$SCHEDULER_FILE" \
  | grep -oE '"[a-z0-9-]+"' | tr -d '"')"
# FALSIFIABLE CEILING, and not decoration: if this parse ever returns nothing,
# every job reads as "not prod-only" and the script silently goes back to
# creating twenty dead QA monitors — the failure looking exactly like success.
if [[ "$(wc -w <<< "$PROD_ONLY_SCHED")" -lt 10 ]]; then
  echo "FATAL: parsed $(wc -w <<< "$PROD_ONLY_SCHED") PROD_ONLY_JOBS entries from" >&2
  echo "       ${SCHEDULER_FILE} — expected at least 10. The format changed;" >&2
  echo "       fix the parse rather than letting it fail open." >&2
  exit 1
fi

# True when EVERY scheduler entry dispatching to this job id is prod-only.
# "Some entries prod-only" is not enough: `news-rss-sync` has a market-hours and
# an off-hours entry, and only one being restricted would still leave QA data.
job_is_prod_only() {
  local job="$1" sched sn any=0 all=1
  sched="$(grep -oE "\"[a-z0-9-]+\|[^|]*\|${job}\|" "$SCHEDULER_FILE" \
    | sed 's/^"//' | cut -d'|' -f1 | sort -u)"
  # No SCHEDULER_DEFS row. Two different situations, and they must not be one
  # answer — MONEY-1358.
  #
  # The EDGAR bulk triggers are created by `setup_edgar_bulk_job_schedulers`, a
  # FUNCTION, not by a row, so the grep above cannot see them at all. They ARE
  # in PROD_ONLY_JOBS, under trigger names that extend the job id
  # (`edgar-bulk-ftd-semimonthly`, `edgar-bulk-ftd-retry`). Without this
  # fallback those jobs read as not-prod-only and QA gets a monitor for a job it
  # runs DISARMED — `PARSE_APPLY="false"` there, so every run reports
  # `selected: N, written: 0` and the monitor pages nightly on QA.
  if [[ -z "$sched" ]]; then
    grep -qE "^${job}-" <<< "$PROD_ONLY_SCHED" && return 0
    # Genuinely no clock: the DELIBERATELY NOT MONITORED block below covers that
    # case, and nothing here should guess.
    return 1
  fi
  for sn in $sched; do
    any=1
    grep -qx "$sn" <<< "$PROD_ONLY_SCHED" || all=0
  done
  [[ "$any" == 1 && "$all" == 1 ]]
}
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
DD_SRC="$REPO_ROOT/packages/datadog/src"
TEMPLATE="$HERE/monitor-zero-write.json"
LATENCY_TEMPLATE="$HERE/monitor-latency-p95.json"

# ---------------------------------------------------------------------------
# THE THIRD TEMPLATE — job ABSENCE (MONEY-1293).
#
# A committed file beside the other two, since MONEY-1266/1293/1358. It was
# written to a temp file at run time while it was one monitor for one job, with
# a note to promote it the day a second job needed one. That day is here: four
# jobs use it now, and a template three other people have to read should not
# only exist inside a heredoc. Nothing about the rendering changed — it goes
# through the SAME `render()`, so it inherits the `_`-key strip, the
# unknown-placeholder throw, the unsubstituted-placeholder check and the
# threshold coercion.
#
# ## The question this asks, and why neither existing template can ask it
#
# On 2026-08-29 there were ZERO `news-sync` invocations for the whole day. The
# 08-28 03:30Z slot took a 503 and then four 409s (the pubsub-dedupe lease, held
# by the attempt that 503'd) and never succeeded; the next successful run was
# 08-30 05:30Z. Roughly 62 hours in which the job did not run.
#
# NOTHING FIRED, and could not have:
#
#   * The zero-write monitor's query is a clamped DIFFERENCE of two counters. A
#     job that never runs emits neither counter, so the difference has no points
#     — the query cannot evaluate, let alone exceed 0. Its own truth table has
#     no row for "there was no run"; every row starts from a run.
#   * Its `notify_no_data` backstop is real but three times too slow by
#     construction: `no_data_timeframe` is 3x the alert window, and news-sync's
#     window is 36h, so silence has to last 108h before Datadog calls it NO
#     DATA. A 62h outage sits comfortably inside that and passes in silence.
#
# So this is a genuinely different question — "did it RUN", not "did the run
# WRITE" — and it is asked of the `selected` counter alone.
#
# `default_zero()` is what makes it an ABSENCE check rather than a second
# no-data monitor: it renders a window with no points as a real 0, so the
# monitor EVALUATES on silence instead of going grey. `notify_no_data` is still
# true underneath it, covering the one case default_zero cannot — a tag
# combination that has never existed at all (a renamed job), where there is no
# series to fill.
#
# ## It also catches a second failure the zero-write monitor calls healthy
#
# `selected == 0` is the "genuinely idle" row of the zero-write truth table:
# 0 - 0 = 0, no alert. That is right for a job with nothing to do and wrong for
# this one, whose population is a standing 782-row set — MONEY-1215 spent months
# in exactly that state, running four times a day and selecting nothing, and the
# monitor built to catch MONEY-1215 still cannot see it. Summing `selected` over
# the window catches both "did not run" and "ran and selected nothing" with one
# threshold, and the message names both.
# ---------------------------------------------------------------------------
#
ABSENCE_TEMPLATE="$HERE/monitor-job-absence.json"
# MONEY-1399 — the SPARSE variant of the same template. Same name, same
# options, same threshold; the query counts SUBMISSIONS (`count_not_null`)
# instead of summing `selected`, so a checkpointed job that ran and honestly
# found nothing does not read as "did not run". Which of the two a row gets
# is the `kind` field, third in every ABSENCE_MONITORS row.
ABSENCE_SPARSE_TEMPLATE="$HERE/monitor-job-absence-sparse.json"

# ---------------------------------------------------------------------------
# THE FOURTH TEMPLATE — the Databento D1 tripwire (MONEY-1373).
#
# The other three ask questions ABOUT A JOB and take a `job:` tag and a window
# sized from a cron. This one asks nothing about a job: it watches an INVARIANT,
# `stockbook.databento.displaced_d1`, whose healthy reading is a permanent,
# literal ZERO. `DATABENTO_SCHEMAS` (the Zod enum the manifest is parsed
# against) has no `ohlcv-1d` member, so no manifest entry can name a daily
# schema and no harvest or append run can produce a daily bar. A non-zero value
# means a writer path reached the D1 series that no manifest can produce.
#
# So there is no threshold to pick, no baseline to learn and no cadence to size
# against — `> 0` is the entire condition and the window only decides how long
# one tripped run stays visible. It gets its own loop rather than a row in one
# of the three above because none of their templates can express a query with no
# `job:` filter and no `{{window}}`.
# ---------------------------------------------------------------------------
D1_TEMPLATE="$HERE/monitor-databento-d1.json"

# ---------------------------------------------------------------------------
# Read the emitted metric names and the API host out of the TypeScript that
# emits them. Deliberately not retyped: a literal here and a `prefix:` there are
# two spellings of one fact, and they HAD already disagreed.
#
# `node`, not `python3`/`jq`/`bc` — this is a Node monorepo, so node is the one
# interpreter guaranteed to exist wherever this script runs, including CI.
# ---------------------------------------------------------------------------
read -r SELECTED_METRIC WRITTEN_METRIC < <(
  DD_SRC="$DD_SRC" node -e '
    const fs = require("node:fs");
    const read = (f) => fs.readFileSync(`${process.env.DD_SRC}/${f}`, "utf8");
    const pick = (src, re, what) => {
      const m = re.exec(src);
      if (!m) {
        console.error(`apply-monitors: could not read ${what} out of packages/datadog/src`);
        process.exit(1);
      }
      return m[1];
    };
    const constants = read("constants.ts");
    const outcome = read("job-outcome.ts");
    const prefix = pick(constants, /METRIC_PREFIX\s*=\s*"([^"]+)"/, "METRIC_PREFIX");
    const selected = pick(outcome, /selected:\s*"([^"]+)"/, "JOB_METRICS.selected");
    const written = pick(outcome, /written:\s*"([^"]+)"/, "JOB_METRICS.written");
    console.log(`${prefix}${selected} ${prefix}${written}`);
  '
)

# A silently-empty name would render a monitor that watches nothing — the exact
# failure being fixed — so refuse rather than apply one.
if [[ -z "$SELECTED_METRIC" || -z "$WRITTEN_METRIC" ]]; then
  echo "apply-monitors: metric name extraction produced an empty value" >&2
  exit 1
fi

# The request plumbing, the renderer, the managed listing and the upsert live
# in lib-datadog.sh — one copy, shared with apply-service-monitors.sh
# (MONEY-1359). Every one of them carries a scar: curl exits 0 on a 403, an
# unreadable listing must abort rather than duplicate the whole set, and a
# `_`-prefixed key inside `options` is a 400. A second copy would drift.
source "$HERE/lib-datadog.sh"

# The site is the LIBRARY's fact, not this script's — it was derived here and
# in four sibling scripts, five spellings of one value that a 403 answers
# silently. `dd_resolve_api_host` sets DD_API_HOST and fails closed.
dd_resolve_api_host || exit 1

# QA monitoring is OFF by founder decision — see `dd_qa_monitoring_enabled` in
# lib-datadog.sh. Exits 0, not 1: this is a deliberate configured state, and a
# non-zero exit here would make the cutover runner look like it failed.
if [[ "$ENV_ARG" == "qa" ]] && ! dd_qa_monitoring_enabled; then
  echo "qa monitoring is disabled (DD_QA_MONITORING is not \"on\") — nothing applied."
  echo "Re-enable with: DD_QA_MONITORING=on $(basename "$0") qa"
  exit 0
fi
DD_BASE_URL="https://${DD_API_HOST}/api/v1/monitor"

if ! $DRY_RUN; then
  # `${ENV_ARG^^}` is a bash-4 expansion and macOS ships bash 3.2, where it
  # renders as "bad substitution" INSIDE the very message that is supposed to
  # name the secret to fetch. `tr` is POSIX and works on both.
  ENV_UPPER="$(printf %s "$ENV_ARG" | tr '[:lower:]' '[:upper:]')"
  : "${DD_API_KEY:?export DD_API_KEY first (GCP Secret Manager: DD_API_KEY_${ENV_UPPER})}"
  : "${DD_APP_KEY:?export DD_APP_KEY first (GCP Secret Manager: DD_APP_KEY_${ENV_UPPER})}"
fi

# The jobs this monitors, and the window each one's CADENCE justifies.
#
# The window must exceed the interval or the monitor alerts on every gap between
# runs. A weekly job with a 24h window is a pager that fires six days out of
# seven — the fastest way to get a real alert ignored.
#
# Every name here must be emitted by a `reportJobOutcome({ job: "…" })` call
# somewhere in workers/src/processors or scripts/jobs. That is not a convention:
# `notify_no_data` is true, so a monitor for a job that emits nothing sits in NO
# DATA from birth, and a monitor that has never been green is a monitor somebody
# mutes. Four of these eight were in exactly that state until MONEY-1238.
# packages/datadog/__tests__/job-outcome-coverage.test.ts fails on a name here
# with no emit site.
#
#   job                  window   cadence
# ── Latency monitors (MONEY-979) ─────────────────────────────────────────────
# `job|metric|threshold_seconds|window`. A different QUESTION from the list
# below — that one asks "was selected work written", this asks "how long did it
# take" — so it needs its own template, its own counters and its own accounting.
#
# 300s is MONEY-979's stated gate (filing -> stored under 5 minutes at p95), and
# the design's measured budget is ~90s: a one-minute Scheduler tick plus the
# walk and the parse. The alarm therefore fires on a REAL regression rather than
# on the design's own headroom. MONEY-1271 (always-on poller) and MONEY-1272
# (the SEC PDS push feed) lower the budget; lower the threshold WITH them, never
# ahead of them, or the monitor pages for a target that has not shipped.
#
# THIS LIST'S TEMPLATE SETS `notify_no_data: false`, which is the opposite of
# every monitor in the list below and is the ONE rule to carry when adding a
# row here. A latency series has a point only when the job did work — this one
# only when a NEW filing was claimed — so it is empty in two states we ship on
# purpose: the disarmed one (`EDGAR_DETECT` ships "off", so there are zero
# points until arming, while this script runs in the runbook's FIRST-DEPLOY
# block) and every weekend (SEC accepts filings on business days; Sat 00:00 ET
# -> Mon 06:00 ET is ~54h with no sample, and monitors evaluate on weekends).
# Absence is watched instead by the `edgar-detect` ZERO-WRITE row below, whose
# counters are emitted from a `finally` on all 1,440 daily runs in all weather.
# The full argument, including why `options.scheduling` was not used, is in
# monitor-latency-p95.json's `_notify_no_data_rationale`.
#
# The rule generalises: a monitor whose series is empty in a DOCUMENTED-NORMAL
# state must not notify on no-data. packages/core/__tests__/ops/
# edgar-monitor-and-scheduler.spawntest.ts fails if a template here does.
declare -a LATENCY_MONITORS=(
  "edgar-detect|stockbook.edgar.detect_latency_seconds|300|1h"
)

# ── Absence monitors (MONEY-1293) ────────────────────────────────────────────
# `job|window|max gap between runs`. THE THIRD QUESTION: the list above asks
# "was selected work written", the latency list asks "how long did it take",
# this asks "did it run at all".
#
# THE WINDOW IS SIZED FROM THE MAX GAP BETWEEN RUNS, and for news-sync that is
# NOT the nominal cadence. The cron is `0 9,11,13,15 * * *` — four runs a day,
# every day — so three of the gaps are 2h and the fourth, 15:00 -> 09:00, is
# EIGHTEEN HOURS. A 12h window would therefore go below threshold every single
# night between 15:00 and 09:00 IST and page on a perfectly healthy schedule.
# That is `bhavcopy-sync`'s 36h-on-a-`1-5`-cron (MONEY-1238) restated: a monitor
# that fires nightly in the configuration we ship is a monitor somebody mutes,
# and a muted monitor is no monitor on the week the job actually breaks.
#
# 24h is the smallest window that exceeds the real gap. It still detects the
# MONEY-1293 outage — ~62h of silence — inside a day, against the 108h the
# existing zero-write monitor's no-data backstop would have needed and did not
# reach.
#
# PREREQUISITE, and it is met: `processNewsSync` calls `reportJobOutcome`
# unconditionally at the end of the run, so an idle run emits `selected: 0`
# rather than emitting nothing — which is exactly the distinction this monitor
# reads. Note the counters it needs are the SAME ones the zero-write monitor
# uses; nothing new is emitted for this.
declare -a ABSENCE_MONITORS=(
  "news-sync|24h|standing|4x daily 09/11/13/15 IST; 15:00 -> 09:00 = 18h"
  # MONEY-1266 — candle-evict CANNOT use the zero-write template. It ships
  # DISARMED (`CANDLE_EVICT_APPLY="false"` in both specs) and a disarmed run
  # honestly reports `selected: N>0, written: 0`, because its dry-run rows land
  # in `keptNotArmed`. A zero-write row would therefore evaluate to 1 - 0 = 1
  # and PAGE EVERY NIGHT in the exact configuration we ship. Its real failure
  # mode is SILENCE: an evictor that stops firing does not error, it lets
  # `candles` grow until the hot window stops being a window.
  "candle-evict|36h|sparse|daily 15:00 IST, PROD_ONLY"
  # MONEY-1293 — the ticket proposed 2h from the nominal 15-minute cadence. The
  # MAX GAP is what sizes a window, and it is 7h15m: the market-hours cron is
  # `*/5 9-15 * * 1-5` and the off-hours one `*/15 0-8,16-23 * * *`, so SATURDAY
  # AND SUNDAY 09:00-15:59 are covered by NEITHER. A 2h window would page every
  # weekend on a perfectly healthy schedule.
  "news-rss-sync|12h|sparse|every 5 min mkt hrs + 15 min off-hrs; Sat/Sun 09-16 uncovered = 7h15m"
  # MONEY-1358 — every 2 minutes, ALL SEVEN DAYS, PROD_ONLY. The tightest window
  # in the set, because the cadence genuinely permits it.
  "tiingo-news-poll|2h|sparse|every 2 min, all days, PROD_ONLY"
  # MONEY-1373 — the Databento intraday append. TWO crons, `0 15 * * 2-6` and
  # `0 18 * * 2-6` (a late vendor publication is a real state, not a fault), so
  # the runs are Tue-Sat and the longest gap is SATURDAY 18:00 -> TUESDAY 15:00
  # = 69h. Five trading days spread over seven calendar days, which is why 7d
  # and not 3d: a window sized from the nominal daily cadence would go below
  # threshold every Sunday and Monday on a perfectly healthy schedule.
  #
  # SILENCE IS THE FAILURE MODE HERE. `databento-append` has no chain and no
  # second publisher: if its trigger stops, the intraday history simply stops
  # extending and nothing errors. Its zero-write monitor cannot see that — 96h
  # is past Datadog's 4320-minute no-data ceiling, so `window_limits` turns
  # `notify_no_data` OFF, which is the MONEY-1359 finding-10 hole this template
  # exists to fill.
  #
  # PREREQUISITE, and it is met: `main()` calls `reportJobOutcome` on every
  # exit, so an UP_TO_DATE run emits `selected: 0` rather than emitting nothing.
  # That is what this query reads. Note the SECOND cause this template's message
  # names is the normal state here rather than a fault — a whole window of
  # UP_TO_DATE runs sums `selected` to 0 — so the window has to be long enough
  # that a run which actually appended is inside it, which 7d over five trading
  # days is.
  "databento-append|7d|sparse|Tue-Sat 15:00 IST primary + 18:00 retry; 5 trading days = 7 calendar days, PROD_ONLY"
  #
  # ── MONEY-1359 finding 10: the jobs the no-data CEILING left uncovered ─────
  #
  # `window_limits` turns `notify_no_data` OFF for every zero-write row whose
  # window is >= 4320 minutes, because Datadog has no timeframe long enough to
  # be meaningful. That is forced and correct. What it left behind is not: for
  # those 21 jobs "stopped running entirely" became UNWATCHED, and this is the
  # only template that can see it — the zero-write query is a DIFFERENCE of two
  # counters, so a job that never ran emits neither operand and the threshold
  # cannot fire.
  #
  # TWO CONSTRAINTS SIZE A WINDOW HERE, and WHICH OF THEM APPLIES IS THE `kind`
  # FIELD (MONEY-1399, third in every row):
  #
  #  (1) THE MAX GAP BETWEEN RUNS, from the cron. Simulated, never guessed —
  #      packages/datadog/__tests__/monitor-agreement.test.ts expands each job's
  #      real cron over a week and fails a window that does not exceed the gap.
  #      EVERY row must clear this one.
  #
  #  (2) THE LONGEST LEGITIMATE STRETCH WITH `selected == 0`. STANDING ROWS
  #      ONLY. Their query is `sum(selected) < 1`, which cannot separate "did
  #      not run" from "ran and selected nothing" — and for a standing
  #      population that is the POINT, because a gate matching no rows IS the
  #      defect (news-sync: 782 rows selecting nothing for months, MONEY-1215).
  #      For an exchange-driven job the stretch is a HOLIDAY: `bhavcopy-sync`
  #      runs on every weekday cron and honestly reports `selected: 0` when the
  #      market was shut, and `market-movers-sync` does not run at all (its own
  #      zero-write comment records a Diwali cluster pushing its gap past 96h).
  #      Those five stay `standing` because their zero is BOUNDED by the closure
  #      — a PERMANENT zero there is a dead feed and must keep alarming.
  #
  #      SPARSE ROWS ARE EXEMPT FROM (2), and that is the whole point of the
  #      kind. Their query counts SUBMISSIONS (`count_not_null`) rather than
  #      work, so the value is irrelevant and only (1) sizes them. A job whose
  #      checkpoint or novelty gate means a caught-up run finds nothing —
  #      edgar-bulk-ftd, feed-parse, databento-append, resend-contact-sync,
  #      tiingo-news-poll, and the rest marked `sparse`
  #      — cannot satisfy (2) at any window Datadog will accept, because the
  #      legitimate stretch is unbounded by construction.
  #
  #      MEASURED, 2026-09-13: `etf-expense-enrichment`'s candidate query
  #      EXCLUDED every ETF that already carried an expenseRatio, so a drained
  #      queue reported 0 FOREVER — and that exemption ALSO hid the fact that
  #      the job could never write at all (`fetchKuveraMetadata` returns null
  #      unless MF_METADATA_PROVIDER === "kuvera"; both specs set "amfi"). A
  #      guaranteed no-op and a finished backlog produced the identical signal,
  #      which is why it ran every Sunday since MONEY-209 without anyone
  #      noticing. RETIRED in MONEY-1404; both of its rows are gone from the
  #      lists below and its scheduler is in OLD_SCHEDULER_PREFIXES. Kept in
  #      this note because the LESSON is about the sparse exemption, not about
  #      that job: a `sparse` row cannot distinguish "caught up" from "broken",
  #      so it must be spent only where the job's health is established some
  #      other way. And `edgar-bulk-ftd`'s 16d sat under SEC's
  #      ~15-day (reaching ~24-day) publication stretch, so that monitor was
  #      created 2026-09-06, alerted 11 seconds later, and had never once been
  #      OK while `us_cusip_map.SEC_FTD` filled correctly underneath it.
  #
  # So these windows are NOT copies of the zero-write windows, and deliberately:
  # 8d clears a four-day exchange closure on top of the Fri->Mon gap, and 16d
  # clears two whole cycles of a weekly job. That trades sensitivity for silence
  # on purpose — detection in 8-16 days against the NOTHING these jobs have
  # today, and a monitor that cannot fire on a healthy schedule is the only kind
  # that survives to fire on a broken one (MONEY-1238).
  #
  # Every window is also <= 30 days, or Datadog refuses the query outright.
  #
  # -- weekday market jobs: 72h Fri->Mon gap, plus a holiday cluster --
  "xbrl-ratios|8d|standing|weekdays 22:00; gap 72h + exchange holidays"
  "bhavcopy-sync|8d|standing|weekdays 21:00; gap 72h + exchange holidays"
  "feed-parse|8d|sparse|weekdays 22:35; gap 72h + exchange holidays"
  "surveillance-sync|8d|standing|weekdays 20:15; gap 72h + exchange holidays"
  "institutional-flow-sync|8d|standing|weekdays 20:30; gap 72h + exchange holidays"
  "report-archive-sync|8d|sparse|weekdays 19:30+21:45, Sat 20:00; gap 47h30m + holidays"
  "bse-announcements-sync|8d|standing|weekdays 21:30; gap 72h + exchange holidays"
  "nse-announcements-sync|8d|standing|weekdays 21:15; gap 72h + exchange holidays"
  "market-movers-sync|8d|standing|every 3 min 09-16 weekdays; gap 64h + skips holidays"
  "price-sync|8d|standing|weekdays 23:00/23:15; gap 71h45m + exchange holidays"
  "price-backfill|8d|sparse|weekdays 23:15; gap 72h + exchange holidays"
  "intraday-sync|8d|standing|weekdays 16:05; gap 72h + exchange holidays"
  "us-eod-sync|8d|standing|Tue-Sat 11:00; gap 72h + US market holidays"
  "us-instrument-master-sync|8d|standing|Tue-Sat 10:00; gap 72h + US market holidays"
  # MONEY-1403. `mf-sync` is the PRIMARY MF NAV feed — ~14,300 schemes upserted
  # every night — and it had no monitor of any kind. AMFI moved two columns on
  # 2026-08-19, the positional parser skipped every row, and it wrote nothing
  # for 26 nights while answering 200 in ~150 ms. `standing` because AMFI
  # publishes daily including weekends: there is no calendar on which a zero is
  # legitimate.
  "mf-sync|36h|standing|daily 22:30; gap 24h, no weekend or holiday exemption"
  # -- weekly jobs: 168h gap, so 16d is two whole cycles --
  "mf-metadata-sync|16d|standing|weekly Sun 21:00; gap 168h"
  "index-constituent-sync|16d|standing|weekly Sun 03:00; gap 168h"
  "resend-contact-sync|16d|sparse|weekly Sun 01:00; gap 168h"
  # -- twice-weekly --
  "macro-sync|12d|standing|Sat + Tue 08:00; gap 96h"
  # `edgar-bulk-ftd` has NO SCHEDULER_DEFS row — its four triggers are created
  # by `setup_edgar_bulk_job_schedulers`, a FUNCTION — so the cron simulation
  # cannot size it and the test carries it in an explicit not-simulable list
  # rather than passing on a number it never computed. The crons are
  # `0 19 3,18 * *` and `0 19 10,25 * *`: the longest gap is the 25th -> the 3rd
  # = 9 days, so 16d is under Datadog's 30-day ceiling with a whole cycle of
  # room.
  "edgar-bulk-ftd|16d|sparse|3rd/10th/18th/25th 19:00 IST; longest gap 9d"
  #
  # ── MONEY-1479 — the two D1 tile builders ───────────────────────────────────
  #
  # AN ABSENCE ROW IS THE ONLY MONITOR THAT CAN SEE WHAT HAPPENED TO THESE, and
  # that is the whole lesson of the ticket rather than a preference.
  # `tile-build-d1-us` was OOM-killed nightly for weeks. A SIGKILL runs none of
  # our code: `zeroWriteRefusal` never evaluates, `reportJobOutcome` is never
  # called and `flushMetrics` never posts, so the job contributes NO POINT at
  # all. Every in-process guard the job carries is downstream of surviving, and
  # silence is the only symptom a kill leaves behind. Neither job had a row in
  # ANY list in this file — the gap was total, not partial.
  #
  # `standing`, not `sparse`. The population is ~14,258 US and ~9,278 India
  # listings on every run; `selected` is `built + skipped + failed` and is in
  # the thousands per shard on any healthy night (measured 2026-09-22:
  # 3,492 / 3,512 / 3,597 / 3,669 across the four US tasks). There is no
  # checkpoint and no novelty gate, so a zero IS the defect — the selector
  # drifting to nothing is exactly what `zeroWriteRefusal`'s `population === 0`
  # branch refuses one layer down, and this is its out-of-process twin.
  #
  # FOUR SHARDS EMIT FOUR POINTS PER RUN and the query SUMS them, so the
  # threshold is unaffected by `--tasks` moving. A single shard falling silent
  # does not trip this — correctly: that is the zero-write/latency question,
  # not the absence one.
  #
  # 8d, the same number and the same arithmetic as `bhavcopy-sync` and
  # `us-eod-sync` above, whose producers these two follow by 45 minutes.
  #
  # NEITHER JOB MAY HAVE A ZERO-WRITE ROW, and this is not caution — that
  # monitor would PAGE ON A MARKET HOLIDAY. `written` is `counters.built`, and
  # a session with no new bars advances no `source_max_date`, so
  # `rebuildReason` returns null for every listing, everything is SKIPPED and
  # the run honestly reports `selected: 3492, written: 0`. The clamped
  # difference is 1 - 0 = 1 and it alerts. That is ~9 US market holidays a year
  # for the US job and the whole NSE holiday calendar for the India one, on
  # perfectly healthy runs — which is how a real alert gets muted. Identical
  # reasoning to `candle-evict` above; the counters mean different things, the
  # disqualification is the same.
  "tile-build-d1-in|8d|standing|weekdays 21:45; gap 72h + exchange holidays"
  "tile-build-d1-us|8d|standing|Tue-Sat 11:45; gap 72h + US market holidays"
  #
  # `mf-portfolio-sync` IS THE ONE JOB THAT CANNOT HAVE A ROW HERE, and it is
  # named rather than quietly skipped. Its crons are `30 8 12 * *` and
  # `30 8 20 * *` — DAY-OF-MONTH, which the week-long simulation cannot read at
  # all (it sees dow `*` and answers 24h, which is wrong by a factor of ~23).
  # The real gap is the 20th -> the 12th of the next month = up to 23 days, and
  # WITHOUT the retry entry it is a full month, up to 744h. Datadog's query
  # window maxes at 720h in either unit, so a window that exceeds the gap either
  # does not exist or sits in a band whose whole width depends on the retry
  # trigger continuing to exist. There is no honest number, so there is no row;
  # its zero-write monitor still covers "found work and wrote nothing".
)

# ── The Databento D1 tripwire (MONEY-1373) ───────────────────────────────────
# `gate_job|note`. NOT `job|window|cadence` like the three lists around it, and
# the missing fields are the point rather than an omission:
#
#   NO WINDOW.  monitor-databento-d1.json hard-codes `sum(last_1d)`. The window
#               is not sized against a cron here — the query is a boolean over a
#               counter that must never move — so a window column would be a
#               number nobody derived from anything.
#   NO JOB in the QUERY. BOTH `databento-harvest` and `databento-append` emit
#               this counter, and the invariant is a property of the DATA rather
#               than of either job. Filtering to one would leave the other's
#               breach unwatched.
#
# The field that IS here is the job the PROD-ONLY GATE is asked about, which is
# a different question from what the query filters on. `databento-append` is the
# scheduled emitter and both its triggers (`databento-append-daily`,
# `databento-append-retry`) are in PROD_ONLY_JOBS, so QA creates nothing — QA
# receives `candles` and `databento_batch_jobs` by copy and must never spend
# against the vendor, which means a QA D1 series can only ever be empty.
# (`databento-harvest` has no trigger at all: it is a one-time buy run by hand.)
declare -a D1_MONITORS=(
  "databento-append|invariant tripwire; sum(last_1d) > 0, healthy reading is 0"
)

declare -a MONITORED_JOBS=(
  "xbrl-projection|36h|daily 23:45"
  # MONEY-1358 — 96h, not 36h. `0 22 * * 1-5` gaps Fri 22:00 -> Mon 22:00 = 72h,
  # so a 36h window sat in NO DATA every weekend since this row was added. Found
  # by the window-vs-cadence check this ticket extended to the zero-write list:
  # the rule was argued in prose here, applied by hand, and got a third job
  # wrong (after bhavcopy-sync and feed-parse) because nothing enforced it.
  "xbrl-ratios|96h|weekdays 22:00; Fri -> Mon = 72h"
  "xbrl-sync|36h|daily 23:15"
  "mf-metadata-sync|8d|weekly Sun 21:00"
  "news-sync|36h|daily"
  "events-sync|36h|daily"
  "bhavcopy-sync|96h|weekdays 21:00"
  # MONEY-1358 — 96h, not 36h. The cron is `35 22 * * 1-5`, so Fri -> Mon is
  # 72h and a 36h window sits in NO DATA every weekend. That is `bhavcopy-sync`'s
  # mistake exactly, in the same file that corrected it.
  "feed-parse|96h|weekdays 22:35; Fri -> Mon = 72h"
  # ── added by MONEY-1238 Group C ──
  #
  # WINDOW > CADENCE, and for a WEEKDAY-ONLY job the real gap is Fri->Mon = 72h,
  # not 24h. `bhavcopy-sync` was shipped at 36h on a `1-5` schedule, so it went
  # NO DATA every Saturday and Sunday — with `notify_no_data: true` that is a
  # pager firing two days in seven, which is how a real alert gets muted. It is
  # corrected to 96h above rather than left as the precedent for these.
  "circulars-sync|36h|daily 18:30"
  "ipo-sync|36h|daily 09:00"
  "annual-reports-sync|36h|daily 09:30"
  "mf-nav-backfill|36h|daily 23:30"
  "mf-sync|36h|daily 22:30"
  "surveillance-sync|96h|weekdays 20:15"
  "institutional-flow-sync|96h|weekdays 20:30"
  "report-archive-sync|96h|weekdays 19:30"
  "bse-announcements-sync|96h|weekdays 21:30"
  "nse-announcements-sync|96h|weekdays 21:15"
  "macro-sync|8d|weekly Sat 08:00"
  "index-constituent-sync|8d|weekly Sun 03:00"
  "mf-portfolio-sync|32d|monthly 12th 08:30"
  # ── added by MONEY-1250: the former WRONG_SIGNAL jobs ──
  #
  # These nine jobs (ten ids — price-sync splits) were held back from this list
  # because their `selected` counted the population they SCANNED, which is
  # non-zero on a healthy quiet run. Wiring them then would have paged on every
  # correct night: `alert-evaluator` alone runs ~624 times a day and fires no
  # alert on almost all of them. MONEY-1250 changed `selected` to mean WORK OWED
  # A WRITE — conditions met, posts past their publish date, rows on legs whose
  # snapshot advanced — so it is now zero exactly when the job had nothing to do,
  # and the standard query works unchanged.
  #
  # WINDOWS ARE SIZED FROM THE MEASURED MAX GAP BETWEEN RUNS, read off
  # setup-scheduler.sh, not from the nominal cadence. Two traps in doing that:
  #
  #  (a) A job with a market-hours cron AND an off-hours cron is not "always
  #      running". `alert-evaluator` is `* 9-15 * * 1-5` plus
  #      `*/5 0-8,16-23 * * *`: the second runs EVERY day but only covers hours
  #      0-8 and 16-23, so SATURDAY 09:00-15:59 is covered by neither. The real
  #      gap is Sat 08:55 -> Sat 16:00 = 7h05m, not five minutes. Same shape for
  #      `news-rss-sync` (7h15m).
  #
  #  (b) A weekday-only job's gap is Fri -> Mon, which is the mistake
  #      `bhavcopy-sync` shipped with (36h on a `1-5` schedule = NO DATA every
  #      weekend). All four weekday jobs below take 96h, matching that fix.
  #
  # `market-movers-sync` is the one with a caveat worth writing down:
  # `shouldPollMovers` skips HOLIDAYS outright, so a Diwali cluster can push the
  # gap past 96h. That is safe rather than noisy — an empty window makes the
  # query 0-0=0, and no-data is 3x the window (288h = 12 days), comfortably
  # beyond any Indian holiday run.
  #
  #        job                    window   max gap between runs
  "newsletter-publish|1h|every 5 min, all days"
  "alert-evaluator|12h|every 1 min mkt hours + 5 min off-hours; Sat/Sun 09-16 uncovered = 7h05m"
  "news-rss-sync|12h|every 5 min mkt hours + 15 min off-hours; Sat/Sun 09-16 uncovered = 7h15m"
  "market-movers-sync|96h|every 3 min 09-16 weekdays; Fri 16:57 -> Mon 09:00 = 64h"
  "price-sync|96h|weekdays 23:00; Fri -> Mon = 72h"
  "price-backfill|96h|weekdays 23:15; Fri -> Mon = 72h"
  "intraday-sync|96h|weekdays 16:05; Fri -> Mon = 72h"
  # -- added by MONEY-980: the US price backbone --
  #
  # 96h, and the arithmetic is the point rather than caution. The cron is
  # `0 11 * * 2-6` (Tue-Sat IST) because a US session on day D closes at 02:30
  # IST on D+1, so the IST weekdays that follow a US trading day are Tue..Sat.
  # (This comment read `0 7 * * 2-6` until MONEY-1264: the job moved to 11:00
  # IST so leg (b) clears the fund-NAV publication boundary — 00:00 ET, LATER
  # than the 20:00 ET equity-correction window — and the stale hour was left
  # behind. The DAY field, which is what sizes the window, never changed.)
  # That leaves a SATURDAY 11:00 -> TUESDAY 11:00 gap of 72h — longer than the
  # Fri->Mon gap every other weekday job here has, one timezone further out.
  #
  # A 36h window on this schedule would sit in NO DATA from Sunday morning to
  # Tuesday morning, every single week. With `notify_no_data: true` that is a
  # pager firing two days in seven, which is exactly how `bhavcopy-sync`'s
  # 36h-on-a-`1-5`-cron got itself muted (MONEY-1238) — and a muted monitor is
  # the same as no monitor on the week the job actually breaks.
  #
  # PREREQUISITE, and it is met: `processUsEodSync` calls `reportJobOutcome`
  # from a `finally`, so a run that selects nothing still emits 0/0 rather than
  # emitting nothing. An idle run reads as 0-0=0 through the clamped-difference
  # query — healthy — while a run that found work and wrote nothing reads as
  # 1-0=1. `judgeUsEodHealth` fills `skippedReason` PER LEG, so a NAV leg that
  # 403s while the EOD leg writes 70,000 bars is still named: a total hides a
  # dead leg, which is the MONEY-1255 lesson this job has four of.
  "us-eod-sync|96h|Tue-Sat 11:00"
  "us-instrument-master-sync|96h|Tue-Sat 10:00"
  # MONEY-980 — `candle-evict` is DELIBERATELY ABSENT from this list, and the
  # reason is a property of this script rather than of the job.
  #
  # Every monitor here is built from ONE template, `monitor-zero-write.json`,
  # whose query is `clamp_max(selected,1) - clamp_max(written,1) > 0` — a
  # VOLUME check: "it selected work and wrote nothing". The evictor ships
  # DISARMED (`CANDLE_EVICT_APPLY="false"` in both cloudbuild specs), and a
  # disarmed run honestly reports `selected: N>0, written: 0` because its
  # dry-run rows land in `keptNotArmed`. So an entry here would evaluate to
  # 1 - 0 = 1 and PAGE EVERY NIGHT in the exact configuration we ship.
  #
  # A monitor that fires nightly in its shipped state is worse than none: it
  # trains people to ignore the channel that every other job on this list
  # depends on. One was added and removed in the same change once that was
  # measured.
  #
  # What this job actually needs is a FRESHNESS monitor — "it has not run in
  # 36h" — because its failure mode is silence, not noise: an evictor that
  # stops firing does not error, it just lets Mongo grow until the hot window
  # stops being a window. That is a second template this script does not have,
  # and adding one is its own change with its own blast radius across the 12
  # monitors already here. Until then the gap is written down rather than
  # papered over with an alarm that says the wrong thing.
  "investor-rollup|36h|daily 03:00"
  "intent-learning|36h|daily 03:00"
  "resend-contact-sync|8d|weekly Sun 01:00"
  # -- added by MONEY-1255: the block below claimed this job had no clock --
  #
  # It read: stock-document-extract  CHAINED, not scheduled: published by
  # annual-reports-sync / stock-document-sync only when there is work.
  #
  # That is FALSE, and falsifiably so. setup-scheduler.sh has carried the entry
  # stock-document-extract-daily on cron 0 22 * * * since MONEY-783, on BOTH
  # envs (it is not in PROD_ONLY_JOBS). The job is chained AS WELL AS scheduled,
  # and the comment read the first half as the whole.
  #
  # The cost was the one this file exists to prevent: the daily job that feeds
  # the entire RAG corpus had no freshness monitor, so it could have stopped
  # running and nothing would have paged. It was in fact half-dead the whole
  # time - draining newest-first at 50/day against a 34,790-PDF queue.
  #
  # 36h, not 24h: the window must exceed the cadence, and a daily job can gap by
  # 24h. Same rule that corrected bhavcopy-sync to 96h.
  #
  # PREREQUISITE, and not optional: the processor used to call reportJobOutcome
  # BELOW an early return taken whenever the queue was empty, so an idle night
  # emitted NOTHING. With notify_no_data true this monitor would have gone red
  # the moment the backlog finished draining - the never-green monitor somebody
  # mutes. MONEY-1255 moved that call into the finally, so every run reports,
  # and an idle run reports 0/0 which the clamped-difference query reads as
  # healthy.
  "stock-document-extract|36h|daily 22:00"
  # ⚠️ REMOVING A ROW HERE DOES NOT DELETE THE MONITOR. This script's apply
  # loop is create-or-update only — an EXISTING_ID lookup, then PUT when found
  # and POST when not: there is no delete verb anywhere in this file, which you
  # can confirm by grepping it for one. (Deliberately NOT written here as a
  # grep pattern — the coverage scan reads this file for job names and is
  # comment-blind, so a quoted request verb is parsed as a MONITORED_JOBS entry
  # and then reported as a job with no emit site. Third instance of that class
  # in one change.) A job dropped from MONITORED_JOBS leaves its monitor live
  # in Datadog, emitting no series, and `notify_no_data: true` with
  # `no_data_timeframe = window x 3` pages ~4.5 days later — unrecoverable by
  # re-running this script. The manual DELETE is step 0c of
  # docs/reference/doc-ingest-runbook.md.
  #
  # MONEY-1314 - `stock-document-parse` was monitored here on a 36h window
  # against its daily 01:00 cron. THAT CRON IS RETIRED and the row is removed
  # with it: all four passes are in OLD_SCHEDULER_PREFIXES, so nothing publishes
  # to the lane on a schedule any more and the monitor would sit in NO DATA -
  # `notify_no_data: true`, `no_data_timeframe` = 3x the window = 4.5 days -
  # which is precisely the state this file's own comments warn about, and how
  # `bhavcopy-sync`'s monitor got muted (MONEY-1238).
  #
  # `stock-document-ingest` is NOT added in its place YET, deliberately. It is
  # event-driven: announced at store time by the five `stock_documents` writers,
  # and gated by DOC_INGEST_REALTIME, which ships "false". A freshness monitor
  # on a lane that is switched off is guaranteed NO DATA on day one, and a
  # monitor that has never been green is a monitor somebody mutes.
  #
  # ADD IT IN THE SAME CHANGE THAT ARMS DOC_INGEST_REALTIME, not before. The
  # emit site already exists (`reportJobOutcome({ job: "stock-document-ingest" })`
  # in the processor's finish path, on EVERY exit including not-found), so the
  # row is a one-line addition: the job id stock-document-ingest, a 36h window,
  # and a cadence note saying it is event-driven.
  #
  # (Deliberately NOT written here in the array's own syntax. The agreement
  # test parses this file for rows and is comment-blind, so a quoted example
  # with a pipe in it is COUNTED as a 37th monitor - it renders 36, the parse
  # sees 37, and the failure names neither. Same class as MONEY-1143.)
  #
  # The figures those companies depend on keep flowing meanwhile through the
  # `doc-ingest-backfill` Cloud Run job, which is operator-run and reports its
  # own outcome; `document-financials-projection` below still watches the
  # downstream write.
  #
  # ─── MONEY-1404 — `etf-expense-enrichment` RETIREMENT, step 0 ────────────
  #
  # THE SAME CLASS, WITH THE IDS ALREADY KNOWN. That job is retired in this
  # change and BOTH of its rows are gone — the zero-write row above and the
  # sparse absence row in ABSENCE_MONITORS. Two monitors are therefore live in
  # Datadog with no row left to update them, and per the block above this
  # script cannot delete either one:
  #
  #   22316235   Alert   [production] etf-expense-enrichment wrote nothing but
  #                      had work to do
  #   22317851   OK      [production] etf-expense-enrichment has not reported a
  #                      run in 16d
  #
  # (Verified against the live org 2026-09-13, which holds 77 monitors under
  # managed-by:apply-monitors.)
  #
  # WHAT HAPPENS IF THIS IS SKIPPED. 22317851 is the SPARSE absence template,
  # `default_zero(count_not_null(...)) < 1` over a 16d window, and the retired
  # route stops calling reportJobOutcome the moment the deploy lands. So it
  # flips OK to Alert roughly 16 DAYS AFTER THE DEPLOY and stays there forever;
  # 22316235 drops into permanent NO DATA. A late alarm on a job that no longer
  # exists is the state that gets a monitor muted, and muting is how
  # `bhavcopy-sync` lost its only alert (MONEY-1238).
  #
  # `--only=verify` CANNOT CATCH THIS. These two share the managed tag with
  # apply-service-monitors.sh, so `dd_verify_managed` runs with exclusive=false
  # and reports them as under-the-tag-not-mine rather than as orphans, and
  # exits 0. The MISSING half of verify stays authoritative; the ORPHAN half
  # does not, which is exactly the half that would have found these.
  #
  # ORDER. Do this AFTER the deploy and BEFORE or alongside
  # `setup-scheduler.sh prod` — the absence clock starts at the DEPLOY, not at
  # the scheduler teardown. Until that script runs, the weekly trigger is still
  # live and still firing into a route that answers 200 and drops the message,
  # which emits no job outcome either.
  #
  # HOW. A founder action; nothing in this repo deletes a monitor.
  #
  #   DD_API_KEY=$(gcloud secrets versions access latest \
  #     --secret=DD_API_KEY_PROD)
  #   DD_APP_KEY=$(gcloud secrets versions access latest \
  #     --secret=DD_APP_KEY_PROD)
  #   for id in 22316235 22317851; do
  #     curl -s -X DELETE -H "DD-API-KEY: ${DD_API_KEY}" \
  #       -H "DD-APPLICATION-KEY: ${DD_APP_KEY}" \
  #       "https://api.us5.datadoghq.com/api/v1/monitor/${id}"
  #   done
  #
  # (Prod only. QA renders zero monitors — DD_QA_MONITORING gates every QA
  # apply — so there is no QA pair to delete. The host is us5, not the default
  # us1: a wrong site answers 403 and the delete silently does not happen.)
  #
  # Re-derive the ids rather than trusting these two if the run is much later:
  # the monitor search endpoint answers
  # `query=etf-expense-enrichment`, and both titles begin [production].
  "document-financials-projection|36h|daily 03:00"
  # ── MONEY-979 — SEC EDGAR (services/us-fundamentals) ──────────────────────
  #
  # ONE row, out of eleven EDGAR job ids that emit. The other ten are named in
  # the block below with the reason each would page in the configuration we
  # actually ship — which is the question this file has learned to ask first.
  #
  # THE EMIT SITE IS PYTHON. `app/jobs/detect.py` calls
  # `report_job_outcome(JOB_NAME, …)` from a `finally`, where
  # `JOB_NAME = "edgar-detect"`. `job-outcome-coverage.test.ts` scanned only
  # `workers/src/processors` and `scripts/jobs`, both TypeScript, so a Python
  # emit site was invisible to it and this row would have read as "monitored,
  # never emitted" — the NO-DATA-from-birth state that gets a monitor muted.
  # That scan is widened (per-file, on the report path) in the same change.
  #
  # WINDOW 6h, on a job whose cadence is ONE MINUTE. Neither the cadence nor
  # this file's 36h daily default, and the arithmetic runs the other way from
  # every row above: those pick a window LONGER than the gap between runs so a
  # quiet weekend is not NO DATA. Here the schedule fires 1,440 times a day in
  # all weather and reports 0/0 when the feed is quiet, so NO DATA can only mean
  # the scheduler or the service stopped — exactly what should page. What the
  # window sizes instead is SENSITIVITY, because the query sums over it: any
  # single successful claim in the window makes it healthy.
  #
  #   too long (36h)  a broken claim path is invisible for a day and a half,
  #                   and the window is nearly certain to contain one good claim
  #   too short (1h)  `selected` counts NEW Atom entries and `written` counts
  #                   filings actually CLAIMED, so an hour holding one filing
  #                   that a previous overlapping run already claimed reads
  #                   1 - 0 = 1. On a quiet Saturday that is a page for a
  #                   duplicate collapse, which is correct behaviour.
  #
  # 6h needs six hours in which SEC published something and we claimed none of
  # it. Overlapping runs — the only benign source of selected>0/written=0 —
  # happen when a walk exceeds its minute, i.e. at the 16:00-18:00 ET peak,
  # which is exactly when the window also contains hundreds of good claims.
  #
  # ARMING IS NOT A PRECONDITION HERE, and that is why this row can ship now:
  # `EDGAR_DETECT` ships "off" and the disarmed path returns before anything is
  # selected, so a disarmed run reports 0/0 — genuinely idle, not an alert.
  # PROD-ONLY is handled by the existing derivation: both scheduler entries that
  # dispatch to this job (edgar-detect-minutely, edgar-reconcile-hourly) are in
  # PROD_ONLY_JOBS, so no QA monitor is created.
  "edgar-detect|6h|every 1 min (atom) + hourly EFTS reconcile, all days"
  # ── MONEY-1358: the EDGAR bulk jobs, which were excluded as "disarmed" ──
  #
  # The exclusion block below said EDGAR_PARSE_APPLY ships false. IT DOES NOT:
  # setup-us-fundamentals-jobs.sh sets PARSE_APPLY="true" for prod, and the
  # deployed edgar-bulk-ftd-prod carries EDGAR_PARSE_APPLY: 'true' (read with
  # `gcloud run jobs describe`, 2026-09-05). Precondition (a) is met.
  #
  # (b) and (c) were the real work and are done: job_is_prod_only now sees a
  # trigger created by a FUNCTION rather than a SCHEDULER_DEFS row, and the
  # emit-site scan resolves a job id from JOB_NAMES in app/bulk/common.py.
  #
  # THE ZERO-WRITE QUERY IS SAFE ON A NO-OP DAY, measured rather than assumed —
  # prod job-outcome lines, 2026-09-05:
  #   companyfacts NOT_YET_PUBLISHED  selected 0    written 0      -> 0-0=0 quiet
  #   companyfacts COMPLETED          selected 131  written 15715  -> 1-1=0 quiet
  #   submissions  COMPLETED          selected 2342 written 2743562
  #   ftd          COMPLETED          selected 13255 written 13255
  # An unchanged upstream exits NOT_YET_PUBLISHED with 0/0, which the clamped
  # difference reads as genuinely idle. Had `selected` counted the members it
  # SCANNED, every quiet night would page.
  #
  # 12d on ftd, not 36h: it runs the 3rd, 10th, 18th and 25th, so the longest
  # gap is the 25th -> the 3rd = 9 days, and a window under that sits in NO DATA
  # for a week of every month.
  "edgar-bulk-ftd|12d|semimonthly 3rd/10th/18th/25th 19:00 IST; longest gap 9d"
  "edgar-bulk-submissions|36h|daily 13:00 + 16:00 retry"
  "edgar-bulk-companyfacts|36h|daily 13:00 + 16:00 retry"
  # MONEY-1358 — every 2 min, all days, PROD_ONLY. `selected` is `state.owed`
  # (work OWED a write, MONEY-1250), so it is zero exactly when the poller had
  # nothing to do and the standard query works unchanged.
  "tiingo-news-poll|2h|every 2 min, all days"
  # ── MONEY-1373 — the Databento intraday append ────────────────────────────
  #
  # 96h, from the MAX GAP rather than the nominal cadence. The crons are
  # `0 15 * * 2-6` and `0 18 * * 2-6` — Tue-Sat IST, because a US session
  # closing 16:00 ET lands after midnight IST — so the gap is SATURDAY -> TUESDAY:
  # 72h on the primary cron alone, 69h once the 18:00 retry is counted (Sat
  # 18:00 -> Tue 15:00). The row note states the primary-only figure, which is
  # the one that survives the retry being removed. That is the weekday job's Fri->Mon shape one
  # timezone further out, and a 36h window would sit in NO DATA every Sunday and
  # Monday, which is how `bhavcopy-sync`'s monitor got itself muted
  # (MONEY-1238).
  #
  # THIS CANNOT FALSE-ALARM ON THE HEALTHY STEADY STATE, and that is a property
  # of the counters rather than of the window. `UP_TO_DATE` is the NORMAL
  # outcome — the 18:00 retry after a successful 15:00 run reaches it from one
  # free `metadata.get_dataset_range` call — and it returns `sessions: []`, so
  # `sessionsPlanned` stays 0 and the run reports `selected: 0, written: 0`.
  # The template's query is `clamp_max(selected,1) - clamp_max(written,1) > 0`,
  # whose 0/0 row is 0 - 0 = 0: genuinely idle, no alert. What DOES fire is
  # sessions planned and no rows written — a download that verified and loaded
  # nothing, which is the class this whole directory exists for.
  #
  # ABSENCE is watched separately, and has to be: 96h is past Datadog's
  # 4320-minute no-data ceiling, so `window_limits` turns `notify_no_data` OFF
  # here and "the trigger stopped firing" would be unwatched. There is an
  # ABSENCE_MONITORS row above.
  #
  # PROD_ONLY, handled by the existing derivation: both triggers
  # (`databento-append-daily`, `databento-append-retry`) are in PROD_ONLY_JOBS,
  # so no QA monitor is created — QA receives `candles` and
  # `databento_batch_jobs` by copy and must never spend against the vendor.
  "databento-append|96h|Tue-Sat 15:00 IST; Sat -> Tue = 72h"
  #
  # DELIBERATELY NOT MONITORED, though they now emit:
  #
  #   us-instrument-sync      no scheduler entry — a manual seed job
  #
  #   ── MONEY-979, the ten EDGAR job ids that are NOT above ──
  #
  #   Written down rather than left to be rediscovered, because every one of
  #   them LOOKS like it belongs on the list and each fails for a different
  #   reason. Names are given bare, never in this array's quoted
  #   name-pipe-window form: `monitored jobs` is parsed out of this block by TWO
  #   independent readers (bash, which honours `#`, and the regex in
  #   job-outcome-coverage.test.ts / monitor-agreement.test.ts, which does not),
  #   so a commented-out row would be monitored by the tests and by nothing
  #   else. edgar-infra-coverage.test.ts fails if one appears.
  #
  #   edgar-parse-ownership / -13f / -13dg / -8k / -financials
  #       EVENT-DRIVEN, no clock. Their only publisher is the detect job's
  #       fan-out, so a night with no 13F filings is a topic with no messages
  #       and a metric with no points. With `notify_no_data: true` that is a
  #       monitor in NO DATA every quiet Sunday — the muted-alarm shape, and
  #       exactly the `stock-document-embed` case two entries up. They are not
  #       unwatched: they fire once per detected filing, and the edgar-detect
  #       monitor is what notices when those runs stop.
  #
  #   edgar-evict
  #       Daily 03:30 IST and PROD_ONLY, so the schedule is fine. The blocker is
  #       the shipped FLAG STATE: `EDGAR_EVICT_APPLY` ships "false", and a
  #       disarmed run is honest about it — `_evict_one` returns ok=False on the
  #       disarmed branch, so `stats.evicted` stays 0 while `stats.selected`
  #       counts every filing it planned to move. 1 - 0 = 1, every night, in the
  #       configuration we ship. That is `candle-evict` verbatim (see the note
  #       above it), and a monitor that fires nightly in its shipped state
  #       trains people to ignore the channel every other job here depends on.
  #       ADD IT IN THE CHANGE THAT SETS EDGAR_EVICT_APPLY=true, window 36h.
  #
  #   edgar-bulk-submissions / edgar-bulk-companyfacts
  #       Daily 13:00 + 16:00 retry (and 13:20 + 16:20), prod-only, and the
  #       COUNTERS ARE ALREADY RIGHT for the armed state: an unchanged upstream
  #       exits NOT_YET_PUBLISHED with selected=0 written=0, which the clamped
  #       difference reads as healthy, while a new zip that selects members and
  #       writes none reads as 1. Two things must land before the rows do:
  #         (a) EDGAR_PARSE_APPLY=true. Both jobs increment `selected` BEFORE
  #             the `if not applying: continue`, so while the flag is false
  #             every night SEC republishes reports selected=N written=0.
  #         (b) A prod-only derivation that can SEE them. `job_is_prod_only`
  #             greps SCHEDULER_DEFS rows, and these two are not rows — they are
  #             created by `setup_edgar_bulk_job_schedulers`, which skips AND
  #             DELETES on non-prod. So today they would resolve as
  #             not-prod-only and get a QA monitor for a job QA never runs.
  #         (c) An emit-site scan that can SEE them. job-outcome-coverage.test.ts
  #             finds a Python job id from a module-level JOB/JOB_NAME literal in
  #             a file that calls report_job_outcome; these two resolve `job`
  #             from JOB_NAMES in app/bulk/common.py, which does not. That test
  #             fails first and names itself, which is the right order.
  #
  #   edgar-xbrl-backfill / edgar-ownership-backfill
  #       One-shot history walks with no scheduler entry at all — the
  #       `us-instrument-sync` case. A clock is what a freshness monitor is late
  #       against, and inventing one for a job run by hand creates the muted
  #       alarm this ticket exists to remove.
  #
  #   edgar-bulk-ftd
  #       WAS grouped with those two as "no scheduler entry at all". It is not,
  #       and has not been since this same branch added
  #       `edgar-bulk-ftd-semimonthly-{env}` (`0 19 3,18 * *`) and
  #       `-retry-{env}` (`0 19 10,25 * *`) — four runs a month for a
  #       twice-monthly feed, because the publication day cannot be targeted.
  #       The exclusion still stands, for the reason the other bulk jobs have
  #       rather than the one that was written here:
  #         (a) EDGAR_PARSE_APPLY=true. `selected` is `counters["cusipsSeen"]`
  #             and `_write_cusip_rows` returns 0 written on the disarmed
  #             branch, so with the shipped `false` every run reports N-0=1 and
  #             pages four times a month in the configuration we ship. This is
  #             the `candle-evict` / `edgar-evict` shape a third time.
  #         (b) `job_is_prod_only` cannot see it, for the same reason it cannot
  #             see the other two: it greps SCHEDULER_DEFS rows, and these
  #             triggers are not rows — `setup_edgar_bulk_job_schedulers`
  #             creates them, skipping AND deleting on non-prod.
  #       (c) does NOT apply here: `ftd.py` sets `JOB_NAME` as a module-level
  #       literal and calls `report_job_outcome`, so the Python emit-site scan
  #       already finds it.
  #       WINDOW WHEN ADDED: 12d, not 36h. Runs land on the 3rd, 10th, 18th and
  #       25th, so the longest gap is the 25th -> the 3rd = 9 days, and the
  #       window must exceed the gap or it is NO DATA for a week every month.
  #
  #   stock-document-embed    CHAINED by stock-document-extract, and VERIFIED
  #                           rather than assumed (MONEY-1255): grep -n
  #                           stock-document over setup-scheduler.sh returns the
  #                           two sync entries and the extract entry, and
  #                           nothing for embed. Its ONLY publisher is
  #                           triggerEmbedPass, from the extract processor's
  #                           finally. So it genuinely has no clock of its own
  #                           - but it is not unwatched either: it fires once
  #                           per extract run, and the extract monitor above is
  #                           what notices when those runs stop.
  #
  # `notify_no_data: true` means a monitor for a job that does not run on a
  # clock sits in NO DATA from birth, which is finding #1(d) verbatim. Their
  # metrics are still emitted and queryable; what they lack is a CLOCK to be
  # late against, and inventing one here would create the muted alarm this
  # ticket exists to remove.
  #
  # `stockbook.job.transport_failures` (MONEY-1250) is emitted by
  # market-movers-sync, news-rss-sync, intraday-sync and price-sync and is NOT
  # monitored here, deliberately. It is a COUNT of upstream calls that failed, so
  # the useful alert is "more than usual", not "more than zero" — a single Yahoo
  # timeout in a 500-symbol run is normal and a `> 0` monitor would page on it.
  # A threshold needs a per-job baseline that does not exist yet. The counter is
  # queryable now, which is what makes the baseline observable; the monitor waits
  # until there is one. Its immediate value is the WARN line in
  # `reportJobOutcome`, which fires when transport failed AND nothing was
  # written — the shape that used to emit a clean 0/0/0.
)

NOTIFY="${DD_NOTIFY:-deepshaswat@gmail.com}"
MANAGED_TAG="managed-by:apply-monitors"

# THE LISTING IS ENV-SCOPED, and that is load-bearing rather than tidy.
#
# `monitor_tags` ANDs comma-separated tags (verified against the live API:
# `managed-by:apply-monitors,env:production` returns 75, `,env:qa` returns 0).
# Without the env term the listing is CROSS-ENVIRONMENT, and a row skipped
# because it is not in this env never reaches the rendered set — so the pruner
# reads the OTHER environment's monitors as orphans. Reproduced before fixing:
# `DD_QA_MONITORING=on apply-perf-monitors.sh qa` issued two DELETEs against
# `[production]` monitors and reported `pruned 2`. The first qa run after that
# switch is flipped would have deleted every prod perf monitor, with its history
# and its mute state, and reported success.
LIST_TAG="${MANAGED_TAG},env:${DD_ENV_TAG}"

# ---------------------------------------------------------------------------
# HTTP — status checked explicitly, body kept.
#
# NOT `curl -f`: -f makes curl exit non-zero on an HTTP error but also discards
# the response body, and Datadog's body is where the reason lives ("query is
# invalid", "monitor with that name exists"). Losing it would trade one silent
# failure for a loud one with nothing to act on.
# ---------------------------------------------------------------------------
RESPONSE_BODY=""
RESPONSE_STATUS=""


# ---------------------------------------------------------------------------
# Render one monitor from the template.
#
# Templating in node rather than sed: the message body carries newlines, `@`,
# `/` and `{}`, and a sed expression over them is one unescaped delimiter away
# from producing valid-looking JSON that says something else. node also drops
# the `_`-prefixed documentation keys, which the API rejects.
# ---------------------------------------------------------------------------
# render <template> <job> <window> <no_data_minutes> [metric] [threshold_seconds]
#
# The template is now a PARAMETER. It was a fixed global, which was correct
# while there was one question to ask; MONEY-979 needs a percentile over a
# histogram, and no substitution of monitor-zero-write.json's placeholders can
# express that — its type, query shape and threshold semantics are all fixed to
# a two-counter difference.
#
# The unknown-placeholder throw below is what keeps ONE variable map safe for
# BOTH templates: a variable a template does not use costs nothing, while a
# placeholder no variable supplies still fails loudly.
# Thin wrapper over `dd_render` in lib-datadog.sh — MONEY-1359.
#
# The nine `P_*` variables stay HERE because they are THIS script's
# placeholders; the rendering RULES — strip `_` documentation keys at every
# depth, throw on an unknown or an unsubstituted placeholder, coerce the numeric
# options — are shared with apply-service-monitors.sh and live in the library.
# Keeping this signature means the call sites in the three apply loops below are
# untouched, so the extraction is a move rather than a rewrite.
# Datadog's own ceilings, learned by applying for real — MONEY-1229.
#
#   no_data_timeframe   <= 4320 minutes (72h)
#   a query's `d` unit  1..30
#
# 35 of 37 monitors were refused 400 "No data timeframe must be <= 4320" on the
# first live apply, and one more for a `32d` window. Neither limit is in any doc
# we read; both were measured.
#
# The no-data rule is NOT a clamp, because clamping alone would break the
# monitors it silences. `notify_no_data` only means something when its timeframe
# EXCEEDS the job's legitimate maximum gap — otherwise it fires on a healthy
# schedule, gets muted, and the monitor becomes worse than absent. That is
# exactly how bhavcopy-sync's monitor was lost (MONEY-1238).
#
# The WINDOW is already sized to exceed that gap by the week-long cron
# simulation, so:
#
#   window < 4320 min   no_data = min(3 x window, 4320), notify TRUE.
#                       72h still exceeds a sub-72h gap, so the clamp is safe.
#   window >= 4320 min  the legitimate gap is at or past the ceiling and NO
#                       valid timeframe exists. notify FALSE, deliberately —
#                       the 96h jobs gap 72h Fri->Mon and a 72h alarm would fire
#                       every single weekend.
#
# Sets NO_DATA_MINUTES, NOTIFY_NO_DATA and QUERY_WINDOW.
DD_MAX_NO_DATA_MINUTES=4320
window_limits() {
  # TWO lines, not one. Bash expands every word of a `local` command BEFORE
  # executing it, so `local hours="$1" minutes=$((hours * 60))` evaluates the
  # arithmetic while `hours` is still unset in this scope — "unbound variable"
  # under `set -u`, from a line that looks obviously correct.
  local hours="$1"
  local minutes=$((hours * 60))
  NO_DATA_MINUTES=$((minutes * 3))
  if ((minutes >= DD_MAX_NO_DATA_MINUTES)); then
    NOTIFY_NO_DATA=false
    NO_DATA_MINUTES=$DD_MAX_NO_DATA_MINUTES
  else
    NOTIFY_NO_DATA=true
    ((NO_DATA_MINUTES > DD_MAX_NO_DATA_MINUTES)) && NO_DATA_MINUTES=$DD_MAX_NO_DATA_MINUTES
  fi
  # DATADOG'S QUERY WINDOW MAXES AT 30 DAYS, in either unit: `d` is 1..30 and
  # `h` is 1..720, and 720h IS 30d. Both measured — `last_32d` was refused
  # "unit d must have value between 1 and 30", and converting it to `last_768h`
  # was then refused "unit h must have value between 1 and 720".
  #
  # So a window longer than 30 days cannot be expressed, and it is CLAMPED
  # LOUDLY rather than silently. A shrunk window is the one change that can turn
  # a correct monitor into one that fires on a healthy schedule — the window is
  # sized to exceed the job's legitimate gap, and shrinking it below that gap is
  # how a monitor gets muted. The operator has to see it happen.
  QUERY_WINDOW=""
  if ((hours > 720)); then
    QUERY_WINDOW="720h"
    echo "  NOTE: window ${hours}h exceeds Datadog's 30-day maximum; clamped to 720h." >&2
    echo "        Verify the job's longest legitimate gap is still under 30 days," >&2
    echo "        or this monitor will fire on a healthy schedule." >&2
  fi
}

render() {
  local vars
  vars="$(
    P_JOB="$2" P_WINDOW="$3" P_NODATA="$4" P_METRIC="${5:-}" P_THRESHOLD="${6:-}" \
    P_NOTIFY_ND="${7:-true}" \
    P_ENV="$DD_ENV_TAG" P_SELECTED="$SELECTED_METRIC" P_WRITTEN="$WRITTEN_METRIC" \
    P_NOTIFY="$NOTIFY" node -e '
      console.log(JSON.stringify({
        job: process.env.P_JOB,
        env: process.env.P_ENV,
        window: process.env.P_WINDOW,
        no_data_minutes: process.env.P_NODATA,
        notify_no_data: process.env.P_NOTIFY_ND === "true",
        notify: process.env.P_NOTIFY,
        selected_metric: process.env.P_SELECTED,
        written_metric: process.env.P_WRITTEN,
        metric: process.env.P_METRIC,
        threshold_seconds: process.env.P_THRESHOLD,
      }));
    '
  )" || return 1
  dd_render "$1" "$vars"
}

# ---------------------------------------------------------------------------

FAILED_JOBS=()
APPLIED=0
SKIPPED=0
# What THIS run rendered, for `--only=verify`. Collected in ALL FOUR loops:
# a loop left out contributes no names, so every monitor it owns reads as an
# orphan and verify reports drift that does not exist.
#
# Always the name READ OUT OF THE RENDERED BODY. The latency, absence and d1
# loops already have one (L_NAME/A_NAME/D_NAME); the zero-write loop's $NAME is
# a bash copy of the template string, so that one re-reads the body. The body's
# `name` is what Datadog stores, so if the copy ever drifts from the template
# the script is already POSTing duplicates — and a verify built on the copy
# would agree with itself and hide exactly that.
RENDERED_NAMES=()

# One listing for the whole run rather than one lookup per job. Monitors are
# matched on the rendered NAME; the tag only narrows what has to be listed.
EXISTING_JSON="{}"
if ! $DRY_RUN; then
  if dd_request GET "${DD_BASE_URL}?monitor_tags=$(printf %s "$LIST_TAG" | sed 's/:/%3A/g')"; then
    EXISTING_JSON="$RESPONSE_BODY"
    # Validate the SHAPE, not just the status. A 200 carrying anything other
    # than an array would be read as "no monitors exist" by the lookup below and
    # every job would be POSTed as new — the duplication this GET exists to
    # prevent, arrived at through the door marked success. Same class as the
    # thing being fixed, so it is checked rather than assumed.
    if ! EXISTING="$EXISTING_JSON" node -e '
      const v = JSON.parse(process.env.EXISTING);
      if (!Array.isArray(v)) throw new Error("expected an array of monitors");
    ' 2>/dev/null; then
      echo "FATAL: monitor listing was not a JSON array — refusing to POST" >&2
      echo "${RESPONSE_BODY}" >&2
      exit 1
    fi
  else
    # Fatal, not a warning. Continuing here would POST every monitor as new and
    # duplicate the whole set — the failure mode this lookup exists to prevent.
    echo "FATAL: could not list existing monitors (HTTP ${RESPONSE_STATUS})" >&2
    echo "${RESPONSE_BODY}" >&2
    exit 1
  fi
fi

for ROW in "${MONITORED_JOBS[@]}"; do
  IFS='|' read -r JOB WINDOW CADENCE <<< "$ROW"

  # no-data window is generous: 3x the alert window. A late run must not page.
  # Plain bash arithmetic — the previous `sed | bc` pipeline added a dependency
  # on `bc`, which is not installed everywhere this has to run.
  #
  # Validated as digits-then-unit BEFORE any arithmetic. An unquoted `$(( ))`
  # over a non-numeric operand is a bash SYNTAX error, and a syntax error inside
  # a loop body aborts the loop without aborting the script — so the run would
  # skip every remaining job and still reach the success line at the bottom.
  # That is this file's own bug class, in the file that fixes it.
  if [[ ! "$WINDOW" =~ ^([0-9]+)([hd])$ ]]; then
    echo "FATAL: unparsable window '${WINDOW}' for ${JOB} (expected e.g. 36h, 8d)" >&2
    exit 1
  fi
  WINDOW_HOURS="${BASH_REMATCH[1]}"
  [[ "${BASH_REMATCH[2]}" == "d" ]] && WINDOW_HOURS=$((WINDOW_HOURS * 24))
  window_limits "$WINDOW_HOURS"

  # A job QA never runs gets no QA monitor — see the derivation above.
  if [[ "$DD_ENV_TAG" == "qa" ]] && job_is_prod_only "$JOB"; then
    echo "skipping (prod-only): ${JOB}"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  BODY="$(render "$TEMPLATE" "$JOB" "${QUERY_WINDOW:-$WINDOW}" "$NO_DATA_MINUTES" "" "" "$NOTIFY_NO_DATA")"
  NAME="[${DD_ENV_TAG}] ${JOB} wrote nothing but had work to do"

  if $DRY_RUN; then
    echo "would apply: ${NAME} (${CADENCE}, window ${WINDOW})"
    echo "  ${BODY}"
    APPLIED=$((APPLIED + 1))
    continue
  fi

  if [[ "$ONLY" == verify ]]; then
    RENDERED_NAMES+=("$(BODY="$BODY" node -e 'process.stdout.write(JSON.parse(process.env.BODY).name)')")
    continue
  fi

  EXISTING_ID="$(
    EXISTING="$EXISTING_JSON" MONITOR_NAME="$NAME" node -e '
      // Shape already validated after the GET; parse errors here are fatal on
      // purpose rather than degrading to "not found", which would duplicate.
      const list = JSON.parse(process.env.EXISTING);
      const hit = list.find((m) => m && m.name === process.env.MONITOR_NAME);
      process.stdout.write(hit && hit.id != null ? String(hit.id) : "");
    '
  )"

  if [[ -n "$EXISTING_ID" ]]; then
    echo "updating: ${NAME} (id ${EXISTING_ID}, ${CADENCE}, window ${WINDOW})"
    if dd_request PUT "${DD_BASE_URL}/${EXISTING_ID}" "$BODY"; then
      echo "  -> ${EXISTING_ID}"
      APPLIED=$((APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${JOB} (PUT ${EXISTING_ID}, HTTP ${RESPONSE_STATUS})")
    fi
  else
    echo "creating: ${NAME} (${CADENCE}, window ${WINDOW})"
    if dd_request POST "$DD_BASE_URL" "$BODY"; then
      NEW_ID="$(RESP="$RESPONSE_BODY" node -e '
        try {
          process.stdout.write(String(JSON.parse(process.env.RESP).id ?? ""));
        } catch {
          process.stdout.write("");
        }
      ')"
      echo "  -> ${NEW_ID:-created}"
      APPLIED=$((APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${JOB} (POST, HTTP ${RESPONSE_STATUS})")
    fi
  fi
done

# ── Latency monitors ─────────────────────────────────────────────────────────
# Counted SEPARATELY. Folding these into APPLIED/SKIPPED would break the
# accounting check below, whose whole point is that the number of monitors
# reached equals the number declared — and a check that sums two different
# populations cannot detect a loop that ended early in either one.
L_APPLIED=0
L_SKIPPED=0
for ROW in "${LATENCY_MONITORS[@]}"; do
  IFS='|' read -r L_JOB L_METRIC L_THRESHOLD L_WINDOW <<< "$ROW"

  # Validated before arithmetic, for the reason the window parse above is: an
  # unquoted $(( )) over a non-numeric operand is a bash SYNTAX error, and a
  # syntax error inside a loop body aborts the LOOP without aborting the script,
  # so the run would skip the rest and still reach the success line.
  if [[ ! "$L_WINDOW" =~ ^([0-9]+)([hd])$ ]]; then
    echo "FATAL: unparsable window '${L_WINDOW}' for ${L_JOB}" >&2; exit 1
  fi
  # Captured IMMEDIATELY, before any other `=~`. BASH_REMATCH is global and is
  # REWRITTEN by every match, and the threshold check below uses `^[0-9]+$` —
  # no capture group — so reading BASH_REMATCH[1] after it yields nothing.
  # `set -u` turned that into a hard "unbound variable" here; without it the
  # window would have silently become empty and the no-data timeframe wrong.
  L_HOURS="${BASH_REMATCH[1]}"
  L_UNIT="${BASH_REMATCH[2]}"
  if [[ ! "$L_THRESHOLD" =~ ^[0-9]+$ ]]; then
    echo "FATAL: threshold '${L_THRESHOLD}' for ${L_JOB} is not an integer" >&2; exit 1
  fi
  [[ "$L_UNIT" == "d" ]] && L_HOURS=$((L_HOURS * 24))
  # TWO of the three things `window_limits` sets apply here. This template sets
  # `notify_no_data: false` by design (see its `_notify_no_data_rationale`), so
  # the true/false half is irrelevant and NO_DATA_MINUTES is inert — but it must
  # still be <= 4320 or Datadog refuses the whole monitor, and QUERY_WINDOW is
  # NOT inert: a window past 30 days is refused outright in either unit.
  window_limits "$L_HOURS"
  L_NODATA="$NO_DATA_MINUTES"
  # USE THE CLAMPED WINDOW — MONEY-1359 finding 9. This loop called
  # `window_limits` (which can set QUERY_WINDOW=720h and print a loud clamp
  # NOTE) and then rendered with the RAW "$L_WINDOW", so a latency row over 30
  # days would have printed the clamp and POSTed the unclamped value anyway —
  # rejected 400 "unit d must have value between 1 and 30". Both sibling loops
  # already read the clamp back (`${QUERY_WINDOW:-$WINDOW}` and `A_QWINDOW`);
  # this one computed it and threw it away. Dormant only because the list holds
  # one 1h row.
  L_QWINDOW="${QUERY_WINDOW:-$L_WINDOW}"

  # MONEY-979 T14 — the SAME prod-only skip the zero-write loop performs, and it
  # was missing here. `edgar-detect` is in PROD_ONLY_JOBS (QA ships
  # SEC_EGRESS=off, so a QA detect run cannot reach sec.gov by design), yet a
  # `apply-monitors.sh qa` run still rendered `[qa] edgar-detect — p95 latency
  # over 300s`. QA emits this series ZERO times, ever: the only emit site is
  # detect.py's fan-out, and a QA detect run cannot reach the feed that fills
  # it. The monitor is therefore permanently in NO DATA on QA — dead weight in
  # the listing, and a name an operator has to learn to ignore. It no longer
  # PAGES from that state (the template sets `notify_no_data: false`; see its
  # `_notify_no_data_rationale`), but "silent and permanently grey" is not a
  # reason to create it. That is finding #1(d) of MONEY-1238, in the second
  # template, for the same reason the first one had it: the skip lived in one
  # loop and the list grew a second.
  #
  # Placed AFTER the window/threshold validation on purpose, matching the loop
  # above: a malformed row must fail loudly in EVERY environment, not only in
  # the one that does not skip it.
  if [[ "$DD_ENV_TAG" == "qa" ]] && job_is_prod_only "$L_JOB"; then
    echo "skipping (prod-only): ${L_JOB} latency"
    L_SKIPPED=$((L_SKIPPED + 1))
    continue
  fi

  L_BODY="$(render "$LATENCY_TEMPLATE" "$L_JOB" "$L_QWINDOW" "$L_NODATA" "$L_METRIC" "$L_THRESHOLD")" || {
    echo "FATAL: could not render latency monitor for ${L_JOB}" >&2; exit 1
  }
  L_NAME="$(BODY="$L_BODY" node -e 'process.stdout.write(JSON.parse(process.env.BODY).name)')"

  # `if $DRY_RUN` — the same form every other site in this file uses. DRY_RUN
  # holds the STRINGS "true"/"false", so `[[ "$DRY_RUN" == "1" ]]` is never
  # true and this branch would have fallen through to a live API call during a
  # dry run.
  if $DRY_RUN; then
    echo "would apply: ${L_NAME}"
    echo "  ${L_BODY}"
    L_APPLIED=$((L_APPLIED + 1))
    continue
  fi

  if [[ "$ONLY" == verify ]]; then
    RENDERED_NAMES+=("$L_NAME")
    continue
  fi

  L_ID="$(
    EXISTING="$EXISTING_JSON" MONITOR_NAME="$L_NAME" node -e '
      const list = JSON.parse(process.env.EXISTING);
      const hit = list.find((m) => m && m.name === process.env.MONITOR_NAME);
      process.stdout.write(hit && hit.id != null ? String(hit.id) : "");
    '
  )"

  if [[ -n "$L_ID" ]]; then
    echo "updating: ${L_NAME} (id ${L_ID})"
    if dd_request PUT "${DD_BASE_URL}/${L_ID}" "$L_BODY"; then
      L_APPLIED=$((L_APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${L_JOB} latency (PUT ${L_ID}, HTTP ${RESPONSE_STATUS})")
    fi
  else
    echo "creating: ${L_NAME}"
    if dd_request POST "$DD_BASE_URL" "$L_BODY"; then
      L_APPLIED=$((L_APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${L_JOB} latency (POST, HTTP ${RESPONSE_STATUS})")
    fi
  fi
done

# ── Absence monitors ─────────────────────────────────────────────────────────
# Counted SEPARATELY, for the reason the latency loop is: the accounting check
# below asserts that the number of monitors REACHED equals the number DECLARED,
# and a check that sums two populations cannot detect a loop that ended early in
# either one. A third population needs a third pair of counters or the guarantee
# weakens for all three.
A_APPLIED=0
A_SKIPPED=0
for ROW in "${ABSENCE_MONITORS[@]}"; do
  IFS='|' read -r A_JOB A_WINDOW A_KIND A_CADENCE <<< "$ROW"

  # Validated before arithmetic, for the reason both loops above are: an
  # unquoted $(( )) over a non-numeric operand is a bash SYNTAX error, and a
  # syntax error inside a loop body aborts the LOOP without aborting the script,
  # so the run would skip the rest and still reach the success line.
  if [[ ! "$A_WINDOW" =~ ^([0-9]+)([hd])$ ]]; then
    echo "FATAL: unparsable window '${A_WINDOW}' for ${A_JOB} absence" >&2; exit 1
  fi
  # Captured IMMEDIATELY: BASH_REMATCH is global and rewritten by every match.
  A_HOURS="${BASH_REMATCH[1]}"
  A_UNIT="${BASH_REMATCH[2]}"

  # MONEY-1399 — the KIND decides which of the two absence templates renders,
  # and an unrecognised value must never fall through to a default. Defaulting
  # would silently give a sparse job the standing query, which is the exact
  # defect this field exists to end: edgar-bulk-ftd alerted 11 seconds after
  # birth and was never once OK, while the table it feeds was being written
  # correctly the whole time. Fail loudly instead, like the window check above.
  #
  # Placed AFTER the BASH_REMATCH capture on purpose. `case` uses glob
  # matching and does not touch BASH_REMATCH (verified), but the capture
  # above documents itself as immediate, and a later edit that reached for
  # `[[ =~ ]]` here would clear it with nothing to catch that.
  case "$A_KIND" in
    standing|sparse) ;;
    *) echo "FATAL: absence row for ${A_JOB} has kind '${A_KIND}' — expected 'standing' or 'sparse'" >&2; exit 1 ;;
  esac
  [[ "$A_UNIT" == "d" ]] && A_HOURS=$((A_HOURS * 24))
  window_limits "$A_HOURS"
  A_NODATA="$NO_DATA_MINUTES"
  A_NOTIFY_ND="$NOTIFY_NO_DATA"
  A_QWINDOW="${QUERY_WINDOW:-$A_WINDOW}"

  # The SAME prod-only skip both loops above perform. `news-sync-market-hours`
  # is in PROD_ONLY_JOBS, so QA never runs this job and a QA absence monitor
  # would alert continuously from birth — which is worse here than in either
  # other loop, because this monitor's whole premise is that silence is a fault.
  if [[ "$DD_ENV_TAG" == "qa" ]] && job_is_prod_only "$A_JOB"; then
    echo "skipping (prod-only): ${A_JOB} absence"
    A_SKIPPED=$((A_SKIPPED + 1))
    continue
  fi

  # STANDING sums `selected` (a zero IS the defect — MONEY-1215); SPARSE counts
  # submissions (a zero is the designed steady state of a checkpointed job).
  # Both render the SAME `name`, so this switch changes the query of an existing
  # monitor in place rather than creating a second one beside it.
  if [[ "$A_KIND" == "sparse" ]]; then
    A_TEMPLATE="$ABSENCE_SPARSE_TEMPLATE"
  else
    A_TEMPLATE="$ABSENCE_TEMPLATE"
  fi

  A_BODY="$(render "$A_TEMPLATE" "$A_JOB" "$A_QWINDOW" "$A_NODATA" "" "" "$A_NOTIFY_ND")" || {
    echo "FATAL: could not render absence monitor for ${A_JOB}" >&2; exit 1
  }
  A_NAME="$(BODY="$A_BODY" node -e 'process.stdout.write(JSON.parse(process.env.BODY).name)')"

  if $DRY_RUN; then
    echo "would apply: ${A_NAME} (${A_CADENCE})"
    echo "  ${A_BODY}"
    A_APPLIED=$((A_APPLIED + 1))
    continue
  fi

  if [[ "$ONLY" == verify ]]; then
    RENDERED_NAMES+=("$A_NAME")
    continue
  fi

  A_ID="$(
    EXISTING="$EXISTING_JSON" MONITOR_NAME="$A_NAME" node -e '
      const list = JSON.parse(process.env.EXISTING);
      const hit = list.find((m) => m && m.name === process.env.MONITOR_NAME);
      process.stdout.write(hit && hit.id != null ? String(hit.id) : "");
    '
  )"

  if [[ -n "$A_ID" ]]; then
    echo "updating: ${A_NAME} (id ${A_ID})"
    if dd_request PUT "${DD_BASE_URL}/${A_ID}" "$A_BODY"; then
      A_APPLIED=$((A_APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${A_JOB} absence (PUT ${A_ID}, HTTP ${RESPONSE_STATUS})")
    fi
  else
    echo "creating: ${A_NAME}"
    if dd_request POST "$DD_BASE_URL" "$A_BODY"; then
      A_APPLIED=$((A_APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${A_JOB} absence (POST, HTTP ${RESPONSE_STATUS})")
    fi
  fi
done

# ── The Databento D1 tripwire ────────────────────────────────────────────────
# Counted SEPARATELY, for the reason all three loops above are: the accounting
# checks assert that the number of monitors REACHED equals the number DECLARED,
# and a check that sums two populations cannot detect a loop that ended early in
# either one.
D_APPLIED=0
D_SKIPPED=0
for ROW in "${D1_MONITORS[@]}"; do
  IFS='|' read -r D_GATE_JOB D_NOTE <<< "$ROW"

  # NO WINDOW PARSE, unlike the three loops above, because there is no window
  # column — monitor-databento-d1.json hard-codes `sum(last_1d)`. `window_limits`
  # is still called, for the ONE thing it produces that this template needs: a
  # no_data_timeframe inside Datadog's 4320-minute ceiling. `render()` coerces
  # that key to a Number unconditionally, so it has to be a real integer even
  # though `notify_no_data` is false in the template and it is therefore inert.
  window_limits 24
  D_NODATA="$NO_DATA_MINUTES"

  # The SAME prod-only skip all three loops above perform. The gate job is the
  # SCHEDULED emitter; see the D1_MONITORS comment for why that is a different
  # question from what the query filters on.
  if [[ "$DD_ENV_TAG" == "qa" ]] && job_is_prod_only "$D_GATE_JOB"; then
    echo "skipping (prod-only): databento d1 tripwire"
    D_SKIPPED=$((D_SKIPPED + 1))
    continue
  fi

  D_BODY="$(render "$D1_TEMPLATE" "$D_GATE_JOB" "" "$D_NODATA" "" "" "false")" || {
    echo "FATAL: could not render the databento d1 monitor" >&2; exit 1
  }
  D_NAME="$(BODY="$D_BODY" node -e 'process.stdout.write(JSON.parse(process.env.BODY).name)')"

  if $DRY_RUN; then
    echo "would apply: ${D_NAME} (${D_NOTE})"
    echo "  ${D_BODY}"
    D_APPLIED=$((D_APPLIED + 1))
    continue
  fi

  if [[ "$ONLY" == verify ]]; then
    RENDERED_NAMES+=("$D_NAME")
    continue
  fi

  D_ID="$(
    EXISTING="$EXISTING_JSON" MONITOR_NAME="$D_NAME" node -e '
      const list = JSON.parse(process.env.EXISTING);
      const hit = list.find((m) => m && m.name === process.env.MONITOR_NAME);
      process.stdout.write(hit && hit.id != null ? String(hit.id) : "");
    '
  )"

  if [[ -n "$D_ID" ]]; then
    echo "updating: ${D_NAME} (id ${D_ID})"
    if dd_request PUT "${DD_BASE_URL}/${D_ID}" "$D_BODY"; then
      D_APPLIED=$((D_APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${D_GATE_JOB} d1 (PUT ${D_ID}, HTTP ${RESPONSE_STATUS})")
    fi
  else
    echo "creating: ${D_NAME}"
    if dd_request POST "$DD_BASE_URL" "$D_BODY"; then
      D_APPLIED=$((D_APPLIED + 1))
    else
      echo "  !! FAILED (HTTP ${RESPONSE_STATUS}): ${RESPONSE_BODY}" >&2
      FAILED_JOBS+=("${D_GATE_JOB} d1 (POST, HTTP ${RESPONSE_STATUS})")
    fi
  fi
done

# Before the FAILED/accounting block on purpose: those report on a WRITE run,
# and a verify run performed none. Its exit code is its own — 0 in sync, 3 drift.
if [[ "$ONLY" == verify ]]; then
  # Rows REFUSED by their preflight were never rendered, so they are absent
  # from BOTH sets below and the three counts do not add up to the row count
  # without this. Reporting them is what makes the arithmetic checkable — and
  # a refused row is its own answer anyway: a row whose series has no points is
  # a row whose monitor should not exist.
  if ((${#FAILED_JOBS[@]} > 0)); then
    echo "${#FAILED_JOBS[@]} row(s) COULD NOT BE VERIFIED — refused by their own preflight,"
    echo "so they were never rendered and appear in neither set below:"
    printf '  ! %s\n' "${FAILED_JOBS[@]}"
    echo ""
  fi
  # `"${A[@]}"` on an EMPTY array is an unbound-variable error under `set -u` in
  # bash 3.2, which is what macOS ships. The `+` form expands to nothing instead.
  # false: this tag is SHARED with the sibling apply script, so a monitor
  # under it that this script did not render is not evidence of an orphan.
  dd_verify_managed "$LIST_TAG" false "${RENDERED_NAMES[@]+"${RENDERED_NAMES[@]}"}"
  exit $?
fi

if ((${#FAILED_JOBS[@]} > 0)); then
  echo >&2
  echo "${#FAILED_JOBS[@]} of $((${#MONITORED_JOBS[@]} + ${#LATENCY_MONITORS[@]} + ${#ABSENCE_MONITORS[@]} + ${#D1_MONITORS[@]})) monitors did NOT apply:" >&2
  for f in "${FAILED_JOBS[@]}"; do echo "  - $f" >&2; done
  exit 1
fi

# Count, not absence-of-error. "No failures recorded" and "every job was
# reached" are different facts, and the second is the one the success line
# claims — a loop that ended early records nothing and would otherwise print
# success. This is the same arithmetic the monitor itself does: work selected
# versus work done.
if ((APPLIED + SKIPPED != ${#MONITORED_JOBS[@]})); then
  echo "FATAL: ${APPLIED} applied + ${SKIPPED} skipped != ${#MONITORED_JOBS[@]} monitored —" >&2
  echo "       the loop did not complete" >&2
  exit 1
fi

# Same arithmetic for the latency list, and placed AFTER the FAILED_JOBS report
# on purpose: an HTTP failure already names itself there, and reaching this line
# first would replace a precise "POST returned 400" with a vague "the loop did
# not complete".
# APPLIED **+ SKIPPED** here too, for the reason the zero-write check carries
# both: a prod-only latency monitor is skipped on qa, and a skip must not read
# as a lost monitor. Dropping either term breaks one environment.
if ((L_APPLIED + L_SKIPPED != ${#LATENCY_MONITORS[@]})); then
  echo "FATAL: ${L_APPLIED} applied + ${L_SKIPPED} skipped != ${#LATENCY_MONITORS[@]} latency monitor(s) declared —" >&2
  echo "       the latency loop did not complete" >&2
  exit 1
fi

# And the third, for the same reason again. Three populations, three checks:
# folding them into one sum would let a loop that ended early be masked by
# another that over-counted.
if ((A_APPLIED + A_SKIPPED != ${#ABSENCE_MONITORS[@]})); then
  echo "FATAL: ${A_APPLIED} applied + ${A_SKIPPED} skipped != ${#ABSENCE_MONITORS[@]} absence monitor(s) declared —" >&2
  echo "       the absence loop did not complete" >&2
  exit 1
fi

# And the fourth. Four populations, four checks, for the reason stated above:
# folding them into one sum would let a loop that ended early be masked by
# another that over-counted.
if ((D_APPLIED + D_SKIPPED != ${#D1_MONITORS[@]})); then
  echo "FATAL: ${D_APPLIED} applied + ${D_SKIPPED} skipped != ${#D1_MONITORS[@]} d1 monitor(s) declared —" >&2
  echo "       the d1 loop did not complete" >&2
  exit 1
fi

# `${SKIPPED:+...}` is not the test wanted here: SKIPPED is the STRING "0" when
# nothing was skipped, which is non-empty and would print ", 0 skipped".
TOTAL_SKIPPED=$((SKIPPED + L_SKIPPED + A_SKIPPED + D_SKIPPED))
SUFFIX=""
((TOTAL_SKIPPED > 0)) && SUFFIX=", ${TOTAL_SKIPPED} skipped as prod-only (no QA schedule)"
echo "${APPLIED} zero-write + ${L_APPLIED} latency + ${A_APPLIED} absence + ${D_APPLIED} d1 monitor(s) applied to ${DD_ENV_TAG} (${DD_API_HOST})${SUFFIX}"
