#!/usr/bin/env bash
#
# Shared Datadog API plumbing — MONEY-1359.
#
# SOURCED, never executed. Callers set DD_API_KEY / DD_APP_KEY / DD_API_HOST /
# DRY_RUN before sourcing, and own their own row lists.
#
# ## Why a library rather than a second copy
#
# `apply-service-monitors.sh` needs the same request helper, the same renderer
# and the same create-or-update decision that `apply-monitors.sh` already has,
# and every one of those has a scar on it: `curl` exits 0 on a 403, so the
# status has to be checked explicitly; an unreadable listing must ABORT rather
# than read as "no monitors exist" and duplicate the whole set; `_`-prefixed
# documentation keys have to be stripped at EVERY depth because Datadog rejects
# an unknown field inside `options` with a 400; and a threshold that arrives as
# the STRING "300" is refused.
#
# A second copy would start identical and drift, which is the defect class this
# directory's whole history is made of. One copy, sourced twice.
#
# ## What did NOT move
#
# The job lists, the prod-only derivation and the three apply loops stay in
# `apply-monitors.sh`. They are that script's subject matter, not plumbing, and
# `packages/datadog/__tests__/monitor-agreement.test.ts` spawns the real script
# against a stubbed `curl` — so this extraction is executed rather than
# reviewed.


# The Datadog API host, derived from the ONE place the site is spelled.
#
# This lived in four apply scripts as four copies of the same twelve lines, and
# the site is exactly the kind of fact that must not have four spellings: the
# org moved us3 -> us5, a stale copy is answered 403, and a 403 on an intake is
# swallowed and renders as NO DATA rather than as an error (MONEY-1238 fault
# (d), MONEY-1229). A script that derives it independently can drift; one that
# calls this cannot.
#
# Sets DD_API_HOST. Fails CLOSED — an unreadable constant stops the run rather
# than defaulting to a site, because defaulting is how you end up writing
# monitors into an org nobody is watching.
# QA MONITORING IS OFF — founder decision, 2026-09-06.
#
# Not a code limitation and not an oversight. QA runs a subset of the schedules
# on data copied down from prod, so a QA monitor either duplicates a prod alarm
# or watches a job QA never runs — and the second kind is the one that pages at
# 03:00 about nothing and teaches everyone to ignore the channel.
#
# Reversal is this one variable. `DD_QA_MONITORING=on` re-enables every qa row,
# and the apply scripts recreate what they deleted, because everything is keyed
# by name and tagged `managed-by:`.
#
# Returns 0 when qa monitoring is enabled.
dd_qa_monitoring_enabled() { [[ "${DD_QA_MONITORING:-off}" == "on" ]]; }

dd_resolve_api_host() {
  local root site
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  site="$(DD_SRC="$root/packages/datadog/src" node -e '
    const fs = require("node:fs");
    const src = fs.readFileSync(`${process.env.DD_SRC}/constants.ts`, "utf8");
    const m = /DD_SITE\s*=\s*\n?\s*"([^"]+)"/.exec(src);
    if (!m) { console.error("could not read DD_SITE"); process.exit(1); }
    console.log(m[1]);
  ')" || { echo "FATAL: could not read DD_SITE from packages/datadog/src/constants.ts" >&2; return 1; }
  [[ -n "$site" ]] || { echo "FATAL: DD_SITE resolved empty" >&2; return 1; }
  DD_API_HOST="api.${site}"
  export DD_API_HOST
}

