/**
 * MONEY-1301 — `corporate_actions.isin` was 4.4% populated, and the join that
 * was supposed to fill it keyed on the wrong thing.
 *
 * ## What was measured on prod, 2026-08-30
 *
 * `corporate_actions` holds 56,446 rows over 8,577 symbols and every health
 * signal it emits is green: `corporate-actions-sync` ran 7/7 days with 8,832
 * selected = 8,832 written. `isin` is set on **2,507 rows (4.4%)**, so the
 * `@@index([isin])` at `schema.prisma:3444` indexes an almost-empty column and
 * every ISIN-keyed consumer — dual-listing dedupe, the XBRL `dividendPerShare`
 * feed behind `dividendYield`, MF-holding cross-references — gets an empty
 * result that is indistinguishable from "this company had no corporate
 * actions".
 *
 * Running the repair's join over the whole table: **40,483 rows (71.7%) resolve
 * on (symbol, exchange)**, taking the column from 4.4% to 76.2%.
 *
 * ## The defect was the MAP KEY, not the query
 *
 * The writer already issued ONE bulk `findMany` and already attached ISINs. It
 * then indexed the result by SYMBOL:
 *
 *     for (const r of rows) map.set(r.symbol.toUpperCase(), r.isin)
 *
 * `instrument_mappings` is `@@unique([symbol, exchange])`, so a dual-listed
 * company contributes TWO rows under one symbol and the second `set` overwrote
 * the first. Harmless when both rows are the same company. Not harmless for the
 * **10 symbols on prod whose NSE and BSE rows carry DIFFERENT ISINs** — two
 * separate companies sharing a ticker (KIRLPNU, SEL, CORDELIA, RAJPUTANA,
 * TDPOWERSYS, FOCUS, KALYANI, GSTL, MAL, ZEAL). **68 corporate actions sit on
 * those symbols**, and under a symbol-only key each one was a coin flip between
 * two companies' identities.
 *
 * A wrong ISIN here is worse than a missing one. A missing one reads as "not
 * ingested yet"; a wrong one attributes a payout to another company through an
 * index that then makes the join look healthy.
 *
 * ## Why these assertions are falsifiable
 *
 * The determinism case builds a fixture in which two DIFFERENT ISINs live under
 * one symbol and asserts on the CHOSEN VALUE per exchange. An implementation
 * that reverts to a symbol key cannot pass it under any tie-break: last-wins
 * gives both rows the BSE ISIN, first-wins gives both the NSE one, and the
 * refusal rule gives both null. Three different wrong answers, all red.
 *
 * The functional cases drive the REAL `processCorporateActionsSync` through its
 * injected seams and read `isin` off the argument that actually reaches the
 * upsert — so a join that ranks correctly and fails to thread its answer into
 * the write is red too. That is the specific shape MONEY-1299 shipped: a
 * resolver whose answer reached the write by a path nothing exercised.
 *
 * ## What these tests deliberately do NOT claim
 *
 * They do not claim the residual is small. 13,456 rows stay null after the
 * join, and they are bucketed rather than summed because the causes need
 * different work: 3,788 have a mapping row that itself carries no ISIN (3,591
 * of them debt servicing — INTEREST_PAYMENT / REDEMPTION / OTHER on BSE bond
 * tickers like `1020NFL27`), 9,486 name a symbol absent from
 * `instrument_mappings` entirely (G-Secs like `815GS2026`, BSE `#`-suffixed
 * tickers, delisted issuers), and 182 exist only on the OTHER exchange and are
 * REFUSED on purpose. That last bucket is the one a "helpful" future change
 * would fill, and it is the one that puts another company's ISIN on a dividend.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  attachIsins,
  buildIsinIndex,
  corpActionIsinKey,
  isinLookupArgs,
  type InstrumentIsinRow,
} from "../../src/processors/corporate-actions-sync-logic";
import {
  processCorporateActionsSync,
  type CorporateActionsSyncDeps,
} from "../../src/processors/corporate-actions-sync";
import type { CorporateActionInput } from "@usemoney/services";

// ══════════════════════════════════════════════════════════════════════
// Fixtures — the real prod shapes, in miniature
// ══════════════════════════════════════════════════════════════════════

/** RELIANCE is dual-listed and is ONE company: same ISIN on both venues. */
const RELIANCE_ISIN = "INE002A01018";
/**
 * KALYANI is TWO companies. Both ISINs below are shaped like real Indian ISINs
 * and are deliberately different in the issuer block, which is the whole point.
 */
