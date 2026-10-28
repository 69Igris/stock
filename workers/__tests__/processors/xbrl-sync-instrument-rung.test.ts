/**
 * MONEY-1299 — the ISIN leg picked a listing, not a company.
 *
 * ## The defect, as measured on prod 2026-08-30
 *
 * `resolveInstrumentId`'s ISIN leg was
 * `findFirst({ where: { isin }, select: { id: true } })` — no `orderBy`. That
 * spelling asserts "any row bearing this ISIN is the right one", and a dual
 * listing makes it false: ONE company holds TWO `instrument_mappings` rows, one
 * per exchange, both carrying the same ISIN. Over the 2,845 ISINs present in
 * `xbrl_filings`, 2,155 have exactly that pair and the census of row shapes is a
 * single entry — `{"BSE+,NSE+": 2155}`, i.e. NSE-active AND BSE-active, every
 * time.
 *
 * Mongo answered with the BSE row. **79,297 of the 101,288 resolved filings
 * (78.3%), across 2,172 symbols, were attached to the company's BSE listing** —
 * although `xbrl_filings.exchange` is `"NSE"` on all 108,020 rows. 2,148 of the
 * 2,169 BSE instruments so attached have an NSE sibling with the identical ISIN.
 * 163 of those filings landed on a row whose symbol is a DIFFERENT company's
 * (GILLETTE onto `PGHH/BSE`, GLOBOFFS onto `GARWAOFFS/BSE`).
 *
 * Nothing errored, because nothing could: `StockRatios.instrumentId` is
 * `@unique` and `StockFinancials` keys on it, and the BSE id is a perfectly
 * valid distinct value. `xbrl-ratios` reads filings by `instrumentId` and upserts
 * on `(symbol, exchange)`, so from a BSE-attached filing it writes
 * `(SYMBOL, "BSE")` — while all 2,135 incumbent `stock_ratios` rows and all
 * 32,359 `stock_financials` rows are keyed to NSE instruments. No collision, a
 * SECOND row per company, and every reader asking for the NSE listing keeps the
 * stale one.
 *
 * ## Why these assertions are falsifiable
 *
 * The determinism cases assert on the CHOSEN ID against a candidate set that
 * contains a wrong answer, so a resolver that reverts to first-wins picks the
 * BSE row and the assertion fails on a value. They are not literal-vs-literal
 * and they do not restate the ladder's own scoring: the candidate arrays are
 * given in an order that DISAGREES with the expected answer, so an
 * implementation that returns `candidates[0]` — the old behaviour — is red.
 *
 * The functional cases drive the real `storeFiling` against an injected Prisma
 * and read the `instrumentId` off the actual upsert argument, so a resolver that
 * ranks correctly but fails to thread its answer into the write is also red.
 *
 * ## What this ticket does NOT fix, stated so it is not re-opened
 *
 * The 6,732 filings across 275 symbols that carry an ISIN and no `instrumentId`
 * are NOT recoverable by ranking. Bucketed on prod: 6,536 filings over 269
 * symbols have NO row in `instrument_mappings` bearing that ISIN at all
 * (delisted or suspended issuers — RELCAPITAL, JPASSOCIAT, TALWALKARS,
 * TATACOFFEE post-merger), and 196 over 6 symbols match only by SYMBOL on a BSE
 * row whose own ISIN differs. Zero fall into "exists but inactive" or "exists
 * only on BSE", because the ISIN leg never filtered on `isActive` or `exchange`
 * in the first place. They are counted as `unresolvedIsin` instead.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FilingIndexEntry } from "@usemoney/core/market-data";
import { parseXbrlDocument } from "@usemoney/core/market-data";
import {
  rankIsinCandidates,
  storeFiling,
  type InstrumentCandidate,
  type InstrumentResolutionTally,
  type XbrlStoreDeps,
} from "../../src/processors/xbrl-sync";

const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "core",
  "__tests__",
  "fixtures",
  "xbrl",
);

/** RELIANCE — a real dual-listed filer, which is the whole subject here. */
const RELIANCE_XML = readFileSync(
  join(FIXTURES, "bse-reliance-q1fy27-consolidated-indas-2026-01-31.xml"),
  "utf8",
);

