/**
 * MF portfolio section service — MONEY-1204 (P14 / 14d.1).
 *
 * The `apps/api` half of the MF Portfolio tab. Kept in lockstep with the web
 * action by construction: both call into the same pure
 * `mf-portfolio-section-logic` and both return the same `withProvenance`
 * envelope, so the standing "keep apps/api in sync with server actions" rule is
 * satisfied by sharing code rather than by two people remembering.
 *
 * Collaborators are injected (`MfPortfolioDeps`) so the whole path is testable
 * with a hand-rolled fake Prisma and no database, matching
 * `stock-tabs.service.ts`.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core/cache";
import { getNseMarketStatus } from "@usemoney/core/market-data/market-hours";
import {
  buildMfPortfolioSection,
  diffMfPortfolio,
  disclosedWeight,
  schemeCodeWhere,
  type FundHoldingRow,
  type MfPortfolioDiff,
  type MfHoldingLine,
  type MfPortfolioRow,
} from "@usemoney/core/market-data";

import type { ServiceResult } from "./types";
import { withProvenance, type WithProvenance } from "./provenance";

const NS = "discover" as const;

/**
 * Holding rows read PER disclosure month — never shared across the two.
 *
 * Wide enough for a full index-fund portfolio (a Nifty 500 tracker discloses
 * ~500 lines) with room to spare, and applied per month so a big newest month
 * can never eat the month the diff is measured against.
 */
const HOLDING_ROWS_PER_PERIOD = 800;

export interface MfPortfolioSectionData {
  lines: MfHoldingLine[];
  diff: MfPortfolioDiff;
  totals: { totalPct: number; disclosed: number; undisclosed: number };
  /** AMC disclosures we could not attach to this scheme — shown, not hidden. */
  unresolvedSchemes: string[];
}

export interface MfPortfolioDeps {
  prisma?: typeof prisma;
  getCached?: typeof getCached;
  setCached?: typeof setCached;
  getNseMarketStatus?: () => { isLive: boolean };
}

function resolve(deps: MfPortfolioDeps) {
  const status = deps.getNseMarketStatus ?? getNseMarketStatus;
  return {
    db: deps.prisma ?? prisma,
    readCache: deps.getCached ?? getCached,
    writeCache: deps.setCached ?? setCached,
    // Monthly data. A short TTL would buy nothing and cost a query per view;
    // 6h even during market hours is generous for a figure that moves once a
    // month, and the closed-market value is a day.
    ttl: status().isLive ? 6 * 60 * 60 : 24 * 60 * 60,
  };
}

/**
 * Holdings for one AMFI scheme code.
 *
 * Official AMC disclosure first, Kuvera/AI-derived `FundHolding` only when the
 * official side is empty — and labelled `fallback` either way, because the two
 * disagree in ways the reader cannot see.
 *
 * MONEY-1205 — this is keyed on the AMFI scheme code and nothing else, which is
 * exactly right and is why `/etf/[symbol]` can now call it: the ETF page
 * resolves its scheme code through `lib/fund/fund-identity` instead of only
 * holding a trading symbol. The ETF-side third-party reading is NOT reachable
 * from here — `FundHolding` stores it under `("ETF", <symbol>)` — and that is
 * deliberate: on both fund pages `FundCompositionSection` is the panel that
 * renders it, gated on this function reporting no official disclosure.
 */