# dd_server_span SERVICE — print SERVICE's APM SERVER span, read from the ONE
# place it is declared: DD_SERVER_SPAN in packages/datadog/src/constants.ts.
#
# MONEY-1534. A row that restated the span kept querying `web.request` after
# the workers' ESM loader let dd-trace's Hono plugin rename it `hono.request`,
# and the monitor sat in No Data from 2026-09-12 without an error. The measured
# span per service, and why it differs, is documented on the constant.
#
# Fails CLOSED on an undeclared service: a default would be a guess, and a
# guessed span is a query over a series nobody emits.
dd_server_span() {
  local root
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
  DD_SRC="$root/packages/datadog/src" SVC="$1" node -e '
    const src = require("node:fs").readFileSync(`${process.env.DD_SRC}/constants.ts`, "utf8");
    const body = /DD_SERVER_SPAN\s*=\s*\{([^}]*)\}/.exec(src)?.[1] ?? "";
    for (const m of body.matchAll(/"([a-z0-9-]+)":\s*"([a-z0-9_.]+)"/g))
      if (m[1] === process.env.SVC) { console.log(m[2]); process.exit(0); }
    console.error(`no server span declared for "${process.env.SVC}" in DD_SERVER_SPAN`);
    process.exit(1);
  '
}

# The two keys, as a curl CONFIG on stdin — never on argv.
#
# `-H "DD-API-KEY: $KEY"` puts the credential on curl's own command line, which
# any process on the box can read through `ps`; this repo has already been bitten
# by `pgrep -fl` printing a process environment. `set-dd-secret.sh` closed the
# same hole for its one probe, and this is the same fix at ~50 requests per
# apply run. `printf` is a bash BUILTIN, so the key never becomes a separate
# process's argv either, and curl parses `-K -` to EOF at startup before it
# opens a socket.
dd_credential_config() {
  printf 'header = "DD-API-KEY: %s"\nheader = "DD-APPLICATION-KEY: %s"\n' \
    "${DD_API_KEY}" "${DD_APP_KEY}"
}

dd_request() {
  local method="$1" url="$2" body="${3:-}" rc=0
  local raw
  # SET BEFORE ANY `return 1`, and reset on every call.
  #
  # Every caller reports a failure by printing RESPONSE_STATUS and
  # RESPONSE_BODY, and they all run under `set -u`. Returning before these are
  # assigned kills the script INSIDE the handler that was supposed to report the
  # failure — `unbound variable`, no diagnosis. The extraction into this library
  # dropped the top-level pre-initialisation `apply-monitors.sh` still carries,
  # which is why only that script survived a curl that never answered.
  #
  # Mid-run it is quieter and worse: the PREVIOUS request's status and body are
  # still in place, so the FAILED entry reports some other request's outcome.
  RESPONSE_STATUS="000"
  RESPONSE_BODY=""
  # The BODY stays on `-d`, deliberately. It is not a credential, and curl's
  # config format would need the JSON re-quoted (backslash and double-quote
  # escapes) to carry it — a new correctness risk for no secrecy gain, on the
  # one channel `-K -` is already occupying.
  if [[ -n "$body" ]]; then
    raw="$(dd_credential_config | curl -sS -X "$method" "$url" -K - \
      -H "Content-Type: application/json" \
      -d "$body" \
      -w $'\n%{http_code}')" || rc=$?
  else
    raw="$(dd_credential_config | curl -sS -X "$method" "$url" -K - \
      -w $'\n%{http_code}')" || rc=$?
  fi
  if [[ "$rc" -ne 0 ]]; then
    # `000` is curl's own spelling of "no HTTP response", so it reads correctly
    # in the `(HTTP ${RESPONSE_STATUS})` the callers already print.
    RESPONSE_BODY="curl exited ${rc} without an HTTP response (${method} ${url})"
    return 1
  fi
  RESPONSE_STATUS="${raw##*$'\n'}"
  RESPONSE_BODY="${raw%$'\n'*}"
  [[ "$RESPONSE_STATUS" == 2* ]] || return 1
  return 0
}

