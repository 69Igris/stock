/**
 * FUNCTIONAL TEST — `xbrl-sync` writes the FILING's exchange (MONEY-1255).
 *
 * ## The defect this pins
 *
 * `xbrl-sync.ts` hardcoded `"NSE"` in five places: the archive descriptor, the
 * instrument lookup, the stored payload, the upsert's unique key, and the
 * skip-before-download probe. All five were TRUE while NSE was the only results
 * index, and all five become silently wrong the moment a BSE filing arrives —
 * it would be written into the NSE namespace, where it collides with the NSE
 * filing for the same symbol and period.
 *
 * The fifth (`filingKey`) is the one worth naming: it is a READ, not a write.
 * It fetches the incumbent row to decide whether `projectedAt` must be cleared,
 * so left hardcoded a BSE filing compares itself against the NSE row and can
 * conclude "nothing changed" from a document it has never seen.
 *
 * ## Why the assertions are on the PAYLOAD, not on the source
 *
 * A source-text check ("does the file still contain `exchange: \\"NSE\\"`") is a
 * literal-vs-literal assertion — it passes against a re-hardcoded writer as
 * long as the string appears anywhere else in the file, including in a comment.
 * Prisma is injected and the actual upsert argument is read instead, so
 * re-hardcoding fails on a VALUE.
 *
 * ## The bridge
 *
 * A BSE-only issuer files `<in-capmkt:Symbol>NOTLISTED</in-capmkt:Symbol>` — a
 * literal sentinel, not an absent field. `XbrlFiling.symbol` is required and is
 * part of the unique key, so a writer that accepts any non-empty symbol writes
 * every BSE-only issuer of a given quarter and basis to ONE row, where they
 * overwrite each other. The XML below is the REAL Apollo Finvest filing that
 * states that sentinel.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FilingIndexEntry } from "@usemoney/core/market-data";
import { parseXbrlDocument } from "@usemoney/core/market-data";
import {
  storeFiling,
  buildInstanceFetchPlan,
  isUsableSymbol,
  resolveWritableSymbol,
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
const read = (n: string): string => readFileSync(join(FIXTURES, n), "utf8");

/** Apollo Finvest — a BSE-only NBFC. Symbol = "NOTLISTED", scrip 512437. */
const SENTINEL_XML = read("bse-apollofin-h1fy26-standalone-nbfc-2025-01-31.xml");
/** RELIANCE via BSE — dual listed, states a real symbol. */
const SYMBOL_XML = read("bse-reliance-q1fy27-consolidated-indas-2026-01-31.xml");

function financialsOf(xml: string) {
  const out = parseXbrlDocument(xml);
  assert.equal(out.kind, "financials", "fixture must parse for this to mean anything");
  return out.financials;
}

interface Upsert {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
}
interface Lookup {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
}

/**
 * @param mappingRows rows the instrument lookup should answer with, matched in
 *   order against the `where` it receives. `null` means "no such instrument".
 */
