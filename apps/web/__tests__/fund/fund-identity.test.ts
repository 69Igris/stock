/**
 * `resolveFundIdentity` — the one join three surfaces used to do separately.
 * MONEY-1205.
 *
 * ## The measurement this is built from (prod, 2026-08-18)
 *
 *   SBIETFQLTY · ISIN INF200KA1WX6 · AMFI 145648
 *   mutual_fund_masters: "SBI Nifty 200 Quality 30 ETF" / "SBI Mutual Fund" /
 *                        category "ETF" / benchmarkName null
 *   rendered on /etf/SBIETFQLTY: AMC "Sbi", category "Other",
 *                                benchmark "Other"
 *
 * The row was one `select` away from the page the whole time.
 *
 * Also measured: 541 active ETF rows, ALL with an ISIN, 307 distinct ISINs
 * (NSE + BSE dual listings), and every one of the 307 joins a master row.
 * `amfiSchemeCode` was populated on 0 of them, which is why the write-through
 * below is the mechanism that turns the join into a lookup.
 *
 * Driven through the REAL exported function via its injectable `db` port — no
 * database, no `require.cache` mocking.
 *
 * Source: apps/web/lib/fund/fund-identity.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  resolveFundIdentity,
  cleanInstrumentName,
  type FundIdentityDb,
  type InstrumentIdentityRow,
  type MasterIdentityRow,
} from "@/lib/fund/fund-identity";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SBIETFQLTY: InstrumentIdentityRow = {
  id: "inst-1",
  symbol: "SBIETFQLTY",
  exchange: "NSE",
  name: "SBI NIFTY 200 QUALITY 30 ETF",
  isin: "INF200KA1WX6",
  instrumentType: "ETF",
  amfiSchemeCode: null,
  yahooSymbol: "SBIETFQLTY.NS",
};

const MASTER_145648: MasterIdentityRow = {
  schemeCode: "145648",
  schemeName: "SBI Nifty 200 Quality 30 ETF",
  amcName: "SBI Mutual Fund",
  category: "ETF",
  subCategory: null,
  plan: null,
  isinGrowth: "INF200KA1WX6",
  isinDividend: null,
  description: null,
  fundType: null,
  fundManager: null,
  benchmarkName: null,
  launchDate: null,
  exitLoad: null,
  nav: 228.3347,
  navDate: new Date("2026-08-14T00:00:00Z"),
  aum: null,
  expenseRatio: null,
  returns1Y: null,
  returns3Y: null,
  returns5Y: null,
  returnsInception: null,
  riskLevel: null,
};

interface Calls {
  instrumentFindFirst: Array<Record<string, unknown>>;
  masterFindFirst: Array<Record<string, unknown>>;
  updates: Array<{ where: Record<string, unknown>; data: unknown }>;
}

/**
 * A STORED instrument row, in which `amfiSchemeCode` may be entirely ABSENT.
 *
 * `InstrumentIdentityRow` cannot express that — its field is `string | null` —
 * and that gap is precisely why MONEY-1236 stayed invisible: Prisma READS an
 * absent field back as `null`, so every consumer of a row sees "null" while the
 * document on disk has no key at all, and only a WHERE clause can tell the two
 * apart. Measured on prod 2026-08-21: 26,768 of 26,768 `instrument_mappings`
 * rows are in the absent shape.
 */
type StoredInstrument = Omit<InstrumentIdentityRow, "amfiSchemeCode"> & {
  amfiSchemeCode?: string | null;
};

/** True when the row physically carries the key (vs. Mongo's "missing field"). */
function hasSchemeCodeKey(row: StoredInstrument): boolean {
  return (
    Object.prototype.hasOwnProperty.call(row, "amfiSchemeCode") &&
    row.amfiSchemeCode !== undefined
  );
}

/**
 * MongoDB's ACTUAL matching rule for the `amfiSchemeCode` predicate — the whole
 * subject of MONEY-1236:
 *
 *   `{ amfiSchemeCode: null }`             present-and-null ONLY
 *   `{ amfiSchemeCode: { isSet: false } }` ABSENT key ONLY
 *
 * The previous version of this file modelled the opposite ("Mirrors Mongo:
 * `{ field: null }` matches null AND absent"), which is the same false belief
 * the source comment carried. A double that collapses the two reports this
 * write-through as healthy in both directions, so the 26,768-row no-op could
 * never fail a test.
 */
