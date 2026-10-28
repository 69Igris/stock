/**
 * Every route file must actually be MOUNTED, AT THE RIGHT PATH — MONEY-1257.
 *
 * `document-financials-projection` shipped fully provisioned in every respect
 * except one line. The route file existed. The processor existed. The Pub/Sub
 * topic and its push subscription were created. The Cloud Scheduler job was
 * ENABLED. `PUBSUB_TOPICS` carried the constant. Tests covered the logic.
 *
 * And `workers/src/index.ts` never mounted it, so every delivery returned 404
 * and the subscription dead-lettered after five attempts:
 *
 *     httpRequest.status 404  /jobs/document-financials-projection   x5
 *     [dead-letter] sourceJob: "document-financials-projection", deliveryCount: 5
 *
 * Nothing else in the chain could tell. A 404 from Cloud Run is indistinguishable
 * from a job that ran and did nothing unless you look at the HTTP status, and a
 * dead-letter is only visible if someone reads that topic. The scheduler kept
 * firing on time, the monitor saw no writes, and every provisioning check
 * passed — because every provisioning check was for a DIFFERENT artefact.
 *
 * The through-line with this branch's other silent failures: an artefact that
 * exists is not an artefact that is CONNECTED. `topic-publisher-coverage`
 * already asserts every declared topic has a publisher; this asserts the other
 * end — that every route file has a mount, at the path the subscription posts to.
 *
 * ## MONEY-1326 — the mount PATH was never read, and the scan could go empty
 *
 * The first version of this guard checked only that the exported symbol was
 * imported and appeared inside SOME `app.route(...)` call:
 *
 *     new RegExp(`app\\.route\\([^)]*\\b${symbol}\\b`, "s")
 *
 * `[^)]*` swallows the first argument without capturing it, so the MOUNT PATH —
 * the one thing MONEY-1257 was about — was not an input to any assertion. Three
 * mutations, all MEASURED green against that version:
 *
 *   1. Renaming `"/jobs/document-financials-projection"` to
 *      `"/jobs/document-financials-projektion"` and touching nothing else.
 *      The symbol is still imported, still handed to `app.route`, and Cloud Run
 *      404s exactly as it did in MONEY-1257 — the same incident, re-armed, with
 *      the guard written to catch it reporting 2 pass / 0 fail.
 *   2. Adding a route module exporting `zzMoney1257ProbeHandler` and never
 *      mounting it. `exportedRouteSymbol` matches only `export const \w+Route`,
 *      returns null, and the loop `continue`s. An unparseable route module read
 *      as "not a route module" is the same silence one level up.
 *   3. Renaming `export const xRoute` to `export const xRouter` across ALL 68
 *      route files, leaving index.ts untouched so nothing resolves. ZERO modules
 *      were then checked and the suite still reported 2 pass / 0 fail — because
 *      the `[meta]` floor counted FILES ON DISK (`files.length >= 15`, against
 *      68 actual) and never counted symbols RESOLVED or mounts MATCHED. A floor
 *      on the scan's INPUT is not a floor on its OUTPUT.
 *
 * So the mount path is now parsed and JOINED against the authority that decides
 * it: `BASE_WORKER_TOPICS` in `workers/scripts/setup-pubsub.sh`, whose loop
 * builds `--push-endpoint="${SERVICE_URL}/jobs/${BASE_TOPIC}"`. That script says
 * so itself, in four places — "Route path MUST equal this base name". The join
 * is what makes mutation 1 fail: the topic loses its mount and the typo'd path
 * gains no topic, and both halves are named.
 *
 * Measured 2026-09-02: 68 route files, 68 `app.route(` calls, 67 `/jobs/*`
 * mounts, 65 `BASE_WORKER_TOPICS` — and ZERO topics without a mount, so the
 * strict direction ships with a clean baseline rather than a waiver list.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// MONEY-1326 — every path below is anchored to THIS FILE, never to
// `process.cwd()`. The reads used to be bare relative strings, so they resolved
// correctly only when the runner's cwd happened to be `workers/` (which is what
// `yarn test` does, per-workspace) and threw ENOENT from the repo root. Same
// class as the MONEY-1314 coverage test that resolved its roots from the cwd
// and silently scanned ZERO files.
const WORKERS = join(import.meta.dirname, "..");

const ROUTES_DIR = join(WORKERS, "src", "routes");
const INDEX = join(WORKERS, "src", "index.ts");
const PUBSUB_SCRIPT = join(WORKERS, "scripts", "setup-pubsub.sh");

const index = readFileSync(INDEX, "utf8");

/** Route modules on disk, by file stem. */
function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => f.replace(/\.ts$/, ""));
}

