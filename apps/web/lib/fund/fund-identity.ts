/**
 * One resolver for "what fund is this?" — MONEY-1205.
 *
 * ## The bug this closes
 *
 * `app/etf/[symbol]/page.tsx` ALREADY joined `mutual_fund_masters` by ISIN. It
 * just never selected `schemeCode`, and never selected the naming columns. So
 * the page held the row that says
 *
 *     schemeCode "145648" · "SBI Nifty 200 Quality 30 ETF" · "SBI Mutual Fund"
 *                                                          · category "ETF"
 *
 * and rendered, instead, `titleCase("SBI")` → "Sbi" as the AMC and the
 * name-keyword fallthrough "Other" as the category — with "Other" passed a
 * SECOND time as the fund's benchmark. Every one of those was derivable from a
 * join the request had already paid for.
 *
 * Three surfaces performed that join independently (`app/etf/[symbol]/page.tsx`,
 * `app/mf/[schemeCode]/page.tsx`, `packages/services/src/discover-market.service.ts`)
 * and disagreed about the answer. This is the single implementation the two
 * pages now share.
 *
 * ## Why identity is PERSISTED, not just joined
 *
 * `InstrumentMapping.amfiSchemeCode` (+ its index) exists precisely so the
 * ISIN join is paid ONCE per instrument instead of once per page view. This
 * module is the writer: a successful ISIN -> schemeCode resolution is written
 * back, fire-and-forget, guarded on the column still being empty. There is no
 * migration and none is needed — the column fills lazily as funds are viewed,
 * and a row that has never been viewed costs exactly what it costs today.
 *
 * Only POSITIVE resolutions are stored. "No master row for this ISIN" is never
 * written, because a fund that AMFI adds tomorrow must be resolvable tomorrow —
 * caching a failure would make that permanent.
 *
 * That write-through was a NO-OP from the day it shipped until MONEY-1236 — its
 * `where` guard could not match a single row. See `rememberSchemeCode` below;
 * the measured count is 0 written of 26,768 candidates.
 *
 * ## Fallback is a first-class path
 *
 * An ETF with no ISIN, or an ISIN with no master row, still has to render. The
 * caller keeps `lib/screener/etf-derive` for exactly that case; this resolver
 * reports which side supplied the naming fields (`source`) so the caller can
 * tell "real identity" from "parsed out of the ticker's name".
 */

import { prisma } from "@usemoney/database";

// ---------------------------------------------------------------- row shapes

/** The instrument columns identity needs. */
export interface InstrumentIdentityRow {
  id: string;
  symbol: string;
  exchange: string;
  name: string;
  isin: string | null;
  instrumentType: string;
  amfiSchemeCode: string | null;
  yahooSymbol: string;
}

/** The master columns identity + the fund pages need. */
export interface MasterIdentityRow {
  schemeCode: string;
  schemeName: string;
  amcName: string;
  category: string;
  subCategory: string | null;
  plan: string | null;
  /**
   * Both ISINs are selected because they are the ONLY way back to the listed
   * instrument for a fund nobody has opened yet: `amfiSchemeCode` fills lazily,
   * so `/mf/145648` cannot find `SBIETFQLTY` — and therefore cannot know it
   * should redirect to `/etf/…` — without them.
   */
  isinGrowth: string | null;
  isinDividend: string | null;
  description: string | null;
  fundType: string | null;
  fundManager: string | null;
  benchmarkName: string | null;
  launchDate: Date | null;
  exitLoad: string | null;
  nav: number;
  navDate: Date;
  aum: number | null;
  expenseRatio: number | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  returnsInception: number | null;
  riskLevel: string | null;
}

/**
 * The database seam.
 *
 * Method syntax (not property syntax) is load-bearing: methods are checked
 * bivariantly, which is what lets the real Prisma delegates satisfy these
 * deliberately loose argument types. Mirrors `MfNavReader` in
 * `packages/core/src/market-data/prices/mf-nav-service.ts`.
 */
export interface FundIdentityDb {
  instrumentMapping: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
      orderBy?: Record<string, "asc" | "desc">;
    }): Promise<InstrumentIdentityRow | null>;
    updateMany(args: {
      where: Record<string, unknown>;
      data: { amfiSchemeCode: string };
    }): Promise<{ count: number }>;
  };
  mutualFundMaster: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
    }): Promise<MasterIdentityRow | null>;
  };
}

export interface ResolveFundIdentityArgs {
  symbol?: string | null;
  isin?: string | null;
  schemeCode?: string | null;
  /** Narrows the instrument lookup when the URL carried `?exchange=`. */
  exchange?: string | null;
  /** Restrict the instrument lookup, e.g. `["ETF"]` on the ETF route. */
  instrumentTypes?: readonly string[];
}