function schemeCodeClauseMatches(
  row: StoredInstrument,
  clause: unknown
): boolean {
  const present = hasSchemeCodeKey(row);
  if (
    typeof clause === "object" &&
    clause !== null &&
    "isSet" in (clause as Record<string, unknown>)
  ) {
    return (clause as { isSet: boolean }).isSet === present;
  }
  if (clause === null) return present && row.amfiSchemeCode === null;
  return present && row.amfiSchemeCode === clause;
}

/** Evaluate an `updateMany` WHERE (id + an optional OR / flat scheme-code arm). */
function updateWhereMatches(
  row: StoredInstrument,
  where: Record<string, unknown>
): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  const or = where.OR as Array<Record<string, unknown>> | undefined;
  if (or) {
    const ok = or.some(
      (arm) =>
        "amfiSchemeCode" in arm &&
        schemeCodeClauseMatches(row, arm.amfiSchemeCode)
    );
    if (!ok) return false;
  }
  if ("amfiSchemeCode" in where) {
    if (!schemeCodeClauseMatches(row, where.amfiSchemeCode)) return false;
  }
  return true;
}

/**
 * A hand-rolled Prisma stand-in.
 *
 * It answers by inspecting the WHERE, so "did the resolver look this up the
 * cheap way?" is observable rather than assumed.
 */
