// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2.1 · web-v2 parity: Screener with scans sheet, Strategies
// lifecycle (Catalog | Custom | Signals + 4-tab detail), Home layout presets,
// Settings → Developer (keys · MCP · usage · provenance).
// ─────────────────────────────────────────────────────────────────────────
const { useState: vpS } = React;
window.__umUS = window.__umUS || { persona: "nri" };
window.__umPreset = window.__umPreset || "intermediate";

const SCAN_SRC = { ENGINE: "var(--pop-2)", CHARTINK: "var(--pop-3)", STRATEGY: "var(--pop-5)", YOURS: "var(--emerald)" };
const SCANS2 = [
  { id: "momo", name: "Momentum breakouts", src: "ENGINE", plain: "Stocks breaking a 52-week high on above-average volume.", rules: ["Close > 52W high", "Vol > 1.5× 20D avg", "RSI 55–75"], syms: ["RELIANCE", "HAL", "DIXON", "IRCTC"], total: 23 },
  { id: "quality", name: "Quality compounders", src: "ENGINE", plain: "High return on equity, low debt, steady sales growth.", rules: ["ROE > 20%", "D/E < 0.3", "5Y sales CAGR > 12%"], syms: ["TCS", "HINDUNILVR", "ITC", "HAL"], total: 42 },
  { id: "ci-vcp", name: "VCP tightening", src: "CHARTINK", plain: "Volatility contraction ahead of a possible breakout.", rules: ["ATR(14) falling 3 wks", "Close within 5% of pivot"], syms: ["INFY", "DIXON"], total: 9 },
  { id: "st-mom12", name: "12-month momentum", src: "STRATEGY", plain: "Top decile 12M return, rebalanced monthly. From your Strategies.", rules: ["12M return · top 10%", "Skip last month", "Rebalance monthly"], syms: ["HAL", "DIXON", "IRCTC", "TATAMOTORS"], total: 18 },
  { id: "mine", name: "My dividend list", src: "YOURS", plain: "Your saved screen: yield above 2%, payout under 60%.", rules: ["Div yield > 2%", "Payout < 60%"], syms: ["ITC", "INFY", "HINDUNILVR"], total: 12 },
];
const STRATS = [
  { id: "mom12", name: "12-month momentum", status: "FORWARD", sharpe: 1.42, dd: -18.4, cagr: 22.1, plain: "Buy the top decile by 12-month return (skipping the most recent month), equal-weight, rebalance monthly.", src: "catalog", divergence: "amber" },
  { id: "lowvol", name: "Low-volatility quality", status: "VALIDATED", sharpe: 1.18, dd: -11.2, cagr: 15.6, plain: "Lowest-volatility third of NIFTY 200, filtered for ROE above 15%.", src: "catalog" },
  { id: "meanrev", name: "Mean reversion · 5D", status: "BACKTESTED", sharpe: 0.71, dd: -24.9, cagr: 9.8, plain: "Buy the 5-day biggest losers in NIFTY 100, hold 5 days.", src: "catalog", overfit: "HIGH" },
  { id: "defflexi", name: "My defensive flexi-cap", status: "DRAFT", plain: "Large-cap tilt, max 8% per name, dividend payers only.", src: "custom" },
];
const STATUS_ORDER = ["DRAFT", "BACKTESTED", "VALIDATED", "FORWARD", "RETIRED"];
const STATUS_BG = { DRAFT: "var(--paper-2)", BACKTESTED: "var(--pop-3)", VALIDATED: "var(--pop-5)", FORWARD: "var(--emerald)", RETIRED: "var(--ink-3)" };
function StatusChip({ s }) { return <Tag bg={STATUS_BG[s]} color={s === "RETIRED" ? "var(--paper)" : "#1d1d1b"} style={{ borderColor: "var(--ink)" }}>{s}</Tag>; }
function SrcBadge({ src }) { return <Tag bg={SCAN_SRC[src]} color="#1d1d1b" style={{ borderColor: "var(--ink)", fontSize: 8.5 }}>{src}</Tag>; }

