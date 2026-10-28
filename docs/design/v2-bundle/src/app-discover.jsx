// ─────────────────────────────────────────────────────────────────────────
// Authenticated app · Discover — Markets, Screener, Strategies, Research List,
// News & Events.
// ─────────────────────────────────────────────────────────────────────────
const { useState: dUS } = React;

// ── Markets ─────────────────────────────────────────────────────────────────
function MarketsScreen() {
  const [tab, setTab] = dUS(0);
  const indices = [["NIFTY 50", "24,810.55", "+153.2", "+0.62%", true], ["SENSEX", "81,420.1", "+438.6", "+0.54%", true], ["BANK NIFTY", "52,180.4", "+109.8", "+0.21%", true], ["NIFTY IT", "38,902.0", "-142.5", "-0.36%", false], ["NIFTY MIDCAP", "57,330.2", "+512.1", "+0.90%", true]];
  const movers = {
    Gainers: [["ADANIENT", "2,910", "+5.2%"], ["TATAMOTORS", "985.4", "+4.1%"], ["JSWSTEEL", "942.0", "+3.6%"], ["COALINDIA", "412.5", "+3.1%"]],
    Losers: [["WIPRO", "452.0", "-2.8%"], ["HCLTECH", "1,544", "-2.1%"], ["DMART", "4,120", "-1.9%"], ["NESTLEIND", "2,388", "-1.4%"]],
  };
  const mtab = ["Gainers", "Losers"][tab];
  return (
    <AppScreen eyebrow="NSE · BSE · LIVE" title="Markets">
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 10 }}>
        {indices.map(ix => (
          <div key={ix[0]} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 15px", background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{ix[0]}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: ix[4] ? "var(--emerald-text)" : "var(--loss)" }}>{ix[2]} ({ix[3]})</div></div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 700, color: "var(--ink)" }}>{ix[1]}</div>
          </div>
        ))}
      </div>
      <SectionLabel>Top movers</SectionLabel>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {["Gainers", "Losers"].map((x, i) => (
          <button key={x} onClick={() => setTab(i)} style={{ padding: "7px 16px", borderRadius: 99, border: "2px solid var(--ink)", background: tab === i ? "var(--ink)" : "var(--paper-3)", color: tab === i ? "var(--paper)" : "var(--ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: tab === i ? "none" : "2px 2px 0 var(--ink)" }}>{x}</button>
        ))}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {movers[mtab].map(r => (
          <div key={r[0]} style={{ display: "flex", alignItems: "center", padding: "12px 15px", background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ flex: 1, fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{r[0]}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: "var(--ink)", marginRight: 10 }}>{r[1]}</span>
            <Pill up={mtab === "Gainers"}>{r[2]}</Pill>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── Screener ────────────────────────────────────────────────────────────────
function ScreenerScreen({ go }) {
  const [active, setActive] = dUS(["Large cap", "PE < 25"]);
  const filters = ["Large cap", "Mid cap", "PE < 25", "Div yield > 2%", "ROE > 15%", "52w high", "Profitable", "Low debt"];
  const results = [["RELIANCE", "Energy", "24.3", "₹2,942"], ["ITC", "FMCG", "21.0", "₹478"], ["SBIN", "Financials", "9.8", "₹812"], ["COALINDIA", "Energy", "7.4", "₹412"]];
  const toggle = (f) => setActive(a => a.includes(f) ? a.filter(x => x !== f) : [...a, f]);
  return (
    <AppScreen eyebrow="7,000+ INSTRUMENTS" title="Screener"
      right={<button onClick={() => go("stocksage")} style={{ height: 40, padding: "0 12px", borderRadius: 11, border: "2px solid var(--ink)", background: "var(--pop-5)", display: "flex", alignItems: "center", gap: 6, boxShadow: "2px 2px 0 var(--ink)", cursor: "pointer", fontWeight: 800, fontSize: 12, color: "#1d1d1b" }}><Icon name="sparkles" size={15} color="#1d1d1b" />AI</button>}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1, marginTop: 6 }}>FILTERS</div>
      <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
        {filters.map(f => {
          const on = active.includes(f);
          return <button key={f} onClick={() => toggle(f)} style={{ padding: "7px 13px", borderRadius: 99, border: "2px solid var(--ink)", background: on ? "var(--emerald)" : "var(--paper-3)", color: on ? "#1d1d1b" : "var(--ink)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", boxShadow: on ? "none" : "2px 2px 0 var(--ink)" }}>{on ? "✓ " : ""}{f}</button>;
        })}
      </div>
      <SectionLabel>{results.length * 8} matches</SectionLabel>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 13, overflow: "hidden", boxShadow: "3px 3px 0 var(--ink)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 0.7fr 1fr", background: "var(--ink)", color: "var(--paper)", padding: "9px 13px", fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 0.5 }}>
          <span>STOCK</span><span>SECTOR</span><span>PE</span><span style={{ textAlign: "right" }}>LTP</span>
        </div>
        {results.map((r, i) => (
          <div key={r[0]} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 0.7fr 1fr", padding: "12px 13px", background: i % 2 ? "var(--paper-2)" : "var(--paper-3)", borderTop: "1.5px solid var(--rule-soft)", alignItems: "center" }}>
            <span style={{ fontWeight: 800, fontSize: 13.5, color: "var(--ink)" }}>{r[0]}</span>
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{r[1]}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink-2)" }}>{r[2]}</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: "var(--ink)", textAlign: "right" }}>{r[3]}</span>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── Strategies ──────────────────────────────────────────────────────────────
function StrategiesScreen() {
  const strats = [
    { t: "Golden crossover", d: "50-DMA crosses above 200-DMA", tag: "MOMENTUM", c: "var(--pop-3)", ret: "+18.2%", win: "64%" },
    { t: "Low PE value", d: "PE < sector median, ROE > 15%", tag: "VALUE", c: "var(--pop-2)", ret: "+12.6%", win: "58%" },
    { t: "Dividend aristocrats", d: "10y rising dividend, yield > 2%", tag: "INCOME", c: "var(--emerald)", ret: "+9.8%", win: "71%" },
    { t: "RSI oversold bounce", d: "RSI < 30 with volume spike", tag: "MEAN REVERT", c: "var(--pop-4)", ret: "+15.1%", win: "52%" },
  ];
  return (
    <AppScreen eyebrow="BACKTESTED ON NSE" title="Strategies"
      right={<Pill color="var(--emerald-text)">● LIVE</Pill>}>
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 12 }}>
        {strats.map(s => (
          <div key={s.t} style={{ padding: 16, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div><div style={{ fontWeight: 800, fontSize: 16, color: "var(--ink)", letterSpacing: -0.3 }}>{s.t}</div><div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 3 }}>{s.d}</div></div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, color: "#1d1d1b", background: s.c, border: "1.5px solid var(--ink)", borderRadius: 99, padding: "3px 8px", flexShrink: 0 }}>{s.tag}</span>
            </div>
            <div style={{ marginTop: 13, display: "flex", gap: 18 }}>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 1 }}>CAGR</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 800, color: "var(--emerald-text)" }}>{s.ret}</div></div>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 1 }}>WIN RATE</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 800, color: "var(--ink)" }}>{s.win}</div></div>
              <button style={{ marginLeft: "auto", alignSelf: "flex-end", padding: "8px 14px", borderRadius: 10, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Backtest</button>
            </div>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── Research List ───────────────────────────────────────────────────────────
function ResearchListScreen() {
  const items = [
    { t: "INFY — Q4 deep dive", depth: "L4 · ADVANCED", c: "var(--pop-5)", d: "Margins, deal pipeline, attrition. 14 sources.", time: "2h ago" },
    { t: "Is RELIANCE's retail arm undervalued?", depth: "L3 · DEEP", c: "var(--pop-3)", d: "SOTP vs market cap. 9 sources.", time: "yesterday" },
    { t: "FMCG vs rural recovery", depth: "L2 · STANDARD", c: "var(--pop-2)", d: "ITC, HUL, Nestle compared.", time: "2d ago" },
    { t: "Should I exit WIPRO?", depth: "L1 · FLASH", c: "var(--emerald)", d: "Quick read on your holding.", time: "3d ago" },
  ];
  return (
    <AppScreen eyebrow="SAVED SAGE RESEARCH" title="Research List">
      <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 11 }}>
        {items.map(it => (
          <div key={it.t} style={{ padding: 15, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, color: "#1d1d1b", background: it.c, borderRadius: 99, padding: "3px 8px" }}>{it.depth}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{it.time}</span>
            </div>
            <div style={{ fontWeight: 800, fontSize: 15, color: "var(--ink)", lineHeight: 1.2 }}>{it.t}</div>
            <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4 }}>{it.d}</div>
            <div style={{ marginTop: 9, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--emerald-text)" }}>Open report →</div>
          </div>
        ))}
      </div>
    </AppScreen>
  );
}

