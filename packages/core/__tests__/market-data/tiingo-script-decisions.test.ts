/**
 * The three Tiingo backfill/seed scripts' PURE DECISIONS — MONEY-1263 review.
 *
 * Covers F1 (a partial write must not be a terminal DONE), F2 (the news seed
 * must not walk the current day), F3 (a moved route must stop the run) and F4
 * (an unparseable argument must never resolve to a bigger job).
 *
 * ## Why the decisions are LIFTED out of the real files
 *
 * Same mechanism, and the same reasoning, as `repair-fo-summary-gap.test.ts`:
 * each script has a top-level `main()` and a module-scope `@usemoney/database`
 * import, so it cannot simply be imported into `node:test` — importing it would
 * RUN it. The decisions are pure and marker-delimited, so each region is read
 * out of the shipping file, written to a temp ESM module and imported. Mutate
 * the region in the script and these tests fail, which is exactly what a
 * source-text assertion cannot promise.
 *
 * The alternative — spawning each script with a bad argv and asserting on the
 * exit code, as `backfill-financials-flag-safety.test.ts` does — was rejected
 * here for cost: ~30 argv cases across three scripts is ~30 node processes,
 * each loading Prisma. The one property that shape would add (the guard really
 * runs at module scope, before any work) is instead pinned by asserting that
 * the parse call site sits above `main()` in the file.
 *
 * ## The argv parser is ONE rule stated three times
 *
 * It has to be: these are standalone scripts with no shared local module, and
 * the repo's own convention is a per-script `KNOWN_FLAGS` (seven scripts do
 * it). So the region is pinned BYTE-IDENTICAL across the three files below —
 * three copies drift, three copies a test compares cannot.
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
// The REAL boundary, from the package the repository itself uses. The script
// under test must not have a second copy — see the de-duplication guard below.
import {
  hotWindowFloorYear,
  resolveCandleDestination,
  HOT_WINDOW_YEARS,
} from "../../src/market-data/candles/candle-logic";

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

// `scripts/jobs/`, not `scripts/data/` — MONEY-1263. These three moved when
// they became Cloud Run JOBS: every long backfill in this repo lives in
// `scripts/jobs/` and is a tsup entry compiled to `dist/<name>.js`, because a
// multi-hour walk cannot sit behind Pub/Sub's 600s ack deadline. A path that
// still said `data/` would make this whole file throw in its module body.
const SCRIPTS = {
  eod: join(ROOT, "scripts", "jobs", "tiingo-us-backfill.ts"),
  corpActions: join(
    ROOT,
    "scripts",
    "jobs",
    "tiingo-us-corp-actions-backfill.ts",
  ),
  news: join(ROOT, "scripts", "jobs", "tiingo-us-news-seed.ts"),
} as const;

const RAW: Record<keyof typeof SCRIPTS, string> = {
  eod: readFileSync(SCRIPTS.eod, "utf8"),
  corpActions: readFileSync(SCRIPTS.corpActions, "utf8"),
  news: readFileSync(SCRIPTS.news, "utf8"),
};

/**
 * The pure, import-free region between a marker pair.
 *
 * The `:begin` marker lives INSIDE a block comment (so the region's own doc
 * comment travels with the file rather than with the extract), and the region
 * is everything from that comment's `*​/` to the `:end` marker.
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

/** A `const NAME: Type = { … };` object literal, lifted verbatim and exported. */
function constLiteral(src: string, decl: string, file: string): string {
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`${file} no longer declares \`${decl}\``);
  const end = src.indexOf("\n};", start);
  if (end < 0) throw new Error(`${file}: \`${decl}\` has no closing "};"`);
  return `export ${src.slice(start, end + 3)}`;
}

const tempDir = mkdtempSync(join(tmpdir(), "tiingo-script-extract-"));
after(() => rmSync(tempDir, { recursive: true, force: true }));

let moduleSeq = 0;
async function loadModule(source: string): Promise<Record<string, unknown>> {
  const path = join(tempDir, `extracted-${moduleSeq++}.mts`);
  writeFileSync(path, `${source}\n`, "utf8");
  return (await import(pathToFileURL(path).href)) as Record<string, unknown>;
}

// ── The regions, lifted ──────────────────────────────────────────────────

const CLI_REGION = {
  eod: markedRegion(RAW.eod, "tiingo-cli-args", "tiingo-us-backfill.ts"),
  corpActions: markedRegion(
    RAW.corpActions,
    "tiingo-cli-args",
    "tiingo-us-corp-actions-backfill.ts",
  ),
  news: markedRegion(RAW.news, "tiingo-cli-args", "tiingo-us-news-seed.ts"),
} as const;

const EOD_VERDICT_REGION = markedRegion(
  RAW.eod,
  "eod-write-verdict",
  "tiingo-us-backfill.ts",
);
const COLD_SPAN_REGION = markedRegion(
  RAW.eod,
  "cold-span",
  "tiingo-us-backfill.ts",
);
const COLD_STAMP_REGION = markedRegion(
  RAW.eod,
  "cold-stamp-verdict",
  "tiingo-us-backfill.ts",
);
const BREAKER_REGION = markedRegion(
  RAW.corpActions,
  "corp-actions-notfound-breaker",
  "tiingo-us-corp-actions-backfill.ts",
);
const NEWS_WINDOW_REGION = markedRegion(
  RAW.news,
  "news-window-end",
  "tiingo-us-news-seed.ts",
);

// ── Typed views of the extracted modules ─────────────────────────────────

interface CliSpec {
  readonly bare: readonly string[];
  readonly valued: readonly string[];
  readonly numeric: readonly string[];
}
interface CliArgs {
  has(flag: string): boolean;
  value(flag: string): string | undefined;
  number(flag: string, fallback: number): number;
}
type ParseCli = (argv: readonly string[], spec: CliSpec) => CliArgs;

interface EodTally {
  created: number;
  upgraded: number;
  preserved: number;
  dupInBatch: number;
  droppedNonFinite: number;
  failed: number;
  archivedCold: number;
}
interface EodVerdict {
  status: "DONE" | "ERROR";
  rows: number;
  detail: string | undefined;
}
interface EodCheckpointFields {
  status: string;
  rows: number;
  bytes: number;
  firstTs: Date | null;
  lastTs: Date | null;
  detail: string | null;
}

type LegOutcome = "answered" | "not-found" | "failed";
interface StreakVerdict {
  streak: number;
  stop: string | null;
}

interface WindowEnd {
  to: string;
  warning: string | null;
}

const eodModule = await loadModule(
  `${CLI_REGION.eod}\n${EOD_VERDICT_REGION}\n${COLD_SPAN_REGION}\n${COLD_STAMP_REGION}\n${constLiteral(RAW.eod, "const CLI_SPEC: TiingoCliSpec = {", "tiingo-us-backfill.ts")}`,
);
const corpModule = await loadModule(
  `${CLI_REGION.corpActions}\n${BREAKER_REGION}\n${constLiteral(RAW.corpActions, "const CLI_SPEC: TiingoCliSpec = {", "tiingo-us-corp-actions-backfill.ts")}`,
);
const newsModule = await loadModule(
  `${CLI_REGION.news}\n${NEWS_WINDOW_REGION}\n${constLiteral(RAW.news, "const CLI_SPEC: TiingoCliSpec = {", "tiingo-us-news-seed.ts")}`,
);

