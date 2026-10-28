/**
 * Probe & pin NSE/BSE archive unknowns — MONEY-1096 (Data Engine P1)
 * ==========================================================================
 *
 * A ONE-OFF reconnaissance script. It answers "does this file/endpoint exist,
 * and how far back does it go?" for the ~15 NSE/BSE archive unknowns the
 * Jul-2026 audit could not settle, and writes the answers out as the registry
 * seed that P2 (`report-archive-sync`) and P3 (full-history backfill) build on.
 *
 * It reads. It never writes anything except two files under `docs/reference/`.
 * No Prisma, no GCS, no DB, no product code — deliberately, because the whole
 * point is to learn what is REACHABLE before committing to a schema.
 *
 * ## Why this has to run from OUR egress, and why it is paranoid about it
 *
 * The audit sandbox could not reach BSE at all, and NSE/BSE both make
 * availability a function of WHO is asking: they 403 obvious bot user agents,
 * they rate-limit by IP, and — the nasty one — they answer a throttled request
 * with `200 OK` carrying an HTML challenge page rather than an error status.
 * So "is `MTO_01041999.DAT` published?" is not answerable from a datasheet; it
 * is only answerable by asking, from the same IP that will later do the
 * fetching.
 *
 * That is also the danger. This egress is the one `bhavcopy-sync` uses every
 * weekday at 21:00 IST to seed close prices for the entire listed universe. If
 * a probe run gets this IP blocked, the blast radius is not "the probe failed",
 * it is "the platform has no EOD prices". Every guard below exists for that
 * reason and none of them is decorative:
 *
 *   - **1 request/second, globally.** Not per host — the total. Slower than a
 *     human clicking around the site.
 *   - **A hard {@link MAX_REQUESTS} budget.** Probes that do not fit are
 *     recorded as `SKIPPED_BUDGET` rather than silently dropped, so the report
 *     can never imply "we checked" when we ran out of room.
 *   - **Stop-on-403 per host.** The FIRST 403 from a host cancels every
 *     remaining probe against that host. A 403 here means "you are being
 *     throttled", and the worst possible response is to keep asking.
 *
 * ## Why it re-implements the fetch instead of calling `fetchExchangeAsset`
 *
 * `packages/core/src/market-data/exchange-feed.ts` is the production seam, and
 * it is deliberately LOSSY: it maps 404 to `null` (meaning "non-trading day")
 * and throws on every other non-OK status. Both are correct for an ingest job
 * and useless for a probe — the raw status code IS the finding here, and a 403
 * has to be caught and reasoned about, not thrown.
 *
 * So this script goes around the helper but imports its header CONSTANTS
 * ({@link EXCHANGE_USER_AGENT}, the referers) rather than copying them. That
 * matters: the probe's whole value is that it observed what production will
 * observe, which is only true while the two send identical headers. A copied UA
 * string would drift the moment someone bumps the Chrome version in
 * exchange-feed.ts, and the report would quietly start describing a client we
 * no longer are.
 *
 * ## Reading the output
 *
 * Every probe records an HTTP status, the response's first
 * {@link PREVIEW_BYTES} bytes, and a VERDICT. The verdict is the part that
 * needs care, because on these hosts `200 OK` does not mean "the file exists":
 *
 *   PRESENT  200 + a body that actually looks like the feed
 *   EMPTY    200 + a well-formed but zero-row body (endpoint valid, no data)
 *   HTML     200 + an HTML page — a challenge/error page wearing a success code
 *   ABSENT   404 — genuinely not published
 *   BLOCKED  403/401 — throttled; trips this host's breaker
 *   ERROR    any other non-OK status
 *   NETWORK  the request never completed
 *
 * Collapsing HTML into PRESENT is the specific failure this script is built to
 * avoid: it would enter a floor date into the registry for a file that does not
 * exist, and P3 would then backfill a decade of throttle pages. `feed-payload.ts`
 * exists in core for exactly the same reason.
 *
 * ## Usage
 *
 *   node --import tsx scripts/data/probe-exchange-archives.ts            # run
 *   node --import tsx scripts/data/probe-exchange-archives.ts --dry-run  # plan
 *   node --import tsx scripts/data/probe-exchange-archives.ts --only=bse
 *
 * `--dry-run` prints the full probe plan and makes ZERO requests — review what
 * it will touch before pointing it at prod egress. `--only=<substring>` filters
 * by group id (`nse-archives`, `nse-api`, `bse-www`, `bse-api`, `bse-results`)
 * so a follow-up question does not cost a whole budget.
 *
 * **`--only` still overwrites both reports, with only the groups it ran.** It
 * is for answering a question at the terminal, not for updating the registry
 * seed — a partial file here looks exactly like a full one that lost feeds. To
 * refresh the committed artifacts, always run the whole thing.
 *
 * Outputs (both overwritten atomically):
 *   docs/reference/exchange-archive-probe.json   machine-readable, every probe
 *   docs/reference/exchange-archive-ranges.md    the human registry seed
 *
 * `--registry` (MONEY-1097) instead verifies every `REPORT_REGISTRY` row
 * against live and writes its own pair of files, so it can never overwrite the
 * seed above:
 *
 *   node --import tsx scripts/data/probe-exchange-archives.ts --registry --max=80
 *   docs/reference/exchange-registry-verification.json
 *   docs/reference/exchange-registry-verification.md
 */

import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXCHANGE_USER_AGENT,
  BSE_REFERER,
  NSE_REFERER,
  allFamilies,
  type ReportFamily,
} from "@usemoney/core/market-data";

// ─── Budget & pacing ─────────────────────────────────────────────────

/**
 * Hard ceiling on HTTP requests for one run. The ticket says "max ~60".
 *
 * It is a CEILING, not a target — the plan below spends ~45, leaving headroom
 * for the trading-day walk-back and the floor refinement, both of which consume
 * an amount that is only known at runtime.
 *
 * `--max=N` raises it for `--registry` runs, which probe ~50 registry rows and
 * legitimately need more than the P1 question set did. The pacing and the 403
 * breaker are NOT adjustable — those are the guards that protect the egress,
 * and a bigger budget is only safe because they still apply.
 */
const MAX_REQUESTS = (() => {
  const raw = process.argv
    .find((a) => a.startsWith("--max="))
    ?.slice("--max=".length);
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60;
})();

/** Minimum gap between ANY two requests, across all hosts. 1 rps. */
const MIN_REQUEST_INTERVAL_MS = 1_000;

/** Per-request timeout. Matches `EXCHANGE_FETCH_TIMEOUT_MS` in core. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How much of each response body to keep as evidence. */
const PREVIEW_BYTES = 200;

/**
 * Cap on extra requests spent narrowing a floor once the fixed ladder has
 * bracketed it. Bounded because bisection is unbounded by nature and the
 * budget is shared with every other probe.
 */
const MAX_REFINE_STEPS = 3;

// ─── Types ───────────────────────────────────────────────────────────

type Verdict =
  | "PRESENT"
  | "EMPTY"
  | "HTML"
  | "ABSENT"
  | "BLOCKED"
  | "ERROR"
  | "NETWORK"
  | "SKIPPED_BLOCKED"
  | "SKIPPED_BUDGET"
  /** The registry row deliberately builds no URL — nothing to ask. */
  | "NO_URL";

interface ProbeResult {
  /** Stable id, e.g. "nse-archives/cm-1994/03NOV1994". */
  id: string;
  /** Group id — also the `--only` filter key. */
  group: string;
  /** The audit question this probe answers, in words. */
  question: string;
  url: string;
  verdict: Verdict;
  status: number | null;
  contentType: string | null;
  bytes: number | null;
  /** First {@link PREVIEW_BYTES} bytes, as text or hex. */
  preview: string | null;
  /** Anything the probe wants the reader to know. */
  note?: string;
}

/** A resolved answer distilled from one or more probes. */
interface Finding {
  group: string;
  /** Feed family, e.g. "NSE CM bhavcopy (legacy `cmDDMMMYYYYbhav`)". */
  feed: string;
  /** URL pattern with `{tokens}`, for the P2 registry. */
  pattern: string;
  /** What we concluded — a floor date, a param set, "not published", … */
  answer: string;
  /** Probe ids backing the answer. */
  evidence: string[];
}

// ─── CLI ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const ONLY = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);

/**
 * `--registry` — verify `REPORT_REGISTRY` (MONEY-1097) against live, instead of
 * running the P1 question set.
 *
 * This is the loop-closer for the registry's `enabled` flag. P1 verified about
 * a dozen URL patterns; the rest were written from knowledge of NSE's archive
 * layout and ship `enabled: false` precisely because a guessed path 404s
 * IDENTICALLY to a market holiday, so a wrong one would never announce itself.
 * This mode asks the exchange, once per row, and prints the answer — flip
 * `enabled` from that, never from confidence.
 */
const REGISTRY_MODE = argv.includes("--registry");

/**
 * `--floors` — bracket the REAL historical floor of each backfillable family
 * (MONEY-941 step 0d).
 *
 * 28 enabled families carry `startDate: "2020-01-01"`, which is the `nse()`
 * helper's default rather than evidence. A backfill driven off a guessed floor
 * fails in whichever direction the guess is wrong: too late and years of real
 * history are never fetched; too early and the walker grinds through years of
 * 404s that are indistinguishable from market holidays.
 *
 * ## Why it does NOT bisect
 *
 * P1 established that NSE's archive is SPARSE, not monotonic: 1994-11-03 is
 * present, 1994-11-04 is a genuine 404, 1994-12-01 is present again. Bisection
 * assumes a single edge and will happily converge on a hole in the middle of a
 * live range. So this walks COARSE-TO-FINE with a K-miss rule instead: a year
 * only counts as absent when several sampled weekdays in it all miss, and the
 * descent only stops after several consecutive absent years.
 *
 * The output is a BRACKET, deliberately. Exact edges are the backfill walker's
 * job — it visits every trading day anyway.
 */
const FLOORS_MODE = argv.includes("--floors");

/** Weekdays sampled per candidate year before calling it absent. */
const YEAR_SAMPLES = 3;

/** Consecutive absent years that end the descent. */
const MAX_EMPTY_YEARS = 2;

/** Hard cap on probes per family, so one deep family cannot eat the budget. */
const MAX_PROBES_PER_FAMILY = 26;

// ─── Run state ───────────────────────────────────────────────────────

const results: ProbeResult[] = [];
const findings: Finding[] = [];

/** Hosts that answered 403. Every later probe against them is skipped. */
const blockedHosts = new Set<string>();

let requestsMade = 0;
let lastRequestAt = 0;

/**
 * Bodies deliberately retained for later analysis, keyed by probe id.
 *
 * Only used where a question needs the CONTENT, not just the status — e.g.
 * "do BSE EGR rows appear in the CM UDiFF file?" is answered by grepping a
 * bhavcopy we already downloaded, which is why that question costs 0 extra
 * requests instead of another hit on a host we are trying not to annoy.
 */
const retainedBodies = new Map<string, Buffer>();

// ─── Small helpers ───────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Enforce the global 1 rps floor before a request goes out. */
async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

/**
 * Render the first {@link PREVIEW_BYTES} bytes as evidence.
 *
 * Text when the bytes are mostly printable, hex otherwise — the NSE bhavcopy
 * is a ZIP, and `PK\x03\x04…` rendered as mojibake tells the reader nothing
 * while `504b0304` immediately says "a real archive came back".
 */
function preview(buf: Buffer): string {
  const head = buf.subarray(0, PREVIEW_BYTES);
  let printable = 0;
  for (const b of head) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
  }
  const looksTextual = head.length > 0 && printable / head.length > 0.85;
  return looksTextual
    ? head.toString("utf8").replace(/\s+/g, " ").trim()
    : `hex:${head.toString("hex")}`;
}

/**
 * Decide what a response actually means.
 *
 * The ordering is the substance. Status codes are checked first because a 403
 * has to trip the breaker regardless of what the body looks like; then the
 * HTML check, because it is the one that catches a throttle page masquerading
 * as data; then emptiness, so "endpoint is valid but has no rows" stays
 * distinguishable from "endpoint is wrong" — that distinction is precisely
 * what the EGR and PIT-bulk questions turn on.
 */
function classify(status: number, buf: Buffer, contentType: string): Verdict {
  if (status === 403 || status === 401) return "BLOCKED";
  if (status === 404) return "ABSENT";
  if (status < 200 || status >= 300) return "ERROR";
  if (buf.length === 0) return "EMPTY";

  const head = buf.subarray(0, 512).toString("utf8").trim().toLowerCase();
  if (
    contentType.includes("text/html") ||
    head.startsWith("<!doctype") ||
    head.startsWith("<html") ||
    head.includes("<head>")
  ) {
    return "HTML";
  }

  // JSON endpoints: an empty array / empty `data` is a real, meaningful answer
  // ("the endpoint exists, it just has nothing"), not a failure.
  if (head.startsWith("{") || head.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(buf.toString("utf8"));
      if (Array.isArray(parsed))
        return parsed.length === 0 ? "EMPTY" : "PRESENT";
      if (parsed && typeof parsed === "object") {
        const rec = parsed as Record<string, unknown>;
        const rows = rec.data ?? rec.Table ?? rec.rows ?? rec.records;
        if (Array.isArray(rows)) return rows.length === 0 ? "EMPTY" : "PRESENT";
        // A bare `{}` is how BSE's JSON endpoints say "nothing here" — both
        // `IndexArchDailyAll` and `AnnSubCategoryGetData` answered exactly that
        // on the first run, and falling through scored them PRESENT, which is
        // how a feed that returned NO DATA would have entered the registry as
        // working. An object with no keys is empty in every sense that matters.
        if (Object.keys(rec).length === 0) return "EMPTY";
      }
    } catch {
      // Malformed JSON from a JSON endpoint is not "present" in any useful
      // sense; fall through so it is reported on its bytes alone.
    }
  }

  return "PRESENT";
}

