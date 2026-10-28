/**
 * The QA sample-universe generator's PURE DECISIONS — MONEY-980.
 *
 * `scripts/ops/build-qa-sample-universe.ts` produces a CHECKED-IN manifest that
 * bounds `sync-prod-to-qa.sh --tier=sample`. Every defect it can have is quiet:
 * a short list, a reshuffled list, a list of the wrong shape, or a list of real
 * symbols that match nothing. None of those throw at the consumer — the sync
 * runs, reports success, and leaves QA hollow.
 *
 * ## Why the decisions are LIFTED out of the real file
 *
 * Same mechanism, and the same reasoning, as `tiingo-script-decisions.test.ts`:
 * the generator has a top-level `main()` and a `@usemoney/database` import, so
 * importing it into `node:test` would RUN it — against whatever `DATABASE_URL`
 * the ambient `.env` happens to name. The decisions are pure and
 * marker-delimited, so the region is read out of the shipping file, written to
 * a temp ESM module and imported. Mutate the region in the script and these
 * tests fail, which is exactly what a source-text assertion cannot promise.
 *
 * ## What is deliberately NOT tested here
 *
 * The network fetches and the Prisma reads. Those are the impure edges and they
 * are covered by running the generator, which is a human-invoked dry run that
 * prints its counts. What IS tested is every rule that decides what lands in
 * the file.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import {
  buildListingId,
  deriveListingStatus,
} from "../../src/market-data/tiingo/tiingo-logic";

/**
 * Repo root resolved from THIS FILE, never from cwd.
 *
 * A cwd-relative path makes the suite throw inside the module body, which node
 * reports as a dropped file with `fail 0` and exit 0 — the guard vanishes
 * instead of failing.
 */
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
assert.ok(
  existsSync(join(ROOT, "yarn.lock")),
  `resolved repo root ${ROOT} has no yarn.lock`,
);

const SCRIPT = join(ROOT, "scripts", "ops", "build-qa-sample-universe.ts");
const CONSUMER = join(ROOT, "scripts", "ops", "qa-sample-plan.ts");
const MANIFEST = join(ROOT, "scripts", "ops", "qa-sample-universe.json");

const RAW = readFileSync(SCRIPT, "utf8");

/**
 * The pure, import-free region between a marker pair.
 *
 * The `:begin` marker lives INSIDE a block comment (so the region's own doc
 * comment travels with the file rather than with the extract), and the region
 * is everything from that comment's close to the `:end` marker.
 */
function markedRegion(src: string, marker: string, file: string): string {
  const begin = src.indexOf(`${marker}:begin`);
  const end = src.indexOf(`/* ${marker}:end */`);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error(
      `${file} is missing the ${marker} markers — the pure decision region ` +
        "must stay marked so this suite can EXECUTE it rather than assert " +
        "about its text",
    );
  }
  const afterComment = src.indexOf("*/", begin);
  if (afterComment < 0 || afterComment > end) {
    throw new Error(`${marker}:begin in ${file} is not inside a block comment`);
  }
  return src.slice(afterComment + 2, end);
}

const REGION = markedRegion(
  RAW,
  "qa-universe-pure",
  "build-qa-sample-universe.ts",
);