/** The two ids a dual-listed company actually has on prod. */
const NSE_ID = "699bc2599c01208e0a7527c9";
const BSE_ID = "699bc1879c01208e0a74f536";

/**
 * The prod shape, given BSE-FIRST — which is the order the unfixed query
 * returned and therefore the order under which "take the first row" is wrong.
 */
const DUAL_LISTED: InstrumentCandidate[] = [
  { id: BSE_ID, exchange: "BSE", isActive: true },
  { id: NSE_ID, exchange: "NSE", isActive: true },
];

interface Upsert {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}

function emptyTally(): InstrumentResolutionTally {
  return { unresolvedIsin: 0, instrumentRungs: {} };
}

/**
 * @param rows what the ISIN lookup answers with. `findFirst` answers the SYMBOL
 *   leg only, and answers `null`, so any resolution observed below came through
 *   the ranked ISIN leg and not through a symbol fallback.
 */
function fakeDb(rows: InstrumentCandidate[]): {
  deps: XbrlStoreDeps;
  upserts: Upsert[];
  isinQueries: unknown[];
} {
  const upserts: Upsert[] = [];
  const isinQueries: unknown[] = [];
  return {
    upserts,
    isinQueries,
    deps: {
      instrumentMapping: {
        findFirst: async () => null,
        findMany: async (args: unknown) => {
          isinQueries.push(args);
          return rows;
        },
      },
      xbrlFiling: {
        upsert: async (args: unknown) => {
          upserts.push(args as Upsert);
          return {};
        },
      },
    },
  };
}

/** An NSE index entry for RELIANCE, carrying the shared dual-listing ISIN. */
function nseEntry(over: Partial<FilingIndexEntry> = {}): FilingIndexEntry {
  return {
    era: "integrated",
    exchange: "NSE",
    symbol: "RELIANCE",
    scripCode: null,
    isin: "INE002A01018",
    xbrlUrl:
      "https://nsearchives.nseindia.com/corporate/xbrl/RELIANCE_q1fy27.xml",
    ixbrlUrl: null,
    basis: "CONSOLIDATED",
    audited: null,
    cumulative: null,
    periodType: null,
    filerKind: "GENERIC",
    quarterEnd: null,
    broadcastAt: null,
    companyName: "RELIANCE INDUSTRIES LIMITED",
    revisionKind: null,
    revisedAt: null,
    createdAt: null,
    indexSequence: null,
    ...over,
  } as FilingIndexEntry;
}

function relianceFinancials() {
  const out = parseXbrlDocument(RELIANCE_XML);
  assert.equal(
    out.kind,
    "financials",
    "fixture must parse, or every assertion below is vacuous",
  );
  return out.financials;
}

// ───────────────────────────────────────────────────────────────────────────
// The ladder itself
// ───────────────────────────────────────────────────────────────────────────

