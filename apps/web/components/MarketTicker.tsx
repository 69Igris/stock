"use client";

import { cn } from "@usemoney/utils";
import {
  useMarketTickerStore,
  type IndexQuote,
  type MarketStatus,
} from "@/lib/stores/market-ticker";

type Market = "IN" | "US" | "MCX";
type MarketPhase = "PRE" | "OPEN" | "POST" | "CLOSED";

// Always-dark band to match the landing-page PlayfulTicker (theme-independent
// so contrast stays readable in both themes): #1d1d1b band, gold labels,
// cream values, green/red changes — fed by the LIVE market-ticker store.
const BAND = "#1d1d1b";
const GOLD = "#fcd34d";
const CREAM = "#f7f3e6";
const POS = "#4ade80";
const NEG = "#ff8a8a";

const PHASE_CONFIG: Record<MarketPhase, { label: string; dot: string }> = {
  PRE: { label: "PRE-MKT", dot: "#fbbf24" },
  OPEN: { label: "OPEN", dot: "#4ade80" },
  POST: { label: "POST-MKT", dot: "#60a5fa" },
  CLOSED: { label: "CLOSED", dot: "#9a9a92" },
};

const MARKET_LABELS: Record<Market, string> = {
  IN: "IND",
  US: "US",
  MCX: "MCX",
};

function MarketStatusBadge({ phase }: { phase: MarketPhase }) {
  const config = PHASE_CONFIG[phase];
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium">
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          phase !== "CLOSED" && "animate-pulse"
        )}
        style={{ background: config.dot }}
      />
      <span style={{ color: config.dot }}>{config.label}</span>
    </span>
  );
}

function formatPrice(price: number, market: Market): string {
  if (market === "US" || market === "MCX") {
    return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return price.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

export function MarketTicker() {
  const { indices, marketStatus } = useMarketTickerStore();

  if (indices.length === 0) {
    return (
      <div
        className="h-full flex items-center px-4"
        style={{ background: BAND, color: CREAM }}
      >
        <div className="flex gap-8 text-xs font-mono" style={{ color: GOLD }}>
          <span>Loading market data…</span>
        </div>
      </div>
    );
  }

  // Group by market for separator display (ordered: IND, MCX, US)
  const marketOrder: Market[] = ["IN", "MCX", "US"];

  const tickerSegment: Array<
    { type: "label"; market: Market } | { type: "quote"; quote: IndexQuote }
  > = [];

  for (const market of marketOrder) {
    const items = indices.filter((i) => i.market === market);
    if (items.length > 0) {
      tickerSegment.push({ type: "label", market });
      for (const item of items) {
        tickerSegment.push({ type: "quote", quote: item });
      }
    }
  }

  // Duplicate for seamless loop
  const tickerItems = [...tickerSegment, ...tickerSegment];

  return (
    <div
      className="h-full flex items-center overflow-hidden relative"
      style={{ background: BAND, color: CREAM }}
    >
      <div className="animate-marquee flex whitespace-nowrap gap-5 px-4 font-mono text-xs">
        {tickerItems.map((item, i) => {
          if (item.type === "label") {
            return (
              <span
                key={`label-${item.market}-${i}`}
                className="inline-flex items-center gap-1.5 pl-4 first:border-l-0 first:pl-0"
                style={{ borderLeft: "1px solid rgba(247,243,230,0.18)" }}
              >
                <span
                  className="font-semibold text-[11px]"
                  style={{ color: "rgba(247,243,230,0.75)" }}
                >
                  {MARKET_LABELS[item.market]}
                </span>
                {marketStatus?.[item.market] && (
                  <MarketStatusBadge phase={marketStatus[item.market]} />
                )}
              </span>
            );
          }

          const idx = item.quote;
          return (
            <span
              key={`${idx.symbol}-${i}`}
              className="inline-flex items-center gap-1.5"
            >
              {/* Symbol label — gold, matching the landing PlayfulTicker */}
              <span className="font-semibold" style={{ color: GOLD }}>
                {idx.name}
              </span>
              <span style={{ color: CREAM }}>
                {formatPrice(idx.price, idx.market as Market)}
              </span>
              <span style={{ color: idx.change >= 0 ? POS : NEG }}>
                {idx.change >= 0 ? "+" : ""}
                {idx.change.toFixed(2)} ({idx.changePercent >= 0 ? "+" : ""}
                {idx.changePercent.toFixed(2)}%)
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
