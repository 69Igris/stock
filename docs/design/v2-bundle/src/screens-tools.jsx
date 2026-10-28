// ─────────────────────────────────────────────────────────────────────────
// TOOLS — Paper trading (Chat/Overview/Terminal/Positions/History),
// FIRE calculator, Calculators, Risk report, Tax report, Document vault
// ─────────────────────────────────────────────────────────────────────────
const { useState: tlS } = React;

// ── Paper trading (tabbed) ─────────────────────────────────────────────────────
function PaperScreen({ go }) {
  const [tab, setTab] = tlS("Overview");
  return (
    <AppPage eyebrow="PAPER TRADING · LIVE NSE TICKS" title={<>Trade for <span className="ser">real,</span> risk <span className="strike">nothing.</span></>}>
      <div className="pf-seg" style={{ marginBottom: 14 }}>
        {["Chat", "Overview", "Terminal", "Positions", "History"].map(t => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>
      {tab === "Overview" && (
        <div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
            <div className="pf-card pf-stat"><div className="l">Paper equity</div><div className="v">₹10.84L</div><div className="d pos">▲ ₹84,200 · 8.4%</div></div>
            <div className="pf-card pf-stat"><div className="l">Max drawdown</div><div className="v">-6.2%</div><div className="d">12 trades</div></div>
          </div>
          <div className="pf-card" style={{ marginTop: 12, padding: 16 }}>
            <div className="ttl">EQUITY CURVE · 90D</div>
            <div style={{ marginTop: 12, height: 90, display: "flex", alignItems: "flex-end", gap: 4 }}>
              {[30, 38, 34, 46, 52, 48, 60, 58, 70, 66, 82, 90].map((h, k) => <div key={k} style={{ flex: 1, height: `${h}%`, borderRadius: "3px 3px 0 0", background: k === 11 ? "var(--emerald)" : "var(--ink)" }} />)}
            </div>
          </div>
        </div>
      )}
      {tab === "Terminal" && (
        <div>
          <div className="pf-card" style={{ padding: 16 }}>
            <div className="ttl">ORDER TICKET · RELIANCE</div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button style={{ flex: 1, padding: "11px", borderRadius: 9, border: "2px solid var(--ink)", background: "var(--emerald)", color: "#fff", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>BUY</button>
              <button style={{ flex: 1, padding: "11px", borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper)", color: "var(--loss)", fontWeight: 800, fontSize: 14, cursor: "pointer" }}>SELL</button>
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginBottom: 5, letterSpacing: 1 }}>QTY</div><input className="pf-input" defaultValue="10" /></div>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginBottom: 5, letterSpacing: 1 }}>LIMIT PRICE · LTP ₹2,942</div><input className="pf-input" defaultValue="2,940" /></div>
            </div>
            <button style={{ width: "100%", marginTop: 14, padding: 13, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)" }}>Place paper order</button>
          </div>
        </div>
      )}
      {tab === "Positions" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {[{ n: "RELIANCE", q: "+10", pl: "+₹3,200", up: true }, { n: "INFY", q: "-25", pl: "-₹1,100", up: false }, { n: "TCS", q: "+12", pl: "+₹4,800", up: true }].map(p => (
            <div key={p.n} className="pf-row">
              <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)", fontFamily: "var(--font-mono)" }}>{p.n}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{p.q} qty · {p.up ? "LONG" : "SHORT"}</div></div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: p.up ? "var(--emerald-text)" : "var(--loss)" }}>{p.pl}</div>
            </div>
          ))}
        </div>
      )}
      {tab === "History" && (
        <div className="pf-card flat" style={{ padding: "4px 6px", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--ink)" }}>
          <table className="pf-tbl"><thead><tr><th>Symbol</th><th>Result</th><th style={{ textAlign: "right" }}>P&L</th></tr></thead>
            <tbody>{[{ n: "WIPRO", r: "WIN", pl: "+₹2,100", up: true }, { n: "PAYTM", r: "LOSS", pl: "-₹900", up: false }, { n: "DMART", r: "WIN", pl: "+₹3,400", up: true }].map(h => (
              <tr key={h.n}><td><span className="tk">{h.n}</span></td><td><span className="pf-pill" style={{ background: h.up ? "var(--emerald-bg)" : "transparent", color: h.up ? "var(--emerald-text)" : "var(--loss)", borderColor: h.up ? "var(--emerald)" : "var(--loss)" }}>{h.r}</span></td><td className="num" style={{ color: h.up ? "var(--emerald-text)" : "var(--loss)" }}>{h.pl}</td></tr>
            ))}</tbody></table>
        </div>
      )}
      {tab === "Chat" && (
        <div className="pf-card" style={{ padding: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}><span style={{ width: 26, height: 26, borderRadius: 7, background: "var(--pop-5)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={14} color="#fff" /></span><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>SAGE · PAPER COACH</span></div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>Your paper book is up 8.4% but the RSI strategy is dragging it. Want me to backtest a tighter stop-loss before your next entry?</div>
          <button onClick={() => go("sagechat")} style={{ marginTop: 12, padding: "9px 14px", borderRadius: 9, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Open full chat →</button>
        </div>
      )}
    </AppPage>
  );
}

// ── FIRE calculator ────────────────────────────────────────────────────────────
function FireSlider({ label, value, set, min, max, step, fmt, unit }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-2)" }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, color: "var(--ink)", whiteSpace: "nowrap", flexShrink: 0, marginLeft: 10 }}>{fmt ? fmt(value) : value}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => set(+e.target.value)} style={{ width: "100%", accentColor: "var(--emerald)" }} />
    </div>
  );
}
function FireScreen({ go }) {
  const [tab, setTab] = tlS("Plan");
  const [age, setAge] = tlS(32);
  const [retire, setRetire] = tlS(47);
  const [life, setLife] = tlS(85);
  const [corpus, setCorpus] = tlS(1490000);
  const [sip, setSip] = tlS(45000);
  const [salHike, setSalHike] = tlS(8);
  const [savHike, setSavHike] = tlS(10);
  const [wr, setWr] = tlS(4);
  const inr = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
  const lakh = (n) => n >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : `₹${(n / 1e5).toFixed(1)} L`;
  // toy projection: monthly expenses ~₹68k, fire = annual exp / wr
  const monthlyExp = 68000;
  const fireNum = (monthlyExp * 12) / (wr / 100);
  const years = retire - age;
  const onTrack = sip >= 38000;
  return (
    <AppPage eyebrow="FIRE · INDIAN ASSUMPTIONS · ₹" title={<>Retire on <span className="ser">your</span> number.</>} sub="STCG, LTCG, PPF & EPF aware.">
      {/* summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <div className="pf-card pf-stat" style={{ padding: 13 }}><div className="l">FIRE number</div><div className="v" style={{ fontSize: 20 }}>{lakh(fireNum)}</div><div className="d" style={{ color: "var(--ink-3)" }}>target corpus</div></div>
        <div className="pf-card pf-stat" style={{ padding: 13, boxShadow: `3px 3px 0 ${onTrack ? "var(--emerald)" : "var(--pop-1)"}` }}><div className="l">Years to FIRE</div><div className="v" style={{ fontSize: 20, color: onTrack ? "var(--emerald-text)" : "var(--pop-1-text)" }}>{years}y</div><div className="d" style={{ color: "var(--ink-3)" }}>retire at {retire}</div></div>
        <div className="pf-card pf-stat" style={{ padding: 13 }}><div className="l">Monthly expenses</div><div className="v" style={{ fontSize: 20 }}>{inr(monthlyExp)}</div><div className="d" style={{ color: "var(--ink-3)" }}>6.0% inflation</div></div>
        <div className="pf-card pf-stat" style={{ padding: 13 }}><div className="l">Status</div><div className="v" style={{ fontSize: 18, color: onTrack ? "var(--emerald-text)" : "var(--pop-1-text)" }}>{onTrack ? "✓ On track" : "⚠ Behind"}</div><div className="d" style={{ color: "var(--ink-3)" }}>{onTrack ? "keep going" : "save more"}</div></div>
      </div>

      {/* projection */}
      <div className="pf-card" style={{ marginTop: 14, padding: 16, background: "var(--ink)", color: "var(--paper)", boxShadow: "5px 5px 0 var(--pop-2)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.6)", letterSpacing: 1.2 }}>WEALTH PROJECTION</div>
        <div style={{ marginTop: 12, height: 84, display: "flex", alignItems: "flex-end", gap: 4 }}>
          {Array.from({ length: 14 }).map((_, k) => { const h = Math.round(14 + Math.pow(k / 13, 1.8) * 86); const done = k >= Math.round((years / (life - age)) * 13); return <div key={k} style={{ flex: 1, height: `${h}%`, borderRadius: "3px 3px 0 0", background: done ? "var(--pop-2)" : "rgba(244,237,224,0.32)" }} />; })}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.6)" }}><span>AGE {age}</span><span style={{ color: "var(--pop-2)", fontWeight: 700 }}>AGE {retire} · FIRE ✦</span><span>AGE {life}</span></div>
      </div>

      {/* tabs */}
      <div className="pf-seg" style={{ marginTop: 16 }}>
        {["Plan", "Allocation", "Expenses"].map(t => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {tab === "Plan" && (
        <div className="pf-card" style={{ marginTop: 12, padding: 16 }}>
          <div className="ttl">PARAMETERS</div>
          <FireSlider label="Current age" value={age} set={setAge} min={18} max={60} step={1} unit=" yrs" />
          <FireSlider label="Target retirement age" value={retire} set={setRetire} min={age + 1} max={75} step={1} unit=" yrs" />
          <FireSlider label="Life expectancy" value={life} set={setLife} min={70} max={100} step={1} unit=" yrs" />
          <FireSlider label="Current corpus" value={corpus} set={setCorpus} min={0} max={20000000} step={50000} fmt={lakh} />
          <FireSlider label="Monthly savings (SIP)" value={sip} set={setSip} min={5000} max={200000} step={5000} fmt={inr} />
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1.5px dashed var(--rule-soft)" }}>
            <div className="ttl" style={{ display: "flex", alignItems: "center", gap: 6 }}><Icon name="trending" size={13} color="var(--ink-3)" /> INCOME GROWTH</div>
            <FireSlider label="Annual salary increment" value={salHike} set={setSalHike} min={0} max={30} step={0.5} unit="%" />
            <FireSlider label="Annual savings increment" value={savHike} set={setSavHike} min={0} max={30} step={0.5} unit="%" />
          </div>
          <FireSlider label="Safe withdrawal rate" value={wr} set={setWr} min={2} max={8} step={0.1} unit="%" />
        </div>
      )}

      {tab === "Allocation" && (
        <div className="pf-card" style={{ marginTop: 12, padding: 16 }}>
          <div className="ttl">ASSET ALLOCATION · EXPECTED RETURN 11.4%</div>
          <div style={{ display: "flex", height: 14, borderRadius: 99, overflow: "hidden", border: "1.5px solid var(--ink)", marginTop: 12 }}>
            {[["var(--emerald)", 55], ["var(--pop-3)", 20], ["var(--pop-2)", 15], ["var(--pop-5)", 10]].map(([c, w], i) => <div key={i} style={{ width: `${w}%`, background: c }} />)}
          </div>
          <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            {[["Equity / MF", "55%", "12.5%", "var(--emerald)"], ["Debt / PPF / EPF", "20%", "7.2%", "var(--pop-3)"], ["Gold", "15%", "9.0%", "var(--pop-2)"], ["Cash / liquid", "10%", "6.5%", "var(--pop-5)"]].map(([n, w, r, c]) => (
              <div key={n} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 12, height: 12, borderRadius: 4, background: c, border: "1.5px solid var(--ink)" }} />
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{n}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--ink-3)" }}>exp {r}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 800, color: "var(--ink)", minWidth: 38, textAlign: "right" }}>{w}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "Expenses" && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="pf-card" style={{ padding: 16 }}>
            <div className="ttl">MONTHLY EXPENSES · {inr(monthlyExp)}</div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
              {[["Housing / rent", "₹26,000"], ["Food & groceries", "₹14,000"], ["Lifestyle", "₹12,000"], ["Utilities & misc", "₹16,000"]].map(([n, v]) => (
                <div key={n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{n}</span><span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{v}</span></div>
              ))}
            </div>
            <button style={{ marginTop: 12, padding: "8px 13px", borderRadius: 9, border: "2px dashed var(--ink-3)", background: "transparent", color: "var(--ink-3)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}><Icon name="plus" size={14} color="var(--ink-3)" /> Add expense</button>
          </div>
          <div className="pf-card" style={{ padding: 16 }}>
            <div className="ttl">ONE-TIME GOALS</div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
              {[["Child education · 2032", "₹40 L"], ["Home down-payment · 2028", "₹25 L"]].map(([n, v]) => (
                <div key={n} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontSize: 13.5, color: "var(--ink-2)" }}>{n}</span><span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{v}</span></div>
              ))}
            </div>
          </div>
        </div>
      )}

      <button style={{ width: "100%", marginTop: 16, padding: 14, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", fontWeight: 800, fontSize: 14.5, cursor: "pointer", boxShadow: "3px 3px 0 var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Icon name="download" size={16} color="var(--ink)" /> Save this scenario</button>
    </AppPage>
  );
}

// ── Calculators ────────────────────────────────────────────────────────────────
function CalculatorsScreen({ go }) {
  const calcs = [
    { i: "trending", t: "SIP", c: "var(--pop-3)" }, { i: "wallet", t: "Lumpsum", c: "var(--pop-2)" },
    { i: "home", t: "EMI", c: "var(--pop-1)" }, { i: "briefcase", t: "FD", c: "var(--emerald)" },
    { i: "receipt", t: "STCG", c: "var(--pop-5)" }, { i: "receipt", t: "LTCG", c: "var(--pop-4)" },
    { i: "pie", t: "Asset mix", c: "var(--pop-3)" }, { i: "calc", t: "PPF", c: "var(--pop-2)" },
    { i: "calc", t: "NPS", c: "var(--pop-1)" }, { i: "activity", t: "XIRR", c: "var(--emerald)" },
    { i: "flame", t: "Retirement", c: "var(--pop-5)" }, { i: "scale", t: "Goal", c: "var(--pop-4)" },
  ];
  return (
    <AppPage eyebrow="CALCULATORS · 12 IN ALL" title={<>Run the <span className="hl">numbers.</span></>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {calcs.map(c => (
          <button key={c.t} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "16px 4px", borderRadius: 13, border: "2px solid var(--ink)", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, background: c.c, border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name={c.i} size={19} color="#1d1d1b" /></span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>{c.t}</span>
          </button>
        ))}
      </div>
    </AppPage>
  );
}

// ── Risk report ──────────────────────────────────────────────────────────────
function RiskScreen({ go }) {
  const metrics = [["Volatility", "14.2%", "Moderate"], ["Beta vs Nifty", "1.08", "Market-like"], ["Sharpe", "1.34", "Healthy"], ["Max drawdown", "-18%", "2022 dip"]];
  return (
    <AppPage eyebrow="RISK REPORT · STRESS-TESTED" title={<>How much <span className="ser">risk</span> are you really taking?</>}>
      <div className="pf-card" style={{ padding: 18, textAlign: "center" }}>
        <div className="ttl">RISK PROFILE</div>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 30, color: "var(--pop-1-text)", marginTop: 8 }}>AGGRESSIVE</div>
        <div style={{ marginTop: 14, height: 12, borderRadius: 99, background: "var(--rule-soft)", overflow: "hidden", border: "1.5px solid var(--ink)" }}>
          <div style={{ width: "78%", height: "100%", background: "linear-gradient(90deg, var(--emerald), var(--pop-2), var(--pop-1))" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}><span>CONSERVATIVE</span><span>AGGRESSIVE</span></div>
      </div>
      <div className="pf-sec-h"><span className="n">σ</span><h3>Key metrics</h3><span className="rule" /></div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
        {metrics.map(([l, v, d]) => (
          <div key={l} className="pf-card pf-stat"><div className="l">{l}</div><div className="v">{v}</div><div className="d" style={{ color: "var(--ink-3)" }}>{d}</div></div>
        ))}
      </div>
      <div className="pf-card" style={{ marginTop: 12, padding: 15, background: "var(--pop-1)", color: "#fff", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--ink)" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}><Icon name="alert" size={20} color="#fff" /><div><div style={{ fontWeight: 800, fontSize: 14 }}>Stress test: -20% market</div><div style={{ fontSize: 13, marginTop: 3, lineHeight: 1.4, opacity: 0.95 }}>Your book would fall ~₹1.5L. Concentration in IT amplifies the hit.</div></div></div>
      </div>
    </AppPage>
  );
}

// ── Tax report ───────────────────────────────────────────────────────────────
function TaxScreen({ go }) {
  return (
    <AppPage eyebrow="TAX REPORT · ITR-2 READY" title={<>Tax season, <span className="ser">sorted.</span></>} sub="Capital gains, FIFO-paired & export-ready.">
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 12 }}>
        <div className="pf-card pf-stat"><div className="l">STCG (FY26)</div><div className="v">₹42,180</div><div className="d" style={{ color: "var(--ink-3)" }}>tax @ 20% = ₹8,436</div></div>
        <div className="pf-card pf-stat"><div className="l">LTCG (FY26)</div><div className="v">₹1,18,400</div><div className="d pos">₹1.25L exempt</div></div>
      </div>
      <div className="pf-card" style={{ padding: 16 }}>
        <div className="ttl">REALISED GAINS BY HEAD</div>
        <table className="pf-tbl" style={{ marginTop: 8 }}>
          <tbody>
            {[["Equity STCG", "₹42,180", "var(--ink)"], ["Equity LTCG", "₹1,18,400", "var(--emerald-text)"], ["F&O turnover", "₹6.2L", "var(--ink)"], ["Intraday", "₹3,100", "var(--loss)"]].map(([l, v, c]) => (
              <tr key={l}><td>{l}</td><td className="num" style={{ color: c }}>{v}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <button style={{ width: "100%", marginTop: 14, padding: 14, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}><Icon name="download" size={17} color="var(--paper)" /> Export ITR-2 statement</button>
    </AppPage>
  );
}

// ── Document vault ─────────────────────────────────────────────────────────────
function DocumentsScreen({ go }) {
  const docs = [
    { t: "Zerodha contract notes", d: "PDF · 24 files · FY26", i: "file", c: "var(--pop-3)" },
    { t: "Holdings statement", d: "PDF · May 2026", i: "file", c: "var(--pop-2)" },
    { t: "Form 26AS", d: "PDF · AY 2026-27", i: "receipt", c: "var(--pop-5)" },
    { t: "Capital gains report", d: "XLSX · generated", i: "barChart", c: "var(--emerald)" },
  ];
  return (
    <AppPage eyebrow="DOCUMENT VAULT · ENCRYPTED" title={<>Every <span className="hl">statement,</span> safe.</>} right={<button className="pf-pill gold" style={{ marginTop: 12, cursor: "pointer" }}><Icon name="upload" size={12} color="#1d1d1b" /> UPLOAD</button>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {docs.map(d => (
          <div key={d.t} className="pf-row">
            <span className="ic" style={{ background: d.c }}><Icon name={d.i} size={18} color="#1d1d1b" /></span>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>{d.t}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>{d.d}</div></div>
            <button style={{ width: 32, height: 32, borderRadius: 8, border: "1.5px solid var(--rule-soft)", background: "var(--paper)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="download" size={15} color="var(--ink-2)" /></button>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 9, padding: 13, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 12 }}>
        <Icon name="lock" size={15} color="var(--emerald-text)" /><span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--emerald-text)" }}>AES-256-GCM · Mumbai region</span>
      </div>
    </AppPage>
  );
}

Object.assign(window, { PaperScreen, FireScreen, CalculatorsScreen, RiskScreen, TaxScreen, DocumentsScreen });