const parseCli = corpModule.parseTiingoCliArgs as ParseCli;
const CliError = corpModule.TiingoCliError as new (m: string) => Error;
const judgeEodWrite = eodModule.judgeEodWrite as (
  fetched: number,
  res: EodTally,
) => EodVerdict;
const eodCheckpointFields = eodModule.eodCheckpointFields as (args: {
  status: string;
  landedRows: number;
  detail: string | undefined;
  bars: { bytes: number; bars: readonly { date: string }[] } | null;
}) => EodCheckpointFields;
const judgeNotFoundStreak = corpModule.judgeNotFoundStreak as (
  previous: number,
  outcome: LegOutcome,
  context: string,
) => StreakVerdict;
const MAX_CONSECUTIVE_NOT_FOUND =
  corpModule.MAX_CONSECUTIVE_NOT_FOUND as number;
interface HotColdSplit<B> {
  hot: B[];
  coldCount: number;
  coldYearsFrom: number | null;
  coldYearsTo: number | null;
}
/** The minimum a bar needs to be routed: a year. */
interface Bar {
  y: number;
}

const splitByDestination = eodModule.splitByDestination as <B>(args: {
  bars: readonly B[];
  yearOf: (bar: B) => number;
  listingStatus: string;
  now: Date;
  destinationOf: (a: {
    barYear: number;
    listingStatus: string;
    now: Date;
  }) => string;
}) => HotColdSplit<B>;

const planColdStamp = eodModule.planColdStamp as (args: {
  coldYearsFrom: number | null;
  coldYearsTo: number | null;
  coldFailed: number;
}) => {
  stamp: boolean;
  from: number | null;
  to: number | null;
  reason: string | null;
};

const judgeColdStamp = eodModule.judgeColdStamp as (args: {
  symbol: string;
  exchange: string;
  listingId: string;
  shards: number;
  stamped: boolean;
}) => { missed: number; warning: string | null };

const resolveNewsWindowEnd = newsModule.resolveNewsWindowEnd as (
  explicitTo: string | undefined,
  today: string,
) => WindowEnd;
const NEWS_TO_OFFSET = newsModule.DEFAULT_TO_OFFSET_DAYS as number;

const SPEC = {
  eod: eodModule.CLI_SPEC as CliSpec,
  corpActions: corpModule.CLI_SPEC as CliSpec,
  news: newsModule.CLI_SPEC as CliSpec,
} as const;

/** The spec the parser cases below exercise — the corp-actions one, verbatim. */
const TEST_SPEC = SPEC.corpActions;

// ───────────────────────────────────────────────────────────────────────────
// The extraction is of the real, shipping files
// ───────────────────────────────────────────────────────────────────────────