function fakeDb(opts: {
  instruments?: StoredInstrument[];
  masters?: MasterIdentityRow[];
}): { db: FundIdentityDb; calls: Calls } {
  const instruments: StoredInstrument[] = opts.instruments ?? [];
  const masters = opts.masters ?? [];
  const calls: Calls = {
    instrumentFindFirst: [],
    masterFindFirst: [],
    updates: [],
  };

  const db: FundIdentityDb = {
    instrumentMapping: {
      async findFirst(args) {
        calls.instrumentFindFirst.push(args.where);
        const w = args.where as Record<string, unknown>;
        const hit = instruments.find((row) => {
          if (w.symbol && row.symbol !== w.symbol) return false;
          if (w.exchange && row.exchange !== w.exchange) return false;
          if (w.isin && typeof w.isin === "string" && row.isin !== w.isin) {
            return false;
          }
          if (w.isin && typeof w.isin === "object") {
            const list = (w.isin as { in: string[] }).in;
            if (!row.isin || !list.includes(row.isin)) return false;
          }
          if (w.amfiSchemeCode && row.amfiSchemeCode !== w.amfiSchemeCode) {
            return false;
          }
          const types = (w.instrumentType as { in?: string[] })?.in;
          if (types && !types.includes(row.instrumentType)) return false;
          return true;
        });
        // Prisma hands an ABSENT field back to the caller as `null` — the read
        // side cannot distinguish the two shapes, only the WHERE side can.
        // Returning a normalised COPY is what makes that faithful (and keeps
        // the store's absent key absent for the updateMany below to see).
        return hit
          ? { ...hit, amfiSchemeCode: hit.amfiSchemeCode ?? null }
          : null;
      },
      async updateMany(args) {
        calls.updates.push({ where: args.where, data: args.data });
        let count = 0;
        for (const row of instruments) {
          if (!updateWhereMatches(row, args.where)) continue;
          row.amfiSchemeCode = args.data.amfiSchemeCode;
          count += 1;
        }
        return { count };
      },
    },
    mutualFundMaster: {
      async findFirst(args) {
        calls.masterFindFirst.push(args.where);
        const w = args.where as Record<string, unknown>;
        if (typeof w.schemeCode === "string") {
          return masters.find((m) => m.schemeCode === w.schemeCode) ?? null;
        }
        const or = w.OR as Array<Record<string, string>> | undefined;
        if (or) {
          return (
            masters.find((m) =>
              or.some(
                (clause) =>
                  (clause.isinGrowth && m.isinGrowth === clause.isinGrowth) ||
                  (clause.isinDividend &&
                    m.isinDividend === clause.isinDividend)
              )
            ) ?? null
          );
        }
        return null;
      },
    },
  };
  return { db, calls };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("MONEY-1205 — a joined ETF gets its identity from the master", () => {
  it("[regression] the AMC is 'SBI Mutual Fund', not titleCase('SBI')", async () => {
    const { db } = fakeDb({
      instruments: [{ ...SBIETFQLTY }],
      masters: [MASTER_145648],
    });
    const id = await resolveFundIdentity(
      { symbol: "sbietfqlty", instrumentTypes: ["ETF"] },
      { db, persist: false }
    );
    assert.ok(id);
    assert.equal(id.amcName, "SBI Mutual Fund");
    assert.equal(id.category, "ETF");
    assert.equal(id.schemeCode, "145648");
    assert.equal(id.schemeName, "SBI Nifty 200 Quality 30 ETF");
    assert.equal(id.source, "master");
  });

  it("carries the master row through so the page needs no second join", async () => {
    const { db, calls } = fakeDb({
      instruments: [{ ...SBIETFQLTY }],
      masters: [MASTER_145648],
    });
    const id = await resolveFundIdentity(
      { symbol: "SBIETFQLTY" },
      { db, persist: false }
    );
    assert.equal(id?.master?.nav, 228.3347);
    assert.equal(calls.masterFindFirst.length, 1, "one master read, not two");
  });

  it("benchmarkName stays null — there is nothing to synthesise it from", async () => {
    // Measured: 0 of 14,223 master rows have one. MONEY-610 removed a
    // fabricated benchmark from this product once already.
    const { db } = fakeDb({
      instruments: [{ ...SBIETFQLTY }],
      masters: [MASTER_145648],
    });
    const id = await resolveFundIdentity(
      { symbol: "SBIETFQLTY" },
      { db, persist: false }
    );
    assert.equal(id?.master?.benchmarkName, null);
  });
});

describe("MONEY-1205 — an UNJOINED instrument still resolves", () => {
  it("reports source 'instrument' so the caller knows to fall back", async () => {
    // A newly listed ETF is in `instrument_mappings` before AMFI publishes it.
    const orphan: InstrumentIdentityRow = {
      ...SBIETFQLTY,
      id: "inst-2",
      symbol: "NEWETF",
      name: "BRAND NEW NIFTY ETF",
      isin: null,
    };
    const { db } = fakeDb({ instruments: [orphan], masters: [MASTER_145648] });
    const id = await resolveFundIdentity(
      { symbol: "NEWETF" },
      { db, persist: false }
    );
    assert.ok(id);
    assert.equal(id.source, "instrument");
    assert.equal(id.amcName, null, "no AMC may be invented from a name here");
    assert.equal(id.category, null);
    assert.equal(id.schemeCode, null);
    assert.equal(id.schemeName, "BRAND NEW NIFTY ETF");
  });

  it("returns null only when NOTHING matches", async () => {
    const { db } = fakeDb({});
    assert.equal(
      await resolveFundIdentity({ symbol: "NOPE" }, { db, persist: false }),
      null
    );
  });

  it("[regression] strips the literal quotes BSE ships in instrument names", () => {
    // Measured on prod: `"HDFC GOLD ETF"` — the quote characters are IN the
    // stored string and were rendered inside the page's <h1>.
    assert.equal(cleanInstrumentName('"HDFC GOLD ETF"'), "HDFC GOLD ETF");
    assert.equal(cleanInstrumentName("  SBI ETF  "), "SBI ETF");
    assert.equal(cleanInstrumentName("HDFC GOLD ETF"), "HDFC GOLD ETF");
  });
});

describe("MONEY-1205 — the scheme code is persisted, not re-joined", () => {
  it("writes amfiSchemeCode back after an ISIN resolution", async () => {
    const row = { ...SBIETFQLTY };
    const { db, calls } = fakeDb({
      instruments: [row],
      masters: [MASTER_145648],
    });

    await resolveFundIdentity({ symbol: "SBIETFQLTY" }, { db });
    // Fire-and-forget: let the microtask chain drain.
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.updates.length, 1);
    assert.deepEqual(calls.updates[0].data, { amfiSchemeCode: "145648" });
    assert.equal(row.amfiSchemeCode, "145648");
  });

  it("guards the write on the column still being EMPTY", async () => {
    // `updateMany` rather than `update`: idempotent under concurrent renders.
    // The guard names BOTH empty shapes (MONEY-1236) — a stored null and an
    // absent key are different documents to Mongo, and only the second one
    // exists on prod.
    const row = { ...SBIETFQLTY };
    const { db, calls } = fakeDb({
      instruments: [row],
      masters: [MASTER_145648],
    });
    await resolveFundIdentity({ symbol: "SBIETFQLTY" }, { db });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls.updates[0].where.OR, [
      { amfiSchemeCode: null },
      { amfiSchemeCode: { isSet: false } },
    ]);
    assert.equal(
      Object.prototype.hasOwnProperty.call(
        calls.updates[0].where,
        "amfiSchemeCode"
      ),
      false,
      "a leftover top-level guard would AND with the OR and re-break the write"
    );
  });

  it("does NOT write again once the column is filled", async () => {
    const row = { ...SBIETFQLTY, amfiSchemeCode: "145648" };
    const { db, calls } = fakeDb({
      instruments: [row],
      masters: [MASTER_145648],
    });
    await resolveFundIdentity({ symbol: "SBIETFQLTY" }, { db });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.updates.length, 0);
  });

  it("never persists a NEGATIVE resolution", async () => {
    // A fund AMFI adds tomorrow must be resolvable tomorrow.
    const orphan = { ...SBIETFQLTY, id: "inst-3", isin: "INFNOTINMASTER" };
    const { db, calls } = fakeDb({ instruments: [orphan], masters: [] });
    await resolveFundIdentity({ symbol: "SBIETFQLTY" }, { db });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.updates.length, 0);
  });

  it("a filled column short-circuits the ISIN join", async () => {
    const row = { ...SBIETFQLTY, amfiSchemeCode: "145648" };
    const { db, calls } = fakeDb({
      instruments: [row],
      masters: [MASTER_145648],
    });
    const id = await resolveFundIdentity(
      { symbol: "SBIETFQLTY" },
      { db, persist: false }
    );
    assert.equal(id?.schemeCode, "145648");
    assert.equal(calls.masterFindFirst.length, 1);
    assert.equal(
      calls.masterFindFirst[0].schemeCode,
      "145648",
      "with the code stored, the master is read by PRIMARY KEY, not by ISIN"
    );
  });
});