const KALYANI_NSE_ISIN = "INE907A01026";
const KALYANI_BSE_ISIN = "INE180C01026";

const MAPPINGS: InstrumentIsinRow[] = [
  { symbol: "RELIANCE", exchange: "NSE", isin: RELIANCE_ISIN },
  { symbol: "RELIANCE", exchange: "BSE", isin: RELIANCE_ISIN },
  { symbol: "KALYANI", exchange: "NSE", isin: KALYANI_NSE_ISIN },
  { symbol: "KALYANI", exchange: "BSE", isin: KALYANI_BSE_ISIN },
  // A mapping row that EXISTS and carries no ISIN — 3,788 rows on prod sit
  // behind this shape, and it must resolve to null, not to a neighbour.
  { symbol: "JBCHEPHARM", exchange: "NSE", isin: null },
  // Present on BSE only. An action tagged NSE for this symbol must NOT borrow
  // the BSE identity (182 rows on prod).
  { symbol: "BEARDSELL", exchange: "BSE", isin: "INE520B01012" },
];

/** A minimal `NSECorporateAction` — the shape both bulk feeds return. */
function action(
  symbol: string,
  exDate: string,
  type = "DIVIDEND",
): Record<string, unknown> {
  return {
    symbol,
    actionType: "DIVIDEND - RS 10 PER SHARE",
    type,
    exDate: new Date(exDate),
    recordDate: null,
    ratio: null,
    oldFaceValue: null,
    newFaceValue: null,
    dividendPerShare: 10,
    details: "DIVIDEND - RS 10 PER SHARE",
    rawData: {},
  };
}

interface RunResult {
  /** Every row that reached the upsert, flattened across symbol groups. */
  upserted: CorporateActionInput[];
  /** One entry per `findInstrumentMappings` call — the count IS the assertion. */
  lookups: Array<{ where: Record<string, unknown> }>;
  outcomes: Array<{ skippedReason?: string }>;
}

/**
 * Drive the REAL processor with fake collaborators.
 *
 * Nothing here replaces the unit under test: the ISIN join, the batch shape and
 * the threading into the write are all the production code path. What is faked
 * is only what sits on the other side of the network and the database.
 */
async function run(
  nseRows: Array<Record<string, unknown>>,
  bseRows: Array<Record<string, unknown>>,
  mappings: InstrumentIsinRow[] = MAPPINGS,
): Promise<RunResult> {
  const upserted: CorporateActionInput[] = [];
  const lookups: RunResult["lookups"] = [];
  const outcomes: RunResult["outcomes"] = [];

  const deps: CorporateActionsSyncDeps = {
    findInstrumentMappings: async (args) => {
      lookups.push({ where: args.where });
      const symbols = (args.where.symbol as { in: string[] } | undefined)?.in;
      const exchanges = (args.where.exchange as { in: string[] } | undefined)
        ?.in;
      // Honour the filter the processor actually sent, so a call that asks for
      // one symbol cannot masquerade as a batched call that asked for all.
      return mappings.filter(
        (m) =>
          (!symbols || symbols.includes(m.symbol)) &&
          (!exchanges || exchanges.includes(m.exchange)),
      );
    },
    // No held symbols => empty Screener enrichment set => no scrape, no GCS
    // snapshot, no pacing sleep.
    findHeldSymbols: async () => [],
    fetchNSE: (async () => ({
      rows: nseRows,
      failedWindows: [],
    })) as unknown as CorporateActionsSyncDeps["fetchNSE"],
    fetchBSE: (async () => ({
      rows: bseRows,
      failedWindows: [],
    })) as unknown as CorporateActionsSyncDeps["fetchBSE"],
    scrapeScreener: (async () =>
      null) as unknown as CorporateActionsSyncDeps["scrapeScreener"],
    archive: async () => null,
    upsert: async (rows) => {
      upserted.push(...rows);
      return { created: rows.length, updated: 0, skipped: 0 };
    },
    reportOutcome: ((o: { skippedReason?: string }) => {
      outcomes.push(o);
    }) as unknown as CorporateActionsSyncDeps["reportOutcome"],
    delayBetweenSymbolsMs: 0,
  };

  await processCorporateActionsSync({}, deps);
  return { upserted, lookups, outcomes };
}