const tempDir = mkdtempSync(join(tmpdir(), "qa-universe-extract-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

let moduleSeq = 0;
async function loadModule(source: string): Promise<Record<string, unknown>> {
  const path = join(tempDir, `extracted-${moduleSeq++}.mts`);
  writeFileSync(path, `${source}\n`, "utf8");
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

const mod = await loadModule(REGION);

type CliArgs = {
  has(f: string): boolean;
  value(f: string): string | undefined;
};
const parseUniverseCliArgs = mod.parseUniverseCliArgs as (
  argv: readonly string[],
  spec: { bare: readonly string[]; valued: readonly string[] },
) => CliArgs;
const parseSp500Wikitext = mod.parseSp500Wikitext as (
  src: string,
) => Array<{ symbol: string; name: string; sector: string; exchange: string }>;
const cleanWikiCell = mod.cleanWikiCell as (c: string) => string;
const toTiingoTicker = mod.toTiingoTicker as (s: string) => string;
const dedupeByIsin = mod.dedupeByIsin as (
  rows: readonly Record<string, unknown>[],
  prefer?: string,
) => Record<string, unknown>[];
const topByMetric = mod.topByMetric as (
  rows: readonly Record<string, unknown>[],
  metric: "marketCap" | "volume",
  n: number,
) => Record<string, unknown>[];
const stableBySymbol = mod.stableBySymbol as <T>(e: readonly T[]) => T[];
const resolveDelisted = mod.resolveDelisted as (
  specs: readonly Record<string, unknown>[],
  master: readonly Record<string, unknown>[],
  make: (s: string, e: string, d: string | null) => string,
) => Array<Record<string, unknown>>;
const assertPlausible = mod.assertPlausible as (
  n: string,
  a: number,
  f: number,
) => void;
const intersectPreservingOrder = mod.intersectPreservingOrder as (
  ranked: readonly string[],
  available: ReadonlySet<string>,
) => string[];
const isinsOf = mod.isinsOf as (
  rows: readonly { isin: string | null }[],
) => string[];
const selectUsFunds = mod.selectUsFunds as (
  population: readonly {
    ticker: string;
    startDate: string | null;
    endDate: string | null;
  }[],
  curated: readonly string[],
  target: number,
) => { symbols: string[]; missingCurated: string[] };

const row = (o: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  symbol: "X",
  exchange: "NSE",
  isin: "INE000A01001",
  name: "X Ltd",
  instrumentType: "EQUITY",
  isActive: true,
  marketCap: 1,
  volume: 1,
  ...o,
});

// ── the lift itself ──────────────────────────────────────────────────────

describe("the lifted region is self-contained", () => {
  it("is import-free, clock-free and env-free, so the extract really runs", () => {
    assert.ok(REGION.length > 2000, `region is only ${REGION.length} chars`);
    assert.doesNotMatch(REGION, /^\s*import\s/m, "region imports something");
    assert.doesNotMatch(REGION, /\brequire\(/, "region uses require()");
    assert.doesNotMatch(REGION, /Date\.now\(\)/, "region reads the clock");
    assert.doesNotMatch(REGION, /process\.env/, "region reads the env");
  });

  it("exports every decision this suite exercises", () => {
    for (const name of [
      "parseUniverseCliArgs",
      "parseSp500Wikitext",
      "toTiingoTicker",
      "dedupeByIsin",
      "topByMetric",
      "stableBySymbol",
      "resolveDelisted",
      "assertPlausible",
      "intersectPreservingOrder",
      "isinsOf",
      "selectUsFunds",
    ]) {
      assert.equal(typeof mod[name], "function", `${name} is not exported`);
    }
  });
});

// ── argv ─────────────────────────────────────────────────────────────────

describe("argv parsing refuses rather than defaulting", () => {
  const SPEC = { bare: ["apply"], valued: ["env"] } as const;
  const parse = (...argv: string[]) => parseUniverseCliArgs(argv, SPEC);

  it("dry run is the default — a bare --apply is the only way to write", () => {
    assert.equal(parse().has("apply"), false);
    assert.equal(parse("--apply").has("apply"), true);
  });

  it("REJECTS --apply=true rather than ignoring it (MONEY-1252)", () => {
    // The whole failure: a wrapper emitted `--flag=value`, `--apply` was
    // neither detected nor rejected, and a 54-minute run exited 0 having
    // written nothing.
    assert.throws(() => parse("--apply=true"), /bare flag and takes no value/);
  });

  it("REJECTS the space form, which used to silently widen a run", () => {
    // `--limit 500` once parsed as NO limit at all — i.e. every row. The
    // rejection arrives on the flag itself, before the orphaned value is even
    // considered.
    assert.throws(
      () => parse("--env", "prod"),
      /--env requires a value and the SPACE form is not accepted/,
    );
  });

  it("REJECTS a bare positional, so an orphaned value can never be ignored", () => {
    assert.throws(() => parse("--apply", "prod"), /Unexpected argument "prod"/);
  });

  it("rejects an unknown flag instead of ignoring it", () => {
    assert.throws(() => parse("--dry-run"), /Unknown flag "--dry-run"/);
  });

  it("rejects a repeated flag rather than guessing which wins", () => {
    assert.throws(() => parse("--env=qa", "--env=prod"), /more than once/);
    assert.throws(() => parse("--apply", "--apply"), /more than once/);
  });

  it("rejects an empty value and a valued flag with no value", () => {
    assert.throws(() => parse("--env="), /empty value/);
    assert.throws(() => parse("--env"), /requires a value/);
  });

  it("accepts the one supported spelling", () => {
    const a = parse("--apply", "--env=prod");
    assert.equal(a.has("apply"), true);
    assert.equal(a.value("env"), "prod");
  });
});

// ── S&P 500 wikitext ─────────────────────────────────────────────────────

const WIKI = `
== S&P 500 component stocks ==
{| class="wikitable sortable" id="constituents"
|-
!Symbol
! Security !! GICS Sector
|-
|| {{NyseSymbol|MMM}}
|| [[3M]]
|| Industrials
|| Industrial Conglomerates
|-
|| {{NasdaqSymbol|AAPL}}
|| [[Apple Inc.|Apple]]
|| Information Technology
|| Technology Hardware
|}

== Selected changes to the list ==
{| class="wikitable" id="changes"
|-
|| {{NyseSymbol|GONE}}
|| [[Removed Corp]]
|}
`;

describe("S&P 500 wikitext parsing", () => {
  it("reads symbol, display name, sector and the LISTING VENUE", () => {
    const rows = parseSp500Wikitext(WIKI);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      symbol: "MMM",
      name: "3M",
      sector: "Industrials",
      exchange: "NYSE",
    });
    assert.deepEqual(rows[1], {
      symbol: "AAPL",
      name: "Apple",
      sector: "Information Technology",
      exchange: "NASDAQ",
    });
  });

  it("STOPS at the constituents table — the changes table must not bleed in", () => {
    // This is the difference between 502 constituents and 502 plus every
    // company ever removed from the index.
    const rows = parseSp500Wikitext(WIKI);
    assert.ok(
      !rows.some((r) => r.symbol === "GONE"),
      "a row from the changes table leaked into the constituents list",
    );
  });

  it("throws when the anchor disappears instead of returning a short list", () => {
    assert.throws(
      () => parseSp500Wikitext("no table here"),
      /no longer contains id="constituents"/,
    );
  });

  it("normalises share-class dots to Tiingo's dashes", () => {
    // Wikipedia writes BRK.B; candles.symbol and us_instruments.symbol store
    // BRK-B ("dashes not periods" in both schema comments). Measured against
    // the live master: BRK.B and BF.B have ZERO rows, BRK-B and BF-B have one
    // each. Unnormalised, those two would match nothing while the other 500
    // matched fine — two companies silently missing, no error anywhere.
    assert.equal(toTiingoTicker("BRK.B"), "BRK-B");
    assert.equal(toTiingoTicker("BF.B"), "BF-B");
    assert.equal(toTiingoTicker("SPG.P.J"), "SPG-P-J");
    assert.equal(toTiingoTicker("AAPL"), "AAPL", "a plain ticker is untouched");
  });

  it("emits the normalised symbol and keeps the source spelling when it differs", () => {
    const rows = parseSp500Wikitext(
      '{| id="constituents"\n|-\n|| {{NyseSymbol|BRK.B}}\n|| [[Berkshire Hathaway]]\n|| Financials\n|}',
    );
    assert.equal(rows[0].symbol, "BRK-B");
    assert.equal(
      (rows[0] as { wikiSymbol?: string }).wikiSymbol,
      "BRK.B",
      "the source spelling was not preserved for traceability",
    );
  });

  it("does not add wikiSymbol when no normalisation happened", () => {
    const rows = parseSp500Wikitext(WIKI);
    assert.equal((rows[0] as { wikiSymbol?: string }).wikiSymbol, undefined);
  });

  it("collapses piped and plain wikilinks, and strips refs", () => {
    assert.equal(cleanWikiCell("[[Alphabet Inc.|Alphabet]]"), "Alphabet");
    assert.equal(cleanWikiCell("[[3M]]"), "3M");
    assert.equal(cleanWikiCell("Acme<ref name=x>cite</ref>"), "Acme");
    assert.equal(cleanWikiCell("Acme<ref name=x/>"), "Acme");
  });
});

// ── dual listings ────────────────────────────────────────────────────────

describe("dual-listing dedupe", () => {
  it("collapses one ISIN quoted on both exchanges to a single NSE row", () => {
    // The measured reality: every one of prod's top 15 by market cap appears
    // twice. Without this, "top 500" is ~250 companies counted twice.
    const out = dedupeByIsin([
      row({ symbol: "RELIANCE", exchange: "BSE", isin: "INE002A01018" }),
      row({ symbol: "RELIANCE", exchange: "NSE", isin: "INE002A01018" }),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].exchange, "NSE");
  });

  it("prefers NSE regardless of input order", () => {
    const a = dedupeByIsin([
      row({ exchange: "NSE", isin: "I1" }),
      row({ exchange: "BSE", isin: "I1" }),
    ]);
    const b = dedupeByIsin([
      row({ exchange: "BSE", isin: "I1" }),
      row({ exchange: "NSE", isin: "I1" }),
    ]);
    assert.equal(a[0].exchange, "NSE");
    assert.equal(b[0].exchange, "NSE");
  });

  it("is deterministic when NEITHER row is on the preferred exchange", () => {
    // Otherwise the winner depends on Mongo's return order and a regeneration
    // reshuffles rows for no reason.
    const a = dedupeByIsin([
      row({ exchange: "MCX", isin: "I1" }),
      row({ exchange: "BSE", isin: "I1" }),
    ]);
    const b = dedupeByIsin([
      row({ exchange: "BSE", isin: "I1" }),
      row({ exchange: "MCX", isin: "I1" }),
    ]);
    assert.equal(a[0].exchange, "BSE");
    assert.equal(b[0].exchange, "BSE");
  });

  it("KEEPS rows with no ISIN rather than silently dropping them", () => {
    const out = dedupeByIsin([
      row({ symbol: "A", isin: null }),
      row({ symbol: "B", isin: null }),
    ]);
    assert.equal(out.length, 2, "rows without an ISIN were dropped");
  });
});

// ── ranking and emit order ───────────────────────────────────────────────

describe("ranking and emit order", () => {
  it("takes the top N by the metric, descending", () => {
    const out = topByMetric(
      [
        row({ symbol: "LOW", marketCap: 1 }),
        row({ symbol: "HIGH", marketCap: 100 }),
        row({ symbol: "MID", marketCap: 50 }),
      ],
      "marketCap",
      2,
    );
    assert.deepEqual(
      out.map((r) => r.symbol),
      ["HIGH", "MID"],
    );
  });

  it("breaks ties on symbol, so the boundary never reshuffles", () => {
    const forward = topByMetric(
      [row({ symbol: "B", marketCap: 5 }), row({ symbol: "A", marketCap: 5 })],
      "marketCap",
      2,
    );
    const reverse = topByMetric(
      [row({ symbol: "A", marketCap: 5 }), row({ symbol: "B", marketCap: 5 })],
      "marketCap",
      2,
    );
    assert.deepEqual(
      forward.map((r) => r.symbol),
      ["A", "B"],
    );
    assert.deepEqual(
      forward.map((r) => r.symbol),
      reverse.map((r) => r.symbol),
    );
  });

  it("excludes non-finite and non-positive metrics rather than ranking them", () => {
    // A NaN sorts unpredictably and would otherwise occupy a slot silently.
    const out = topByMetric(
      [
        row({ symbol: "OK", marketCap: 10 }),
        row({ symbol: "NAN", marketCap: NaN }),
        row({ symbol: "ZERO", marketCap: 0 }),
        row({ symbol: "NULL", marketCap: null }),
        row({ symbol: "NEG", marketCap: -5 }),
      ],
      "marketCap",
      10,
    );
    assert.deepEqual(
      out.map((r) => r.symbol),
      ["OK"],
    );
  });

  it("emits sorted by SYMBOL, not by rank, so a diff is reviewable", () => {
    // Market caps move daily. Rank order would reshuffle hundreds of lines on
    // every regeneration and bury the one change anyone cares about.
    const out = stableBySymbol([
      { symbol: "ZEE" },
      { symbol: "ACC" },
      { symbol: "MID" },
    ]);
    assert.deepEqual(
      out.map((r) => r.symbol),
      ["ACC", "MID", "ZEE"],
    );
  });

  it("does not mutate its input", () => {
    const input = [{ symbol: "B" }, { symbol: "A" }];
    stableBySymbol(input);
    assert.deepEqual(
      input.map((r) => r.symbol),
      ["B", "A"],
    );
  });
});

// ── delisted resolution ──────────────────────────────────────────────────

const masterRow = (o: Partial<Record<string, unknown>>) => ({
  ticker: "DOW",
  exchange: "NYSE",
  assetType: "Stock",
  priceCurrency: "USD",
  startDate: "1972-06-01",
  endDate: "2017-08-31",
  status: "DELISTED",
  ...o,
});

describe("delisted resolution against the Tiingo master", () => {
  const DOW_OLD = masterRow({});
  const DOW_NEW = masterRow({
    startDate: "2019-03-20",
    endDate: "2026-08-27",
    status: "ACTIVE",
  });

  it("picks the window the SPEC names, not whichever row comes first", () => {
    // The entire reason listingId exists: DOW is Dow Chemical (1972-2017) and
    // Dow Inc. (2019-), identical in exchange, assetType and currency.
    const out = resolveDelisted(
      [
        {
          symbol: "DOW",
          exchange: "NYSE",
          listingStartDate: "1972-06-01",
          rationale: "Dow Chemical",
        },
      ],
      [DOW_NEW, DOW_OLD],
      buildListingId,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].listingId, "DOW:NYSE:1972-06-01");
    assert.equal(out[0].listingEndDate, "2017-08-31");
  });

  it("builds the listingId with the SAME helper production uses", () => {
    // Not a re-implementation: a divergent format here would key candles
    // written by this sample differently from candles written by the sync.
    assert.equal(
      buildListingId("DOW", "NYSE", "1972-06-01"),
      "DOW:NYSE:1972-06-01",
    );
  });

  it("ABORTS when the spec would resolve to a live security", () => {
    assert.throws(
      () =>
        resolveDelisted(
          [
            {
              symbol: "DOW",
              exchange: "NYSE",
              listingStartDate: "2019-03-20",
              rationale: "wrong window",
            },
          ],
          [DOW_NEW, DOW_OLD],
          buildListingId,
        ),
      /still reports as ACTIVE/,
    );
  });

  it("ABORTS on an ambiguous match rather than picking one", () => {
    const dup = masterRow({ assetType: "ETF" });
    assert.throws(
      () =>
        resolveDelisted(
          [
            {
              symbol: "DOW",
              exchange: "NYSE",
              listingStartDate: "1972-06-01",
              rationale: "x",
            },
          ],
          [DOW_OLD, dup],
          buildListingId,
        ),
      /matched 2 master rows, expected exactly 1/,
    );
  });

  it("ABORTS when the window vanishes upstream instead of skipping it", () => {
    assert.throws(
      () =>
        resolveDelisted(
          [
            {
              symbol: "DOW",
              exchange: "NYSE",
              listingStartDate: "1999-01-01",
              rationale: "x",
            },
          ],
          [DOW_OLD],
          buildListingId,
        ),
      /matched 0 master rows/,
    );
  });

  it("ignores non-USD rows for the same ticker", () => {
    const cny = masterRow({ priceCurrency: "CNY", startDate: "1972-06-01" });
    const out = resolveDelisted(
      [
        {
          symbol: "DOW",
          exchange: "NYSE",
          listingStartDate: "1972-06-01",
          rationale: "x",
        },
      ],
      [DOW_OLD, cny],
      buildListingId,
    );
    assert.equal(out.length, 1);
  });

  describe("the two deliberately-absent probes", () => {
    const ENE = {
      symbol: "ENE",
      expectAbsent: true,
      upstreamBehaviour: "HTTP 404",
      rationale: "Enron",
    };

    it("resolves to a null listingId with inTiingoMaster false", () => {
      const out = resolveDelisted([ENE], [], buildListingId);
      assert.equal(out.length, 1);
      assert.equal(out[0].listingId, null);
      assert.equal(out[0].inTiingoMaster, false);
      assert.equal(out[0].upstreamBehaviour, "HTTP 404");
    });

    it("ABORTS if Tiingo ever starts carrying them", () => {
      // ENE and LEH are in the list BECAUSE they are missing upstream and fail
      // differently (404 vs 200-with-empty-array). If that stops being true the
      // list has silently lost its only coverage of those paths.
      assert.throws(
        () =>
          resolveDelisted(
            [ENE],
            [masterRow({ ticker: "ENE" })],
            buildListingId,
          ),
        /marked expectAbsent but Tiingo's master now has 1 USD row/,
      );
    });
  });
});

