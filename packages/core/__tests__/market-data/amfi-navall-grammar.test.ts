/**
 * NAVAll layout changes must be survivable, and must be LOUD — MONEY-1403.
 *
 * On or about 2026-08-19 AMFI inserted two columns, `Plan` and `Option`,
 * between `Scheme Name` and `Net Asset Value`:
 *
 * ```
 * WAS  Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 * NOW  Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date
 * ```
 *
 * Two parsers read the NAV out of `parts[4]`. `amfi-mf-provider.parseAmfiFeed`
 * therefore read `"Direct Plan"`, got `NaN`, skipped every row, returned `[]`,
 * and `mf-sync` reported `parsed=0, upserted=0, failed=0` at exit 0 for **26
 * consecutive nights** — 14,225 funds frozen at 2026-08-18, no monitor able to
 * tell a moved column from an empty feed. `amfi-scheme-bridge.parseNavAllGroups`
 * held the same grammar and broke the same day, but broke LOUDLY (every row
 * failed its width check, so it returned `null`), which is why one sibling job
 * logged "the feed grammar changed" and nothing else did.
 *
 * So there are two properties to pin here, and the second is the one that was
 * actually missing:
 *
 *   1. The parser reads BOTH layouts correctly, by header NAME.
 *   2. A layout it CANNOT read is reported as unreadable — never as empty.
 *
 * ## Why the equivalence fixture is synthesised in-test
 *
 * `NAVAll.trimmed.txt` (6-column, 2026-08-14) and `NAVAll.2026-09.trimmed.txt`
 * (8-column, 2026-09-13) are both verbatim captures, and each proves the parser
 * handles bytes AMFI really served. Neither can prove the two layouts yield the
 * SAME answer, because they are different slices of different days.
 *
 * So the equivalence case widens the 6-column fixture ROW BY ROW inside the
 * test. Same schemes, same NAVs, same dates, two layouts — the only variable is
 * the column positions, which is the only thing under test. A committed
 * "expected" file could drift from the fixture it was generated from; this
 * cannot.
 *
 * MUTATION (run for each assertion marked MUT): revert
 * `amfi-scheme-bridge.parseNavAllGroups` to the positional reads it had before
 * this ticket — `parts[4]` for the NAV, `parts[5]` for the date, and
 * `parts.length !== 6` for the width — and every 8-column case below goes red.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseNavAllGroups,
  parseNavAllHeader,
  type NavAllFile,
  type NavAllScheme,
} from "../../src/market-data/amfi-scheme-bridge";
import {
  AmfiNavGrammarError,
  parseAmfiFeed,
} from "../../src/market-data/instruments/amfi-mf-provider";

const fixture = (name: string): string =>
  readFileSync(
    join(import.meta.dirname, "..", "fixtures", "amfi-navall", name),
    "utf8",
  );

/** 2026-08-14 capture — the SIX-column layout. */
const SIX_COL = fixture("NAVAll.trimmed.txt");
/** 2026-09-13 capture — the EIGHT-column layout AMFI serves today. */
const EIGHT_COL = fixture("NAVAll.2026-09.trimmed.txt");

const allSchemes = (file: NavAllFile): NavAllScheme[] =>
  file.groups.flatMap((g) => [...g.schemes]);

/**
 * Widen a six-column capture to the eight-column layout, verbatim otherwise.
 *
 * Header and data rows only — separator, section and AMC lines carry no
 * semicolon and are passed through untouched, which is also what the parser
 * must do.
 */
function widenToEightColumns(text: string): string {
  return text
    .split(/\r\n|\n/)
    .map((line) => {
      if (!line.includes(";")) return line;
      const parts = line.split(";");
      if (parts.length !== 6) return line;
      const isHeader = /^Scheme\s+Code\s*;/i.test(line.trim());
      const inserted = isHeader
        ? ["Plan", "Option"]
        : ["Direct Plan", "Growth Option"];
      return [...parts.slice(0, 4), ...inserted, ...parts.slice(4)].join(";");
    })
    .join("\r\n");
}