function isinFor(
  rows: CorporateActionInput[],
  symbol: string,
  exchange: string,
): string | null | undefined {
  return rows.find((r) => r.symbol === symbol && r.exchange === exchange)?.isin;
}

// ══════════════════════════════════════════════════════════════════════
// 1. The source row has no ISIN; the mapping does; the stored row carries it
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1301: the ISIN reaches the row that gets written", () => {
  it("a feed row with no ISIN is stamped from instrument_mappings", async () => {
    // Both bulk feeds pass `isin: null` into `nseActionToInput` /
    // `bseActionToInput` — verified in corporate-actions.service.ts — so EVERY
    // row arrives at the join without an identity.
    const { upserted } = await run([action("RELIANCE", "2026-08-10")], []);

    assert.equal(upserted.length, 1, "the one action should reach the upsert");
    assert.equal(
      upserted[0]!.isin,
      RELIANCE_ISIN,
      "the row written to corporate_actions must carry the mapped ISIN — " +
        "this is the 4.4%-populated column the ticket is about",
    );
  });

  it("a row whose mapping carries NO isin is written with null, not a neighbour's", async () => {
    // JBCHEPHARM/NSE exists in instrument_mappings with a null ISIN. 3,788 prod
    // rows sit behind this shape and the correct answer is null.
    const { upserted } = await run([action("JBCHEPHARM", "2026-08-11")], []);
    assert.equal(upserted.length, 1);
    assert.equal(upserted[0]!.isin ?? null, null);
  });

  it("an NSE action for a BSE-only symbol is NOT filled from the other exchange", async () => {
    // 182 prod rows. Filling these is the tempting change that puts one
    // company's identity on another company's action.
    const { upserted } = await run([action("BEARDSELL", "2026-08-12")], []);
    assert.equal(upserted.length, 1);
    assert.equal(upserted[0]!.exchange, "NSE");
    assert.equal(
      upserted[0]!.isin ?? null,
      null,
      "BEARDSELL has a BSE mapping only; an NSE action must stay null",
    );
  });

  it("the run REPORTS its fill rate instead of leaving it query-only", async () => {
    const { outcomes } = await run(
      [action("RELIANCE", "2026-08-10"), action("JBCHEPHARM", "2026-08-11")],
      [],
    );
    const reason = outcomes.at(-1)?.skippedReason ?? "";
    assert.match(reason, /isinResolved=1\b/);
    assert.match(reason, /isinUnresolved=1\b/);
    assert.match(reason, /isinUnkeyable=0\b/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. The key is (symbol, exchange). Never symbol alone.
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1301: two companies, one ticker, two ISINs", () => {
  it("each exchange's action gets its OWN company's ISIN", async () => {
    const { upserted } = await run(
      [action("KALYANI", "2026-08-10")],
      [action("KALYANI", "2026-08-10")],
    );

    assert.equal(upserted.length, 2, "one NSE row and one BSE row");
    assert.equal(
      isinFor(upserted, "KALYANI", "NSE"),
      KALYANI_NSE_ISIN,
      "the NSE action must carry the NSE-listed company's ISIN",
    );
    assert.equal(
      isinFor(upserted, "KALYANI", "BSE"),
      KALYANI_BSE_ISIN,
      "the BSE action must carry the BSE-listed company's ISIN",
    );
    assert.notEqual(
      isinFor(upserted, "KALYANI", "NSE"),
      isinFor(upserted, "KALYANI", "BSE"),
      "a symbol-keyed map collapses these to one value — 68 prod rows",
    );
  });

  it("a genuinely dual-listed company still gets the same ISIN on both", async () => {
    // The guard must not over-fire: RELIANCE is ONE company on two venues.
    const { upserted } = await run(
      [action("RELIANCE", "2026-08-10")],
      [action("RELIANCE", "2026-08-10")],
    );
    assert.equal(upserted.length, 2);
    assert.equal(isinFor(upserted, "RELIANCE", "NSE"), RELIANCE_ISIN);
    assert.equal(isinFor(upserted, "RELIANCE", "BSE"), RELIANCE_ISIN);
  });

  it("an action whose exchange is absent or unplaceable stays NULL", () => {
    // The processor's own feeds always tag NSE or BSE (prod `unkeyable` = 0),
    // so this is the guard for a future source, asserted on the real function
    // the processor calls rather than on a copy of it.
    const index = buildIsinIndex(MAPPINGS);
    const rows = [
      { symbol: "KALYANI", exchange: "", isin: null },
      { symbol: "KALYANI", exchange: "   ", isin: null },
      { symbol: "KALYANI", exchange: "UNKNOWN", isin: null },
      { symbol: "KALYANI", exchange: "NFO", isin: null },
      { symbol: "", exchange: "NSE", isin: null },
    ];
    const tally = attachIsins(rows, index);

    for (const row of rows) {
      assert.equal(
        row.isin,
        null,
        `${row.symbol || "(blank)"}/${row.exchange || "(blank)"} must not ` +
          `borrow either KALYANI's identity`,
      );
    }
    assert.equal(tally.resolved, 0);
    assert.equal(tally.unresolved, rows.length);
    assert.equal(
      tally.unkeyable,
      rows.length,
      "all five are unkeyable, and that is a DIFFERENT alarm from a missing mapping",
    );
  });

  it("corpActionIsinKey refuses rather than guessing", () => {
    assert.equal(corpActionIsinKey("kalyani", "nse"), "KALYANI|NSE");
    assert.equal(corpActionIsinKey(" KALYANI ", " BSE "), "KALYANI|BSE");
    assert.equal(corpActionIsinKey("KALYANI", ""), null);
    assert.equal(corpActionIsinKey("KALYANI", null), null);
    assert.equal(corpActionIsinKey("KALYANI", undefined), null);
    assert.equal(corpActionIsinKey("KALYANI", "N/A"), null);
    assert.equal(corpActionIsinKey("KALYANI", "MCX"), null);
    assert.equal(corpActionIsinKey("", "NSE"), null);
    // The two halves must be distinguishable — a delimiter-free concatenation
    // would make ("AB","CNSE") and ("ABC","NSE") the same key.
    assert.notEqual(
      corpActionIsinKey("AB", "NSE"),
      corpActionIsinKey("ABN", "SE"),
    );
  });

  it("one (symbol, exchange) with two DIFFERENT ISINs resolves to neither", () => {
    // Cannot happen against a live @@unique([symbol, exchange]); it can happen
    // against a fixture or a future feed, and last-wins there would bless
    // whichever order the caller happened to build.
    const index = buildIsinIndex([
      { symbol: "GSTL", exchange: "NSE", isin: "INE111A01011" },
      { symbol: "GSTL", exchange: "NSE", isin: "INE222B01022" },
    ]);
    assert.equal(index.has("GSTL|NSE"), false);
    assert.equal(index.size, 0);
  });

  it("the same ISIN twice on one key is NOT a conflict", () => {
    const index = buildIsinIndex([
      { symbol: "GSTL", exchange: "NSE", isin: "INE111A01011" },
      { symbol: "GSTL", exchange: "NSE", isin: "INE111A01011" },
    ]);
    assert.equal(index.get("GSTL|NSE"), "INE111A01011");
  });

  it("an ISIN already on the row is never overwritten by the join", () => {
    const index = buildIsinIndex(MAPPINGS);
    const row = { symbol: "KALYANI", exchange: "NSE", isin: "INE999Z01019" };
    const tally = attachIsins([row], index);
    assert.equal(row.isin, "INE999Z01019");
    assert.equal(tally.resolved, 1);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. ONE lookup per batch, whatever the batch size
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1301: the mapping read is bulk, not per row", () => {
  /** 60 distinct symbols, two actions each — 120 rows, 60 symbols. */
  const SYMBOLS = Array.from({ length: 60 }, (_, i) => `SYM${i}`);

  it("60 symbols in a batch issue exactly ONE findMany", async () => {
    const mappings: InstrumentIsinRow[] = SYMBOLS.map((s, i) => ({
      symbol: s,
      exchange: "NSE",
      isin: `INE${String(i).padStart(3, "0")}A01011`,
    }));
    const nse = SYMBOLS.flatMap((s) => [
      action(s, "2026-08-10"),
      action(s, "2026-08-11"),
    ]);

    const { upserted, lookups } = await run(nse, [], mappings);

    assert.equal(
      lookups.length,
      1,
      `expected ONE mapping query for 60 symbols / 120 rows, got ${lookups.length}`,
    );

    // A single call that only asked for one symbol would also be "one lookup",
    // so assert the call actually carried the whole batch.
    const asked = (lookups[0]!.where.symbol as { in: string[] }).in;
    assert.equal(asked.length, SYMBOLS.length);
    assert.deepEqual([...asked].sort(), [...SYMBOLS].sort());

    // And that every row came back stamped, so "one call" did not buy
    // correctness away.
    assert.equal(upserted.length, 120);
    assert.equal(
      upserted.filter((r) => r.isin).length,
      120,
      "all 120 rows must carry an ISIN from the single lookup",
    );
  });

  it("the lookup args are distinct pairs, not one entry per row", () => {
    const rows = [
      { symbol: "RELIANCE", exchange: "NSE", isin: null },
      { symbol: "RELIANCE", exchange: "NSE", isin: null },
      { symbol: "RELIANCE", exchange: "BSE", isin: null },
      { symbol: "KALYANI", exchange: "NSE", isin: null },
      // Unkeyable rows contribute NOTHING to the query — asking Mongo for a
      // blank exchange is how a blank-exchange mapping row would start matching.
      { symbol: "KALYANI", exchange: "", isin: null },
    ];
    const args = isinLookupArgs(rows);
    assert.deepEqual([...args.symbols].sort(), ["KALYANI", "RELIANCE"]);
    assert.deepEqual([...args.exchanges].sort(), ["BSE", "NSE"]);
    assert.equal(args.pairs, 3);
  });

  it("a batch with nothing joinable produces empty `in` lists", () => {
    // `attachIsinsToBatch` refuses to send `{ symbol: { in: [] } }` — an empty
    // `$in` matches nothing, so it is a guaranteed-useless round trip. The
    // decision is visible here, in the args builder, rather than only inside
    // the I/O function.
    const args = isinLookupArgs([
      { symbol: "KALYANI", exchange: "", isin: null },
      { symbol: "", exchange: "NSE", isin: null },
    ]);
    assert.deepEqual(args.symbols, []);
    assert.deepEqual(args.exchanges, []);
    assert.equal(args.pairs, 0);
  });

  it("an empty mapping set leaves every row null and still writes them", async () => {
    // The join failing must never cost the ROW. Corporate actions are
    // cost-basis data; a missing ISIN is a degraded row, not a dropped one.
    const { lookups, upserted } = await run(
      [action("RELIANCE", "2026-08-10")],
      [],
      [],
    );
    assert.equal(lookups.length, 1);
    assert.equal(upserted.length, 1);
    assert.equal(upserted[0]!.isin ?? null, null);
  });
});
