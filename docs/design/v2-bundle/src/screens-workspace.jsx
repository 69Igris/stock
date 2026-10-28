// ─────────────────────────────────────────────────────────────────────────
// WORKSPACE — Dashboard, StockSage chat, Holdings, Watchlists, Tradebook, Roast
// ─────────────────────────────────────────────────────────────────────────
const { useState: wS, useRef: wR, useEffect: wE } = React;

const HOLD = [
  { n: "RELIANCE", nm: "Reliance Inds", q: 48, avg: 2410, ltp: 2942, val: "1,41,216", pl: "+22.1%", up: true, b: "zerodha", w: 18 },
  { n: "INFY", nm: "Infosys", q: 120, avg: 1480, ltp: 1610, val: "1,93,200", pl: "+8.8%", up: true, b: "groww", w: 25 },
  { n: "HDFCBANK", nm: "HDFC Bank", q: 60, avg: 1740, ltp: 1690, val: "1,01,400", pl: "-2.9%", up: false, b: "upstox", w: 13 },
  { n: "TCS", nm: "Tata Consultancy", q: 32, avg: 3520, ltp: 3890, val: "1,24,480", pl: "+10.5%", up: true, b: "zerodha", w: 16 },
  { n: "ITC", nm: "ITC Ltd", q: 300, avg: 410, ltp: 462, val: "1,38,600", pl: "+12.7%", up: true, b: "angel", w: 18 },
  { n: "TATAMOTORS", nm: "Tata Motors", q: 90, avg: 720, ltp: 685, val: "61,650", pl: "-4.9%", up: false, b: "groww", w: 8 },
];

// ── Dashboard ────────────────────────────────────────────────────────────────
function DashboardScreen({ go }) {
  const actions = [
    { i: "sparkles", t: "Ask Sage", c: "var(--pop-5)", to: "sagechat" },
    { i: "flame", t: "Roast", c: "var(--pop-1)", to: "roast" },
    { i: "briefcase", t: "Holdings", c: "var(--pop-2)", to: "holdings" },
    { i: "calc", t: "FIRE", c: "var(--pop-3)", to: "fire" },
  ];
  return (
    <AppPage eyebrow="GOOD MORNING · MARKETS OPEN" title={<>Hey Rahul. <span className="ser">Today's tape.</span></>}>
      {/* portfolio card */}
      <div style={{ background: "var(--ink)", color: "var(--paper)", border: "2px solid var(--ink)", borderRadius: 18, padding: 18, boxShadow: "5px 5px 0 var(--emerald)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.6)", letterSpacing: 1.2 }}>TOTAL VALUE · 4 BROKERS</div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 32, letterSpacing: -1, marginTop: 4 }}>₹17,24,180</div>
          </div>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: "#1d1d1b", background: "var(--pop-2)", borderRadius: 99, padding: "5px 10px" }}><Icon name="trending" size={12} color="#1d1d1b" />+0.84%</span>
        </div>
        <div style={{ marginTop: 16, display: "flex", gap: 14 }}>
          {[["TODAY", "+₹14,380", "var(--pop-2)"], ["INVESTED", "₹14,90,000", "rgba(244,237,224,0.92)"], ["XIRR", "18.4%", "var(--pop-2)"]].map(([l, v, c]) => (
            <div key={l}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(244,237,224,0.5)", letterSpacing: 1 }}>{l}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 14.5, fontWeight: 700, color: c, marginTop: 2 }}>{v}</div></div>
          ))}
        </div>
      </div>

      {/* quick actions */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 9 }}>
        {actions.map(a => (
          <button key={a.t} onClick={() => go(a.to)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 7, padding: "13px 4px", borderRadius: 13, border: "2px solid var(--ink)", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: a.c, border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name={a.i} size={18} color="#1d1d1b" /></span>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink)" }}>{a.t}</span>
          </button>
        ))}
      </div>

      {/* sage nudge */}
      <button onClick={() => go("sagechat")} style={{ width: "100%", marginTop: 16, padding: 14, background: "var(--pop-2)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", display: "flex", gap: 11, alignItems: "center", transform: "rotate(-0.5deg)", cursor: "pointer", textAlign: "left" }}>
        <Icon name="sparkles" size={20} color="#1d1d1b" />
        <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 13.5, color: "#1d1d1b" }}>Ask Sage about your portfolio</div><div style={{ fontSize: 12, color: "#1d1d1b", opacity: 0.8 }}>5 free credits left this month</div></div>
        <Icon name="arrowR" size={18} color="#1d1d1b" />
      </button>

      {/* allocation */}
      <div className="pf-sec-h"><span className="n">01</span><h3>Top holdings</h3><span className="rule" /><span className="meta" onClick={() => go("holdings")} style={{ cursor: "pointer", color: "var(--emerald-text)" }}>See all →</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {HOLD.slice(0, 4).map(h => (
          <button key={h.n} onClick={() => go("holdings")} className="pf-row" style={{ cursor: "pointer", textAlign: "left", width: "100%" }}>
            <div className="ic" style={{ background: "var(--paper)", padding: 5 }}><img src={`assets/brokers/${h.b}.png`} alt={h.b} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>{h.n}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>{h.q} sh · ₹{h.avg}</div>
            </div>
            <Spark up={h.up} w={48} h={20} />
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>₹{h.val}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: h.up ? "var(--emerald-text)" : "var(--loss)" }}>{h.pl}</div>
            </div>
          </button>
        ))}
      </div>
    </AppPage>
  );
}