export async function getMfPortfolioSection(
  args: { schemeCode: string },
  deps: MfPortfolioDeps = {},
): Promise<ServiceResult<WithProvenance<MfPortfolioSectionData>>> {
  const { db, readCache, writeCache, ttl } = resolve(deps);
  const cacheKey = `mf-portfolio-section:${args.schemeCode}`;

  const cached = await readCache<WithProvenance<MfPortfolioSectionData>>(
    NS,
    "_global",
    cacheKey,
  );
  if (cached) return { success: true, data: cached };

  try {
    // Two months, not one: the newest renders and the previous one is what
    // makes the entered/exited diff possible. Resolved as the two most recent
    // periods that this scheme actually published, rather than by a date
    // predicate, because AMC disclosures skip months and a "last 60 days"
    // window would silently return one month for a scheme that published in
    // March and July.
    // MONEY-1294 — the primary code OR any of the scheme's plan variants; see
    // `schemeCodeWhere`. Reached by whichever code the caller resolved, and
    // AMFI hands out up to four per filed portfolio.
    const newest = await db.mfPortfolioHolding.findFirst({
      where: schemeCodeWhere(args.schemeCode),
      orderBy: { period: "desc" },
      select: { period: true, amc: true, schemeKey: true },
    });

    // MONEY-1401 — every read AFTER the resolve is narrowed to the newest row's
    // OWN (amc, schemeKey), never to the scheme code again. This is the same
    // narrowing `fund-composition.service.ts` does, for the same reason and one
    // step further, because this surface reads TWO months.
    //
    // The table's identity is (period, amc, schemeKey, instrumentName);
    // `amfiSchemeCode`/`amfiSchemeCodes` are nullable join handles on top of it
    // and are NOT unique. Two sheets can land on one code by construction:
    // `schemeKeyOf` (the storage key) is separator-SENSITIVE while
    // `schemeFamilyKey` (which resolves the codes) is separator-FREE — measured,
    // 57 of 4,109 families contain members that disagree about the split, e.g.
    // `SBI Nifty Midcap150 ETF` / `SBI Nifty Midcap 150 ETF`. One family, one
    // code array, TWO storage keys. Unnarrowed, `buildMfPortfolioSection` takes
    // every row in the newest period with no grouping and `diffMfPortfolio`
    // keys its map on `instrumentName` alone, so the two portfolios union into
    // one that renders "200.0% across 4 of 4 holdings" and a diff that silently
    // drops whichever duplicate name was written first.
    //
    // `amc` is HALF that identity: `schemeKey` normalises the PRINTED NAME
    // alone, so two AMCs printing one name are one key (9 of 662 stored keys
    // carry no AMC name at all — Shriram and Baroda BNP print the bare SEBI
    // category line).
    //
    // Still sits on `@@index([schemeKey, period(sort: Desc)])`; `amc` filters
    // inside it.
    //
    // Built INSIDE the `newest` branch rather than as a nullable object spread
    // into each read: a `where` field holding `undefined` is "no filter" to
    // Prisma, so a scope that can be half-absent is one refactor away from
    // widening back to the whole table without changing shape.
    const scope = newest
      ? { amc: newest.amc, schemeKey: newest.schemeKey }
      : null;
    const prior =
      scope && newest
        ? await db.mfPortfolioHolding.findFirst({
            where: { ...scope, period: { lt: newest.period } },
            orderBy: { period: "desc" },
            select: { period: true },
          })
        : null;
    const periods = newest
      ? [newest.period, ...(prior ? [prior.period] : [])]
      : [];

    // One bounded page PER month. A single `take` spanning both is not a
    // smaller version of this: with `period: "desc"` leading the sort the whole
    // newest month lands first, so the cut falls INSIDE the prior month and
    // every holding it truncated reads as a position the scheme opened this
    // month — printed as fact by the entered/exited diff. An index fund
    // tracking the Nifty 500 discloses ~500 rows a month, so a single 800-row
    // cap over two months is already short today. The explicit secondary sort
    // matters for the same reason: with no `orderBy` the cut point inside a
    // truncated month is arbitrary and two identical reads can disagree.
    const pages = (await Promise.all(
      periods.map((period) =>
        db.mfPortfolioHolding.findMany({
          where: { ...scope, period },
          orderBy: [{ percentToNav: "desc" }],
          take: HOLDING_ROWS_PER_PERIOD,
          select: {
            period: true,
            amc: true,
            schemeKey: true,
            amfiSchemeCode: true,
            instrumentName: true,
            isin: true,
            holdingType: true,
            quantity: true,
            marketValue: true,
            percentToNav: true,
            source: true,
          },
        }),
      ),
    )) as MfPortfolioRow[][];
    const official = pages.flat();

    const fallback =
      official.length === 0
        ? ((await db.fundHolding.findMany({
            where: { fundType: "MF", fundId: args.schemeCode },
            orderBy: { weightPercent: "desc" },
            take: 200,
            select: {
              holdingName: true,
              holdingSymbol: true,
              isin: true,
              holdingType: true,
              sector: true,
              weightPercent: true,
              source: true,
            },
          })) as FundHoldingRow[])
        : [];

    const section = buildMfPortfolioSection({ official, fallback });
    const data: MfPortfolioSectionData = {
      lines: section.lines,
      diff: diffMfPortfolio(official),
      totals: disclosedWeight(section.lines),
      unresolvedSchemes: section.unresolvedSchemes,
    };

    const envelope = withProvenance(data, {
      source: section.source,
      asOf: section.period,
      fallback: section.fallback,
      note: section.fallback
        ? "The AMC has not published a machine-readable portfolio for this scheme; showing a third-party reading."
        : undefined,
      // `data` is an object and is never key-less, so length cannot decide.
      // Emptiness here means "no holdings on either source".
      emptyOverride: section.lines.length === 0,
    });

    // Never cache an empty result: the AMC publishes monthly and a miss taken
    // an hour before that write would otherwise be served for the whole TTL.
    if (!envelope.empty) {
      await writeCache(NS, "_global", cacheKey, envelope, undefined, { ttl });
    }
    return { success: true, data: envelope };
  } catch (error) {
    console.error("getMfPortfolioSection error:", error);
    return { success: false, error: "Failed to load fund portfolio" };
  }
}
