/**
 * DelayedDataNote — data-freshness disclaimer (MONEY-566, MONEY-1259, MONEY-1309).
 *
 * Renders a small, inline, theme-aware note on market-data surfaces so the
 * disclaimer travels with the data rather than sitting in fixed page chrome.
 *
 * ## It used to gate on broker status, and that premise is dead
 *
 * The original built on this claim: "active-broker users receive real-time data
 * under their own access token", so the note was HIDDEN for them and everyone
 * else additionally saw a `connect a broker for real-time` link to /brokers.
 *
 * MONEY-837 invalidated it. Portfolio sync runs on the FREE Zerodha "Personal"
 * app, which has no live quotes, no charts and no WebSockets; the paid
 * "Connect" app is founder-only and dormant. Runtime market data in apps/web is
 * **Yahoo — exchange-delayed — for every user**, broker connected or not.
 *
 * That made the component wrong twice over, in opposite directions:
 *
 *   - The CTA promised something connecting a broker cannot deliver. It routed
 *     users to /brokers on a false pretext.
 *   - The gate SUPPRESSED the disclaimer for active-broker users, who receive
 *     exactly the same delayed feed — hiding a compliance disclosure from the
 *     users most likely to assume they are seeing real-time prices.
 *
 * ## MONEY-1309 — it is conditional again, on the DATA
 *
 * The note above ended with the condition under which that would be allowed:
 * "If live quotes ever ship, this becomes conditional again — but on whether the
 * QUOTE SOURCE is live, which is a property of the data, not of the viewer."
 * US symbols served out of our own realtime quote keys are that case, so the
 * `provenance` prop is now honoured — and the distinction it draws is exactly
 * the one that note prescribed:
 *
 *   - `provenance` OMITTED, or a delayed/EOD/fallback one → the disclaimer,
 *     unchanged. Omission is the conservative reading on purpose. Every existing
 *     mount (`TradingViewAdvancedChart`, which is the single mount every chart
 *     surface renders through) passes nothing and therefore keeps today's
 *     behaviour byte for byte.
 *   - a live one → a freshness badge instead. It is still a disclosure, not the
 *     absence of one: it says which feed and when.
 *
 * The decision itself is NOT made here. {@link isLiveQuote} — core's
 * `isLiveQuoteProvenance`, re-exported by the quote route's pure logic — is the
 * one place that answers it, and the response envelope's `delayed` flag and
 * apps/api's per-quote `delayed` read the same function. The payload and the
 * disclosure cannot drift apart, which is how MONEY-1259 happened.
 *
 * ## It takes the whole PROVENANCE, and that is the fix, not a refactor
 *
 * The prop used to be `source?: string`, and this component asked
 * `isLiveQuoteSource(source)` — it never read `fallback`. `decideUsQuote` could
 * emit `{source:"TIINGO_RT", fallback:true}` (the last quote before the feed
 * went quiet), and that rendered here as a green `Live quote · 05:30 am` badge
 * WITH THE COMPLIANCE DISCLAIMER REPLACED BY IT — on the same header whose
 * `ProvenanceChip` was correctly showing an amber `fallback` pill. One fact, two
 * consumers, one of them reading half of it.
 *
 * Adding a second condition at the call site would have been the small fix and
 * the wrong one: a second condition is what created this. The prop is now the
 * provenance OBJECT, so a caller cannot hand this component a source while
 * withholding the flag that qualifies it, and the US panel passes the SAME
 * object to both renderers.
 *
 * `FundChartCard` opts out via `showDelayedDataNote={false}`, correctly: an MF
 * NAV is a published end-of-day value, not a delayed quote.
 */

import { Clock, Radio } from "lucide-react";

import { isLiveQuote } from "@/app/api/market/quote/quote-logic";

/**
 * The provenance of the number on screen.
 *
 * Structurally the same object `ProvenanceChip` takes (`SectionProvenance`), so
 * one surface hands the identical value to both and they cannot disagree.
 * Every field is optional and every absence fails CLOSED — an unknown
 * provenance is a delayed one.
 */
export interface QuoteNoteProvenance {
  source?: string | null;
  /** ISO market timestamp of the number on screen, when known. */
  asOf?: string | null;
  /** True when this is not the preferred provider — i.e. not a live quote. */
  fallback?: boolean | null;
}

interface DelayedDataNoteProps {
  className?: string;
  /**
   * Where the number on screen came from, as reported by `/api/market/quote`.
   * Omitted means "unknown", which is treated as delayed.
   */
  provenance?: QuoteNoteProvenance | null;
}

/** "14:32:05" in the viewer's locale — a quote's age is a clock, not a date. */
function formatQuoteTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DelayedDataNote({
  className,
  provenance,
}: DelayedDataNoteProps) {
  const wrapper = `inline-flex items-center gap-1 text-[11px] leading-tight${
    className ? ` ${className}` : ""
  }`;

  if (isLiveQuote(provenance)) {
    const at = formatQuoteTime(provenance?.asOf);
    return (
      <span
        className={`${wrapper} text-emerald-500`}
        role="note"
        title={
          at
            ? `Streaming quote, last updated ${at}.`
            : "Streaming quote from the consolidated feed."
        }
      >
        <Radio size={11} aria-hidden className="shrink-0" />
        <span>Live quote{at ? ` · ${at}` : ""}</span>
      </span>
    );
  }

  return (
    <span
      className={`${wrapper} text-muted-foreground`}
      role="note"
      title="Quotes and charts are exchange-delayed."
    >
      <Clock size={11} aria-hidden className="shrink-0" />
      <span>Exchange-delayed data</span>
    </span>
  );
}
