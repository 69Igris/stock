/**
 * Every Tiingo request must be charged to the SHARED budget — MONEY-1309.
 *
 * ## The defect this exists to make impossible
 *
 * `withTiingoBudget` (market-data/tiingo/tiingo-budget.ts) is the account-wide
 * ceiling: one Redis-shared hour/day request counter and one monthly byte meter,
 * so that N processes on one metered Tiingo account cannot each spend a full
 * allowance. It shipped WIRED AT ONE OF FIVE CALL SITES.
 *
 * Measured on the branch that added it: `paceTiingoRequest()` — the one call
 * every Tiingo request already made — appeared at five places in
 * `packages/core/src`, and exactly one of them (`tiingo-client.ts`, covering the
 * `eod` and `master` legs) went through the budget wrapper. The other four
 * (`news`, `corp-actions`, `search`, `metadata`) spent the same account and were
 * invisible to the counter. So the shared meter reported roughly A FIFTH of real
 * spend.
 *
 * That is worse than having no guard at all, and the asymmetry is the whole
 * point of this file: a missing guard fails loudly at Tiingo's edge with a 429,
 * which `decideTiingoFailure` classifies and every caller circuit-breaks on. An
 * under-reporting guard produces CONFIDENT HEADROOM THAT DOES NOT EXIST — the
 * ops read says 20% spent, the ceiling never fires, and the first evidence of
 * trouble is the 429 the guard was installed to prevent. It is the same shape as
 * MONEY-1255's per-source counters, which were incremented before the call they
 * counted, so a source that 403'd on every request still produced a full-looking
 * number and hid Tickertape's block for five months.
 *
 * `TiingoBudgetLeg` already declared all six leg names when only two were wired,
 * which is exactly how partial wiring survives review: the design looked
 * complete because the TYPE was complete.
 *
 * ## Why a SOURCE-TEXT scan and not a runtime check
 *
 * There is no single import, base class or client object that every Tiingo
 * caller shares, so there is nothing to instrument. The five call sites reach
 * the network through `getFeedAsset` — which is the ARCHIVE seam, shared with
 * NSE, BSE, Kite, RBI and SEC, and has no business knowing about a Tiingo quota
 * — and each builds its own headers, its own retry ladder placement and its own
 * archive descriptor. A runtime assertion inside `paceTiingoRequest` could see
 * that it was called but not whether a budget frame encloses it (no async
 * context is threaded through the seam), and one inside `getFeedAsset` would
 * fire for every non-Tiingo feed in the repo.
 *
 * What IS uniform is lexical: a Tiingo request is a `paceTiingoRequest()` call,
 * and a budgeted one sits inside a `withTiingoBudget(...)` argument list. So the
 * check is lexical too. It is the same instrument, and the same argument, as
 * `no-feed-fetch-bypass.test.ts` (MONEY-1085/1157): a scan that fails the suite
 * instead of a comment asking people to remember.
 *
 * ## The scan is checked against passing vacuously
 *
 * This repo has shipped source-text guards that silently matched nothing —
 * `no-feed-fetch-bypass` grepped only for the tidy bypass and stayed green while
 * a live raw `fetch()` to Kite sat uncovered for months. A scan of this kind has
 * TWO vacuous failure modes and both are pinned below:
 *
 *   1. finding nothing (a rename, a moved directory, a rotted matcher) — the
 *      premise test asserts a floor of five sites AND that each of the five
 *      known files still contributes one;
 *   2. finding sites but never being able to say "unbudgeted" — the fixture
 *      test feeds the scanner hand-written wrapped, unwrapped and decoy sources
 *      and asserts it separates them.
 *
 * Only `src` is walked, never `__tests__`, so the fixtures below cannot count
 * themselves.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

/** packages/core, resolved from THIS FILE rather than from the CWD. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCAN_ROOT = join(PKG_ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__"]);
const SOURCE_EXT = /\.ts$/;

/** The call that marks one Tiingo request. */
const PACE_FN = "paceTiingoRequest";
/** The wrapper that charges it to the shared account-wide counter. */
const BUDGET_FN = "withTiingoBudget";