// ── the anti-hollow guards ───────────────────────────────────────────────

describe("guards against a silently smaller universe", () => {
  it("assertPlausible throws below the floor and passes at or above it", () => {
    assert.throws(
      () => assertPlausible("in.equities", 12, 500),
      /produced only 12 rows, below the floor of 500/,
    );
    assert.doesNotThrow(() => assertPlausible("in.equities", 500, 500));
    assert.doesNotThrow(() => assertPlausible("in.equities", 501, 500));
  });

  it("intersect keeps ranked order and drops what the collection lacks", () => {
    // The measured failure: 12,409 of 14,225 masters have no NAV history, so a
    // list ranked over the master matches 0 of 3,193,427 rows while looking
    // entirely well-formed.
    const out = intersectPreservingOrder(
      ["119551", "100033", "999999", "100034"],
      new Set(["100034", "100033"]),
    );
    assert.deepEqual(out, ["100033", "100034"]);
  });

  it("intersect can shrink to nothing — it never pads back up", () => {
    assert.deepEqual(intersectPreservingOrder(["a", "b"], new Set()), []);
  });

  it("isinsOf dedupes, sorts, and omits missing ISINs rather than emitting null", () => {
    // A null inside an `$in` array matches documents where the field is
    // ABSENT, which would silently widen the slice instead of narrowing it.
    const out = isinsOf([
      { isin: "INE002A01018" },
      { isin: null },
      { isin: "INE002A01018" },
      { isin: "" },
      { isin: "INE001A01036" },
    ]);
    assert.deepEqual(out, ["INE001A01036", "INE002A01018"]);
  });
});

