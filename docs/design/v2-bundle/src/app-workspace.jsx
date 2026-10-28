// ─────────────────────────────────────────────────────────────────────────
// Authenticated app · Workspace — Dashboard, StockSage, Holdings, Watchlists,
// Tradebook, Portfolio Roast.
// ─────────────────────────────────────────────────────────────────────────
const { useState: wUS, useRef: wUR, useEffect: wUE } = React;

const HOLDINGS = [
  { n: "RELIANCE", full: "Reliance Industries", q: 48, avg: 2410, ltp: 2942, b: "zerodha", sec: "Energy" },
  { n: "INFY", full: "Infosys", q: 120, avg: 1480, ltp: 1610, b: "groww", sec: "IT" },
  { n: "TCS", full: "Tata Consultancy", q: 30, avg: 3680, ltp: 3910, b: "groww", sec: "IT" },
  { n: "HDFCBANK", full: "HDFC Bank", q: 60, avg: 1690, ltp: 1641, b: "upstox", sec: "Financials" },
  { n: "ITC", full: "ITC Ltd", q: 200, avg: 412, ltp: 478, b: "angel", sec: "FMCG" },
  { n: "TATAMOTORS", full: "Tata Motors", q: 80, avg: 720, ltp: 985, b: "dhan", sec: "Auto" },
];
const fmt = (n) => "₹" + n.toLocaleString("en-IN");
const pnl = (h) => (h.ltp - h.avg) * h.q;
const pct = (h) => ((h.ltp - h.avg) / h.avg) * 100;