describe("the lift really came out of the shipping scripts", () => {
  it("each script is substantial and still calls main()", () => {
    for (const [name, src] of Object.entries(RAW)) {
      assert.ok(src.length > 8_000, `${name} read as ${src.length} chars`);
      assert.match(src, /^main\(\)$/m, `${name} no longer calls main()`);
    }
  });

  it("every lifted region is import-free, so the extract is self-contained", () => {
    const regions: [string, string][] = [
      ["cli-args (eod)", CLI_REGION.eod],
      ["cli-args (corp)", CLI_REGION.corpActions],
      ["cli-args (news)", CLI_REGION.news],
      ["eod-write-verdict", EOD_VERDICT_REGION],
      ["cold-span", COLD_SPAN_REGION],
      ["cold-stamp-verdict", COLD_STAMP_REGION],
      ["notfound-breaker", BREAKER_REGION],
      ["news-window-end", NEWS_WINDOW_REGION],
    ];
    for (const [name, region] of regions) {
      assert.ok(
        region.length > 200,
        `${name} region is only ${region.length} chars`,
      );
      assert.doesNotMatch(region, /^\s*import\s/m, `${name} imports something`);
      assert.doesNotMatch(region, /\brequire\(/, `${name} uses require()`);
      // Pure: no clock, no env, no I/O. A decision that reads any of these
      // cannot be tested at a boundary and is exactly what these regions exist
      // to keep out of the loop bodies.
      assert.doesNotMatch(region, /Date\.now\(\)/, `${name} reads the clock`);
      assert.doesNotMatch(region, /process\.env/, `${name} reads the env`);
    }
  });

  it("the argv parser is BYTE-IDENTICAL in all three scripts", () => {
    // The anti-drift guard. Three standalone scripts cannot share a local
    // module, so the rule is stated three times — and a rule stated three times
    // is a rule that diverges unless something compares them.
    assert.equal(
      CLI_REGION.eod,
      CLI_REGION.corpActions,
      "tiingo-us-backfill.ts and tiingo-us-corp-actions-backfill.ts have drifted",
    );
    assert.equal(
      CLI_REGION.eod,
      CLI_REGION.news,
      "tiingo-us-backfill.ts and tiingo-us-news-seed.ts have drifted",
    );
  });

  it("argv is parsed at MODULE scope, above main(), in all three", () => {
    // The guard's value is entirely in WHEN it runs. Parsed inside main() it
    // would still reject a bad flag — after `fetchSupportedTickers()` had
    // already spent a request and after Prisma had connected.
    for (const [name, src] of Object.entries(RAW)) {
      const parsedAt = src.indexOf("const ARGS = parseArgsOrExit();");
      const mainAt = src.indexOf("async function main(");
      assert.ok(parsedAt > 0, `${name} does not call parseArgsOrExit()`);
      assert.ok(mainAt > 0, `${name} has no main()`);
      assert.ok(
        parsedAt < mainAt,
        `${name} parses argv inside/after main() — the guard must run first`,
      );
      // …and it must exit NON-ZERO. `process.exit(1)`, not a bare return.
      assert.match(src, /process\.exit\(1\)/, `${name} does not exit non-zero`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F4 — the argv parser
// ───────────────────────────────────────────────────────────────────────────

describe("parseTiingoCliArgs — accepts exactly one spelling", () => {
  it("parses the documented shape", () => {
    const args = parseCli(
      ["--apply", "--from=2020-01-01", "--to=2020-12-31", "--limit=20"],
      TEST_SPEC,
    );
    assert.equal(args.has("apply"), true);
    assert.equal(args.has("retry-terminal"), false);
    assert.equal(args.value("from"), "2020-01-01");
    assert.equal(args.value("to"), "2020-12-31");
    assert.equal(args.number("limit", 0), 20);
  });

  it("an EMPTY argv is valid — dry run over the whole population", () => {
    const args = parseCli([], TEST_SPEC);
    assert.equal(args.has("apply"), false);
    assert.equal(args.value("from"), undefined);
    assert.equal(args.number("limit", 0), 0);
  });

  it("REJECTS --apply=true — the MONEY-1252 wrapper shape", () => {
    // The headline case. Not detected by `argv.includes("--apply")` and not
    // rejected either, so a multi-hour walk ran as a dry run and exited 0.
    assert.throws(() => parseCli(["--apply=true"], TEST_SPEC), CliError);
    assert.throws(() => parseCli(["--apply=1"], TEST_SPEC), CliError);
    assert.throws(() => parseCli(["--apply="], TEST_SPEC), CliError);
    assert.throws(
      () => parseCli(["--apply=false"], TEST_SPEC),
      /BARE flag/,
      "the message must say what the right spelling is",
    );
  });

  it("REJECTS `--apply=<anything>` for EVERY bare flag of EVERY script", () => {
    // Per-flag, per-script: a spec that grows a bare flag gets the guard for
    // free, and a bare flag accidentally moved into `valued` fails here.
    for (const [script, spec] of Object.entries(SPEC)) {
      for (const flag of spec.bare) {
        assert.throws(
          () => parseCli([`--${flag}=true`], spec),
          CliError,
          `${script}: --${flag}=true must be refused`,
        );
        // …and the bare spelling must still work.
        assert.equal(parseCli([`--${flag}`], spec).has(flag), true);
      }
    }
  });

  it("REJECTS the SPACE form and names the `=` form", () => {
    // `--to 1999-12-31` used to leave TO on its default and turn a
    // ~2,600-request walk into an ~18,600-request one.
    assert.throws(
      () => parseCli(["--to", "1999-12-31"], TEST_SPEC),
      /Use --to=<value>/,
    );
    assert.throws(
      () => parseCli(["--limit", "500"], TEST_SPEC),
      /Use --limit=<value>/,
    );
    // The trailing VALUE token is refused on its own account too, so the space
    // form cannot survive by having its flag spelled some other way.
    assert.throws(
      () => parseCli(["--apply", "500"], TEST_SPEC),
      /Unexpected argument "500"/,
    );
  });

  it("REJECTS an unknown flag and lists what it knows", () => {
    assert.throws(() => parseCli(["--dry-run"], TEST_SPEC), CliError);
    assert.throws(() => parseCli(["--Apply"], TEST_SPEC), /Unknown flag/);
    assert.throws(
      () => parseCli(["--from=x", "--nope=1"], TEST_SPEC),
      CliError,
    );
    try {
      parseCli(["--dry-run"], TEST_SPEC);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /--from=<value>/);
      assert.match(err.message, /--apply/);
    }
  });

  it("REJECTS a non-numeric, zero, negative or exotic numeric value", () => {
    // Every one of these used to collapse to 0 via `Number(x) || 0`, and 0 is
    // the sentinel for NO LIMIT: a typo silently became the whole population.
    for (const bad of [
      "abc",
      "",
      "0",
      "-5",
      "1.5",
      "1e3",
      "0x10",
      "Infinity",
      "NaN",
      " ",
      "12abc",
      "+12",
    ]) {
      assert.throws(
        () => parseCli([`--limit=${bad}`], TEST_SPEC),
        CliError,
        `--limit=${JSON.stringify(bad)} must be refused`,
      );
    }
    // …and a real positive integer is still accepted.
    assert.equal(parseCli(["--limit=1"], TEST_SPEC).number("limit", 0), 1);
    assert.equal(
      parseCli(["--limit=20000"], TEST_SPEC).number("limit", 0),
      20000,
    );
  });

  it("REJECTS an empty value on any valued flag", () => {
    // `--symbols=` used to mean "no symbol filter" — i.e. every listing.
    for (const flag of TEST_SPEC.valued) {
      assert.throws(() => parseCli([`--${flag}=`], TEST_SPEC), CliError);
      assert.throws(() => parseCli([`--${flag}=   `], TEST_SPEC), CliError);
    }
  });

  it("REJECTS a repeated flag rather than picking a winner", () => {
    assert.throws(
      () => parseCli(["--limit=5", "--limit=10"], TEST_SPEC),
      CliError,
    );
    assert.throws(() => parseCli(["--apply", "--apply"], TEST_SPEC), CliError);
    assert.throws(
      () => parseCli(["--from=a", "--from=b"], TEST_SPEC),
      CliError,
    );
  });

  it("REJECTS a positional argument", () => {
    assert.throws(() => parseCli(["2020-01-01"], TEST_SPEC), CliError);
    assert.throws(() => parseCli(["-apply"], TEST_SPEC), CliError);
    assert.throws(() => parseCli(["apply"], TEST_SPEC), CliError);
  });

  it("splits at the FIRST `=`, so a value may contain one", () => {
    assert.equal(parseCli(["--from=a=b"], TEST_SPEC).value("from"), "a=b");
  });

  it("`number()` returns the fallback only when the flag is ABSENT", () => {
    // The distinction the old parser could not make: "not passed" and
    // "unparseable" both produced 0.
    assert.equal(parseCli([], TEST_SPEC).number("limit", 0), 0);
    assert.equal(parseCli([], TEST_SPEC).number("limit", 99), 99);
    assert.equal(parseCli(["--limit=7"], TEST_SPEC).number("limit", 99), 7);
  });

  it("every flag in every script's own USAGE examples is accepted", () => {
    // An execution check on the real specs against the real documented
    // invocations: a flag that is documented but missing from CLI_SPEC would
    // make the script exit 1 on its own header example.
    const usage = /^\s*\*\s+node --import tsx (\S+)(.*)$/gm;
    for (const [name, src] of Object.entries(RAW)) {
      const spec = SPEC[name as keyof typeof SPEC];
      let seen = 0;
      for (const m of src.matchAll(usage)) {
        const argv = (m[2] ?? "")
          .split("#")[0]!
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        seen++;
        assert.doesNotThrow(
          () => parseCli(argv, spec),
          `${name} documents an invocation its own parser refuses: ${argv.join(" ")}`,
        );
      }
      assert.ok(seen >= 3, `${name} has only ${seen} usage examples to check`);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F1 — a partial write is not a terminal DONE
// ───────────────────────────────────────────────────────────────────────────

describe("judgeEodWrite — a lost bar must not be checkpointed DONE", () => {
  const tally = (over: Partial<EodTally>): EodTally => ({
    created: 0,
    upgraded: 0,
    preserved: 0,
    dupInBatch: 0,
    droppedNonFinite: 0,
    failed: 0,
    archivedCold: 0,
    ...over,
  });

  it("a clean write is DONE with no detail", () => {
    const v = judgeEodWrite(11_517, tally({ created: 11_517 }));
    assert.equal(v.status, "DONE");
    assert.equal(v.rows, 11_517);
    assert.equal(v.detail, undefined);
  });

  it("ANY failed row makes the verdict ERROR, not DONE", () => {
    // THE defect. DONE is terminal and the resume set skips it, so the missing
    // bars were a permanent price hole that no re-run repaired.
    const v = judgeEodWrite(11_517, tally({ created: 11_417, failed: 100 }));
    assert.equal(v.status, "ERROR");
    assert.match(v.detail ?? "", /100 bar\(s\) landed NOWHERE/);
    assert.match(v.detail ?? "", /permanent price hole/);
  });

  it("even ONE failed row out of thousands is ERROR", () => {
    assert.equal(
      judgeEodWrite(11_517, tally({ created: 11_516, failed: 1 })).status,
      "ERROR",
    );
  });

  it("`rows` is BARS LANDED, never bars fetched", () => {
    // The old value was `bars.bars.length`, parsed from the very archive object
    // the column exists to be reconciled against — a comparison that could not
    // fail. Here 6 of 10 bars are gone and the column has to say so.
    const v = judgeEodWrite(10, tally({ created: 4, failed: 6 }));
    assert.equal(v.rows, 4);
    assert.notEqual(v.rows, 10);
  });

  it("a fully-PRESERVED re-run reports the full count, not zero", () => {
    // `--retry-terminal` over a symbol that is already complete: nothing is
    // written, everything is preserved. Counting strictly-written would
    // checkpoint `rows: 0` for a symbol holding 11,517 bars, and the archive
    // reconcile would then report a hole that does not exist.
    const v = judgeEodWrite(11_517, tally({ preserved: 11_517 }));
    assert.equal(v.status, "DONE");
    assert.equal(v.rows, 11_517);
    assert.equal(v.detail, undefined);
  });

  it("the ERROR-repair re-run lands back on the archive's own count", () => {
    // The run this fix makes possible: 100 repaired, 11,417 already there.
    const v = judgeEodWrite(11_517, tally({ created: 100, preserved: 11_417 }));
    assert.equal(v.status, "DONE");
    assert.equal(v.rows, 11_517);
  });

  it("dupInBatch and droppedNonFinite are EXCLUDED from `rows`", () => {
    // Neither is in the table, so `rows < fetched` stays a real signal.
    const v = judgeEodWrite(
      10,
      tally({ created: 7, dupInBatch: 2, droppedNonFinite: 1 }),
    );
    assert.equal(v.rows, 7);
    assert.equal(v.status, "DONE");
    assert.match(v.detail ?? "", /dropped=1/);
    assert.match(v.detail ?? "", /dupInBatch=2/);
  });

  it("a non-finite drop is recorded but is NOT a reason to re-fetch", () => {
    // Re-fetching cannot fix a non-finite price — the same bytes come back.
    const v = judgeEodWrite(10, tally({ created: 9, droppedNonFinite: 1 }));
    assert.equal(v.status, "DONE");
    assert.ok(v.detail);
  });

  it("arithmetic that does not close is reported", () => {
    // 10 handed to putCandles, 5 accounted for. Bars went missing somewhere
    // this function cannot see, which is worth a permanent note.
    const v = judgeEodWrite(10, tally({ created: 5 }));
    assert.equal(v.status, "DONE");
    assert.match(v.detail ?? "", /fetched=10/);
  });

  it("an empty response is a clean, silent zero", () => {
    const v = judgeEodWrite(0, tally({}));
    assert.equal(v.status, "DONE");
    assert.equal(v.rows, 0);
    assert.equal(v.detail, undefined);
  });

  it("the CHECKPOINT gets the landed count, not the fetched one", () => {
    // Found by a SURVIVING mutation: `judgeEodWrite` was fully covered and the
    // upsert could still be handed `bars.bars.length`, because the call site
    // lives inside an un-importable `main()`. The mapping is a function now, so
    // this is an execution test rather than a source-text hope.
    const bars = {
      bytes: 4096,
      bars: [{ date: "1980-12-12" }, { date: "2026-08-27" }],
    };
    const fields = eodCheckpointFields({
      status: "ERROR",
      landedRows: 4,
      detail: "6 bar(s) landed NOWHERE",
      bars,
    });
    assert.equal(fields.rows, 4);
    assert.notEqual(fields.rows, bars.bars.length);
    assert.equal(fields.status, "ERROR");
    assert.equal(fields.bytes, 4096);
    assert.equal(fields.detail, "6 bar(s) landed NOWHERE");
  });

  it("firstTs/lastTs describe the FETCHED response, at UTC midnight", () => {
    // They are the archive's range, not the write's — `isRecycledResponse`
    // reasoning is checked against them, so they must be populated even on a
    // symbol where nothing was stored.
    const fields = eodCheckpointFields({
      status: "RECYCLED",
      landedRows: 0,
      detail: "first bar postdates listing end",
      bars: {
        bytes: 99,
        bars: [{ date: "2019-03-20" }, { date: "2026-08-27" }],
      },
    });
    assert.equal(fields.rows, 0);
    assert.equal(fields.firstTs?.toISOString(), "2019-03-20T00:00:00.000Z");
    assert.equal(fields.lastTs?.toISOString(), "2026-08-27T00:00:00.000Z");
  });

  it("a null response yields zeroed columns and null timestamps", () => {
    assert.deepEqual(
      eodCheckpointFields({
        status: "NOT_FOUND",
        landedRows: 0,
        detail: undefined,
        bars: null,
      }),
      {
        status: "NOT_FOUND",
        rows: 0,
        bytes: 0,
        firstTs: null,
        lastTs: null,
        detail: null,
      },
    );
  });

  it("a single-bar response has firstTs === lastTs", () => {
    const fields = eodCheckpointFields({
      status: "DONE",
      landedRows: 1,
      detail: undefined,
      bars: { bytes: 1, bars: [{ date: "2026-08-27" }] },
    });
    assert.equal(fields.firstTs?.toISOString(), fields.lastTs?.toISOString());
  });

  it("the script SPREADS those fields rather than recomputing them", () => {
    // The residue the execution test cannot reach: three key columns and a
    // spread. Asserted on the source because that is all that is left, and
    // stated as such rather than dressed up as behaviour.
    assert.match(
      RAW.eod,
      /const fields = eodCheckpointFields\(\{ status, landedRows, detail, bars \}\);/,
    );
    assert.match(RAW.eod, /\.\.\.fields,/);
    assert.doesNotMatch(
      RAW.eod,
      /rows: bars\?\.bars\.length/,
      "the checkpoint must never be handed the FETCHED count again",
    );
  });

  it("the detail always carries the full breakdown when it fires", () => {
    const v = judgeEodWrite(
      10,
      tally({ created: 1, upgraded: 2, preserved: 3, failed: 4 }),
    );
    for (const part of [
      "fetched=10",
      "created=1",
      "upgraded=2",
      "preserved=3",
      "failed=4",
      "archivedCold=0",
    ]) {
      assert.match(v.detail ?? "", new RegExp(part.replace("=", "=")));
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F3 — a moved route stops the run
// ───────────────────────────────────────────────────────────────────────────

describe("judgeNotFoundStreak — a 404 is the PATH, not the day", () => {
  it("the threshold is more than one and small", () => {
    // More than one, so a single edge blip cannot end a multi-day walk; small,
    // so a genuinely moved route costs a handful of requests rather than
    // ~18,000.
    assert.ok(MAX_CONSECUTIVE_NOT_FOUND > 1, "one 404 must not stop the run");
    assert.ok(MAX_CONSECUTIVE_NOT_FOUND <= 10, "the breaker must trip early");
  });

  it("does not trip below the threshold", () => {
    let streak = 0;
    for (let i = 1; i < MAX_CONSECUTIVE_NOT_FOUND; i++) {
      const v = judgeNotFoundStreak(
        streak,
        "not-found",
        `2020-01-0${i} SPLITS`,
      );
      assert.equal(v.stop, null, `tripped early at ${i}`);
      assert.equal(v.streak, i);
      streak = v.streak;
    }
  });

  it("trips exactly ON the threshold, naming the leg", () => {
    let streak = 0;
    let stop: string | null = null;
    for (let i = 0; i < MAX_CONSECUTIVE_NOT_FOUND; i++) {
      const v = judgeNotFoundStreak(
        streak,
        "not-found",
        "1990-01-02 DISTRIBUTIONS",
      );
      streak = v.streak;
      stop = v.stop;
    }
    assert.ok(stop, "the breaker never tripped");
    assert.match(stop, /ROUTE MOVED/);
    assert.match(stop, /1990-01-02 DISTRIBUTIONS/);
    // It must also tell the operator the damage is repairable — otherwise the
    // natural next move is `--retry-terminal`, which is not needed.
    assert.match(stop, /re-run/);
  });

  it("a 200 RESETS the streak — that is the only thing that does", () => {
    let streak = 0;
    for (let i = 0; i < MAX_CONSECUTIVE_NOT_FOUND - 1; i++) {
      streak = judgeNotFoundStreak(streak, "not-found", "x").streak;
    }
    assert.equal(streak, MAX_CONSECUTIVE_NOT_FOUND - 1);
    const cleared = judgeNotFoundStreak(streak, "answered", "x");
    assert.equal(cleared.streak, 0);
    assert.equal(cleared.stop, null);
  });

  it("a swallowed transport failure HOLDS the streak — it does not clear it", () => {
    // The flapping case. Reset on `failed` and a route that 404s while the
    // network is unhappy never reaches the threshold: one failure between every
    // two 404s and a "consecutive" counter counts nothing.
    let streak = 0;
    let stop: string | null = null;
    for (let i = 0; i < MAX_CONSECUTIVE_NOT_FOUND; i++) {
      streak = judgeNotFoundStreak(streak, "not-found", "y").streak;
      const held = judgeNotFoundStreak(streak, "failed", "y");
      assert.equal(held.streak, streak, "a failure must not move the streak");
      assert.equal(
        held.stop,
        null,
        "a failure alone must not trip the breaker",
      );
      streak = held.streak;
      stop = judgeNotFoundStreak(streak, "not-found", "y").stop;
      if (stop) break;
      streak = judgeNotFoundStreak(streak, "not-found", "y").streak;
    }
    assert.ok(stop, "interleaved failures let the breaker be evaded");
  });

  it("an `answered` leg never carries a stop, however long the run", () => {
    for (const previous of [0, 1, 99]) {
      assert.deepEqual(judgeNotFoundStreak(previous, "answered", "z"), {
        streak: 0,
        stop: null,
      });
    }
  });

  it("NOT_FOUND is no longer a TERMINAL status", () => {
    // The other half of F3, and the half the breaker cannot supply: the legs
    // already written before the breaker trips must be re-walkable. Extracted
    // from the real declaration rather than asserted about its text.
    const match = /const TERMINAL_STATUSES = (\[[^\]]*\]);/.exec(
      RAW.corpActions,
    );
    assert.ok(
      match,
      "tiingo-us-corp-actions-backfill.ts no longer declares TERMINAL_STATUSES",
    );
    const statuses = JSON.parse(match[1]!.replace(/'/g, '"')) as string[];
    assert.deepEqual(statuses.slice().sort(), ["DONE", "EMPTY"]);
    for (const nonTerminal of ["NOT_FOUND", "SHAPE", "ERROR"]) {
      assert.ok(
        !statuses.includes(nonTerminal),
        `${nonTerminal} must stay re-walkable — it is a global condition, not a fact about the day`,
      );
    }
  });

  it("the NOT_FOUND leg is checkpointed with a status the resume set will retry", () => {
    // The status string is kept for triage; what changed is only that it is not
    // in TERMINAL_STATUSES. Pinned together so a future edit cannot restore one
    // without the other.
    assert.match(RAW.corpActions, /status = "NOT_FOUND"/);
    assert.match(RAW.corpActions, /status = "SHAPE"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F2 — the news seed must not walk the current day
// ───────────────────────────────────────────────────────────────────────────

describe("resolveNewsWindowEnd — the default stops at the last SETTLED day", () => {
  it("defaults to YESTERDAY, never today", () => {
    // THE defect. `to = today` walked the current UTC day and checkpointed it
    // DONE/EMPTY — both terminal — so a run at 02:00 UTC (22:00 ET the previous
    // day) recorded a near-empty day that every later run then skipped.
    const end = resolveNewsWindowEnd(undefined, "2026-08-28");
    assert.equal(end.to, "2026-08-27");
    assert.notEqual(end.to, "2026-08-28");
    assert.equal(end.warning, null);
  });

  it("the offset is ONE day, matching the corp-actions sibling", () => {
    assert.equal(NEWS_TO_OFFSET, 1);
    // The sibling states the same rule under the same name; drift between them
    // would mean two jobs disagreeing about when a day is finished.
    const sibling = /const DEFAULT_TO_OFFSET_DAYS = (\d+);/.exec(
      RAW.corpActions,
    );
    assert.ok(
      sibling,
      "the corp-actions script no longer declares the constant",
    );
    assert.equal(Number(sibling[1]), NEWS_TO_OFFSET);
  });

  it("crosses month, year and leap boundaries", () => {
    assert.equal(
      resolveNewsWindowEnd(undefined, "2026-03-01").to,
      "2026-02-28",
    );
    assert.equal(
      resolveNewsWindowEnd(undefined, "2026-01-01").to,
      "2025-12-31",
    );
    assert.equal(
      resolveNewsWindowEnd(undefined, "2028-03-01").to,
      "2028-02-29",
    );
    assert.equal(
      resolveNewsWindowEnd(undefined, "2026-09-01").to,
      "2026-08-31",
    );
  });

  it("an explicit SETTLED --to is honoured silently", () => {
    assert.deepEqual(resolveNewsWindowEnd("2026-08-01", "2026-08-28"), {
      to: "2026-08-01",
      warning: null,
    });
    // The boundary: yesterday itself is settled.
    assert.deepEqual(resolveNewsWindowEnd("2026-08-27", "2026-08-28"), {
      to: "2026-08-27",
      warning: null,
    });
  });

  it("an explicit --to of TODAY is honoured but WARNS", () => {
    // An operator asking for today, with --redo, is making a choice; the
    // consequence is invisible at the moment it is incurred, so it is stated.
    const end = resolveNewsWindowEnd("2026-08-28", "2026-08-28");
    assert.equal(end.to, "2026-08-28");
    assert.ok(end.warning, "walking an unfinished day must warn");
    assert.match(end.warning, /not a SETTLED day/);
    assert.match(end.warning, /TERMINAL/);
    assert.match(end.warning, /--redo/);
    assert.match(
      end.warning,
      /2026-08-27/,
      "the warning names the settled day",
    );
  });

  it("an explicit --to in the FUTURE warns too", () => {
    const end = resolveNewsWindowEnd("2027-01-01", "2026-08-28");
    assert.equal(end.to, "2027-01-01");
    assert.ok(end.warning);
  });

  it("the script actually LOGS the warning rather than dropping it", () => {
    // A warning nobody prints is a warning that does not exist.
    assert.match(RAW.news, /if \(end\.warning !== null\) log\.info\(/);
    assert.match(RAW.news, /const end = resolveNewsWindowEnd\(TO, today\);/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D2/D3 — the hot/cold split, and the two ways it silently over-fills Mongo
// ───────────────────────────────────────────────────────────────────────────

describe("splitByDestination — the boundary is CORE's, injected not copied", () => {
  // The REAL rule, imported from the package the repository uses. Passing this
  // in is the point of the injection: if core moves the window, every case
  // below moves with it, and a script that reintroduced its own copy would
  // disagree with these numbers rather than quietly agreeing with them.
  const bars = (...ys: number[]): Bar[] => ys.map((y) => ({ y }));
  const at = (year: number) => new Date(Date.UTC(year, 5, 15));
  const split = (rows: Bar[], listingStatus: string, now = at(2026)) =>
    splitByDestination<Bar>({
      bars: rows,
      yearOf: (b) => b.y,
      listingStatus,
      now,
      destinationOf: resolveCandleDestination,
    });

  it("an ACTIVE listing keeps in-window bars hot and spans the rest", () => {
    const floor = hotWindowFloorYear(at(2026));
    const p = split(bars(1980, 1980, floor - 1, floor, 2026), "ACTIVE");
    assert.deepEqual(
      p.hot.map((b) => b.y),
      [floor, 2026],
    );
    assert.equal(p.coldCount, 3);
    assert.equal(p.coldYearsFrom, 1980);
    assert.equal(p.coldYearsTo, floor - 1);
  });

  it("the window floor year itself is INSIDE the window", () => {
    // `>=`, not `>`. Asserted through core's own helper so the two cannot
    // disagree about which year the floor is.
    const p = split(bars(hotWindowFloorYear(at(2026))), "ACTIVE");
    assert.equal(p.hot.length, 1);
    assert.equal(p.coldCount, 0);
  });

  it("EVERY bar of a DELISTED listing is cold, none hot", () => {
    // THE half that is easy to drop. A security delisted in 2024 has bars
    // sitting inside a 10-year window, so a year test ALONE sweeps all ~10,287
    // delisted issues into Mongo — the outcome the split exists to prevent.
    const p = split(bars(2019, 2022, 2024, 2026), "DELISTED");
    assert.equal(p.hot.length, 0);
    assert.equal(p.coldCount, 4);
    assert.equal(p.coldYearsFrom, 2019);
    assert.equal(p.coldYearsTo, 2026);
  });

  it("any status that is not ACTIVE routes cold", () => {
    for (const status of ["UNKNOWN", "SUSPENDED", "DELISTED"]) {
      assert.equal(
        split(bars(2026), status).coldCount,
        1,
        `status ${status} must not be treated as ACTIVE`,
      );
    }
  });

  it("the span is the DISTINCT cold years, deduped and ordered", () => {
    const p = split(bars(2003, 2001, 2002, 2001, 2003, 2001), "DELISTED");
    assert.equal(p.coldCount, 6, "every bar is counted");
    assert.equal(p.coldYearsFrom, 2001);
    assert.equal(p.coldYearsTo, 2003);
  });

  it("a listing with NO cold years spans null, not 0", () => {
    // 0 is a legal year to `buildCandleColdKey`, so a numeric sentinel would
    // point a reader at `candles/US/D1/X/0`. Absence has to be absent.
    const p = split(bars(2024, 2026), "ACTIVE");
    assert.equal(p.coldCount, 0);
    assert.equal(p.coldYearsFrom, null);
    assert.equal(p.coldYearsTo, null);
  });

  it("no bar is dropped and none is counted twice", () => {
    // The conservation law. Both halves are reported to the checkpoint, so a
    // split that loses a bar loses it from the accounting too.
    const rows = bars(1970, 1985, 1985, 2016, 2020, 2026, 2026);
    for (const status of ["ACTIVE", "DELISTED"]) {
      const p = split(rows, status);
      assert.equal(
        p.hot.length + p.coldCount,
        rows.length,
        `${status} lost or duplicated a bar`,
      );
    }
  });

  it("an empty response splits to empty, with null bounds", () => {
    const p = split([], "ACTIVE");
    assert.deepEqual(p.hot, []);
    assert.equal(p.coldCount, 0);
    assert.equal(p.coldYearsFrom, null);
  });

  it("a bar whose year did not parse THROWS rather than picking a side", () => {
    // Core routes a non-finite year COLD, which is the conservative direction
    // — but a cold bar with no integer year cannot be filed under a shard key
    // at all, so it would count as archived while landing nowhere.
    assert.throws(
      () =>
        splitByDestination<Bar>({
          bars: [{ y: Number.NaN }],
          yearOf: (b) => b.y,
          listingStatus: "ACTIVE",
          now: at(2026),
          destinationOf: resolveCandleDestination,
        }),
      /non-integer year/,
    );
  });

  it("the span WIDENS as the window rolls forward, never narrows", () => {
    // Why an overwrite of coldYearsFrom/To is safe: `from` is pinned to the
    // first bar and `to` advances by one each 1 January. A stamp that could
    // narrow would orphan the shards outside the new range.
    const rows = bars(1990, 2015, 2016, 2017);
    const a = split(rows, "ACTIVE", at(2026));
    const b = split(rows, "ACTIVE", at(2027));
    assert.equal(a.coldYearsFrom, b.coldYearsFrom);
    assert.ok(
      (b.coldYearsTo ?? -Infinity) >= (a.coldYearsTo ?? -Infinity),
      `coldYearsTo went backwards: ${a.coldYearsTo} -> ${b.coldYearsTo}`,
    );
  });

  it("the year rollover is a CLOCK, so 31 December is testable", () => {
    // C's signature takes `now: Date` rather than a year integer for exactly
    // this. One second apart, on opposite sides of a UTC year boundary.
    const rows = bars(2016);
    const dec31 = new Date("2026-12-31T23:59:59.000Z");
    const jan1 = new Date("2027-01-01T00:00:00.000Z");
    assert.equal(
      split(rows, "ACTIVE", dec31).hot.length,
      1,
      "2016 is in 2016..2026",
    );
    assert.equal(
      split(rows, "ACTIVE", jan1).coldCount,
      1,
      "2016 falls out in 2017..2027",
    );
  });
});

describe("planColdStamp — a stamp is a PROMISE the objects exist", () => {
  it("a clean cold write stamps the span it computed", () => {
    const plan = planColdStamp({
      coldYearsFrom: 1962,
      coldYearsTo: 2015,
      coldFailed: 0,
    });
    assert.equal(plan.stamp, true);
    assert.equal(plan.from, 1962);
    assert.equal(plan.to, 2015);
    assert.equal(plan.reason, null);
  });

  it("ANY failed shard suppresses the stamp entirely", () => {
    // The stamp is what a reader trusts INSTEAD of listing GCS (which fails
    // OPEN to [] — MONEY-941). A span naming years whose objects are missing
    // is unrecoverable by any reader; no span at all is merely unknown.
    const plan = planColdStamp({
      coldYearsFrom: 1962,
      coldYearsTo: 2015,
      coldFailed: 1,
    });
    assert.equal(plan.stamp, false);
    assert.equal(plan.from, null);
    assert.equal(plan.to, null);
    assert.match(plan.reason ?? "", /NOT stamped/);
  });

  it("a listing with no cold years stamps null over whatever was there", () => {
    const plan = planColdStamp({
      coldYearsFrom: null,
      coldYearsTo: null,
      coldFailed: 0,
    });
    assert.equal(plan.stamp, true);
    assert.equal(plan.from, null);
  });
});

describe("judgeColdStamp — the miss is a VALUE, not a branch", () => {
  const args = {
    symbol: "LEH",
    exchange: "NYSE",
    listingId: "LEH:NYSE:1980-01-02",
    shards: 27,
  };

  it("a landed stamp is silent and counts nothing", () => {
    const v = judgeColdStamp({ ...args, stamped: true });
    assert.equal(v.missed, 0);
    assert.equal(v.warning, null);
  });

  it("a missed stamp counts ONE and names the listing and the shards", () => {
    // `updateMany` returns {count: 0} for a listing with no us_instruments row
    // rather than throwing — the right call for a 3.7h walk, and a silent zero
    // unless something turns it into a number.
    const v = judgeColdStamp({ ...args, stamped: false });
    assert.equal(v.missed, 1);
    assert.match(v.warning ?? "", /LEH NYSE/);
    assert.match(v.warning ?? "", /27 cold shard\(s\)/);
    assert.match(v.warning ?? "", /LEH:NYSE:1980-01-02/);
    assert.match(v.warning ?? "", /fails OPEN/);
  });
});

describe("judgeEodWrite — the cold half of the split", () => {
  const tally = (over: Partial<EodTally>): EodTally => ({
    created: 0,
    upgraded: 0,
    preserved: 0,
    dupInBatch: 0,
    droppedNonFinite: 0,
    failed: 0,
    archivedCold: 0,
    ...over,
  });

  it("a DELISTED symbol writes ZERO to Mongo and is still a clean DONE", () => {
    // All 10,287 delisted issues take this path: every bar archived, none in
    // the table. Counting only Mongo would checkpoint `rows: 0` for every one
    // of them — indistinguishable from a symbol whose write failed entirely.
    const v = judgeEodWrite(4_812, tally({ archivedCold: 4_812 }));
    assert.equal(v.status, "DONE");
    assert.equal(v.rows, 4_812);
    assert.equal(v.detail, undefined);
  });

  it("`rows` counts Mongo AND GCS, because both are durable", () => {
    const v = judgeEodWrite(
      11_517,
      tally({ created: 2_500, archivedCold: 9_017 }),
    );
    assert.equal(v.rows, 11_517);
    assert.equal(v.detail, undefined);
  });

  it("the identity closes over the WHOLE response, the repository's own", () => {
    // `created + upgraded + preserved + dupInBatch + droppedNonFinite
    //  + failed + archivedCold === bars handed in`, verbatim from
    // CandleWriteResult. Omitting archivedCold would leave the arithmetic open
    // for every symbol with pre-window history — a permanent detail string on
    // ~every row, which destroys the signal rather than adding one.
    const v = judgeEodWrite(
      100,
      tally({ created: 40, preserved: 10, dupInBatch: 2, archivedCold: 48 }),
    );
    assert.equal(v.detail, undefined);
    const short = judgeEodWrite(100, tally({ created: 40, archivedCold: 48 }));
    assert.match(short.detail ?? "", /archivedCold=48/);
  });

  it("a cold archive does NOT launder a failed hot write into DONE", () => {
    const v = judgeEodWrite(
      11_517,
      tally({ created: 2_400, failed: 100, archivedCold: 9_017 }),
    );
    assert.equal(v.status, "ERROR");
    assert.match(v.detail ?? "", /100 bar\(s\) landed NOWHERE/);
    assert.match(v.detail ?? "", /archivedCold=9017/);
  });
});

describe("the EOD script WIRES the split rather than describing it", () => {
  it("putCandles is handed the WHOLE response, with listingStatus per row", () => {
    // The residue no lifted region can reach: the call site is inside an
    // un-importable `main()`. Two mutations matter here and neither is caught
    // by any unit test above — pre-splitting the batch (which double-writes or
    // loses bars, see the `cold-span` region) and dropping `listingStatus`
    // (which puts all ~10,287 delisted issues in Mongo).
    // MONEY-1617 — the whole response goes through the CLIP first, and
    // putCandles gets everything the clip kept (each bar under the window
    // covering its session). Pre-splitting by tier is still forbidden below.
    assert.match(
      RAW.eod,
      /clipBarsToListingWindows\(\{\s*\n?\s*bars: bars\.bars,/,
      "the clip must be handed the whole response",
    );
    assert.match(
      RAW.eod,
      /await candleRepository\.putCandles\(\s*\n?\s*clip\.kept\.map\(/,
      "putCandles must be handed everything the clip kept",
    );
    // SCOPED to the putCandles block. `listingStatus: row.listingStatus` also
    // appears in the splitByDestination call above it, so a bare match cannot
    // tell which one it found — and the write-row one is the load-bearing
    // copy: without it all ~10,287 delisted issues land in Mongo.
    const callAt = RAW.eod.indexOf(
      "const res = await candleRepository.putCandles(",
    );
    assert.ok(callAt > 0, "putCandles is not called");
    const writeRows = RAW.eod.slice(callAt, RAW.eod.indexOf("})),", callAt));
    // The ASSIGNED window's status (destructured off the clip result), so a
    // predecessor's bars route to its own delisted cold tier.
    assert.match(
      writeRows,
      /\blistingStatus \}\) => \(\{/,
      "the status must come off the clip's assignment",
    );
    assert.match(
      writeRows,
      /^\s*listingStatus,$/m,
      "every write row must carry the assigned listing's status",
    );
    assert.match(writeRows, /source: "TIINGO",/, "the slice found the rows");
    assert.doesNotMatch(
      writeRows,
      /\btier:/,
      "the backfill must never force a tier — WINDOW is what routing computes",
    );
    assert.doesNotMatch(
      RAW.eod,
      /putCandles\(\s*\n?\s*split\.hot\.map\(/,
      "the batch must never be pre-split again",
    );
  });

  it("the script archives NO cold shard of its own", () => {
    // `putCandles` does it. A second writer means a bar in both stores, or a
    // bar in neither while one side counts it written.
    assert.doesNotMatch(
      RAW.eod,
      /\bwriteColdShard\(/,
      "the script must not write cold shards directly — putCandles routes",
    );
  });

  it("the hot/cold boundary exists ONCE, and not in this script", () => {
    // The de-duplication guard. Both copies compiled, both were tested, and
    // both said 10 — which is exactly why the drift would have been invisible.
    // A de-duplication nothing enforces re-duplicates the next time someone is
    // in a hurry.
    assert.doesNotMatch(
      RAW.eod,
      /^\s*(export\s+)?const HOT_WINDOW_YEARS\s*=/m,
      "the script must IMPORT HOT_WINDOW_YEARS, never declare one",
    );
    assert.doesNotMatch(
      RAW.eod,
      /^\s*(export\s+)?function (tierForBar|hotWindowFloorYear|resolveCandleDestination)\b/m,
      "the script must IMPORT the boundary, never define its own",
    );
    // No open-coded window arithmetic either — the shape a copy comes back as.
    assert.doesNotMatch(
      RAW.eod,
      /currentYear\s*-\s*HOT_WINDOW_YEARS\s*\?/,
      "an inline `year >= currentYear - HOT_WINDOW_YEARS ? …` is the rule restated",
    );
    assert.match(
      RAW.eod,
      /from "@usemoney\/core\/market-data\/candles\/candle-logic"/,
      "the boundary must come from core",
    );
  });

  it("the lifted split contributes NO boundary arithmetic of its own", () => {
    // `destinationOf` is a parameter, not an import, precisely so the region
    // stays liftable AND cannot hold a copy of the rule. If it ever computes a
    // floor year itself, that is a second copy wearing an injection's clothes.
    assert.match(COLD_SPAN_REGION, /destinationOf: \(a: \{/);
    assert.doesNotMatch(COLD_SPAN_REGION, /HOT_WINDOW_YEARS/);
    assert.doesNotMatch(COLD_SPAN_REGION, /getUTCFullYear\(\)/);
  });

  it("the stamp is PLANNED, then written, then judged — in that order", () => {
    const planAt = RAW.eod.indexOf("const plan = planColdStamp({");
    const writeAt = RAW.eod.indexOf("? await stampColdYears({");
    const judgeAt = RAW.eod.indexOf("const stamp = judgeColdStamp({");
    assert.ok(planAt > 0, "planColdStamp is not called");
    assert.ok(writeAt > 0, "stampColdYears is not called");
    assert.ok(judgeAt > 0, "judgeColdStamp is not called");
    assert.ok(
      planAt < writeAt && writeAt < judgeAt,
      "the suppression decision must precede the write it suppresses",
    );
  });

  it("the miss count is an UNCONDITIONAL add, so it cannot be neutered", () => {
    // The first version of this counter was `if (!stamped) t.coldStampMissed++`
    // and it SURVIVED an `if (false && !stamped)` mutation, because the branch
    // is inside an un-importable main(). An add of a tested value has no
    // predicate left to falsify.
    assert.match(RAW.eod, /t\.coldStampMissed \+= stamp\.missed;/);
    assert.doesNotMatch(
      RAW.eod,
      /if\s*\([^)]*\)\s*\{?\s*t\.coldStampMissed\+\+/,
      "the count must not be guarded by a branch again",
    );
    assert.match(RAW.eod, /coldStampMissed=\$\{t\.coldStampMissed\}/);
  });

  it("funds are routed away from putCandles entirely", () => {
    assert.match(RAW.eod, /const isFund = row\.instrumentType === "MF";/);
    assert.match(RAW.eod, /prisma\.usFundNav\.upsert\(/);
  });

  it("a fund with no permaTicker is NOT terminal", () => {
    // The resume set must not skip it: run the search enrichment, re-run this
    // walk, and the fund is picked up without --retry-terminal.
    assert.match(RAW.eod, /status = "NO_PERMATICKER";/);
    const at = RAW.eod.indexOf('status: { in: ["DONE"');
    assert.ok(at > 0);
    assert.doesNotMatch(
      RAW.eod.slice(at, at + 200),
      /NO_PERMATICKER/,
      "NO_PERMATICKER must stay out of the resume skip-set",
    );
  });

  it("--apply with no cold store REFUSES before the first request", () => {
    // writeColdShard throws without a registered store, and the repository's
    // fallback writes cold bars to MONGO — which is data-preserving but is the
    // whole size problem. Discovering that per-symbol costs the walk.
    const guardAt = RAW.eod.indexOf("if (APPLY && !coldReady)");
    const fetchAt = RAW.eod.indexOf("await fetchSupportedTickers()");
    assert.ok(guardAt > 0, "there is no cold-store preflight");
    assert.ok(fetchAt > 0);
    assert.ok(
      guardAt < fetchAt,
      "the preflight must run before the master is fetched",
    );
    assert.match(
      RAW.eod,
      /initCandleColdStore\b/,
      "the store must be registered from workers/src/lib, not re-implemented",
    );
  });

  it("the run reads ONE clock, not one per symbol", () => {
    // A 3.7-hour walk started on 31 December would otherwise cross the window
    // boundary mid-walk and route two symbols of the same vintage differently.
    assert.match(RAW.eod, /const now = new Date\(\);/);
    assert.match(RAW.eod, /const currentYear = now\.getUTCFullYear\(\);/);
    // The loop must PASS the hoisted `now`, never mint one. A fresh Date per
    // symbol is what splits a 31-December walk across two windows.
    assert.match(
      RAW.eod,
      /^\s*now,\n\s*destinationOf: resolveCandleDestination,/m,
      "splitByDestination must receive the hoisted clock",
    );
    const news = [...RAW.eod.matchAll(/new Date\(\)/g)].length;
    assert.equal(
      news,
      2,
      `the script mints ${news} Dates; expected exactly 2 — the hoisted run ` +
        "clock and the checkpoint's `at`. Any other is a per-symbol clock.",
    );
  });

  it("core's constant is what the script's log line reports", () => {
    // Cheap, and it proves the import is USED rather than merely present.
    assert.ok(HOT_WINDOW_YEARS > 0);
    assert.equal(
      hotWindowFloorYear(new Date("2026-06-15T00:00:00Z")),
      2026 - HOT_WINDOW_YEARS,
    );
    assert.match(RAW.eod, /hotWindow=\$\{hotWindowFloorYear\(now\)\}/);
    assert.doesNotMatch(
      RAW.eod,
      /currentYear - HOT_WINDOW_YEARS/,
      "the floor must come from core's helper, not be recomputed inline",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A circuit-break must reach the EXIT CODE, in all three
// ───────────────────────────────────────────────────────────────────────────

describe("a stopped run exits NON-ZERO", () => {
  it("every script parks the reason and exits 1 rather than logging and moving on", () => {
    // A Cloud Run Job reports SUCCEEDED on exit 0. A walk that hit the daily
    // cap three days into ninety has checkpointed real work — so it is not a
    // failure in the "nothing happened" sense — but a wrapper reading only the
    // exit code must not read it as a completed backfill.
    //
    // `tiingo-us-news-seed.ts` was exactly this bug: it logged the stop and
    // `break`, with no exit code anywhere but `main().catch()`.
    for (const [name, src] of Object.entries(RAW)) {
      assert.match(
        src,
        /let stop(ped)?: string \| null = null;/,
        `${name} has no parked stop reason`,
      );
      // The stop now reaches the exit code through the SHARED judge rather
      // than a local `if`. The property is unchanged and wider: a
      // circuit-break is still non-zero, and so is a run that attempted work
      // and had nothing succeed — a night where the upstream 500s every
      // request used to record ~72,685 ERROR checkpoints and exit 0.
      assert.match(
        src,
        /judgeBackfillOutcome\(\{[\s\S]{0,200}?stopped/,
        `${name} does not feed its stop reason to the exit-code judge`,
      );
      assert.match(
        src,
        /process\.exitCode = verdict\.exitCode;/,
        `${name} computes a verdict but never applies it to the exit code`,
      );
    }
  });

  it("the rate-limit arm covers the DAILY CAP without a second arm", () => {
    // `TiingoDailyCapError extends TiingoRateLimitError` in tiingo-pacer.ts, so
    // one `instanceof` catches both. Asserted because the alternative — a
    // separate arm, or a generic catch above the typed ones — is how a cap
    // becomes a counted transport failure and the run tears on.
    for (const [name, src] of Object.entries(RAW)) {
      const rateAt = src.indexOf("err instanceof TiingoRateLimitError");
      assert.ok(rateAt > 0, `${name} has no rate-limit arm`);
      // The typed arms must come FIRST in their catch. A generic
      // `status = "ERROR"` before them would swallow the cap.
      const catchAt = src.lastIndexOf("} catch (err) {", rateAt);
      const genericAt = src.indexOf('status = "ERROR";', catchAt);
      assert.ok(
        genericAt > rateAt,
        `${name} handles a generic error before the rate-limit arm — the cap ` +
          "would be counted as a transport failure and the run would continue",
      );
    }
  });
});

describe("the historical fund-NAV writer carries the whole bar", () => {
  // WHY THIS EXISTS. `writeFundNavs` in the EOD backfill wrote only
  // `{ permaTicker, symbol, date, nav, source }` while the `EodBar` it was
  // handed also carried `divCash` and `splitFactor` — the equity branch six
  // lines below passed both through, the fund branch dropped them.
  //
  // It is the ONLY writer of historical fund NAVs: the nightly leg runs a
  // trailing window of at most MAX_LOOKBACK_DAYS (30) and can never revisit
  // 2018. So anything dropped here is dropped permanently.
  //
  // For `splitFactor` that is not a gap but a WRONG ANSWER. The column is
  // SPARSE and absent means exactly "no split", so a dropped factor turns
  // FCNTX 2018-08-10 (10-for-1, NAV 138.17 -> 13.73) into a 90% one-day
  // collapse indistinguishable from a real one.
  //
  // The existing guard could not catch it: the `splitFactor` source scan in
  // workers/__tests__/processors/us-eod-sync-logic.test.ts iterates exactly
  // ["us-eod-sync-logic.ts", "us-eod-sync.ts"] and never reads this script.

  const fundWriter = (): string => {
    const at = RAW.eod.indexOf("async function writeFundNavs(");
    assert.ok(at > 0, "writeFundNavs is gone — this guard is scanning nothing");
    // `\n}` alone is WRONG here: the signature destructures its argument, so
    // `}: Promise<number> {` puts a closing brace at column 0 BEFORE the body
    // and the extract came out 111 characters long — a scan over which passes
    // or fails for reasons unrelated to the code. Require the newline after it.
    const end = RAW.eod.indexOf("\n}\n", at);
    assert.ok(end > at, "could not bound writeFundNavs");
    const seg = RAW.eod.slice(at, end);
    assert.ok(
      seg.includes("prisma.usFundNav.upsert("),
      "the extract does not contain the upsert — this guard is scanning the wrong region",
    );
    return seg;
  };

  it("writes divCash in BOTH the create and the update", () => {
    const src = fundWriter();
    assert.equal(
      (src.match(/divCash/g) ?? []).length >= 2,
      true,
      "divCash must appear in create AND update — create-only freezes the " +
        "first-seen 0 permanently, and Tiingo publishes the NAV before the " +
        "distribution settles, so the first write of a payout date is routinely 0",
    );
  });

  it("writes splitFactor SPARSELY, and unsets rather than omits on update", () => {
    const src = fundWriter();
    assert.match(
      src,
      /\.\.\.\(isRealSplit\([^)]*\)/,
      "create must SPREAD the key so 'no split' is an absent field, not a stored 1.0",
    );
    assert.match(
      src,
      /unset:\s*true/,
      "update must UNSET, not omit — omitting leaves a phantom split for ever",
    );
  });

  it("never open-codes the split threshold", () => {
    // `!== 1` is wrong against live data: AAPL's 2014 seven-for-one arrives as
    // 7.000007000007001. The threshold is imported from core so the nightly and
    // the backfill cannot disagree about whether a field exists.
    assert.doesNotMatch(
      fundWriter(),
      /splitFactor\s*[!=]==?\s*1\b/,
      "compare via isRealSplit, never against the literal 1",
    );
    assert.match(
      RAW.eod,
      /import \{[^}]*isRealSplit[^}]*\} from "@usemoney\/core\/market-data\/candles\/candle-logic"/s,
      "isRealSplit must be imported from core, not re-declared",
    );
  });
});
