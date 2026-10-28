"use client";

/**
 * Analyst snapshot card for the stock-detail Overview tab (MONEY-796 item 3).
 *
 * Renders the THIRD-PARTY analyst consensus carried on `StockRatios`
 * (targetPrice + recommendation) plus the implied upside-to-target vs the
 * live price. SEBI-safe: this is explicitly labelled as external data
 * ("Analyst consensus · informational"), NOT a UseMoney recommendation. We
 * surface the recommendation string as a neutral DATA chip and never turn it
 * into an action prompt. A dashed-top disclaimer matches the styling used in
 * the research report / roast surfaces.
 *
 * The card self-suppresses when the row carries neither a target nor a
 * recommendation — nothing to show.
 *
 * ## MONEY-1235 — and when the row is OLD
 *
 * Self-suppressing on "no target AND no recommendation" was the only gate, and
 * it stopped being enough. `targetPrice` and `recommendation` are the two
 * `StockRatios` columns that NOTHING writes any more: `xbrl-ratios-daily`
 * derives 23 of the model's 25 columns from our own filings and close history
 * and deliberately leaves these alone, because sell-side opinion is not in a
 * filing and not reproducible from a price series. Tickertape, which used to
 * write them, now returns 403 to our Cloud Run egress.
 *
 * So the values freeze while the price does not, and `upsideToTargetPct`
 * happily computes a "+18.4% VS LTP" from a five-month-old consensus against
 * today's LTP — a confident, moving, wrong number, which is worse than a
 * missing one because nothing about it looks broken. Two guards follow:
 *
 *  1. An AGE GATE on `fetchedAt` (180 days). `fetchedAt` is the honest stamp
 *     for exactly these two columns — the nightly derive stamps
 *     `ratiosDerivedAt` instead, specifically so this one keeps meaning "when
 *     an upstream last supplied the analyst fields".
 *  2. The attribution no longer names `data.source`. After the ratios switchover
 *     that column reads `NSE_XBRL` on a row whose analyst fields are still
 *     Tickertape's, so "estimates aggregated by NSE_XBRL" credits the exchange's
 *     filing system with a broker's price target. The card now dates the
 *     estimates instead of attributing them.
 */

import { useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import {
  getStockRatiosAction,
  type StockRatiosData,
} from "@/lib/actions/stock-tabs";
import { upsideToTargetPct } from "@/lib/actions/stock-detail-logic";
import { formatNumber } from "@/app/stock/[symbol]/stock-format";
import { SEBI_SHORT } from "@/components/chat/blocks/ChatBlock";

interface Props {
  symbol: string;
  exchange: string;
  /** Live LTP from the page's quote hook, for the upside-to-target figure. */
  currentPrice: number | null;
}

/**
 * How old an analyst consensus may be before the card stops showing it.
 *
 * 180 days ≈ two reporting cycles. A price target that has survived two sets of
 * results without being re-issued is not a current view of the company, and
 * pricing it against a live LTP implies it is.
 */
export const ANALYST_MAX_AGE_DAYS = 180;

/**
 * True when the analyst fields are too old to show against a live price.
 *
 * `now` is a parameter so the rule is testable without freezing the clock.
 *
 * An ABSENT or unparseable `fetchedAt` counts as STALE — fail closed. The
 * column is `DateTime @default(now())` and non-null in the schema, so a missing
 * value means the payload could not tell us; and "we don't know how old this
 * target is" is not a licence to render it beside a live LTP. The distinction
 * matters enough that it is written down rather than inferred from `!fetchedAt`
 * at the call site.
 */
export function isAnalystConsensusStale(
  fetchedAt: string | null | undefined,
  now: number = Date.now(),
  maxAgeDays: number = ANALYST_MAX_AGE_DAYS
): boolean {
  const t = fetchedAt ? new Date(fetchedAt).getTime() : NaN;
  if (!Number.isFinite(t)) return true;
  return now - t > maxAgeDays * 24 * 60 * 60 * 1000;
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * `12 Mar 2026`, in UTC and without `Intl`.
 *
 * A deliberate twin of the one in `StockFinancialsTab.tsx` rather than a shared
 * import: pulling it across would drag that component's `financials-playful.css`
 * side-effect import into the Overview bundle for the sake of four lines.
 */
export function formatAnalystAsOf(
  iso: string | null | undefined
): string | null {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function StockAnalystSnapshot({
  symbol,
  exchange,
  currentPrice,
}: Props) {
  const [data, setData] = useState<StockRatiosData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStockRatiosAction(symbol, exchange)
      .then((r) => {
        if (cancelled) return;
        if (r.success) setData(r.data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  const target = data?.targetPrice ?? null;
  const recommendation = data?.recommendation ?? null;
  const hasAnything =
    target != null || (recommendation && recommendation.trim());
  // MONEY-1235 — the age gate. Read from `fetchedAt`, NOT from `dataAsOf`:
  // `dataAsOf` is `max(fetchedAt, ratiosDerivedAt)` and moves every night the
  // derive runs, so gating on it would keep a frozen 2026-03 consensus on
  // screen forever on the strength of a freshly recomputed margin.
  const consensusStale = isAnalystConsensusStale(data?.fetchedAt);
  const asOf = formatAnalystAsOf(data?.fetchedAt);

  // Nothing to render until we know there's data — and suppress entirely when
  // the synced row has no analyst fields, or when the ones it has are too old
  // to be priced against a live LTP.
  if (loading) return <AnalystSkeleton />;
  if (!data || !hasAnything || consensusStale) return null;

  const upside = upsideToTargetPct(currentPrice, target);
  const upsidePositive = upside != null && upside >= 0;

  return (
    <div
      className="pf-card"
      style={{ padding: 16, marginBottom: 24, background: "var(--paper-2)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Landmark size={14} style={{ color: "var(--ink-3)" }} aria-hidden />
        <div className="ttl" style={{ color: "var(--ink-3)" }}>
          ANALYST CONSENSUS · INFORMATIONAL
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          display: "flex",
          flexWrap: "wrap",
          gap: 22,
          alignItems: "flex-end",
        }}
      >
        {target != null && (
          <div>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9.5,
                letterSpacing: 1,
                fontWeight: 700,
                color: "var(--ink-3)",
              }}
            >
              CONSENSUS TARGET
            </div>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 26,
                fontWeight: 800,
                letterSpacing: -1,
                color: "var(--ink)",
                lineHeight: 1.05,
                marginTop: 3,
              }}
            >
              ₹{formatNumber(target)}
            </div>
          </div>
        )}

        {upside != null && (
          <div>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9.5,
                letterSpacing: 1,
                fontWeight: 700,
                color: "var(--ink-3)",
              }}
            >
              VS LTP
            </div>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: -0.5,
                color: upsidePositive ? "var(--emerald)" : "var(--pop-1)",
                lineHeight: 1.05,
                marginTop: 3,
              }}
            >
              {upsidePositive ? "+" : "−"}
              {Math.abs(upside).toFixed(1)}%
            </div>
          </div>
        )}

        {recommendation && recommendation.trim() && (
          <div>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9.5,
                letterSpacing: 1,
                fontWeight: 700,
                color: "var(--ink-3)",
              }}
            >
              CONSENSUS RATING
            </div>
            {/* Rendered as a neutral DATA chip — never as a UseMoney verdict. */}
            <div style={{ marginTop: 5 }}>
              <span
                className="pf-pill outline"
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {recommendation}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Dashed-top disclaimer — same treatment as research / roast surfaces. */}
      <div
        style={{
          marginTop: 14,
          paddingTop: 10,
          borderTop: "1px dashed var(--rule-soft)",
          fontFamily: "Instrument Serif, serif",
          fontStyle: "italic",
          fontSize: 12,
          color: "var(--ink-3)",
          lineHeight: 1.4,
        }}
      >
        {/* MONEY-1235 — this used to read "aggregated by {data.source}". After
            the ratios switchover `source` is `NSE_XBRL` on a row whose analyst
            fields are still Tickertape's frozen values, so that sentence
            credited the exchange's filing system with a broker's price target.
            Nothing writes these two columns any more, so there is no current
            attribution to give — the honest substitute is the DATE. */}
        Third-party analyst estimates
        {asOf ? `, last updated ${asOf}` : ""}, shown as data — not a UseMoney
        recommendation. {SEBI_SHORT}
      </div>
    </div>
  );
}

function AnalystSkeleton() {
  return (
    <div
      className="pf-card"
      style={{ padding: 16, marginBottom: 24, background: "var(--paper-2)" }}
    >
      <div
        className="animate-pulse"
        style={{
          height: 10,
          width: 200,
          background: "var(--rule-soft)",
          borderRadius: 4,
        }}
      />
      <div
        className="animate-pulse"
        style={{
          height: 30,
          width: 260,
          background: "var(--rule-softer)",
          borderRadius: 7,
          marginTop: 14,
        }}
      />
    </div>
  );
}

export default StockAnalystSnapshot;