describe("MONEY-1236 — the write-through was a no-op on 26,768 of 26,768 rows", () => {
  /**
   * The prod shape: the `amfiSchemeCode` KEY is missing from the document, not
   * stored as null. The column was added with the row population already in
   * place and no backfill, so every row is like this.
   */
  function absentSchemeCodeRow(): StoredInstrument {
    const row: StoredInstrument = { ...SBIETFQLTY };
    delete row.amfiSchemeCode;
    return row;
  }

  it("[meta] the shipped flat guard writes 0 rows against that shape", async () => {
    // Driven straight at the double so the two filters can be compared on the
    // SAME row. If this ever reports 1, the double has stopped modelling Mongo
    // and every assertion in this block is vacuous.
    const row = absentSchemeCodeRow();
    const { db } = fakeDb({ instruments: [row], masters: [MASTER_145648] });

    const preFix = await db.instrumentMapping.updateMany({
      where: { id: "inst-1", amfiSchemeCode: null },
      data: { amfiSchemeCode: "145648" },
    });
    assert.equal(preFix.count, 0, "`{ amfiSchemeCode: null }` reaches nothing");
    assert.equal(hasSchemeCodeKey(row), false, "the row is untouched");

    const fixed = await db.instrumentMapping.updateMany({
      where: {
        id: "inst-1",
        OR: [{ amfiSchemeCode: null }, { amfiSchemeCode: { isSet: false } }],
      },
      data: { amfiSchemeCode: "145648" },
    });
    assert.equal(fixed.count, 1);
    assert.equal(row.amfiSchemeCode, "145648");
  });

  it("[regression] persists on a row whose amfiSchemeCode key is ABSENT", async () => {
    const row = absentSchemeCodeRow();
    const { db, calls } = fakeDb({
      instruments: [row],
      masters: [MASTER_145648],
    });

    await resolveFundIdentity({ symbol: "SBIETFQLTY" }, { db });
    await new Promise((r) => setTimeout(r, 0));

    assert.equal(calls.updates.length, 1);
    assert.equal(
      row.amfiSchemeCode,
      "145648",
      "before MONEY-1236 this wrote 0 rows on every render, forever — the " +
        "ISIN join the column exists to retire was re-paid on every view"
    );
  });

  it("an ABSENT key still reads back as null, which is why this hid", async () => {
    // The resolver's own `!instrument.amfiSchemeCode` check cannot tell the
    // shapes apart; Prisma normalises the read. Only the WHERE can.
    const { db } = fakeDb({
      instruments: [absentSchemeCodeRow()],
      masters: [MASTER_145648],
    });
    const id = await resolveFundIdentity(
      { symbol: "SBIETFQLTY" },
      { db, persist: false }
    );
    assert.equal(id?.schemeCode, "145648", "resolution itself never broke");
  });

  it("the EXPLICIT-null shape keeps working too", async () => {
    // 0 rows on prod today, but a partial write or a future backfill can make
    // one, and the OR must not have traded one shape for the other.
    const row: StoredInstrument = { ...SBIETFQLTY, amfiSchemeCode: null };
    const { db, calls } = fakeDb({
      instruments: [row],
      masters: [MASTER_145648],
    });
    await resolveFundIdentity({ symbol: "SBIETFQLTY" }, { db });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls.updates.length, 1);
    assert.equal(row.amfiSchemeCode, "145648");
  });
});

