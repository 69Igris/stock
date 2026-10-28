// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

/**
 * Stock Detail Page - Server Component
 *
 * Fetches instrument data from InstrumentMapping and renders the client component.
 * URL: /stock/RELIANCE?exchange=NSE
 *
 * ## MONEY-1205 — this route is not the fund route
 *
 * Six of the eight link sites in the app sent ETFs here, to a page built around
 * OHLC / P-E / EPS — which its own comment history already calls "wrong for
 * funds". `lib/fund/instrument-href` fixes the sites that KNOW an instrument's
 * type; the redirect below is what catches the ones that cannot, because a
 * watchlist item and a holdings row carry only a symbol and an exchange (see
 * `WatchlistItem` in schema.prisma). Both halves are needed: the helper keeps
 * the URL honest when we know better, the redirect keeps the PAGE honest when
 * we do not.
 *
 * It follows the shape of the numeric scheme-code redirect immediately below,
 * which has sent `/stock/119551` to `/mf/119551` since long before this ticket.
 *
 * ## MONEY-1309 — the US branch, and what "thin" buys
 *
 * `instrument_mappings` is India-only. Ask this page for `AAPL` and it misses
 * every lookup, falls through to the synthesised block at the bottom and
 * fabricates `yahooSymbol: "AAPL.NS"` — an NSE-shaped symbol Yahoo will happily
 * answer with something. `DOW` is the vivid case: `DOW.NS` is a real, different
 * company, so the page renders a confident wrong price rather than an error.
 *
 * The branch below resolves US tickers against `us_instruments` through
 * `resolveInstrument` and renders `UsStockClient`. It sits BEFORE the synthesis
 * and AFTER the India lookups, so a dual-listed India symbol is untouched.
 *
 * It is gated on the EXISTING `us-stocks-listing` flag (default false,
 * founder-targeted in PostHog). Flag OFF is not "show a broken page" — it is the
 * pre-existing behaviour exactly, including the synthesis, because changing what
 * an un-flagged user sees is not what a flag is for.
 */

import { prisma } from "@usemoney/database";
import StockDetailClient from "./client";
import ChartPreloadLinks from "@/components/charts/ChartPreloadLinks";
import UsStockClient from "./us-client";
import { notFound, redirect } from "next/navigation";
import { instrumentDetailHref } from "@/lib/fund/instrument-href";
import { resolveInstrument } from "@usemoney/core/market-data/instruments/resolve-instrument";
import { getUsFeatureFlags } from "@/lib/actions/feature-flags";
import { isDemoSession } from "@/lib/demo/session";
import { stockPageShowsChart } from "@/lib/charts/preload-gate";
import { currentUserMaySeeUsMarket } from "@/lib/market/us-access";
import { noteUsSymbolInterest } from "@/lib/market/us-interest";

interface StockPageProps {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ exchange?: string; type?: string }>;
}