/** The exported symbol a route file provides, if it declares one. */
function exportedRouteSymbol(stem: string): string | null {
  const src = readFileSync(join(ROUTES_DIR, `${stem}.ts`), "utf8");
  return src.match(/export const (\w+Route)\b/)?.[1] ?? null;
}

interface Mount {
  readonly path: string;
  readonly symbol: string;
}

/**
 * Every `app.route(PATH, SYMBOL)` in index.ts, with BOTH arguments.
 *
 * Pure and corpus-taking so the parse can be driven with synthetic input — the
 * real file has one multi-line call and 67 single-line ones, which is not
 * enough shape variety to tell a working parser from a lucky one.
 */
export function parseMounts(src: string): Mount[] {
  return [...src.matchAll(/app\.route\(\s*"([^"]+)"\s*,\s*(\w+)\s*,?\s*\)/gs)]
    .map((m) => ({ path: m[1]!, symbol: m[2]! }));
}

/** How many `app.route(` calls exist at all — parsed or not. */
export function countRouteCalls(src: string): number {
  return (src.match(/app\.route\(/g) ?? []).length;
}

/**
 * The topic bases whose push subscription posts to `/jobs/<base>` on the
 * WORKERS service.
 *
 * Bounded to the `BASE_WORKER_TOPICS` array. `EDGAR_TOPICS`, declared a few
 * lines below it, is deliberately NOT included: its loop points at
 * `US_FUNDAMENTALS_URL`, a different Cloud Run service whose routes live in
 * `services/us-fundamentals/app/main.py`, not here. Reading both arrays would
 * demand a Hono mount for five topics this service must never answer.
 */
export function parseWorkerTopics(src: string): string[] {
  const block = /^declare -a BASE_WORKER_TOPICS=\(\n([\s\S]*?)^\)/m.exec(src);
  if (!block) return [];
  return [...block[1]!.matchAll(/^\s*"([^"]+)"\s*$/gm)].map((m) => m[1]!);
}

const files = routeFiles();
const mounts = parseMounts(index);
const routeCallCount = countRouteCalls(index);
const workerTopics = parseWorkerTopics(readFileSync(PUBSUB_SCRIPT, "utf8"));

/** Mounted `/jobs/<name>` names, in mount order. */
const jobMountNames = mounts
  .filter((m) => m.path.startsWith("/jobs/"))
  .map((m) => m.path.slice("/jobs/".length));

/**
 * Route modules with no `export const …Route`.
 *
 * NAMED, never skipped. The old code `continue`d on a null symbol with the
 * comment "helpers, types — skipping those is deliberate"; on the tree as it
 * stands there are ZERO such files, so the branch protected nothing and hid
 * mutation 2. If a genuine non-route helper ever lands in `src/routes/`, add it
 * here with a reason — that is a one-line diff somebody reviews, which is the
 * point. It must never be an invisible default.
 */
const NON_ROUTE_MODULES: readonly string[] = [];

/**
 * Mounted `/jobs/*` paths with no `BASE_WORKER_TOPICS` entry.
 *
 * Both entries are real and both are documented in the ops script itself:
 *
 *   dead-letter           its subscription is created in its OWN block
 *                         (`dead-letter-${ENV}-push` -> `/jobs/dead-letter`,
 *                         60s ack, no DLQ of its own), because the topic it
 *                         consumes IS the dead-letter topic and must not carry
 *                         a dead-letter policy pointing at itself.
 *   financial-data-sync   RETIRED (MONEY-1220). Removed from setup-pubsub.sh
 *                         entirely; the ROUTE survives to answer 200
 *                         `{retired:true}` and DROP the message, because
 *                         Pub/Sub ACKs only on 2xx and the three orphaned
 *                         subscriptions would otherwise burn five delivery
 *                         attempts plus a dead-letter alert per message.
 *   etf-expense-enrichment
 *                         RETIRED (MONEY-1404), and retired the same way for
 *                         the same reason. It was a GUARANTEED no-op rather
 *                         than a job whose upstream died: `fetchKuveraMetadata`
 *                         returns null unless MF_METADATA_PROVIDER === "kuvera"
 *                         and both specs set "amfi", so it could never reach
 *                         its source — which 404s every ISIN anyway.
 *                         `expenseRatio` now comes from AMFI's own monthly TER
 *                         file via mf-metadata-weekly.
 */
const MOUNTS_WITHOUT_TOPIC: readonly string[] = [
  "dead-letter",
  "financial-data-sync",
  "etf-expense-enrichment",
];

describe("every route file is mounted in index.ts (MONEY-1257)", () => {
  it("[premise] the scan resolved route files, symbols and MOUNTS", () => {
    // Floors on the scan's OUTPUT, not just its input. Measured 2026-09-02:
    // 68 route files, 68 app.route() calls, 67 /jobs/ mounts, 65 worker topics.
    // Each floor is ~65% of the measured count — the doctrine the sibling
    // topic-publisher-coverage guard settled on: low enough to survive ordinary
    // deletion, high enough that a scan which stops resolving fails BY NAME
    // instead of shrinking to nothing and reporting green.
    //
    // The old floor was `files.length >= 15` against 68. Fifty-three of the
    // sixty-eight route files could have vanished and it still passed.
    assert.ok(
      files.length >= 44,
      `found ${files.length} route files (expected >= 44); the directory scan has drifted`,
    );
    assert.ok(index.length > 5000, `index.ts read as ${index.length} chars`);

    // EVERY app.route( call must PARSE. An unparseable mount is the one thing
    // this guard must never read as "no route registered" — that is exactly the
    // silence MONEY-1257 shipped on.
    assert.equal(
      mounts.length,
      routeCallCount,
      `${routeCallCount} app.route( calls but only ${mounts.length} parsed. The ` +
        "unparsed ones are mounting routes this guard cannot see; widen " +
        "parseMounts rather than leaving them silent.",
    );
    assert.ok(
      mounts.length >= 44,
      `parsed ${mounts.length} mounts (expected >= 44)`,
    );
    assert.ok(
      workerTopics.length >= 42,
      `parsed ${workerTopics.length} BASE_WORKER_TOPICS entries (expected >= 42) — ` +
        "the array moved or its bounds stopped matching, and an empty topic " +
        "list makes the mount-path join below pass vacuously",
    );
  });

  it("[premise] every route module yields a symbol this guard can check", () => {
    // Mutation 3: renaming `xRoute` -> `xRouter` across all 68 files left the
    // old suite green with ZERO modules checked. A file the symbol matcher
    // cannot read must FAIL, not be skipped.
    const unreadable = files.filter(
      (stem) =>
        !exportedRouteSymbol(stem) && !NON_ROUTE_MODULES.includes(stem),
    );
    assert.deepStrictEqual(
      unreadable,
      [],
      "route modules with no `export const …Route`. Each one is currently " +
        "UNCHECKED — if it is a real route it could be unmounted and this " +
        "guard would not know; if it is a helper, name it in " +
        "NON_ROUTE_MODULES with a reason:\n  " +
        unreadable.join("\n  "),
    );

    const checked = files.filter((stem) => exportedRouteSymbol(stem)).length;
    assert.ok(
      checked >= 44,
      `only ${checked} of ${files.length} route modules resolved a symbol; the ` +
        "export convention moved and the assertions below are running on " +
        "almost nothing",
    );
  });

  it("every route module's exported symbol is mounted", () => {
    const unmounted: string[] = [];
    for (const stem of files) {
      const symbol = exportedRouteSymbol(stem);
      // Absence is policed by the premise above, not swallowed here.
      if (!symbol) continue;
      // Mounted means BOTH imported and handed to app.route(). An import alone
      // is what a half-applied wiring change looks like.
      const imported = new RegExp(
        `\\b${symbol}\\b[^\\n]*from ["']\\./routes/`,
      ).test(index);
      const mounted = mounts.some((m) => m.symbol === symbol);
      if (!imported || !mounted) unmounted.push(`${stem} (${symbol})`);
    }

    assert.deepStrictEqual(
      unmounted,
      [],
      "these route modules exist but are not reachable. Cloud Run answers 404, " +
        "the Pub/Sub subscription dead-letters after its delivery attempts, and " +
        "NOTHING else in the chain notices: the topic exists, the subscription " +
        "exists, the scheduler fires on time, and the job simply never runs. " +
        "Mount them in src/index.ts.",
    );
  });

  it("no two routes are mounted at the SAME path", () => {
    // Hono registers both; the second is reachable only for paths the first
    // does not answer, so one job silently stops receiving its deliveries while
    // both modules look correctly wired.
    const seen = new Map<string, string[]>();
    for (const m of mounts) {
      seen.set(m.path, [...(seen.get(m.path) ?? []), m.symbol]);
    }
    const dupes = [...seen.entries()]
      .filter(([, syms]) => syms.length > 1)
      .map(([path, syms]) => `${path} <- ${syms.join(", ")}`);
    assert.deepStrictEqual(dupes, [], dupes.join("\n  "));
  });
});

describe("MONEY-1326 — the mount PATH matches the push subscription", () => {
  // `workers/scripts/setup-pubsub.sh` builds every worker push endpoint as
  // `${SERVICE_URL}/jobs/${BASE_TOPIC}`, and says so in its own comments:
  // "Route path MUST equal this base name". So the topic list IS the mount-path
  // authority, and the two can be joined instead of trusted separately.

  it("every worker topic has a route mounted at /jobs/<topic>", () => {
    // THE assertion mutation 1 was invisible to. A path typo removes the mount
    // for its topic, so the topic shows up here by name.
    const mounted = new Set(jobMountNames);
    const unmounted = workerTopics.filter((t) => !mounted.has(t));
    assert.deepStrictEqual(
      unmounted,
      [],
      "these Pub/Sub topics have a push subscription posting to " +
        "`/jobs/<topic>` and NO route mounted there. Every delivery 404s and " +
        "the subscription dead-letters after 5 attempts, while the topic, the " +
        "subscription, the scheduler and the processor all look correct — " +
        "MONEY-1257 exactly. Mount it in src/index.ts at the path named:\n  " +
        unmounted.map((t) => `/jobs/${t}`).join("\n  "),
    );
  });

  it("every mounted /jobs/ path is a worker topic (or a named exemption)", () => {
    // The other half of a typo: the path nobody publishes to. On its own this
    // is a dead route rather than a dead job — but it is what turns a rename
    // from "one topic is unmounted" into "…and here is the path you meant".
    const known = new Set([...workerTopics, ...MOUNTS_WITHOUT_TOPIC]);
    const orphans = jobMountNames.filter((n) => !known.has(n));
    assert.deepStrictEqual(
      orphans,
      [],
      "these routes are mounted at a /jobs/ path that NO Pub/Sub subscription " +
        "posts to, so nothing can ever reach them. Either the path is a typo " +
        "(check the topic it was meant to serve), or the topic was removed and " +
        "the route should be deleted — or, if the route deliberately outlives " +
        "its topic the way `financial-data-sync` does, add it to " +
        "MOUNTS_WITHOUT_TOPIC with the reason:\n  " +
        orphans.map((n) => `/jobs/${n}`).join("\n  "),
    );
  });

  it("[control] every named exemption is still real", () => {
    // An exemption list decays into a waiver list unless the entries are
    // checked. Both of these must still be MOUNTED (otherwise delete the
    // entry) and still absent from the topic array (otherwise the exemption is
    // stale and the strict case should be doing the work).
    const mounted = new Set(jobMountNames);
    const topics = new Set(workerTopics);
    for (const name of MOUNTS_WITHOUT_TOPIC) {
      assert.ok(
        mounted.has(name),
        `${name} is exempted but no longer mounted — drop it from MOUNTS_WITHOUT_TOPIC`,
      );
      assert.ok(
        !topics.has(name),
        `${name} is now a real BASE_WORKER_TOPICS entry, so the exemption is ` +
          "stale and is suppressing a check that would otherwise run",
      );
    }
  });

  it("[falsifiability] the parser reads both call shapes and rejects neither", () => {
    // index.ts holds 67 single-line calls and ONE multi-line call — the
    // document-financials-projection mount, wrapped by prettier. A parser that
    // handled only the common shape would silently drop the very route this
    // guard is named after.
    const parsed = parseMounts(
      [
        'app.route("/jobs/alpha", alphaRoute);',
        "app.route(",
        '  "/jobs/beta",',
        "  betaRoute,",
        ");",
      ].join("\n"),
    );
    assert.deepStrictEqual(parsed, [
      { path: "/jobs/alpha", symbol: "alphaRoute" },
      { path: "/jobs/beta", symbol: "betaRoute" },
    ]);
  });

  it("[control] an app.route the parser cannot read is COUNTED, not dropped", () => {
    // The premise compares parsed against counted precisely so a mount spelled
    // in a shape this regex misses (a template literal, a constant, a spread)
    // fails loudly instead of reading as "no route registered".
    const src = [
      'app.route("/jobs/alpha", alphaRoute);',
      "app.route(JOB_PATHS.beta, betaRoute);",
    ].join("\n");
    assert.equal(countRouteCalls(src), 2);
    assert.equal(parseMounts(src).length, 1);
  });

  it("[control] the topic parser stays bounded to BASE_WORKER_TOPICS", () => {
    // EDGAR_TOPICS sits a few lines away and points at a DIFFERENT service.
    // Harvesting it would demand a Hono mount for five topics this service must
    // never answer, and the resulting red would name the wrong repair.
    const src = [
      "declare -a BASE_WORKER_TOPICS=(",
      '  "alpha-sync"',
      "  # a comment",
      '  "beta-sync"',
      ")",
      "declare -a EDGAR_TOPICS=(",
      '  "edgar-parse-13f"',
      ")",
    ].join("\n");
    assert.deepStrictEqual(parseWorkerTopics(src), ["alpha-sync", "beta-sync"]);
    assert.deepStrictEqual(parseWorkerTopics("nothing here"), []);
  });
});
