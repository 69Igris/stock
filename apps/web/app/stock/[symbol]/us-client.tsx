"use client";

/**
 * US stock panel — MONEY-1309.
 *
 * DELIBERATELY THIN. `StockDetailClient` is ~2,000 lines of India-shaped
 * surfaces: XBRL financials keyed on `stock_financials`, NSE shareholding, the
 * corporate-actions table, screener peers, the Documents tab — every one of them
 * reads a table whose rows are `exchange: "NSE" | "BSE"` and would render an
 * empty box for `AAPL`. Nineteen empty sections is a worse answer than four
 * populated fields, and pretending otherwise is how a "US page" ships looking
 * finished while carrying nothing.
 *
 * So this renders what we actually hold today — identity, venue, and the quote
 * with honest provenance — and nothing else. The tabs come back one at a time as
 * their US data source lands (`us_fundamentals` for financials, `Candle` for the
 * chart), each behind the same flag.
 *
 * ## Provenance is the point of the panel, not decoration
 *
 * A US price here is one of two things and the number cannot tell you which: a
 * streaming quote out of the realtime keys, or the previous session's close
 * standing in for one. `ProvenanceChip` (the SAME component nineteen
 * data-engine sections already use) says which, and `DelayedDataNote` says
 * whether it is live. Both read the response's own metadata; neither infers.
 *
 * ## They read the SAME OBJECT, and that is deliberate
 *
 * They used to read two derived values off it — the chip took `fallback`, the
 * note took `chipSource` — and the note's own predicate never looked at
 * `fallback`. So a `{source:"TIINGO_RT", fallback:true}` quote rendered an amber
 * `fallback` pill and a green `Live quote · 05:30 am` badge, two inches apart,
 * on the same header. The badge REPLACES the exchange-delayed disclaimer, so
 * that was a compliance disclosure swapped for a live-price claim.
 *
 * One object is now built once and handed to both. Nothing here decides what
 * "live" means; `isLiveQuote` (core, via the quote route's pure logic) does,
 * and the response envelope reads the identical function.
 */

import { useMemo } from "react";
import { Building2 } from "lucide-react";

import { useQuote } from "@/hooks/useMarketData";
import { ProvenanceChip } from "@/components/stock/SectionShell";
import DelayedDataNote from "@/components/market/DelayedDataNote";
import type { QuoteExchange } from "@/lib/market/quote-exchange";

interface UsStockClientProps {
  symbol: string;
  name: string;
  exchange: string;
  assetType: string | null;
  listingId: string | null;
}

/** US prices are USD. No FX here — dual denomination is MONEY-982. */
function formatUsd(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatSignedPercent(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export default function UsStockClient({
  symbol,
  name,
  exchange,
  assetType,
  listingId,
}: UsStockClientProps) {
  const options = useMemo(
    () => ({ exchange: exchange as QuoteExchange, interval: 10_000 }),
    [exchange]
  );
  const { quote, isLoading, error, source, meta } = useQuote(symbol, options);

  // Per-quote provenance is finer-grained than the envelope's single `source`
  // (a batch can mix a live quote with an EOD close), so prefer it and fall
  // back to the envelope only when a quote has not arrived yet.
  //
  // ONE object, built once. The envelope fallback maps `meta.delayed` onto
  // `fallback` — "the payload is delayed" and "this is not the preferred
  // provider" are the same claim at that granularity, and both mean NOT LIVE,
  // which is the conservative reading a missing per-quote provenance needs.
  const provenance = quote?.provenance;
  const quoteProvenance = useMemo(
    () => ({
      source: provenance?.source ?? source,
      asOf: provenance?.asOf ?? meta.asOf,
      fallback: provenance?.fallback ?? meta.delayed,
      note: provenance?.note,
    }),
    [
      provenance?.source,
      provenance?.asOf,
      provenance?.fallback,
      provenance?.note,
      source,
      meta.asOf,
      meta.delayed,
    ]
  );

  const up = (quote?.change ?? 0) >= 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-center gap-2">
        <Building2 className="h-4 w-4 text-emerald-400" aria-hidden />
        <h1 className="font-display text-[20px] font-bold tracking-[-0.3px]">
          {symbol}
        </h1>
        <span className="rounded border border-[var(--border)] px-1.5 py-px font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
          {exchange}
        </span>
        {assetType && (
          <span className="rounded border border-[var(--border)] px-1.5 py-px font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-muted)]">
            {assetType}
          </span>
        )}
        <ProvenanceChip {...quoteProvenance} />
      </header>

      <p className="mb-6 text-[15px] text-[var(--text-muted)]">{name}</p>

      <section className="rounded-lg border border-[var(--border)] p-5">
        {isLoading && !quote ? (
          <div
            className="h-8 w-40 animate-pulse rounded bg-[var(--surface-2)]"
            aria-label="Loading quote"
          />
        ) : error || !quote ? (
          <p className="text-[13px] text-[var(--text-muted)]">
            No quote available for {symbol} right now.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-display text-[32px] font-bold tracking-[-0.5px] tabular-nums">
                {formatUsd(quote.price)}
              </span>
              <span
                className={`font-mono text-[14px] tabular-nums ${
                  up ? "text-emerald-500" : "text-red-500"
                }`}
              >
                {up ? "+" : ""}
                {formatUsd(quote.change).replace("$", "")} (
                {formatSignedPercent(quote.changePercent)})
              </span>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
              <div>
                <dt className="text-[var(--text-dim)]">Open</dt>
                <dd className="tabular-nums">{formatUsd(quote.open)}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-dim)]">High</dt>
                <dd className="tabular-nums">{formatUsd(quote.high)}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-dim)]">Low</dt>
                <dd className="tabular-nums">{formatUsd(quote.low)}</dd>
              </div>
              <div>
                <dt className="text-[var(--text-dim)]">Prev close</dt>
                <dd className="tabular-nums">
                  {formatUsd(quote.previousClose)}
                </dd>
              </div>
            </dl>
          </>
        )}

        <div className="mt-4">
          <DelayedDataNote provenance={quoteProvenance} />
        </div>
      </section>

      {listingId && (
        // Surfaced because a US ticker is NOT a security: 2,196 tickers repeat
        // in Tiingo's master and 834 delisted rows share one with a live listing
        // (`DOW` is Dow Chemical 1972-2017 AND Dow Inc. 2019-). The listing id is
        // what every price read resolves to, so showing it makes "which company
        // is this" checkable rather than assumed.
        <p className="mt-4 font-mono text-[10px] uppercase tracking-[1px] text-[var(--text-dim)]">
          listing {listingId}
        </p>
      )}
    </div>
  );
}
