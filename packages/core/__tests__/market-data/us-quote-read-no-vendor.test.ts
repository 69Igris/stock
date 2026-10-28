/**
 * A US quote REQUEST must never become a Tiingo REQUEST — MONEY-1309.
 *
 * ## Why this is a guard and not a comment
 *
 * Tiingo is a PAID METERED api. We are on the Commercial plan — 20,000
 * requests/hour, 150,000/day, and a licence that is INTERNAL USE ONLY — and the
 * client paces PROACTIVELY at 180 ms between requests because the vendor
 * publishes no quota headers, so a 429 is the only feedback and it arrives too
 * late to steer by. `/api/market/quote` is polled every 5-10 seconds per open
 * tab. One import of `tiingo-client` into the read path turns every open browser
 * tab into a quota consumer, and NOTHING WOULD FAIL: prices would keep
 * rendering, correctly, until the day the budget ran out mid-session. That is
 * the same silent shape as Tickertape's five-month block (CLAUDE.md), which is
 * exactly why it gets a test rather than a note.
 *
 * ## What it checks
 *
 * TWO walks, because the property has two halves and the first suite covered
 * only one of them (MONEY-1309 A5 — see the second header, mid-file).
 *
 * 1. A transitive walk rooted at the three CORE read modules, following
 *    relative imports inside `src/`.
 * 2. A transitive walk rooted at the four APP entry points that serve a US
 *    quote, following imports that stay inside the app and CHECKING every
 *    `@usemoney/*` specifier that crosses the package boundary.
 *
 * Every module reached must:
 *
 *   - not import `tiingo-client` (or any `*-client` under `tiingo/`), and
 *   - not name a Tiingo host.
 *
 * Transitive, not file-local, on purpose: a file-local scan is satisfied by
 * moving the import one hop away, which is the tidy bypass
 * `no-feed-fetch-bypass.test.ts` records having been caught by exactly once.
 *
 * Mirrors packages/core/__tests__/market-data/no-feed-fetch-bypass.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Roots: the wiring module and its pure sibling. CWD is packages/core. */
const ROOTS = [
  join("src", "market-data", "tiingo", "tiingo-rt-read.ts"),
  join("src", "market-data", "tiingo", "tiingo-rt-read-logic.ts"),
  join("src", "market-data", "tiingo", "tiingo-rt-keys.ts"),
];

/** Hosts the vendor answers on. Both are real and both are billed. */
const TIINGO_HOSTS = ["api.tiingo.com", "apimedia.tiingo.com", "tiingo.com"];

/** Modules that would bring a billed HTTP client with them. */
const VENDOR_CLIENT = /tiingo\/tiingo-(client|news|corp-actions)\b/;

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

/**
 * Drop comments before scanning for hosts.
 *
 * Not laxity — the opposite. The read modules DOCUMENT the vendor by name,
 * because "this path must never call api.tiingo.com" is the contract and a
 * reader has to be told which host is meant. Scanning raw source would make the
 * guard fail on its own explanation and push the next person to delete the
 * explanation rather than keep the guard. Comments are prose; CODE is the thing
 * that can issue a request, so code is what is checked.
 *
 * String literals survive the strip, so a host hidden in one is still caught.
 *
 * LINE BEFORE BLOCK, always — MONEY-1143. A `//` comment containing an opening
 * `/*` starts a phantom block that runs to the next `*` + `/`, hundreds of lines
 * away, and because every assertion in this file is an ABSENCE, the swallowed
 * code reads as a PASS. That is the one failure mode where a broken guard and a
 * healthy one are indistinguishable, and it has been fixed five times in this
 * repo; `apps/web/__tests__/meta/comment-strip-ordering.test.ts` fails the suite
 * if this order is ever swapped back.
 */
function stripComments(src: string): string {
  return src
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Resolve a relative specifier to a real `.ts` file under `src/`, or null. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(fromFile), spec));
  for (const candidate of [
    base,
    `${base}.ts`,
    join(base, "index.ts"),
    `${base}.tsx`,
  ]) {
    if (existsSync(candidate) && candidate.endsWith(".ts")) return candidate;
  }
  return null;
}