// ── US mutual funds ──────────────────────────────────────────────────────

describe("US mutual-fund selection", () => {
  const fund = (ticker: string, startDate: string, endDate = "2026-08-26") => ({
    ticker,
    startDate,
    endDate,
  });

  // Longevity order here is OLD > MID > NEW.
  const POP = [
    fund("NEW", "2020-01-01"),
    fund("OLD", "1960-01-29"),
    fund("MID", "1990-01-01"),
    fund("SWPPX", "1997-05-20"),
  ];

  it("pins the curated core FIRST, ahead of the longevity ranking", () => {
    // SWPPX is younger than OLD and MID, so a pure longevity ranking would
    // drop it. It is pinned because its split (2025-08-15 x6) is measured, and
    // splitFactor is a sparse path a longevity ranking will not reliably hit.
    const { symbols } = selectUsFunds(POP, ["SWPPX"], 2);
    assert.deepEqual(symbols, ["SWPPX", "OLD"]);
  });

  it("fills the remainder by longevity, longest-lived first", () => {
    const { symbols } = selectUsFunds(POP, [], 3);
    assert.deepEqual(symbols, ["OLD", "MID", "SWPPX"]);
  });

  it("never duplicates a curated fund that the ranking would also pick", () => {
    const { symbols } = selectUsFunds(POP, ["OLD"], 3);
    assert.equal(
      new Set(symbols).size,
      symbols.length,
      `duplicate in ${symbols}`,
    );
    assert.deepEqual(symbols, ["OLD", "MID", "SWPPX"]);
  });

  it("REPORTS a curated fund that is no longer live rather than dropping it", () => {
    // Silently proceeding would yield 100 fund tickers with no measured
    // corporate action among them — a full-looking sample that leaves the
    // sparse splitFactor path untested.
    const { missingCurated } = selectUsFunds(POP, ["SWPPX", "GONE"], 2);
    assert.deepEqual(missingCurated, ["GONE"]);
  });

  it("breaks longevity ties on ticker, so the boundary is stable", () => {
    const tied = [fund("BBB", "1980-01-02"), fund("AAA", "1980-01-02")];
    assert.deepEqual(selectUsFunds(tied, [], 2).symbols, ["AAA", "BBB"]);
    assert.deepEqual(selectUsFunds([...tied].reverse(), [], 2).symbols, [
      "AAA",
      "BBB",
    ]);
  });

  it("ranks a listing with unusable dates LAST rather than first", () => {
    // A null date must not sort to the top and consume a slot.
    const { symbols } = selectUsFunds(
      [
        { ticker: "NULLS", startDate: null, endDate: null },
        fund("REAL", "1990-01-01"),
      ],
      [],
      2,
    );
    assert.deepEqual(symbols, ["REAL", "NULLS"]);
  });

  it("stops at the target and does not over-fill", () => {
    assert.equal(selectUsFunds(POP, [], 2).symbols.length, 2);
  });
});