# dd_render TEMPLATE_PATH VARS_JSON — print the rendered body on stdout.
#
# The `render()` in apply-monitors.sh was positional over nine `P_*` env vars,
# which is fine for one template family and useless for a second with different
# placeholders. This takes the variables as JSON so a caller supplies exactly
# the placeholders its own template names; `fill` still THROWS on a placeholder
# no variable supplies, so a typo is a hard failure rather than a literal
# `{{service}}` reaching the API.
dd_render() {
  TPL="$1" VARS_JSON="$2" node -e '
    const fs = require("node:fs");
    // Documentation-only keys, dropped at EVERY depth — MONEY-979 review.
    //
    // This was `for (const k of Object.keys(doc)) if (k.startsWith("_")) …`,
    // which strips the TOP LEVEL and nothing else. Every rendered body happened
    // to be clean, because every `_` key in both templates happens to sit at the
    // top — so the bug was one `"_note"` inside `options` away, and Datadog
    // rejects an unknown field there with a 400: a monitor that pages wrongly
    // would become a monitor that does not apply at all.
    //
    // It also could not fail the test that exists to catch it, which filtered
    // `Object.keys(m)` — the same one level. A rule enforced to exactly the
    // depth the bug is not at is the shape of every defect in this directory.
    //
    // BEFORE fill(), not after: `_placeholders` documents `{{job}}` and friends
    // as literal text, and fill() throws on a placeholder no variable supplies.
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
    const doc = strip(JSON.parse(fs.readFileSync(process.env.TPL, "utf8")));
    const vars = JSON.parse(process.env.VARS_JSON);
    const fill = (v) =>
      typeof v === "string"
        ? v.replace(/\{\{(\w+)\}\}/g, (m, k) => {
            if (!(k in vars)) throw new Error(`unknown placeholder ${m}`);
            return vars[k];
          })
        : Array.isArray(v)
          ? v.map(fill)
          : v && typeof v === "object"
            ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
            : v;
    const filled = fill(doc);
    // no_data_timeframe is minutes as an INTEGER; the template carries it as a
    // placeholder string, so it has to be coerced back after substitution.
    if (filled.options && "no_data_timeframe" in filled.options)
      filled.options.no_data_timeframe = Number(filled.options.no_data_timeframe);
    // Same coercion for a threshold that arrived as a placeholder. The
    // zero-write template hard-codes `0` (already a number and untouched here);
    // the latency template parameterises it, and Datadog rejects a monitor
    // whose threshold is the STRING "300" — with a 400 that names the field,
    // which is only obvious once you have seen it.
    // And the same for BOOLEAN options that arrived as placeholders. A template
    // can only carry `"{{x}}"`, so substitution always yields a string, and
    // Datadog rejects `"notify_no_data": "true"` — it wants the literal `true`.
    // Coerced from the STRING rather than from truthiness, because
    // `Boolean("false")` is true and would silently arm the one option this
    // repo most needs to be able to turn OFF (MONEY-1238: a no-data alarm on a
    // job that legitimately gaps longer than the alarm fires every weekend).
    for (const k of ["notify_no_data", "require_full_window", "include_tags", "is_enabled"]) {
      const v = filled.options?.[k];
      if (v === "true" || v === "false") filled.options[k] = v === "true";
    }
    for (const k of Object.keys(filled.options?.thresholds ?? {})) {
      const t = filled.options.thresholds[k];
      if (typeof t === "string") filled.options.thresholds[k] = Number(t);
    }
    const left = JSON.stringify(filled).match(/\{\{\w+\}\}/g);
    if (left) throw new Error(`unsubstituted placeholders: ${left.join(", ")}`);
    console.log(JSON.stringify(filled));
  '
}

# dd_list_managed TAG — GET the monitors carrying TAG into EXISTING_JSON.
#
# Fails CLOSED on both an unreachable listing and an unparsable one. Reading
# either as "no monitors exist" makes the next step POST a duplicate of every
# monitor in the set, and duplicates alert independently.
dd_list_managed() {
  local tag="$1"
  # `g` on the sed, because TAG may now be a comma-separated AND of several
  # tags (`managed-by:x,env:production`) and escaping only the first colon
  # leaves a raw `:` in the query string.
  if ! dd_request GET "https://${DD_API_HOST}/api/v1/monitor?monitor_tags=$(printf %s "$tag" | sed 's/:/%3A/g')"; then
    echo "FATAL: could not list existing monitors (HTTP ${RESPONSE_STATUS})" >&2
    echo "${RESPONSE_BODY}" >&2
    exit 1
  fi
  EXISTING_JSON="$RESPONSE_BODY"
  if ! EXISTING="$EXISTING_JSON" node -e '
    const v = JSON.parse(process.env.EXISTING);
    if (!Array.isArray(v)) throw new Error("expected an array of monitors");
  ' 2>/dev/null; then
    echo "FATAL: monitor listing was not a JSON array — refusing to POST" >&2
    echo "${RESPONSE_BODY}" >&2
    exit 1
  fi
}