export interface ResolveFundIdentityDeps {
  db?: FundIdentityDb;
  /** Injected in tests to assert the write-through without a database. */
  persist?: boolean;
}

export interface FundIdentity {
  instrumentId: string | null;
  symbol: string | null;
  exchange: string | null;
  isin: string | null;
  schemeCode: string | null;
  /** Display name. The master's `schemeName` when joined; else the cleaned instrument name. */
  schemeName: string | null;
  amcName: string | null;
  category: string | null;
  subCategory: string | null;
  description: string | null;
  /** `"master"` when the naming fields came from `mutual_fund_masters`. */
  source: "master" | "instrument";
  instrumentType: string | null;
  yahooSymbol: string | null;
  /** The rest of the joined master row, or null when nothing joined. */
  master: MasterIdentityRow | null;
}

const INSTRUMENT_SELECT = {
  id: true,
  symbol: true,
  exchange: true,
  name: true,
  isin: true,
  instrumentType: true,
  amfiSchemeCode: true,
  yahooSymbol: true,
} as const;

const MASTER_SELECT = {
  schemeCode: true,
  schemeName: true,
  amcName: true,
  category: true,
  subCategory: true,
  plan: true,
  isinGrowth: true,
  isinDividend: true,
  description: true,
  fundType: true,
  fundManager: true,
  benchmarkName: true,
  launchDate: true,
  exitLoad: true,
  nav: true,
  navDate: true,
  aum: true,
  expenseRatio: true,
  returns1Y: true,
  returns3Y: true,
  returns5Y: true,
  returnsInception: true,
  riskLevel: true,
} as const;

/**
 * Instrument names arrive from the exchange masters wrapped in literal quote
 * characters on the BSE side (`"HDFC GOLD ETF"` — the quotes are IN the
 * stored string, and were rendered inside the page's `<h1>`). The master's
 * `schemeName` never carries them, which is one more reason to prefer it.
 */