export default async function StockPage({
  params,
  searchParams,
}: StockPageProps) {
  const { symbol } = await params;
  // MONEY-1255 — read the RAW param so "the caller asked for NSE" and "the
  // caller said nothing" stay distinguishable. Defaulting at the destructure
  // collapsed them, which is what made a BSE-only company unreachable: its
  // page resolved against exchange="NSE", missed, and every downstream numeric
  // read was then scoped to an exchange the company is not listed on.
  const { exchange: exchangeParam, type } = await searchParams;
  const exchangeExplicit =
    typeof exchangeParam === "string" && exchangeParam.trim() !== "";
  const exchange = exchangeExplicit ? exchangeParam : "NSE";

  const decodedSymbol = decodeURIComponent(symbol).toUpperCase();

  // Check if this is a mutual fund scheme code (purely numeric)
  if (/^\d+$/.test(decodedSymbol)) {
    try {
      const mf = await prisma.mutualFundMaster.findUnique({
        where: { schemeCode: decodedSymbol },
        select: { schemeCode: true },
      });
      if (mf) {
        redirect(
          instrumentDetailHref({
            symbol: mf.schemeCode,
            instrumentType: "MF",
          })
        );
      }
    } catch (e) {
      // redirect() throws a Next.js control-flow error — re-throw it, or the
      // MF redirect silently degrades to rendering an equity page for a scheme
      // code. (Pre-existing: this catch swallowed it.)
      if (e && typeof e === "object" && "digest" in e) throw e;
      // DB unavailable - continue to stock page
    }
  }

  // Fetch instrument from DB
  let instrument = null;
  try {
    instrument = await prisma.instrumentMapping.findFirst({
      where: {
        symbol: decodedSymbol,
        exchange: exchange.toUpperCase(),
        isActive: true,
      },
      select: {
        id: true,
        symbol: true,
        name: true,
        exchange: true,
        yahooSymbol: true,
        isin: true,
        sector: true,
        industry: true,
        description: true,
        instrumentType: true,
      },
    });
  } catch {
    // DB unavailable - continue with basic data
  }

  // An ETF is a fund. `/etf/[symbol]` is its canonical route and a strict
  // superset of what this page can show it: LTP, iNAV, premium/discount,
  // TradingView, the real AMC, and the AMC's own filed portfolio disclosure.
  // Outside the try/catch above on purpose — `redirect()` signals by throwing.
  if (instrument?.instrumentType === "ETF") {
    redirect(
      instrumentDetailHref({
        symbol: instrument.symbol,
        exchange: instrument.exchange,
        instrumentType: "ETF",
      })
    );
  }

  // MONEY-1255 — the caller named no exchange and NSE had nothing. Before
  // falling back to a synthesised NSE row, look the symbol up on ANY exchange.
  //
  // 2,389 real companies are listed on BSE with no NSE row. Without this they
  // resolve to the synthetic block below stamped `exchange: "NSE"`, and every
  // numeric read downstream (`stock-tabs.ts`, `stock-tabs.service.ts`) is
  // exchange-scoped — so the page renders an EMPTY Financials tab beside a
  // POPULATED Documents tab, because the documents read on symbol alone.
  //
  // NSE first, so a dual-listed company is unaffected: it already matched
  // above and never reaches here.
  if (!instrument && !exchangeExplicit) {
    try {
      instrument = await prisma.instrumentMapping.findFirst({
        where: { symbol: decodedSymbol, isActive: true },
        orderBy: { exchange: "asc" }, // "BSE" < "NSE"; NSE already tried above
        select: {
          id: true,
          symbol: true,
          name: true,
          exchange: true,
          yahooSymbol: true,
          isin: true,
          sector: true,
          industry: true,
          description: true,
          instrumentType: true,
        },
      });
    } catch {
      // A lookup failure here is not worth failing the page for — the
      // synthesised block below still renders a usable shell.
    }
  }

  // MONEY-1309 — nothing in India matched. Before synthesising an NSE row (and
  // with it a `.NS` symbol for a company that has never traded in India), ask
  // the US collection.
  //
  // The flag is read INSIDE the miss, not at the top of the function: a flag
  // evaluation is an `auth()` plus a possible Clerk round trip, and every India
  // page view would otherwise pay for it to learn something it does not use.
  if (!instrument) {
    const { flags } = await getUsFeatureFlags();
    // BOTH must pass. `us-stocks-listing` is the product flag and answers "is
    // this surface ready"; `currentUserMaySeeUsMarket` is the LICENCE gate and
    // answers "may this person receive US prices at all". They are different
    // questions with different failure modes: a PostHog flag is remote
    // configuration that can be flipped from a dashboard by someone who does
    // not know it is load-bearing for a licence, so the licence side is
    // enforced in code with a founder-only default (MONEY-1262).
    if (flags["us-stocks-listing"] && (await currentUserMaySeeUsMarket())) {
      // `market: "US"` rather than a bare symbol: 214 tickers exist in BOTH
      // collections, and a bare resolve would let one market's ranking answer
      // for the other. India has already had its turn above, so this call is
      // asking a narrower question than "who owns this ticker".
      const resolved = await resolveInstrument({
        symbol: decodedSymbol,
        market: "US",
      }).catch(() => null);

      if (resolved?.status === "RESOLVED") {
        const us = resolved.instrument;
        // Fire-and-forget, off the render's critical path. See the module note
        // — a subscription hint must never be able to fail a page.
        noteUsSymbolInterest(us.symbol, us.exchange);
        return (
          <UsStockClient
            symbol={us.symbol}
            name={us.name ?? us.symbol}
            exchange={us.exchange}
            assetType={us.assetType}
            listingId={us.listingId}
          />
        );
      }
    }
  }

  // If not found in DB, construct minimal data from URL params
  const instrumentData = instrument ?? {
    id: null,
    symbol: decodedSymbol,
    name: decodedSymbol,
    exchange: exchange.toUpperCase(),
    yahooSymbol:
      type === "index"
        ? decodedSymbol
        : `${decodedSymbol}.${exchange.toUpperCase() === "BSE" ? "BO" : "NS"}`,
    isin: null,
    sector: null,
    industry: null,
    description: null,
    instrumentType: type === "index" ? "INDEX" : "EQUITY",
  };

  // MONEY-1383 (L2): the preload is only worth issuing if this visitor's
  // render will MOUNT a chart. `client.tsx` replaces it with "Charts disabled
  // in demo mode", so a demo visitor was downloading 2.5 MB no document ever
  // executes. Awaited HERE rather than at the top of the function: the US
  // branch above returns before this, and an India page view should not pay
  // for a signal it does not use. `isDemoSession()` short-circuits on a Clerk
  // session, so a signed-in user pays one local `auth()` read.
  const preloadChart = stockPageShowsChart({ isDemo: await isDemoSession() });

  return (
    <>
      {/* MONEY-1383 (L2): rendered OUTSIDE <PageGuard>, so the 2.5 MB
          charting library starts downloading with the document instead of
          after the ~0.6s /api/subscription/access round-trip the guard
          blocks on before mounting the chart. */}
      {preloadChart && <ChartPreloadLinks />}
      <StockDetailClient
        symbol={instrumentData.symbol}
        name={instrumentData.name}
        exchange={instrumentData.exchange}
        yahooSymbol={instrumentData.yahooSymbol}
        instrumentId={instrumentData.id}
        isin={instrumentData.isin}
        sector={instrumentData.sector}
        industry={instrumentData.industry}
        description={instrumentData.description}
        instrumentType={instrumentData.instrumentType}
      />
    </>
  );
}

export async function generateMetadata({
  params,
  searchParams,
}: StockPageProps) {
  const { symbol } = await params;
  const { exchange } = await searchParams;
  const decodedSymbol = decodeURIComponent(symbol).toUpperCase();

  // MONEY-1255 — name an exchange only when the CALLER named one.
  //
  // This used to default to "NSE", which put a factual claim in the <title>
  // and meta description for 2,389 BSE-only companies — text search engines
  // index. Resolving the real exchange would mean a DB query on a path that
  // is deliberately query-free, and the honest cheap answer is available:
  // say the symbol and stop. An omitted exchange is accurate for every
  // company; a guessed one is wrong for 2,389 of them.
  const named = typeof exchange === "string" && exchange.trim() !== "";
  const venue = named ? exchange.trim().toUpperCase() : null;

  return {
    // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
    title: venue ? `${decodedSymbol} - ${venue}` : decodedSymbol,
    description: venue
      ? `View live price chart, key stats, and analysis for ${decodedSymbol} on ${venue}`
      : `View live price chart, key stats, and analysis for ${decodedSymbol}`,
  };
}
