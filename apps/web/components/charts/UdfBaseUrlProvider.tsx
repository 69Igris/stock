"use client";

/**
 * Carries the resolved `/udf` origin from the SERVER to the chart.
 * MONEY-1468 (A3).
 *
 * ## WHY A PROVIDER AND NOT A PROP
 *
 * The decision needs `PlatformConfig` — a Mongo row, so server-only — and the
 * chart is a client component with six call sites, several of which sit inside
 * client trees with no server parent to thread from. A prop would have to be
 * passed at every one of them, and the one that got missed would silently keep
 * the old route while the flag read "on".
 *
 * That is not hypothetical: the first version of this change shipped the prop
 * and the resolver and wired NEITHER, so flipping `MARKET_DATA_TILES` in prod
 * changed nothing at all. One provider in the root layout is one place to get
 * right and one place to check.
 *
 * The default is the legacy route, so a tree rendered without the provider
 * behaves exactly as it did before.
 */
import { createContext, useContext, type ReactNode } from "react";
import { LEGACY_UDF_BASE_URL } from "@usemoney/core/market-data/udf/datafeed-target";
import { LEGACY_QUOTE_URL } from "@usemoney/core/market-data/quotes/quotes-target";

const UdfBaseUrlContext = createContext<string>(LEGACY_UDF_BASE_URL);

export function UdfBaseUrlProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <UdfBaseUrlContext.Provider value={value || LEGACY_UDF_BASE_URL}>
      {children}
    </UdfBaseUrlContext.Provider>
  );
}

/** The `/udf` origin for this tree. Defaults to the legacy route. */
export function useUdfBaseUrl(): string {
  return useContext(UdfBaseUrlContext);
}

/* ─────────────────────────────────────────────────────────────────────────
   Quotes — MONEY-1469 (A4). Same shape, same reasons, one file.
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The quote-poll origin, resolved on the server and carried to the poller.
 *
 * It lives beside the UDF one rather than in its own file because the argument
 * is identical and the wiring is the piece that goes wrong: A3's first cut
 * shipped a resolver with zero callers and flipping the flag changed nothing.
 * One provider component in the root layout is one place to get right.
 */
const QuotesBaseUrlContext = createContext<string>(LEGACY_QUOTE_URL);

export function QuotesBaseUrlProvider({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  return (
    <QuotesBaseUrlContext.Provider value={value || LEGACY_QUOTE_URL}>
      {children}
    </QuotesBaseUrlContext.Provider>
  );
}

/** The quote origin for this tree. Defaults to the legacy web route. */
export function useQuotesBaseUrl(): string {
  return useContext(QuotesBaseUrlContext);
}
