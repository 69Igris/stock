/**
 * The venue vocabulary the quote path accepts — MONEY-1309.
 *
 * `symbol-mapper.ts` declares `Exchange = "NSE" | "BSE"` and every function in
 * it acts on that promise: `toYahooSymbol` appends `.BO` for BSE and `.NS` for
 * everything else. Widening THAT type in place would have been the cheap move
 * and the wrong one — it would silently re-type ~40 India-only call sites,
 * several of which branch with `exchange === "BSE" ? … : …` and would therefore
 * start treating NASDAQ as NSE without a single compile error. The `DOW.NS`
 * synthesis on the stock page is that bug in its finished form.
 *
 * So the India type is left exactly as it was and the union happens HERE, at
 * the one seam that has to speak both: the quote providers, the quote route, the
 * SSE stream and the polling hook.
 *
 * ## Why the guard delegates to core
 *
 * `TIINGO_US_EXCHANGES` (packages/core/.../tiingo-logic.ts) is the single
 * runtime list of American venues — `marketForExchange` already reads it, and
 * carries the note about what a second spelling of that list cost the sector
 * taxonomy. A copy here would be a second answer to "is this venue American?"
 * that agrees today and drifts the moment a venue is added. The literal union
 * that TypeScript needs is a MIRROR of that set, declared in core beside it and
 * pinned against it by a test.
 *
 * Everything re-exported here is pure — no Prisma, no Redis, no network — so a
 * client component may import it.
 */

import {
  isUsExchange as coreIsUsExchange,
  normalizeUsExchange as coreNormalizeUsExchange,
  type UsExchange,
} from "@usemoney/core/market-data/tiingo/tiingo-rt-read-logic";

import type { Exchange } from "@/lib/market/symbol-mapper";

export type { UsExchange };

/** Any venue the quote path can be asked for: India's two, or a US one. */
export type QuoteExchange = Exchange | UsExchange;

/**
 * True when this venue is American and must NOT go through `toYahooSymbol`.
 *
 * A TYPE PREDICATE on the first overload, and that is the load-bearing half:
 * `if (isUsExchange(x)) … else …` narrows the else branch of a `QuoteExchange`
 * back to the India-only `Exchange`, so every India call site keeps its exact
 * old type and the compiler — not a reviewer — is what stops a US venue reaching
 * `toYahooSymbol`. Without the predicate the union would have to be cast away at
 * each of those call sites, which is the same thing as not widening the type at
 * all. The second overload keeps it usable on an unvalidated query string.
 */
export function isUsExchange(value: QuoteExchange): value is UsExchange;
export function isUsExchange(value: string | null | undefined): boolean;
export function isUsExchange(value: string | null | undefined): boolean {
  return coreIsUsExchange(value);
}

/** Canonical spelling of a US venue, or `null` when it is not one of ours. */
export function normalizeUsExchange(
  value: string | null | undefined
): UsExchange | null {
  return coreNormalizeUsExchange(value);
}

/**
 * Resolve a raw `?exchange=` parameter.
 *
 * A recognised US venue is returned in its canonical spelling; BSE is BSE;
 * EVERYTHING else — including an unrecognised string — is NSE.
 *
 * ## The doc used to say that and the code did not do it
 *
 * It was `(value || "NSE") as Exchange`, which returns "NSE" only for an EMPTY
 * value. `?exchange=LSE` was CAST into a two-member union it is not a member of
 * and handed on: `toYahooSymbol` suffixes anything that is not BSE with `.NS`,
 * so the request quietly became an NSE one — the same prices the documented
 * behaviour promises, but reached by laundering an unvalidated query string
 * through a lie to the compiler. Every `exchange === "BSE" ? … : …` branch
 * downstream, and the response's echoed `exchange`, then reason about a value
 * whose type is wrong.
 *
 * The cast is gone. The two India venues are enumerated, so the return value is
 * always a real member of {@link QuoteExchange} and the documented fallback is
 * what the code does rather than what it is described as doing.
 */
export function resolveQuoteExchange(
  value: string | null | undefined
): QuoteExchange {
  const us = coreNormalizeUsExchange(value);
  if (us !== null) return us;
  const india: Exchange = value?.trim().toUpperCase() === "BSE" ? "BSE" : "NSE";
  return india;
}