// ── News & Events ───────────────────────────────────────────────────────────
function NewsScreen() {
  const [tab, setTab] = dUS(0);
  const news = [
    { tag: "MARKETS", c: "var(--pop-3)", t: "Nifty closes at record high on IT, auto strength", time: "1h", src: "Mint" },
    { tag: "YOUR STOCK", c: "var(--emerald)", t: "Reliance announces ₹11,000cr retail expansion", time: "3h", src: "ET" },
    { tag: "RBI", c: "var(--pop-1)", t: "MPC holds repo rate at 6.25%, stance neutral", time: "5h", src: "BS" },
    { tag: "EARNINGS", c: "var(--pop-2)", t: "Infosys beats Q4 estimates, raises FY guidance", time: "1d", src: "Reuters" },
  ];
  const events = [
    { d: "02 Jun", t: "TCS — dividend record date", tag: "₹27/sh" },
    { d: "05 Jun", t: "INFY — AGM", tag: "AGM" },
    { d: "08 Jun", t: "RELIANCE — Q1 results", tag: "EARNINGS" },
    { d: "12 Jun", t: "ITC ex-dividend", tag: "₹7.5/sh" },
  ];
  return (
    <AppScreen eyebrow="PERSONALISED TO YOUR HOLDINGS" title="News & Events">
      <div style={{ display: "flex", gap: 8, marginTop: 6, marginBottom: 14 }}>
        {["News", "Events"].map((x, i) => (
          <button key={x} onClick={() => setTab(i)} style={{ padding: "7px 18px", borderRadius: 99, border: "2px solid var(--ink)", background: tab === i ? "var(--ink)" : "var(--paper-3)", color: tab === i ? "var(--paper)" : "var(--ink)", fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: tab === i ? "none" : "2px 2px 0 var(--ink)" }}>{x}</button>
        ))}
      </div>
      {tab === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {news.map(n => (
            <div key={n.t} style={{ padding: 15, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, color: "#1d1d1b", background: n.c, borderRadius: 99, padding: "3px 8px" }}>{n.tag}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{n.src} · {n.time}</span>
              </div>
              <div style={{ fontWeight: 700, fontSize: 14.5, color: "var(--ink)", lineHeight: 1.3 }}>{n.t}</div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {events.map(e => (
            <div key={e.t} style={{ display: "flex", alignItems: "center", gap: 13, padding: 14, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
              <div style={{ width: 48, textAlign: "center", flexShrink: 0 }}><div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 15, color: "var(--ink)", lineHeight: 1 }}>{e.d.split(" ")[0]}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{e.d.split(" ")[1]}</div></div>
              <div style={{ flex: 1, fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{e.t}</div>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--emerald-text)", background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 99, padding: "3px 8px" }}>{e.tag}</span>
            </div>
          ))}
        </div>
      )}
    </AppScreen>
  );
}

Object.assign(window, { MarketsScreen, ScreenerScreen, StrategiesScreen, ResearchListScreen, NewsScreen });