// ── the shape the consumer actually reads ────────────────────────────────

describe("the manifest matches the consumer's contract", () => {
  it("the consumer still flattens `symbols` as a flat string array", () => {
    // If `universeFromManifest` ever stops doing `pick(l) => l.symbols`, the
    // generator's emit shape has to move with it. An array of objects would
    // produce a Set of "[object Object]" and every $in would match nothing.
    const consumer = readFileSync(CONSUMER, "utf8");
    assert.match(
      consumer,
      /Array\.isArray\(l\?\.symbols\)\s*\?\s*l\.symbols\s*:\s*\[\]/,
      "qa-sample-plan.ts no longer picks a flat `symbols` array",
    );
    assert.match(
      consumer,
      /schemeCodes:\s*\[\.\.\.new Set\(m\.schemeCodes \?\? pick\(m\.in\?\.schemes\)\)\]/,
      "the schemeCodes fallback changed",
    );
    // us_fund_nav's writer selects assetType === "Mutual Fund". If funds are
    // ever folded back into usSymbols, that table is sampled against symbols
    // it can never match — zero rows, guard skips, run reports success.
    assert.match(
      consumer,
      /usFundSymbols:\s*\[\.\.\.new Set\(pick\(m\.us\?\.funds\)\)\]/,
      "usFundSymbols is no longer read from m.us.funds as a separate vector",
    );
  });

  if (existsSync(MANIFEST)) {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<
      string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      any
    >;

    it("carries every key the consumer reads", () => {
      for (const p of ["us.equities", "us.etfs", "us.delisted"]) {
        const [a, b] = p.split(".");
        assert.ok(Array.isArray(m[a][b].symbols), `${p}.symbols missing`);
      }
      for (const p of ["in.equities", "in.etfs", "in.schemes"]) {
        const [a, b] = p.split(".");
        assert.ok(Array.isArray(m[a][b].symbols), `${p}.symbols missing`);
      }
      assert.ok(Array.isArray(m.isins), "isins missing");
      assert.ok(Array.isArray(m.schemeCodes), "schemeCodes missing");
    });

    it("every `symbols` member is a STRING, never an object", () => {
      const lists: string[][] = [
        m.us.equities.symbols,
        m.us.etfs.symbols,
        m.us.delisted.symbols,
        m.us.funds.symbols,
        m.in.equities.symbols,
        m.in.etfs.symbols,
        m.in.schemes.symbols,
        m.isins,
        m.schemeCodes,
      ];
      for (const l of lists) {
        for (const s of l) {
          assert.equal(
            typeof s,
            "string",
            `found a non-string member: ${JSON.stringify(s)}`,
          );
        }
      }
    });

    it("no US symbol carries a DOT — they would match zero rows", () => {
      const dotted = [
        ...m.us.equities.symbols,
        ...m.us.etfs.symbols,
        ...m.us.delisted.symbols,
        ...m.us.funds.symbols,
      ].filter((x: string) => x.includes("."));
      assert.deepEqual(dotted, [], `dotted US tickers survived: ${dotted}`);
    });

    it("carries a us.funds list the equity lists could never supply", () => {
      assert.ok(Array.isArray(m.us.funds.symbols), "us.funds.symbols missing");
      assert.equal(m.us.funds.symbols.length, 100);
      const equityish = new Set<string>([
        ...m.us.equities.symbols,
        ...m.us.etfs.symbols,
        ...m.us.delisted.symbols,
      ]);
      const overlap = (m.us.funds.symbols as string[]).filter((f) =>
        equityish.has(f),
      );
      assert.deepEqual(
        overlap,
        [],
        `a fund ticker also appears as an equity: ${overlap}`,
      );
    });

    it("pins the six funds whose corporate actions are MEASURED", () => {
      for (const t of ["SWPPX", "FCNTX", "FSPTX", "DODGX", "VFIAX", "FXAIX"]) {
        assert.ok(
          (m.us.funds.symbols as string[]).includes(t),
          `${t} is missing — its split/dividend is measured and it is pinned`,
        );
        assert.ok(
          m.us.funds.pinnedEvidence[t],
          `${t} has no recorded evidence for why it is pinned`,
        );
      }
    });

    it("does NOT claim the fund list is hit-count validated", () => {
      // us_fund_nav does not exist in prod, so a zero there is an absent
      // table, not a validated list. Saying so is the difference between
      // evidence and the appearance of it.
      assert.equal(m.us.funds.hitCountValidated, false);
      const v = (
        m.validation as Array<{ list: string; expectedZero?: string }>
      ).find((x) => x.list === "us.funds");
      assert.ok(v?.expectedZero, "us.funds has no expectedZero reason");
      assert.match(v.expectedZero, /NOT hit-count validated/);
    });

    it("holds the sizes the founder asked for", () => {
      assert.ok(m.us.equities.symbols.length >= 450, "S&P 500 list is short");
      assert.equal(m.us.etfs.symbols.length, 100);
      assert.equal(m.us.delisted.symbols.length, 20);
      assert.equal(m.in.equities.symbols.length, 500);
      assert.equal(m.in.etfs.symbols.length, 100);
    });

    it("declares a method for every list, and never claims derived when static", () => {
      assert.equal(m.us.equities.method, "derived:wikipedia");
      assert.ok(
        ["static-fallback", "derived:prod-candles"].includes(m.us.etfs.method),
        `unexpected us.etfs method ${m.us.etfs.method}`,
      );
      assert.equal(m.in.equities.method, "derived:prod");
      assert.equal(m.in.etfs.method, "derived:prod");
    });

    it("keeps schemeCodes and in.schemes.symbols identical", () => {
      // The consumer prefers the top-level one; a disagreement makes the other
      // a silent falsehood in a checked-in file.
      assert.deepEqual(m.schemeCodes, m.in.schemes.symbols);
    });

    it("every list is sorted, so a regeneration diffs as adds and removes", () => {
      const sorted = (a: string[]) =>
        JSON.stringify(a) === JSON.stringify([...a].sort());
      assert.ok(sorted(m.in.equities.symbols), "in.equities is not sorted");
      assert.ok(sorted(m.in.etfs.symbols), "in.etfs is not sorted");
      assert.ok(sorted(m.us.equities.symbols), "us.equities is not sorted");
      assert.ok(sorted(m.us.etfs.symbols), "us.etfs is not sorted");
      assert.ok(sorted(m.isins), "isins is not sorted");
    });

    it("records a non-zero hit count for every list whose collection exists", () => {
      // The point of the whole validation block: a manifest that produces
      // empty slices is worse than none, because the sync reports success.
      for (const v of m.validation as Array<{
        list: string;
        collection: string;
        matched: number;
        expectedZero?: string;
      }>) {
        if (v.expectedZero) continue;
        assert.ok(
          v.matched > 0,
          `${v.list} -> ${v.collection} matched 0 rows with no expectedZero reason`,
        );
      }
    });

    it("the delisted listings carry a listingId except the absent probes", () => {
      const listings = m.us.delisted.listings as Array<{
        symbol: string;
        listingId: string | null;
        inTiingoMaster: boolean;
      }>;
      const absent = listings.filter((l) => !l.inTiingoMaster);
      assert.deepEqual(
        absent.map((l) => l.symbol).sort(),
        ["ENE", "LEH"],
        "the two different-failure probes changed",
      );
      for (const l of listings) {
        if (l.inTiingoMaster) {
          assert.match(
            l.listingId ?? "",
            /^[^:]+:[^:]+:\d{4}-\d{2}-\d{2}$/,
            `${l.symbol} has a malformed listingId`,
          );
        } else {
          assert.equal(l.listingId, null);
        }
      }
    });

    it("keeps the recycled tickers that make listingId necessary", () => {
      const ids = (
        m.us.delisted.listings as Array<{ listingId: string | null }>
      )
        .map((l) => l.listingId)
        .filter((x): x is string => x !== null);
      // DOW is the canonical case; a bare "DOW" is ambiguous between Dow
      // Chemical and Dow Inc.
      assert.ok(
        ids.includes("DOW:NYSE:1972-06-01"),
        "the Dow Chemical listing is no longer in the sample",
      );
    });
  }
});

