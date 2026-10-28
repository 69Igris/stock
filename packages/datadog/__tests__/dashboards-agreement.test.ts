/**
 * MONEY-1361 — every widget queries a series this repo actually emits.
 *
 * ## The one assertion this file exists for
 *
 * A widget over a metric nobody emits renders as an EMPTY GRAPH, and an empty
 * graph is indistinguishable from a healthy quiet system. It is not an error,
 * nothing goes red, and the board keeps looking like coverage. That is
 * MONEY-1238's defect class, and this stack has now shipped it at four layers:
 * a monitor on the unprefixed `job.written`, monitors POSTed to the wrong
 * Datadog site, an `env:prod` tag no worker has ever emitted, and a per-source
 * counter incremented before the call it counted.
 *
 * A dashboard is the layer where it is HARDEST to notice, because a dashboard
 * has no alert state to be wrong — so the check has to be a test.
 *
 * ## Why the inventory is DERIVED and not a list
 *
 * A hand-typed list of "metrics we emit" agrees with the code exactly until
 * somebody renames one, and then it agrees with nothing while still passing.
 * Every entry below is read from the thing that emits it:
 *
 *   job counters      `EMITTED_JOB_METRICS` (packages/datadog/src/job-outcome.ts)
 *   realtime          `RT_COUNTER_METRICS` / `RT_GAUGE_METRICS`, read out of
 *                     workers/src/realtime/rt-metrics-logic.ts
 *   everything else   a SOURCE SCAN of the `metrics.increment/gauge/histogram`
 *                     call sites in apps/web, workers/src and packages/../src
 *   python            `services/us-fundamentals/app/store/outcome.py`
 *
 * The prefix is the sharp edge. `datadog-metrics` is initialised with
 * `prefix: "stockbook."`, so the code passes `job.written` and the series that
 * arrives is `stockbook.job.written`. A widget must query the PREFIXED name,
 * and `"stockbook.job.written".includes("job.written")` is true — which is
 * exactly how the original monitor assertion passed over the live bug.
 *
 * ## The inventory is deliberately a FLOOR
 *
 * The source scan only sees a STRING LITERAL first argument, so a metric named
 * through a constant object (`atlas-gate.ts`'s `METRIC.FALLBACK`) is absent
 * from it. That direction is safe: a missing entry can only make this file
 * refuse a widget that would have worked, never accept one that renders empty.
 * Widen the scan when a board needs such a metric — never widen the exemption.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EMITTED_JOB_METRICS } from "../src/job-outcome";
import { DD_SERVER_SPAN, METRIC_PREFIX } from "../src/constants";
import { blankNonCode, matchingClose } from "./job-outcome-source-scan";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DASH_DIR = join(ROOT, "scripts/ops/datadog/dashboards");
const SCRIPT = join(ROOT, "scripts/ops/datadog/apply-dashboards.sh");
const MONITORS = join(ROOT, "scripts/ops/datadog/apply-monitors.sh");
const SCRIPT_SRC = readFileSync(SCRIPT, "utf8");

/** The boards the plan names. Present so DELETING one fails here. */
const EXPECTED_BOARDS = [
  "cache-and-brokers",
  "job-health",
  "prod-health",
  "us-market",
  "web-vitals",
  "workers-performance",
];

// ── The boards, as the API would receive them ───────────────────────────────
//
// Read through the SCRIPT rather than with JSON.parse, so what is asserted is
// the artefact that would be PUT: `_`-prefixed documentation keys stripped at
// every depth by `dd_render`, `{{slo:…}}` still in place (a dry run has no
// credentials to resolve one with). A test that parsed the files directly
// would pass over a renderer that drops half of each board.

/**
 * A `curl` that cannot reach the network, first on PATH for every dry run.
 *
 * `--dry-run` is a BRANCH in a shell script and this repo has shipped two bugs
 * in exactly that branch. The offline guarantee is therefore moved off the
 * branch and onto the process: no credentials, and a `curl` that logs and exits
 * non-zero. The log is asserted empty below.
 */