// ── Screener v2 · scans as a sheet, one search box ──────────────────────────
function ScreenerV2Screen({ go, back, um }) {
  const [market, setMarket] = vpS("in");
  const [scanId, setScanId] = vpS("momo");
  const [q, setQ] = vpS("");
  const [ai, setAi] = vpS(false);
  const [locked, setLocked] = vpS(true);
  const flag = !!um.usFlag;
  const scan = SCANS2.find(s => s.id === scanId);
  const ql = q.trim().toLowerCase();
  const isPhrase = ql.length > 3 && ql.includes(" ");
  const rows = ai ? ["HDFCBANK", "INFY", "ITC", "SBIN"] : scan ? scan.syms : Object.keys(STOCKS).slice(0, 8);
  const openScans = () => um.setSheet({ title: "Scans", body: (
    <div>
      <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-3)", marginBottom: 12 }}>A scan is a saved screener query, whoever authored it. Tap one — it runs in place.</div>
      <ListCard>{SCANS2.map((s, i) => <RowItem key={s.id} last={i === SCANS2.length - 1} onClick={() => { setScanId(s.id); setAi(false); setLocked(true); um.setSheet(null); }} left={<span style={{ width: 8, height: 34, borderRadius: 4, background: SCAN_SRC[s.src], border: "1.5px solid var(--ink)", flexShrink: 0 }} />} title={s.name} sub={s.plain} right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, color: "var(--gain-text)" }}>{s.total}</span>} rightSub={<SrcBadge src={s.src} />} />)}</ListCard>
      <div style={{ marginTop: 12 }}><GhostBtn icon="upload" onClick={() => { um.setSheet(null); um.toast("Saved as scan · YOURS"); }}>Save current filters as a scan</GhostBtn></div>
    </div>) });
  return (
    <SubPage um={um} title="Screener" onBack={back} right={flag ? <Seg grow={false} size={10.5} value={market} onChange={setMarket} options={[{ k: "in", label: "INDIA" }, { k: "us", label: "US" }]} /> : <Tag>NSE · BSE</Tag>}>
      <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 9, border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)", padding: "0 12px", boxShadow: "3px 3px 0 var(--ink)" }}>
        <Icon name="search" size={16} color="var(--ink-3)" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Ticker, or plain English: “undervalued large caps”" style={{ flex: 1, border: 0, outline: 0, background: "transparent", padding: "12px 0", fontSize: 14, color: "var(--ink)", fontFamily: "var(--font-sans)", minWidth: 0 }} />
      </div>
      {isPhrase && <Press onClick={() => { setAi(true); setScanId(null); setQ(""); }}><div style={{ marginTop: 8, border: "2px solid var(--ink)", borderRadius: 10, background: "var(--pop-2)", padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "#1d1d1b" }}>↵ BUILD FILTERS FROM “{q.trim()}”</div></Press>}
      {market === "us" && !flag ? (
        <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--pop-2)" style={{ marginTop: 16, color: "var(--paper)" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.4, color: "var(--pop-2)", fontWeight: 800 }}>FLAG us-stocks-listing · OFF</div><div style={{ fontWeight: 800, fontSize: 20, letterSpacing: -0.6, marginTop: 6 }}>Not on your plan yet.</div><div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 4, lineHeight: 1.5 }}>In production this pill is absent while the flag is off. At launch the gate becomes a pricing tier.</div><div style={{ marginTop: 12 }}><PrimaryBtn onClick={() => um.setUsFlag(true)}>Turn the flag on</PrimaryBtn></div></Card>
      ) : (
        <>
          <div style={{ display: "flex", gap: 7, marginTop: 12, overflowX: "auto", paddingBottom: 4 }}>
            <Chip active onClick={openScans}>☰ Scans</Chip>
            {(market === "us" ? ["P/E < 20", "Rev growth > 10%", "SEC 10-Q < 45d"] : ["Large cap", "PE < 25", "ROE > 15%", "Nifty 500"]).map(c => <Chip key={c}>{c}</Chip>)}
            <Chip>+3</Chip>
          </div>
          {(scan || ai) && (
            <Card pad={12} style={{ marginTop: 12, background: "var(--paper-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}><SrcBadge src={ai ? "ENGINE" : scan.src} /><b style={{ flex: 1, fontSize: 13.5, color: "var(--ink)" }}>{ai ? "AI filters" : scan.name}</b><button onClick={() => { setScanId(null); setAi(false); }} style={{ border: 0, background: "transparent", cursor: "pointer", display: "flex" }}><Icon name="x" size={14} color="var(--ink-3)" /></button></div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>{(ai ? ["PE < 18", "Mkt cap > ₹50k Cr", "ROE > 12%"] : scan.rules).map(r => <Tag key={r} bg={locked ? "var(--paper)" : "var(--pop-2)"} color="var(--ink)" style={{ borderColor: "var(--ink)", textTransform: "none", letterSpacing: 0 }}>{r}{!locked && " ✎"}</Tag>)}</div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>{ai ? "3 FILTERS · 4 MATCHES" : `${scan.total} MATCHES · RAN 16:05 IST`}{market === "us" && " · ◷ EOD"}</span>{!ai && <span onClick={() => setLocked(l => !l)} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, color: "var(--emerald-text)", cursor: "pointer" }}>{locked ? "EDIT AS FILTERS →" : "UNSAVED DRAFT · SAVE AS SCAN"}</span>}</div>
            </Card>
          )}
          <SecHead label={`${rows.length} matches`} right={<Tag>{market === "us" ? "SEC + EOD TAPE" : "NSE BHAVCOPY · EOD"}</Tag>} />
          <ListCard>{rows.map((sym, i) => { const st = STOCKS[sym] || { name: sym, ltp: 0, chg: 0 }; const us = market === "us"; return <RowItem key={sym} last={i === rows.length - 1} onClick={() => go(us ? "usstock:AAPL" : "stock:" + sym)} left={<SymTile sym={us ? ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "BRK-B"][i] : sym} size={36} />} title={us ? ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "BRK-B"][i] : sym} sub={us ? "◷ EOD · 10-Q May 02" : st.name} right={us ? "$" + [211.04, 441.2, 168.42, 188.62, 223.1, 712.4, 318.9, 486.2][i] : "₹" + inr(st.ltp, 1)} rightSub={<Num v={us ? [0.86, 0.41, -1.12, 0.22, 0.9, -0.3, 2.1, 0.1][i] : st.chg} fmt="pct" dec={2} size={10.5} />} />; })}</ListCard>
          {scan && scan.total === 0 && <EmptyState icon="search" title="Nothing matches today" sub="This scan re-runs at 16:05 IST." />}
        </>
      )}
      <div style={{ marginTop: 14, textAlign: "center" }}><span onClick={() => go("strategies")} style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 800, color: "var(--emerald-text)", cursor: "pointer" }}>TRACK THIS SCAN AS A STRATEGY →</span></div>
    </SubPage>
  );
}