function fakeDb(
  mappingRows: (w: Record<string, unknown>) =>
    | { id: string; symbol?: string | null }
    | null = () => null,
): { deps: XbrlStoreDeps; upserts: Upsert[]; lookups: Lookup[] } {
  const upserts: Upsert[] = [];
  const lookups: Lookup[] = [];
  return {
    upserts,
    lookups,
    deps: {
      instrumentMapping: {
        findFirst: async (args: unknown) => {
          const a = args as Lookup;
          lookups.push(a);
          return mappingRows(a.where);
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

/** A BSE index entry, as the BSE producer would build it. */
function bseEntry(over: Partial<FilingIndexEntry> = {}): FilingIndexEntry {
  return {
    era: "integrated",
    exchange: "BSE",
    // BSE's index is keyed by scrip code and states no symbol of its own.
    symbol: "",
    scripCode: "512437",
    isin: null,
    xbrlUrl:
      "https://www.bseindia.com/XBRLFILES/IFNBFCUploadDocument/" +
      "Integrated_Finance_NBFC_512437_8112025151738.xml",
    ixbrlUrl: null,
    basis: "STANDALONE",
    audited: null,
    cumulative: null,
    periodType: null,
    filerKind: "NBFC",
    quarterEnd: null,
    broadcastAt: null,
    companyName: "APOLLO FINVEST (INDIA) LIMITED",
    revisionKind: null,
    revisedAt: null,
    createdAt: null,
    indexSequence: null,
    ...over,
  };
}

describe("buildInstanceFetchPlan — the archive descriptor", () => {
  const day = new Date(Date.UTC(2026, 7, 12));

  it("stamps the FILING's exchange on the descriptor", () => {
    const bse = buildInstanceFetchPlan("BSE", day);
    assert.equal(
      bse.descriptor.exchange,
      "BSE",
      "a BSE filing archived under exchange NSE lands on the wrong GCS " +
        "prefix and is replayed as an NSE feed forever",
    );
    assert.equal(bse.descriptor.date, day);

    const nse = buildInstanceFetchPlan("NSE", day);
    assert.equal(nse.descriptor.exchange, "NSE");
  });

  it("uses the same feed slug for both, so one archive holds both", () => {
    assert.equal(
      buildInstanceFetchPlan("BSE", day).descriptor.feed,
      buildInstanceFetchPlan("NSE", day).descriptor.feed,
    );
  });

  it("sends each exchange its OWN referer", () => {
    assert.match(
      buildInstanceFetchPlan("NSE", undefined).referer,
      /nseindia\.com/,
    );
    assert.match(
      buildInstanceFetchPlan("BSE", undefined).referer,
      /bseindia\.com/,
    );
  });

  it("sends BSE an Origin and NSE none — the verified asymmetry", () => {
    // NSE's archives host was confirmed to serve the XML with no Origin, and
    // the one derivable from its page-level referer would carry a path, which
    // no browser sends. Every working BSE call in this repo sends an Origin.
    assert.equal(buildInstanceFetchPlan("NSE", undefined).headers.Origin, null);
    assert.equal(
      buildInstanceFetchPlan("BSE", undefined).headers.Origin,
      "https://www.bseindia.com",
    );
  });
});

describe("isUsableSymbol — the sentinel guard", () => {
  it("rejects the sentinel a BSE-only issuer actually files", () => {
    assert.equal(isUsableSymbol("NOTLISTED"), false);
    assert.equal(isUsableSymbol(" notlisted "), false, "trim + case");
  });

  it("rejects empty and absent", () => {
    for (const v of ["", "   ", null, undefined]) {
      assert.equal(isUsableSymbol(v), false, String(v));
    }
  });

  it("accepts real symbols, including ones containing a rejected substring", () => {
    for (const v of ["RELIANCE", "NATIONALUM", "NAUKRI", "NIITLTD"]) {
      assert.equal(isUsableSymbol(v), true, v);
    }
  });
});

describe("resolveWritableSymbol — the scrip-code bridge", () => {
  it("passes a usable symbol straight through without touching the DB", async () => {
    const { deps, lookups } = fakeDb();
    const got = await resolveWritableSymbol("RELIANCE", {}, deps);
    assert.equal(got, "RELIANCE");
    assert.deepEqual(lookups, [], "NSE must not pay for BSE's bridge");
  });

  it("SCRIP-CODE ONLY — resolves the sentinel via bseScripCode", async () => {
    const { deps, lookups } = fakeDb((w) =>
      w.bseScripCode === "512437" ? { id: "i1", symbol: "APOLLO" } : null,
    );
    const got = await resolveWritableSymbol(
      "NOTLISTED",
      { scripCode: "512437", isin: "INE412D01013" },
      deps,
    );
    assert.equal(got, "APOLLO");
    assert.equal(
      lookups[0]?.where.bseScripCode,
      "512437",
      "the scrip code is the most specific identity and must be tried first",
    );
  });

  it("falls back to ISIN when the scrip code is not yet mapped", async () => {
    // `bseScripCode` is a recently-populated column. A filing arriving before
    // the backfill reaches its issuer must not be dropped for a reason that
    // has nothing to do with the filing.
    const { deps } = fakeDb((w) =>
      w.isin === "INE412D01013" ? { id: "i1", symbol: "APOLLO" } : null,
    );
    const got = await resolveWritableSymbol(
      "NOTLISTED",
      { scripCode: "512437", isin: "INE412D01013" },
      deps,
    );
    assert.equal(got, "APOLLO");
  });

  it("returns null — never a guess — when nothing resolves", async () => {
    const { deps } = fakeDb(() => null);
    assert.equal(
      await resolveWritableSymbol(
        "NOTLISTED",
        { scripCode: "999999", isin: "INE000X01011" },
        deps,
      ),
      null,
    );
  });

  it("rejects the 000000 not-listed-on-BSE marker without querying for it", async () => {
    const { deps, lookups } = fakeDb(() => null);
    await resolveWritableSymbol("NOTLISTED", { scripCode: "000000" }, deps);
    assert.deepEqual(
      lookups.filter((l) => "bseScripCode" in l.where),
      [],
      "000000 is a real value meaning 'not on BSE'; it joins to nothing",
    );
  });

  it("does not accept a mapping row whose own symbol is unusable", async () => {
    const { deps } = fakeDb(() => ({ id: "i1", symbol: "NOTLISTED" }));
    assert.equal(
      await resolveWritableSymbol("NOTLISTED", { scripCode: "512437" }, deps),
      null,
      "a mapping polluted with the sentinel must not re-introduce it",
    );
  });
});

describe("storeFiling — the exchange reaches every write", () => {
  it("writes a BSE filing under exchange BSE, in the payload AND the key", async () => {
    const { deps, upserts } = fakeDb((w) =>
      w.bseScripCode === "512437" ? { id: "inst-1", symbol: "APOLLO" } : null,
    );
    const outcome = await storeFiling(
      bseEntry(),
      financialsOf(SENTINEL_XML),
      deps,
    );
    assert.equal(outcome, "written");
    assert.equal(upserts.length, 1);

    const [u] = upserts;
    assert.equal(
      (u!.create as { exchange?: unknown }).exchange,
      "BSE",
      "the stored payload must carry BSE",
    );
    const key = u!.where
      .symbol_exchange_periodEnd_periodType_basis_cumulative as Record<
      string,
      unknown
    >;
    assert.equal(
      key.exchange,
      "BSE",
      "the UNIQUE KEY must carry BSE, or the row collides with NSE's",
    );
    assert.equal(
      key.symbol,
      "APOLLO",
      "the bridged symbol — not the NOTLISTED sentinel",
    );
  });

  it("still writes NSE when the entry states no exchange (regression)", async () => {
    const { deps, upserts } = fakeDb(() => null);
    const outcome = await storeFiling(
      // No `exchange` field at all — every pre-existing producer.
      bseEntry({ exchange: undefined, symbol: "RELIANCE", scripCode: null }),
      financialsOf(SYMBOL_XML),
      deps,
    );
    assert.equal(outcome, "written");
    const key = upserts[0]!.where
      .symbol_exchange_periodEnd_periodType_basis_cumulative as Record<
      string,
      unknown
    >;
    assert.equal(key.exchange, "NSE");
    assert.equal((upserts[0]!.create as { exchange?: unknown }).exchange, "NSE");
  });

  it("scopes the instrument lookup to the filing's exchange", async () => {
    const { deps, lookups } = fakeDb((w) =>
      w.bseScripCode === "512437" ? { id: "inst-1", symbol: "APOLLO" } : null,
    );
    await storeFiling(bseEntry(), financialsOf(SENTINEL_XML), deps);
    const symbolLookups = lookups.filter((l) => "symbol" in l.where);
    assert.ok(symbolLookups.length > 0, "expected a symbol-scoped lookup");
    for (const l of symbolLookups) {
      assert.equal(
        l.where.exchange,
        "BSE",
        "a BSE filing must not be joined to an NSE instrument row",
      );
    }
  });

  it("reads the INCUMBENT under the filing's exchange, not NSE's", async () => {
    // The fifth literal, and the sneaky one: `filingKey` feeds a findUnique
    // that decides whether `projectedAt` must be cleared. Hardcoded to NSE, a
    // BSE filing compares itself against the NSE row for the same symbol and
    // period and can conclude "nothing changed" from a document it has never
    // seen — leaving stock_financials serving the other exchange's numbers.
    //
    // NOTE this needs a findUnique on the double. Without one the production
    // code short-circuits to `null` and the key is never built, so a fake DB
    // that omits it cannot fail — which is exactly why this test exists apart.
    const reads: Array<Record<string, unknown>> = [];
    const base = fakeDb((w) =>
      w.bseScripCode === "512437" ? { id: "inst-1", symbol: "APOLLO" } : null,
    );
    const deps: XbrlStoreDeps = {
      ...base.deps,
      xbrlFiling: {
        ...base.deps.xbrlFiling,
        findUnique: async (args: unknown) => {
          reads.push((args as { where: Record<string, unknown> }).where);
          return null;
        },
      },
    };

    await storeFiling(bseEntry(), financialsOf(SENTINEL_XML), deps);
    assert.equal(reads.length, 1, "expected exactly one incumbent read");
    const key = reads[0]!
      .symbol_exchange_periodEnd_periodType_basis_cumulative as Record<
      string,
      unknown
    >;
    assert.equal(key.exchange, "BSE");
    assert.equal(key.symbol, "APOLLO");
  });

  it("COUNTS an unresolvable filing as no-symbol and writes NOTHING", async () => {
    const { deps, upserts } = fakeDb(() => null);
    const outcome = await storeFiling(
      bseEntry({ scripCode: "999999" }),
      financialsOf(SENTINEL_XML),
      deps,
    );
    assert.equal(
      outcome,
      "no-symbol",
      "an unresolvable filing is a counted refusal, never a crash",
    );
    assert.deepEqual(
      upserts,
      [],
      "nothing may be written under the sentinel — that merges companies",
    );
  });

  it("never writes the sentinel as a symbol, even when the DB is empty", async () => {
    const { deps, upserts } = fakeDb(() => null);
    await storeFiling(bseEntry(), financialsOf(SENTINEL_XML), deps);
    for (const u of upserts) {
      assert.notEqual(
        (u.create as { symbol?: unknown }).symbol,
        "NOTLISTED",
        "every BSE-only issuer would collapse onto this one key",
      );
    }
  });
});

describe("resolveWritableSymbol — one ISIN, several rows", () => {
  // The suite above drives this function through a `findFirst`-only double, so
  // it could never see which row an ambiguous ISIN picked. That is the shape
  // MONEY-1299 removed from the resolver 200 lines below and which survived
  // here: 2,155 ISINs in this table carry more than one row, and 163 filings
  // were measured whose BSE row holds a DIFFERENT company's symbol
  // (GILLETTE/PGHH, GLOBOFFS/GARWAOFFS, OCCL/AGVENTURES).
  //
  // `XbrlFiling.symbol` is required AND part of the unique key, so an arbitrary
  // pick files one company's numbers under another company's key.

  /** Rows in a deliberately unhelpful storage order — the wrong answer first. */
  const rowsFor = (isin: string) => [
    { id: "b", symbol: "GARWAOFFS", exchange: "NSE", isActive: false, isin },
    { id: "a", symbol: "GLOBOFFS", exchange: "BSE", isActive: true, isin },
    { id: "c", symbol: "OTHER", exchange: "NSE", isActive: true, isin },
  ];

  const rankingDeps = (captured: { orderBy?: unknown } = {}) => ({
    instrumentMapping: {
      findMany: async (args: { where: { isin?: string } }) =>
        rowsFor(args.where.isin ?? "X"),
      findFirst: async (args: { orderBy?: unknown }) => {
        captured.orderBy = args.orderBy;
        return rowsFor("X")[0];
      },
    },
  });

  it("picks the OWN-exchange ACTIVE row, not whatever storage returned first", async () => {
    const got = await resolveWritableSymbol(
      "NOTLISTED",
      { isin: "INE102D01028" },
      rankingDeps() as never,
    );
    // `b` is first out of the database and is an inactive NSE row; `a` is the
    // active BSE row, which is the company this BSE filing belongs to.
    assert.equal(got, "GLOBOFFS");
  });

  it("is STABLE when the storage order changes", async () => {
    // A rename CREATES a row (MONEY-1177), so "first" can reshuffle between
    // runs. Two filings for one company must still resolve to one symbol, or
    // the company forks into two keys, each valid against the unique index.
    const reversed = {
      instrumentMapping: {
        findMany: async (args: { where: { isin?: string } }) =>
          [...rowsFor(args.where.isin ?? "X")].reverse(),
      },
    };
    const got = await resolveWritableSymbol(
      "NOTLISTED",
      { isin: "INE102D01028" },
      reversed as never,
    );
    assert.equal(got, "GLOBOFFS");
  });

  it("the findFirst fallback is ordered too", async () => {
    // A caller whose double has no `findMany` still must not get storage order.
    const captured: { orderBy?: unknown } = {};
    const deps = rankingDeps(captured);
    delete (deps.instrumentMapping as { findMany?: unknown }).findMany;
    await resolveWritableSymbol("NOTLISTED", { isin: "INE102D01028" }, deps as never);
    assert.ok(captured.orderBy, "the degraded path issued findFirst with no orderBy");
  });
});