/**
 * The files that legitimately hold a pace call, and how many each holds today.
 *
 * A verified ceiling, not decoration. A scan that reports "0 offenders" is
 * indistinguishable from a scan that found nothing to inspect, and the
 * difference is the entire value of the test — so the population is pinned by
 * name. A file that moves fails HERE, with a message saying to retarget the
 * scan, rather than quietly shrinking the coverage to nothing.
 *
 * `>=` on the per-file count, because ADDING a budgeted call site is the
 * expected way to grow this list; the guard below is what makes that safe.
 */
const KNOWN_PACE_SITES: Readonly<Record<string, readonly string[]>> = {
  // The client is the one seam that takes its leg as a PARAMETER — the two
  // concrete values ("eod", "master") are pinned where they are passed in, by
  // "both public fetchers pass a leg through the seam" below.
  "src/market-data/tiingo/tiingo-client.ts": ["leg"],
  "src/market-data/tiingo/tiingo-news.ts": ["news"],
  "src/market-data/tiingo/tiingo-corp-actions.ts": ["corp-actions"],
  "src/market-data/instruments/tiingo-search.ts": ["search"],
  "src/market-data/instruments/us-instrument-names.ts": ["metadata"],
};

const KNOWN_PACE_FILES: readonly string[] = Object.keys(KNOWN_PACE_SITES);

/** The floor the premise asserts. One per file above. */
const EXPECTED_MIN_SITES = 5;

/** Where the two functions the scan is built on are defined. */
const PACER_FILE = join(SCAN_ROOT, "market-data", "tiingo", "tiingo-pacer.ts");
const BUDGET_FILE = join(
  SCAN_ROOT,
  "market-data",
  "tiingo",
  "tiingo-budget.ts",
);