// ── Strategies · Catalog | Custom | Signals ─────────────────────────────────
function StrategiesScreen({ go, back, um }) {
  const [tab, setTab] = vpS("catalog");
  const list = STRATS.filter(s => tab === "signals" || s.src === tab);
  const SIGNALS = [["Today · 16:05", "mom12", "HAL", "Entered top decile · 12M +48%"], ["Today · 16:05", "mom12", "TATAMOTORS", "Dropped out · rank 14"], ["Yesterday", "lowvol", "HINDUNILVR", "Vol rank 3 · ROE 19%"], ["Mon", "meanrev", "SBIN", "5D −6.2% · buy signal"]];
  return (
    <SubPage um={um} title="Strategies" onBack={back} right={<GhostBtn full={false} icon={null} style={{ padding: "8px 11px", fontSize: 12 }} onClick={() => um.toast("Create AI strategy · 3 credits", "info")}>+ New</GhostBtn>}>
      <div style={{ marginTop: 12 }}><Seg value={tab} onChange={setTab} size={12} options={[{ k: "catalog", label: "Catalog" }, { k: "custom", label: "Custom" }, { k: "signals", label: "Signals" }]} /></div>
      <div style={{ marginTop: 10, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13.5, color: "var(--ink-3)" }}>Screener = who matches now · strategy = does this rule set make money over time.</div>
      {tab !== "signals" ? (
        <>
          <SecHead label={`${list.length} strategies`} right={<Tag>DRAFT → BACKTESTED → VALIDATED → FORWARD</Tag>} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{list.map(s => (
            <Card key={s.id} pad={14} onClick={() => go("strategy:" + s.id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}><b style={{ flex: 1, fontSize: 15, color: "var(--ink)" }}>{s.name}</b><StatusChip s={s.status} /></div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 5, lineHeight: 1.45 }}>{s.plain}</div>
              {s.sharpe ? <div style={{ display: "flex", gap: 18, marginTop: 10 }}><StatCell label="Sharpe" value={s.sharpe.toFixed(2)} /><StatCell label="Max DD" value={pct(s.dd)} color="var(--loss)" /></div>
                : <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}><span style={{ fontSize: 12.5, color: "var(--ink-3)", fontStyle: "italic", fontFamily: "var(--font-serif)" }}>Not yet backtested — run it</span><CostChip n={2} /></div>}
            </Card>))}</div>
        </>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 12, overflowX: "auto" }}><Chip active>All</Chip>{STRATS.filter(s => s.sharpe).map(s => <Chip key={s.id}>{s.name}</Chip>)}</div>
          <SecHead label="Today" right={<Tag>EOD · 16:05 IST</Tag>} />
          <ListCard>{SIGNALS.slice(0, 2).map(([t, sid, sym, txt], i) => <RowItem key={sym} last={i === 1} onClick={() => go("strategy:" + sid + ":signals")} left={<SymTile sym={sym} size={34} />} title={sym} sub={txt} right={<Tag>{STRATS.find(s => s.id === sid).name.split(" ")[0]}</Tag>} />)}</ListCard>
          <SecHead label="Earlier" />
          <ListCard>{SIGNALS.slice(2).map(([t, sid, sym, txt], i) => <RowItem key={sym} last={i === 1} onClick={() => go("strategy:" + sid + ":signals")} left={<SymTile sym={sym} size={34} />} title={sym} sub={`${t} · ${txt}`} right={<Tag>{STRATS.find(s => s.id === sid).name.split(" ")[0]}</Tag>} />)}</ListCard>
        </>
      )}
    </SubPage>
  );
}