export function cleanInstrumentName(name: string): string {
  return name.replace(/^["'\s]+|["'\s]+$/g, "");
}

function defaultDb(): FundIdentityDb {
  return prisma as unknown as FundIdentityDb;
}

/** Persist a resolved scheme code, once, without blocking or throwing. */
function rememberSchemeCode(
  db: FundIdentityDb,
  instrumentId: string,
  schemeCode: string
): void {
  // `updateMany` rather than `update`: idempotent under concurrent renders, and
  // the guard keeps the write off a column somebody else already filled.
  //
  // ## MONEY-1236 — the guard used to match NOTHING, so this never wrote
  //
  // The shipped guard was the bare `{ amfiSchemeCode: null }`, carrying a
  // comment that said Mongo's null predicate "matches rows where the field is
  // ABSENT as well". It does not. Prisma's MongoDB connector compiles
  // `{ f: null }` to an EQUALITY on a stored null; only `{ f: { isSet: false } }`
  // (or a raw `$exists: false`) reaches a document that never had the key. That
  // sentence was the belief, written down as a fact, and it is the same belief
  // behind MONEY-1050, MONEY-1205, MONEY-1234 and MONEY-1235.
  //
  // Measured on PROD 2026-08-21, `instrument_mappings`:
  //
  //     total                       26,768
  //     amfiSchemeCode ABSENT       26,768   (100.0%)
  //     amfiSchemeCode present           0
  //
  // The column was added with the row population already in place and no
  // backfill, so EVERY row is in the absent shape and the old guard selected
  // zero of them. `updateMany` returned `{ count: 0 }` on every call — a
  // success, with no write — which is why nothing ever surfaced: the
  // fire-and-forget `.catch()` below has never had anything to catch. The
  // "paid ONCE per instrument" claim at the top of this file was therefore
  // false in production; the ISIN join was re-paid on every single render.
  //
  // Both arms are kept because neither subsumes the other: `isSet: false` is
  // the 26,768 absent rows, `null` is the explicitly-stored null a partial
  // write or a future backfill can produce.
  void Promise.resolve()
    .then(() =>
      db.instrumentMapping.updateMany({
        where: {
          id: instrumentId,
          OR: [{ amfiSchemeCode: null }, { amfiSchemeCode: { isSet: false } }],
        },
        data: { amfiSchemeCode: schemeCode },
      })
    )
    .catch(() => {
      // A failed write-through costs one join on the next view. Never a render.
    });
}

/**
 * Resolve a fund's identity from any one of symbol / ISIN / AMFI scheme code.
 *
 * Returns `null` only when NOTHING matched — neither an instrument nor a master
 * row. A partial answer (instrument with no master, or master with no listed
 * instrument) is a real answer and is returned with `source` set accordingly.
 */
export async function resolveFundIdentity(
  args: ResolveFundIdentityArgs,
  deps: ResolveFundIdentityDeps = {}
): Promise<FundIdentity | null> {
  const db = deps.db ?? defaultDb();
  const persist = deps.persist ?? true;

  const symbol = args.symbol?.trim().toUpperCase() || null;
  const isinArg = args.isin?.trim().toUpperCase() || null;
  const schemeCodeArg = args.schemeCode?.trim() || null;
  const exchange = args.exchange?.trim().toUpperCase() || null;

  let instrument: InstrumentIdentityRow | null = null;
  let master: MasterIdentityRow | null = null;

  // ---- 1. Instrument side -------------------------------------------------
  if (symbol || isinArg) {
    instrument = await db.instrumentMapping
      .findFirst({
        where: {
          isActive: true,
          ...(symbol ? { symbol } : {}),
          ...(!symbol && isinArg ? { isin: isinArg } : {}),
          ...(exchange ? { exchange } : {}),
          ...(args.instrumentTypes && args.instrumentTypes.length > 0
            ? { instrumentType: { in: [...args.instrumentTypes] } }
            : {}),
        },
        select: INSTRUMENT_SELECT,
        // NSE before BSE alphabetically — the same preference the ETF page
        // has always applied when the caller did not name an exchange.
        orderBy: { exchange: "asc" },
      })
      .catch(() => null);
  }

  // ---- 2. Master side -----------------------------------------------------
  const knownSchemeCode =
    schemeCodeArg ?? instrument?.amfiSchemeCode?.trim() ?? null;
  const knownIsin = instrument?.isin?.trim().toUpperCase() ?? isinArg;

  if (knownSchemeCode) {
    master = await db.mutualFundMaster
      .findFirst({
        where: { schemeCode: knownSchemeCode },
        select: MASTER_SELECT,
      })
      .catch(() => null);
  }
  if (!master && knownIsin) {
    master = await db.mutualFundMaster
      .findFirst({
        where: {
          OR: [{ isinGrowth: knownIsin }, { isinDividend: knownIsin }],
        },
        select: MASTER_SELECT,
      })
      .catch(() => null);
  }

  // ---- 3. Instrument from the master, when we started at /mf/{code} -------
  if (!instrument && master) {
    instrument = await db.instrumentMapping
      .findFirst({
        where: { isActive: true, amfiSchemeCode: master.schemeCode },
        select: INSTRUMENT_SELECT,
        orderBy: { exchange: "asc" },
      })
      .catch(() => null);

    // The `amfiSchemeCode` column fills lazily, so an ISIN sweep is still
    // required for every fund nobody has opened yet.
    if (!instrument) {
      const isins = [
        ...new Set(
          [knownIsin, isinArg, master.isinGrowth, master.isinDividend]
            .filter((v): v is string => typeof v === "string" && v.length > 0)
            .map((v) => v.trim().toUpperCase())
        ),
      ];
      if (isins.length > 0) {
        instrument = await db.instrumentMapping
          .findFirst({
            where: { isActive: true, isin: { in: isins } },
            select: INSTRUMENT_SELECT,
            orderBy: { exchange: "asc" },
          })
          .catch(() => null);
      }
    }
  }

  if (!instrument && !master) return null;

  // ---- 4. Write-through ---------------------------------------------------
  if (persist && instrument && master && !instrument.amfiSchemeCode) {
    rememberSchemeCode(db, instrument.id, master.schemeCode);
  }

  return {
    instrumentId: instrument?.id ?? null,
    symbol: instrument?.symbol ?? null,
    exchange: instrument?.exchange ?? null,
    isin:
      instrument?.isin ?? master?.isinGrowth ?? master?.isinDividend ?? null,
    schemeCode: master?.schemeCode ?? instrument?.amfiSchemeCode ?? null,
    schemeName: master
      ? master.schemeName
      : instrument
        ? cleanInstrumentName(instrument.name)
        : null,
    amcName: master?.amcName ?? null,
    category: master?.category ?? null,
    subCategory: master?.subCategory ?? null,
    description: master?.description ?? null,
    source: master ? "master" : "instrument",
    instrumentType: instrument?.instrumentType ?? null,
    yahooSymbol: instrument?.yahooSymbol ?? null,
    master,
  };
}