describe("rankIsinCandidates — a filing belongs to a company, not a listing", () => {
  it("prefers the filing's OWN exchange when both listings are active", () => {
    const choice = rankIsinCandidates(DUAL_LISTED, "NSE");
    assert.equal(
      choice?.id,
      NSE_ID,
      "an NSE filing attached to the company's BSE row is how 79,297 of " +
        "101,288 prod filings ended up writing stock_ratios under " +
        '(SYMBOL,"BSE") beside an untouched (SYMBOL,"NSE") incumbent',
    );
    assert.equal(choice?.rung, "isin-own-active");
  });

  it("prefers BSE for a BSE filing — the preference is the FILING's, not a constant", () => {
    const choice = rankIsinCandidates(DUAL_LISTED, "BSE");
    assert.equal(
      choice?.id,
      BSE_ID,
      'hardcoding "prefer NSE" would mis-attach every BSE-sourced filing ' +
        "the same way, one exchange over",
    );
    assert.equal(choice?.rung, "isin-own-active");
  });

  it("resolves when the ISIN is only on a BSE row, and says so", () => {
    const choice = rankIsinCandidates(
      [{ id: BSE_ID, exchange: "BSE", isActive: true }],
      "NSE",
    );
    assert.equal(
      choice?.id,
      BSE_ID,
      "a dual-listed company whose NSE row lacks the ISIN still has exactly " +
        "one company; refusing the BSE row would discard a mapping we hold",
    );
    assert.equal(choice?.rung, "isin-other-active");
  });

  it("resolves an INACTIVE-only row, with the rung recorded", () => {
    const choice = rankIsinCandidates(
      [{ id: NSE_ID, exchange: "NSE", isActive: false }],
      "NSE",
    );
    assert.equal(
      choice?.id,
      NSE_ID,
      "a delisted issuer's row is still the right join target for its " +
        "historical filings",
    );
    assert.equal(
      choice?.rung,
      "isin-own-inactive",
      "the rung is what makes the choice auditable — an inactive match and a " +
        "live one must not report identically",
    );
  });

  it("an ACTIVE other-exchange row outranks an INACTIVE own-exchange row", () => {
    // Given own-exchange-inactive FIRST, so first-wins is the wrong answer.
    const choice = rankIsinCandidates(
      [
        { id: NSE_ID, exchange: "NSE", isActive: false },
        { id: BSE_ID, exchange: "BSE", isActive: true },
      ],
      "NSE",
    );
    assert.equal(choice?.id, BSE_ID);
    assert.equal(choice?.rung, "isin-other-active");
  });

  it("returns null for an ISIN nothing carries — the 97.1% case", () => {
    assert.equal(
      rankIsinCandidates([], "NSE"),
      null,
      "6,536 of the 6,732 unresolved prod filings are this: no row anywhere " +
        "bears the ISIN. Ranking cannot invent one",
    );
  });

  it("treats a row that omits isActive as ACTIVE, not as inactive", () => {
    // `isActive` is `Boolean @default(true)` and NOT nullable, so `undefined`
    // means "not projected", never "false". Demoting it would rank every
    // candidate from a caller that did not select the column into the cellar.
    const choice = rankIsinCandidates([{ id: NSE_ID, exchange: "NSE" }], "NSE");
    assert.equal(choice?.rung, "isin-own-active");
  });

  // ── DETERMINISM ──────────────────────────────────────────────────────────

  it("is TOTAL: two rows in the SAME class resolve identically every call", () => {
    // Two BSE-active rows for one ISIN, i.e. a tie on exchange AND status.
    // Nothing but the id tie-break separates them.
    const a = {
      id: "bbbbbbbbbbbbbbbbbbbbbbbb",
      exchange: "BSE",
      isActive: true,
    };
    const b = {
      id: "aaaaaaaaaaaaaaaaaaaaaaaa",
      exchange: "BSE",
      isActive: true,
    };
    const forward = rankIsinCandidates([a, b], "NSE");
    const reversed = rankIsinCandidates([b, a], "NSE");
    assert.equal(
      forward?.id,
      reversed?.id,
      "StockRatios.instrumentId is @unique and StockFinancials keys on it, so " +
        "one company resolving to two ids across runs FORKS it into two rows, " +
        "each valid against the index. Order-dependence here is that fork",
    );
    assert.equal(forward?.id, "aaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("is stable across repeated calls on the dual-listed shape", () => {
    const seen = new Set(
      Array.from(
        { length: 8 },
        () => rankIsinCandidates(DUAL_LISTED, "NSE")?.id,
      ),
    );
    assert.equal(seen.size, 1, `resolution flipped across calls: ${[...seen]}`);
    assert.equal([...seen][0], NSE_ID);
  });

  it("order of the input array cannot change the winner", () => {
    const nseFirst = rankIsinCandidates([...DUAL_LISTED].reverse(), "NSE");
    assert.equal(
      nseFirst?.id,
      rankIsinCandidates(DUAL_LISTED, "NSE")?.id,
      "the unfixed query's answer was whatever Mongo returned first; if the " +
        "ladder still depends on input order the fix is cosmetic",
    );
  });

  it("ignores a candidate with no id rather than choosing it", () => {
    const choice = rankIsinCandidates(
      [{ id: "", exchange: "NSE", isActive: true }, ...DUAL_LISTED],
      "NSE",
    );
    assert.equal(choice?.id, NSE_ID);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The write — the ranked id has to reach the row
// ───────────────────────────────────────────────────────────────────────────

describe("storeFiling — the ranked instrument reaches the upsert", () => {
  it("writes the NSE instrumentId for an NSE filing on a dual-listed ISIN", async () => {
    const { deps, upserts, isinQueries } = fakeDb(DUAL_LISTED);
    const tally = emptyTally();

    const outcome = await storeFiling(
      nseEntry(),
      relianceFinancials(),
      deps,
      tally,
    );

    assert.equal(outcome, "written");
    assert.equal(upserts.length, 1);
    assert.equal(
      upserts[0]!.create.instrumentId,
      NSE_ID,
      "ranking correctly and then writing the other id is the same defect " +
        "with an extra step",
    );
    assert.equal(upserts[0]!.update.instrumentId, NSE_ID);
    assert.equal(tally.instrumentRungs["isin-own-active"], 1);
    assert.equal(tally.unresolvedIsin, 0);

    // The lookup must NOT pre-filter — the ladder needs every candidate to rank.
    const where = (isinQueries[0] as { where: Record<string, unknown> }).where;
    assert.deepEqual(
      Object.keys(where).sort(),
      ["isin"],
      "an isActive or exchange predicate here would hide the very rows the " +
        "preference order exists to choose between",
    );
  });

  it("counts an ISIN nothing carries, and still writes the filing", async () => {
    const { deps, upserts } = fakeDb([]);
    const tally = emptyTally();

    const outcome = await storeFiling(
      nseEntry({ symbol: "RELCAPITAL", isin: "INE013A01015" }),
      relianceFinancials(),
      deps,
      tally,
    );

    assert.equal(
      outcome,
      "written",
      "XbrlFiling.instrumentId is nullable BECAUSE a filing from an issuer we " +
        "do not carry is still a real filing",
    );
    assert.equal(upserts[0]!.create.instrumentId, null);
    assert.equal(
      tally.unresolvedIsin,
      1,
      "6,536 prod filings are in this state and produced no signal at all " +
        "before this counter",
    );
    assert.deepEqual(tally.instrumentRungs, {});
  });

  it("reports an unranked resolution under its OWN rung, never as a ranked one", async () => {
    // A double predating MONEY-1299: `findMany` absent. `scripts/jobs/
    // xbrl-reparse.ts` builds one, which is why the field is optional.
    const upserts: Upsert[] = [];
    const deps: XbrlStoreDeps = {
      instrumentMapping: { findFirst: async () => ({ id: BSE_ID }) },
      xbrlFiling: {
        upsert: async (args: unknown) => {
          upserts.push(args as Upsert);
          return {};
        },
      },
    };
    const tally = emptyTally();

    await storeFiling(nseEntry(), relianceFinancials(), deps, tally);

    assert.equal(upserts[0]!.create.instrumentId, BSE_ID);
    assert.equal(
      tally.instrumentRungs["isin-unranked"],
      1,
      "absent-and-ranked must not be one state: that equivalence is exactly " +
        "how a disarmed flag reads as an armed one (MONEY-1214)",
    );
    assert.equal(tally.instrumentRungs["isin-own-active"], undefined);
  });
});