/** Every module transitively reachable from `roots` by relative import. */
function reachable(roots: readonly string[]): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [...roots];
  // Bounded: `src/` is finite and every file is visited once, but a cap makes a
  // pathological cycle a failed assertion rather than a hung suite.
  let guard = 0;
  while (queue.length > 0) {
    if (++guard > 5_000) throw new Error("import walk did not terminate");
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const src = readFileSync(file, "utf8");
    seen.set(file, src);
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const next = resolveRelative(file, m[1]!);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return seen;
}

const GRAPH = reachable(ROOTS);

describe("the US quote read path cannot reach Tiingo (MONEY-1309)", () => {
  it("[meta] the walk found a real, non-trivial graph", () => {
    // Ceiling. Every assertion below is "this string is absent", which an empty
    // graph satisfies vacuously — the precise shape of a test that reports
    // green while protecting nothing.
    for (const root of ROOTS) {
      assert.ok(GRAPH.has(root), `root not walked: ${root}`);
    }
    assert.ok(
      GRAPH.size >= 5,
      `walk reached only ${GRAPH.size} modules — the graph should include the ` +
        `candle store and the Redis singleton`,
    );
    // Pin two modules we KNOW must be in there, so a resolver regression that
    // silently stopped following imports shows up here.
    const files = [...GRAPH.keys()].join("\n");
    assert.match(files, /candles\/candle-repository\.ts/);
    assert.match(files, /cache\/redis\.ts/);
  });

  it("[meta] the comment strip does not swallow code", () => {
    // Ceiling for the strip itself: if it ate everything, the host scan below
    // would pass on any file at all.
    const stripped = stripComments(GRAPH.get(ROOTS[0]!)!);
    assert.ok(
      stripped.includes("getRedisClient"),
      "stripComments removed real code — the host scan would be vacuous",
    );
    assert.ok(
      !stripped.includes("api.tiingo.com"),
      "the header comment naming the vendor host survived the strip",
    );
    // And it still catches a host in a STRING, which is the shape that matters.
    assert.ok(
      stripComments('const u = "https://api.tiingo.com/x";').includes(
        "api.tiingo.com",
      ),
      "a host inside a string literal must survive the strip",
    );
  });

  it("names no Tiingo host anywhere in the graph", () => {
    for (const [file, rawSrc] of GRAPH) {
      const src = stripComments(rawSrc);
      for (const host of TIINGO_HOSTS) {
        assert.ok(
          !src.includes(host),
          `${file} names ${host}. The US quote read path serves from OUR OWN ` +
            `Redis keys and \`candles\` rows; reaching the vendor from a route ` +
            `polled every 5s per tab spends a metered, internal-use-only quota.`,
        );
      }
    }
  });

  it("imports no Tiingo HTTP client anywhere in the graph", () => {
    for (const [file, src] of GRAPH) {
      IMPORT_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        const spec = m[1]!;
        assert.ok(
          !VENDOR_CLIENT.test(spec),
          `${file} imports ${spec}. Only the nightly \`us-eod-sync\` job and ` +
            `the always-on socket holder may contact Tiingo.`,
        );
      }
    }
  });

  it("issues no fetch() of its own", () => {
    // The read path's I/O is Prisma and one ioredis client. A `fetch(` in any
    // module the walk reaches is, by construction, a call to something this
    // path has no business calling.
    const OWN = ROOTS;
    for (const file of OWN) {
      const src = GRAPH.get(file)!;
      assert.ok(
        !/\bfetch\s*\(/.test(src),
        `${file} calls fetch(). This path reads Redis and Mongo only.`,
      );
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   MONEY-1309 (A5) — the walk above never leaves `packages/core`

   `resolveRelative` returns `null` for any specifier that does not start with
   `.`, so the graph rooted at the three core modules is a CORE graph. That is
   worth having — those three files are where the read path's logic lives — but
   `apps/web/CLAUDE.md` cited it as proof that the ROUTES cannot reach the
   vendor, and it never looked at a route.

   Mutation-proved: appending

     import { fetchTiingoEod } from "@usemoney/core/market-data/tiingo/tiingo-client";
     export async function __probe(s: string) { return fetchTiingoEod(s, d, d); }

   to `apps/web/app/api/market/quote/route.ts` — the exact route the claim names
   — passed every guard in this package. A live metered EOD call on a route
   polled every 5-10 s per open tab, and nothing failed.

   ## Why this is a SECOND walk and not a widened first one

   Measured: following `@usemoney/*` specifiers into `packages/*` grows the
   closure from 19 modules to 784 and reaches `tiingo-client.ts` from all four
   entry points — through `packages/core/src/market-data/index.ts`, the BARREL,
   which re-exports `tiingo-news`, `tiingo-corp-actions` and (via
   `us-instrument-sync`) the client itself. `apps/api/src/routes/v1/market.ts:30`
   imports that barrel.

   Module reachability is not a request. Evaluating `tiingo-client.ts` defines
   functions and constants; it issues nothing. A rule that descended past the
   barrel would be RED today for a bundling fact, which is how a guard gets
   deleted rather than fixed. (That the barrel is imported at all is its own
   defect — this repo's standing rule is subpath imports, never root barrels —
   but it belongs to that file, not to this test.)

   So the seam is the SPECIFIER. Descent stops at the package boundary and every
   `@usemoney/...` specifier crossing it is checked by NAME. That is exactly
   where the mutation above would have been caught, and it costs nothing: over
   the 19-module app-local closure there are 25 cross-package specifiers and
   ZERO of them is a vendor client.

   ## What this does NOT prove

   A route calling a re-exported vendor function OFF THE BARREL
   (`import { fetchTiingoEod } from "@usemoney/core/market-data"`) names no
   vendor module and is not caught here. Closing that needs the barrel to stop
   re-exporting the client, or the routes to stop importing the barrel — a
   source change, not a test. Written down rather than implied, because a
   limitation nobody states is a limitation everybody assumes away.
   ────────────────────────────────────────────────────────────────────────── */

/** Repo root, from packages/core. */
const REPO = join("..", "..");

/**
 * The live entry points that serve a US quote.
 *
 * Hardcoded, and each is asserted below to still reach `tiingo-rt-read` — so a
 * renamed or deleted route fails loudly here instead of quietly shrinking the
 * set this guard covers to nothing.
 */
const APP_ENTRY_POINTS = [
  join(REPO, "apps", "web", "app", "api", "market", "quote", "route.ts"),
  join(REPO, "apps", "web", "app", "api", "market", "stream", "route.ts"),
  join(REPO, "apps", "web", "lib", "market", "us-interest.ts"),
  join(REPO, "apps", "api", "src", "routes", "v1", "market.ts"),
];

/**
 * TYPE-only imports, dropped before the walk.
 *
 * Not tidiness — correctness twice over. A type import is erased at compile
 * time and cannot cause a request, and following one explodes the graph:
 * `market.ts:24` does `import type { AppContext } from "../../app"`, which
 * dragged in `app.ts`, `routes/v1/index.ts` and all 40 v1 route modules. That
 * would have made a vendor import in ANY unrelated route fail THIS test, with a
 * message pointing at the quote path.
 *
 * `[^;]*?` AND NOT `[\s\S]*?` — this is the file header's phantom-comment bug
 * wearing a different regex, and the first draft of this shipped with it.
 * `export type CachedQuotesResult = …` (quote-cache.ts:223) is an `export type`
 * with NO `from`, so a lazy any-character middle ran forward to the next
 * `from "…"` ANYWHERE in the file and deleted everything in between. Measured:
 * a vendor import appended to quote-cache.ts was swallowed whole and the suite
 * reported 10/10 green. Negating the statement terminator bounds the match to
 * one statement, and the regression case below pins it.
 */
const TYPE_ONLY_IMPORT =
  /^[^\S\n]*(?:import|export)\s+type\s[^;]*?from\s*["'][^"']+["'];?/gm;

/** Resolve a specifier that stays inside the SAME app, or null. */
function resolveAppLocal(fromFile: string, spec: string): string | null {
  const pick = (base: string): string | null => {
    for (const c of [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ]) {
      if (existsSync(c) && /\.tsx?$/.test(c)) return c;
    }
    return null;
  };
  if (spec.startsWith("."))
    return pick(normalize(join(dirname(fromFile), spec)));
  // `@/` is apps/web's tsconfig alias for its own root.
  if (spec.startsWith("@/") && fromFile.includes(join("apps", "web"))) {
    return pick(normalize(join(REPO, "apps", "web", spec.slice(2))));
  }
  return null;
}

interface AppWalk {
  /** Every module reached without leaving the app. */
  modules: Map<string, string>;
  /** Cross-package specifiers, as `file :: specifier`. */
  crossings: string[];
}

function walkApp(roots: readonly string[]): AppWalk {
  const modules = new Map<string, string>();
  const crossings: string[] = [];
  const queue = [...roots];
  let guard = 0;
  while (queue.length > 0) {
    if (++guard > 5_000) throw new Error("app import walk did not terminate");
    const file = queue.shift()!;
    if (modules.has(file)) continue;
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    modules.set(file, src);
    const scan = stripComments(src).replace(TYPE_ONLY_IMPORT, "");
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(scan)) !== null) {
      const spec = m[1]!;
      const next = resolveAppLocal(file, spec);
      if (next) {
        if (!modules.has(next)) queue.push(next);
      } else if (spec.startsWith("@usemoney/")) {
        crossings.push(`${file} :: ${spec}`);
      }
    }
  }
  return { modules, crossings };
}

const APP = walkApp(APP_ENTRY_POINTS);

describe("the US quote ROUTES cannot reach Tiingo (MONEY-1309)", () => {
  it("[meta] every entry point exists and reaches the US read module", () => {
    // Ceiling. Every assertion below is an ABSENCE, which an empty walk
    // satisfies — and this suite exists because a walk that silently covered
    // nothing was cited in CLAUDE.md as proof for two releases.
    for (const entry of APP_ENTRY_POINTS) {
      assert.ok(existsSync(entry), `entry point missing: ${entry}`);
      const { modules } = walkApp([entry]);
      const reachesRead = [...modules.values()].some((src) =>
        /tiingo\/tiingo-rt-read\b/.test(stripComments(src)),
      );
      assert.ok(
        reachesRead,
        `${entry} no longer reaches tiingo-rt-read. Either it stopped serving ` +
          `US quotes (drop it from APP_ENTRY_POINTS) or the walk stopped ` +
          `following its imports — in which case this suite is guarding an ` +
          `empty graph.`,
      );
    }
    assert.ok(
      APP.modules.size >= 15,
      `app walk reached only ${APP.modules.size} modules`,
    );
    assert.ok(
      APP.crossings.length >= 10,
      `only ${APP.crossings.length} cross-package specifiers seen — the ` +
        `boundary check has nothing to check`,
    );
    // Pin three modules the US path MUST go through, so a resolver regression
    // that stopped following relative or `@/` imports shows up here.
    const files = [...APP.modules.keys()].join("\n");
    assert.match(files, /lib\/market\/quote-cache\.ts/);
    assert.match(files, /lib\/market\/providers\/quote-providers\.ts/);
    assert.match(files, /app\/api\/market\/stream\/route\.ts/);
  });

  it("no route imports a Tiingo HTTP client, statically or dynamically", () => {
    // `IMPORT_RE` matches `import(` as well as `from`, which is load-bearing:
    // three of the four entry points reach the read module through a DYNAMIC
    // `await import(...)`, and so would a vendor client.
    const offenders = APP.crossings.filter((c) =>
      VENDOR_CLIENT.test(c.split(" :: ")[1]!),
    );
    assert.deepEqual(
      offenders,
      [],
      "a US quote route imports a billed Tiingo client:\n  " +
        offenders.join("\n  ") +
        "\nThese routes are polled every 5-10s per open tab and Tiingo is " +
        "paid, metered and internal-use-only. Only the nightly `us-eod-sync` " +
        "job and the always-on socket holder may contact the vendor.",
    );
  });

  it("no route names a Tiingo host", () => {
    for (const [file, rawSrc] of APP.modules) {
      const src = stripComments(rawSrc);
      for (const host of TIINGO_HOSTS) {
        assert.ok(
          !src.includes(host),
          `${file} names ${host}. A US quote is served from OUR OWN Redis ` +
            `keys and \`candles\` rows.`,
        );
      }
    }
  });

  it("the boundary check actually fires — a synthetic vendor import is caught", () => {
    // The positive control. Without it this suite passes whenever
    // `VENDOR_CLIENT` stops matching or `crossings` stops being collected,
    // which is precisely how the core-only walk read as covering the routes.
    const synthetic = [
      'import { fetchTiingoEod } from "@usemoney/core/market-data/tiingo/tiingo-client";',
      'const rt = await import("@usemoney/core/market-data/tiingo/tiingo-rt-read");',
      "export async function probe(s: string) { return fetchTiingoEod(s); }",
    ].join("\n");
    const seen: string[] = [];
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(synthetic)) !== null) seen.push(m[1]!);
    assert.deepEqual(
      seen.filter((s) => VENDOR_CLIENT.test(s)),
      ["@usemoney/core/market-data/tiingo/tiingo-client"],
    );
    // ...and the read module beside it is NOT an offender, which is the other
    // half: a rule that flagged `tiingo-rt-read` would flag the fix.
    assert.equal(
      seen.filter((s) => VENDOR_CLIENT.test(s)).length,
      1,
      "tiingo-rt-read must not match VENDOR_CLIENT — it is the seam, not the vendor",
    );
  });

  it("the type-import strip cannot swallow a following import", () => {
    // The bug this file's own header warns about (MONEY-1143), rebuilt in a
    // different regex and caught by mutation rather than by reading. An
    // `export type X = …` carries no `from`, so a lazy any-character middle
    // ran to the NEXT `from "…"` and ate the statements between — including a
    // vendor import — while every assertion here is an ABSENCE and read green.
    const src = [
      'import type { QuoteExchange } from "@/lib/market/quote-exchange";',
      "export type CachedQuotesResult = QuoteCacheResult<QuoteData> & {",
      "  partial: boolean;",
      "};",
      'import { fetchTiingoEod } from "@usemoney/core/market-data/tiingo/tiingo-client";',
    ].join("\n");
    const scanned = src.replace(TYPE_ONLY_IMPORT, "");
    assert.ok(
      scanned.includes("tiingo-client"),
      "the type-import strip swallowed a real import — every check downstream " +
        "of it is now vacuous on this file",
    );
    // ...and it still removes the thing it is for.
    assert.ok(
      !scanned.includes("quote-exchange"),
      "the type-only import survived the strip — the walk will follow it",
    );
  });

  it("a type-only import is not followed", () => {
    // The over-trigger side, and the reason the closure is 19 modules and not
    // 70: `import type { AppContext } from "../../app"` is erased at compile
    // time. Following it made every v1 route part of the US quote path.
    const src = readFileSync(
      join(REPO, "apps", "api", "src", "routes", "v1", "market.ts"),
      "utf8",
    );
    assert.match(src, /import type \{ AppContext \} from "\.\.\/\.\.\/app"/);
    assert.ok(
      ![...APP.modules.keys()].some((f) =>
        f.endsWith(join("api", "src", "app.ts")),
      ),
      "the walk followed a type-only import — the graph is now the whole API app",
    );
  });
});