// ── Dashboard ───────────────────────────────────────────────────────────────
function DashboardScreen({ go }) {
  const ticker = [["NIFTY 50", "24,810", "+0.62%", true], ["SENSEX", "81,420", "+0.54%", true], ["RELIANCE", "2,942", "+1.3%", true], ["INFY", "1,610", "-0.4%", false], ["BANKNIFTY", "52,180", "+0.21%", true]];
  const actions = [["sparkles", "Ask Sage", "var(--pop-5)", "stocksage"], ["flame", "Roast", "var(--pop-1)", "roast"], ["wallet", "Holdings", "var(--pop-3)", "holdings"], ["target", "FIRE", "var(--pop-2)", "fire"]];
  return (
    <AppScreen eyebrow="GOOD MORNING · RAHUL" title="Dashboard"
      right={<button onClick={() => go("notifications")} style={{ width: 40, height: 40, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--ink)", cursor: "pointer", position: "relative" }}><Icon name="bell" size={18} color="var(--ink)" /><span style={{ position: "absolute", top: 6, right: 7, width: 8, height: 8, borderRadius: 99, background: "var(--pop-1)", border: "1.5px solid var(--paper-3)" }} /></button>}>
      {/* ticker */}
      <div style={{ margin: "0 -18px 4px", overflow: "hidden", borderTop: "1.5px solid var(--rule-soft)", borderBottom: "1.5px solid var(--rule-soft)", padding: "8px 0", background: "var(--paper-2)" }}>
        <div style={{ display: "flex", gap: 20, padding: "0 18px", animation: "umtick 24s linear infinite", whiteSpace: "nowrap", width: "max-content" }}>
          <style>{`@keyframes umtick{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
          {[...ticker, ...ticker].map((t, k) => (
            <span key={k} style={{ display: "inline-flex", gap: 7, fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
              <span style={{ color: "var(--ink-3)", fontWeight: 700 }}>{t[0]}</span><span style={{ color: "var(--ink)", fontWeight: 600 }}>{t[1]}</span><span style={{ color: t[3] ? "var(--emerald-text)" : "var(--loss)", fontWeight: 700 }}>{t[2]}</span>
            </span>
          ))}
        </div>
      </div>

      <div style={{ background: "var(--ink)", color: "var(--paper)", border: "2px solid var(--ink)", borderRadius: 18, padding: 20, boxShadow: "5px 5px 0 var(--emerald)", marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.6)", letterSpacing: 1.2 }}>TOTAL VALUE · 5 BROKERS</div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 33, letterSpacing: -1, marginTop: 4 }}>₹17,24,180</div>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: "#1d1d1b", background: "var(--pop-2)", borderRadius: 99, padding: "5px 10px" }}><Icon name="trending" size={12} color="#1d1d1b" />+0.84%</span>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 18 }}>
          {[["TODAY", "+₹14,380", "var(--pop-2)"], ["INVESTED", "₹14,90,000", "rgba(244,237,224,0.9)"], ["XIRR", "18.4%", "var(--pop-2)"]].map(([l, v, c]) => (
            <div key={l}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "rgba(244,237,224,0.5)", letterSpacing: 1 }}>{l}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700, color: c, marginTop: 2 }}>{v}</div></div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
        {actions.map(a => (
          <button key={a[1]} onClick={() => go(a[3])} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: "13px 4px", borderRadius: 13, border: "2px solid var(--ink)", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, background: a[2], border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name={a[0]} size={19} color="#1d1d1b" /></span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{a[1]}</span>
          </button>
        ))}
      </div>

      <SectionLabel action="See all" onAction={() => go("holdings")}>Top holdings</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {HOLDINGS.slice(0, 3).map(h => (
          <div key={h.n} onClick={() => go("holdings")} style={{ display: "flex", alignItems: "center", gap: 12, padding: 13, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <BrokerDot b={h.b} size={36} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{h.n}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{h.q} sh · {fmt(h.avg)}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{fmt(h.ltp * h.q)}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: pct(h) >= 0 ? "var(--emerald-text)" : "var(--loss)" }}>{pct(h) >= 0 ? "+" : ""}{pct(h).toFixed(1)}%</div></div>
          </div>
        ))}
      </div>

      <button onClick={() => go("stocksage")} style={{ width: "100%", marginTop: 16, padding: 15, background: "var(--pop-2)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "3px 3px 0 var(--ink)", display: "flex", gap: 11, alignItems: "center", cursor: "pointer", transform: "rotate(-0.4deg)" }}>
        <Icon name="sparkles" size={20} color="#1d1d1b" />
        <div style={{ flex: 1, textAlign: "left" }}><div style={{ fontWeight: 800, fontSize: 13.5, color: "#1d1d1b" }}>Ask Sage about your portfolio</div><div style={{ fontSize: 12, color: "#1d1d1b", opacity: 0.8 }}>5 free credits left this month</div></div>
        <Icon name="arrowR" size={18} color="#1d1d1b" />
      </button>
    </AppScreen>
  );
}

// ── StockSage chat ──────────────────────────────────────────────────────────
function StockSageScreen({ go }) {
  const [msgs, setMsgs] = wUS([
    { who: "sage", text: "Hi Rahul — I've read all 6 holdings across your 5 brokers. Ask me anything, or try a prompt below.", chips: [] },
  ]);
  const [val, setVal] = wUS("");
  const scrollRef = wUR(null);
  const prompts = ["Roast my portfolio", "My sector concentration?", "Did my trades beat a Nifty SIP?"];
  const answer = (q) => {
    const a = {
      "Roast my portfolio": { text: "Honest take: you're 42% in IT (INFY + TCS), above the 25% you set. Reliance is a healthy 21%. Cash drag is low. Score: 62/100 — fair, a touch concentrated.", chips: ["IT 42%", "YOUR TRADEBOOK", "ROAST"] },
      "My sector concentration?": { text: "IT is your largest at 42% of equity. Financials 14%, Energy 21%, FMCG 11%, Auto 12%. The IT tilt is the one to watch.", chips: ["SECTORS", "PORTFOLIO"] },
      "Did my trades beat a Nifty SIP?": { text: "Your last 6 trades returned +11.4% vs a Nifty 50 SIP at +7.9% over the same window — you're ahead by 350bps, mostly from TATAMOTORS.", chips: ["TRADEBOOK", "NIFTY 50", "+350BPS"] },
    }[q] || { text: "Good question. Based on your holdings, RELIANCE is up 22% and your single best position by absolute gain (₹25,536).", chips: ["RELIANCE", "YOUR HOLDINGS"] };
    return a;
  };
  const send = (q) => {
    const text = q || val.trim();
    if (!text) return;
    setMsgs(m => [...m, { who: "me", text }]);
    setVal("");
    setTimeout(() => { const a = answer(text); setMsgs(m => [...m, { who: "sage", ...a }]); }, 450);
  };
  wUE(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [msgs]);

  return (
    <div className="um" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper)", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px)", backgroundSize: "9px 9px" }}>
      <div style={{ flexShrink: 0, padding: "60px 18px 12px", borderBottom: "2px solid var(--ink)", display: "flex", alignItems: "center", gap: 11, background: "var(--paper-3)" }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, background: "var(--pop-5)", border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={20} color="#1d1d1b" /></span>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 18, color: "var(--ink)", letterSpacing: -0.4 }}>StockSage</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 0.5 }}>GEMINI 2.5 · PORTFOLIO-AWARE</div></div>
        <Pill color="var(--pop-2-text)">5 CREDITS</Pill>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "16px 18px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {msgs.map((m, i) => m.who === "me" ? (
          <div key={i} style={{ alignSelf: "flex-end", maxWidth: "82%", background: "var(--ink)", color: "var(--paper)", padding: "11px 14px", borderRadius: "14px 14px 4px 14px", fontSize: 14, boxShadow: "3px 3px 0 var(--emerald)" }}>{m.text}</div>
        ) : (
          <div key={i} style={{ alignSelf: "flex-start", maxWidth: "90%" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}><span style={{ width: 20, height: 20, borderRadius: 6, background: "var(--pop-5)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={12} color="#fff" /></span><span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>STOCKSAGE</span></div>
            <div style={{ background: "var(--paper-3)", border: "2px solid var(--ink)", padding: "12px 14px", borderRadius: "14px 14px 14px 4px", boxShadow: "3px 3px 0 var(--ink)", fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>
              {m.text}
              {m.chips && m.chips.length > 0 && <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>{m.chips.map(c => <span key={c} style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, padding: "3px 7px", borderRadius: 99, background: "var(--emerald-bg)", color: "var(--emerald-text)", border: "1px solid var(--emerald)" }}>{c}</span>)}</div>}
            </div>
          </div>
        ))}
      </div>

      <div style={{ flexShrink: 0, padding: "10px 14px 96px", background: "var(--paper-3)", borderTop: "2px solid var(--ink)" }}>
        <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 9 }}>
          {prompts.map(p => <button key={p} onClick={() => send(p)} style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, padding: "6px 11px", borderRadius: 99, border: "1.5px solid var(--ink)", background: "var(--paper)", color: "var(--ink)", cursor: "pointer", whiteSpace: "nowrap" }}>{p}</button>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 6px 6px 14px", border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper)" }}>
          <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask anything about your money…" style={{ flex: 1, border: 0, outline: 0, background: "transparent", fontSize: 14, color: "var(--ink)", minWidth: 0 }} />
          <button onClick={() => send()} style={{ width: 36, height: 36, borderRadius: 9, background: "var(--ink)", border: 0, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0 }}><Icon name="send" size={16} color="var(--paper)" /></button>
        </div>
      </div>
    </div>
  );
}

// ── Holdings (+ detail) ─────────────────────────────────────────────────────
function HoldingsScreen({ go }) {
  const [sel, setSel] = wUS(null);
  const totVal = HOLDINGS.reduce((s, h) => s + h.ltp * h.q, 0);
  const totInv = HOLDINGS.reduce((s, h) => s + h.avg * h.q, 0);
  const totPnl = totVal - totInv;
  if (sel != null) {
    const h = HOLDINGS[sel];
    const p = pnl(h);
    return (
      <AppScreen onBack={() => setSel(null)} eyebrow={h.sec.toUpperCase() + " · NSE"} title={h.n} sub={h.full}
        right={<BrokerDot b={h.b} size={40} />}>
        <Card pad={18} shadow="4px 4px 0 var(--ink)" style={{ marginTop: 6 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1 }}>CURRENT VALUE</div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 30, color: "var(--ink)", letterSpacing: -1, marginTop: 3 }}>{fmt(h.ltp * h.q)}</div>
          <div style={{ marginTop: 8 }}><Pill up={p >= 0}>{p >= 0 ? "+" : ""}{fmt(Math.round(p))} · {pct(h).toFixed(1)}%</Pill></div>
        </Card>
        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          {[["QTY", h.q], ["AVG COST", fmt(h.avg)], ["LTP", fmt(h.ltp)], ["INVESTED", fmt(h.avg * h.q)]].map(([l, v]) => (
            <Card key={l} pad={13}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 1 }}>{l}</div><div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 17, color: "var(--ink)", marginTop: 3 }}>{v}</div></Card>
          ))}
        </div>
        <button onClick={() => go("stocksage")} style={{ width: "100%", marginTop: 16, padding: 14, background: "var(--pop-5)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", display: "flex", gap: 10, alignItems: "center", justifyContent: "center", cursor: "pointer", fontWeight: 800, fontSize: 14.5, color: "#1d1d1b" }}>
          <Icon name="sparkles" size={18} color="#1d1d1b" /> Ask Sage about {h.n}
        </button>
      </AppScreen>
    );
  }
  return (
    <AppScreen eyebrow="5 BROKERS · 6 STOCKS" title="Holdings"
      right={<Pill up={totPnl >= 0}>{totPnl >= 0 ? "+" : ""}{(totPnl / totInv * 100).toFixed(1)}%</Pill>}>
      <Card pad={16} shadow="4px 4px 0 var(--emerald)" style={{ background: "var(--ink)", color: "var(--paper)", marginTop: 6 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.6)", letterSpacing: 1 }}>PORTFOLIO VALUE</div>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 28, letterSpacing: -1, marginTop: 3 }}>{fmt(totVal)}</div>
        <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--pop-2)", fontWeight: 700 }}>+{fmt(Math.round(totPnl))} all-time · {(totPnl / totInv * 100).toFixed(1)}%</div>
      </Card>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {HOLDINGS.map((h, i) => (
          <div key={h.n} onClick={() => setSel(i)} style={{ display: "flex", alignItems: "center", gap: 12, padding: 13, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <BrokerDot b={h.b} size={38} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{h.n}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{h.q} sh · LTP {fmt(h.ltp)}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{fmt(h.ltp * h.q)}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: pct(h) >= 0 ? "var(--emerald-text)" : "var(--loss)" }}>{pct(h) >= 0 ? "+" : ""}{pct(h).toFixed(1)}%</div></div>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── Watchlists ──────────────────────────────────────────────────────────────
function WatchlistsScreen({ go }) {
  const [tab, setTab] = wUS(0);
  const lists = ["My watchlist", "IT pack", "Dividend"];
  const data = [
    [["TATASTEEL", "168.4", "+2.1%", true], ["WIPRO", "452.0", "-0.8%", false], ["SBIN", "812.6", "+1.4%", true], ["ADANIENT", "2,910", "+3.2%", true], ["DMART", "4,120", "-0.5%", false]],
    [["INFY", "1,610", "-0.4%", false], ["TCS", "3,910", "+0.6%", true], ["HCLTECH", "1,544", "+1.1%", true], ["WIPRO", "452.0", "-0.8%", false]],
    [["ITC", "478.0", "+0.9%", true], ["COALINDIA", "412.5", "+1.8%", true], ["POWERGRID", "298.4", "+0.3%", true]],
  ];
  return (
    <AppScreen eyebrow="LIVE · NSE" title="Watchlists"
      right={<button style={{ width: 40, height: 40, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--emerald)", cursor: "pointer" }}><Icon name="search" size={18} color="var(--paper)" /></button>}>
      <div style={{ display: "flex", gap: 8, marginTop: 6, overflowX: "auto", paddingBottom: 4 }}>
        {lists.map((l, i) => (
          <button key={l} onClick={() => setTab(i)} style={{ flexShrink: 0, padding: "8px 14px", borderRadius: 99, border: "2px solid var(--ink)", background: tab === i ? "var(--ink)" : "var(--paper-3)", color: tab === i ? "var(--paper)" : "var(--ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: tab === i ? "none" : "2px 2px 0 var(--ink)" }}>{l}</button>
        ))}
      </div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {data[tab].map(r => (
          <div key={r[0]} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 15px", background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{r[0]}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>NSE</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{r[1]}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: r[3] ? "var(--emerald-text)" : "var(--loss)" }}>{r[2]}</div></div>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── Tradebook ───────────────────────────────────────────────────────────────
function TradebookScreen() {
  const [f, setF] = wUS("All");
  const trades = [
    { d: "29 May", s: "TATAMOTORS", t: "BUY", q: 40, p: 962, b: "dhan" },
    { d: "28 May", s: "INFY", t: "SELL", q: 30, p: 1598, b: "groww" },
    { d: "24 May", s: "RELIANCE", t: "BUY", q: 18, p: 2880, b: "zerodha" },
    { d: "21 May", s: "ITC", t: "BUY", q: 100, p: 466, b: "angel" },
    { d: "18 May", s: "HDFCBANK", t: "SELL", q: 20, p: 1655, b: "upstox" },
    { d: "12 May", s: "TCS", t: "BUY", q: 10, p: 3840, b: "groww" },
  ];
  const shown = f === "All" ? trades : trades.filter(t => t.t === f.toUpperCase());
  return (
    <AppScreen eyebrow="FIFO-PAIRED · ALL BROKERS" title="Tradebook">
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        {["All", "Buy", "Sell"].map(x => (
          <button key={x} onClick={() => setF(x)} style={{ padding: "7px 16px", borderRadius: 99, border: "2px solid var(--ink)", background: f === x ? "var(--ink)" : "var(--paper-3)", color: f === x ? "var(--paper)" : "var(--ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: f === x ? "none" : "2px 2px 0 var(--ink)" }}>{x}</button>
        ))}
      </div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {shown.map((t, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 13, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: "#1d1d1b", background: t.t === "BUY" ? "var(--emerald)" : "var(--pop-1)", borderRadius: 7, padding: "5px 8px", flexShrink: 0 }}>{t.t}</span>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{t.s}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>{t.d} · {t.q} @ {fmt(t.p)}</div></div>
            <div style={{ textAlign: "right" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{fmt(t.q * t.p)}</div><BrokerDot b={t.b} size={22} /></div>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── Portfolio Roast ─────────────────────────────────────────────────────────
function RoastScreen({ go }) {
  const crit = [
    { i: "flame", c: "var(--pop-1)", t: "IT concentration", d: "42% in INFY + TCS. One bad quarter hurts. Trim toward your 25% target." },
    { i: "check", c: "var(--emerald)", t: "Healthy core", d: "RELIANCE at 21% is a sensible anchor. Good entry, up 22%." },
    { i: "trending", c: "var(--pop-3)", t: "Winner running", d: "TATAMOTORS +37%. Consider booking part to lock LTCG." },
  ];
  return (
    <AppScreen eyebrow="AI CRITIQUE · NOT A HIT-PIECE" title="Portfolio Roast"
      right={<button style={{ width: 40, height: 40, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--ink)", cursor: "pointer" }}><Icon name="send" size={17} color="var(--ink)" /></button>}>
      <div style={{ marginTop: 6, background: "var(--ink)", border: "2px solid var(--ink)", borderRadius: 18, boxShadow: "6px 6px 0 var(--pop-1)", padding: "26px 20px", display: "flex", flexDirection: "column", alignItems: "center", color: "var(--paper)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 2, color: "rgba(244,237,224,0.6)" }}>ROAST SCORE</div>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 80, lineHeight: 1, color: "var(--pop-2)" }}>62</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(244,237,224,0.6)" }}>/ 100 · FAIR — A TOUCH CONCENTRATED</div>
        <div style={{ marginTop: 16, display: "flex", gap: 6, width: "100%" }}>
          {[1, 1, 1, 0.4, 0].map((v, k) => <div key={k} style={{ flex: 1, height: 7, borderRadius: 99, background: k < 3 ? "var(--pop-2)" : "rgba(244,237,224,0.18)" }} />)}
        </div>
      </div>
      <div style={{ marginTop: 16 }}>
        <Sticker rotate={-2} style={{ display: "inline-block" }}>"Solid core, but your <strong>IT bet</strong> is doing a lot of heavy lifting."</Sticker>
      </div>
      <SectionLabel>The breakdown</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {crit.map(c => (
          <div key={c.t} style={{ display: "flex", gap: 12, padding: 14, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, background: c.c, border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={c.i} size={19} color="#1d1d1b" /></span>
            <div><div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)" }}>{c.t}</div><div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 2, lineHeight: 1.45 }}>{c.d}</div></div>
          </div>
        ))}
      </div>
      <button onClick={() => go("stocksage")} style={{ width: "100%", marginTop: 16, padding: 14, background: "var(--pop-5)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", display: "flex", gap: 10, alignItems: "center", justifyContent: "center", cursor: "pointer", fontWeight: 800, fontSize: 14.5, color: "#1d1d1b" }}>
        <Icon name="sparkles" size={18} color="#1d1d1b" /> Ask Sage how to fix this
      </button>
    </AppScreen>
  );
}

Object.assign(window, { DashboardScreen, StockSageScreen, HoldingsScreen, WatchlistsScreen, TradebookScreen, RoastScreen });