interface PaceSite {
  /** Package-relative, forward-slashed, so failures are copy-pasteable. */
  readonly file: string;
  readonly line: number;
  /** True when the call sits inside a `withTiingoBudget(` argument list. */
  readonly budgeted: boolean;
  /**
   * The FIRST argument of the innermost enclosing `withTiingoBudget(` — the
   * leg this request is charged to — or null when unbudgeted.
   *
   * A string literal is reported without its quotes; an identifier (the
   * client's `leg` parameter) is reported verbatim. Recorded because
   * `budgeted: boolean` alone could not tell the difference between charging
   * the news leg and charging news requests to the EOD leg: rewriting
   * `withTiingoBudget("news"` to `withTiingoBudget("eod"` left this scan 8/8
   * GREEN. The circuit break is PER LEG, so a mislabelled site parks the wrong
   * leg after a 429 and leaves the guilty one running.
   */
  readonly leg: string | null;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

/**
 * Find every `paceTiingoRequest(` CALL and decide whether a `withTiingoBudget(`
 * argument list encloses it.
 *
 * A hand-rolled walk rather than a regex, because "lexically inside" is a
 * nesting question and a regex cannot answer one. It tracks a stack of open
 * parens, marking the frame opened by `withTiingoBudget`; a call is budgeted iff
 * any such frame is still open at its offset. Comments and string/template
 * literals are skipped WHOLESALE, which both stops prose from matching (this
 * repo's own comments quote `paceTiingoRequest()` half a dozen times) and keeps
 * paren balance, since an ignored literal contributes neither its opens nor its
 * closes.
 *
 * Two deliberate simplifications, stated rather than discovered later:
 * REGEX LITERALS are not recognised (a `/(/` would unbalance the stack) and a
 * BACKTICK NESTED INSIDE a `${}` expression would end its template early.
 * Neither exists in the five files this must be exact about, and both are
 * caught rather than hidden: a mis-parse there changes the site COUNT, which
 * the premise test pins per file.
 */
/**
 * The LOCAL name `paceTiingoRequest` is bound to in this file.
 *
 * An alias defeated the scan outright: `import { paceTiingoRequest as ping }`
 * and then `await ping()` matched nothing, so the file reported ZERO pace sites
 * and passed the "every call is budgeted" guard vacuously. The premise test's
 * per-file floor would have caught a whole file going dark, but not a second,
 * aliased call added beside a legitimate one.
 *
 * Resolved rather than BANNED, because a ban is another rule to remember and
 * this cannot be defeated by obeying it.
 */
function paceLocalName(src: string): string {
  const imports = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*tiingo-pacer["']/g;
  let m: RegExpExecArray | null;
  while ((m = imports.exec(src)) !== null) {
    for (const spec of (m[1] ?? "").split(",")) {
      const alias =
        /^\s*paceTiingoRequest\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(
          spec,
        );
      if (alias?.[1]) return alias[1];
    }
  }
  return PACE_FN;
}

/** Read the first argument token after a `withTiingoBudget(` — the leg. */
function legAt(src: string, openParen: number): string | null {
  let k = openParen + 1;
  while (k < src.length && /\s/.test(src[k] as string)) k++;
  const q = src[k];
  if (q === '"' || q === "'") {
    const end = src.indexOf(q, k + 1);
    return end === -1 ? null : src.slice(k + 1, end);
  }
  if (q !== undefined && IDENT_START.test(q)) {
    let j = k;
    while (j < src.length && IDENT_PART.test(src[j] as string)) j++;
    return src.slice(k, j);
  }
  return null;
}

function scanPaceSites(
  displayPath: string,
  src: string,
  /** Defaults to the binding this file actually uses — see `paceLocalName`. */
  paceName: string = paceLocalName(src),
): PaceSite[] {
  const sites: PaceSite[] = [];
  /** One entry per open `(`; the leg when `withTiingoBudget` opened it. */
  const parens: (string | null)[] = [];
  let i = 0;
  let line = 1;
  /** The last identifier read, so `function paceTiingoRequest(` is not a call. */
  let prevIdent = "";
  const n = src.length;

  while (i < n) {
    const c = src[i] as string;

    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n) {
        const d = src[i];
        if (d === "\\") {
          if (src[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (d === "\n") {
          line++;
          i++;
          continue;
        }
        i++;
        if (d === c) break;
      }
      prevIdent = "";
      continue;
    }
    if (c === "(") {
      parens.push(prevIdent === BUDGET_FN ? (legAt(src, i) ?? "?") : null);
      prevIdent = "";
      i++;
      continue;
    }
    if (c === ")") {
      parens.pop();
      prevIdent = "";
      i++;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < n && IDENT_PART.test(src[j] as string)) j++;
      const ident = src.slice(i, j);
      // Look past whitespace for the opening paren that makes it a call.
      let k = j;
      while (k < n && /\s/.test(src[k] as string)) k++;
      if (ident === paceName && src[k] === "(" && prevIdent !== "function") {
        // The INNERMOST open budget frame owns the charge.
        const open = parens.filter((p) => p !== null);
        sites.push({
          file: displayPath,
          line,
          budgeted: open.length > 0,
          leg: open.length > 0 ? (open[open.length - 1] as string) : null,
        });
      }
      i = j;
      prevIdent = ident;
      continue;
    }
    // Whitespace must NOT clear `prevIdent` — `withTiingoBudget (fn)` is still
    // a call, and `function\n  paceTiingoRequest(` is still a declaration.
    if (!/\s/.test(c)) prevIdent = "";
    i++;
  }

  return sites;
}

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(entry)) yield full;
  }
}

function displayPath(absolute: string): string {
  return relative(PKG_ROOT, absolute).split(sep).join("/");
}

function allPaceSites(): PaceSite[] {
  const sites: PaceSite[] = [];
  for (const file of walk(SCAN_ROOT)) {
    sites.push(...scanPaceSites(displayPath(file), readFileSync(file, "utf8")));
  }
  return sites;
}