# dd_upsert_monitor LABEL BODY — PUT when the rendered NAME already exists in
# EXISTING_JSON, POST when it does not. Appends to FAILED on error and
# increments APPLIED on success, so the caller's accounting is one convention.
dd_upsert_monitor() {
  local label="$1" body="$2" name id
  name="$(BODY="$body" node -e 'console.log(JSON.parse(process.env.BODY).name)')" || {
    FAILED+=("${label} (unreadable rendered body)")
    return 1
  }
  if $DRY_RUN; then
    echo "$body"
    APPLIED=$((APPLIED + 1))
    return 0
  fi
  id="$(EXISTING="$EXISTING_JSON" NAME="$name" node -e '
    const hit = JSON.parse(process.env.EXISTING).find((m) => m.name === process.env.NAME);
    if (hit) console.log(hit.id);
  ')"
  if [[ -n "$id" ]]; then
    if dd_request PUT "https://${DD_API_HOST}/api/v1/monitor/${id}" "$body"; then
      echo "   updated ${label} (#${id})"
      APPLIED=$((APPLIED + 1))
      return 0
    fi
    FAILED+=("${label} (PUT ${id}, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  else
    if dd_request POST "https://${DD_API_HOST}/api/v1/monitor" "$body"; then
      echo "   created ${label}"
      APPLIED=$((APPLIED + 1))
      return 0
    fi
    FAILED+=("${label} (POST, HTTP ${RESPONSE_STATUS}) ${RESPONSE_BODY}")
  fi
  return 1
}

# ── Drift between the code and the org ──────────────────────────────────────
#
# MONEY-1379. Every apply script UPSERTS by title and none of them deletes, so
# the estate can disagree with the repo in two directions and neither announces
# itself:
#
#   ORPHAN   a row deleted from a script leaves its monitor in Datadog, still
#            alerting, with nothing in the repo explaining what it watches or
#            why. `apply-monitors.sh` documents a MANUAL delete step for this.
#   MISSING  a row added to a script that nobody has run yet. The repo says the
#            thing is monitored; the org has never heard of it.
#
# `--only=verify` on each apply script renders its rows without writing and
# calls `dd_verify_managed`, so "the code and Datadog agree" becomes a checkable
# claim with an exit code rather than a belief.

# dd_verify_managed TAG EXCLUSIVE NAME... — 0 in sync, 3 drift.
#
# Read-only. NAMEs are what the caller RENDERED this run; the listing is what
# Datadog HOLDS under the managed tag. All three sets are printed because each
# implies a different action: an orphan is deleted, a missing name is applied,
# and "in both" is the only state in which the script describes reality.
#
# EXCLUSIVE says whether the CALLER IS THE ONLY WRITER OF THAT TAG, and getting
# it wrong makes this whole facility useless. `apply-monitors.sh` and
# `apply-service-monitors.sh` BOTH tag with — and both list by —
# `managed-by:apply-monitors`; measured 2026-09-11, the live org holds 75
# monitors under it. So each script sees the OTHER script's monitors as
# orphans, and a verify that counted them as drift would exit 3 on a perfectly
# synced estate, every time. An alarm that always fires is one somebody mutes,
# which is the exact defect class this directory exists to avoid.
#
# So with EXCLUSIVE=false the extra monitors are REPORTED and do NOT fail the
# run: from one script alone, "under this tag but not rendered by me" is not
# evidence of anything. The MISSING half is still authoritative either way —
# a name this script rendered that the org does not have is drift no matter who
# else shares the tag — and that is the half that catches "somebody edited the
# script and never applied it".
#
# There is no "could not list" return: `dd_list_managed` exits the process
# itself on an unreadable listing, which is the correct fail-closed behaviour
# and the reason this function does not try to report one.
#
# Leaves EXISTING_JSON populated, so a caller that wants to compare more than
# names (apply-perf-monitors.sh compares queries — a monitor hand-edited in the
# UI keeps its title) can do it from the same listing without a second request.
dd_verify_managed() {
  local tag="$1" exclusive="$2"
  shift 2
  # VALIDATED, because getting this argument wrong is silent in two directions.
  # A caller that forgets it entirely — `dd_verify_managed "$TAG" "${NAMES[@]}"`
  # — consumes the first rendered NAME as the flag: that name then disappears
  # from the code side, lands in the ignored "not mine" bucket, and the run
  # reports in sync while under-reporting by one. And only the literal `true`
  # means exclusive, so `True` / `1` / `yes` would quietly degrade to the
  # permissive mode on the one script whose orphan detection actually works.
  case "$exclusive" in
    true|false) ;;
    *)
      echo "FATAL: dd_verify_managed's second argument must be literally" >&2
      echo "       'true' or 'false' (got '${exclusive}'). Did a caller omit it" >&2
      echo "       and pass a monitor NAME into the flag?" >&2
      exit 1
      ;;
  esac
  dd_list_managed "$tag"
  RENDERED="$(printf '%s\n' "$@")" EXISTING="$EXISTING_JSON" \
    EXCLUSIVE="$exclusive" node -e '
    const exclusive = process.env.EXCLUSIVE === "true";
    const live = new Set(JSON.parse(process.env.EXISTING).map((m) => m.name));
    const code = new Set(process.env.RENDERED.split("\n").filter(Boolean));
    const both = [...code].filter((n) => live.has(n));
    const orphan = [...live].filter((n) => !code.has(n));
    const missing = [...code].filter((n) => !live.has(n));
    const row = (h, xs) =>
      console.log(`${h.padEnd(22)} ${xs.length}` + (xs.length ? "\n  - " + xs.join("\n  - ") : ""));
    row("in both", both);
    row(exclusive ? "only in Datadog" : "under the tag, not mine", orphan);
    row("only in code", missing);
    if (!exclusive && orphan.length)
      console.log(
        "\nThe tag is SHARED with another apply script, so the middle set is not\n" +
        "drift — it cannot be told apart from a sibling script’s monitors from\n" +
        "here. Only the last set fails this check.",
      );
    process.exit((exclusive ? orphan.length : 0) + missing.length ? 3 : 0);
  '
}