// ─── The probe runner ────────────────────────────────────────────────

interface ProbeSpec {
  id: string;
  group: string;
  question: string;
  url: string;
  /** Extra/override headers (JSON endpoints, cookies). */
  headers?: Record<string, string>;
  /** Keep the body in {@link retainedBodies} for later analysis. */
  keepBody?: boolean;
}

/** Exchange-feed's header contract, rebuilt from the imported constants. */
function exchangeHeaders(referer: string): Record<string, string> {
  return {
    "User-Agent": EXCHANGE_USER_AGENT,
    Referer: referer,
    Origin: referer.replace(/\/$/, ""),
    Accept: "text/csv,application/zip,application/octet-stream,*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

function refererFor(url: string): string {
  return new URL(url).host.includes("bseindia") ? BSE_REFERER : NSE_REFERER;
}

function record(r: ProbeResult): ProbeResult {
  results.push(r);
  const tag = r.verdict.padEnd(15);
  const status = r.status === null ? "---" : String(r.status);
  console.log(
    `  ${tag} ${status.padStart(3)}  ${r.id}` +
      (r.bytes !== null ? `  (${r.bytes} bytes)` : ""),
  );
  if (r.preview)
    console.log(`                    ↳ ${r.preview.slice(0, 140)}`);
  return r;
}

/**
 * Run one probe, honouring the budget and the per-host breaker.
 *
 * Never throws: a probe that cannot run is a RESULT (`SKIPPED_*` / `NETWORK`),
 * because a report that silently omits a question is worse than one that says
 * "did not ask". Callers can branch on `verdict` without a try/catch.
 */
async function probe(spec: ProbeSpec): Promise<ProbeResult> {
  const base: Omit<ProbeResult, "verdict"> = {
    id: spec.id,
    group: spec.group,
    question: spec.question,
    url: spec.url,
    status: null,
    contentType: null,
    bytes: null,
    preview: null,
  };

  const host = new URL(spec.url).host;

  // A dry run prints the plan and asks nothing. Note the honest limitation:
  // several probes BRANCH on an earlier result (the trading-day walk-back, the
  // floor refinement), and with no results to branch on those take their
  // inconclusive path — so the dry-run plan is a SUPERSET of the cheap cases
  // and a subset of the expensive ones. It is for reviewing which hosts and
  // paths get touched, not for predicting the exact request count.
  if (DRY_RUN) {
    console.log(
      `  PLAN                 ${spec.id}\n                    ↳ ${spec.url}`,
    );
    return {
      ...base,
      verdict: "SKIPPED_BUDGET",
      note: "dry run — not requested",
    };
  }

  if (blockedHosts.has(host)) {
    return record({
      ...base,
      verdict: "SKIPPED_BLOCKED",
      note: `${host} already answered 403; remaining probes on this host were cancelled to avoid deepening the throttle.`,
    });
  }

  if (requestsMade >= MAX_REQUESTS) {
    return record({
      ...base,
      verdict: "SKIPPED_BUDGET",
      note: `request budget (${MAX_REQUESTS}) exhausted before this probe ran — NOT an availability finding.`,
    });
  }

  await pace();
  requestsMade++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(spec.url, {
      headers: spec.headers ?? exchangeHeaders(refererFor(spec.url)),
      signal: controller.signal,
      redirect: "follow",
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "";
    const verdict = classify(res.status, buf, contentType);

    if (verdict === "BLOCKED") {
      blockedHosts.add(host);
      console.warn(
        `\n  ⚠ 403 from ${host} — tripping the breaker. Every remaining probe ` +
          `on this host will be skipped.\n`,
      );
    }

    if (spec.keepBody && buf.length > 0) retainedBodies.set(spec.id, buf);

    return record({
      ...base,
      verdict,
      status: res.status,
      contentType: contentType || null,
      bytes: buf.length,
      preview: preview(buf),
    });
  } catch (err) {
    return record({
      ...base,
      verdict: "NETWORK",
      note: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** True when a verdict means "the resource is really there". */
function isPresent(r: ProbeResult): boolean {
  return r.verdict === "PRESENT";
}

/** True when the probe answered the question at all (vs. skipped/blocked). */
function isConclusive(r: ProbeResult): boolean {
  return (
    r.verdict !== "SKIPPED_BLOCKED" &&
    r.verdict !== "SKIPPED_BUDGET" &&
    r.verdict !== "NETWORK"
  );
}

// ─── Date helpers ────────────────────────────────────────────────────
//
// Every exchange filename token is keyed to the IST trading date. The +5:30
// shift is done explicitly rather than trusting the host TZ — same convention
// as `istParts` in core's bhavcopy.ts.

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function istParts(d: Date): { y: number; m: number; d: number } {
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    y: ist.getUTCFullYear(),
    m: ist.getUTCMonth() + 1,
    d: ist.getUTCDate(),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYYMMDD` — UDiFF filenames. */
const tokYYYYMMDD = (d: Date): string => {
  const { y, m, d: dd } = istParts(d);
  return `${y}${pad2(m)}${pad2(dd)}`;
};

/** `DDMMYYYY` — MTO / sec_bhavdata_full. */
const tokDDMMYYYY = (d: Date): string => {
  const { y, m, d: dd } = istParts(d);
  return `${pad2(dd)}${pad2(m)}${y}`;
};

/** `DDMMYY` — legacy PR / EQ_ISINCODE zips. */
const tokDDMMYY = (d: Date): string => {
  const { y, m, d: dd } = istParts(d);
  return `${pad2(dd)}${pad2(m)}${String(y).slice(-2)}`;
};

/** `DDMM` — BSE gross-delivery SCBSEALL. */
const tokDDMM = (d: Date): string => {
  const { m, d: dd } = istParts(d);
  return `${pad2(dd)}${pad2(m)}`;
};

/** `DDMMMYYYY` uppercase — legacy NSE cm bhavcopy. */
const tokDDMMMYYYY = (d: Date): string => {
  const { y, m, d: dd } = istParts(d);
  return `${pad2(dd)}${MONTHS[m - 1]}${y}`;
};

/** `DD-Mon-YYYY` — the NSE `/api/reports` archives door. */
const tokDashMon = (d: Date): string => {
  const { y, m, d: dd } = istParts(d);
  const mon = MONTHS[m - 1]!;
  return `${pad2(dd)}-${mon[0]}${mon.slice(1).toLowerCase()}-${y}`;
};

/** `DD/MM/YYYY` — BSE's api.bseindia.com date params. */
const tokSlash = (d: Date): string => {
  const { y, m, d: dd } = istParts(d);
  return `${pad2(dd)}/${pad2(m)}/${y}`;
};

/** Parse `YYYY-MM-DD` at UTC noon, so the +5:30 shift cannot cross a day. */
function day(iso: string): Date {
  return new Date(`${iso}T12:00:00.000Z`);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** Most recent Mon–Fri on or before `d` (IST). Holidays are not modelled. */
function lastWeekday(d: Date): Date {
  let cur = d;
  for (let i = 0; i < 7; i++) {
    const ist = new Date(cur.getTime() + 5.5 * 60 * 60 * 1000);
    const dow = ist.getUTCDay();
    if (dow !== 0 && dow !== 6) return cur;
    cur = addDays(cur, -1);
  }
  return cur;
}

// ─── Floor bracketing ────────────────────────────────────────────────

/**
 * Turn a ladder of probes into a floor statement.
 *
 * A fixed ladder can only ever produce a BRACKET — "absent at X, present at Y"
 * — never an exact floor, and saying otherwise in the registry would be a
 * fabrication that P3 then acts on. So the answer is phrased as the bracket it
 * actually is, and {@link refineFloor} narrows it only as far as the leftover
 * budget honestly allows.
 *
 * ## Why it checks for SPARSENESS first
 *
 * "Floor" presumes availability is MONOTONIC in time: absent before some date,
 * present ever after. The first live run disproved that for NSE's oldest cash
 * archive — 1994-11-03 present, 1994-11-04 absent, 1994-12-01 present. The
 * original take-first-present / take-last-absent arithmetic does not notice,
 * and it emitted the interval `(1994-11-04, 1994-11-03]`: backwards, and
 * meaningless as a backfill instruction.
 *
 * A sparse archive is a genuinely different fact from a late-starting one, and
 * it changes P3's design — a backfill over a sparse range must tolerate holes
 * per-day rather than treat the first 404 as the end of history. So it is
 * reported as sparseness, not smoothed into a floor.
 */
function bracket(rungs: Array<{ date: string; result: ProbeResult }>): {
  answer: string;
  latestAbsent?: string;
  earliestPresent?: string;
} {
  const conclusive = rungs.filter((r) => isConclusive(r.result));
  if (conclusive.length === 0) {
    return {
      answer: "INCONCLUSIVE — no rung of the ladder returned an answer",
    };
  }

  // Ladders are built in ascending date order; sort anyway so the reasoning
  // below cannot be broken by a caller that reorders its rungs.
  const ordered = [...conclusive].sort((a, b) => a.date.localeCompare(b.date));
  const present = ordered.filter((r) => isPresent(r.result));
  const absent = ordered.filter((r) => r.result.verdict === "ABSENT");

  // ── Rungs that answered, but answered NOTHING about availability ──
  //
  // `isConclusive` only means "the probe completed". HTML / EMPTY / ERROR all
  // pass it and none of them is evidence either way: BSE serves its SPA
  // catch-all page with a 200 for a missing file, so an HTML rung tells you the
  // path did not resolve to a FILE — not that the file does not exist.
  //
  // Sorting those into neither bucket is what produced a fabricated finding on
  // the first run. All three `EQ_ISINCODE` rungs came back 200 + text/html,
  // 13,850 bytes, zero 404s; `present.length === 0` was therefore true and the
  // report published "NOT AVAILABLE at any probed date". That sentence became
  // "BSE's pre-UDiFF EQ_ISINCODE zips are gone entirely" in four other files.
  // The HTML verdict exists precisely to stop a 200-with-a-page being read as
  // data — and this function threw that away one layer up.
  const indeterminate = ordered.filter(
    (r) => !isPresent(r.result) && r.result.verdict !== "ABSENT",
  );

  if (present.length === 0) {
    // Only a ladder of real 404s can support "not available". Anything else is
    // an unanswered question, and it must READ like one.
    if (absent.length === 0) {
      return {
        answer:
          `INDETERMINATE — no rung returned either a file or a 404. Verdicts: ` +
          `${indeterminate.map((r) => `${r.date}=${r.result.verdict}`).join(", ")}. ` +
          `A 200 carrying an HTML page means the path did not resolve to a file; ` +
          `it is NOT evidence that the file is unavailable. Re-probe before ` +
          `concluding anything about this feed.`,
      };
    }
    return {
      answer:
        `NOT AVAILABLE — 404 at ${absent.map((r) => r.date).join(", ")}` +
        (indeterminate.length > 0
          ? `; ${indeterminate.length} further rung(s) were INDETERMINATE (${indeterminate
              .map((r) => `${r.date}=${r.result.verdict}`)
              .join(", ")}) and support no conclusion`
          : ""),
      latestAbsent: absent[absent.length - 1]?.date,
    };
  }

  const earliestPresent = present[0]!.date;

  // Holes AFTER the first hit mean the archive is sparse, not late-starting.
  const holes = absent
    .filter((r) => r.date > earliestPresent)
    .map((r) => r.date);
  if (holes.length > 0) {
    return {
      answer:
        `SPARSE — not a clean floor. Earliest confirmed file ${earliestPresent}, ` +
        `but ${holes.length} later probed date(s) are MISSING (${holes.join(", ")}). ` +
        `P3 must treat 404s inside the range as holes, not as the end of history.`,
      earliestPresent,
    };
  }

  if (absent.length === 0) {
    // "at every probed date" must not be claimed over rungs that never
    // answered — an HTML,HTML,PRESENT ladder is one hit, not three.
    return {
      answer:
        indeterminate.length > 0
          ? `earliest CONFIRMED file ${earliestPresent}; ${indeterminate.length} rung(s) were INDETERMINATE (${indeterminate
              .map((r) => `${r.date}=${r.result.verdict}`)
              .join(
                ", ",
              )}) so the floor is NOT bracketed — re-probe those dates`
          : `available at every probed date; floor is at or before ${earliestPresent} (not bracketed — probe earlier to pin it)`,
      earliestPresent,
    };
  }

  const latestAbsent = absent[absent.length - 1]!.date;
  return {
    answer: `floor is in (${latestAbsent}, ${earliestPresent}] — absent at ${latestAbsent}, present at ${earliestPresent}`,
    latestAbsent,
    earliestPresent,
  };
}

/** `YYYY-MM-DD` for a Date, in IST. */
function isoOf(d: Date): string {
  const p = istParts(d);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/**
 * Bisect a bracketed floor a few more steps, budget permitting.
 *
 * Capped at {@link MAX_REFINE_STEPS} and it stops the moment the budget gets
 * tight, because refinement is the LEAST valuable thing a leftover request can
 * buy — an unasked question is a hole in the registry, whereas a floor known to
 * a month instead of a week is merely imprecise.
 *
 * ## Midpoints are snapped to a weekday, and why that was not optional
 *
 * These files only exist for TRADING days, so a 404 carries two possible
 * meanings and bisection only works on one of them. The first live run walked
 * the MTO floor onto 2001-03-31 (a Saturday) and 2002-03-31 (a Sunday); both
 * 404'd for the boring reason, both were read as "the archive does not go back
 * this far", and each one shoved `lo` forward. A bisection that mistakes a
 * weekend for the edge of history converges confidently on the wrong date.
 *
 * Snapping to the preceding weekday removes the systematic half of that error.
 * It does NOT remove exchange holidays — Diwali, Holi and the rest are not
 * modelled here — so a refined bound is reported as APPROXIMATE and a single
 * absent rung is never treated as proof on its own.
 */
async function refineFloor(
  group: string,
  idPrefix: string,
  question: string,
  buildUrl: (d: Date) => string,
  latestAbsentIso: string,
  earliestPresentIso: string,
): Promise<{ result: string; probes: ProbeResult[] }> {
  let lo = day(latestAbsentIso);
  let hi = day(earliestPresentIso);
  const probes: ProbeResult[] = [];

  for (let step = 0; step < MAX_REFINE_STEPS; step++) {
    const gapDays = Math.round((hi.getTime() - lo.getTime()) / 86_400_000);
    if (gapDays <= 1) break;
    if (requestsMade >= MAX_REQUESTS - 2) break;

    const mid = lastWeekday(addDays(lo, Math.floor(gapDays / 2)));
    // Snapping can land back on a bound (a narrow weekend-spanning gap). There
    // is nothing left to learn from re-asking a date we already have.
    if (mid.getTime() <= lo.getTime() || mid.getTime() >= hi.getTime()) break;

    const r = await probe({
      id: `${idPrefix}/refine-${isoOf(mid)}`,
      group,
      question,
      url: buildUrl(mid),
    });
    probes.push(r);

    if (!isConclusive(r)) break;
    // Only a real 404 may move the LOWER bound. `else` used to swallow HTML,
    // EMPTY and ERROR too, so a single throttle page — likely by this point,
    // ~30 requests deep into the same host — would be read as "history stops
    // here" and shove `lo` years forward, publishing a floor that is both
    // wrong and MORE precise-looking than the honest bracket it replaced.
    // Stopping is the safe move: the caller keeps the un-refined bracket.
    if (isPresent(r)) hi = mid;
    else if (r.verdict === "ABSENT") lo = mid;
    else break;
  }

  return {
    result: `narrowed to approximately (${isoOf(lo)}, ${isoOf(hi)}] (weekends skipped; exchange holidays NOT modelled, so the lower bound may still sit on a holiday)`,
    probes,
  };
}

// ─── NSE cookie session ──────────────────────────────────────────────

/**
 * Warm an NSE session cookie, mirroring `packages/research/src/data-sources/
 * nse-filings.ts`.
 *
 * `www.nseindia.com/api/*` sits behind Akamai and returns an HTML challenge to
 * a cookieless client. The documented quirk, carried over from nse-filings, is
 * that a **403 on the warm-up still sets the cookies you need** — so this one
 * request is deliberately EXEMPT from the breaker. Tripping on it would cancel
 * every `/api` probe over the handshake those probes depend on.
 *
 * It still costs budget, because it is still a request to a host we are being
 * careful with.
 */
async function warmNseSession(): Promise<string> {
  // This function deliberately bypasses `probe()` so the breaker cannot trip on
  // it — which also means it bypasses probe()'s dry-run guard, and the first
  // dry run duly fired one live request at www.nseindia.com. Exempting a helper
  // from ONE policy quietly exempts it from every policy that shares the same
  // choke point; the guard has to be restated here.
  if (DRY_RUN) {
    console.log(
      `  PLAN                 nse-api/session-warmup\n                    ↳ ${NSE_REFERER}`,
    );
    return "";
  }
  if (requestsMade >= MAX_REQUESTS) return "";
  await pace();
  requestsMade++;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(NSE_REFERER, {
      headers: {
        "User-Agent": EXCHANGE_USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    const cookies = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .filter((c): c is string => Boolean(c && c.includes("=")))
      .join("; ");
    console.log(
      `  session        ${res.status}  nse cookie warm-up ` +
        `(${cookies ? `${cookies.split(";").length} cookies` : "NO COOKIES"})`,
    );
    return cookies;
  } catch (err) {
    console.warn(
      `  session        ---  nse cookie warm-up failed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** Header set for a cookie-gated `www.nseindia.com/api/*` JSON call. */
/**
 * Header set for a cookie-gated `www.nseindia.com/api/*` JSON call.
 *
 * `refererPath` is the site page that OWNS the XHR, and it is not cosmetic.
 * The first run sent `all-reports` as the Referer for every endpoint and
 * `corporates-pit` answered `200 {"acqNameList":[],"data":[]}` — a well-formed
 * response from a working endpoint with nothing in it, for a 30-day window over
 * the whole market, which is not a plausible amount of insider trading. NSE
 * gates several `/api/*` routes on the Referer matching the page the browser
 * would have made the call from, and answers a mismatch with an empty result
 * set rather than an error. An empty 200 is therefore ambiguous until the
 * Referer is right, which is why each probe now names its own page.
 */
function nseApiHeaders(
  cookie: string,
  refererPath = "all-reports",
): Record<string, string> {
  return {
    "User-Agent": EXCHANGE_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${NSE_REFERER}${refererPath}`,
    "X-Requested-With": "XMLHttpRequest",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

/** `--only=` filter. */
function shouldRun(group: string): boolean {
  if (!ONLY) return true;
  return group.includes(ONLY);
}

// ─── URL builders (one per feed family) ──────────────────────────────

const NSE_ARCHIVES = "https://nsearchives.nseindia.com";
const BSE_WWW = "https://www.bseindia.com";
const BSE_API = "https://api.bseindia.com/BseIndiaAPI/api";

/** Legacy NSE cash bhavcopy: /content/historical/EQUITIES/{YYYY}/{MON}/cm{DDMMMYYYY}bhav.csv.zip */
const urlLegacyCm = (d: Date): string => {
  const { y, m } = istParts(d);
  return `${NSE_ARCHIVES}/content/historical/EQUITIES/${y}/${MONTHS[m - 1]}/cm${tokDDMMMYYYY(d)}bhav.csv.zip`;
};

/** NSE market-to-order (delivery) DAT: /archives/equities/mto/MTO_{DDMMYYYY}.DAT */
const urlMto = (d: Date): string =>
  `${NSE_ARCHIVES}/archives/equities/mto/MTO_${tokDDMMYYYY(d)}.DAT`;

/** NSE full price+delivery CSV: /products/content/sec_bhavdata_full_{DDMMYYYY}.csv */
const urlSecBhavFull = (d: Date): string =>
  `${NSE_ARCHIVES}/products/content/sec_bhavdata_full_${tokDDMMYYYY(d)}.csv`;

/** NSE PR (full daily report bundle): /archives/equities/bhavcopy/pr/PR{DDMMYY}.zip */
const urlPr = (d: Date): string =>
  `${NSE_ARCHIVES}/archives/equities/bhavcopy/pr/PR${tokDDMMYY(d)}.zip`;

/** NSE currency-derivatives UDiFF: /archives/cd/bhav/BhavCopy_NSE_CD_… */
const urlUdiffCd = (d: Date): string =>
  `${NSE_ARCHIVES}/archives/cd/bhav/BhavCopy_NSE_CD_0_0_0_${tokYYYYMMDD(d)}_F_0000.csv.zip`;

/** NSE commodity UDiFF: /content/com/BhavCopy_NSE_CO_… */
const urlUdiffCom = (d: Date): string =>
  `${NSE_ARCHIVES}/content/com/BhavCopy_NSE_CO_0_0_0_${tokYYYYMMDD(d)}_F_0000.csv.zip`;

/** BSE cash UDiFF (note: capital-B `BhavCopy` directory). */
const urlBseCm = (d: Date): string =>
  `${BSE_WWW}/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${tokYYYYMMDD(d)}_F_0000.CSV`;

/** BSE F&O UDiFF (note: lowercase-c `Bhavcopy` directory — deliberate). */
const urlBseFo = (d: Date): string =>
  `${BSE_WWW}/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_${tokYYYYMMDD(d)}_F_0000.CSV`;

/** BSE currency UDiFF — a GUESS by analogy with CM/FO; this probe verifies it. */
const urlBseCd = (d: Date): string =>
  `${BSE_WWW}/download/Bhavcopy/Currency/BhavCopy_BSE_CD_0_0_0_${tokYYYYMMDD(d)}_F_0000.CSV`;

/** BSE gross delivery: /BSEDATA/gross/{YYYY}/SCBSEALL{DDMM}.zip */
const urlScbseall = (d: Date): string =>
  `${BSE_WWW}/BSEDATA/gross/${istParts(d).y}/SCBSEALL${tokDDMM(d)}.zip`;

/** BSE legacy cash bhavcopy: /download/BhavCopy/Equity/EQ_ISINCODE_{DDMMYY}.zip */
const urlBseLegacy = (d: Date): string =>
  `${BSE_WWW}/download/BhavCopy/Equity/EQ_ISINCODE_${tokDDMMYY(d)}.zip`;

// ─── Q1–Q2: NSE nsearchives (cookieless static archive) ──────────────

async function probeNseArchives(): Promise<void> {
  const group = "nse-archives";
  if (!shouldRun(group)) return;
  console.log("\n▌ NSE nsearchives — static archive (cookieless)\n");

  // Q1.1 — earliest legacy cash bhavcopy. The audit's claim is that NSE's cash
  // history starts at the exchange's own beginning (Nov-1994); these three
  // rungs test the very first trading days rather than a round-number month.
  const cm1994 = [
    { date: "1994-11-03", d: day("1994-11-03") },
    { date: "1994-11-04", d: day("1994-11-04") },
    { date: "1994-12-01", d: day("1994-12-01") },
  ];
  const cmRungs: Array<{ date: string; result: ProbeResult }> = [];
  for (const r of cm1994) {
    cmRungs.push({
      date: r.date,
      result: await probe({
        id: `${group}/cm-legacy/${r.date}`,
        group,
        question: "Earliest NSE cash bhavcopy (legacy cm{DDMMMYYYY}bhav form)",
        url: urlLegacyCm(r.d),
      }),
    });
  }
  findings.push({
    group,
    feed: "NSE CM bhavcopy — legacy",
    pattern:
      "/content/historical/EQUITIES/{YYYY}/{MON}/cm{DDMMMYYYY}bhav.csv.zip",
    answer: bracket(cmRungs).answer,
    evidence: cmRungs.map((r) => r.result.id),
  });

  // Q1.2 — MTO (delivery) floor. The audit verified >= Apr-2016; this ladder
  // spans 1999→2014 so the answer is a bracket, not a guess.
  const mtoLadder = ["1999-04-01", "2003-04-01", "2010-04-01", "2014-04-01"];
  const mtoRungs: Array<{ date: string; result: ProbeResult }> = [];
  for (const date of mtoLadder) {
    mtoRungs.push({
      date,
      result: await probe({
        id: `${group}/mto/${date}`,
        group,
        question: "MTO (delivery quantity) archive floor",
        url: urlMto(day(date)),
      }),
    });
  }
  const mtoBracket = bracket(mtoRungs);
  let mtoAnswer = mtoBracket.answer;
  if (mtoBracket.latestAbsent && mtoBracket.earliestPresent) {
    const refined = await refineFloor(
      group,
      `${group}/mto`,
      "MTO (delivery quantity) archive floor — refinement",
      urlMto,
      mtoBracket.latestAbsent,
      mtoBracket.earliestPresent,
    );
    if (refined.probes.length > 0) mtoAnswer += `; ${refined.result}`;
  }
  findings.push({
    group,
    feed: "NSE MTO (delivery %)",
    pattern: "/archives/equities/mto/MTO_{DDMMYYYY}.DAT",
    answer: mtoAnswer,
    evidence: mtoRungs.map((r) => r.result.id),
  });

  // Q1.3 — PR zip depth (the full daily-report bundle: 20+ files per day).
  const prLadder = ["1995-01-01", "2000-01-01", "2010-01-01"];
  const prRungs: Array<{ date: string; result: ProbeResult }> = [];
  for (const date of prLadder) {
    prRungs.push({
      date,
      result: await probe({
        id: `${group}/pr/${date}`,
        group,
        question: "PR daily-report bundle archive depth",
        url: urlPr(day(date)),
      }),
    });
  }
  findings.push({
    group,
    feed: "NSE PR bundle",
    pattern: "/archives/equities/bhavcopy/pr/PR{DDMMYY}.zip",
    answer: bracket(prRungs).answer,
    evidence: prRungs.map((r) => r.result.id),
  });

  // Q1.4 — sec_bhavdata_full start. This is the file that carries price AND
  // delivery in one row, so its floor decides whether P4's delivery-% series
  // needs the MTO join before that date or not.
  const secLadder = ["2019-07-01", "2019-10-01", "2020-01-01"];
  const secRungs: Array<{ date: string; result: ProbeResult }> = [];
  for (const date of secLadder) {
    secRungs.push({
      date,
      result: await probe({
        id: `${group}/sec-bhavdata-full/${date}`,
        group,
        question: "sec_bhavdata_full (price+delivery) start date",
        url: urlSecBhavFull(day(date)),
      }),
    });
  }
  const secBracket = bracket(secRungs);
  let secAnswer = secBracket.answer;
  if (secBracket.latestAbsent && secBracket.earliestPresent) {
    const refined = await refineFloor(
      group,
      `${group}/sec-bhavdata-full`,
      "sec_bhavdata_full start date — refinement",
      urlSecBhavFull,
      secBracket.latestAbsent,
      secBracket.earliestPresent,
    );
    if (refined.probes.length > 0) secAnswer += `; ${refined.result}`;
  }
  findings.push({
    group,
    feed: "NSE sec_bhavdata_full (price + delivery)",
    pattern: "/products/content/sec_bhavdata_full_{DDMMYYYY}.csv",
    answer: secAnswer,
    evidence: secRungs.map((r) => r.result.id),
  });

  // Q2 — UDiFF backfill floors for the currency + commodity segments. UDiFF
  // went live across segments in Jul-2024; the question is how far BACK each
  // segment's archive was backfilled, which differs per segment.
  for (const [feed, build, pattern] of [
    [
      "NSE CD UDiFF (currency)",
      urlUdiffCd,
      "/archives/cd/bhav/BhavCopy_NSE_CD_0_0_0_{YYYYMMDD}_F_0000.csv.zip",
    ],
    [
      "NSE COM UDiFF (commodity)",
      urlUdiffCom,
      "/content/com/BhavCopy_NSE_CO_0_0_0_{YYYYMMDD}_F_0000.csv.zip",
    ],
  ] as const) {
    const ladder = ["2024-01-02", "2024-07-01", "2025-01-02"];
    const rungs: Array<{ date: string; result: ProbeResult }> = [];
    for (const date of ladder) {
      rungs.push({
        date,
        result: await probe({
          id: `${group}/${feed.includes("CD") ? "udiff-cd" : "udiff-com"}/${date}`,
          group,
          question: `${feed} backfill floor`,
          url: build(day(date)),
        }),
      });
    }
    findings.push({
      group,
      feed,
      pattern,
      answer: bracket(rungs).answer,
      evidence: rungs.map((r) => r.result.id),
    });
  }
}

// ─── Q3–Q4: NSE www/api (cookie-gated JSON) ──────────────────────────

/**
 * Report the outcome of the A/B Referer test as a conclusion, not two statuses.
 *
 * The point of running both is that either result is informative and they mean
 * opposite things for how we integrate: if only the page Referer works, the
 * Referer is a hard requirement everywhere; if neither works, the params are
 * wrong and the Referer was never the issue; if both work, the endpoint is
 * genuinely empty for this window and bulk mode is a dead end.
 */
function describeRefererExperiment(
  withPage: ProbeResult,
  withGeneric: ProbeResult,
  pagePath: string,
): string {
  const pageOk = withPage.verdict === "PRESENT";
  const genericOk = withGeneric.verdict === "PRESENT";

  if (pageOk && !genericOk) {
    return `REFERER-GATED — returns rows ONLY with Referer \`/${pagePath}\` (${withPage.bytes} bytes); the generic Referer yields ${withGeneric.verdict}. Any client of this endpoint MUST send the page Referer.`;
  }
  if (pageOk && genericOk) {
    return `param set CONFIRMED — returns rows on both Referers (${withPage.bytes} bytes). Referer is not a gate here.`;
  }
  if (!pageOk && !genericOk) {
    return `still ${withPage.verdict} with the page Referer AND ${withGeneric.verdict} with the generic one — the Referer is NOT the blocker, so the PARAM SET is wrong. Capture the real XHR from /${pagePath} in DevTools.`;
  }
  return `unexpected: generic Referer returned rows but the page Referer did not (${withPage.verdict}). Re-probe before trusting either.`;
}

async function probeNseApi(): Promise<void> {
  const group = "nse-api";
  if (!shouldRun(group)) return;
  console.log("\n▌ NSE www/api — cookie-gated JSON endpoints\n");

  const cookie = await warmNseSession();
  const headers = nseApiHeaders(cookie);
  if (!cookie) {
    console.warn(
      "  ⚠ No session cookie. The /api probes below will likely return an " +
        "HTML challenge — that is recorded as HTML, not as 'endpoint missing'.",
    );
  }

  const base = `${NSE_REFERER}api`;

  // Q3.1 — EGR (Electronic Gold Receipts) daily reports. EGR launched May-2026
  // and the audit saw zero files; the question is whether any exist YET and
  // what they are NAMED, since the filename template is what P2 registers.
  await probe({
    id: `${group}/daily-reports/EGR`,
    group,
    question: "daily-reports?key=EGR — are any EGR files published yet?",
    url: `${base}/daily-reports?key=EGR`,
    headers,
  });

  // Q3.2 — monthly report families. Each key is a separate archive family for
  // the P2 registry; an EMPTY verdict here means "valid key, no files", which
  // is a different registry entry from a 404 "wrong key".
  for (const key of ["INDEX", "CBM", "TRI-PARTY", "EBP"]) {
    await probe({
      id: `${group}/monthly-reports/${key}`,
      group,
      question: `monthly-reports?key=${key} — does this family exist?`,
      url: `${base}/monthly-reports?key=${encodeURIComponent(key)}`,
      headers,
    });
  }

  // Q3.3 — corporates-pit in BULK mode. Per-symbol works; the audit's bulk
  // attempt came back empty. Replicating the browser means omitting `symbol`
  // and supplying an explicit date WINDOW, which is what the insider-trading
  // page's own XHR does.
  const pitTo = lastWeekday(addDays(new Date(), -1));
  const pitFrom = addDays(pitTo, -30);
  const fmt = (d: Date): string =>
    tokDDMMYYYY(d).replace(/(\d{2})(\d{2})(\d{4})/, "$1-$2-$3");
  //
  // Two variants, because the first run could not distinguish "bulk mode needs
  // different params" from "the Referer was wrong". Sending the page-specific
  // Referer isolates that: if the page-Referer call returns rows and the
  // all-reports one does not, the gate is the Referer and every future NSE
  // integration has to carry it.
  const pitPage = "companies-listing/corporate-filings-insider-trading";
  // Captured live (MONEY-1097). TWO corrections over the P1 guess, and each
  // alone produces an empty 200 rather than an error:
  //   - the endpoint is `corporates-pit-gg`, not `corporates-pit`
  //   - the day is NOT zero-padded (`9-07-2026`), while the month is
  // The A/B Referer control in P1 correctly ruled headers out; it was the
  // endpoint name all along.
  const pitDate = (d: Date): string => {
    const p = istParts(d);
    return `${p.d}-${pad2(p.m)}-${p.y}`;
  };
  const pitQuery = `index=equities&from_date=${pitDate(pitFrom)}&to_date=${pitDate(pitTo)}`;

  const pitWithPageReferer = await probe({
    id: `${group}/corporates-pit/bulk-page-referer`,
    group,
    question:
      "corporates-pit bulk mode, Referer = the insider-trading page that owns the XHR",
    url: `${base}/corporates-pit-gg?${pitQuery}`,
    headers: nseApiHeaders(cookie, pitPage),
  });

  const pitWithGenericReferer = await probe({
    id: `${group}/corporates-pit/bulk-generic-referer`,
    group,
    question:
      "corporates-pit bulk mode, generic Referer — the control for the Referer hypothesis",
    url: `${base}/corporates-pit-gg?${pitQuery}`,
    headers,
  });

  findings.push({
    group,
    feed: "NSE corporates-pit (insider trading) — BULK mode",
    pattern:
      "/api/corporates-pit?index=equities&from_date={DD-MM-YYYY}&to_date={DD-MM-YYYY}",
    answer: describeRefererExperiment(
      pitWithPageReferer,
      pitWithGenericReferer,
      pitPage,
    ),
    evidence: [pitWithPageReferer.id, pitWithGenericReferer.id],
  });

  // Q3.4 — integrated-filing-results param discovery. This one already returned
  // rows on the generic Referer, so it is probed with its own page Referer only.
  const ifr = await probe({
    id: `${group}/integrated-filing-results/bulk`,
    group,
    question: "integrated-filing-results — bulk param set",
    url: `${base}/integrated-filing-results?index=equities&from_date=${fmt(pitFrom)}&to_date=${fmt(pitTo)}`,
    headers: nseApiHeaders(
      cookie,
      "companies-listing/corporate-filings-integrated-filing",
    ),
  });
  findings.push({
    group,
    feed: "NSE integrated-filing-results",
    pattern:
      "/api/integrated-filing-results?index=equities&from_date={DD-MM-YYYY}&to_date={DD-MM-YYYY}",
    answer:
      ifr.verdict === "PRESENT"
        ? `param set CONFIRMED — returns filings for a 30-day window (${ifr.bytes} bytes)`
        : `${ifr.verdict} — param set NOT confirmed`,
    evidence: [ifr.id],
  });

  // Q3.5 — the Debt tab's "Weekly Reports". No /api/weekly-reports exists, so
  // the hypothesis is that it rides the generic archives door with a
  // weekly-reports TYPE. This probe is a guess-verify: whatever comes back is
  // the finding.
  const debtArchive = JSON.stringify([
    {
      name: "Weekly Reports",
      type: "weekly-reports",
      category: "debt",
      section: "debt",
    },
  ]);
  await probe({
    id: `${group}/reports/debt-weekly`,
    group,
    question: 'Debt tab "Weekly Reports" XHR shape (guess-verify)',
    url: `${base}/reports?archives=${encodeURIComponent(debtArchive)}&date=${tokDashMon(pitTo)}&type=weekly-reports&mode=single`,
    headers,
  });

  // Q3.6 — the Capital-Market "Mutual Fund" section. Keys MF/MFSS were
  // rejected, so try it as an archives SECTION instead of a key.
  const mfArchive = JSON.stringify([
    {
      name: "Mutual Fund",
      type: "archives",
      category: "capital-market",
      section: "mutual-fund",
    },
  ]);
  await probe({
    id: `${group}/reports/cm-mutual-fund`,
    group,
    question: 'Capital-Market "Mutual Fund" section XHR shape (guess-verify)',
    url: `${base}/reports?archives=${encodeURIComponent(mfArchive)}&date=${tokDashMon(pitTo)}&type=archives&mode=single`,
    headers,
  });

  // Q4 — does the archives door serve OLD dates? This is the fallback path for
  // P3: if nsearchives 403s under backfill load, the same files are reachable
  // through www's API. A 2019 date proves the door is not recent-only.
  const volArchive = JSON.stringify([
    {
      name: "CM - Daily Volatility",
      type: "archives",
      category: "capital-market",
      section: "equities",
    },
  ]);
  const doorResult = await probe({
    id: `${group}/reports/archives-door-2019`,
    group,
    question:
      "Does /api/reports?archives=[…] serve OLD dates? (fallback when nsearchives 403s)",
    url: `${base}/reports?archives=${encodeURIComponent(volArchive)}&date=15-Mar-2019&mode=single`,
    headers,
  });
  findings.push({
    group,
    feed: "NSE archives door (fallback for nsearchives)",
    pattern:
      "/api/reports?archives=[{name,type,category,section}]&date={DD-Mon-YYYY}&mode=single",
    answer:
      doorResult.verdict === "PRESENT"
        ? "SERVES OLD DATES — usable as the P3 fallback when nsearchives throttles"
        : `${doorResult.verdict} at 15-Mar-2019 — do NOT rely on it as the P3 fallback without re-probing`,
    evidence: [doorResult.id],
  });
}

// ─── Q5–Q8: BSE ──────────────────────────────────────────────────────

async function probeBseWww(): Promise<void> {
  const group = "bse-www";
  if (!shouldRun(group)) return;
  console.log("\n▌ BSE www — downloads (UA + Origin/Referer)\n");

  // Q5 — do the LIVE files 200 from our egress at all? The audit sandbox could
  // not reach BSE, so this is the load-bearing question: everything else about
  // BSE is moot if the host refuses us.
  //
  // Walk back day by day until the CM file appears. A 404 on the first try is
  // ambiguous — weekend, exchange holiday, or pre-EOD all look identical — so
  // treating one 404 as "BSE is unreachable" would be a false negative. Bounded
  // at 4 steps so a genuine outage cannot eat the budget.
  let tradingDay: Date | null = null;
  let cmProbeId: string | null = null;
  for (let i = 0; i < 4; i++) {
    const candidate = lastWeekday(addDays(new Date(), -(1 + i)));
    const iso = `${istParts(candidate).y}-${pad2(istParts(candidate).m)}-${pad2(istParts(candidate).d)}`;
    const r = await probe({
      id: `${group}/cm-udiff-live/${iso}`,
      group,
      question: "BSE CM UDiFF live availability from our egress",
      url: urlBseCm(candidate),
      keepBody: true,
    });
    if (isPresent(r)) {
      tradingDay = candidate;
      cmProbeId = r.id;
      break;
    }
    if (!isConclusive(r) || r.verdict === "BLOCKED") break;
  }

  findings.push({
    group,
    feed: "BSE CM UDiFF (cash)",
    pattern:
      "/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{YYYYMMDD}_F_0000.CSV",
    answer: tradingDay
      ? `REACHABLE from our egress (verified ${tokYYYYMMDD(tradingDay)})`
      : "NOT reachable / no recent file found — see probe rows",
    evidence: cmProbeId ? [cmProbeId] : [],
  });

  // Anchor the remaining live checks to the day CM actually resolved for, so a
  // 404 below means "this feed is absent" rather than "we asked for a holiday".
  const anchor = tradingDay ?? lastWeekday(addDays(new Date(), -1));

  const fo = await probe({
    id: `${group}/fo-udiff-live`,
    group,
    question:
      "BSE F&O UDiFF live availability (note the lowercase-c `Bhavcopy` dir)",
    url: urlBseFo(anchor),
  });
  findings.push({
    group,
    feed: "BSE FO UDiFF (derivatives)",
    pattern:
      "/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_{YYYYMMDD}_F_0000.CSV",
    answer: `${fo.verdict} at ${tokYYYYMMDD(anchor)}`,
    evidence: [fo.id],
  });

  const gross = await probe({
    id: `${group}/scbseall-live`,
    group,
    question: "BSE gross-delivery SCBSEALL live availability",
    url: urlScbseall(anchor),
  });
  findings.push({
    group,
    feed: "BSE gross delivery (SCBSEALL)",
    pattern: "/BSEDATA/gross/{YYYY}/SCBSEALL{DDMM}.zip",
    answer: `${gross.verdict} at ${tokDDMM(anchor)}`,
    evidence: [gross.id],
  });

  const cd = await probe({
    id: `${group}/cd-udiff-live`,
    group,
    question:
      "BSE Currency UDiFF — does this path exist at all? (guess-verify)",
    url: urlBseCd(anchor),
  });
  findings.push({
    group,
    feed: "BSE CD UDiFF (currency)",
    pattern:
      "/download/Bhavcopy/Currency/BhavCopy_BSE_CD_0_0_0_{YYYYMMDD}_F_0000.CSV",
    answer:
      cd.verdict === "PRESENT"
        ? "path CONFIRMED by analogy with CM/FO"
        : `${cd.verdict} — the guessed path is NOT valid; do not register it`,
    evidence: [cd.id],
  });

  // Q6 — old-format cash bhavcopies. BSE cut over to UDiFF in 2024; the
  // question is whether the PRE-cutover zips are still served (they are the
  // only route to 2007–2023 cash history).
  const legacyLadder = ["2007-01-02", "2016-01-01", "2024-03-29"];
  const legacyRungs: Array<{ date: string; result: ProbeResult }> = [];
  for (const date of legacyLadder) {
    legacyRungs.push({
      date,
      result: await probe({
        id: `${group}/eq-isincode/${date}`,
        group,
        question: "BSE legacy EQ_ISINCODE zip availability post-UDiFF-cutover",
        url: urlBseLegacy(day(date)),
      }),
    });
  }
  findings.push({
    group,
    feed: "BSE CM bhavcopy — legacy (pre-UDiFF)",
    pattern: "/download/BhavCopy/Equity/EQ_ISINCODE_{DDMMYY}.zip",
    answer: bracket(legacyRungs).answer,
    evidence: legacyRungs.map((r) => r.result.id),
  });

  // Q6b — how far back does the gross-delivery year folder go?
  const grossLadder = ["2007-01-04", "2012-01-02", "2018-01-01"];
  const grossRungs: Array<{ date: string; result: ProbeResult }> = [];
  for (const date of grossLadder) {
    grossRungs.push({
      date,
      result: await probe({
        id: `${group}/scbseall/${date}`,
        group,
        question: "SCBSEALL earliest year folder",
        url: urlScbseall(day(date)),
      }),
    });
  }
  findings.push({
    group,
    feed: "BSE gross delivery — history",
    pattern: "/BSEDATA/gross/{YYYY}/SCBSEALL{DDMM}.zip",
    answer: bracket(grossRungs).answer,
    evidence: grossRungs.map((r) => r.result.id),
  });

  // Q8 — costs ZERO requests: it re-reads the CM body already retained above.
  answerEgrInUdiff(group, cmProbeId);
}

/**
 * Q8 — do BSE EGR (Electronic Gold Receipt) rows ride the CM UDiFF file?
 *
 * Answered by inspecting a bhavcopy we ALREADY downloaded for Q5 rather than
 * fetching another one. That matters beyond politeness: it is the same bytes
 * production would parse, so a "no EGR rows here" answer is about our actual
 * ingest path and not about some other file that happens to share a name.
 *
 * Two independent signals, because either alone is weak: an explicit segment /
 * series token saying EGR, and BSE's 18xxxx scrip-code block which is where
 * gold receipts are numbered.
 */
function answerEgrInUdiff(group: string, cmProbeId: string | null): void {
  const body = cmProbeId ? retainedBodies.get(cmProbeId) : undefined;
  if (!body) {
    findings.push({
      group,
      feed: "BSE EGR rows inside CM UDiFF",
      pattern: "(analysis of the CM UDiFF body)",
      answer:
        "UNANSWERED — no CM UDiFF body was retained (the live probe did not succeed)",
      evidence: cmProbeId ? [cmProbeId] : [],
    });
    return;
  }

  const text = body.toString("utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = (lines[0] ?? "").split(",").map((h) => h.trim());
  const idx = (name: string): number =>
    header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  const iSgmt = idx("Sgmt");
  const iSrs = idx("SctySrs");
  const iId = idx("FinInstrmId");

  const segments = new Set<string>();
  const series = new Set<string>();
  let egrLike = 0;
  let code18xx = 0;

  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const sgmt = iSgmt >= 0 ? (cols[iSgmt] ?? "").trim() : "";
    const srs = iSrs >= 0 ? (cols[iSrs] ?? "").trim() : "";
    const id = iId >= 0 ? (cols[iId] ?? "").trim() : "";
    if (sgmt) segments.add(sgmt);
    if (srs) series.add(srs);
    if (/EGR/i.test(sgmt) || /EGR/i.test(srs)) egrLike++;
    if (/^18\d{4}$/.test(id)) code18xx++;
  }

  findings.push({
    group,
    feed: "BSE EGR rows inside CM UDiFF",
    pattern: "(analysis of the CM UDiFF body — 0 extra requests)",
    answer:
      egrLike > 0 || code18xx > 0
        ? `EGR IS present in the CM file — ${egrLike} row(s) with an EGR segment/series token, ${code18xx} row(s) with an 18xxxx scrip code. P2 does NOT need a separate EGR feed.`
        : `NO EGR rows in the CM file (${lines.length - 1} data rows scanned; segments seen: ${[...segments].join("/") || "n/a"}; series seen: ${[...series].slice(0, 12).join("/") || "n/a"}). EGR needs its OWN feed entry in the P2 registry.`,
    evidence: cmProbeId ? [cmProbeId] : [],
  });
}

/**
 * Say what the SENSEX CSV actually CONTAINS, not merely that it responded.
 *
 * The distinction is load-bearing for P3: a close-only series supports index
 * levels and returns, but nothing that needs a daily range. Reporting "PRESENT"
 * for a file whose OHLC columns are blank would have let P3 plan work the data
 * cannot support.
 */
function describeSensexColumns(sensex: ProbeResult): string {
  const body = retainedBodies.get(sensex.id);
  if (!body) return `${sensex.verdict} for calendar-1986 — no body retained`;

  const rows = body
    .toString("utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const dataRows = rows.slice(1);
  if (dataRows.length === 0) {
    return `${sensex.verdict} but ZERO data rows for calendar-1986 — the archive does not reach back this far`;
  }

  // Header is Date,Open,High,Low,Close — count rows where any of O/H/L is blank.
  let closeOnly = 0;
  for (const line of dataRows) {
    const c = line.split(",");
    if (!c[1]?.trim() || !c[2]?.trim() || !c[3]?.trim()) closeOnly++;
  }

  const first = dataRows[0]?.split(",")[0]?.trim() ?? "?";
  const last = dataRows[dataRows.length - 1]?.split(",")[0]?.trim() ?? "?";
  return closeOnly === dataRows.length
    ? `history reaches 1986 (${dataRows.length} rows, ${first} → ${last}) but is CLOSE-ONLY — open/high/low are blank for every row. P3 can build a level/returns series, NOT a daily range.`
    : closeOnly > 0
      ? `history reaches 1986 (${dataRows.length} rows, ${first} → ${last}); ${closeOnly} row(s) lack full OHLC — treat early years as close-only.`
      : `history reaches 1986 with full OHLC (${dataRows.length} rows, ${first} → ${last}).`;
}

/**
 * Read BSE's announcement CATEGORY / SUBCATEGORY vocabulary out of real rows.
 *
 * P5 needs the exact subcategory string for earnings-call transcripts. A wrong
 * guess does not error — it filters to zero rows forever, which is the failure
 * mode that looks like "no company held a concall this quarter". So the string
 * is taken from BSE's own payload rather than guessed, and anything
 * transcript-shaped is surfaced explicitly.
 *
 * Field names are not hardcoded to one spelling: BSE's payloads have used
 * `CATEGORYNAME`/`SUBCATNAME`/`NEWSSUB` across endpoints, so this scans each row
 * for keys that LOOK like a category field. Being liberal here is deliberate —
 * missing the vocabulary because a key was renamed would waste the whole probe.
 */
function describeAnnouncementVocabulary(annRecent: ProbeResult): string {
  const body = retainedBodies.get(annRecent.id);
  if (!body) {
    return `UNKNOWN — the recent announcements probe returned ${annRecent.verdict}, so no rows were available to read the vocabulary from.`;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return "UNKNOWN — the announcements response was not JSON.";
  }

  const rec = parsed as Record<string, unknown>;
  const rows = (Array.isArray(parsed) ? parsed : rec.Table) as
    | Array<Record<string, unknown>>
    | undefined;
  if (!Array.isArray(rows) || rows.length === 0) {
    return "UNKNOWN — the announcements response carried no rows.";
  }

  const categories = new Set<string>();
  const subcategories = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string" || !value.trim()) continue;
      const k = key.toUpperCase();
      if (k.includes("SUBCAT") || k === "NEWSSUB")
        subcategories.add(value.trim());
      else if (k.includes("CATEGORY") || k === "CAT")
        categories.add(value.trim());
    }
  }

  const transcriptLike = [...subcategories, ...categories].filter((v) =>
    /transcript|concall|conference call|earnings call|investor (meet|call)/i.test(
      v,
    ),
  );

  const cats = [...categories].slice(0, 15).join(" · ") || "none found";
  const subs = [...subcategories].slice(0, 25).join(" · ") || "none found";

  return (
    `from ${rows.length} real rows — CATEGORIES: ${cats}. SUBCATEGORIES: ${subs}. ` +
    (transcriptLike.length > 0
      ? `**Transcript-related string(s): ${transcriptLike.join(" · ")}** — use verbatim in P5.`
      : "NO transcript/concall string appeared in this 7-day window; widen the window or filter category=Company Update before P5 relies on it.")
  );
}

async function probeBseApi(): Promise<void> {
  const group = "bse-api";
  if (!shouldRun(group)) return;
  console.log("\n▌ BSE api.bseindia.com — JSON endpoints\n");

  const headers = {
    "User-Agent": EXCHANGE_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BSE_REFERER,
    Origin: BSE_REFERER.replace(/\/$/, ""),
  };

  // Q7.1 — SENSEX archive floor. 1986 is the index's own base year, so a hit
  // here means the whole index history is free; a miss brackets it.
  const sensex = await probe({
    id: `${group}/sensex/1986`,
    group,
    question: "SENSEX daily archive floor (ProduceCSVForDate)",
    url: `${BSE_API}/ProduceCSVForDate/w?strIndex=SENSEX&dtFromDate=01/01/1986&dtToDate=31/12/1986&period=D`,
    headers,
    keepBody: true,
  });
  findings.push({
    group,
    feed: "BSE SENSEX daily history",
    pattern:
      "/ProduceCSVForDate/w?strIndex={NAME}&dtFromDate={DD/MM/YYYY}&dtToDate={DD/MM/YYYY}&period=D",
    // "PRESENT, see the preview" was too weak to build on. The 1986 rows come
    // back as `2-January-1986,,,,549.43` — a CLOSE with EMPTY open/high/low —
    // and whether the early years carry full OHLC decides whether P3 can derive
    // anything intraday-shaped from them or only a close series. Reading the
    // body costs nothing extra since it is already in hand.
    answer: describeSensexColumns(sensex),
    evidence: [sensex.id],
  });

  // Q7.2 — the all-index daily endpoint (index FAMILIES in one call).
  const anchor = lastWeekday(addDays(new Date(), -1));
  const idxAll = await probe({
    id: `${group}/index-arch-daily-all`,
    group,
    question: "IndexArchDailyAll — all-index daily close, one recent date",
    url: `${BSE_API}/IndexArchDailyAll/w?fmdt=${encodeURIComponent(tokSlash(anchor))}&todt=${encodeURIComponent(tokSlash(anchor))}`,
    headers,
  });
  findings.push({
    group,
    feed: "BSE all-index daily close",
    pattern: "/IndexArchDailyAll/w?fmdt={DD/MM/YYYY}&todt={DD/MM/YYYY}",
    answer:
      idxAll.verdict === "PRESENT"
        ? `serves all-index closes at ${tokSlash(anchor)} with this param set`
        : `${idxAll.verdict} at ${tokSlash(anchor)} — the guessed param set (fmdt/todt only) returns nothing; the real call likely needs strIndex/Indexcode. Capture it from the index page XHR before registering.`,
    evidence: [idxAll.id],
  });

  // Q7.3 — announcements. Two windows, RECENT first.
  //
  // The Jan-2011 probe alone was unreadable: an empty result means either "the
  // archive stops after 2011" or "this param set is wrong", and those call for
  // opposite responses. A recent window is the control — it MUST return rows if
  // the params are right, because the whole market files announcements daily.
  const annRecentTo = lastWeekday(addDays(new Date(), -1));
  const annRecentFrom = addDays(annRecentTo, -7);
  const annQuery = (from: Date, to: Date): string =>
    // strCat takes the category NAME ("Company Update"), not -1. Passing -1
    // is what made every P1 attempt return a bare `{}` — a working endpoint
    // answering "no rows" for a filter that matches nothing.
    `pageno=1&strCat=${encodeURIComponent("Company Update")}&subcategory=-1&strPrevDate=${tokYYYYMMDD(from)}` +
    `&strToDate=${tokYYYYMMDD(to)}&strScrip=&strSearch=P&strType=C`;

  const annRecent = await probe({
    id: `${group}/announcements/recent`,
    group,
    question:
      "BSE announcements, RECENT 7-day window — the control that proves the param set",
    url: `${BSE_API}/AnnSubCategoryGetData/w?${annQuery(annRecentFrom, annRecentTo)}`,
    headers,
    keepBody: true,
  });

  const ann = await probe({
    id: `${group}/announcements/2011`,
    group,
    question: "Earliest BSE announcements (strPrevDate=20110101)",
    url: `${BSE_API}/AnnSubCategoryGetData/w?${annQuery(day("2011-01-01"), day("2011-01-31"))}`,
    headers,
  });

  const paramsWork = annRecent.verdict === "PRESENT";
  findings.push({
    group,
    feed: "BSE corporate announcements",
    pattern:
      "/AnnSubCategoryGetData/w?pageno={N}&strCat={CAT}&subcategory={SUB}&strPrevDate={YYYYMMDD}&strToDate={YYYYMMDD}&strType=C",
    answer: !paramsWork
      ? `param set NOT confirmed — even a recent 7-day window returned ${annRecent.verdict}, so the Jan-2011 result says nothing about archive depth. Capture the real XHR from the announcements page.`
      : ann.verdict === "PRESENT"
        ? "param set CONFIRMED and the archive reaches Jan-2011"
        : `param set CONFIRMED (recent window returns rows) but Jan-2011 is ${ann.verdict} — the archive does NOT reach back to 2011. Bisect the floor before P5 promises 20y of history.`,
    evidence: [annRecent.id, ann.id],
  });

  // Q7.4 — the subcategory vocabulary, DERIVED from real rows.
  //
  // Guessing a list-endpoint name burns requests on a host we want to stay
  // friendly with and yields nothing when wrong (the first run's guess returned
  // an HTML page). The announcement rows themselves carry their category and
  // subcategory, so the vocabulary can be read straight out of the response we
  // already fetched above — no extra request, and it reports what BSE actually
  // emits rather than what a docs page claims.
  // The AUTHORITATIVE subcategory list — endpoint captured live (MONEY-1097).
  //
  // P1 guessed `DDLCategoryWiseSubcategory` and got an HTML page. The real name
  // is `DDLSubCategoryData`, and it takes `categoryname` (not `category`). The
  // nine categories BSE exposes are: AGM/EGM, Board Meeting, Company Update,
  // Corp. Action, Insider Trading / SAST, New Listing, Result, Integrated
  // Filing, Others. "Company Update" is the one carrying concall/transcript
  // filings, which is the string P5 is blocked on.
  const subcats = await probe({
    id: `${group}/announcement-subcategories`,
    group,
    question:
      'Subcategory list for category "Company Update" (the transcript string)',
    url: `${BSE_API}/DDLSubCategoryData/w?categoryname=${encodeURIComponent("Company Update")}`,
    headers,
    keepBody: true,
  });

  findings.push({
    group,
    feed: "BSE announcement subcategories (incl. the transcript string)",
    pattern: "/DDLSubCategoryData/w?categoryname={CATEGORY}",
    answer:
      subcats.verdict === "PRESENT"
        ? `subcategory vocabulary RETRIEVED for "Company Update" — see the probe preview for the exact transcript string P5 must filter on`
        : `${subcats.verdict} — endpoint captured from the live site but returned no list; cross-check against the row-derived vocabulary below`,
    evidence: [subcats.id],
  });

  // Kept as a CROSS-CHECK on the authoritative list above: the rows carry their
  // own category/subcategory, so if the two disagree the endpoint is stale.
  findings.push({
    group,
    feed: "BSE announcement vocabulary (cross-check, derived from rows)",
    pattern: "(derived from AnnSubCategoryGetData rows — 0 extra requests)",
    answer: describeAnnouncementVocabulary(annRecent),
    evidence: [annRecent.id],
  });
}

// ─── Q9: BSE results XBRL (MONEY-1255) ───────────────────────────────

/**
 * Where a BSE company's RESULTS XBRL instance actually lives.
 *
 * ## Why this needed a discovery pass at all
 *
 * We had `XbrlFiling` rows for NSE only, and the standing assumption was that
 * BSE simply did not publish machine-readable results. It does. What was
 * missing was the INDEX — the thing that turns a scrip code into an instance
 * URL — and three earlier guesses at it all 404'd:
 *
 *   /xml-data/corpfiling/AttachLive/{XML_NAME}.xml
 *   /xml-data/corpfiling/AttachHis/{XML_NAME}.xml
 *   /bseplus/AnnualReport/{XML_NAME}.xml
 *
 * All three are the same mistake, and it is worth naming because it is the
 * cheap one to repeat: `XML_NAME` (`ANN_530127_AD76AC5C-…`) is NOT a filename.
 * The announcement row's actual attachment is a DIFFERENT field,
 * `ATTACHMENTNAME`, a bare GUID `.pdf`, and BSE's own site builds that link as
 * `/xml-data/corpfiling/AttachLive/{ATTACHMENTNAME}` (live) or
 * `/xml-data/corpfiling/CorpAttachment/{YYYY}/{M}/{ATTACHMENTNAME}` (archived).
 * So the directory in those three guesses was right and the FIELD was wrong,
 * which is why they 404'd rather than 403'd or redirected.
 *
 * ## The `200 with a 2-byte body` rule, and where it did and did not apply
 *
 * `Corpforthresults/w?scripcode=…` answering `{}` was read as "the path is
 * plausible, the params are wrong — do NOT re-derive the path"
 * (`exchange-registry-verification.json`, `bse-index-daily-all`). That rule
 * held here in ONE place and misled in another, so both are recorded:
 *
 *   - It HELD for `GetCorXbrlDetails_ng`, which answers an explicit
 *     `{"Error":[{"message":"From Date and To Date are mandatory."}]}` — an
 *     endpoint stating its own contract. Adding the dates was the whole fix.
 *   - It did NOT hold for `Corpforthresults`, whose name means *forthcoming*
 *     results — a board-meeting calendar. An empty body there is a truthful
 *     "nothing scheduled", not a wrong param set. A name that reads as
 *     "corporate results" and means "results not yet filed" is exactly the
 *     shape that keeps a probe hammering a correct-and-useless endpoint.
 *
 * ## What the answer turned out to be
 *
 * BSE indexes results PER SCRIP, not per date:
 *
 *   https://api.bseindia.com/BseIndiaAPI/api/Result_Arch_ng/w?scrip_cd={CODE}
 *
 * Each row carries `stand_xbrl_link` and `conso_xbrl_link` — site-relative
 * paths under `/XBRLFILES/…` fetched from `www.bseindia.com` — and states its
 * own basis and period, which is the part that matters: BSE splits
 * CONSOLIDATED and STANDALONE into two COLUMNS of one row, where NSE files
 * them as two records. `Fld_QuarterName` ("Quarter" / "Year") gives the period
 * type without inferring it from a date.
 *
 * The per-scrip shape is the operational catch and is recorded as a finding
 * rather than left for whoever wires the job: there is no date-ranged
 * market-wide variant. `NSTodayResults_ng/w` lists the scrips that filed TODAY
 * and carries no XBRL link, so a nightly ingest is two hops — today's filers,
 * then one `Result_Arch_ng` per filer.
 */
async function probeBseResultsXbrl(): Promise<void> {
  const group = "bse-results";
  if (!shouldRun(group)) return;
  console.log("\n▌ BSE results XBRL — the index behind /XBRLFILES\n");

  const jsonHeaders = {
    "User-Agent": EXCHANGE_USER_AGENT,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BSE_REFERER,
    Origin: BSE_REFERER.replace(/\/$/, ""),
  };

  // Two scrips on purpose, and they are not interchangeable. RELIANCE is
  // dual-listed and its instances carry a `<Symbol>` fact; NPR FINANCE is a
  // small BSE-listed NBFC whose instances carry ScripCode + ISIN and NO
  // Symbol. `XbrlFiling.symbol` is a required non-null column, so the
  // second case is the one that decides whether the ingest needs a
  // scrip-code bridge — probing only a large cap would have answered "no".
  const SCRIP_DUAL_LISTED = "500325"; // RELIANCE INDUSTRIES
  const SCRIP_BSE_ONLY = "530127"; // NPR FINANCE

  // Q9.1 — the index itself, on the BSE-only scrip.
  const archBseOnly = await probe({
    id: `${group}/result-arch/${SCRIP_BSE_ONLY}`,
    group,
    question: "Result_Arch_ng — does BSE publish a per-scrip results index?",
    url: `${BSE_API}/Result_Arch_ng/w?scrip_cd=${SCRIP_BSE_ONLY}`,
    headers: jsonHeaders,
    keepBody: true,
  });

  // Q9.2 — the same index on a dual-listed large cap. This is the CONTROL for
  // the consolidated column: a standalone-only filer cannot show whether
  // `conso_xbrl_link` is ever populated, and reading "always null" off one
  // NBFC would have entered a false fact into the registry.
  const archDual = await probe({
    id: `${group}/result-arch/${SCRIP_DUAL_LISTED}`,
    group,
    question: "Result_Arch_ng on a dual-listed large cap (consolidated column)",
    url: `${BSE_API}/Result_Arch_ng/w?scrip_cd=${SCRIP_DUAL_LISTED}`,
    headers: jsonHeaders,
    keepBody: true,
  });

  findings.push({
    group,
    feed: "BSE results XBRL index (per scrip)",
    pattern: "/Result_Arch_ng/w?scrip_cd={BSE_SCRIP_CODE}",
    answer: describeBseResultArch(archBseOnly, archDual),
    evidence: [archBseOnly.id, archDual.id],
  });

  // Q9.3 — the daily discovery feed. Takes NO parameters, which is worth
  // recording explicitly: a nightly job cannot ask it for a past date, so
  // missing a night is not recoverable from this endpoint.
  const today = await probe({
    id: `${group}/ns-today-results`,
    group,
    question: "NSTodayResults_ng — market-wide list of scrips that filed today",
    url: `${BSE_API}/NSTodayResults_ng/w`,
    headers: jsonHeaders,
    keepBody: true,
  });
  findings.push({
    group,
    feed: "BSE results — daily filer discovery",
    pattern: "/NSTodayResults_ng/w  (no parameters)",
    answer: describeBseTodayResults(today),
    evidence: [today.id],
  });

  // Q9.4 — fetch REAL instances off the index we just read, rather than
  // constructing a URL. The point of the probe is that production will follow
  // the index's own links, so following anything else proves nothing.
  const instanceRungs: ProbeResult[] = [];
  for (const [label, arch] of [
    ["bse-only", archBseOnly],
    ["dual", archDual],
  ] as const) {
    for (const link of pickResultXbrlLinks(arch, 2)) {
      instanceRungs.push(
        await probe({
          id: `${group}/instance/${label}/${basenameOf(link)}`,
          group,
          question: "Does an indexed /XBRLFILES instance actually serve?",
          url: `${BSE_WWW}${link}`,
          headers: exchangeHeaders(BSE_REFERER),
          keepBody: true,
        }),
      );
    }
  }
  findings.push({
    group,
    feed: "BSE results XBRL instance",
    pattern: "https://www.bseindia.com{stand_xbrl_link|conso_xbrl_link}",
    answer: describeBseInstances(instanceRungs),
    evidence: instanceRungs.map((r) => r.id),
  });

  // Q9.5 — the announcement-level XBRL generator. Recorded as a NEGATIVE that
  // looks like a positive, which is the only reason it is worth a request:
  // `CorpXbrlGen.aspx` returns 200 `text/xml` for a "Financial Results"
  // announcement, so anything that checks status + content-type would accept
  // it. The body is the `in-bse-co` ANNOUNCEMENT taxonomy — company name,
  // subject, a link to the PDF — and carries no financial facts at all.
  const annXbrl = await probe({
    id: `${group}/corp-xbrl-gen`,
    group,
    question:
      "CorpXbrlGen.aspx — is the announcement XBRL a results instance? (expected: NO)",
    url:
      `${BSE_WWW}/Msource/90D/CorpXbrlGen.aspx` +
      `?Bsenewid=ad76ac5c-9839-43d0-b384-125514bc485d&Scripcode=${SCRIP_BSE_ONLY}`,
    headers: exchangeHeaders(BSE_REFERER),
    keepBody: true,
  });
  findings.push({
    group,
    feed: "BSE announcement XBRL (NOT results)",
    pattern: "/Msource/90D/CorpXbrlGen.aspx?Bsenewid={NEWSID}&Scripcode={CODE}",
    answer: describeBseAnnouncementXbrl(annXbrl),
    evidence: [annXbrl.id],
  });

  // Q9.6 — the XBRL-details listing, and its "Financial Results" category.
  // This is a DISPROVED lead kept in the probe on purpose. It is the endpoint
  // a reasonable person reaches for (its category vocabulary literally
  // contains "Financial Results"), it answers 200, and for that category it
  // returns zero rows at every date tried. Without the Flag=7 control beside
  // it, that empty is indistinguishable from a wrong param set, and the next
  // person re-derives the same dead end.
  const detailsResults = await probe({
    id: `${group}/cor-xbrl-details/flag22`,
    group,
    question:
      'GetCorXbrlDetails_ng, category 22 "Financial Results" — does it list results XBRL?',
    url:
      `${BSE_API}/GetCorXbrlDetails_ng/w` +
      `?Flag=22&scripcode=&fromdate=2026/08/12&todate=2026/08/13`,
    headers: jsonHeaders,
  });
  const detailsControl = await probe({
    id: `${group}/cor-xbrl-details/flag7-control`,
    group,
    question:
      "GetCorXbrlDetails_ng control — a category that MUST have rows, same date format",
    url:
      `${BSE_API}/GetCorXbrlDetails_ng/w` +
      `?Flag=7&scripcode=&fromdate=2026/08/12&todate=2026/08/13`,
    headers: jsonHeaders,
  });
  findings.push({
    group,
    feed: "BSE XBRL-details listing (disproved route to results)",
    pattern:
      "/GetCorXbrlDetails_ng/w?Flag={CATEGORY}&scripcode=&fromdate={YYYY/MM/DD}&todate={YYYY/MM/DD}",
    answer: describeBseXbrlDetails(detailsResults, detailsControl),
    evidence: [detailsResults.id, detailsControl.id],
  });
}

/** Basename of a site-relative `/XBRLFILES/…` path, for a stable probe id. */
function basenameOf(pathname: string): string {
  return pathname.replace(/^.*\//, "") || pathname;
}

/**
 * Read `stand_xbrl_link` / `conso_xbrl_link` out of a retained index body.
 *
 * Deliberately spreads the sample across DIRECTORIES rather than taking the
 * first N rows. The newest rows all sit in one upload directory, and sampling
 * only those is how "the whole feed is broken" and "one directory is broken"
 * become indistinguishable — which is precisely the distinction Q9.4 found.
 */
function pickResultXbrlLinks(arch: ProbeResult, perDir: number): string[] {
  const body = retainedBodies.get(arch.id);
  if (!body) return [];
  let rows: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const table = (parsed as { Table?: unknown }).Table;
    if (!Array.isArray(table)) return [];
    rows = table as Array<Record<string, unknown>>;
  } catch {
    return [];
  }

  const byDir = new Map<string, string[]>();
  for (const row of rows) {
    for (const key of ["stand_xbrl_link", "conso_xbrl_link"]) {
      const link = row[key];
      if (typeof link !== "string" || link.length === 0) continue;
      const dir = link.replace(/\/[^/]*$/, "/");
      const bucket = byDir.get(dir) ?? [];
      if (bucket.length < perDir && !bucket.includes(link)) bucket.push(link);
      byDir.set(dir, bucket);
    }
  }
  return [...byDir.values()].flat();
}

/** Summarise the per-scrip index: row count, link coverage, basis columns. */
function describeBseResultArch(
  bseOnly: ProbeResult,
  dual: ProbeResult,
): string {
  const read = (
    r: ProbeResult,
  ): { rows: number; stand: number; conso: number; dirs: string[] } | null => {
    const body = retainedBodies.get(r.id);
    if (!body) return null;
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      const table = (parsed as { Table?: unknown }).Table;
      if (!Array.isArray(table)) return null;
      let stand = 0;
      let conso = 0;
      const dirs = new Set<string>();
      for (const row of table as Array<Record<string, unknown>>) {
        const s = row.stand_xbrl_link;
        const c = row.conso_xbrl_link;
        if (typeof s === "string" && s) {
          stand++;
          dirs.add(s.replace(/\/[^/]*$/, "/"));
        }
        if (typeof c === "string" && c) {
          conso++;
          dirs.add(c.replace(/\/[^/]*$/, "/"));
        }
      }
      return { rows: table.length, stand, conso, dirs: [...dirs] };
    } catch {
      return null;
    }
  };

  const a = read(bseOnly);
  const b = read(dual);
  if (!a && !b) {
    return `UNANSWERED — neither index probe returned a readable body (${bseOnly.verdict} / ${dual.verdict}).`;
  }

  const parts: string[] = [];
  if (a) {
    parts.push(
      `BSE-only scrip: ${a.rows} rows, ${a.stand} standalone link(s), ${a.conso} consolidated link(s)`,
    );
  }
  if (b) {
    parts.push(
      `dual-listed scrip: ${b.rows} rows, ${b.stand} standalone, ${b.conso} consolidated`,
    );
  }
  const dirs = [...new Set([...(a?.dirs ?? []), ...(b?.dirs ?? [])])];
  return (
    `CONFIRMED — BSE publishes a per-scrip results XBRL index. ${parts.join("; ")}. ` +
    `Upload directories seen: ${dirs.join(", ") || "none"}. ` +
    `Basis is a COLUMN PAIR here (stand_xbrl_link / conso_xbrl_link) where NSE files two records, ` +
    `and \`Fld_QuarterName\` ("Quarter"/"Year") states the period type rather than leaving it to be inferred. ` +
    `NOTE the shape: keyed by SCRIP CODE with no date range and no paging, so there is no market-wide ` +
    `"filings between X and Y" call — an ingest must iterate scrips.`
  );
}

/** Summarise the daily filer feed, and say plainly what it does NOT carry. */
function describeBseTodayResults(today: ProbeResult): string {
  const body = retainedBodies.get(today.id);
  if (!body) return `${today.verdict} — no body retained.`;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    const table = (parsed as { Table?: unknown }).Table;
    if (!Array.isArray(table)) return `${today.verdict} — no Table in payload.`;
    const first = (table[0] ?? {}) as Record<string, unknown>;
    const keys = Object.keys(first);
    const hasXbrl = keys.some((k) => k.toLowerCase().includes("xbrl"));
    return (
      `${table.length} scrip(s) filed results today. Fields: ${keys.join(", ") || "n/a"}. ` +
      (hasXbrl
        ? "Carries an XBRL link directly."
        : "Carries NO XBRL link — this is a DISCOVERY feed only, so a nightly ingest is two hops " +
          "(today's filers → one Result_Arch_ng per filer).") +
      " Takes NO date parameter, so a missed night cannot be re-asked for here; " +
      "recovery is per-scrip via Result_Arch_ng, which serves full history."
    );
  } catch {
    return `${today.verdict} — payload was not JSON.`;
  }
}

/**
 * Say which indexed instances actually served, and — the load-bearing part —
 * report it PER DIRECTORY.
 *
 * An aggregate "4 of 7 fetched" would be read as a flaky host and retried. The
 * misses are not random: they cluster in one upload directory, which makes
 * them a permanent property of those filings rather than transport noise.
 */
function describeBseInstances(rungs: readonly ProbeResult[]): string {
  if (rungs.length === 0) {
    return "UNANSWERED — the index probes returned no links to follow.";
  }
  const byDir = new Map<string, { ok: number; miss: number; ns: Set<string> }>();
  for (const r of rungs) {
    const dir = new URL(r.url).pathname.replace(/\/[^/]*$/, "/");
    const acc = byDir.get(dir) ?? { ok: 0, miss: 0, ns: new Set<string>() };
    if (isPresent(r)) {
      acc.ok++;
      const body = retainedBodies.get(r.id);
      const head = body?.subarray(0, 900).toString("utf8") ?? "";
      for (const m of head.matchAll(
        /xmlns:(in-bse-fin|in-capmkt)="([^"]+)"/g,
      )) {
        acc.ns.add(m[2] as string);
      }
    } else {
      acc.miss++;
    }
    byDir.set(dir, acc);
  }

  const lines = [...byDir.entries()].map(
    ([dir, a]) =>
      `${dir} → ${a.ok} served / ${a.miss} missing` +
      (a.ns.size ? ` (${[...a.ns].join(", ")})` : ""),
  );
  const totalOk = [...byDir.values()].reduce((n, a) => n + a.ok, 0);
  const dead = [...byDir.entries()].filter(
    ([, a]) => a.ok === 0 && a.miss > 0,
  );

  return (
    `${totalOk}/${rungs.length} indexed instances served. By directory: ${lines.join("; ")}. ` +
    (dead.length
      ? `WHOLE-DIRECTORY GAP: ${dead
          .map(([d]) => d)
          .join(", ")} is indexed but serves nothing — the index links to files ` +
        `the site does not publish. Treat these as FETCH FAILURES, never as parse or taxonomy failures, ` +
        `and do not retry them as if they were transport noise.`
      : "No whole-directory gaps observed.") +
    " Namespaces are the two the parser already dispatches on — `in-bse-fin` is literally a " +
    "bseindia.com-hosted taxonomy and `in-capmkt` is SEBI's, so BSE needs no new parser family."
  );
}

/** The 200-that-is-not-what-you-want. */
function describeBseAnnouncementXbrl(r: ProbeResult): string {
  const body = retainedBodies.get(r.id);
  const text = body?.toString("utf8") ?? "";
  const isCo = text.includes("in-bse-co");
  const hasFinancialFacts = /Revenue|ProfitBeforeTax|TotalIncome/i.test(text);
  if (!isPresent(r)) {
    return `${r.verdict} — the announcement XBRL generator did not respond as expected.`;
  }
  return (
    `SERVES 200 text/xml (${r.bytes ?? 0} bytes) and is NOT a results instance. ` +
    (isCo
      ? "The body declares the `in-bse-co` ANNOUNCEMENT taxonomy — scrip code, company name, " +
        "subject, category, and a link to the PDF."
      : "The body is not the announcement taxonomy either.") +
    ` Financial facts present: ${hasFinancialFacts ? "yes" : "NO"}. ` +
    "Recorded because it is a trap that passes the obvious checks: status 200, content-type text/xml, " +
    "an `<xbrli:xbrl` root, reached from a row whose category is literally \"Result\". " +
    "Anything validating on shape alone would archive these as results filings and project zeros."
  );
}

/** The disproved category route, and why its EMPTY is trustworthy. */
function describeBseXbrlDetails(
  results: ProbeResult,
  control: ProbeResult,
): string {
  const rowsOf = (r: ProbeResult): number | null => {
    const body = retainedBodies.get(r.id);
    if (!body) return null;
    try {
      const parsed: unknown = JSON.parse(body.toString("utf8"));
      const table = (parsed as { Table?: unknown }).Table;
      return Array.isArray(table) ? table.length : null;
    } catch {
      return null;
    }
  };
  const controlRows = rowsOf(control);
  const controlWorked = control.verdict === "PRESENT";

  if (!controlWorked) {
    return (
      `INCONCLUSIVE — category 22 returned ${results.verdict}, but so did the control ` +
      `(category 7, ${control.verdict}) over the SAME dates. With no working control the empty ` +
      `says nothing about whether results are listed here; it may simply be the param set. ` +
      `Re-run the control before drawing any conclusion.`
    );
  }
  return (
    `DISPROVED, with a control. Category 22 "Financial Results" returned ${results.verdict} ` +
    `while category 7 returned PRESENT${controlRows !== null ? ` (${controlRows} rows)` : ""} over the ` +
    `IDENTICAL date range and format, so the \`YYYY/MM/DD\` params are correct and the empty is real. ` +
    `Results XBRL is NOT reachable through this listing — use Result_Arch_ng. ` +
    `Kept in the probe deliberately: this endpoint's own category vocabulary contains the string ` +
    `"Financial Results", so it is the first place anyone will look, and an empty 200 with no control ` +
    `beside it reads as "wrong params" and gets re-derived forever.`
  );
}

// ─── `--registry`: verify REPORT_REGISTRY against live (MONEY-1097) ──

/**
 * Probe every registry row once and report what the exchange actually serves.
 *
 * Anchored to a RECENT weekday rather than each family's `startDate`: the
 * question here is "is this path right?", and the newest file is the one most
 * likely to exist, so a 404 is far more likely to mean "wrong path" than
 * "pruned". Families whose `buildUrl` returns null (the three shapes P1
 * actively disproved) are reported without spending a request — there is
 * nothing to ask.
 */
/**
 * Turn one registry probe into prose an operator can act on.
 *
 * The first version branched only on `PRESENT` and swept EVERY other verdict
 * into "the path is wrong or the file is not published". That is wrong in two
 * ways that matter, because this is the artifact the registry header tells
 * people to flip `enabled` from:
 *
 *   - `EMPTY` means the endpoint answered with no rows — a live case
 *     (`bse-index-daily-all` returns a bare `{}` on wrong params). The path is
 *     fine; the QUERY is wrong. Calling that "path is wrong" sends the reader
 *     to the wrong fix.
 *   - `SKIPPED_BLOCKED` means we never asked. 54 of the 58 probed URLs are on
 *     one host, and the breaker cancels that whole host after a single 403 —
 *     so one early throttle could label ~49 unasked rows "NOT SERVING.
 *     Investigate", with the process still exiting 0. Reporting a question we
 *     declined to ask as a negative answer is the worst failure this file has.
 */
function describeRegistryVerdict(
  result: ProbeResult,
  enabled: boolean,
): string {
  switch (result.verdict) {
    case "PRESENT":
      return enabled
        ? "PRESENT — enabled, confirmed"
        : "PRESENT — SAFE TO ENABLE (flip `enabled: true` and set provenance)";
    case "ABSENT":
      return enabled
        ? "404 — ENABLED BUT NOT SERVING. The path is wrong or the feed moved; investigate before trusting it."
        : "404 — this exact path is wrong; stays disabled until a real one is found";
    case "EMPTY":
      return "EMPTY — the endpoint EXISTS but returned no rows, so the PATH is plausible and the QUERY/params are the problem. Do NOT re-derive the path.";
    case "HTML":
      return "HTML — a 200 carrying a page, not a file. Says the path did not resolve to a file; it is NOT evidence the file is unavailable.";
    case "SKIPPED_BLOCKED":
      return "NOT ASKED — the host tripped the 403 breaker before this row. This is NOT an availability finding; re-run when the host is calm.";
    case "SKIPPED_BUDGET":
      return "NOT ASKED — request budget exhausted. Re-run with a larger --max.";
    case "NO_URL":
      return "NOT ASKED — this row deliberately builds no URL (shape disproved).";
    default:
      return `${result.verdict} — inconclusive; re-probe before drawing any conclusion.`;
  }
}

async function probeRegistry(): Promise<void> {
  const group = "registry";
  const anchor = lastWeekday(addDays(new Date(), -1));
  const families = allFamilies();

  console.log(
    `\n▌ Registry verification — ${families.length} families against ${isoOf(anchor)}\n`,
  );

  for (const family of families) {
    const url = family.buildUrl(anchor);
    if (!url) {
      record({
        id: `${group}/${family.id}`,
        group,
        question: `registry row ${family.id}`,
        url: "(buildUrl returned null)",
        verdict: "NO_URL",
        status: null,
        contentType: null,
        bytes: null,
        preview: null,
        note: `deliberately unfetchable — ${family.notes}`,
      });
      continue;
    }

    const result = await probe({
      id: `${group}/${family.id}`,
      group,
      question: `registry row ${family.id} (${family.provenance}, enabled=${family.enabled})`,
      url,
    });

    findings.push({
      group,
      feed: family.id,
      pattern: url,
      answer: describeRegistryVerdict(result, family.enabled),
      evidence: [result.id],
    });
  }
}

// ─── `--floors`: bracket real historical floors (MONEY-941 step 0d) ──

/** A weekday in `year` at roughly `frac` through it, snapped backwards. */
function sampleWeekday(year: number, frac: number): Date {
  const dayOfYear = Math.max(1, Math.round(365 * frac));
  return lastWeekday(new Date(Date.UTC(year, 0, dayOfYear, 12, 0, 0)));
}

/**
 * Does this family have ANY data in `year`?
 *
 * Samples several spread-out weekdays and returns true on the FIRST hit. One
 * 404 proves nothing here — that is the whole lesson of the sparse 1994 range,
 * where a present day sits either side of an absent one.
 */
async function yearHasData(
  family: ReportFamily,
  year: number,
  spend: () => boolean,
): Promise<{ present: boolean; probes: number; hitOn?: string }> {
  let probes = 0;
  for (let i = 0; i < YEAR_SAMPLES; i++) {
    if (!spend()) break;
    const day = sampleWeekday(year, (i + 1) / (YEAR_SAMPLES + 1));
    const url = family.buildUrl(day);
    if (!url) break;
    probes++;
    const r = await probe({
      id: `floors/${family.id}/${isoOf(day)}`,
      group: "floors",
      question: `${family.id}: does ${year} have data?`,
      url,
    });
    if (isPresent(r)) return { present: true, probes, hitOn: isoOf(day) };
    // A BLOCKED host means we never learned anything — stop rather than
    // record an absence we did not observe.
    if (r.verdict === "BLOCKED" || r.verdict === "SKIPPED_BLOCKED") break;
  }
  return { present: false, probes };
}

/**
 * Walk backwards from a family's current floor to find where its data really
 * starts, and report the bracket.
 */
async function probeFloors(): Promise<void> {
  const group = "floors";
  const targets = allFamilies().filter(
    (f) => f.backfillable && f.buildUrl(new Date()) !== null,
  );
  const filtered = ONLY ? targets.filter((f) => f.id.includes(ONLY)) : targets;

  console.log(
    `\n▌ Floor walk — ${filtered.length} backfillable families ` +
      `(${YEAR_SAMPLES} samples/year, stop after ${MAX_EMPTY_YEARS} empty years)\n`,
  );

  for (const family of filtered) {
    let spent = 0;
    const spend = (): boolean =>
      spent < MAX_PROBES_PER_FAMILY &&
      requestsMade < MAX_REQUESTS &&
      ++spent > 0;

    const startYear = Number(family.startDate.slice(0, 4));
    let earliestPresent: number | null = null;
    let emptyRun = 0;
    let firstHit: string | undefined;

    // Descend year by year from the declared floor.
    for (let year = startYear; year >= 1994; year--) {
      if (!spend()) break;
      spent--; // `spend` above was only a budget probe; yearHasData spends its own
      const res = await yearHasData(family, year, spend);
      if (res.probes === 0) break;

      if (res.present) {
        earliestPresent = year;
        firstHit = firstHit ?? res.hitOn;
        emptyRun = 0;
      } else if (++emptyRun >= MAX_EMPTY_YEARS) {
        break;
      }
    }

    const declared = family.startDate;
    const answer =
      earliestPresent === null
        ? `NO data found at or before ${declared} within budget — floor unproven, leave as-is`
        : earliestPresent < startYear
          ? `REACHES BACK FURTHER than declared: data found in ${earliestPresent} ` +
            `(declared floor ${declared}). Bracket: floor is in ` +
            `[${earliestPresent}-01-01, ${earliestPresent + 1}-01-01). ` +
            `Lower startDate to ~${earliestPresent}-01-01 (provenance: probed).`
          : `declared floor ${declared} looks right — no data found in ${startYear - 1} ` +
            `or earlier (${MAX_EMPTY_YEARS} empty years). Mark provenance: probed.`;

    findings.push({
      group,
      feed: family.id,
      pattern: family.buildUrl(day(declared)) ?? "(no URL)",
      answer,
      evidence: [],
    });

    console.log(`  ${family.id.padEnd(30)} ${answer.slice(0, 96)}`);
    if (requestsMade >= MAX_REQUESTS) {
      console.warn(
        `\n  Budget exhausted after ${family.id}. Re-run with a larger --max ` +
          `or --only=<id> to continue; floors already found are in the report.\n`,
      );
      break;
    }
  }
}

// ─── Reports ─────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const OUT_DIR = path.join(REPO_ROOT, "docs/reference");

/** Write atomically — a half-written registry seed is worse than none. */
function writeAtomic(file: string, body: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, file);
  console.log(`  wrote ${path.relative(REPO_ROOT, file)}`);
}

function verdictCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
  return counts;
}

/**
 * Output basenames per mode.
 *
 * A `--registry` run answers a DIFFERENT question from the P1 question set, so
 * it writes different files. Sharing them would let a registry verification
 * silently destroy the archive-range seed that P2/P3 build on — exactly the
 * partial-overwrite hazard already called out for `--only`.
 */
const OUT_BASENAME = FLOORS_MODE
  ? {
      json: "exchange-archive-floors.json",
      md: "exchange-archive-floors.md",
    }
  : REGISTRY_MODE
    ? {
        json: "exchange-registry-verification.json",
        md: "exchange-registry-verification.md",
      }
    : { json: "exchange-archive-probe.json", md: "exchange-archive-ranges.md" };

function writeJsonReport(startedAt: string): void {
  writeAtomic(
    path.join(OUT_DIR, OUT_BASENAME.json),
    `${JSON.stringify(
      {
        ticket: "MONEY-1096",
        startedAt,
        finishedAt: new Date().toISOString(),
        budget: { max: MAX_REQUESTS, used: requestsMade },
        pacing: { minIntervalMs: MIN_REQUEST_INTERVAL_MS },
        blockedHosts: [...blockedHosts],
        verdictCounts: verdictCounts(),
        findings,
        probes: results,
      },
      null,
      2,
    )}\n`,
  );
}

function writeMarkdownReport(startedAt: string): void {
  const counts = verdictCounts();
  const byGroup = new Map<string, ProbeResult[]>();
  for (const r of results) {
    const list = byGroup.get(r.group) ?? [];
    list.push(r);
    byGroup.set(r.group, list);
  }

  const lines: string[] = [];
  lines.push(
    FLOORS_MODE
      ? "# Historical floor walk — bracketed startDate evidence"
      : REGISTRY_MODE
        ? "# Report registry verification — REPORT_REGISTRY vs live"
        : "# Exchange archive ranges — NSE/BSE registry seed",
  );
  lines.push("");
  lines.push(
    "> Generated by `scripts/data/probe-exchange-archives.ts` (MONEY-1096, Data",
    "> Engine P1). **Do not hand-edit** — re-run the script instead. This is the",
    "> input P2 (`report-archive-sync` registry) and P3 (full-history backfill)",
    "> build on.",
  );
  lines.push("");
  lines.push(`- Probed at: \`${startedAt}\``);
  lines.push(
    `- Requests used: **${requestsMade} / ${MAX_REQUESTS}** at ≤1 rps`,
  );
  lines.push(
    `- Hosts that tripped the 403 breaker: ${
      blockedHosts.size === 0
        ? "**none**"
        : `**${[...blockedHosts].join(", ")}**`
    }`,
  );
  lines.push(
    `- Verdicts: ${Object.entries(counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(" · ")}`,
  );
  lines.push("");
  lines.push(
    "Verdicts: `PRESENT` real payload · `EMPTY` valid endpoint, no rows ·",
    "`HTML` a 200 carrying a challenge/error page (**not** data) · `ABSENT` 404 ·",
    "`BLOCKED` 403 · `SKIPPED_*` never asked, so **not** an availability finding.",
  );
  lines.push("");

  lines.push("## Findings — the registry seed");
  lines.push("");
  lines.push("| Feed family | URL pattern | Finding |");
  lines.push("| --- | --- | --- |");
  for (const f of findings) {
    lines.push(
      `| ${f.feed} | \`${f.pattern}\` | ${f.answer.replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push("");

  lines.push("## Raw probe log");
  lines.push("");
  for (const [group, list] of byGroup) {
    lines.push(`### \`${group}\``);
    lines.push("");
    lines.push("| Probe | Status | Verdict | Bytes | Evidence (first 200B) |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const r of list) {
      const ev = (r.preview ?? r.note ?? "")
        .replace(/\|/g, "\\|")
        .replace(/`/g, "'")
        .slice(0, 110);
      lines.push(
        `| \`${r.id}\` | ${r.status ?? "—"} | ${r.verdict} | ${r.bytes ?? "—"} | ${ev} |`,
      );
    }
    lines.push("");
  }

  lines.push("## URLs probed");
  lines.push("");
  for (const r of results) lines.push(`- \`${r.id}\` → ${r.url}`);
  lines.push("");

  writeAtomic(path.join(OUT_DIR, OUT_BASENAME.md), `${lines.join("\n")}\n`);
}

// ─── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();

  console.log("Probe exchange archives — MONEY-1096 (Data Engine P1)");
  console.log("=".repeat(70));
  console.log(
    `  budget   : ${MAX_REQUESTS} requests, ≥${MIN_REQUEST_INTERVAL_MS}ms apart`,
  );
  console.log(
    `  breaker  : first 403 per host cancels that host's remaining probes`,
  );
  console.log(`  mode     : ${DRY_RUN ? "DRY RUN (no requests)" : "LIVE"}`);
  if (ONLY) console.log(`  filter   : --only=${ONLY}`);
  console.log("=".repeat(70));

  if (FLOORS_MODE) {
    await probeFloors();
  } else if (REGISTRY_MODE) {
    await probeRegistry();
  } else {
    await probeNseArchives();
    await probeNseApi();
    await probeBseWww();
    await probeBseApi();
    await probeBseResultsXbrl();
  }

  console.log("\n" + "=".repeat(70));
  console.log(`  requests used : ${requestsMade} / ${MAX_REQUESTS}`);
  console.log(`  blocked hosts : ${[...blockedHosts].join(", ") || "none"}`);
  console.log(
    `  verdicts      : ${Object.entries(verdictCounts())
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  console.log("=".repeat(70) + "\n");

  if (DRY_RUN) {
    console.log("Dry run — no reports written. Re-run without --dry-run.\n");
    return;
  }

  writeJsonReport(startedAt);
  writeMarkdownReport(startedAt);
  console.log("");
}

main().catch((err: unknown) => {
  console.error("\nProbe run failed:", err);
  process.exitCode = 1;
});