describe("the scanner separates budgeted calls from unbudgeted ones", () => {
  // The anti-vacuous half. A scan that can only ever answer "budgeted" would
  // pass the guard below on a completely unwired repo.
  it("reports an unwrapped call as UNBUDGETED", () => {
    const sites = scanPaceSites(
      "fixture.ts",
      [
        "async function fetchThing() {",
        `  await ${PACE_FN}();`,
        "  return getFeedAsset(url);",
        "}",
      ].join("\n"),
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.budgeted, false);
    assert.equal(sites[0]?.line, 2, "line numbers must survive the walk");
  });

  it("reports a wrapped call as BUDGETED, braces and template literals and all", () => {
    const sites = scanPaceSites(
      "fixture.ts",
      [
        "async function fetchThing() {",
        `  return ${BUDGET_FN}("news", async () => {`,
        `    await ${PACE_FN}();`,
        "    return getFeedAsset(url, { basename: `x-${sym.toUpperCase()}.json` });",
        "  });",
        "}",
      ].join("\n"),
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.budgeted, true);
  });

  it("closes the frame at the wrapper's closing paren", () => {
    // A call AFTER the wrapper returns is not covered by it. Without this the
    // scan would call a whole file budgeted on the strength of one wrapper.
    const sites = scanPaceSites(
      "fixture.ts",
      [
        `await ${BUDGET_FN}("news", async () => getFeedAsset(url));`,
        `await ${PACE_FN}();`,
      ].join("\n"),
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.budgeted, false);
  });

  it("ignores comments, strings and the pacer's own declaration", () => {
    const sites = scanPaceSites(
      "fixture.ts",
      [
        `// await ${PACE_FN}(); — prose, not a call`,
        `/* ${PACE_FN}() in a block comment */`,
        `const label = "${PACE_FN}(";`,
        `export async function ${PACE_FN}(): Promise<void> {}`,
      ].join("\n"),
    );
    assert.deepEqual(sites, []);
  });
});

describe("the Tiingo budget scan is live (premise)", () => {
  it("finds at least one pace call in every file known to hold one", () => {
    const sites = allPaceSites();
    const byFile = new Map<string, number>();
    for (const s of sites) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);

    const missing = KNOWN_PACE_FILES.filter((f) => (byFile.get(f) ?? 0) === 0);
    assert.deepEqual(
      missing,
      [],
      "these files are supposed to contain a paceTiingoRequest() call and the " +
        "scan found none — either they moved (retarget KNOWN_PACE_FILES and " +
        "this scan) or the matcher rotted. A guard that matches nothing " +
        "reports zero offenders and is cited as proof:\n" +
        missing.join("\n"),
    );
  });

  it(`finds at least ${EXPECTED_MIN_SITES} pace call sites in total`, () => {
    const sites = allPaceSites();
    assert.ok(
      sites.length >= EXPECTED_MIN_SITES,
      `expected >= ${EXPECTED_MIN_SITES} ${PACE_FN}() call sites under ` +
        `packages/core/src, found ${sites.length}. This is the premise: the ` +
        `guard below passes trivially if the scan finds nothing.\n` +
        sites.map((s) => `${s.file}:${s.line}`).join("\n"),
    );
  });

  it("the two functions the scan is built on still exist under those names", () => {
    assert.match(
      readFileSync(PACER_FILE, "utf8"),
      new RegExp(`export async function ${PACE_FN}\\b`),
      `${PACE_FN} is no longer exported from tiingo-pacer.ts — retarget this ` +
        "scan rather than letting it match nothing",
    );
    assert.match(
      readFileSync(BUDGET_FILE, "utf8"),
      new RegExp(`export async function ${BUDGET_FN}\\b`),
      `${BUDGET_FN} is no longer exported from tiingo-budget.ts — retarget ` +
        "this scan rather than letting every call site read as unbudgeted",
    );
  });
});

describe("every Tiingo request is charged to the shared budget (MONEY-1309)", () => {
  it(`every ${PACE_FN}() call sits inside a ${BUDGET_FN}() callback`, () => {
    const unbudgeted = allPaceSites()
      .filter((s) => !s.budgeted)
      .map((s) => `${s.file}:${s.line}`);

    assert.deepEqual(
      unbudgeted,
      [],
      `these Tiingo requests are paced but NOT budgeted, so they spend the ` +
        `metered account without the shared counter seeing it — which makes ` +
        `the counter under-report and hand ops headroom that does not exist ` +
        `(it reported ~1/5 of real spend while four of five sites were ` +
        `unwired). Wrap the request: withTiingoBudget(<leg>, async () => { ` +
        `await paceTiingoRequest(); return getFeedAsset(...); }) — budget ` +
        `check OUTER, pacer INNER, so a refusal costs no sleep and the ` +
        `pacer's TiingoDailyCapError is re-thrown untouched instead of being ` +
        `mistaken for a 429. Add the leg to TiingoBudgetLeg if it is new:\n` +
        unbudgeted.join("\n"),
    );
  });
});

