/**
 * Bhavcopy → InstrumentMapping metadata backfill (MONEY-1093).
 *
 * `series` was uniformly the stamped default "EQ" on all 22,090 active rows and
 * `isin` was populated on ZERO of them. Those are exactly the two fields that
 * distinguish EQUITY from DEBT — and the bhavcopy has carried both, daily,
 * since MONEY-851. The worker parsed them into `BhavcopyRow` and used them only
 * to mint REIT/InvIT rows.
 *
 * `planMetadataBackfill` is the pure decision of what to write. It is tested
 * here rather than through the worker because the interesting properties are
 * all about WHICH writes are planned:
 *
 *   - only CHANGES (so the daily run is a no-op on a settled universe)
 *   - ISIN written only when ABSENT, never overwritten — `DailyPrice` has no
 *     exchange column, so a repointed instrument writes prices onto the wrong
 *     listing (the MONEY-1085 failure)
 *   - grouped by series so it is one updateMany per distinct value, not per row
 *
 * Source: workers/src/processors/bhavcopy-sync-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

/**
 * Repo root, found by walking up from cwd until `turbo.json` appears.
 *
 * Neither cwd nor `import.meta.dirname` is safe here. A cwd-relative path breaks
 * when the suite runs from the repo root instead of the workspace; and
 * `import.meta.dirname` is undefined under this workspace's module target, which
 * threw inside the describe callback — and node reports a thrown describe body as
 * a dropped suite with `fail 0` and exit 0, so the guard silently vanished (32
 * cases became 29, green). Walking to a known marker works from any cwd under
 * any module format.
 */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "yarn.lock"))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(process.cwd());
}

/**
 * Read a repo-relative source file. Returns "" instead of throwing, so a moved
 * or renamed file FAILS an explicit assertion rather than deleting the suite.
 */
