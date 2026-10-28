"use client";

const DEFAULT_TICKER: Array<[string, string, string, "pos" | "neg"]> = [
  ["NIFTY 50", "24,891", "+1.23%", "pos"],
  ["SENSEX", "81,643", "+0.98%", "pos"],
  ["BANKNIFTY", "54,120", "+0.45%", "pos"],
  ["RELIANCE", "₹2,487", "+2.1%", "pos"],
  ["TCS", "₹3,821", "-0.3%", "neg"],
  ["INFY", "₹1,654", "+1.8%", "pos"],
  ["HDFC BANK", "₹1,743", "+0.6%", "pos"],
  ["ICICI BANK", "₹1,247", "+0.4%", "pos"],
  ["ITC", "₹437", "+1.1%", "pos"],
  ["SBIN", "₹812", "+0.8%", "pos"],
  ["LT", "₹3,612", "-0.6%", "neg"],
  ["HUL", "₹2,418", "+0.2%", "pos"],
  ["BHARTI ARTL", "₹1,612", "+1.4%", "pos"],
  ["KOTAK BANK", "₹1,742", "-0.1%", "neg"],
  ["WIPRO", "₹542", "+2.4%", "pos"],
];

export function PlayfulTicker({
  items = DEFAULT_TICKER,
}: {
  items?: Array<[string, string, string, "pos" | "neg"]>;
}) {
  const doubled = [...items, ...items];
  return (
    <div className="ticker-band">
      <div className="ticker-track">
        {doubled.map(([l, v, c, k], i) => (
          <span key={i} className="t-item">
            <span className="t-lab">{l}</span>
            <span className="t-val">{v}</span>
            <span className={`t-chg ${k}`}>{c}</span>
          </span>
        ))}
      </div>
      <style jsx>{`
        /* Always-dark band — independent of theme so contrast stays
           readable in both light and dark. Mirrors .big-cta lockdown. */
        .ticker-band {
          border-top: 2px solid #1d1d1b;
          border-bottom: 2px solid #1d1d1b;
          background: #1d1d1b;
          color: #f7f3e6;
          overflow: hidden;
          padding: 14px 0;
          position: relative;
        }
        .ticker-track {
          display: flex;
          gap: 36px;
          white-space: nowrap;
          animation: tk 60s linear infinite;
          font-family: "JetBrains Mono", monospace;
          font-size: 14px;
        }
        .ticker-track :global(.t-item) {
          display: inline-flex;
          gap: 10px;
          align-items: center;
        }
        .ticker-track :global(.t-lab) {
          color: #fcd34d;
          font-weight: 600;
        }
        .ticker-track :global(.t-val) {
          color: #f7f3e6;
        }
        .ticker-track :global(.t-chg.pos) {
          color: #4ade80;
        }
        .ticker-track :global(.t-chg.neg) {
          color: #ff8a8a;
        }
        @keyframes tk {
          from {
            transform: translateX(0);
          }
          to {
            transform: translateX(-50%);
          }
        }
      `}</style>
    </div>
  );
}
