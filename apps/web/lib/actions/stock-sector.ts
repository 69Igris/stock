"use server";

/**
 * On-Demand Sector Enrichment
 *
 * When a user visits /stock/[symbol] and the sector is null in InstrumentMapping,
 * this action fetches sector/industry from Yahoo Finance's quoteSummary assetProfile
 * and persists it for future requests.
 *
 * Works even if InstrumentMapping doesn't have a record - constructs the Yahoo
 * symbol from symbol+exchange and returns sector without persisting.
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
import {
  yahooFetchQuoteSummary,
  normalizeToNseSector,
  toWritableNseSector,
  isSectorBearing,
  sectorWritableWhere,
} from "@usemoney/core/market-data";
import { buildYahooSymbol } from "@/lib/actions/stock-sector-logic";

interface AssetProfile {
  sector?: string;
  industry?: string;
}

export async function getOrEnrichSectorAction(
  symbol: string,
  exchange: string
): Promise<{
  success: boolean;
  sector?: string;
  industry?: string;
  error?: string;
}> {
  try {
    // Try cache first
    const filters = { symbol, exchange };
    const cached = await getCached<{ sector: string; industry?: string }>(
      "instrument",
      "_global",
      "sector",
      filters
    );
    if (cached) {
      return {
        success: true,
        sector: cached.sector,
        industry: cached.industry,
      };
    }

    // Try to find existing instrument in DB
    const instrument = await prisma.instrumentMapping.findFirst({
      where: { symbol, exchange, isActive: true },
      select: {
        id: true,
        sector: true,
        industry: true,
        yahooSymbol: true,
        // MONEY-1093: needed to decide whether this row may carry a sector at
        // all. Not filtered in the `where` on purpose — /stock/[symbol] renders
        // bonds too, and this action still has to return a sector-less answer
        // for them rather than behaving as if the instrument did not exist.
        instrumentType: true,
      },
    });

    // Already has sector - return it and cache
    if (instrument?.sector) {
      const result = {
        sector: instrument.sector,
        industry: instrument.industry ?? undefined,
      };
      await setCached("instrument", "_global", "sector", result, filters);
      return { success: true, ...result };
    }

    // MONEY-1093: a bond has an issuer, not a sector. Bail BEFORE the Yahoo
    // call — this is reachable for real: /stock/[symbol] looks a row up with no
    // instrumentType filter, so a G-Sec/SGB/NCD held at Zerodha renders as a
    // stock page, sees `sector === null`, and fires this action. Yahoo will
    // happily return a sector for the bond's issuer, which is how bonds got
    // sectors in the first place.
    //
    // Only rows that ALREADY have a sector short-circuit above, so without this
    // the nightly DEBT clear was undone on the next page view — permanently,
    // because `planMetadataBackfill` only ever revisits rows still typed EQUITY.
    if (instrument && !isSectorBearing(instrument.instrumentType)) {
      return { success: false, error: "No sector data available" };
    }

    // Build Yahoo symbol: prefer DB record, fall back to construction
    const yahooSymbol =
      instrument?.yahooSymbol || buildYahooSymbol(symbol, exchange);

    // Fetch from Yahoo Finance quoteSummary
    const quoteSummary = await yahooFetchQuoteSummary(yahooSymbol, [
      "assetProfile",
    ]);

    const profile = quoteSummary?.assetProfile as AssetProfile | undefined;

    if (!profile?.sector) {
      return { success: false, error: "No sector data available" };
    }

    const normalizedSector = normalizeToNseSector(profile.sector);
    const industry = profile.industry ?? null;

    // Persist if we have a DB record.
    //
    // `updateMany`, not `update`: the type predicate re-checks the invariant at
    // WRITE time, and `update` requires a unique `where` so it cannot carry one.
    // The re-check is not redundant with the early return above — the Yahoo
    // fetch sits between them, and the nightly bhavcopy writer (21:00 IST) can
    // retype this exact row to DEBT inside that window.
    //
    // MONEY-1302 — the taxonomy axis, on top of the type axis above.
    // `normalizeToNseSector` ends in `return rawSector`: it maps the known GICS
    // strings and passes every OTHER label through verbatim. This action fires
    // on stock-page visits, so an unmapped label was persisted raw and
    // continuously — and such a row never heals, because the screener's sector
    // facet cannot reach an off-taxonomy value and `sector-enrichment.ts` only
    // re-selects rows whose sector is null/empty.
    //
    // `toWritableNseSector` rejects anything off-taxonomy; a rejection SKIPS
    // the write. Skipping is the recoverable direction — the row keeps its
    // missing sector and the next visit retries, whereas one off-taxonomy write
    // is permanent.
    //
    // The RETURNED value deliberately keeps the passthrough. Display of a raw
    // bucket is the documented read-side behaviour (see the facet-section
    // header in sector-taxonomy.ts — the heatmap is a diagnostic surface), and
    // narrowing the response here would change this action's contract for a
    // problem that is purely about what gets STORED.
    const writableSector = toWritableNseSector(profile.sector);
    if (instrument && writableSector !== null) {
      await prisma.instrumentMapping.updateMany({
        where: { id: instrument.id, ...sectorWritableWhere() },
        data: {
          sector: writableSector,
          industry,
        },
      });
    }

    const result = {
      sector: normalizedSector,
      industry: industry ?? undefined,
    };
    await setCached("instrument", "_global", "sector", result, filters);

    return { success: true, ...result };
  } catch {
    return { success: false, error: "Failed to fetch sector data" };
  }
}