function StrategyDetailScreen({ go, back, param, um }) {
  const [id, t0] = (param || "mom12").split(":");
  const s = STRATS.find(x => x.id === id) || STRATS[0];
  const [tab, setTab] = vpS(t0 || "overview");
  const idx = STATUS_ORDER.indexOf(s.status);
  const has = (st) => idx >= STATUS_ORDER.indexOf(st);
  const teach = (need, txt) => <EmptyState icon="zap" title={`${need} first`} sub={txt} cta={need === "Backtest" ? "Run backtest · 2 credits" : "Start signals"} onCta={() => um.toast(need + " started", "info")} />;
  return (
    <SubPage um={um} title={s.name} onBack={back} right={<StatusChip s={s.status} />}>
      <div style={{ display: "flex", gap: 4, marginTop: 12 }}>{STATUS_ORDER.slice(0, 4).map((st, i) => <span key={st} style={{ flex: 1, height: 6, borderRadius: 99, border: "1.5px solid var(--ink)", background: i <= idx ? STATUS_BG[st] : "transparent" }} />)}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 14, overflowX: "auto", paddingBottom: 4 }}>{[["overview", "Overview"], ["backtest", "Backtest"], ["signals", "Signals"], ["forward", "Forward run"]].map(([k, l]) => <Chip key={k} active={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}</div>
      {tab === "overview" && (
        <>
          <Card pad={14} style={{ marginTop: 14 }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "var(--ink-3)" }}>RULES · PLAIN ENGLISH</div><div style={{ fontSize: 14, color: "var(--ink)", marginTop: 6, lineHeight: 1.5 }}>{s.plain}</div><div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--emerald-text)", fontWeight: 800 }}>VIEW AS DSL ›</div></Card>
          {s.sharpe && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}><Card pad={10}><StatCell label="CAGR" value={pct(s.cagr)} color="var(--gain-text)" /></Card><Card pad={10}><StatCell label="Sharpe" value={s.sharpe.toFixed(2)} /></Card><Card pad={10}><StatCell label="Max DD" value={pct(s.dd)} color="var(--loss)" /></Card></div>}
          {s.overfit && <GateBanner tier="OVERFIT · HIGH" line="PBO 0.61 · CPCV fails. Validate before you trust it." onUpgrade={() => setTab("backtest")} style={{ marginTop: 10 }} />}
          <div style={{ marginTop: 12 }}><GhostBtn icon="search" onClick={() => go("screener2")}>See current matches in the screener</GhostBtn></div>
        </>
      )}
      {tab === "backtest" && (has("BACKTESTED") ? (
        <>
          <Card pad={12} style={{ marginTop: 14 }}><div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", fontWeight: 700 }}><span>GROWTH OF ₹10,000 · 2016–2026</span><span style={{ color: "var(--gain-text)" }}>₹{inr(10000 * Math.pow(1 + s.cagr / 100, 10))}</span></div><LineChart series={genSeries(11, 80, 0.0035, 0.03, 10000 * Math.pow(1 + s.cagr / 100, 10))} h={110} baseline={26000} /><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 4 }}>DASHED = NIFTY 50 · COSTS 0.15% PER SIDE · SURVIVORSHIP-ADJUSTED</div></Card>
          <SecHead label="Validation" right={<Tag>CPCV · PBO</Tag>} />
          <ListCard>{[["Walk-forward · 8 folds", has("VALIDATED") ? "7 of 8 positive" : "4 of 8 positive"], ["Probability of overfit", has("VALIDATED") ? "0.12" : "0.61"], ["Deflated Sharpe", has("VALIDATED") ? "1.02" : "0.38"]].map(([l, v], i) => <RowItem key={l} last={i === 2} title={l} right={v} />)}</ListCard>
        </>
      ) : teach("Backtest", "Backtest this strategy to unlock Signals and Forward Run."))}
      {tab === "signals" && (has("VALIDATED") ? (
        <>
          <Card pad={12} style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--ink)" }}>EOD · 16:05 IST</div><div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Intraday for PRO · push + email on</div></div><div className="on" style={{ width: 40, height: 22, borderRadius: 99, background: "var(--emerald)", border: "2px solid var(--ink)", position: "relative" }}><span style={{ position: "absolute", right: 2, top: 2, width: 14, height: 14, borderRadius: 99, background: "var(--paper)", border: "1.5px solid var(--ink)" }} /></div></Card>
          <SecHead label="Recent signals" />
          <ListCard>{[["HAL", "Entered top decile · 12M +48% · ₹4,812"], ["TATAMOTORS", "Dropped out · rank 14 · ₹1,024"], ["DIXON", "Held · rank 3"]].map(([sym, txt], i) => <RowItem key={sym} last={i === 2} left={<SymTile sym={sym} size={34} />} title={sym} sub={txt} right={<Tag>{i === 0 ? "ENTRY" : i === 1 ? "EXIT" : "HOLD"}</Tag>} onClick={() => go("stock:" + sym)} />)}</ListCard>
        </>
      ) : teach(has("BACKTESTED") ? "Validate" : "Backtest", has("BACKTESTED") ? "Pass the overfit checks (CPCV, PBO) to start Signals." : "Backtest this strategy to unlock Signals."))}
      {tab === "forward" && (has("FORWARD") ? (
        <>
          <Card pad={14} bg="var(--paper-2)" style={{ marginTop: 14 }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "var(--ink-3)" }}>SIMULATION · NO REAL ORDERS WERE OR CAN BE PLACED</div><div style={{ display: "flex", gap: 16, marginTop: 8 }}><StatCell label="Hypothetical P&L" value="+₹1,18,400" color="var(--gain-text)" sub="+11.8% · 14 wks" /><StatCell label="vs NIFTY" value="+4.2%" color="var(--gain-text)" align="right" /></div></Card>
          {s.divergence && <Card pad={12} style={{ marginTop: 10, borderColor: "var(--pop-2)" }}><div style={{ display: "flex", gap: 10 }}><span style={{ width: 28, height: 28, borderRadius: 8, background: "var(--pop-2)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13, flexShrink: 0 }}>!</span><div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45 }}><b style={{ color: "var(--ink)" }}>Diverging from backtest.</b> Live Sharpe 0.84 sits outside the backtest band (1.1–1.7). Two more weeks before we call it.</div></div></Card>}
          <SecHead label="Shadow ledger" right={<Tag>INCL. COSTS</Tag>} />
          <ListCard>{[["HAL", "Signal 16:05 → fill 09:16 next day · ₹4,818", "+₹12,300"], ["DIXON", "Held since 12 May · ₹14,210", "+₹38,900"], ["TATAMOTORS", "Exited · ₹1,021 · slippage 0.08%", "−₹2,140"]].map(([sym, txt, pl], i) => <RowItem key={sym} last={i === 2} left={<SymTile sym={sym} size={34} />} title={sym} sub={txt} right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 700, color: pl.startsWith("−") ? "var(--loss)" : "var(--gain-text)" }}>{pl}</span>} />)}</ListCard>
        </>
      ) : teach(has("VALIDATED") ? "Run signals" : "Validate", has("VALIDATED") ? "Run signals for 2 weeks before Forward Run." : "Validate the backtest before a forward run."))}
    </SubPage>
  );
}