// ── the fixture framing ──────────────────────────────────────────────────

describe("the manifest stays a TEST FIXTURE", () => {
  it("the generator says so prominently", () => {
    assert.match(
      RAW,
      /THIS IS A TEST FIXTURE\. IT IS NOT A PRODUCTION DATA DEPENDENCY\./,
    );
  });

  it("nothing in a production path reads the manifest", () => {
    // The property that keeps this file clear of licensing questions. A grep,
    // because the only way to break it is for someone to add an import.
    let hits = "";
    try {
      hits = execFileSync(
        "git",
        [
          "grep",
          "-l",
          "qa-sample-universe",
          "--",
          "apps/",
          "workers/",
          "packages/",
        ],
        { cwd: ROOT, encoding: "utf8" },
      );
    } catch {
      hits = ""; // git grep exits 1 when there are no matches
    }
    const offenders = hits
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.includes("__tests__"));
    assert.deepEqual(
      offenders,
      [],
      `the QA sample manifest is referenced from a production path: ${offenders.join(", ")}`,
    );
  });

  it("deriveListingStatus is the shared rule, not a copy in the region", () => {
    // The region must not re-implement ACTIVE/DELISTED. It consumes a status
    // the caller computed with core's helper, so there is one rule.
    assert.doesNotMatch(REGION, /toleranceDays|fileMaxEndDate/);
    assert.equal(
      deriveListingStatus(
        {
          ticker: "X",
          exchange: "NYSE",
          assetType: "Stock",
          priceCurrency: "USD",
          startDate: "1990-01-01",
          endDate: "2017-08-31",
        },
        "2026-08-28",
      ),
      "DELISTED",
    );
  });
});