describe("the scan reads the LEG, not just the presence of a wrapper", () => {
  it("records the leg string each call is charged to", () => {
    const sites = scanPaceSites(
      "fixture.ts",
      [
        `await ${BUDGET_FN}("news", async () => {`,
        `  await ${PACE_FN}();`,
        "});",
      ].join("\n"),
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.leg, "news");
  });

  it("records an IDENTIFIER leg verbatim", () => {
    // `tiingo-client.ts` takes its leg as a parameter, so the scan must not
    // require a literal — it would report that one legitimate site as broken.
    const sites = scanPaceSites(
      "fixture.ts",
      [
        `return await ${BUDGET_FN}(leg, async () => {`,
        `  await ${PACE_FN}();`,
        "});",
      ].join("\n"),
    );
    assert.equal(sites[0]?.leg, "leg");
  });

  it("attributes a nested call to the INNERMOST wrapper", () => {
    const sites = scanPaceSites(
      "fixture.ts",
      [
        `await ${BUDGET_FN}("eod", async () => {`,
        `  return ${BUDGET_FN}("news", async () => {`,
        `    await ${PACE_FN}();`,
        "  });",
        "});",
      ].join("\n"),
    );
    assert.equal(sites[0]?.leg, "news");
  });

  it("reports a null leg for an unbudgeted call", () => {
    const sites = scanPaceSites("fixture.ts", `await ${PACE_FN}();`);
    assert.equal(sites[0]?.budgeted, false);
    assert.equal(sites[0]?.leg, null);
  });

  it("follows an ALIASED import instead of going blind", () => {
    // `import { paceTiingoRequest as ping }` used to defeat the scan outright:
    // the file reported ZERO pace sites and passed the guard vacuously, which
    // is the same "matches nothing, reports no offenders, gets cited as proof"
    // failure `no-feed-fetch-bypass` shipped with.
    const aliased = [
      'import { paceTiingoRequest as ping } from "../tiingo/tiingo-pacer";',
      "async function fetchThing() {",
      "  await ping();",
      "}",
    ].join("\n");
    const sites = scanPaceSites("fixture.ts", aliased);
    assert.equal(sites.length, 1, "the aliased call must still be found");
    assert.equal(sites[0]?.budgeted, false);
    assert.equal(sites[0]?.line, 3);

    // And an aliased call that IS wrapped reads as budgeted, with its leg.
    const wrapped = [
      'import { paceTiingoRequest as ping } from "../tiingo/tiingo-pacer";',
      `await ${BUDGET_FN}("search", async () => {`,
      "  await ping();",
      "});",
    ].join("\n");
    const okSites = scanPaceSites("fixture.ts", wrapped);
    assert.equal(okSites.length, 1);
    assert.equal(okSites[0]?.budgeted, true);
    assert.equal(okSites[0]?.leg, "search");
  });

  it("does not mistake an unrelated alias for the pacer", () => {
    // The anti-vacuous half: if `paceLocalName` returned the LAST identifier it
    // saw rather than the one bound to `paceTiingoRequest`, this fixture would
    // report a phantom site.
    const src = [
      'import { paceTiingoRequest, somethingElse as ping } from "../tiingo/tiingo-pacer";',
      "await ping();",
      `await ${PACE_FN}();`,
    ].join("\n");
    const sites = scanPaceSites("fixture.ts", src);
    assert.equal(sites.length, 1, "only the real pacer call counts");
    assert.equal(sites[0]?.line, 3);
  });
});