function readRepoFile(...parts: string[]): string {
  const full = join(repoRoot(), ...parts);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

import {
  planMetadataBackfill,
  BACKFILL_TYPES,
  DEFAULT_INSTRUMENT_TYPE,
  buildTypeWriteData,
  isHistoricalRun,
  type StoredInstrumentMeta,
} from "../../../../workers/src/processors/bhavcopy-sync-logic";

function row(instrumentId: string, series: string, isin: string | null = null) {
  return { instrumentId, series, isin };
}
function stored(
  id: string,
  series: string | null,
  isin: string | null = null,
  instrumentType: string | null = "EQUITY"
): StoredInstrumentMeta {
  return { id, series, isin, instrumentType };
}
/** A row carrying the classification inputs as well. */
function typedRow(
  instrumentId: string,
  series: string,
  exchange: "NSE" | "BSE",
  symbol = "SOMECO",
  name = symbol
) {
  return { instrumentId, series, isin: null, symbol, name, exchange };
}

describe("planMetadataBackfill — series", () => {
  it("plans a write when the stored series differs", () => {
    const plan = planMetadataBackfill(
      [row("i1", "F")],
      [stored("i1", "EQ")] // the stamped default
    );
    assert.deepEqual([...plan.seriesGroups.entries()], [["F", ["i1"]]]);
  });

  it("plans nothing when the series already matches", () => {
    // The daily run must be a no-op once the universe has settled, or this
    // becomes 22k pointless writes a day.
    const plan = planMetadataBackfill([row("i1", "A")], [stored("i1", "A")]);
    assert.equal(plan.seriesGroups.size, 0);
  });

  it("compares case-insensitively and ignores surrounding space", () => {
    const plan = planMetadataBackfill([row("i1", " a ")], [stored("i1", "A")]);
    assert.equal(plan.seriesGroups.size, 0);
  });

  it("plans a write when the stored series is null", () => {
    const plan = planMetadataBackfill([row("i1", "X")], [stored("i1", null)]);
    assert.deepEqual(plan.seriesGroups.get("X"), ["i1"]);
  });

  it("GROUPS ids by series so the caller issues one updateMany per value", () => {
    // A real day has ~14 distinct groups across ~4,800 rows. One write per row
    // would be 4,800 round trips.
    const plan = planMetadataBackfill(
      [row("i1", "F"), row("i2", "F"), row("i3", "A"), row("i4", "F")],
      [
        stored("i1", "EQ"),
        stored("i2", "EQ"),
        stored("i3", "EQ"),
        stored("i4", "EQ"),
      ]
    );
    assert.equal(plan.seriesGroups.size, 2);
    assert.deepEqual(plan.seriesGroups.get("F"), ["i1", "i2", "i4"]);
    assert.deepEqual(plan.seriesGroups.get("A"), ["i3"]);
  });

  it("does not queue the same instrument twice when a file repeats it", () => {
    const plan = planMetadataBackfill(
      [row("i1", "F"), row("i1", "F")],
      [stored("i1", "EQ")]
    );
    assert.deepEqual(plan.seriesGroups.get("F"), ["i1"]);
  });

  it("ignores an empty series rather than blanking a stored value", () => {
    const plan = planMetadataBackfill([row("i1", "")], [stored("i1", "A")]);
    assert.equal(plan.seriesGroups.size, 0);
  });
});

describe("planMetadataBackfill — ISIN", () => {
  it("plans a write when the instrument has no ISIN", () => {
    const plan = planMetadataBackfill(
      [row("i1", "A", "INE002A01018")],
      [stored("i1", "A", null)]
    );
    assert.deepEqual(plan.isinUpdates, [{ id: "i1", isin: "INE002A01018" }]);
  });

  it("NEVER overwrites an existing ISIN, even a different one", () => {
    // The exchange file is authoritative for a NEW value, but silently
    // rewriting an existing ISIN lets one bad file repoint a security — and
    // DailyPrice has no exchange column, so a repointed instrument writes
    // prices onto the wrong listing.
    const plan = planMetadataBackfill(
      [row("i1", "A", "INE999Z01099")],
      [stored("i1", "A", "INE002A01018")]
    );
    assert.equal(plan.isinUpdates.length, 0);
  });

  it("treats an empty stored ISIN as absent", () => {
    const plan = planMetadataBackfill(
      [row("i1", "A", "INE002A01018")],
      [stored("i1", "A", "")]
    );
    assert.equal(plan.isinUpdates.length, 1);
  });

  it("upper-cases and trims the incoming ISIN", () => {
    const plan = planMetadataBackfill(
      [row("i1", "A", " ine002a01018 ")],
      [stored("i1", "A", null)]
    );
    assert.equal(plan.isinUpdates[0]!.isin, "INE002A01018");
  });

  it("ignores a blank incoming ISIN", () => {
    const plan = planMetadataBackfill(
      [row("i1", "A", "")],
      [stored("i1", "A", null)]
    );
    assert.equal(plan.isinUpdates.length, 0);
  });

  it("does not queue the same instrument twice", () => {
    const plan = planMetadataBackfill(
      [row("i1", "A", "INE002A01018"), row("i1", "A", "INE002A01018")],
      [stored("i1", "A", null)]
    );
    assert.equal(plan.isinUpdates.length, 1);
  });
});

describe("planMetadataBackfill — rows we cannot act on", () => {
  it("skips an instrument that is not in the stored set", () => {
    // Resolution can hand us an id that vanished between the two queries.
    const plan = planMetadataBackfill([row("ghost", "F", "INE1")], []);
    assert.equal(plan.seriesGroups.size, 0);
    assert.equal(plan.isinUpdates.length, 0);
  });

  it("returns an empty plan for no rows", () => {
    const plan = planMetadataBackfill([], [stored("i1", "EQ")]);
    assert.equal(plan.seriesGroups.size, 0);
    assert.equal(plan.isinUpdates.length, 0);
  });

  it("plans both a series and an ISIN write for the same instrument", () => {
    const plan = planMetadataBackfill(
      [row("i1", "F", "INE7")],
      [stored("i1", "EQ", null)]
    );
    assert.deepEqual(plan.seriesGroups.get("F"), ["i1"]);
    assert.equal(plan.isinUpdates.length, 1);
  });
});

describe("planMetadataBackfill — instrumentType", () => {
  // NOTE ON REACHABILITY. The NSE cases below pin the PLANNER's contract given
  // a debt series — they do NOT describe a reachable production path.
  // `parseUdiffBhavcopy` applies `keepSeries` at parse time and the NSE branch
  // keeps only NSE_CASH_SERIES, so a BhavcopyRow carrying GS/TB/SG or an
  // N*/Y*/Z* series cannot exist. Feeding one here is a unit contract, and
  // calling that out matters: an earlier version of this file presented these
  // as proof that "both exchanges are covered", which is exactly the shadow
  // class — a green test asserting a capability the pipeline cannot deliver.
  // The BSE cases ARE end-to-end reachable.
  it("types an NSE bond from its two-character series", () => {
    const plan = planMetadataBackfill(
      [typedRow("i1", "GS", "NSE", "EPDPGSEC28")],
      [stored("i1", "EQ")]
    );
    assert.deepEqual(plan.typeGroups.get("DEBT"), ["i1"]);
  });

  it("types an NSE bond from a churning debt FAMILY (N*/Y*/Z*)", () => {
    const plan = planMetadataBackfill(
      [typedRow("i1", "N7", "NSE", "885PFL31")],
      [stored("i1", "EQ")]
    );
    assert.deepEqual(plan.typeGroups.get("DEBT"), ["i1"]);
  });

  it("types a BSE bond from its group letter", () => {
    // The other exchange, the other signal. F = corporate debt, G = G-Secs.
    for (const g of ["F", "G"]) {
      const plan = planMetadataBackfill(
        [typedRow("i1", g, "BSE", "0795GOI32")],
        [stored("i1", "EQ")]
      );
      assert.deepEqual(plan.typeGroups.get("DEBT"), ["i1"], `group ${g}`);
    }
  });

  // "16 real consumers" was asserted here with no enumeration anywhere in the
  // source. Measured: 23 non-test references branch on `instrumentType === "ETF"`,
  // including a dedicated `/etf/[symbol]` page that QUERIES on it — so typing an
  // ETF is load-bearing for a shipped feature, not just tidiness.
  //
  // The count that was missing is the other side: 32 sites allowlist "EQUITY",
  // and three of them are user-facing pickers that silently lost the retyped
  // symbols (watchlist add-symbol, paper-trading picker, and the search dedupe
  // they both feed). The first two now accept ETF; the screener's stocks mode
  // still excludes it deliberately, since fundamental screening on an ETF is
  // meaningless.
  it("types an ETF (23 consumers branch on the type, incl. /etf/[symbol])", () => {
    const plan = planMetadataBackfill(
      [
        typedRow(
          "i1",
          "EQ",
          "NSE",
          "NIFTYBEES",
          "Nippon India ETF Nifty 50 BeES"
        ),
      ],
      [stored("i1", "EQ")]
    );
    assert.deepEqual(plan.typeGroups.get("ETF"), ["i1"]);
  });

  it("plans NOTHING once the row has moved off the default — the one-time property", () => {
    // The whole guard. A row already classified can never be selected again,
    // so the daily run converges and then no-ops.
    for (const t of ["DEBT", "ETF", "REIT", "INVIT", "FUTURES"]) {
      const plan = planMetadataBackfill(
        [typedRow("i1", "GS", "NSE")],
        [stored("i1", "EQ", null, t)]
      );
      assert.equal(plan.typeGroups.size, 0, `must not overwrite ${t}`);
    }
  });

  it("treats an absent stored type as the default", () => {
    const plan = planMetadataBackfill(
      [typedRow("i1", "GS", "NSE")],
      [stored("i1", "EQ", null, null)]
    );
    assert.deepEqual(plan.typeGroups.get("DEBT"), ["i1"]);
  });

  it("never plans EQUITY — that is what the row already says", () => {
    const plan = planMetadataBackfill(
      [typedRow("i1", "EQ", "NSE", "RELIANCE")],
      [stored("i1", "EQ")]
    );
    assert.equal(plan.typeGroups.size, 0);
  });

  it("never plans a write on an ABSTENTION", () => {
    // An unrecognised series/group is "no information", not "therefore debt".
    // Retyping on a guess is how 2,200 bonds acquired a sector.
    //
    // NOTE the explicit `name` on every row. `typedRow` defaults `name = symbol`
    // for convenience, and MONEY-1298 made "Kite repeated the instrument code in
    // both fields" the POSITIVE signal that a stamped-default BSE row is a bond
    // — so the default silently supplied the very evidence these cases assert
    // the absence of. A distinct name is what a real company looks like, and it
    // is the whole reason that rule spares TEMPSENS, NOVYRA and ~43 others in
    // the same population.
    for (const [series, exchange] of [
      ["QQ", "NSE"],
      ["Q", "BSE"],
      ["EQ", "BSE"], // the stamped default on BSE — never a real group
      ["", "NSE"],
    ] as Array<[string, "NSE" | "BSE"]>) {
      const plan = planMetadataBackfill(
        [typedRow("i1", series, exchange, "SOMECO", "Some Company Ltd")],
        [stored("i1", "ZZ")]
      );
      assert.equal(
        plan.typeGroups.size,
        0,
        `series "${series}" on ${exchange} must abstain`
      );
    }
  });

  it("DOES type a stamped-default BSE row whose name repeats its code (MONEY-1298)", () => {
    // The other half of the case above, and the reason it needed disambiguating
    // rather than relaxing: BSE + stamped-default group + no ISIN + `name`
    // identical to `symbol` is 5,288 of 5,392 rows measured on prod, all debt
    // (1020NFL27, 778JCL29). ISIN-absence alone is only a GATE — this is the
    // positive signal, and without it the rule would type ~45 real companies.
    const plan = planMetadataBackfill(
      [typedRow("i1", "EQ", "BSE", "1020NFL27", "1020NFL27")],
      [stored("i1", "EQ")]
    );
    assert.equal(plan.typeGroups.size, 1, "a bond-shaped BSE code must type");
    assert.ok(
      [...plan.typeGroups.keys()].includes("DEBT"),
      `expected a DEBT group, got ${[...plan.typeGroups.keys()].join(", ")}`
    );
  });

  it("does NOT write REIT or INVIT", () => {
    // Every news/filings/announcement/financial-data sync gates on
    // instrumentType EQUITY, so typing a held trust drops its coverage.
    const plan = planMetadataBackfill(
      [
        typedRow("i1", "RR", "NSE", "BIRET"),
        typedRow("i2", "IV", "NSE", "PGINVIT"),
      ],
      [stored("i1", "EQ"), stored("i2", "EQ")]
    );
    assert.equal(plan.typeGroups.size, 0);
    assert.ok(!BACKFILL_TYPES.has("REIT"));
    assert.ok(!BACKFILL_TYPES.has("INVIT"));
  });

  it("plans nothing when the row carries no classification inputs", () => {
    // Back-compat: an existing caller passing only series/isin gets the old
    // behaviour rather than a classification built on absent data.
    const plan = planMetadataBackfill(
      [{ instrumentId: "i1", series: "GS", isin: null }],
      [stored("i1", "EQ")]
    );
    assert.equal(plan.typeGroups.size, 0);
  });

  it("GROUPS ids by type — one updateMany per type", () => {
    const plan = planMetadataBackfill(
      [
        typedRow("i1", "GS", "NSE", "B1"),
        typedRow("i2", "F", "BSE", "B2"),
        typedRow("i3", "EQ", "NSE", "NIFTYBEES", "Nippon India ETF Nifty"),
      ],
      [stored("i1", "EQ"), stored("i2", "EQ"), stored("i3", "EQ")]
    );
    assert.deepEqual(plan.typeGroups.get("DEBT"), ["i1", "i2"]);
    assert.deepEqual(plan.typeGroups.get("ETF"), ["i3"]);
  });

  it("does not queue the same instrument twice", () => {
    const plan = planMetadataBackfill(
      [typedRow("i1", "GS", "NSE"), typedRow("i1", "GS", "NSE")],
      [stored("i1", "EQ")]
    );
    assert.deepEqual(plan.typeGroups.get("DEBT"), ["i1"]);
  });

  it("exposes the default so the applier's WHERE guard cannot drift", () => {
    assert.equal(DEFAULT_INSTRUMENT_TYPE, "EQUITY");
  });
});

describe("buildTypeWriteData — clears sector for DEBT and ONLY for DEBT", () => {
  // Previously asserted by regex-matching object literals in the source. That
  // was defeatable by HOISTING the condition: a refactor making the clear
  // unconditional kept the test green, on an unattended destructive write with
  // no rollback file. Now it is a real call.
  it("clears sector and industry for DEBT", () => {
    assert.deepEqual(buildTypeWriteData("DEBT"), {
      instrumentType: "DEBT",
      sector: null,
      industry: null,
    });
  });

  it("does NOT clear them for ETF — an ETF legitimately has a sector", () => {
    assert.deepEqual(buildTypeWriteData("ETF"), { instrumentType: "ETF" });
  });

  it("does not clear them for ANY non-DEBT type", () => {
    for (const t of ["ETF", "EQUITY", "REIT", "INVIT", "FUTURES", "INDEX"]) {
      const d = buildTypeWriteData(t);
      assert.ok(!("sector" in d), `${t} must not have its sector cleared`);
      assert.ok(!("industry" in d), `${t} must not have its industry cleared`);
    }
  });

  it("never touches series — that is the other loop's field", () => {
    for (const t of ["DEBT", "ETF"]) {
      assert.ok(!("series" in buildTypeWriteData(t)));
    }
  });

  it("always sets the type it was asked for", () => {
    for (const t of ["DEBT", "ETF"]) {
      assert.equal(buildTypeWriteData(t).instrumentType, t);
    }
  });
});

describe("the applier wires that payload in, under the default-type guard", () => {
  const src = readRepoFile("workers", "src", "processors", "bhavcopy-sync.ts");

  it("found the applier source", () => {
    assert.ok(src.length > 0, "could not read bhavcopy-sync.ts");
  });

  it("uses buildTypeWriteData rather than an inline literal", () => {
    assert.match(
      src,
      /data:\s*buildTypeWriteData\(/,
      "an inline literal here is how the branch shape stopped being testable"
    );
  });

  it("guards the write on the row still carrying the stamped default", () => {
    assert.match(src, /instrumentType:\s*DEFAULT_INSTRUMENT_TYPE/);
  });

  it("selects instrumentType so the plan can see the current value", () => {
    assert.match(src, /instrumentType:\s*true/);
  });

  it("passes the classification inputs through to the planner", () => {
    for (const field of ["symbol", "exchange"]) {
      assert.match(src, new RegExp(`${field}:\\s*\\w+\\.row\\.${field}`));
    }
  });
});

describe("the backfill is actually CALLED from the price path", () => {
  // Without this, deleting the call leaves every test above green: they all
  // exercise the planner and the applier, neither of which is reached if the
  // caller stops calling. This is the MONEY-1092 lesson applied to the new code.
  const src = readRepoFile("workers", "src", "processors", "bhavcopy-sync.ts");

  it("found the source", () => {
    assert.ok(src.length > 0);
  });

  it("invokes backfillInstrumentMetadata with the resolved rows and index", () => {
    // Deliberately tolerant of extra arguments — pinning the exact arity broke
    // when the historical-backfill flag was threaded through, which is a
    // behaviour-preserving change as far as this assertion is concerned.
    assert.match(src, /backfillInstrumentMetadata\(\s*resolved\s*,\s*index\b/);
  });

  it("does NOT retype during a historical re-seed", () => {
    // `instrumentType` is CURRENT state. A re-seed of last year's closes must
    // not decide it from last year's series — unattended, no dry run, no
    // rollback file, on a job an operator invokes to fix PRICES.
    assert.match(
      src,
      /isBackfill\s*\?\s*\[\]\s*:\s*plan\.typeGroups/,
      "the typeGroups loop must be skipped when isBackfill is true"
    );
    assert.match(src, /isBackfill/, "the flag must reach the applier");
  });

  it("does NOT overwrite the current series during a historical re-seed", () => {
    // The series is the INPUT to the repair script's destructive decision, so a
    // past file stamping it is how a stale value becomes a permanent retype.
    assert.match(
      src,
      /isBackfill\s*\?\s*\[\]\s*:\s*plan\.seriesGroups/,
      "the seriesGroups loop must be skipped when isBackfill is true"
    );
  });

  it("runs it AFTER the price write, not before", () => {
    // Ordering is load-bearing: the backfill can issue thousands of writes, and
    // running first meant a timeout cost that day's prices entirely.
    const price = src.indexOf("dailyPrice.createMany");
    // Matched on the CALL, not on "…(resolved" — the argument list is wrapped by
    // prettier whenever the call grows, so pinning the first argument made this
    // assertion fail on a pure reformat while the ordering it checks was
    // untouched. Anchor on what the test is actually about.
    const backfill = src.search(/backfillInstrumentMetadata\s*\(/);
    assert.ok(price > 0 && backfill > 0, "both call sites should exist");
    assert.ok(
      backfill > price,
      "metadata backfill must run after the price seed — it is opportunistic, " +
        "prices are the job's purpose"
    );
  });
});

describe("the historical guard is on the axis operators can actually reach", () => {
  const src = readRepoFile("workers", "src", "processors", "bhavcopy-sync.ts");

  it("found the processor source", () => {
    assert.ok(src.length > 0);
  });

  it("derives 'historical' from the resolved DAY, not from a message field", () => {
    // The previous guard keyed off `backfillFrom`/`backfillTo` — and NOTHING in
    // this repo publishes those. The scheduler sends {"includeIndices":true};
    // the documented manual knob is `date`, honoured verbatim with no recency
    // bound. So {"date":"2019-04-01"} had isBackfill === false and a 2019
    // settlement series decided today's instrumentType and cleared sector,
    // unattended, with no rollback file.
    assert.match(
      src,
      /isHistoricalDay\s*=/,
      "the guard must be computed from the day"
    );
    assert.match(
      src,
      /isHistoricalDay\(day\)/,
      "and passed per-day into the ingest"
    );
  });

  it("compares against the AUTO-resolved target, not against today", () => {
    // On a Monday or after a holiday the nightly run legitimately processes
    // Friday's file. A naive `day < today` would call that historical and skip
    // the classification the job exists to do.
    assert.match(src, /resolveTargetDay\(undefined\)/);
  });
});

describe("isHistoricalRun — the predicate, executed", () => {
  /**
   * The guard that decides whether an unattended run performs the destructive
   * retype + sector clear. It was previously an inline arrow covered ONLY by
   * three source-text regexes, which two mutations walked past with all 47 cases
   * green: flipping `!==` to `===`, and replacing the body with `return false`
   * while keeping every token the scan looked for.
   *
   * Keys are IST date strings, which is what the caller derives from a Date via
   * `toIstDateKey` — so these cases are about the COMPARISON, and the IST
   * conversion is exercised where it lives.
   */
  it("is FALSE for the day the scheduler itself would pick", () => {
    // The nightly run: this is when the classification must happen.
    assert.equal(isHistoricalRun("2026-07-30", "2026-07-30"), false);
  });

  it("is TRUE for any other day", () => {
    for (const day of ["2026-07-29", "2019-04-01", "2026-07-31"]) {
      assert.equal(isHistoricalRun("2026-07-30", day), true, day);
    }
  });

  it("does NOT call a Monday run historical", () => {
    // The reason it compares against the AUTO-RESOLVED target rather than
    // "today": on a Monday the nightly run legitimately processes Friday's
    // file, and a naive `day < today` would skip the work the job exists for.
    const fridayKey = "2026-07-24";
    assert.equal(isHistoricalRun(fridayKey, fridayKey), false);
  });

  it("is not fooled by a future date", () => {
    // A wrong-direction comparison (`day < auto`) would call a future day
    // "current" and let it run the destructive path.
    assert.equal(isHistoricalRun("2026-07-30", "2027-01-01"), true);
  });
});