// ── Home layout presets (persona) ───────────────────────────────────────────
function HomePresetsScreen({ go, back, um }) {
  const [p, setP] = vpS(window.__umPreset);
  const DEFS = [["beginner", "Guide me", "Net worth in words, one next step, no jargon. Ask Sage with three simple prompts.", ["Words, not ratios", "One action card", "Learn tile"]], ["intermediate", "Keep me sharp", "Today's layout: holdings summary, compare-to-NIFTY, tax preview, insights.", ["Holdings summary", "Tax preview", "Insights card"]], ["advanced", "Get out of my way", "Dense terminal: watchlist + signals, XIRR · beta · drawdown, alerts. Minimal padding.", ["Mono tabular", "Signals rail", "No greeting"]]];
  const wire = (k) => <div style={{ display: "flex", gap: 3, width: 46, flexShrink: 0 }}>{(k === "beginner" ? [1] : k === "intermediate" ? [1, 1] : [1, 1, 1]).map((_, i) => <span key={i} style={{ flex: 1, height: 30, border: "1.5px solid var(--ink)", borderRadius: 3, background: p === k ? "var(--pop-2)" : "transparent" }} />)}</div>;
  return (
    <SubPage um={um} title="Home layout" onBack={back} footer={<PrimaryBtn onClick={() => { window.__umPreset = p; um.toast(`Layout: ${p}`); go("dashboard"); }}>Apply</PrimaryBtn>}>
      <div style={{ marginTop: 12, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-3)" }}>Same data underneath. The layout changes presentation, never advice.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>{DEFS.map(([k, n, d, chips]) => (
        <Press key={k} onClick={() => setP(k)}><div style={{ border: "2px solid var(--ink)", borderRadius: 14, padding: 14, background: p === k ? "var(--ink)" : "var(--paper-3)", color: p === k ? "var(--paper)" : "var(--ink)", boxShadow: p === k ? "3px 3px 0 var(--emerald)" : "3px 3px 0 var(--ink)", display: "flex", gap: 12 }}>{wire(k)}<div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 15 }}>{n}</div><div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 3, lineHeight: 1.45 }}>{d}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>{chips.map(c => <span key={c} style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 700, letterSpacing: 0.5, border: "1.5px solid currentColor", borderRadius: 5, padding: "2px 6px", opacity: 0.8 }}>{c.toUpperCase()}</span>)}</div></div></div></Press>
      ))}</div>
      <div style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", lineHeight: 1.6 }}>MANUAL PRESET · THE PERSONA ENGINE TAKES OVER LATER · PERSISTS PER SURFACE</div>
    </SubPage>
  );
}