describe("each Tiingo request is charged to the RIGHT leg (MONEY-1309)", () => {
  it("every known call site passes the leg its file is supposed to spend", () => {
    // `budgeted: boolean` was not enough. Rewriting `tiingo-news.ts`'s
    // `withTiingoBudget("news"` to `withTiingoBudget("eod"` left this suite
    // 8/8 GREEN — every request still went through a wrapper, so the wiring
    // guard was satisfied while news spend was being booked against EOD.
    //
    // That is not cosmetic. The circuit break is PER LEG: a 429 caused by the
    // news leg would park `eod` — stopping the nightly price sync, which has
    // ONE window a day — and leave the leg that actually hit the wall running
    // straight back into it. `TiingoBudgetLeg` is a closed union precisely so
    // "a typo'd leg name would arm a break nobody ever checks", and a
    // COPY-PASTED but valid leg name defeats that by being spelled correctly.
    const byFile = new Map<string, string[]>();
    for (const s of allPaceSites()) {
      const legs = byFile.get(s.file) ?? [];
      legs.push(s.leg ?? "<unbudgeted>");
      byFile.set(s.file, legs);
    }

    const wrong: string[] = [];
    for (const [file, expected] of Object.entries(KNOWN_PACE_SITES)) {
      const actual = [...new Set(byFile.get(file) ?? [])].sort();
      const want = [...new Set(expected)].sort();
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        wrong.push(`${file}: expected [${want}], found [${actual}]`);
      }
    }

    assert.deepEqual(
      wrong,
      [],
      "these files charge their Tiingo requests to a leg other than their own. " +
        "The shared COUNTER is account-wide so the totals still add up, but the " +
        "CIRCUIT BREAK is per leg — a 429 would park the wrong leg and leave " +
        "the guilty one running. If a leg was renamed deliberately, update " +
        "KNOWN_PACE_SITES in the same change:\n" +
        wrong.join("\n"),
    );
  });
});

describe("the LADDER-LESS legs do not book a 429 as a transport failure", () => {
  // `tiingo-search.ts` and `us-instrument-names.ts` have no retry ladder, so
  // NOTHING in them ever constructs a `TiingoRateLimitError`. Their `catch`
  // arms tested `error instanceof TiingoRateLimitError` and otherwise returned
  // null/undefined — which the callers book as a `transportFailure` and then
  // STAMP the row for. So a real 429 (a plain Error from the feed seam, see
  // `isTiingoRateLimitFailure`) was recorded as "we asked and there was nothing
  // there", the rotation advanced, and the row went to the back of an 8-night
  // cycle having never been answered.
  //
  // The DECISION is unit-tested behaviourally in tiingo-budget.test.ts
  // ("the shared status rule is the SAME function the ladder decides on").
  // What is asserted here is that it is REACHED — the same split, and the same
  // instrument, as the `withTiingoBudget` wiring scan above: a unit test can
  // prove a predicate works and cannot prove anything calls it.
  const LADDERLESS: readonly [string, string][] = [
    ["src/market-data/instruments/tiingo-search.ts", "search"],
    ["src/market-data/instruments/us-instrument-names.ts", "metadata"],
  ];

  for (const [file, leg] of LADDERLESS) {
    it(`${leg}: a 429 is re-thrown TYPED instead of swallowed`, () => {
      const src = readFileSync(join(PKG_ROOT, file), "utf8");

      assert.match(
        src,
        /if \(isTiingoRateLimitFailure\(error\)\) \{\s*throw new TiingoRateLimitError\(/,
        `${file} must convert a plain-Error 429 into the TYPED error its ` +
          "caller circuit-breaks on. Without it the row is stamped and the " +
          "rotation moves on, recording a rate limit as an upstream blip.",
      );
      // The premise: the weaker `instanceof` arm is still there and still
      // FIRST, so a typed stop (the pacer's daily cap, the budget refusal) is
      // re-thrown untouched rather than being re-wrapped.
      assert.match(
        src,
        /if \(error instanceof TiingoRateLimitError\) throw error;/,
        `${file} must still re-throw an already-typed stop unchanged`,
      );
      assert.ok(
        src.indexOf("error instanceof TiingoRateLimitError") <
          src.indexOf("isTiingoRateLimitFailure(error)"),
        "the typed re-throw must come first, or a daily cap gets re-wrapped",
      );
    });
  }
});
