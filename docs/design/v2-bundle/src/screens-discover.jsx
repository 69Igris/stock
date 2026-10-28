// ─────────────────────────────────────────────────────────────────────────
// DISCOVER (deep) — Markets, Screener (Stocks/MF/ETF + filters), Strategies
// (catalog + detail + backtest/forward + build), Research list, News & events
// ─────────────────────────────────────────────────────────────────────────
const { useState: dcS } = React;

// ════════════════════════ MARKETS ════════════════════════
function MarketsScreen({ go }) {
  const [scope, setScope] = dcS("Nifty 50");
  const [tf, setTf] = dcS("1D");
  const indices = [
    { n: "NIFTY 50", v: "24,810", c: "+0.62%", up: true }, { n: "SENSEX", v: "81,420", c: "+0.54%", up: true },
    { n: "BANKNIFTY", v: "52,180", c: "+0.21%", up: true }, { n: "NIFTY IT", v: "38,940", c: "-0.38%", up: false },
    { n: "NIFTY AUTO", v: "23,510", c: "+1.10%", up: true }, { n: "FINNIFTY", v: "23,940", c: "+0.18%", up: true },
  ];
  // sector heatmap tiles — size hints via flex grow, color by change
  const heat = [
    { s: "Financials", c: 0.8, big: 3 }, { s: "IT", c: -0.4, big: 2 }, { s: "Energy", c: 1.4, big: 2 },
    { s: "Auto", c: 1.8, big: 1.4 }, { s: "FMCG", c: -0.2, big: 1.4 }, { s: "Pharma", c: 0.5, big: 1.2 },
    { s: "Metal", c: 2.1, big: 1 }, { s: "Realty", c: 1.2, big: 0.9 }, { s: "Media", c: -1.1, big: 0.7 },
  ];
  const heatColor = (c) => c >= 1.2 ? "var(--emerald)" : c >= 0 ? "var(--emerald-bg)" : c >= -0.6 ? "#f6d8d2" : "var(--pop-1)";
  const heatText = (c) => c >= 1.2 || c < -0.6 ? "#1d1d1b" : "var(--ink)";
  const gainers = [{ n: "ADANIENT", c: "+6.4%" }, { n: "TATASTEEL", c: "+3.8%" }, { n: "JSWSTEEL", c: "+3.1%" }, { n: "HINDALCO", c: "+2.7%" }];
  const losers = [{ n: "PAYTM", c: "-4.1%" }, { n: "WIPRO", c: "-2.7%" }, { n: "TECHM", c: "-2.2%" }, { n: "ZOMATO", c: "-2.1%" }];
  return (
    <AppPage eyebrow="NSE · BSE · LIVE" title={<>The market, <span className="ser">in one</span> <span className="hl">breath.</span></>} sub="Indices, sectors, gainers & losers — ranked."
      right={<span className="pf-pill emerald" style={{ marginTop: 12 }}><span style={{ width: 6, height: 6, borderRadius: 99, background: "currentColor" }} /> LIVE · 09:15–15:30</span>}>
      {/* index cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
        {indices.map(idx => (
          <div key={idx.n} className="pf-card" style={{ padding: 13 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)" }}>{idx.n}</span>
              <Spark up={idx.up} w={40} h={16} />
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 800, color: "var(--ink)", marginTop: 5, letterSpacing: -0.5 }}>{idx.v}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: idx.up ? "var(--emerald-text)" : "var(--loss)", marginTop: 2 }}>{idx.c}</div>
          </div>
        ))}
      </div>

      {/* sector heatmap */}
      <div className="pf-sec-h"><span className="n">SECTORS</span><h3>Where the <span className="ser">money's flowing.</span></h3><span className="rule" /></div>
      <div style={{ display: "flex", gap: 7, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="pf-seg" style={{ flex: "none" }}>
          {["All NSE", "Nifty 500", "Nifty 50"].map(s => <button key={s} className={scope === s ? "on" : ""} onClick={() => setScope(s)} style={{ padding: "7px 9px", fontSize: 10 }}>{s}</button>)}
        </div>
        <div className="pf-seg" style={{ flex: "none" }}>
          {["1D", "1W", "1M", "YTD"].map(s => <button key={s} className={tf === s ? "on" : ""} onClick={() => setTf(s)} style={{ padding: "7px 9px", fontSize: 10 }}>{s}</button>)}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, border: "2px solid var(--ink)", borderRadius: 13, padding: 6, boxShadow: "3px 3px 0 var(--ink)", background: "var(--paper-3)" }}>
        {heat.map(h => (
          <div key={h.s} style={{ flexGrow: h.big, flexBasis: h.big > 1.5 ? "44%" : "29%", minHeight: 58, borderRadius: 9, background: heatColor(h.c), border: "1.5px solid var(--ink)", padding: "9px 11px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: heatText(h.c) }}>{h.s}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: heatText(h.c), marginTop: 2 }}>{h.c >= 0 ? "+" : ""}{h.c.toFixed(1)}%</div>
          </div>
        ))}
      </div>

      {/* movers */}
      <div className="pf-sec-h"><span className="n">MOVERS</span><h3>Top movers <span className="ser">— today.</span></h3><span className="rule" /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {[["TOP GAINERS", gainers, true], ["TOP LOSERS", losers, false]].map(([t, rows, up]) => (
          <div key={t} className="pf-card" style={{ padding: 13 }}>
            <div className="ttl" style={{ color: up ? "var(--emerald-text)" : "var(--loss)" }}>{t}</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>
              {rows.map(r => (
                <div key={r.n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: "var(--ink)" }}>{r.n}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: up ? "var(--emerald-text)" : "var(--loss)" }}>{r.c}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </AppPage>
  );
}

// ════════════════════════ SCREENER ════════════════════════
function ScreenerScreen({ go }) {
  const [mode, setMode] = dcS("Stocks");
  const [drawer, setDrawer] = dcS(false);
  const counts = { Stocks: "7,395", MF: "14,082", ETF: "214" };
  const stockRes = [
    { n: "ITC", pe: "23.1", roe: "28%", mc: "5.8L Cr" }, { n: "COALINDIA", pe: "9.2", roe: "42%", mc: "2.7L Cr" },
    { n: "POWERGRID", pe: "18.4", roe: "19%", mc: "2.9L Cr" }, { n: "NTPC", pe: "16.0", roe: "13%", mc: "3.5L Cr" },
    { n: "HINDUNILVR", pe: "52.1", roe: "20%", mc: "5.6L Cr" },
  ];
  const mfRes = [
    { n: "Parag Parikh Flexi Cap", cat: "Flexi Cap", r3: "+19.2%", er: "0.63%" },
    { n: "HDFC Mid-Cap Opportunities", cat: "Mid Cap", r3: "+24.8%", er: "0.74%" },
    { n: "Nippon Small Cap", cat: "Small Cap", r3: "+28.4%", er: "0.68%" },
    { n: "ICICI Pru Bluechip", cat: "Large Cap", r3: "+16.1%", er: "0.92%" },
  ];
  const etfRes = [
    { n: "NIFTYBEES", cls: "Equity", r1: "+14.2%", er: "0.04%" }, { n: "GOLDBEES", cls: "Gold", r1: "+18.6%", er: "0.55%" },
    { n: "BANKBEES", cls: "Equity", r1: "+11.8%", er: "0.19%" }, { n: "LIQUIDBEES", cls: "Debt", r1: "+6.8%", er: "0.65%" },
  ];
  const filterGroups = mode === "Stocks"
    ? [["UNIVERSE", ["Exchange · NSE", "Index · Nifty 500"]], ["VALUATION", ["PE < 25", "P/B < 3"]], ["QUALITY", ["ROE > 15%", "Debt/Eq < 0.5"]], ["GROWTH", ["Rev growth > 10%"]]]
    : mode === "MF"
    ? [["CATEGORY", ["Flexi Cap", "Mid Cap"]], ["PLAN", ["Direct"]], ["RETURNS", ["3Y > 15%"]], ["COST", ["Expense < 1%"]], ["RISK", ["Moderate"]]]
    : [["EXCHANGE", ["NSE"]], ["ASSET CLASS", ["Equity", "Gold"]], ["AUM", ["> ₹500 Cr"]], ["COST", ["Expense < 0.5%"]]];
  return (
    <div style={{ height: "100%", position: "relative" }}>
      <AppPage eyebrow="SCREENER" title={<>Filter the <span className="hl">whole</span> market.</>} sub="70+ technicals & fundamentals.">
        <div className="pf-seg" style={{ marginBottom: 12 }}>
          {["Stocks", "MF", "ETF"].map(m => <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{m} · {counts[m]}</button>)}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)" }}><Icon name="search" size={15} color="var(--ink-3)" /><span style={{ fontSize: 13, color: "var(--ink-3)" }}>Search {mode.toLowerCase()}…</span></div>
          <button onClick={() => setDrawer(true)} style={{ padding: "10px 14px", borderRadius: 10, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, boxShadow: "2px 2px 0 var(--emerald)" }}><Icon name="filter" size={14} color="var(--paper)" /> Filters</button>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{mode === "Stocks" ? "142" : mode === "MF" ? "318" : "26"} MATCHES</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--emerald-text)" }}>Sort: {mode === "Stocks" ? "ROE ↓" : mode === "MF" ? "3Y ↓" : "1Y ↓"}</span>
        </div>
        <div className="pf-card flat" style={{ padding: "4px 6px", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--ink)" }}>
          {mode === "Stocks" && (
            <table className="pf-tbl"><thead><tr><th>Stock</th><th style={{ textAlign: "right" }}>PE</th><th style={{ textAlign: "right" }}>ROE</th><th style={{ textAlign: "right" }}>Mkt cap</th></tr></thead>
              <tbody>{stockRes.map(r => <tr key={r.n}><td><span className="tk">{r.n}</span></td><td className="num">{r.pe}</td><td className="num" style={{ color: "var(--emerald-text)" }}>{r.roe}</td><td className="num">{r.mc}</td></tr>)}</tbody></table>
          )}
          {mode === "MF" && (
            <table className="pf-tbl"><thead><tr><th>Fund</th><th style={{ textAlign: "right" }}>3Y</th><th style={{ textAlign: "right" }}>Exp</th></tr></thead>
              <tbody>{mfRes.map(r => <tr key={r.n}><td><div className="tk" style={{ fontSize: 12 }}>{r.n}</div><div className="nm">{r.cat}</div></td><td className="num" style={{ color: "var(--emerald-text)" }}>{r.r3}</td><td className="num">{r.er}</td></tr>)}</tbody></table>
          )}
          {mode === "ETF" && (
            <table className="pf-tbl"><thead><tr><th>ETF</th><th>Class</th><th style={{ textAlign: "right" }}>1Y</th><th style={{ textAlign: "right" }}>Exp</th></tr></thead>
              <tbody>{etfRes.map(r => <tr key={r.n}><td><span className="tk">{r.n}</span></td><td>{r.cls}</td><td className="num" style={{ color: "var(--emerald-text)" }}>{r.r1}</td><td className="num">{r.er}</td></tr>)}</tbody></table>
          )}
        </div>
      </AppPage>

      {/* filter drawer */}
      {drawer && (
        <div onClick={() => setDrawer(false)} style={{ position: "absolute", inset: 0, zIndex: 40, background: "rgba(20,18,12,0.5)", backdropFilter: "blur(2px)", display: "flex", alignItems: "flex-end" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxHeight: "80%", overflowY: "auto", background: "var(--paper)", borderTop: "2px solid var(--ink)", borderRadius: "20px 20px 0 0", padding: "16px 18px calc(env(safe-area-inset-bottom) + 20px)", animation: "umsheet .24s cubic-bezier(.22,.61,.36,1) both" }}>
            <style>{`@keyframes umsheet{from{transform:translateY(100%)}to{transform:none}}`}</style>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)", letterSpacing: -0.4 }}>{mode} filters</span>
              <button onClick={() => setDrawer(false)} style={{ width: 32, height: 32, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="x" size={15} color="var(--ink)" /></button>
            </div>
            {filterGroups.map(([g, chips]) => (
              <div key={g} style={{ marginTop: 16 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1.2, marginBottom: 8 }}>{g}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {chips.map(c => <span key={c} className="pf-pill" style={{ background: "var(--emerald-bg)", borderColor: "var(--emerald)", color: "var(--emerald-text)" }}>{c} <Icon name="x" size={10} color="var(--emerald-text)" /></span>)}
                  <button className="pf-pill" style={{ cursor: "pointer", borderStyle: "dashed" }}><Icon name="plus" size={11} color="var(--ink-3)" /> ADD</button>
                </div>
              </div>
            ))}
            <button onClick={() => setDrawer(false)} style={{ width: "100%", marginTop: 20, padding: 14, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)" }}>Show {mode === "Stocks" ? "142" : mode === "MF" ? "318" : "26"} results</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════ STRATEGIES ════════════════════════
const STRATS = [
  { id: "12m-momentum", n: "12-month momentum", cat: "Momentum", cagr: "+24.1%", sharpe: "1.34", dd: "-28.1%", r1: "+31.4%", win: "54%", hold: "42d", status: "LIVE", up: true, tone: "var(--emerald)", desc: "Top decile by trailing 12-month return ex-recent-month, rebalanced monthly.", uni: "NIFTY 500", entry: "Top decile by 12m-1m return · equal-weight · top 30", exit: "Rebalance monthly · sell on dropout", filters: [["marketCap", ">", "₹3,000 Cr"], ["12m-1m return", ">", "top 10%"], ["avgVolume30d", ">", "₹50 L"]] },
  { id: "roic-quality", n: "ROIC > 18% quality", cat: "Quality", cagr: "+21.0%", sharpe: "1.42", dd: "-16.8%", r1: "+22.4%", win: "67%", hold: "210d", status: "LIVE", up: true, tone: "var(--pop-5)", desc: "Persistent ROIC > 18%, debt/equity < 0.5, FCF positive 5y.", uni: "NIFTY 500", entry: "Top 30 by ROIC × FCF margin · cap-weighted", exit: "Sell when ROIC < 15% · quarterly rebalance", filters: [["marketCap", ">", "₹5,000 Cr"], ["ROIC", ">", "18%"], ["debt/eq", "<", "0.5"], ["fcfMargin", ">", "10%"]] },
  { id: "golden-cross", n: "50/200 DMA crossover", cat: "Trend", cagr: "+18.2%", sharpe: "1.12", dd: "-22.4%", r1: "+24.8%", win: "58%", hold: "84d", status: "Backtested", up: true, tone: "var(--pop-3)", desc: "Long when 50-DMA crosses above 200-DMA. Classic trend follower.", uni: "NIFTY 500", entry: "First day of month · equal-weight · top 30", exit: "On screen dropout · monthly rebalance", filters: [["marketCap", ">", "₹5,000 Cr"], ["close vs 50-DMA", ">", "0%"], ["50-DMA × 200-DMA", "=", "true"]] },
  { id: "magic-formula", n: "Magic Formula", cat: "Value", cagr: "+19.8%", sharpe: "1.24", dd: "-24.6%", r1: "+12.2%", win: "61%", hold: "365d", status: "Backtested", up: true, tone: "var(--pop-2)", desc: "Greenblatt — rank by earnings yield + ROIC. Hold 30 names, annual rebalance.", uni: "NIFTY 500", entry: "Top 30 by (earningsYield + ROIC) rank · equal-weight", exit: "Annual rebalance · sell on dropout", filters: [["marketCap", ">", "₹2,000 Cr"], ["earningsYield", ">", "8%"], ["ROIC", ">", "20%"]] },
  { id: "rsi-mean-rev", n: "RSI < 30 mean-reversion", cat: "Mean-rev", cagr: "+14.6%", sharpe: "0.92", dd: "-18.2%", r1: "+8.2%", win: "63%", hold: "12d", status: "Backtested", up: false, tone: "var(--pop-1)", desc: "Enter when 14-period RSI < 30 + above 200-DMA. Exit on RSI > 55 or 5%.", uni: "NIFTY 100", entry: "RSI(14) < 30 AND close > 200-DMA · equal-weight", exit: "RSI(14) > 55 OR +5% · stop at -3%", filters: [["RSI 14", "<", "30"], ["close vs 200-DMA", ">", "0%"], ["avgVolume20d", ">", "₹2 Cr"]] },
  { id: "52w-breakout", n: "52-week high breakout", cat: "Pattern", cagr: "+26.4%", sharpe: "1.08", dd: "-32.5%", r1: "+28.2%", win: "41%", hold: "38d", status: "Backtested", up: true, tone: "var(--pop-3)", desc: "Long when price breaks above its 52-week high on >1.5× average volume.", uni: "NIFTY 500", entry: "Close ≥ 52w-high · volume > 1.5× avg-30d", exit: "Stop at -8% · trail 10% from peak", filters: [["marketCap", ">", "₹2,000 Cr"], ["close vs 52w-high", "≥", "100%"], ["volume vs avg-30d", ">", "1.5×"]] },
  { id: "defensive-flexicap", n: "My defensive flexi-cap", cat: "Custom", cagr: "+16.2%", sharpe: "1.38", dd: "-12.1%", r1: "+18.4%", win: "65%", hold: "180d", status: "LIVE", up: true, tone: "var(--pop-4)", desc: "Quality + low-vol + dividend yield > 1.5%. Excludes PSU banks.", uni: "NIFTY 500", entry: "Low-vol + ROIC > 15% + div yield > 1.5% · cap-weighted", exit: "Quarterly rebalance · sell on dropout", filters: [["beta", "<", "0.85"], ["ROIC", ">", "15%"], ["dividendYield", ">", "1.5%"], ["sector", "≠", "PSU Banks"]] },
];
const STRAT_CATS = ["All", "Trend", "Momentum", "Value", "Quality", "Mean-rev", "Pattern", "Custom"];

function StrategiesScreen({ go }) {
  const [cat, setCat] = dcS("All");
  const [sel, setSel] = dcS(null);
  const [tab, setTab] = dcS("rules");

  if (sel) {
    const s = STRATS.find(x => x.id === sel);
    return (
      <div className="pf-page" style={{ paddingTop: 16 }}>
        <button onClick={() => setSel(null)} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)", cursor: "pointer", marginBottom: 12 }}><Icon name="arrowL" size={15} color="var(--ink-3)" /> ALL STRATEGIES</button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span className="pf-pill" style={{ background: s.tone, color: "#1d1d1b", borderColor: "var(--ink)" }}>{s.cat.toUpperCase()}</span>
          <span className="pf-pill" style={{ background: s.status === "LIVE" ? "var(--emerald)" : "transparent", color: s.status === "LIVE" ? "#fff" : "var(--ink-3)" }}>{s.status === "LIVE" ? "● LIVE" : "BACKTESTED"}</span>
        </div>
        <h1 style={{ fontWeight: 800, fontSize: 26, letterSpacing: -1, color: "var(--ink)", lineHeight: 1.05 }}>{s.n}</h1>
        <p style={{ marginTop: 8, fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>{s.desc}</p>
        {/* stat grid */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 16 }}>
          {[["CAGR", s.cagr, s.up], ["SHARPE", s.sharpe], ["MAX DD", s.dd], ["1Y RET", s.r1, s.up], ["WIN RATE", s.win], ["AVG HOLD", s.hold]].map(([l, v, pos]) => (
            <div key={l} className="pf-card pf-stat" style={{ padding: 12 }}><div className="l">{l}</div><div className="v" style={{ fontSize: 18, color: pos === true ? "var(--emerald-text)" : pos === false ? "var(--loss)" : "var(--ink)" }}>{v}</div></div>
          ))}
        </div>
        {/* equity curve */}
        <div className="pf-card" style={{ marginTop: 14, padding: 16 }}>
          <div className="ttl">EQUITY CURVE · 5Y BACKTEST</div>
          <div style={{ marginTop: 12, height: 70, display: "flex", alignItems: "flex-end", gap: 4 }}>
            {[50, 52, 56, 54, 60, 63, 67, 72, 76, 82, 88, 95].map((h, k) => <div key={k} style={{ flex: 1, height: `${h}%`, borderRadius: "3px 3px 0 0", background: k === 11 ? "var(--emerald)" : "var(--ink)" }} />)}
          </div>
        </div>
        {/* tabs */}
        <div className="pf-seg" style={{ marginTop: 16 }}>
          {[["rules", "Rules"], ["filters", "Filters"], ["forward", "Paper"]].map(([k, l]) => <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === "rules" && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
            {[["UNIVERSE", s.uni], ["ENTRY", s.entry], ["EXIT", s.exit], ["HOLD", `Median ${s.hold}`]].map(([l, v]) => (
              <div key={l} className="pf-card" style={{ padding: 13 }}><div className="ttl">{l}</div><div style={{ fontSize: 13.5, color: "var(--ink-2)", marginTop: 5, lineHeight: 1.4 }}>{v}</div></div>
            ))}
          </div>
        )}
        {tab === "filters" && (
          <div className="pf-card" style={{ marginTop: 12, padding: 14 }}>
            <div className="ttl">CONDITIONS · ALL OF</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
              {s.filters.map(([f, cmp, v], i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", border: "1.5px solid var(--rule-soft)", borderRadius: 9, background: "var(--paper)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink)", flex: 1 }}>{f}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, color: "var(--emerald-text)" }}>{cmp}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {tab === "forward" && (
          <div className="pf-card" style={{ marginTop: 12, padding: 16, textAlign: "center" }}>
            <Icon name="pen" size={28} color="var(--pop-1)" />
            <div style={{ fontWeight: 800, fontSize: 15, color: "var(--ink)", marginTop: 10 }}>Forward-test on live ticks</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 5, lineHeight: 1.5 }}>Run this strategy on a paper book with real NSE prices — no capital at risk.</div>
            <button onClick={() => go("paper")} style={{ marginTop: 14, padding: "11px 20px", borderRadius: 10, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 14, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)" }}>Start paper trading →</button>
          </div>
        )}
        <button style={{ width: "100%", marginTop: 16, marginBottom: 8, padding: 14, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", fontWeight: 800, fontSize: 14.5, cursor: "pointer", boxShadow: "3px 3px 0 var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Icon name="history" size={16} color="var(--ink)" /> Run full backtest</button>
      </div>
    );
  }

  const list = cat === "All" ? STRATS : STRATS.filter(s => s.cat === cat);
  return (
    <AppPage eyebrow="STRATEGIES · BUILD & BACKTEST" title={<>Test before you <span className="strike">risk it.</span></>}
      right={<button onClick={() => go("strategybuild")} className="pf-pill gold" style={{ marginTop: 12, cursor: "pointer" }}><Icon name="plus" size={12} color="#1d1d1b" /> BUILD NEW</button>}>
      <div style={{ display: "flex", gap: 7, overflowX: "auto", marginBottom: 14, paddingBottom: 4 }}>
        {STRAT_CATS.map(c => <button key={c} onClick={() => setCat(c)} style={{ flexShrink: 0, padding: "7px 12px", borderRadius: 9, border: "2px solid var(--ink)", background: cat === c ? "var(--ink)" : "var(--paper-3)", color: cat === c ? "var(--paper)" : "var(--ink)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", boxShadow: cat === c ? "none" : "2px 2px 0 var(--ink)" }}>{c}</button>)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {list.map(s => (
          <button key={s.id} onClick={() => { setSel(s.id); setTab("rules"); }} className="pf-card" style={{ padding: 15, textAlign: "left", cursor: "pointer" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", gap: 7, marginBottom: 7 }}>
                  <span className="pf-pill outline" style={{ fontSize: 8.5 }}>{s.cat.toUpperCase()}</span>
                  {s.status === "LIVE" && <span className="pf-pill emerald" style={{ fontSize: 8.5 }}>● LIVE</span>}
                </div>
                <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--ink)", letterSpacing: -0.3 }}>{s.n}</div>
              </div>
              <Spark up={s.up} w={56} h={26} />
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 16 }}>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", letterSpacing: 1 }}>CAGR</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 700, color: s.up ? "var(--emerald-text)" : "var(--loss)", marginTop: 2 }}>{s.cagr}</div></div>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", letterSpacing: 1 }}>SHARPE</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>{s.sharpe}</div></div>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", letterSpacing: 1 }}>WIN</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>{s.win}</div></div>
              <Icon name="chevronR" size={16} color="var(--ink-3)" style={{ marginLeft: "auto", alignSelf: "center" }} />
            </div>
          </button>
        ))}
      </div>
    </AppPage>
  );
}

// Strategy builder
function StrategyBuildScreen({ go }) {
  const [conds, setConds] = dcS([["marketCap", ">", "₹5,000 Cr"], ["ROE", ">", "15%"]]);
  return (
    <AppPage eyebrow="STRATEGY BUILDER" title={<>Build your <span className="ser">edge.</span></>} sub="Stack conditions. Backtest instantly.">
      <div className="pf-card" style={{ padding: 15 }}>
        <div className="ttl">UNIVERSE</div>
        <div className="pf-seg" style={{ marginTop: 10 }}>{["Nifty 50", "Nifty 500", "All NSE"].map((u, i) => <button key={u} className={i === 1 ? "on" : ""}>{u}</button>)}</div>
      </div>
      <div className="pf-sec-h"><span className="n">IF</span><h3>All of these</h3><span className="rule" /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {conds.map(([f, cmp, v], i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 12px", border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)", boxShadow: "2px 2px 0 var(--ink)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink)", flex: 1 }}>{f}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: "var(--emerald-text)" }}>{cmp}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{v}</span>
            <button onClick={() => setConds(c => c.filter((_, k) => k !== i))} style={{ border: 0, background: "transparent", cursor: "pointer", padding: 2 }}><Icon name="x" size={14} color="var(--ink-3)" /></button>
          </div>
        ))}
        <button onClick={() => setConds(c => [...c, ["debt/eq", "<", "0.5"]])} style={{ padding: "11px", borderRadius: 11, border: "2px dashed var(--ink-3)", background: "transparent", color: "var(--ink-3)", fontSize: 13, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 7 }}><Icon name="plus" size={15} color="var(--ink-3)" /> Add condition</button>
      </div>
      <button style={{ width: "100%", marginTop: 18, padding: 15, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "4px 4px 0 var(--emerald)", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}><Icon name="history" size={17} color="var(--paper)" /> Run backtest · {conds.length} rules</button>
    </AppPage>
  );
}

// ════════════════════════ RESEARCH ════════════════════════
function ResearchScreen({ go }) {
  const items = [
    { t: "Is RELIANCE a buy at PE 24?", d: "Deep research · Sage L4", date: "2 days ago", tag: "DEEP", c: "var(--pop-5)" },
    { t: "IT sector — derating risk", d: "Saved note · 3 sources", date: "5 days ago", tag: "NOTE", c: "var(--pop-3)" },
    { t: "FY26 dividend aristocrats", d: "Sage research · cited", date: "1 week ago", tag: "DEEP", c: "var(--pop-5)" },
  ];
  return (
    <AppPage eyebrow="RESEARCH LIST · SAVED" title={<>Your <span className="ser">deep dives,</span> kept.</>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {items.map(it => (
          <button key={it.t} onClick={() => go("sagechat")} className="pf-card" style={{ textAlign: "left", cursor: "pointer", padding: 15 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: it.c, color: "#fff", letterSpacing: 0.5 }}>{it.tag}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{it.date}</span>
            </div>
            <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--ink)", letterSpacing: -0.3, lineHeight: 1.15 }}>{it.t}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", marginTop: 6 }}>{it.d}</div>
          </button>
        ))}
      </div>
    </AppPage>
  );
}

// ════════════════════════ NEWS ════════════════════════
function NewsScreen({ go }) {
  const [tab, setTab] = dcS("For you");
  const news = [
    { src: "RBI", time: "1h", t: "RBI holds repo rate at 6.5%, stance neutral", tag: "MACRO", hot: true },
    { src: "RELIANCE", time: "3h", t: "Reliance Q4 net profit up 12% YoY, beats estimates", tag: "EARNINGS", hot: false },
    { src: "NSE", time: "5h", t: "F&O ban list: 4 stocks added for May expiry", tag: "F&O", hot: false },
    { src: "AUTO", time: "7h", t: "May auto sales: Tata Motors EVs up 38%", tag: "SECTOR", hot: false },
  ];
  return (
    <AppPage eyebrow="NEWS & EVENTS · RANKED" title={<>What <span className="hl">moves</span> your book.</>}>
      <div className="pf-seg" style={{ marginBottom: 14 }}>
        {["For you", "Earnings", "Macro", "Calendar"].map(t => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {news.map((n, i) => (
          <div key={i} className="pf-card" style={{ padding: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--ink)", padding: "2px 7px", borderRadius: 5, border: "1.5px solid var(--ink)" }}>{n.src}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.5 }}>{n.tag}</span>
              {n.hot && <span className="pf-pill coral" style={{ fontSize: 8.5 }}>● LIVE</span>}
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{n.time}</span>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.3 }}>{n.t}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16 }}><Sticker rotate={-2} style={{ display: "inline-block", fontSize: 14 }}>ranked by what's <strong style={{ fontStyle: "normal" }}>in your portfolio.</strong></Sticker></div>
    </AppPage>
  );
}

Object.assign(window, { MarketsScreen, ScreenerScreen, StrategiesScreen, StrategyBuildScreen, ResearchScreen, NewsScreen });