// ── Settings → Developer ────────────────────────────────────────────────────
function DevSettingsScreen({ go, back, um }) {
  const [keys, setKeys] = vpS([["um_live_…8f2a", "Claude Desktop", "2h ago"], ["um_live_…c41d", "Cursor", "Jul 12"]]);
  const PROV = { "CONSENTED-BROKER": "var(--pop-3)", "BHAVCOPY-DERIVED": "var(--pop-2)", "PURE-COMPUTE": "var(--pop-5)", EDGAR: "var(--emerald)" };
  const TOOLS = [["get_holdings", "CONSENTED-BROKER"], ["get_quote", "BHAVCOPY-DERIVED"], ["run_screener", "BHAVCOPY-DERIVED"], ["compute_xirr", "PURE-COMPUTE"], ["get_us_filings", "EDGAR"]];
  return (
    <SubPage um={um} title="Developer" onBack={back}>
      <div style={{ marginTop: 12, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-3)" }}>One settings section. Same read-only data you see here, over MCP.</div>
      <SecHead label="API keys" right={<GhostBtn full={false} icon={null} style={{ padding: "6px 10px", fontSize: 11.5 }} onClick={() => { setKeys(k => [["um_live_…" + Math.random().toString(16).slice(2, 6), "New key", "just now"], ...k]); um.toast("Key created — copy it now"); }}>+ Create</GhostBtn>} />
      <ListCard>{keys.map(([k, n, last], i) => <RowItem key={k} last={i === keys.length - 1} title={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{k}</span>} sub={`${n} · last used ${last}`} right={<span onClick={() => setKeys(ks => ks.filter(x => x[0] !== k))} style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--loss)", cursor: "pointer" }}>REVOKE</span>} />)}</ListCard>
      <SecHead label="Connect MCP" right={<Tag>CLAUDE · CURSOR</Tag>} />
      <Card pad={0} style={{ overflow: "hidden" }} onClick={() => um.toast("Config copied")}>
        <div style={{ background: "var(--ink)", color: "var(--paper)", padding: "12px 14px", fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.7 }}>{'{ "mcpServers": { "usemoney": {'}<br />&nbsp;&nbsp;{'"url": "https://mcp.usemoney.ai",'}<br />&nbsp;&nbsp;{'"headers": { "Authorization": "Bearer um_live_…" } } } }'}</div>
        <div style={{ padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>TAP TO COPY</span><span onClick={(e) => { e.stopPropagation(); um.toast("Ping OK · 184 ms"); }} style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--emerald-text)" }}>SEND TEST PING →</span></div>
      </Card>
      <SecHead label="Usage · this month" />
      <Card pad={12}><div style={{ display: "flex", justifyContent: "space-between" }}><StatCell label="Calls" value="1,284" sub="of 5,000" /><StatCell label="Credits via MCP" value="3" sub="deep research" align="center" /><StatCell label="Errors" value="0.2%" align="right" /></div><HBar label="" value={1284} max={5000} /></Card>
      <SecHead label="Tool catalog · provenance" />
      <ListCard>{TOOLS.map(([t, p], i) => <RowItem key={t} last={i === TOOLS.length - 1} title={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>{t}</span>} right={<Tag bg={PROV[p]} color="#1d1d1b" style={{ borderColor: "var(--ink)", fontSize: 8.5 }}>{p}</Tag>} />)}</ListCard>
      <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", lineHeight: 1.6 }}>EVERY TOOL SAYS WHERE ITS DATA CAME FROM · NO ORDER TOOLS EXIST</div>
    </SubPage>
  );
}

Object.assign(window, { ScreenerV2Screen, StrategiesScreen, StrategyDetailScreen, HomePresetsScreen, DevSettingsScreen });