// ── StockSage chat ─────────────────────────────────────────────────────────────
function SageChatScreen({ go }) {
  const [msgs, setMsgs] = wS([
    { who: "u", t: "Is my portfolio too concentrated in IT?" },
    { who: "ai", model: "FLASH", t: "Yes — IT is 42% of equity, above the 25% ceiling you set. INFY + TCS alone are ₹3.2L across 2 brokers.", cites: ["INFY", "TCS", "YOUR TRADEBOOK"], cost: "FREE" },
  ]);
  const [val, setVal] = wS("");
  const [model, setModel] = wS("Flash");
  const [deep, setDeep] = wS(false);
  const [menu, setMenu] = wS(null); // 'slash' | 'at' | null
  const endRef = wR(null);
  const send = (text) => {
    const q = (text || val).trim(); if (!q) return;
    setMsgs(m => [...m, { who: "u", t: q }]);
    setVal(""); setMenu(null);
    setTimeout(() => setMsgs(m => [...m, { who: "ai", model: deep ? "PRO · L4" : model.toUpperCase(), t: "Looking at your book — RELIANCE is +22% and your single largest gain. PE 24.3× sits above its 5-yr median; trimming half locks LTCG at 12.5%.", cites: ["RELIANCE · NSE", "LTCG RULE"], cost: deep ? "3 CREDITS" : "FREE" }]), 650);
  };
  const chips = ["Roast my portfolio", "My sector concentration?", "Beat a Nifty SIP?"];
  const slash = [["/roast", "Score my portfolio"], ["/research", "Deep dive a stock"], ["/compare", "Compare two stocks"], ["/tax", "My tax position"]];
  const mentions = [["@RELIANCE", "Holding"], ["@INFY", "Holding"], ["@Momentum", "Watchlist"], ["@Form26AS", "Document"]];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 16px 8px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--pop-5)", border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={18} color="#fff" /></span>
          <div><div style={{ fontWeight: 800, fontSize: 16, color: "var(--ink)", letterSpacing: -0.3 }}>StockSage</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>READ YOUR PORTFOLIO · CITED</div></div>
          <span className="pf-pill emerald" style={{ marginLeft: "auto" }}>5 CREDITS</span>
        </div>
        {/* model + depth toggles */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <div className="pf-seg" style={{ flex: "none" }}>
            {["Flash", "Pro"].map(m => <button key={m} className={model === m ? "on" : ""} onClick={() => setModel(m)} style={{ padding: "7px 13px", fontSize: 10.5 }}>{m === "Flash" ? "⚡ Flash" : "✦ Pro"}</button>)}
          </div>
          <button onClick={() => setDeep(d => !d)} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 13px", borderRadius: 10, border: "2px solid var(--ink)", background: deep ? "var(--pop-5)" : "var(--paper-3)", color: deep ? "#fff" : "var(--ink-2)", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, cursor: "pointer" }}>
            <Icon name="brain" size={13} color={deep ? "#fff" : "var(--ink-3)"} /> DEEP {deep ? "ON" : "OFF"}
          </button>
          <span style={{ marginLeft: "auto", alignSelf: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{deep ? "1–3 credits" : "free"}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {msgs.map((m, i) => m.who === "u" ? (
            <div key={i} style={{ alignSelf: "flex-end", maxWidth: "82%", background: "var(--ink)", color: "var(--paper)", padding: "11px 14px", borderRadius: "14px 14px 4px 14px", fontSize: 14, fontWeight: 500, boxShadow: "3px 3px 0 var(--emerald)" }}>{m.t}</div>
          ) : (
            <div key={i} style={{ alignSelf: "flex-start", maxWidth: "92%", background: "var(--paper-3)", border: "2px solid var(--ink)", padding: "13px 15px", borderRadius: "14px 14px 14px 4px", boxShadow: "3px 3px 0 var(--ink)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 0.8 }}>SAGE · {m.model}</span>
                {m.cost && <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 700, padding: "2px 6px", borderRadius: 99, background: m.cost === "FREE" ? "var(--emerald-bg)" : "var(--pop-5)", color: m.cost === "FREE" ? "var(--emerald-text)" : "#fff", border: m.cost === "FREE" ? "1px solid var(--emerald)" : 0 }}>{m.cost}</span>}
              </div>
              <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>{m.t}</div>
              {m.cites && <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>{m.cites.map(c => <span key={c} style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, padding: "3px 7px", borderRadius: 99, background: "var(--emerald-bg)", color: "var(--emerald-text)", border: "1px solid var(--emerald)" }}>{c}</span>)}</div>}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
      {/* composer */}
      <div style={{ flexShrink: 0, padding: "8px 14px 14px", borderTop: "1.5px dashed var(--rule-soft)", background: "var(--paper)" }}>
        {menu && (
          <div style={{ marginBottom: 8, border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", overflow: "hidden" }}>
            {(menu === "slash" ? slash : mentions).map(([k, d], i) => (
              <button key={k} onClick={() => { setVal(v => (menu === "slash" ? k + " " : v + k.slice(1) + " ")); setMenu(null); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 13px", border: 0, borderTop: i ? "1px dashed var(--rule-soft)" : 0, background: "transparent", cursor: "pointer", textAlign: "left" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: "var(--emerald-text)" }}>{k}</span>
                <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{d}</span>
              </button>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 8 }}>
          <button onClick={() => setMenu(menu === "slash" ? null : "slash")} style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: "2px solid var(--ink)", background: menu === "slash" ? "var(--ink)" : "var(--paper-3)", color: menu === "slash" ? "var(--paper)" : "var(--ink)", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>/</button>
          <button onClick={() => setMenu(menu === "at" ? null : "at")} style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: "2px solid var(--ink)", background: menu === "at" ? "var(--ink)" : "var(--paper-3)", color: menu === "at" ? "var(--paper)" : "var(--ink)", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 15, cursor: "pointer" }}>@</button>
          {chips.map(c => <button key={c} onClick={() => send(c)} style={{ flexShrink: 0, padding: "7px 11px", borderRadius: 99, border: "2px solid var(--ink)", background: "var(--paper-3)", fontSize: 12, fontWeight: 600, color: "var(--ink)", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)", whiteSpace: "nowrap" }}>{c}</button>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 6px 6px 14px", border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
          <input value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => e.key === "Enter" && send()} placeholder="Ask anything · / for commands · @ to mention" style={{ flex: 1, border: 0, outline: 0, background: "transparent", fontSize: 14, color: "var(--ink)", fontFamily: "var(--font-sans)", padding: "8px 0" }} />
          <button onClick={() => send()} style={{ width: 36, height: 36, borderRadius: 9, background: "var(--ink)", border: 0, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0 }}><Icon name="send" size={16} color="var(--paper)" /></button>
        </div>
      </div>
    </div>
  );
}

// ── Holdings ───────────────────────────────────────────────────────────────────
function HoldingsScreen({ go }) {
  const [tab, setTab] = wS("All");
  return (
    <AppPage eyebrow="HOLDINGS · 4 BROKERS · LIVE" title={<>Your <span className="hl">reconciled</span> book.</>} sub="Every broker, FIFO-paired, one P&L.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 14 }}>
        <div className="pf-card pf-stat"><div className="l">Current value</div><div className="v">₹7,60,546</div><div className="d pos">▲ ₹84,210 · 12.4%</div></div>
        <div className="pf-card pf-stat"><div className="l">Day's P&L</div><div className="v">+₹6,180</div><div className="d pos">▲ 0.82%</div></div>
      </div>
      <div className="pf-seg" style={{ marginBottom: 12 }}>
        {["All", "Equity", "MF", "Gainers"].map(t => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      <div className="pf-card flat" style={{ padding: "4px 6px", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--ink)" }}>
        <table className="pf-tbl">
          <thead><tr><th>Symbol</th><th style={{ textAlign: "right" }}>LTP</th><th style={{ textAlign: "right" }}>Value</th><th style={{ textAlign: "right" }}>P&L</th></tr></thead>
          <tbody>
            {HOLD.filter(h => tab === "Gainers" ? h.up : true).map(h => (
              <tr key={h.n}>
                <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 22, height: 22, borderRadius: 6, background: "var(--paper)", border: "1.5px solid var(--ink)", display: "grid", placeItems: "center", padding: 3, flexShrink: 0 }}><img src={`assets/brokers/${h.b}.png`} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} /></span><div><div className="tk">{h.n}</div><div className="nm">{h.q} · ₹{h.avg}</div></div></div></td>
                <td className="num">{h.ltp}</td>
                <td className="num">{h.val}</td>
                <td className="num" style={{ color: h.up ? "var(--emerald-text)" : "var(--loss)" }}>{h.pl}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={() => go("tradebook")} className="pf-row" style={{ marginTop: 14, cursor: "pointer", width: "100%", textAlign: "left" }}>
        <span className="ic" style={{ background: "var(--pop-3)" }}><Icon name="list" size={18} color="#fff" /></span>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>Full tradebook</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>2,114 rows · export ITR-2</div></div>
        <Icon name="chevronR" size={17} color="var(--ink-3)" />
      </button>
    </AppPage>
  );
}

// ── Watchlists ───────────────────────────────────────────────────────────────
function WatchlistScreen({ go }) {
  const [list, setList] = wS("Momentum");
  const lists = ["Momentum", "Dividend", "F&O", "IPO watch"];
  const rows = [
    { n: "BAJFINANCE", ltp: "7,210", c: "+1.8%", up: true }, { n: "DMART", ltp: "3,940", c: "+0.4%", up: true },
    { n: "ZOMATO", ltp: "262", c: "-2.1%", up: false }, { n: "ADANIENT", ltp: "2,880", c: "+3.2%", up: true },
    { n: "PAYTM", ltp: "452", c: "-1.4%", up: false }, { n: "IRCTC", ltp: "910", c: "+0.9%", up: true },
  ];
  return (
    <AppPage eyebrow="WATCHLISTS · PRICE ALERTS" title={<>Lists you <span className="ser">actually</span> watch.</>} right={<button className="pf-pill gold" style={{ marginTop: 12, cursor: "pointer" }}><Icon name="plus" size={12} color="#1d1d1b" /> NEW LIST</button>}>
      <div style={{ display: "flex", gap: 7, overflowX: "auto", marginBottom: 14, paddingBottom: 4 }}>
        {lists.map(l => <button key={l} onClick={() => setList(l)} style={{ flexShrink: 0, padding: "8px 13px", borderRadius: 10, border: "2px solid var(--ink)", background: list === l ? "var(--ink)" : "var(--paper-3)", color: list === l ? "var(--paper)" : "var(--ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: list === l ? "none" : "2px 2px 0 var(--ink)" }}>{l}</button>)}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {rows.map(r => (
          <div key={r.n} className="pf-row">
            <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)", fontFamily: "var(--font-mono)" }}>{r.n}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>NSE · ₹{r.ltp}</div></div>
            <Spark up={r.up} w={56} />
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: r.up ? "var(--emerald-text)" : "var(--loss)", minWidth: 52, textAlign: "right" }}>{r.c}</div>
            <button style={{ width: 30, height: 30, borderRadius: 8, border: "1.5px solid var(--rule-soft)", background: "var(--paper)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="bell" size={14} color="var(--ink-3)" /></button>
          </div>
        ))}
      </div>
    </AppPage>
  );
}

// ── Tradebook ──────────────────────────────────────────────────────────────────
function TradebookScreen({ go }) {
  const [tab, setTab] = wS("All trades");
  const [broker, setBroker] = wS("All");
  const rows = [
    { d: "31 May", s: "RELIANCE", side: "BUY", q: 10, p: "2,910", b: "zerodha" },
    { d: "30 May", s: "INFY", side: "SELL", q: 25, p: "1,605", b: "groww" },
    { d: "28 May", s: "ITC", side: "BUY", q: 100, p: "458", b: "angel" },
    { d: "27 May", s: "TCS", side: "BUY", q: 12, p: "3,840", b: "zerodha" },
    { d: "24 May", s: "HDFCBANK", side: "SELL", q: 20, p: "1,702", b: "upstox" },
    { d: "22 May", s: "TATAMOTORS", side: "BUY", q: 40, p: "712", b: "groww" },
  ];
  const realized = [
    { s: "INFY", qty: 25, buy: "1,480", sell: "1,605", pl: "+₹3,125", pct: "+8.4%", up: true, term: "LTCG" },
    { s: "HDFCBANK", qty: 20, buy: "1,740", sell: "1,702", pl: "-₹760", pct: "-2.2%", up: false, term: "STCG" },
    { s: "WIPRO", qty: 50, buy: "402", sell: "446", pl: "+₹2,200", pct: "+10.9%", up: true, term: "STCG" },
  ];
  const brokers = ["All", "zerodha", "groww", "upstox", "angel"];
  const shown = rows.filter(r => broker === "All" ? true : r.b === broker).filter(r => tab === "Buys" ? r.side === "BUY" : tab === "Sells" ? r.side === "SELL" : true);
  return (
    <AppPage eyebrow="TRADEBOOK · 2,114 ROWS" title={<>Every <span className="hl">trade</span>, paired.</>} sub="FIFO-matched across brokers. Export ITR-2.">
      {/* realized P&L summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
        <div className="pf-card pf-stat" style={{ padding: 12 }}><div className="l">Realized</div><div className="v" style={{ fontSize: 17, color: "var(--emerald-text)" }}>+₹4.5k</div></div>
        <div className="pf-card pf-stat" style={{ padding: 12 }}><div className="l">Buys</div><div className="v" style={{ fontSize: 17 }}>1,284</div></div>
        <div className="pf-card pf-stat" style={{ padding: 12 }}><div className="l">Sells</div><div className="v" style={{ fontSize: 17 }}>830</div></div>
      </div>
      <div className="pf-seg" style={{ marginBottom: 12 }}>
        {["All trades", "Buys", "Sells", "Realized P&L"].map(t => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {/* broker filter + export */}
      <div style={{ display: "flex", gap: 7, overflowX: "auto", marginBottom: 12, paddingBottom: 4, alignItems: "center" }}>
        {brokers.map(b => <button key={b} onClick={() => setBroker(b)} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 11px", borderRadius: 99, border: "2px solid var(--ink)", background: broker === b ? "var(--ink)" : "var(--paper-3)", color: broker === b ? "var(--paper)" : "var(--ink)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", textTransform: "capitalize" }}>{b !== "All" && <img src={`assets/brokers/${b}.png`} alt="" style={{ width: 14, height: 14, objectFit: "contain", filter: broker === b ? "brightness(0) invert(1)" : "none" }} />}{b}</button>)}
        <button onClick={() => go("tax")} style={{ flexShrink: 0, marginLeft: "auto", padding: "7px 12px", borderRadius: 99, border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", fontSize: 11.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="download" size={13} color="var(--ink)" /> ITR-2</button>
      </div>
      <div className="pf-card flat" style={{ padding: "4px 6px", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--ink)" }}>
        {tab === "Realized P&L" ? (
          <table className="pf-tbl">
            <thead><tr><th>Symbol</th><th>Term</th><th style={{ textAlign: "right" }}>Buy→Sell</th><th style={{ textAlign: "right" }}>P&L</th></tr></thead>
            <tbody>{realized.map((r, i) => (
              <tr key={i}>
                <td><span className="tk">{r.s}</span><div className="nm">{r.qty} sh</div></td>
                <td><span className="pf-pill" style={{ fontSize: 8.5, background: r.term === "LTCG" ? "var(--emerald-bg)" : "transparent", color: r.term === "LTCG" ? "var(--emerald-text)" : "var(--ink-3)", borderColor: r.term === "LTCG" ? "var(--emerald)" : "var(--rule-soft)" }}>{r.term}</span></td>
                <td className="num" style={{ fontSize: 11 }}>{r.buy}→{r.sell}</td>
                <td className="num" style={{ color: r.up ? "var(--emerald-text)" : "var(--loss)" }}>{r.pl}<div style={{ fontSize: 10, fontWeight: 600 }}>{r.pct}</div></td>
              </tr>
            ))}</tbody>
          </table>
        ) : (
          <table className="pf-tbl">
            <thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Price</th></tr></thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{r.d}</td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 7 }}><span style={{ width: 18, height: 18, borderRadius: 5, background: "var(--paper)", border: "1.5px solid var(--ink)", display: "grid", placeItems: "center", padding: 2, flexShrink: 0 }}><img src={`assets/brokers/${r.b}.png`} alt="" style={{ maxWidth: "100%", maxHeight: "100%" }} /></span><span className="tk">{r.s}</span></div></td>
                  <td><span className="pf-pill" style={{ background: r.side === "BUY" ? "var(--emerald-bg)" : "transparent", color: r.side === "BUY" ? "var(--emerald-text)" : "var(--loss)", borderColor: r.side === "BUY" ? "var(--emerald)" : "var(--loss)" }}>{r.side}</span></td>
                  <td className="num">{r.q}</td>
                  <td className="num">₹{r.p}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AppPage>
  );
}

// ── Portfolio Roast ──────────────────────────────────────────────────────────
function RoastScreen({ go }) {
  const cards = [
    { i: "alert", c: "var(--pop-1)", t: "Over-concentrated in IT", d: "42% of equity in 2 stocks. One bad quarter hurts. Trim toward your 25% target." },
    { i: "check", c: "var(--emerald)", t: "Costs are low", d: "Blended expense 0.31% — better than 78% of UseMoney users. Keep it." },
    { i: "alert", c: "var(--pop-2)", t: "Idle cash drag", d: "₹1.2L sitting in the ledger for 40+ days. A liquid fund would've earned ₹1,580." },
  ];
  return (
    <AppPage eyebrow="PORTFOLIO ROAST · HONEST" title={<>The good, <span className="ser">the bad,</span> the <span className="strike">dud.</span></>}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, padding: 18, background: "var(--ink)", borderRadius: 16, boxShadow: "5px 5px 0 var(--pop-1)", color: "var(--paper)" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 56, lineHeight: 1, color: "var(--pop-2)" }}>62</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.6)", letterSpacing: 1 }}>/ 100 · FAIR</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 17, lineHeight: 1.3 }}>"Solid core, but you're crowded in tech and sitting on lazy cash."</div>
          <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--pop-2)", letterSpacing: 1 }}>NOT A HIT-PIECE. JUST REAL.</div>
        </div>
      </div>
      <div className="pf-sec-h"><span className="n">↪</span><h3>The verdict</h3><span className="rule" /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {cards.map(c => (
          <div key={c.t} className="pf-row" style={{ alignItems: "flex-start" }}>
            <span className="ic" style={{ background: c.c }}><Icon name={c.i} size={18} color="#1d1d1b" strokeWidth={2.4} /></span>
            <div style={{ flex: 1 }}><div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)" }}>{c.t}</div><div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3, lineHeight: 1.45 }}>{c.d}</div></div>
          </div>
        ))}
      </div>
      <button onClick={() => go("sagechat")} style={{ width: "100%", marginTop: 16, padding: "14px", borderRadius: 12, border: "2px solid var(--ink)", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", gap: 9, fontSize: 14.5, fontWeight: 800, color: "var(--ink)", cursor: "pointer" }}><Icon name="sparkles" size={17} color="var(--pop-5)" /> Ask Sage how to fix it</button>
    </AppPage>
  );
}

Object.assign(window, { DashboardScreen, SageChatScreen, HoldingsScreen, WatchlistScreen, TradebookScreen, RoastScreen });