# dd_prune_managed TAG NAME... — DELETE every live monitor under TAG whose name
# was not rendered. Sets PRUNED; appends to the caller's FAILED[] on an error.
#
# Only `apply-perf-monitors.sh` calls this, and only because its managed tag is
# its OWN namespace: a monitor carrying `managed-by:apply-perf-monitors` that
# the script did not render is by definition an orphan of that script. The two
# older scripts SHARE `managed-by:apply-monitors` between them, so pruning from
# either would delete the other's monitors — which is why their documented
# remedy is a manual delete and why this is not wired into them.
#
# Never called on a --dry-run: a dry run does not list, so there is nothing to
# compare against and "would prune" would be a claim with no evidence behind it.
dd_prune_managed() {
  local tag="$1"
  shift
  PRUNED=0
  dd_list_managed "$tag"
  local victims
  victims="$(RENDERED="$(printf '%s\n' "$@")" EXISTING="$EXISTING_JSON" node -e '
    const code = new Set(process.env.RENDERED.split("\n").filter(Boolean));
    for (const m of JSON.parse(process.env.EXISTING))
      if (!code.has(m.name)) console.log(`${m.id}\t${m.name}`);
  ')"
  [[ -z "$victims" ]] && return 0
  local id name
  while IFS=$'\t' read -r id name; do
    [[ -z "$id" ]] && continue
    if dd_request DELETE "https://${DD_API_HOST}/api/v1/monitor/${id}"; then
      echo "   pruned ${name} (#${id})"
      PRUNED=$((PRUNED + 1))
    else
      FAILED+=("prune ${name} (#${id}): HTTP ${RESPONSE_STATUS} ${RESPONSE_BODY}")
    fi
  done <<< "$victims"
}