const NO_NET = mkdtempSync(join(tmpdir(), "dashboards-offline-"));
const NO_NET_LOG = join(NO_NET, "calls.log");
writeFileSync(
  join(NO_NET, "curl"),
  [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$STUB_LOG"',
    "cat > /dev/null", // DRAIN `-K -`. A stub that never reads stdin makes the
    // credential writer die of SIGPIPE; `pipefail` then surfaces 141 and
    // `dd_request` misreports it as "curl exited 141". Invisible on macOS,
    // fatal on Linux — which is how CI caught it and a local run did not.
    'echo "curl reached during a --dry-run" >&2',
    "exit 99",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
writeFileSync(NO_NET_LOG, "");

interface WidgetRequest {
  q?: string;
  log_query?: Record<string, unknown>;
  rum_query?: Record<string, unknown>;
  display_type?: string;
  aggregator?: string;
}
interface Widget {
  definition: {
    type: string;
    title?: string;
    requests?: WidgetRequest[];
    slo_id?: string;
    [k: string]: unknown;
  };
}
interface Board {
  title: string;
  description: string;
  layout_type: string;
  template_variables: { name: string; prefix: string; default: string }[];
  widgets: Widget[];
}

function renderBoards(): Board[] {
  const childEnv = { ...process.env };
  delete childEnv.DD_API_KEY;
  delete childEnv.DD_APP_KEY;
  const out = execFileSync("bash", [SCRIPT, "prod", "--dry-run"], {
    encoding: "utf8",
    cwd: ROOT,
    env: {
      ...childEnv,
      PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
      STUB_LOG: NO_NET_LOG,
    },
  });
  return out
    .split("\n")
    .filter((l) => l.trimStart().startsWith("{"))
    .map((l) => JSON.parse(l.trim()) as Board);
}

const BOARDS = renderBoards();

// ── The emitted inventory, derived from the emitters ────────────────────────

/**
 * Sub-series a HISTOGRAM turns into before it reaches a query.
 *
 * Neither client sends the bare name: `datadog-metrics` aggregates client-side
 * into `.avg/.count/.max/.median/.min/.95percentile`, and DogStatsD hands the
 * raw samples to the agent, which does the same. So a widget on the base name
 * of a histogram is an empty graph — the exact failure this file is about, one
 * level below the name itself.
 */
const HISTOGRAM_SUFFIXES = [
  "",
  ".avg",
  ".count",
  ".max",
  ".median",
  ".min",
  ".95percentile",
];

/** Directories whose `metrics.*` call sites are scanned for string literals. */
const SCAN_ROOTS = (): string[] => {
  const roots = [join(ROOT, "apps/web"), join(ROOT, "workers/src")];
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    if (existsSync(src)) roots.push(src);
  }
  return roots;
};

function walkTs(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === "dist" || e === ".next") continue;
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkTs(full, out);
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * `name -> is it a histogram` for every literal metrics call site.
 *
 * COMMENTS ARE BLANKED FIRST, with the same scanner the job-outcome guards use.
 * That is not tidiness: `metrics.ts`'s own JSDoc carries
 * `histogram("broker.sync.duration", …)` and `gauge("pairing.trades_processed", …)`
 * as @example lines, and both of those metrics have NO call site anywhere in
 * the repo. Scanning raw text would put two series nobody emits into the
 * inventory of series we emit, and the file would then cheerfully accept a
 * widget on either — inverting its entire purpose.
 */
function scanLiteralCallSites(): Map<string, boolean> {
  const found = new Map<string, boolean>();
  const CALL =
    /\b(?:metrics\.(increment|gauge|histogram)|incrementCounter|gauge|histogram)\(\s*"([a-z][a-z0-9_.]*)"/g;
  for (const root of SCAN_ROOTS()) {
    for (const file of walkTs(root)) {
      const raw = readFileSync(file, "utf8");
      // Cheap pre-filter: blanking is a character scanner and most files have
      // no call site at all.
      if (
        !raw.includes("increment(") &&
        !raw.includes("gauge(") &&
        !raw.includes("histogram(")
      )
        continue;
      // `preserveStringBodies` — the DEFAULT blanker empties string CONTENT
      // too, which is right for the reachability guard and catastrophic here:
      // the metric name IS the string, so the scan would find nothing and
      // report every widget green against an empty inventory.
      const code = blankNonCode(raw, { preserveStringBodies: true });
      for (const m of code.matchAll(CALL)) {
        const isHistogram = /histogram\(\s*"$/.test(
          m[0]!.slice(0, m[0]!.length - m[2]!.length),
        );
        found.set(m[2]!, found.get(m[2]!) === true || isHistogram);
      }
    }
  }
  return found;
}

/**
 * The realtime holder's metric names, read out of the module that emits them.
 *
 * READ AS TEXT, not imported, and that is a constraint rather than a
 * preference: `packages/datadog/tsconfig.test.json` sets `rootDir: "."`, so an
 * `import` reaching into `workers/src` is TS6059 and breaks `yarn type-check`
 * for this whole package. It is also the pattern that config explicitly
 * describes — "the guards read workers/src/processors/*.ts as TEXT at runtime
 * via node:fs, never as a module, which is the whole point of a source scan".
 *
 * The names still come from the emitting file at run time, so a rename there
 * moves this set with it. What is lost versus an import is the compiler's
 * check that the symbols exist at all, which the floor assertion below
 * replaces: an extraction that silently returns nothing is the one failure a
 * subset check cannot see.
 */
function scanRealtimeMetrics(): string[] {
  const src = blankNonCode(
    readFileSync(
      join(ROOT, "workers/src/realtime/rt-metrics-logic.ts"),
      "utf8",
    ),
    { preserveStringBodies: true },
  );
  const names: string[] = [];
  for (const constName of ["RT_COUNTER_METRICS", "RT_GAUGE_METRICS"]) {
    const at = src.indexOf(`export const ${constName}`);
    assert.ok(at >= 0, `${constName} is gone from rt-metrics-logic.ts`);
    // Brace-matched rather than "the next `\n};`" — the two objects do not end
    // the same way (`} as const;` vs `};`) and RT_COUNTER_METRICS carries a
    // generic type argument in braces before its body.
    const open = src.indexOf("= {", at) + 2;
    const close = matchingClose(src, open);
    assert.ok(open > 1 && close > open, `could not read ${constName}'s body`);
    for (const m of src.slice(open, close).matchAll(/"(rt\.[a-z0-9_]+)"/g))
      names.push(m[1]!);
  }
  return names;
}

/**
 * The Python side, read out of `outcome.py` the same way.
 *
 * `settings.METRIC_PREFIX` is already IN the constant there — DogStatsD has no
 * prefix configured, so what is passed is what arrives — which is the opposite
 * convention from the TypeScript side and the reason both are read from source
 * rather than assumed.
 */
function scanPython(): Map<string, boolean> {
  const src = readFileSync(
    join(ROOT, "services/us-fundamentals/app/store/outcome.py"),
    "utf8",
  );
  // Read the Python prefix rather than reusing the TypeScript one, so the two
  // can be COMPARED (they are asserted equal below). A silent disagreement here
  // is a whole service's worth of series landing in a namespace no board queries.
  PY_METRIC_PREFIX =
    /^METRIC_PREFIX\s*=\s*"([a-z0-9_.]+)"/m.exec(
      readFileSync(
        join(ROOT, "services/us-fundamentals/app/settings.py"),
        "utf8",
      ),
    )?.[1] ?? "";
  const byConst = new Map<string, string>();
  for (const m of src.matchAll(
    /^([A-Z][A-Z0-9_]*)\s*=\s*settings\.METRIC_PREFIX\s*\+\s*"([a-z0-9_.]+)"/gm,
  ))
    byConst.set(m[1]!, m[2]!);
  const out = new Map<string, boolean>();
  for (const [constName, metric] of byConst)
    out.set(
      `${PY_METRIC_PREFIX}${metric}`,
      new RegExp(`statsd\\.histogram\\(\\s*${constName}\\b`).test(src),
    );
  return out;
}

/** Filled by scanPython(), read from services/us-fundamentals/app/settings.py. */
let PY_METRIC_PREFIX = "";

const RT_METRICS = scanRealtimeMetrics();
const LITERAL_SITES = scanLiteralCallSites();
const PYTHON_SITES = scanPython();

function buildInventory(): Set<string> {
  const out = new Set<string>();
  const add = (name: string, isHistogram: boolean) => {
    if (isHistogram) for (const s of HISTOGRAM_SUFFIXES) out.add(`${name}${s}`);
    else out.add(name);
  };
  for (const n of Object.values(EMITTED_JOB_METRICS)) add(n, false);
  for (const n of RT_METRICS) add(`${METRIC_PREFIX}${n}`, false);
  for (const [n, isHist] of LITERAL_SITES) add(`${METRIC_PREFIX}${n}`, isHist);
  for (const [n, isHist] of PYTHON_SITES) add(n, isHist);
  return out;
}

const INVENTORY = buildInventory();

/**
 * Series that come from a VENDOR SDK, exempt BY NAME and with a reason.
 *
 * Stated as an allow-list rather than left to fall out of a regex that happens
 * not to match, so widening it is a visible line in a diff. Nothing here can
 * ever cover a `stockbook.` series — asserted below, because the cheapest way
 * to make this whole file pass is to add one prefix.
 */
const VENDOR_EXEMPT: { prefix: string; why: string }[] = [
  {
    prefix: "trace.",
    why:
      "dd-trace-js and ddtrace-py emit these from inside the tracer, under " +
      "each service's SERVER span — declared per service in DD_SERVER_SPAN " +
      "(MONEY-1534: `hono.request`, `web.request`, `fastapi.request`). The " +
      "NAME is ours to declare but the series is not ours to emit, so " +
      "apply-service-monitors.sh preflights the declared span against the live " +
      "org, which is the only check that can exist for a series we do not " +
      "control. Which is exactly why the case below pins the DIRECTION: a " +
      "preflight cannot tell a server span from a client one, because both " +
      "have points.",
  },
  {
    prefix: "gcp.",
    why:
      "Supplied by Datadog's Google Cloud integration (MONEY-1379), not emitted " +
      "by this repo — 798 series observed active on 2026-09-11. There is no local " +
      "constant to compare against; apply-perf-monitors.sh preflights every " +
      "series it alerts on against the live org, which is the only check that " +
      "can exist for a name we do not control. A gcp.* series that stops " +
      "arriving is caught by that preflight (three outcomes: points / none / " +
      "did-not-run), not by this file.",
  },
];

const isExempt = (metric: string): boolean =>
  VENDOR_EXEMPT.some((e) => metric.startsWith(e.prefix));

/** Every `agg:metric{` in a widget query — the appendix's own regex. */
const METRIC_RE = /(?:sum|avg|min|max|count|p\d+):([a-z0-9_.]+)\{/g;

/**
 * A query that names at least one `gcp.` series.
 *
 * Derived from the same extraction every other check uses rather than a
 * substring test for "gcp.", so a query the extractor cannot read is NOT
 * silently classified as vendor — it falls through to the `$env` rule and to
 * the "every widget with a query yields at least one metric" floor.
 */
const isGcpQuery = (q: string): boolean =>
  [...q.matchAll(METRIC_RE)].some((m) => m[1]!.startsWith("gcp."));

interface MetricRef {
  board: string;
  widget: string;
  metric: string;
}
const metricRefs: MetricRef[] = [];
/** Widgets that carry a `q` and the metrics found in it — for the "no widget parsed zero" floor. */
const qWidgets: { board: string; widget: string; q: string; found: number }[] =
  [];

for (const board of BOARDS) {
  for (const w of board.widgets) {
    const title = w.definition.title ?? `(${w.definition.type})`;
    for (const req of w.definition.requests ?? []) {
      if (!req.q) continue;
      const found = [...req.q.matchAll(METRIC_RE)].map((m) => m[1]!);
      qWidgets.push({
        board: board.title,
        widget: title,
        q: req.q,
        found: found.length,
      });
      for (const metric of found)
        metricRefs.push({ board: board.title, widget: title, metric });
    }
  }
}

// ── The stubbed-curl harness for the apply path ─────────────────────────────

const SLO_NAMES = [
  "[production] Scheduled jobs write what they select",
  "[production] Scheduled jobs run",
  "[production] Workers request success",
  "[production] EDGAR detection under 5 minutes",
];
const SLO_LISTING = JSON.stringify({
  data: SLO_NAMES.map((name, i) => ({ id: `slo-id-${i}`, name })),
});

function runWithStubbedCurl(
  dashboardListing: string,
  status = "200",
): { code: number; stdout: string; stderr: string; curlLog: string } {
  const dir = mkdtempSync(join(tmpdir(), "dashboards-stub-"));
  const log = join(dir, "calls.log");
  try {
    writeFileSync(
      join(dir, "curl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$STUB_LOG"',
        "cat > /dev/null", // DRAIN `-K -`. A stub that never reads stdin makes the
        // credential writer die of SIGPIPE; `pipefail` then surfaces 141 and
        // `dd_request` misreports it as "curl exited 141". Invisible on macOS,
        // fatal on Linux — which is how CI caught it and a local run did not.
        "# Two endpoints, two shapes. Answering the dashboard listing with an",
        "# SLO body would make the script abort on 'no dashboards[]' — which",
        "# looks exactly like the fail-closed behaviour under test and would",
        "# make those cases pass for the wrong reason.",
        'case "$*" in',
        '  *"/api/v1/slo"*) body="$STUB_SLO_BODY"; status=200 ;;',
        '  *) body="$STUB_DASH_BODY"; status="$STUB_STATUS" ;;',
        "esac",
        'printf "%s\\n%s\\n" "$body" "$status"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeFileSync(log, "");
    const res = spawnSync("bash", [SCRIPT, "prod"], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_LOG: log,
        STUB_DASH_BODY: dashboardListing,
        STUB_SLO_BODY: SLO_LISTING,
        STUB_STATUS: status,
        DD_API_KEY: "stub-api-key",
        DD_APP_KEY: "stub-app-key",
      },
    });
    return {
      code: res.status ?? -1,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      curlLog: readFileSync(log, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const countDashboardCalls = (curlLog: string, method: string): number =>
  curlLog
    .split("\n")
    .filter(
      (l) => l.includes(`-X ${method} `) && l.includes("/api/v1/dashboard"),
    ).length;

// ────────────────────────────────────────────────────────────────────────────

describe("dashboards — premise", () => {
  it("renders every board the plan names, with real widgets in them", () => {
    // The floor. Every assertion below iterates BOARDS, and an empty array
    // satisfies all of them — so a render that produced nothing, or a board
    // somebody deleted, has to fail here or it fails nowhere.
    assert.ok(
      BOARDS.length >= 5,
      `expected at least 5 boards, rendered ${BOARDS.length}`,
    );
    const files = readdirSync(DASH_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort();
    for (const name of EXPECTED_BOARDS)
      assert.ok(files.includes(name), `dashboards/${name}.json is missing`);
    const widgets = BOARDS.reduce((n, b) => n + b.widgets.length, 0);
    assert.ok(widgets >= 30, `expected >= 30 widgets in total, got ${widgets}`);
    assert.ok(
      metricRefs.length >= 20,
      `expected >= 20 metric references, extracted ${metricRefs.length}`,
    );
  });

  it("the dry run reached no network", () => {
    assert.equal(
      readFileSync(NO_NET_LOG, "utf8"),
      "",
      "the stubbed curl was called during --dry-run",
    );
  });

  it("the inventory is derived, non-trivial, and REFUSES the metrics nobody emits", () => {
    // The vacuity probe, baked in. Every other assertion in this file is a
    // SUBSET check against INVENTORY, and a subset check against a set
    // containing everything passes for free. So the set is pinned in BOTH
    // directions: it must contain the series the emitters name, and it must NOT
    // contain three that look completely plausible and have no call site.
    assert.ok(METRIC_PREFIX.length > 0, "METRIC_PREFIX must not be empty");
    // Two languages, one namespace. DogStatsD has no prefix setting, so the
    // Python side bakes it into the constant while `datadog-metrics` applies it
    // at init — two spellings of one fact, and a disagreement would put an
    // entire service's series where no board looks.
    assert.equal(
      PY_METRIC_PREFIX,
      METRIC_PREFIX,
      "services/us-fundamentals/app/settings.py disagrees with constants.ts",
    );
    // A source scan that returns nothing is the one failure a subset check
    // cannot see, so each contributing scan carries its own floor.
    assert.ok(
      RT_METRICS.length >= 10,
      `the realtime name scan found ${RT_METRICS.length} metrics`,
    );
    assert.ok(
      LITERAL_SITES.size >= 4,
      `the call-site scan found ${LITERAL_SITES.size} metrics`,
    );
    assert.ok(
      PYTHON_SITES.size >= 4,
      `the outcome.py scan found ${PYTHON_SITES.size} metrics`,
    );
    assert.ok(
      INVENTORY.size >= 15,
      `inventory collapsed to ${INVENTORY.size} entries — the derivation broke`,
    );
    for (const present of [
      `${METRIC_PREFIX}job.written`,
      `${METRIC_PREFIX}job.selected`,
      `${METRIC_PREFIX}rt.health_ok`,
      `${METRIC_PREFIX}rt.subscribed`,
      `${METRIC_PREFIX}rt.bars_closed`,
      `${METRIC_PREFIX}rt.refused_mixed_source`,
      `${METRIC_PREFIX}cache.hit`,
      `${METRIC_PREFIX}broker.sync.failure`,
      `${METRIC_PREFIX}edgar.detect_latency_seconds.95percentile`,
    ])
      assert.ok(INVENTORY.has(present), `inventory is missing ${present}`);

    for (const absent of [
      // Never existed. The mutation the ticket names.
      `${METRIC_PREFIX}job.wrote`,
      // The bare names. `datadog-metrics` prepends the prefix, so these are
      // the series the monitor queried for two releases while emitting nothing.
      "job.written",
      "job.selected",
      // BOTH of these appear in metrics.ts as JSDoc @example arguments and have
      // NO call site in the repo — grep `histogram(` / `gauge(` across apps,
      // workers and packages returns the definitions and the doc comments.
      // If the comment blanker regresses, they land in the inventory and the
      // two widgets this file made us drop become quietly acceptable again.
      `${METRIC_PREFIX}broker.sync.duration.95percentile`,
      `${METRIC_PREFIX}pairing.trades_processed`,
    ])
      assert.ok(
        !INVENTORY.has(absent),
        `${absent} is in the emitted inventory — nothing emits it, so the ` +
          `derivation is wrong and every subset check below is vacuous`,
      );
  });
});

describe("dashboards — every widget queries a series we emit", () => {
  it("every metric named in every query is in the emitted inventory", () => {
    const bad = metricRefs.filter(
      (r) => !INVENTORY.has(r.metric) && !isExempt(r.metric),
    );
    assert.deepEqual(
      bad.map((r) => `${r.board} / ${r.widget}: ${r.metric}`),
      [],
      "a widget queries a metric nothing in this repo emits — it will render " +
        "as an empty graph, which is indistinguishable from a healthy quiet " +
        "system. Either wire the emitter or drop the widget.",
    );
  });

  it("no widget queries the UNPREFIXED name", () => {
    // Whole-token, not `includes`. The bare name is a SUBSTRING of the prefixed
    // one, so a containment test passes identically either way — which is
    // exactly how MONEY-1238 survived the assertion written to catch it.
    for (const r of metricRefs)
      assert.ok(
        r.metric.startsWith(METRIC_PREFIX) || isExempt(r.metric),
        `${r.board} / ${r.widget} queries "${r.metric}" — datadog-metrics ` +
          `prepends "${METRIC_PREFIX}", so that series does not exist`,
      );
  });

  it("every widget with a query yields at least one metric", () => {
    // Without this the subset check has a hole: a query the extractor cannot
    // read contributes zero names and passes silently, which is a widget nobody
    // has ever checked wearing the badge of one that was.
    const blind = qWidgets.filter((w) => w.found === 0);
    assert.deepEqual(
      blind.map((w) => `${w.board} / ${w.widget}: ${w.q}`),
      [],
      "no metric name could be extracted from these queries",
    );
  });

  it("the vendor exemption is narrow, used, and cannot cover our own series", () => {
    for (const e of VENDOR_EXEMPT) {
      assert.ok(
        e.why.length > 40,
        `${e.prefix} is exempt with no reason given`,
      );
      assert.ok(
        !`${METRIC_PREFIX}x`.startsWith(e.prefix),
        `the "${e.prefix}" exemption would swallow our own ${METRIC_PREFIX} ` +
          `series — the cheapest way to make this whole file pass`,
      );
    }
    // A dead exemption is one nobody notices growing. Assert it is load-bearing.
    assert.ok(
      metricRefs.some((r) => isExempt(r.metric)),
      "no widget uses an exempt series — delete the exemption instead",
    );
  });

  it("MONEY-1379 — the gcp. exemption admits gcp and refuses ours, and every prefix ends in a dot", () => {
    // Both directions on the door T1 opened. `startsWith` is a PREFIX test and
    // nothing in the exemption's shape makes it a NAMESPACE test — so "gcp"
    // without the trailing dot would also admit a hypothetical `gcpfoo.`
    // series, and a one-character slip to "g" admits everything on every board
    // while the other assertions in this describe keep passing (nothing this
    // repo emits starts with a bare "g", so the "cannot cover our own series"
    // check above does not catch it either).
    assert.ok(
      isExempt("gcp.pubsub.subscription.oldest_unacked_message_age"),
      "the gcp. exemption does not admit the integration's own series",
    );
    assert.ok(
      !isExempt(`${METRIC_PREFIX}job.written`),
      `an exemption admits ${METRIC_PREFIX}job.written — every subset check ` +
        "in this file is then vacuous",
    );
    for (const e of VENDOR_EXEMPT)
      assert.ok(
        e.prefix.endsWith("."),
        `the "${e.prefix}" exemption is not a namespace — without the ` +
          "trailing dot it matches any metric that merely STARTS with those " +
          "characters",
      );
  });
});

describe("dashboards — env is a variable, not a literal", () => {
  it("every board declares the $env template variable", () => {
    for (const b of BOARDS) {
      const tv = b.template_variables?.find((v) => v.name === "env");
      assert.ok(tv, `${b.title} has no "env" template variable`);
      assert.equal(
        tv!.prefix,
        "env",
        `${b.title}'s env variable must filter on the env: tag`,
      );
      assert.equal(tv!.default, "production");
    }
  });

  it("no query hardcodes an environment", () => {
    // A board pinned to production keeps rendering production's numbers while
    // its selector says qa. That is worse than an empty widget, because it
    // looks right.
    for (const b of BOARDS) {
      const json = JSON.stringify(b);
      for (const literal of ["env:production", "env:qa", "env:prod"])
        assert.ok(
          !json.includes(literal),
          `${b.title} hardcodes "${literal}" — use the $env template variable`,
        );
    }
  });

  it("every metric, log and RUM query is scoped by $env — except gcp.*, which has no env tag", () => {
    // The one exception, and it is stated as an INVERSION rather than a skip.
    //
    // `gcp.*` comes from Datadog's Google Cloud integration (MONEY-1379) and
    // carries no `env` tag at all — Google's resource labels are the scope, and
    // `env` is not one of them. So `{$env}` on a gcp query resolves to
    // `env:production`, matches ZERO series, and renders an empty graph: the
    // exact failure this whole file exists to prevent, arrived at by obeying
    // the rule instead of breaking it.
    //
    // Skipping those queries would leave a hole the other way — a gcp widget
    // could gain `$env` later and nothing would notice — so each query is
    // required to be on exactly one side of the line, never neither.
    for (const b of BOARDS)
      for (const w of b.widgets) {
        const title = w.definition.title ?? `(${w.definition.type})`;
        for (const req of w.definition.requests ?? []) {
          const scoped =
            req.q ??
            (req.log_query as { search?: { query?: string } } | undefined)
              ?.search?.query ??
            (req.rum_query as { search?: { query?: string } } | undefined)
              ?.search?.query;
          if (scoped && isGcpQuery(scoped)) {
            assert.ok(
              !scoped.includes("$env"),
              `${b.title} / ${title} scopes a gcp.* series by $env — those ` +
                "series carry no env tag, so the widget matches nothing and " +
                "renders empty",
            );
            continue;
          }
          assert.ok(
            scoped?.includes("$env"),
            `${b.title} / ${title} is not scoped by $env`,
          );
        }
      }
  });
});

describe("dashboards — shape and identity", () => {
  it("the board titles are exactly these, because the title IS the identity", () => {
    // The one place in this file where a literal list is the RIGHT answer.
    // `apply-dashboards.sh` upserts by title, so a title is not a label — it is
    // the primary key. Editing one does not rename the live board: the next run
    // finds no match, POSTs a SECOND board, and the original stays behind
    // holding whatever it held, with nothing to say it was orphaned. Deriving
    // this list from the files would agree with any edit and catch none of them.
    //
    // Renaming a board is therefore a deliberate act: change it here AND delete
    // the old board in the UI, in the same change.
    assert.deepEqual(BOARDS.map((b) => b.title).sort(), [
      "UseMoney — US market stack",
      "UseMoney — cache and brokers",
      "UseMoney — job health",
      "UseMoney — production health",
      "UseMoney — web vitals",
      "UseMoney — workers performance",
    ]);
    const titles = BOARDS.map((b) => b.title);
    for (const t of titles) assert.ok(t && t.trim().length > 0);
    assert.equal(
      new Set(titles).size,
      titles.length,
      `duplicate board titles: ${titles.join(" | ")}`,
    );
  });

  it("every board carries the managed-by description and an ordered layout", () => {
    for (const b of BOARDS) {
      assert.equal(
        b.description,
        "managed-by:apply-dashboards — edit the file, not the UI",
        `${b.title} does not say where it is edited`,
      );
      assert.equal(b.layout_type, "ordered");
    }
  });

  it("every board has at least four widgets", () => {
    for (const b of BOARDS)
      assert.ok(
        b.widgets.length >= 4,
        `${b.title} has ${b.widgets.length} widgets — a board nobody opens`,
      );
  });

  it("the renderer strips documentation keys at every depth", () => {
    // The boards carry `_why` / `_units` because JSON has no comments, and
    // Datadog rejects an unknown field inside a widget definition with a 400.
    // `dd_render` strips them at EVERY depth; a top-level-only strip renders a
    // board that cannot be applied at all.
    const raw = readFileSync(join(DASH_DIR, "job-health.json"), "utf8");
    assert.ok(raw.includes('"_why"'), "the fixture for this check is gone");
    for (const b of BOARDS)
      assert.ok(
        !JSON.stringify(b).includes('"_'),
        `${b.title} still carries a documentation key`,
      );
  });

  it("every slo widget references an SLO BY NAME, never a pasted id", () => {
    const sloWidgets = BOARDS.flatMap((b) =>
      b.widgets.filter((w) => w.definition.type === "slo"),
    );
    assert.ok(sloWidgets.length >= 4, "the four T7 SLOs are not on any board");
    for (const w of sloWidgets)
      assert.match(
        String(w.definition.slo_id),
        /^\{\{slo:.+\}\}$/,
        "an SLO id pasted from the UI is an id that exists in exactly one " +
          "org and renders blank everywhere else — reference the NAME and let " +
          "the script resolve it",
      );
    // T7 lands slos.json in the same PR. Checked when it is there rather than
    // restating four names that would then exist in two places.
    const slosFile = join(ROOT, "scripts/ops/datadog/slos.json");
    if (existsSync(slosFile)) {
      const names = new Set(
        (JSON.parse(readFileSync(slosFile, "utf8")) as { name: string }[]).map(
          (s) => s.name,
        ),
      );
      for (const w of sloWidgets) {
        const named = /^\{\{slo:(.+)\}\}$/.exec(
          String(w.definition.slo_id),
        )![1]!;
        assert.ok(names.has(named), `no SLO named "${named}" in slos.json`);
      }
    }
  });
});

describe("dashboards — the board and the alarm cannot disagree", () => {
  it("the job-health table is the zero-write monitor's own query", () => {
    // Rendered from apply-monitors.sh rather than restated here. A copy of the
    // formula in this file would agree with the monitor only until one of them
    // is edited — and the entire value of the widget is that it shows exactly
    // what the alarm is about to page on.
    const childEnv = { ...process.env };
    delete childEnv.DD_API_KEY;
    delete childEnv.DD_APP_KEY;
    delete childEnv.DD_NOTIFY;
    const rendered = execFileSync("bash", [MONITORS, "prod", "--dry-run"], {
      encoding: "utf8",
      cwd: ROOT,
      env: {
        ...childEnv,
        PATH: `${NO_NET}:${childEnv.PATH ?? ""}`,
        STUB_LOG: NO_NET_LOG,
      },
    })
      .split("\n")
      // apply-monitors.sh INDENTS its bodies by two spaces; this one does not.
      .filter((l) => l.trimStart().startsWith("{"))
      .map((l) => JSON.parse(l.trim()) as { name: string; query: string });

    const zeroWrite = rendered.find((m) => m.query.includes("clamp_max("));
    assert.ok(zeroWrite, "no clamp_max monitor rendered — the source is gone");

    // Strip what legitimately differs — the scope braces (one job vs `by
    // {job}`), the grouping keyword, the monitor's evaluation window and its
    // threshold — and the formulas must be character-identical.
    const skeleton = (q: string): string =>
      q
        .replace(/^sum\(last_[^)]*\):/, "")
        .replace(/\s*>\s*0\s*$/, "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/\bby\b/g, "")
        .replace(/\s+/g, "");

    const table = BOARDS.find((b) => b.title.includes("job health"))!
      .widgets[0]!.definition.requests![0]!.q!;
    assert.equal(
      skeleton(table),
      skeleton(zeroWrite!.query),
      "the job-health table has drifted from monitor-zero-write.json's query",
    );
    // …and the skeleton must still be the formula, not an empty string that
    // two broken inputs would both reduce to.
    assert.match(skeleton(table), /^clamp_max\(sum:.+\)-clamp_max\(sum:.+\)$/);
  });
});

describe("MONEY-1379 — the workers-performance board", () => {
  const PERF = () => {
    const b = BOARDS.find((x) => x.title === "UseMoney — workers performance");
    assert.ok(b, "the workers-performance board did not render");
    return b!;
  };
  /** A widget's `markers`, which the Widget type carries as an index signature. */
  const markersOf = (w: Widget): { value?: string; label?: string }[] =>
    (w.definition.markers as { value?: string; label?: string }[]) ?? [];

  it("the oldest-unacked markers ARE Pub/Sub's ack deadline, read from setup-pubsub.sh", () => {
    // DERIVED, not retyped. 600 written on both sides would agree with itself
    // forever — including after somebody lowered the subscriptions' deadline,
    // at which point the board draws the alarm line in the wrong place and
    // every widget still looks fine. The deadline lives in exactly one place we
    // control, so read it from there.
    const PUBSUB = readFileSync(
      join(ROOT, "workers/scripts/setup-pubsub.sh"),
      "utf8",
    );
    const deadline = /--ack-deadline=(\d+)/.exec(PUBSUB)?.[1];
    assert.ok(
      deadline,
      "no --ack-deadline in workers/scripts/setup-pubsub.sh — the derivation " +
        "broke, and a check that derives nothing passes for free",
    );
    const expected = `y = ${deadline}`;

    // Every widget that charts the age, not just the first: both carry the
    // line, and asserting on one would let the other drift.
    const aged = PERF().widgets.filter((w) =>
      (w.definition.requests ?? []).some((r) =>
        r.q?.includes("oldest_unacked_message_age"),
      ),
    );
    assert.ok(
      aged.length >= 2,
      `found ${aged.length} oldest-unacked widgets — expected both`,
    );
    for (const w of aged) {
      const values = markersOf(w).map((m) => m.value);
      assert.ok(
        values.includes(expected),
        `"${w.definition.title}" has no "${expected}" marker — its markers ` +
          `are ${JSON.stringify(values)}. This series is SECONDS; the handler-` +
          `time widget is MILLISECONDS and its deadline marker is ${
            Number(deadline) * 1000
          }.`,
      );
    }
  });

  it("no gcp. query on this board is scoped by $env", () => {
    // gcp.* carries no env tag, so `{$env}` there matches zero series and
    // renders an empty graph — MONEY-1238's defect class reached by obeying the
    // rule the other boards live by. Asserted on THIS board by name as well as
    // in the global $env case, because this is the only board where the
    // temptation exists.
    const gcp = PERF()
      .widgets.flatMap((w) =>
        (w.definition.requests ?? []).map((r) => ({
          title: w.definition.title ?? `(${w.definition.type})`,
          q: r.q ?? "",
        })),
      )
      .filter((r) => isGcpQuery(r.q));
    assert.ok(
      gcp.length >= 16,
      `only ${gcp.length} gcp queries found on the board — the scan broke, ` +
        "and a scan that finds nothing passes every assertion below",
    );
    assert.deepEqual(
      gcp.filter((r) => r.q.includes("$env")).map((r) => r.title),
      [],
      "a gcp.* widget is scoped by $env — those series carry no env tag, so " +
        "it matches nothing and renders empty",
    );
  });
});

describe("MONEY-1379 — a widget scope is grammar Datadog will accept", () => {
  // Datadog's tag scope takes EITHER comma-joined terms OR the boolean
  // keywords AND / OR / IN, never both:
  //
  //   {subscription_id:*-prod-push,response_class IN (remote_server_5xx,…)}
  //   -> HTTP 400  "'AND' and 'OR' cannot be mixed with ','"
  //
  // and it is refused at POST TIME ONLY. The board is well-formed JSON, every
  // metric in it is real, and every other case in this file passed — while
  // `apply-dashboards.sh prod` applied five of six boards and dropped
  // workers-performance on the floor.
  //
  // That is this file's own premise one layer down. A widget over a metric
  // nobody emits renders an EMPTY GRAPH; a widget the API REFUSES takes the
  // WHOLE BOARD with it, so the context a pager is meant to land in is simply
  // not there. Neither failure has an alert state to go red, which is why both
  // have to be a test.
  //
  // Commas inside an `IN (...)` list are the vendor's own list separator and
  // are legal — one live widget scopes twelve subscriptions that way — so those
  // lists are collapsed before the comma test. That collapse is load-bearing
  // rather than tidy, and the second case below pins it.

  /** Every `{...}` group in a query: the scope, and any `by {...}` grouping. */
  const scopesOf = (q: string): string[] =>
    [...q.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!);

  /** `IN (a,b)` -> `IN()`, so only STRUCTURAL commas survive. */
  const collapseInLists = (scope: string): string =>
    scope.replace(/\bIN\s*\([^)]*\)/g, "IN()");

  // Space-anchored on purpose: a bare /\bIN\b/ would read the tag VALUE in
  // `{country:IN}` as the keyword. No board carries one today, and a guard
  // that starts false-positiving is a guard somebody deletes.
  const KEYWORD = /(?:^|\s)(?:AND|OR|IN)(?=\s|\()/;

  const mixesCommaAndBoolean = (q: string): boolean =>
    scopesOf(q).some(
      (s) => KEYWORD.test(s) && collapseInLists(s).includes(","),
    );

  it("no scope on any board mixes a comma with AND / OR / IN", () => {
    const scopes = BOARDS.flatMap((b) =>
      b.widgets.flatMap((w) =>
        (w.definition.requests ?? []).flatMap((r) =>
          scopesOf(r.q ?? "").map((scope) => ({
            board: b.title,
            widget: w.definition.title ?? `(${w.definition.type})`,
            scope,
          })),
        ),
      ),
    );
    assert.ok(
      scopes.length >= 40,
      `only ${scopes.length} scopes across ${BOARDS.length} boards — the ` +
        "extractor broke, and an extractor that finds nothing passes for free",
    );

    assert.deepEqual(
      scopes
        .filter(
          ({ scope }) =>
            KEYWORD.test(scope) && collapseInLists(scope).includes(","),
        )
        .map((m) => `${m.board} / ${m.widget}: {${m.scope}}`),
      [],
      "Datadog refuses a comma-joined scope beside a boolean keyword, with a " +
        "400 at apply time. Join those terms with AND: {a:b AND c IN (d,e)}.",
    );
  });

  it("fires on the query that actually 400'd, and spares the legal IN list", () => {
    // The literal widget 6 shipped with, kept here so this guard cannot
    // quietly stop matching the defect it was written for.
    const refused =
      "sum:gcp.pubsub.subscription.push_request_count" +
      "{subscription_id:*-prod-push,response_class IN (remote_server_5xx,unreachable)}" +
      " by {subscription_id}.as_count()";
    const accepted = refused.replace(
      "-prod-push,response_class",
      "-prod-push AND response_class",
    );
    assert.equal(
      mixesCommaAndBoolean(refused),
      true,
      "the guard no longer recognises the query Datadog answered 400 to",
    );
    assert.equal(
      mixesCommaAndBoolean(accepted),
      false,
      "the guard rejects the AND form, which was verified live against the org",
    );

    // A bare IN list is LEGAL and one board depends on it. Without the
    // collapse this reads as a comma beside a keyword and the guard would
    // fail the board it is meant to protect.
    assert.equal(
      mixesCommaAndBoolean(
        "avg:gcp.pubsub.subscription.oldest_unacked_message_age" +
          "{subscription_id IN (a-prod-push,b-prod-push,c-prod-push)} by {subscription_id}",
      ),
      false,
      "the IN-list collapse regressed — a legal multi-value scope now fails",
    );
  });
});

describe("apply-dashboards.sh", () => {
  it("rejects an unknown argument and a missing environment", () => {
    for (const args of [["prod", "--wat"], ["staging"], []]) {
      const res = spawnSync("bash", [SCRIPT, ...args], {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, PATH: `${NO_NET}:${process.env.PATH ?? ""}` },
      });
      assert.equal(
        res.status,
        2,
        `${args.join(" ") || "(no args)"} was accepted`,
      );
    }
    const unknown = spawnSync("bash", [SCRIPT, "prod", "--wat"], {
      encoding: "utf8",
      cwd: ROOT,
    });
    assert.match(unknown.stderr, /unknown argument/);
  });

  it("upserts by TITLE: PUT when the title exists, POST when it does not", () => {
    const existing = JSON.stringify({
      dashboards: BOARDS.map((b, i) => ({
        id: `abc-def-${i}`,
        title: b.title,
      })),
    });
    const hit = runWithStubbedCurl(existing);
    assert.equal(hit.code, 0, hit.stderr);
    assert.equal(countDashboardCalls(hit.curlLog, "PUT"), BOARDS.length);
    assert.equal(countDashboardCalls(hit.curlLog, "POST"), 0);
    // The listing is PAGED, so the bound is per RUN and not per board. A stub
    // that answers every `start` with the same page ends it on the second
    // request, which contributes no new ids; five boards must never mean five
    // listings.
    assert.ok(
      countDashboardCalls(hit.curlLog, "GET") <= 2,
      `one listing per run, not one per board — ${countDashboardCalls(hit.curlLog, "GET")} GETs`,
    );

    const miss = runWithStubbedCurl(JSON.stringify({ dashboards: [] }));
    assert.equal(miss.code, 0, miss.stderr);
    assert.equal(countDashboardCalls(miss.curlLog, "POST"), BOARDS.length);
    assert.equal(countDashboardCalls(miss.curlLog, "PUT"), 0);

    // …and the match is on the TITLE, not on position in the listing. One
    // stale title in an otherwise complete listing must produce exactly one
    // POST — the shape a rename actually has in production, where it costs a
    // duplicate board rather than an error.
    const stale = runWithStubbedCurl(
      JSON.stringify({
        dashboards: BOARDS.map((b, i) => ({
          id: `abc-def-${i}`,
          title: i === 0 ? `${b.title} (old name)` : b.title,
        })),
      }),
    );
    assert.equal(stale.code, 0, stale.stderr);
    assert.equal(countDashboardCalls(stale.curlLog, "POST"), 1);
    assert.equal(countDashboardCalls(stale.curlLog, "PUT"), BOARDS.length - 1);
  });

  it("resolves every {{slo:…}} before writing", () => {
    const existing = JSON.stringify({
      dashboards: BOARDS.map((b, i) => ({
        id: `abc-def-${i}`,
        title: b.title,
      })),
    });
    const res = runWithStubbedCurl(existing);
    assert.ok(
      !res.curlLog.includes("{{slo:"),
      "a board was written with an unresolved SLO placeholder — Datadog " +
        "accepts a nonsense slo_id and renders the widget blank, so this " +
        "would apply 'successfully' and show nothing",
    );
    assert.ok(
      res.curlLog.includes("slo-id-0"),
      "the resolved SLO id never reached the request body",
    );
  });

  it("fails CLOSED on a listing it cannot read", () => {
    // `curl` exits 0 on a 403, so an unreadable listing that read as "no
    // dashboards exist" would POST a duplicate of every board on the account —
    // and a duplicate dashboard is a board somebody edits while watching the
    // other one.
    //
    // The two causes get DIFFERENT diagnostics, and the distinction is checked
    // rather than assumed: "HTTP 403" is a key or permission problem the
    // operator fixes in Secret Manager, "no dashboards[]" is an API answering
    // something unexpected. Aborting with the wrong sentence sends them to the
    // wrong place, and asserting only on the exit code cannot tell the two
    // apart — the second guard would silently cover for the first being gone.
    for (const [listing, status, expected] of [
      [
        JSON.stringify({ dashboards: [] }),
        "403",
        /could not list existing dashboards \(HTTP 403\)/,
      ],
      ["not json at all", "200", /no dashboards\[\]/],
      [JSON.stringify({ data: [] }), "200", /no dashboards\[\]/],
    ] as const) {
      const res = runWithStubbedCurl(listing, status);
      assert.notEqual(res.code, 0, `${status} / ${listing} did not abort`);
      assert.match(res.stderr, expected, `${status} / ${listing}`);
      assert.equal(countDashboardCalls(res.curlLog, "PUT"), 0);
      assert.equal(countDashboardCalls(res.curlLog, "POST"), 0);
    }
  });

  it("reads the WHOLE listing, not just the first page", () => {
    // The listing had no query string at all, and the shape guard only requires
    // an array — so a truncated page is a VALID one. A board that exists but did
    // not fit on page 1 is a title MISS, a title miss falls through to POST, and
    // a POST is counted as APPLIED: the accounting check passes, the run prints
    // success, and the account gains a duplicate board. Nothing in that chain
    // errors.
    //
    // Its own harness rather than the shared one: this is the only case that
    // needs `curl` to answer DIFFERENTLY per `start`, which is exactly the
    // property under test.
    const dir = mkdtempSync(join(tmpdir(), "dashboards-pages-"));
    const log = join(dir, "calls.log");
    try {
      writeFileSync(
        join(dir, "curl"),
        [
          "#!/bin/sh",
          'printf "%s\\n" "$*" >> "$STUB_LOG"',
          "cat > /dev/null", // DRAIN `-K -`. A stub that never reads stdin makes the
          // credential writer die of SIGPIPE; `pipefail` then surfaces 141 and
          // `dd_request` misreports it as "curl exited 141". Invisible on macOS,
          // fatal on Linux — which is how CI caught it and a local run did not.
          'case "$*" in',
          '  *"/api/v1/slo"*) printf "%s\\n%s\\n" "$STUB_SLO_BODY" 200; exit 0 ;;',
          "esac",
          "# Keyed by `start`, so a run that never asks for a second page — or",
          "# that drops the query string — sees only the decoys on page 1.",
          'case "$*" in',
          '  *"start=0"*) body="$STUB_P0" ;;',
          '  *"start=2"*) body="$STUB_P1" ;;',
          '  *"start="*)  body=\'{"dashboards":[]}\' ;;',
          '  *)           body="$STUB_UNPAGED" ;;',
          "esac",
          'printf "%s\\n%s\\n" "$body" 200',
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(log, "");
      const res = spawnSync("bash", [SCRIPT, "prod"], {
        encoding: "utf8",
        cwd: ROOT,
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          STUB_LOG: log,
          STUB_SLO_BODY: SLO_LISTING,
          // Page 1 is two boards nobody here owns; every real title is on
          // page 2. Stop after one page and all five look new.
          STUB_P0: JSON.stringify({
            dashboards: [
              { id: "other-1", title: "Somebody else's board" },
              { id: "other-2", title: "Another team's board" },
            ],
          }),
          STUB_P1: JSON.stringify({
            dashboards: BOARDS.map((b, i) => ({
              id: `abc-def-${i}`,
              title: b.title,
            })),
          }),
          // What an un-paged GET would be answered with — deliberately the
          // decoys, so dropping `?count=…&start=…` reproduces the defect
          // rather than accidentally passing.
          STUB_UNPAGED: JSON.stringify({
            dashboards: [{ id: "other-1", title: "Somebody else's board" }],
          }),
          DD_API_KEY: "stub-api-key",
          DD_APP_KEY: "stub-app-key",
        },
      });
      const curlLog = readFileSync(log, "utf8");
      assert.equal(res.status, 0, res.stderr);
      assert.equal(
        countDashboardCalls(curlLog, "POST"),
        0,
        "a board on page 2 was treated as new — this run created " +
          `${countDashboardCalls(curlLog, "POST")} DUPLICATE boards and ` +
          "reported success",
      );
      assert.equal(countDashboardCalls(curlLog, "PUT"), BOARDS.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives its API host from DD_SITE rather than a literal", () => {
    // apply-monitors.sh POSTed to US1 for two releases while DD_SITE said
    // otherwise — monitors created in an org that never receives the metric.
    // The derivation MOVED to lib-datadog.sh (five scripts had five copies of
    // it, and the site is the one fact a 403 answers silently). So the property
    // is now checked across the SEAM: this script must call the shared
    // resolver, and the resolver must read the constant. Asserting only the
    // first half would pass against a library that hardcoded a host, which is
    // the very thing being prevented.
    const LIB_SRC = readFileSync(
      join(ROOT, "scripts/ops/datadog/lib-datadog.sh"),
      "utf8",
    );
    assert.match(
      SCRIPT_SRC,
      /dd_resolve_api_host/,
      "this script does not reach the shared API-host resolver",
    );
    assert.match(LIB_SRC, /DD_SITE\\s\*=/);
    assert.ok(
      !/api\.[a-z0-9]+\.datadoghq\.com/.test(SCRIPT_SRC.replace(/^#.*$/gm, "")),
      "the API host is written out as a literal somewhere in the script",
    );
  });
});

describe("MONEY-1359 — the APM widgets read the SERVER span", () => {
  it("no widget queries dd-trace-js's HTTP CLIENT span", () => {
    // `web.request` is dd-trace-js's generic SERVER span on the v0 attribute
    // schema and `http.request` is its HTTP CLIENT span — both in
    // node_modules/dd-trace/packages/dd-trace/src/service-naming/schemas/v0/
    // web.js (`server.http.opName` :78, `client.http.opName` :16), and v0 is
    // what applies because DD_TRACE_SPAN_ATTRIBUTE_SCHEMA is set nowhere in
    // this repo. A framework plugin renames the server span per SERVICE
    // (MONEY-1534), so the positive half below reads DD_SERVER_SPAN.
    //
    // Two widgets titled "hits vs errors" charted the CLIENT span for a
    // release, so they showed our OUTBOUND calls to NSE, BSE, Screener, Tiingo
    // and Gemini under a title claiming our own request handling. Nothing else
    // in this file can catch it: `trace.` is VENDOR_EXEMPT precisely because
    // there is no local constant, and a preflight passes either way — the
    // client series genuinely has points.
    const traceRefs = metricRefs.filter((r) => r.metric.startsWith("trace."));
    assert.ok(
      traceRefs.length >= 6,
      `only ${traceRefs.length} trace.* refs found — the widget scan broke, ` +
        "and a scan that finds nothing passes every assertion below",
    );
    for (const r of traceRefs) {
      assert.ok(
        !r.metric.startsWith("trace.http.request."),
        `${r.board} / "${r.widget}" reads ${r.metric} — that is dd-trace-js's ` +
          "HTTP CLIENT span (our outbound vendor calls), not the server span " +
          "this widget claims. Use the service's span from DD_SERVER_SPAN",
      );
    }
    // The positive half, per service and against the DECLARATION. Without it,
    // deleting the widgets satisfies the loop. It pinned `trace.web.request.*`
    // for the workers until MONEY-1534, and passed for twelve days over a
    // widget charting a span the service had stopped emitting.
    for (const service of [
      "stockbook-workers",
      "tiingo-realtime",
      "us-fundamentals",
    ] as const) {
      const span = DD_SERVER_SPAN[service];
      assert.ok(
        qWidgets.some(
          (w) =>
            w.q.includes(`trace.${span}.`) &&
            w.q.includes(`service:${service}`),
        ),
        `no widget charts trace.${span}.* (its declared server span) for ` +
          `service:${service}`,
      );
    }
  });
});