describe("MONEY-1236 — the guard in the source, not just in a copy", () => {
  const SRC = join(__dirname, "..", "..", "lib", "fund", "fund-identity.ts");

  /**
   * MONEY-1143: LINE comments first, BLOCK comments second. A `//` line that
   * contains `/*` makes a block-first stripper swallow the rest of the file,
   * and an absence assertion over swallowed text passes while proving nothing.
   */
  function stripComments(src: string): string {
    return src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }

  const stripped = stripComments(readFileSync(SRC, "utf8"));

  it("[meta] stripComments cannot swallow the code under scan", () => {
    const fixture = [
      "const a = 1;",
      "// a line comment mentioning /* which opens nothing",
      "const keep = { amfiSchemeCode: { isSet: false } };",
      "/* a real block */",
    ].join("\n");
    const out = stripComments(fixture);
    assert.match(out, /isSet: false/);
    assert.doesNotMatch(out, /a real block/);
    assert.doesNotMatch(out, /a line comment/);
  });

  it("the write-through guard carries an isSet:false arm", () => {
    assert.match(
      stripped,
      /OR: \[\{ amfiSchemeCode: null \}, \{ amfiSchemeCode: \{ isSet: false \} \}\]/
    );
  });

  it("[absence] the flat `id + amfiSchemeCode: null` guard is gone", () => {
    assert.doesNotMatch(
      stripped,
      /where: \{ id: instrumentId, amfiSchemeCode: null \}/,
      "that is the shipped shape, and it matched 0 of 26,768 prod rows"
    );
  });
});

describe("MONEY-1205 — /mf/{code} can find its listed instrument", () => {
  it("[regression] via the master's ISINs while amfiSchemeCode is still empty", async () => {
    // Without this the `/mf/145648` -> `/etf/SBIETFQLTY` redirect can never
    // fire on a fund nobody has opened yet — i.e. every fund, on day one.
    const { db } = fakeDb({
      instruments: [{ ...SBIETFQLTY }],
      masters: [MASTER_145648],
    });
    const id = await resolveFundIdentity(
      { schemeCode: "145648" },
      { db, persist: false }
    );
    assert.equal(id?.instrumentType, "ETF");
    assert.equal(id?.symbol, "SBIETFQLTY");
    assert.equal(id?.exchange, "NSE");
  });

  it("a plain MF resolves with no instrument at all", async () => {
    const plainMf: MasterIdentityRow = {
      ...MASTER_145648,
      schemeCode: "119551",
      schemeName: "Some Flexi Cap Fund - Direct Growth",
      category: "Flexi Cap",
      isinGrowth: "INF109K01Z48",
    };
    const { db } = fakeDb({ instruments: [], masters: [plainMf] });
    const id = await resolveFundIdentity(
      { schemeCode: "119551" },
      { db, persist: false }
    );
    assert.ok(id);
    assert.equal(id.instrumentType, null, "not an ETF -> no redirect");
    assert.equal(id.symbol, null);
    assert.equal(id.source, "master");
    assert.equal(id.isin, "INF109K01Z48");
  });
});

describe("MONEY-1205 — a failing read degrades, never throws", () => {
  it("returns what it has when the instrument read rejects", async () => {
    const { db } = fakeDb({ instruments: [], masters: [MASTER_145648] });
    const broken: FundIdentityDb = {
      ...db,
      instrumentMapping: {
        async findFirst() {
          throw new Error("mongo down");
        },
        updateMany: db.instrumentMapping.updateMany,
      },
    };
    const id = await resolveFundIdentity(
      { schemeCode: "145648" },
      { db: broken, persist: false }
    );
    assert.equal(id?.schemeCode, "145648", "the master half still answers");
    assert.equal(id?.instrumentType, null);
  });
});