describe("NAVAll — the layout is read from the header, not from positions", () => {
  it("parses the EIGHT-column layout AMFI serves today", () => {
    // MUT: positional `parts[4]` -> every row fails the width check -> null.
    const file = parseNavAllGroups(EIGHT_COL);
    assert.notEqual(file, null, "the live layout must parse");

    const schemes = allSchemes(file!);
    assert.ok(
      schemes.length > 100,
      `expected the fixture's rows, got ${schemes.length}`,
    );

    // The whole defect in one assertion: the NAV must be a number, not the
    // string that now sits where the NAV used to be.
    const priced = schemes.filter((s) => s.nav !== null);
    assert.equal(
      priced.length,
      schemes.length,
      "every row in this capture carries a NAV",
    );
    for (const s of priced) {
      assert.equal(typeof s.nav, "number");
      assert.ok(
        Number.isFinite(s.nav!) && s.nav! > 0,
        `NAV must be a positive finite number, got ${s.nav} for ${s.schemeCode}`,
      );
    }

    // And the date must come from the DATE column, not from `Option`.
    for (const s of schemes) {
      assert.match(
        s.navDate ?? "",
        /^\d{4}-\d{2}-\d{2}$/,
        `navDate must be YYYY-MM-DD, got ${s.navDate} for ${s.schemeCode}`,
      );
    }
  });

  it("still parses the SIX-column layout, with plan/option absent", () => {
    const file = parseNavAllGroups(SIX_COL);
    assert.notEqual(file, null);

    const schemes = allSchemes(file!);
    assert.ok(schemes.length > 100);
    // `null` means the COLUMN did not exist — distinct from `""`, which would
    // mean AMFI published the column and left the cell blank.
    assert.ok(
      schemes.every((s) => s.plan === null && s.option === null),
      "a six-column file has no plan/option columns to read",
    );
  });

  it("reads the same schemes, NAVs and dates from both layouts", () => {
    // MUT: positional reads -> the widened text yields null -> this throws.
    const narrow = parseNavAllGroups(SIX_COL);
    const widened = parseNavAllGroups(widenToEightColumns(SIX_COL));
    assert.notEqual(narrow, null);
    assert.notEqual(widened, null);

    const a = allSchemes(narrow!);
    const b = allSchemes(widened!);
    assert.equal(b.length, a.length, "widening must not drop or add a row");

    for (let i = 0; i < a.length; i++) {
      const x = a[i]!;
      const y = b[i]!;
      assert.equal(y.schemeCode, x.schemeCode);
      assert.equal(y.schemeName, x.schemeName);
      assert.equal(y.nav, x.nav, `NAV differs for ${x.schemeCode}`);
      assert.equal(y.navDate, x.navDate, `date differs for ${x.schemeCode}`);
      assert.equal(y.isinGrowth, x.isinGrowth);
      assert.equal(y.isinReinvestment, x.isinReinvestment);
    }

    // The inserted columns are read, not merely tolerated.
    assert.ok(
      b.every((s) => s.plan === "Direct Plan" && s.option === "Growth Option"),
      "the new columns must be captured, not skipped over",
    );
  });

  it("resolves column indices by name, and reports a MISSING required column", () => {
    const eight = parseNavAllHeader(
      "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
    );
    assert.notEqual(eight, null);
    assert.equal(eight!.nav, 6, "NAV is the SEVENTH column in today's layout");
    assert.equal(eight!.navDate, 7);
    assert.equal(eight!.plan, 4);
    assert.equal(eight!.option, 5);
    assert.equal(eight!.width, 8);

    const six = parseNavAllHeader(
      "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
    );
    assert.notEqual(six, null);
    assert.equal(six!.nav, 4, "NAV was the FIFTH column before 2026-08");
    assert.equal(six!.plan, null);
    assert.equal(six!.width, 6);

    // Case and internal whitespace vary in the live header — the live file
    // really does carry `ISIN Div Payout/ ISIN Growth` with that stray space.
    assert.notEqual(
      parseNavAllHeader(
        "scheme  code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;SCHEME NAME;Net Asset Value;date",
      ),
      null,
      "header matching must be case- and whitespace-insensitive",
    );
  });
});

describe("NAVAll — an unreadable feed is never reported as an empty one", () => {
  it("returns null when a REQUIRED column is gone from the header", () => {
    // MUT: drop the `badHeader` guard in parseNavAllGroups -> returns a file.
    const mangled = EIGHT_COL.replace("Net Asset Value", "Nav Value");
    assert.equal(
      parseNavAllHeader(mangled.split(/\r\n|\n/)[0]!),
      null,
      "a header missing the NAV column cannot be resolved",
    );
    assert.equal(
      parseNavAllGroups(mangled),
      null,
      "and the file as a whole must be unreadable, not partially parsed",
    );
  });

  it("returns null for an error page served with a 200", () => {
    assert.equal(
      parseNavAllGroups("<html><body>Forbidden</body></html>"),
      null,
    );
    assert.equal(parseNavAllGroups(""), null);
  });

  it("parseAmfiFeed THROWS rather than returning [] on unreadable bytes", () => {
    // This is the assertion the outage turned on. Returning `[]` here is what
    // let `mf-sync` report success 26 nights running.
    // MUT: replace the throw with `return []` -> this goes red.
    assert.throws(
      () => parseAmfiFeed("<html>nope</html>"),
      AmfiNavGrammarError,
      "unreadable bytes must be a named failure, not an empty result",
    );
  });
});