# ── Series-exists preflights ────────────────────────────────────────────────
#
# A monitor on a series nobody emits renders as NO DATA, which is
# indistinguishable from health once its no-data notification is muted. That is
# MONEY-1238's finding (a), and it shipped because nothing ever asked Datadog
# whether the series existed. Each of these asks, and the caller refuses the row
# when the answer is no.
#
# They return 0 (proceed) on --dry-run: there are no credentials there, and a
# dry run is a rendering check rather than a claim about the org.

# THREE outcomes, the same three `dd_events_exist` documents below:
#
#   0  the query ran and found points
#   1  the query ran and found none
#   2  the query DID NOT RUN — transport, auth, or an unparsable body
#
# 1 and 2 were ONE code, and the sibling function's comment already explains
# why that is a defect — it simply had not been applied here. Every existing
# caller tests zero-vs-non-zero and REFUSES on non-zero, so they are unaffected;
# what the split buys is that a caller which RETRIES can tell "the crawl has not
# landed yet" (retry) from "the app key is wrong" (stop and say so). Without it,
# a bad DD_APP_KEY or a single 429 spends the full retry window and then blames
# the thing being measured.
#
# The lookback is a PARAMETER, defaulting to the previous fixed 24h so no caller
# changes behaviour. 24h is right for a one-shot preflight and wrong for a
# re-runnable verify: it passes on yesterday's points no matter what is
# happening now.
dd_metric_has_points() {   # dd_metric_has_points "<metric query>" [lookback_seconds]
  $DRY_RUN && return 0
  local now from encoded
  now=$(date +%s)
  from=$((now - ${2:-86400}))
  encoded="$(QUERY="$1" node -e 'process.stdout.write(encodeURIComponent(process.env.QUERY))')"
  dd_request GET "https://${DD_API_HOST}/api/v1/query?from=${from}&to=${now}&query=${encoded}" || return 2
  BODY="$RESPONSE_BODY" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY); } catch { process.exit(2); }
    const s = doc?.series;
    if (!Array.isArray(s)) process.exit(2);
    process.exit(s.length > 0 ? 0 : 1);
  '
}

# THREE outcomes, never two:
#
#   0  the search ran and found events
#   1  the search ran and found none
#   2  the search DID NOT RUN — transport, auth, or a body that is not {data:[…]}
#
# 1 and 2 were one code, and that is only harmless while every caller uses the
# answer to REFUSE something. `apply-log-config.sh` uses it the other way round:
# an empty `status:error` is what AUTHORISES a permanent, org-wide status- and
# service-remapper over every nodejs line. Collapsed, an app key without
# `logs_read_data`, or a single 429 on the second search, makes both gates pass
# and the pipeline gets created on a measurement that never happened — while that
# file's own header promises "a run that cannot show the defect creates nothing".
#
# An unparsable body counts as 2 for the same reason: `JSON.parse` throwing used
# to exit 1, which is indistinguishable from a genuine empty result.
dd_events_exist() {        # dd_events_exist logs|rum "<search query>"
  $DRY_RUN && return 0
  local kind="$1" query="$2" path payload
  case "$kind" in
    logs) path="/api/v2/logs/events/search" ;;
    rum)  path="/api/v2/rum/events/search" ;;
    *) echo "dd_events_exist: unknown kind ${kind}" >&2; return 2 ;;
  esac
  payload="$(Q="$query" node -e '
    process.stdout.write(JSON.stringify({
      filter: { query: process.env.Q, from: "now-24h", to: "now" },
      page: { limit: 1 },
    }));
  ')" || return 2
  dd_request POST "https://${DD_API_HOST}${path}" "$payload" || return 2
  BODY="$RESPONSE_BODY" node -e '
    let doc;
    try { doc = JSON.parse(process.env.BODY); } catch { process.exit(2); }
    if (!Array.isArray(doc?.data)) process.exit(2);
    process.exit(doc.data.length > 0 ? 0 : 1);
  '
}