describe("parseAmfiFeed maps the live layout onto the NAV sync's shape", () => {
  it("prices every scheme from the eight-column capture", () => {
    // MUT: positional reads in the bridge -> parseAmfiFeed throws (file null).
    const funds = parseAmfiFeed(EIGHT_COL);
    assert.ok(
      funds.length > 100,
      `expected the fixture's schemes, got ${funds.length}`,
    );

    for (const f of funds) {
      assert.ok(
        Number.isFinite(f.nav) && f.nav > 0,
        `NAV must be positive and finite, got ${f.nav} for ${f.schemeCode}`,
      );
      assert.ok(
        f.navDate instanceof Date && !isNaN(f.navDate.getTime()),
        `navDate must be a valid Date for ${f.schemeCode}`,
      );
      assert.ok(f.schemeCode.length > 0);
      assert.ok(f.schemeName.length > 0);
      // MONEY-1198: a section header must never end up as the AMC.
      assert.doesNotMatch(
        f.amcName,
        /Schemes?\(/,
        `section name leaked into amcName for ${f.schemeCode}`,
      );
    }
  });

  it("keeps navDate at LOCAL midnight, as this sync has always written it", () => {
    // `new Date("11-Sep-2026")` is local midnight; `new Date("2026-09-11")` is
    // UTC midnight — 5.5 h apart in IST, on every one of ~14,000 rows. The
    // repaired parser hands back a `YYYY-MM-DD` string, so the mapping rebuilds
    // the Date from its PARTS deliberately. Normalising this is a separate
    // change; silently shifting it inside a parser repair is not.
    //
    // ## Why the zone is FORCED here rather than observed
    //
    // `getHours() === 0` alone was this assertion for one review cycle, and it
    // could only ever be red on a developer laptop. Under `TZ=UTC` — which is
    // every GitHub runner, and no workflow, turbo task or package script pins
    // `TZ` — local midnight IS UTC midnight, so `new Date(y, m-1, d)` and
    // `new Date("YYYY-MM-DD")` are the SAME INSTANT and no property of the
    // resulting Date can tell them apart. That is a fact about the zone, not
    // about the assertion: an "explicit epoch" literal is equally blind,
    // because local midnight's epoch is itself zone-dependent.
    //
    // So the zone is set per iteration and the expectation is an epoch stated
    // OUTRIGHT for each one, rather than recomputed with the constructor under
    // test. Same pattern, and the same reasoning, as the TZ sweep in
    // tiingo-budget.test.ts.
    //
    // This is also self-guarding against `process.env.TZ` being ignored: if it
    // were, the Asia/Kolkata iteration would produce the UTC instant and miss
    // its literal — red, not a silent pass.
    //
    // MUT: `new Date(scheme.navDate)` instead of the parts -> red under
    // Asia/Kolkata in ANY runner zone, including UTC.
    const saved = process.env.TZ;
    try {
      // The fixture's first data row is
      // `135762;...;Axis Children's Fund;Direct Plan;Growth Option;29.9628;11-Sep-2026`.
      for (const [tz, iso] of [
        ["UTC", "2026-09-11T00:00:00.000Z"],
        ["Asia/Kolkata", "2026-09-10T18:30:00.000Z"], // 00:00 IST on the 11th
      ] as const) {
        process.env.TZ = tz;
        const sample = parseAmfiFeed(EIGHT_COL)[0]!;
        assert.equal(
          sample.navDate.toISOString(),
          iso,
          `TZ=${tz}: navDate must be LOCAL midnight of the feed's own date`,
        );
        assert.equal(sample.navDate.getHours(), 0, `TZ=${tz}`);
        assert.equal(sample.navDate.getMinutes(), 0, `TZ=${tz}`);
        assert.equal(sample.navDate.getSeconds(), 0, `TZ=${tz}`);
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it("nulls a junk ISIN instead of storing it", () => {
    // The bridge nulls by ISIN SHAPE where this parser nulled only a literal
    // `-`. Measured on the live feed 2026-09-13: `isinGrowth` unchanged on all
    // 14,361 rows; `isinDividend` newly null on 10, whose only two distinct
    // values are `HDFCNIVODG` (a ticker) and `Redeemed` (a status word).
    const funds = parseAmfiFeed(
      [
        "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
        " ",
        "Open Ended Schemes(Growth)",
        " ",
        "Test Mutual Fund",
        " ",
        "999001;INF123A01AB9;Redeemed;Test Scheme - Direct Growth;Direct Plan;Growth Option;10.5;11-Sep-2026",
      ].join("\r\n"),
    );
    assert.equal(funds.length, 1);
    assert.equal(funds[0]!.isinGrowth, "INF123A01AB9");
    assert.equal(
      funds[0]!.isinDividend,
      null,
      "`Redeemed` is a status word, not an ISIN",
    );
  });
});

describe("MONEY-1405 — no recognised header means no rows, ever", () => {
  /** A real section line: the live feed writes `Schemes(` with no space. */
  const BODY = [
    "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
    "SBI Mutual Fund",
    "119598;INF200K01VT2;INF200K01VU0;SBI Bluechip;95.5;11-Sep-2026",
  ].join("\n");

  it("a headerless file is refused even when it carries a section line", () => {
    // The old guard was `!sawColumnHeader && sections.length === 0`, and the
    // live feed carries dozens of section lines — so that conjunction was false
    // on every real input and a headerless file parsed through a FIXED
    // positional layout.
    //
    // The enforcement is at the ROW (`columns === null` rejects it), not at a
    // header-level guard: restoring the old guard alone leaves this GREEN,
    // which is how the replacement header guard was found to be dead and
    // removed. MUTATION: restore the positional fallback -> RED.
    assert.equal(parseNavAllGroups(BODY), null);
  });

  it("an UNRECOGNISED header is refused, not guessed at", () => {
    // MUTATION: restore `columns ?? NAVALL_LEGACY_COLUMNS` -> RED.
    assert.equal(
      parseNavAllGroups(
        `SchemeCode;ISINGrowth;ISINReinv;SchemeName;NAV;Date\n${BODY}`,
      ),
      null,
    );
  });

  it("THE ONE THAT MATTERS: a REORDERED header is never read by position", () => {
    // Six columns, named in a different order, with the header spelled so the
    // detector misses it. The positional layout read field 0 as the scheme code
    // while the header said field 0 was the DATE — and reported success.
    // Silent, confident and wrong: the 26-night outage, rebuilt as a fallback.
    // MUTATION: restore the positional fallback -> this returns a scheme whose
    // `schemeCode` is "119598" read from the wrong column, RED.
    const reordered =
      "Date;Net Asset Value;Scheme Name;ISIN Div Reinvestment;ISIN Div Payout/ISIN Growth;Scheme Code";
    assert.equal(parseNavAllGroups(`${reordered}\n${BODY}`), null);
  });

  it("the current 8-column feed is untouched", () => {
    // The guard must refuse a guess, not the real thing.
    const header =
      "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date";
    const row =
      "119598;INF200K01VT2;INF200K01VU0;SBI Bluechip;Direct Plan;Growth;95.5;11-Sep-2026";
    const file = parseNavAllGroups(
      `${header}\nOpen Ended Schemes(Equity Scheme - Large Cap Fund)\nSBI Mutual Fund\n${row}`,
    );
    assert.ok(file, "the live grammar must still parse");
    assert.equal(file.schemeCount, 1);
  });

  it("a THIRD spacing of the ISIN header does not kill the feed", () => {
    // `ISIN Div Payout / ISIN Growth` — a space before the slash as well as
    // after. The alias list carried two hand-typed spellings and this third one
    // made `parseNavAllHeader` return null, which makes the WHOLE FEED
    // unreadable: AmfiNavGrammarError, mf-sync throws, no NAVs for the night.
    // One stray space is not a grammar change.
    // MUTATION: drop the slash normalisation from normaliseHeaderCell -> RED.
    for (const isin of [
      "ISIN Div Payout/ ISIN Growth",
      "ISIN Div Payout / ISIN Growth",
      "ISIN Div Payout/ISIN Growth",
      "ISIN Div Payout  /  ISIN Growth",
    ]) {
      const header = `Scheme Code;${isin};ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date`;
      const row =
        "119598;INF200K01VT2;INF200K01VU0;SBI Bluechip;Direct Plan;Growth;95.5;11-Sep-2026";
      const file = parseNavAllGroups(
        `${header}\nOpen Ended Schemes(Equity Scheme - Large Cap Fund)\nSBI Mutual Fund\n${row}`,
      );
      assert.ok(file, `spacing rejected: ${isin}`);
      assert.equal(file.schemeCount, 1, isin);
    }
  });
});
