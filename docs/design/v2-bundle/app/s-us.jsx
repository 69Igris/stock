// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2.1 · US layer: onboarding fork, SnapTrade link, statement
// import, US stock page, mixed portfolio, LRS/TCS tracker, market preferences.
// Decisions: EOD-only quotes · spot FX for values, RBI reference for cost/LRS ·
// flag-gated (no pre-GA) · vendor never named · SnapTrade (no IBKR direct).
// ─────────────────────────────────────────────────────────────────────────
const { useState: usS } = React;

const FX_SPOT = 84.0;
window.__umUS = window.__umUS || { persona: "nri", market: "both" };
const usd = (n, dec = 0) => "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
const usPair = (u, persona) => persona === "nri" ? [usd(u), money(u * FX_SPOT)] : [money(u * FX_SPOT), usd(u)];
const US_BROKERS = [["rh", "Robinhood", "RH", "#00c805", "#0b2b0b"], ["fd", "Fidelity", "FD", "#00945f", "#fff"], ["sw", "Schwab", "SW", "#0033a0", "#fff"], ["wb", "Webull", "WB", "#1a4ae0", "#fff"], ["et", "E*TRADE", "ET", "#6633cc", "#fff"]];
const US_HOLD = [
  { sym: "AAPL", name: "Apple Inc.", src: "Robinhood", qty: 62, avg: 164.2, ltp: 211.04, chg: 0.86 },
  { sym: "MSFT", name: "Microsoft Corp.", src: "Fidelity", qty: 31, avg: 362.4, ltp: 441.2, chg: 0.41 },
  { sym: "NVDA", name: "NVIDIA Corp.", src: "Imported · Apr 26", qty: 140, avg: 121.4, ltp: 168.42, chg: -1.12, imp: true },
  { sym: "GOOGL", name: "Alphabet · A", src: "Imported · Apr 26", qty: 44, avg: 158.1, ltp: 188.62, chg: 0.22, imp: true },
];
const US_BOOK = US_HOLD.reduce((a, h) => a + h.qty * h.ltp, 0);

function UsTile({ ab, bg, fg, size = 32, rotate = 0 }) {
  return <span style={{ width: size, height: size, borderRadius: size * 0.26, border: "2px solid var(--ink)", background: bg, color: fg, display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: size * 0.34, flexShrink: 0, transform: rotate ? `rotate(${rotate}deg)` : "none" }}>{ab}</span>;
}
function EodTag({ text = "◷ EOD · JUL 18" }) { return <Tag bg="var(--paper-2)">{text}</Tag>; }
function Disclaimer({ children }) { return <div style={{ marginTop: 22, paddingTop: 12, borderTop: "1.5px dashed var(--rule-soft)", fontSize: 11.5, color: "var(--ink-3)", lineHeight: 1.5 }}>{children}</div>; }
function PersonaSwitch({ persona, setPersona }) {
  return <Seg grow={false} size={10.5} value={persona} onChange={setPersona} options={[{ k: "nri", label: "NRI · $" }, { k: "lrs", label: "LRS · ₹" }]} />;
}
function usePersona() {
  const [p, set] = usS(window.__umUS.persona);
  return [p, (v) => { window.__umUS.persona = v; set(v); }];
}

// ── 1 · Onboarding fork (two questions) ─────────────────────────────────────
function UsForkScreen({ go, um }) {
  const [mkt, setMkt] = usS("both");
  const [persona, setPersona] = usePersona();
  const hasUs = mkt !== "in";
  const opt = (k, kk, t, d) => (
    <Press key={k} onClick={() => setMkt(k)}>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 13, padding: "13px 14px", background: mkt === k ? "var(--ink)" : "var(--paper-3)", color: mkt === k ? "var(--paper)" : "var(--ink)", boxShadow: mkt === k ? "3px 3px 0 var(--emerald)" : "3px 3px 0 var(--ink)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.2, opacity: 0.7, fontWeight: 700 }}>{kk}</div>
        <div style={{ fontWeight: 800, fontSize: 16, marginTop: 3 }}>{t}</div>
        <div style={{ fontSize: 12, marginTop: 2, opacity: 0.8, lineHeight: 1.4 }}>{d}</div>
      </div>
    </Press>
  );
  return (
    <Screen topPad={64} footer={<PrimaryBtn onClick={() => go(hasUs ? "usconnect" : "connect")}>{hasUs ? (persona === "nri" ? "Next: link a brokerage" : "Next: import a statement") : "Next: connect a broker"}</PrimaryBtn>}>
      <StepBar total={5} current={3} />
      <div style={{ marginTop: 18 }}>
        <Eyebrow>STEP 04 · WHERE YOU INVEST</Eyebrow>
        <h1 style={{ fontWeight: 800, fontSize: 30, lineHeight: 1.05, letterSpacing: -1.4, margin: "12px 0 8px", color: "var(--ink)" }}>Where do you <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>invest?</span></h1>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55 }}>Sets your currency and which connection we offer first. Change it any time in Settings.</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
        {opt("in", "IN", "India", "NSE and BSE, via your brokers")}
        {opt("us", "US", "United States", "NASDAQ and NYSE · end-of-day prices")}
        {opt("both", "IN + US", "Both", "One workspace, two markets")}
      </div>
      {hasUs && (
        <>
          <SecHead label="Question two · because you picked US" />
          <ListCard>
            {[["nri", "In the US", "H-1B, green card, citizen. You think in dollars.", "$ PRIMARY · LINK FIRST"], ["lrs", "In India, investing via LRS", "Vested, INDmoney or a direct broker. You think in rupees.", "₹ PRIMARY · IMPORT FIRST · LRS TRACKER"]].map(([k, t, d, tags], i) => (
              <RowItem key={k} last={i === 1} onClick={() => setPersona(k)}
                left={<span style={{ width: 26, height: 26, borderRadius: 99, border: "2px solid var(--ink)", background: persona === k ? "var(--pop-2)" : "transparent", display: "grid", placeItems: "center", flexShrink: 0 }}>{persona === k && <Icon name="check" size={14} color="#1d1d1b" strokeWidth={3} />}</span>}
                title={t} sub={d} rightSub={<Tag>{tags}</Tag>} />
            ))}
          </ListCard>
          <div style={{ marginTop: 14, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-2)", padding: "11px 13px", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>US quotes are <b>end-of-day</b> at launch — every price says so. Fundamentals come from SEC filings with dates. Live quotes come later, behind a flag.</div>
        </>
      )}
    </Screen>
  );
}

// ── 2 · Connect: SnapTrade link or statement import ────────────────────────
function UsConnectScreen({ go, back, um }) {
  const [persona, setPersona] = usePersona();
  const link = (
    <Card key="link" pad={0} style={{ overflow: "hidden" }}>
      <div style={{ padding: "13px 14px", borderBottom: "1.5px dashed var(--rule-soft)", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--pop-3)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", transform: "rotate(-3deg)" }}><Icon name="link" size={16} color="#f7f3e6" /></span>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 15, color: "var(--ink)" }}>Link a brokerage</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.8 }}>SNAPTRADE · READ-ONLY · 2 MIN</div></div>
        <Tag bg="var(--paper-2)">{persona === "nri" ? "fastest" : "if allowed"}</Tag>
      </div>
      <div style={{ padding: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {US_BROKERS.map(([id, name, ab, bg, fg], i) => (
            <Press key={id} onClick={() => go("usoauth:" + id)}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1.5px solid var(--ink)", borderRadius: 10, padding: "9px 10px", background: "var(--paper)" }}>
                <UsTile ab={ab} bg={bg} fg={fg} size={28} rotate={i % 2 ? 2 : -2} />
                <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)", flex: 1 }}>{name}</span>
              </div>
            </Press>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1.5px dashed var(--rule-soft)", borderRadius: 10, padding: "9px 10px", color: "var(--ink-3)", fontSize: 11.5, lineHeight: 1.3 }}>More brokers<br /><span style={{ fontFamily: "var(--font-mono)", fontSize: 9 }}>20+ VIA SNAPTRADE</span></div>
        </div>
        <div style={{ marginTop: 12, padding: "9px 11px", borderRadius: 9, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>✦ Read-only. We can't place orders — not here, not anywhere. Revoke in one tap.</div>
      </div>
    </Card>
  );
  const imp = (
    <Card key="imp" pad={0} style={{ overflow: "hidden" }} onClick={() => go("usimport")}>
      <div style={{ padding: "13px 14px", borderBottom: "1.5px dashed var(--rule-soft)", display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--pop-5)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", transform: "rotate(3deg)" }}><Icon name="upload" size={16} color="#f7f3e6" /></span>
        <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 15, color: "var(--ink)" }}>Import a statement</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.8 }}>CSV / PDF · 3 STEPS · ANY BROKER</div></div>
        <Tag bg="var(--paper-2)">{persona === "nri" ? "any broker" : "your path"}</Tag>
      </div>
      <div style={{ padding: 14 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{["VESTED", "INDMONEY", "SCHWAB PDF", "IBKR CSV", "GENERIC"].map(f => <Tag key={f}>{f}</Tag>)}</div>
        <div style={{ marginTop: 12, padding: "18px 12px", border: "2px dashed var(--ink)", borderRadius: 11, background: "var(--paper)", textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1.2, color: "var(--ink-3)", fontWeight: 700 }}>TAP TO PICK A FILE</div>
          <div style={{ marginTop: 4, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-2)" }}>up to 20 MB · we de-duplicate against your lots</div>
        </div>
      </div>
    </Card>
  );
  return (
    <SubPage um={um} title="Bring your US accounts in" onBack={back} right={<PersonaSwitch persona={persona} setPersona={setPersona} />}>
      <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--emerald-text)", fontWeight: 700, letterSpacing: 1.2 }}>● US ◷ EOD · JUL 18 CLOSE · FLAG us-stocks-listing</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 12 }}>{persona === "nri" ? [link, imp] : [imp, link]}</div>
      <Disclaimer>Analysis and education only — not investment advice. UseMoney is not a broker-dealer or a registered investment adviser in the US. India surfaces keep their SEBI framing.</Disclaimer>
    </SubPage>
  );
}

// ── 3 · SnapTrade consent → sync → done / re-auth ───────────────────────────
function UsOAuthScreen({ go, back, param, um }) {
  const [id, ctx] = (param || "rh").split(":");
  const b = US_BROKERS.find(x => x[0] === id) || US_BROKERS[0];
  const [phase, setPhase] = usS(ctx === "fail" ? "fail" : "consent");
  const [step, setStep] = usS(0);
  const start = () => { setPhase("sync"); [1, 2, 3, 4].forEach(i => setTimeout(() => { setStep(i); if (i === 4) setTimeout(() => setPhase("done"), 500); }, i * 650)); };
  const STEPS = [{ t: `Signed in at ${b[1]}`, d: "Inside SnapTrade's portal · we never saw the password" }, { t: "Read-only token received", d: "Encrypted at rest · no trading scope" }, { t: "Positions & balances", d: "8 positions" }, { t: "Activity → lots", d: "61 lots · cost basis at RBI reference rate of trade date" }];
  return (
    <SubPage um={um} title={phase === "done" ? "Connected" : phase === "fail" ? "Needs re-authorising" : `Connect ${b[1]}`} onBack={back}
      footer={phase === "consent" ? <PrimaryBtn onClick={start}>Continue to {b[1]}</PrimaryBtn> : phase === "done" ? <PrimaryBtn onClick={() => go("usportfolio", { reset: false })}>See mixed holdings</PrimaryBtn> : phase === "fail" ? <PrimaryBtn onClick={() => { setPhase("consent"); }}>Re-authorise {b[1]}</PrimaryBtn> : null}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
        <UsTile ab={b[2]} bg={b[3]} fg={b[4]} size={44} rotate={-3} />
        <Icon name="arrowR" size={16} color="var(--ink-3)" />
        <BrandMark size={40} />
        <div style={{ marginLeft: "auto" }}><Tag bg="var(--paper-2)">via SnapTrade</Tag></div>
      </div>
      {phase === "consent" && (
        <>
          <SecHead label="What happens next" />
          <ProgressSteps steps={STEPS} current={0} />
          <Card pad={12} style={{ marginTop: 10 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--gain-text)" }}>✓ positions · balances</span><span style={{ color: "var(--ink-3)" }}>what you own</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--gain-text)" }}>✓ activities</span><span style={{ color: "var(--ink-3)" }}>buys, sells, dividends</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "var(--loss)" }}>✕ trading</span><span style={{ color: "var(--loss)" }}>never requested</span></div>
            </div>
          </Card>
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>Revoke any time in You › Market preferences. Revoking stops the sync and keeps what's imported as read-only history.</div>
        </>
      )}
      {phase === "sync" && (<><SecHead label="Syncing" right={<Spinner size={14} />} /><ProgressSteps steps={STEPS} current={step} /><div style={{ marginTop: 12, fontSize: 12, color: "var(--ink-3)" }}>You can leave — we finish in the background.</div></>)}
      {phase === "done" && (
        <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--emerald)" style={{ marginTop: 18, color: "var(--paper)", transform: "rotate(-0.6deg)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.4, color: "var(--pop-2)", fontWeight: 700 }}>{b[1].toUpperCase()} CONNECTED</div>
          <div style={{ fontWeight: 800, fontSize: 24, letterSpacing: -0.8, marginTop: 6 }}>8 positions, in.</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}><Tag color="var(--paper)" style={{ borderColor: "rgba(247,243,230,.4)" }}>◷ EOD · JUL 18</Tag><Tag color="var(--paper)" style={{ borderColor: "rgba(247,243,230,.4)" }}>SPOT ₹84.00/$</Tag><Tag color="var(--paper)" style={{ borderColor: "rgba(247,243,230,.4)" }}>READ-ONLY</Tag></div>
        </Card>
      )}
      {phase === "fail" && (
        <Card pad={14} style={{ marginTop: 18, borderColor: "var(--pop-1)" }}>
          <div style={{ display: "flex", gap: 10 }}><span style={{ width: 30, height: 30, borderRadius: 8, background: "var(--pop-1)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, color: "#fff", transform: "rotate(-3deg)", flexShrink: 0 }}>!</span><div><div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>Broker session expired Jul 14</div><div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 3, lineHeight: 1.45 }}>Normal for this broker. Your other US accounts synced fine and are up to date.</div></div></div>
        </Card>
      )}
    </SubPage>
  );
}

// ── 4 · Statement import (3 steps) ──────────────────────────────────────────
function UsImportScreen({ go, back, um }) {
  const [step, setStep] = usS(0);
  const [persona] = usePersona();
  const ROWS = [["Trade Date", "trade_date", 100], ["Ticker", "symbol", 100], ["Side", "trade_type", 98], ["Units", "quantity", 97], ["Price (USD)", "trade_price", 99], ["INR Rate", "fx_rate_on_trade", 71], ["Fees", "charges", 94]];
  const LOTS = [["18 Apr", "AAPL", 4.2814, 204.11, 83.10], ["18 Apr", "MSFT", 2.1, 438.6, 83.10], ["02 Apr", "NVDA", 6, 168.42, 83.42], ["02 Apr", "GOOGL", 3.4, 182.9, 83.42]];
  return (
    <SubPage um={um} title="Import a statement" onBack={back}
      footer={step < 2 ? <PrimaryBtn onClick={() => setStep(s => s + 1)}>{["Next: map columns", "Next: review"][step]}</PrimaryBtn> : <PrimaryBtn onClick={() => { um.toast("38 lots committed · LRS updated"); go("usportfolio"); }}>Commit 38 lots</PrimaryBtn>}>
      <div style={{ marginTop: 14 }}><StepBar total={3} current={step} /></div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1, marginTop: 8, fontWeight: 700 }}>STEP {step + 1} / 3 — {["UPLOAD", "MAP COLUMNS", "REVIEW & COMMIT"][step]}</div>
      {step === 0 && (
        <>
          <Press onClick={() => setStep(1)}><div style={{ marginTop: 14, padding: "28px 16px", border: "2px dashed var(--ink)", borderRadius: 13, background: "var(--paper-3)", textAlign: "center" }}><span style={{ width: 48, height: 48, borderRadius: 12, background: "var(--pop-5)", border: "2px solid var(--ink)", display: "inline-grid", placeItems: "center", transform: "rotate(-3deg)", boxShadow: "3px 3px 0 var(--ink)" }}><Icon name="upload" size={22} color="#f7f3e6" /></span><div style={{ fontWeight: 800, fontSize: 16, marginTop: 12, color: "var(--ink)" }}>Pick a CSV or PDF</div><div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-3)", marginTop: 3 }}>Files, Drive, or your broker's share sheet</div></div></Press>
          <SecHead label="Format hints" />
          <ListCard>{[["Vested", "CSV · auto-mapped"], ["INDmoney", "CSV · auto-mapped"], ["Schwab", "PDF · OCR, then map"], ["IBKR", "Activity CSV"], ["Anything else", "map it yourself"]].map(([n, s], i, a) => <RowItem key={n} last={i === a.length - 1} title={n} right={<Tag>{s}</Tag>} />)}</ListCard>
        </>
      )}
      {step === 1 && (
        <>
          <Card pad={12} style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10 }}><Icon name="file" size={18} color="var(--emerald)" /><div style={{ flex: 1 }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>vested_apr26.csv</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>184 KB · 42 ROWS · VESTED FORMAT RECOGNISED</div></div><Tag bg="var(--emerald)" color="#0b0b09">7/7</Tag></Card>
          <SecHead label="We'll read it as" />
          <ListCard>{ROWS.map(([a, b, c], i) => <RowItem key={a} last={i === ROWS.length - 1} title={a} sub={b} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: c < 80 ? "#a16207" : "var(--gain-text)" }}>{c}%</span>} right={c < 80 ? <Tag bg="var(--pop-2)" color="#1d1d1b">check</Tag> : null} />)}</ListCard>
          <Card pad={12} style={{ marginTop: 12, borderColor: "var(--pop-1)" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--loss)", letterSpacing: 0.8 }}>2 ROWS NEED YOU</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.45 }}>Row 17 · NVDA · missing FX → <b>use RBI reference ₹83.28</b> for that day. Row 31 · "BRK.B " → did you mean BRK-B?</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}><GhostBtn full={false} icon={null} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }} onClick={() => um.toast("RBI rate applied · row 17")}>Use RBI rate</GhostBtn><GhostBtn full={false} icon={null} style={{ flex: 1, padding: "9px 10px", fontSize: 12.5 }} onClick={() => um.toast("Mapped to BRK-B")}>Yes, BRK-B</GhostBtn></div>
          </Card>
        </>
      )}
      {step === 2 && (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 14 }}><Tag bg="var(--emerald)" color="#0b0b09">38 new lots</Tag><Tag>4 duplicates skipped</Tag></div>
          <SecHead label="What we'll add" right={<Tag>RBI REF ON TRADE DATE</Tag>} />
          <ListCard>{LOTS.map(([d, s, q, p, fx], i) => <RowItem key={s} last={i === LOTS.length - 1} left={<SymTile sym={s} size={34} />} title={s} sub={`${d} · ${q} @ $${p} · RBI ₹${fx}`} right={persona === "nri" ? usd(q * p) : money(q * p * fx)} />)}</ListCard>
          <Card pad={14} style={{ marginTop: 12 }}><div style={{ display: "flex", justifyContent: "space-between" }}><StatCell label="Cost of lots" value={persona === "nri" ? usd(48200) : money(4023708)} sub={persona === "nri" ? money(4023708) : usd(48200)} /><StatCell label="Lots · symbols" value="61 · 9" align="right" /></div></Card>
          {persona === "lrs" && <Press onClick={() => go("lrs")}><div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 13, background: "var(--pop-2)", padding: "12px 14px", boxShadow: "3px 3px 0 var(--ink)", transform: "rotate(0.6deg)", color: "#1d1d1b" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1.4, color: "#3a3a35" }}>ALSO UPDATED</div><div style={{ fontWeight: 800, fontSize: 15, marginTop: 3 }}>Your LRS headroom → adds $12,400 to FY26-27</div></div></Press>}
        </>
      )}
      <Disclaimer>Imported figures are yours — we reconcile them, we don't audit them. Cost basis is frozen at the RBI reference rate of each trade date.</Disclaimer>
    </SubPage>
  );
}

// ── 5 · US stock page (EOD, as filed) ──────────────────────────────────────
function UsStockScreen({ go, back, param, um }) {
  const sym = param || "AAPL";
  const h = US_HOLD.find(x => x.sym === sym) || US_HOLD[0];
  const [persona] = usePersona();
  const [tab, setTab] = usS("overview");
  const [range, setRange] = usS("1Y");
  const [p, s] = persona === "nri" ? [usd(h.ltp, 2), money(h.ltp * FX_SPOT)] : [money(h.ltp * FX_SPOT), usd(h.ltp, 2)];
  const RAT = [["P/E TTM", "32.8×", "10-Q · MAY 02"], ["GROSS MARGIN", "46.6%", "10-Q · MAY 02"], ["ROE", "147%", "10-K · FY25"], ["NET DEBT", "$48.5B", "10-Q · MAY 02"], ["MKT CAP", "$3.15T", "EOD · JUL 18"], ["DIV YIELD", "0.47%", "8-K · MAY 01"]];
  const FIN = [["Revenue", "$95.36B", "+5.1%"], ["Gross profit", "$44.45B", "+5.2%"], ["Operating income", "$29.59B", "+6.1%"], ["Net income", "$24.78B", "+4.8%"], ["Diluted EPS", "$1.65", "+7.8%"], ["Free cash flow", "$24.06B", "+5.5%"]];
  const INS = [["11 Jul", "T. Cook · CEO", "S · SELL", -108000, "$22.4M"], ["02 Jul", "L. Maestri · CFO", "F · TAX", -41200, "$8.6M"], ["28 May", "K. Adams · SVP", "P · BUY", 6500, "$1.3M"]];
  return (
    <SubPage um={um} title={`${h.sym} · ${h.name}`} mono onBack={back} right={<StarBtn on={um.watch.has(h.sym)} onClick={() => um.toggleWatch(h.sym)} />}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}><Tag>US · NASDAQ</Tag><Tag>COMMON STOCK</Tag><EodTag text="◷ EOD · JUL 18 CLOSE" /><Tag>THIRD-PARTY DATA</Tag></div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginTop: 12 }}>
        <div><div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 32, letterSpacing: -1.2, color: "var(--ink)", lineHeight: 1 }}>{p}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>{s} · SPOT ₹84.00/$ · 1H</div></div>
        <div style={{ textAlign: "right" }}><Num v={h.chg} fmt="pct" dec={2} size={14} /><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 2 }}>PREVIOUS SESSION</div></div>
      </div>
      <Card pad={12} style={{ marginTop: 14 }}>
        <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>{["1M", "6M", "1Y", "5Y"].map(r => <Chip key={r} active={range === r} onClick={() => setRange(r)} style={{ padding: "4px 9px", fontSize: 10.5 }}>{r}</Chip>)}<span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--gain-text)", fontWeight: 700 }}>+22.4% · 1Y</span></div>
        <LineChart series={genSeries(77, 60, 0.0035, 0.024, h.ltp)} h={100} />
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 6 }}>● DAILY CLOSES · NO INTRADAY · LIVE TICKS LATER BEHIND A FLAG</div>
      </Card>
      <div style={{ marginTop: 12, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-3)" }}>You hold {h.qty} shares · {usPair(h.qty * h.ltp, persona)[0]} · avg ${h.avg} {persona === "lrs" && "at RBI reference rates"}</div>
      <div style={{ display: "flex", gap: 6, marginTop: 14, overflowX: "auto", paddingBottom: 4 }}>{[["overview", "Overview"], ["financials", "Financials"], ["insiders", "Insiders"], ["holders", "Holders"], ["filings", "Filings"]].map(([k, l]) => <Chip key={k} active={tab === k} onClick={() => setTab(k)}>{l}</Chip>)}</div>
      {tab === "overview" && (
        <>
          <SecHead label="Key ratios" right={<Tag>STANDARDIZED</Tag>} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>{RAT.map(([l, v, src]) => <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 11, padding: "9px 10px", background: "var(--paper-3)" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1, color: "var(--ink-3)", fontWeight: 700 }}>{l}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: "var(--ink)", marginTop: 2 }}>{v}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 8, color: "var(--ink-3)", marginTop: 1 }}>{src}</div></div>)}</div>
          <Card pad={14} bg="var(--paper-2)" style={{ marginTop: 14, transform: "rotate(0.5deg)" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "var(--ink-3)" }}>SAGE TAKE · US SCOPE</div>
            <div style={{ marginTop: 6, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14.5, color: "var(--ink-2)", lineHeight: 1.4 }}>Services margin is doing the work — hardware flat two quarters. <b style={{ fontFamily: "var(--font-sans)", fontStyle: "normal", color: "var(--ink)" }}>Coverage here is filings, fundamentals and EOD prices</b> — thinner than India. We'd rather say so.</div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>{window.__umUS.usResearch ? <><PrimaryBtn full={false} icon="sparkles" style={{ padding: "10px 14px", fontSize: 13 }} onClick={() => { um.setSagePrefill(`Analyze ${h.sym}`); go("sage"); }}>Research with Sage</PrimaryBtn><CostChip n={2} /></> : <><GhostBtn full={false} icon="sparkles" style={{ padding: "10px 14px", fontSize: 13 }} onClick={() => um.toast("US research opens behind us-stock-research", "info")}>Research · India only today</GhostBtn><Tag>FLAG us-stock-research · OFF</Tag></>}</div>
            <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }} onClick={() => { window.__umUS.usResearch = !window.__umUS.usResearch; setTab("overview"); setRange(r => r); }}>DEMO · TOGGLE THE RESEARCH FLAG</div>
          </Card>
        </>
      )}
      {tab === "financials" && (<><SecHead label="Statements, as filed" right={<Tag>10-Q · MAY 02</Tag>} /><ListCard>{FIN.map(([l, v, y], i) => <RowItem key={l} last={i === FIN.length - 1} title={l} sub="Q2 FY26 · vs Q2 FY25" right={v} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--gain-text)", fontWeight: 700 }}>{y}</span>} />)}</ListCard><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 8 }}>SOURCE · SEC EDGAR · FCF DERIVED, NOT FILED</div></>)}
      {tab === "insiders" && (<><SecHead label="Insider activity" right={<Tag>FORMS 3/4/5 · 90D</Tag>} /><ListCard>{INS.map(([d, who, code, sh, val], i) => <RowItem key={who} last={i === INS.length - 1} title={who} sub={`${d} · ${code}`} right={val} rightSub={<Num v={sh} sign={true} fmt="money" size={10.5} style={{ color: sh < 0 ? "var(--loss)" : "var(--gain-text)" }} />} />)}</ListCard><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.6 }}>F = TAX ON A VESTING GRANT, NOT A SALE · CLASSES NEVER SUMMED</div></>)}
      {tab === "holders" && (<><SecHead label="Institutional holders" right={<Tag>13F · Q1 2026</Tag>} /><ListCard>{[["Vanguard Group", "1.38B", "9.2%", "+11.0M"], ["BlackRock", "1.09B", "7.3%", "+15.1M"], ["Berkshire Hathaway", "300M", "2.0%", "-44.9M"], ["Norges Bank · NEW", "168M", "1.1%", "+168M"]].map(([n, sh, pc, q], i, a) => <RowItem key={n} last={i === a.length - 1} title={n} sub={`${sh} shares · ${pc} out`} right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: q.startsWith("-") ? "var(--loss)" : "var(--gain-text)" }}>{q}</span>} rightSub="QoQ" />)}</ListCard></>)}
      {tab === "filings" && <EmptyState icon="file" title="Filings, dated" sub="10-K, 10-Q, 8-K, Forms 3/4/5, 13F — every chip above opens the source document on EDGAR." />}
      <Disclaimer>Analysis and education only — not investment advice. No order entry on this page, ever. Listing US000000000038.</Disclaimer>
    </SubPage>
  );
}

// ── 6 · Mixed portfolio (by market) ────────────────────────────────────────
function UsPortfolioScreen({ go, back, um }) {
  const [persona, setPersona] = usePersona();
  const [grp, setGrp] = usS("market");
  const inVal = HOLDINGS.reduce((a, h) => a + h.val, 0);
  const total = inVal + US_BOOK * FX_SPOT;
  const [tp, ts] = persona === "nri" ? [usd(total / FX_SPOT), money(total)] : [money(total), usd(total / FX_SPOT)];
  const usRow = (h, i, last) => {
    const [vp, vs] = usPair(h.qty * h.ltp, persona);
    return <RowItem key={h.sym} last={last} onClick={() => go("usstock:" + h.sym)} left={<SymTile sym={h.sym} size={36} rotate={i % 2 ? 2 : -2} />} title={h.sym} sub={`${h.qty} @ $${h.avg} · ${h.src}`} right={vp} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{vs} · <span style={{ color: "var(--gain-text)", fontWeight: 700 }}>{pct((h.ltp / h.avg - 1) * 100)}</span></span>} />;
  };
  return (
    <SubPage um={um} title="Holdings · both markets" onBack={back} right={<PersonaSwitch persona={persona} setPersona={setPersona} />}>
      <Card pad={14} bg="var(--ink)" shadow="4px 4px 0 var(--emerald)" style={{ marginTop: 14, color: "var(--paper)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.2, color: "var(--pop-2)", fontWeight: 700 }}>TOTAL · BOTH MARKETS</div>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 30, letterSpacing: -1, marginTop: 4 }}>{tp}</div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, opacity: 0.7 }}>{ts} · SPOT ₹84.00/$ · COST AT RBI REF</div>
        <div style={{ display: "flex", gap: 16, marginTop: 10, borderTop: "1.5px dashed rgba(247,243,230,.25)", paddingTop: 10, fontFamily: "var(--font-mono)", fontSize: 11 }}>
          <span><span style={{ opacity: 0.6, fontSize: 8.5, letterSpacing: 1 }}>INDIA </span><b>{Math.round(inVal / total * 100)}%</b> <span style={{ opacity: 0.6 }}>◷ delayed</span></span>
          <span><span style={{ opacity: 0.6, fontSize: 8.5, letterSpacing: 1 }}>US </span><b>{Math.round(US_BOOK * FX_SPOT / total * 100)}%</b> <span style={{ opacity: 0.6 }}>◷ EOD Jul 18</span></span>
        </div>
      </Card>
      <div style={{ marginTop: 12 }}><Seg value={grp} onChange={setGrp} size={12} options={[{ k: "market", label: "By market" }, { k: "broker", label: "By broker" }, { k: "flat", label: "Flat" }]} /></div>
      <SecHead label={<span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: "var(--pop-3)", border: "1.5px solid var(--ink)", marginRight: 6 }} />United States · 4</span>} right={<EodTag />} />
      <ListCard>{US_HOLD.map((h, i) => usRow(h, i, i === US_HOLD.length - 1))}</ListCard>
      <SecHead label={<span><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 3, background: "var(--pop-5)", border: "1.5px solid var(--ink)", marginRight: 6 }} />India · {HOLDINGS.length}</span>} right={<Tag bg="var(--paper-2)">◷ exchange-delayed</Tag>} />
      <ListCard>{HOLDINGS.slice(0, 4).map((h, i) => <RowItem key={h.sym} last={i === 3} onClick={() => go("stock:" + h.sym)} left={<SymTile sym={h.sym} size={36} />} title={h.sym} sub={`${h.qty} @ ₹${inr(h.avg)}`} right={money(h.val)} rightSub={<Num v={h.pnlPct} fmt="pct" size={10.5} />} />)}</ListCard>
      <div style={{ textAlign: "center", marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>SHOWING 8 OF {US_HOLD.length + HOLDINGS.length} · <span style={{ color: "var(--emerald-text)", fontWeight: 700 }} onClick={() => go("portfolio")}>ALL INDIA HOLDINGS →</span></div>
      <Disclaimer>Imported lots keep the RBI reference rate from their trade date, so your ₹ cost basis doesn't drift with today's rate. Values use the hourly spot rate.</Disclaimer>
    </SubPage>
  );
}

// ── 7 · LRS / TCS tracker (LRS persona only) ───────────────────────────────
function LrsScreen({ go, back, um }) {
  const [persona, setPersona] = usePersona();
  const LED = [["14 Jul", 9800, 83.66, "INDmoney · import"], ["28 Jun", 8000, 83.98, "manual"], ["18 Apr", 12400, 83.10, "Vested · import"], ["02 Apr", 18000, 83.42, "Vested · import"]];
  const used = 48200, limit = 250000;
  return (
    <SubPage um={um} title="LRS & TCS · FY 26-27" onBack={back} right={<GhostBtn full={false} icon={null} style={{ padding: "8px 11px", fontSize: 12 }} onClick={() => um.toast("Add a remittance", "info")}>+ Add</GhostBtn>}>
      {persona === "nri" && (
        <Card pad={12} bg="var(--paper-2)" style={{ marginTop: 14 }}><div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--ink)" }}>LRS-only — you're viewing as the NRI persona.</div><div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 3, lineHeight: 1.45 }}>For an NRI this never appears: no Home card, no Tax row, no Settings entry.</div><div style={{ marginTop: 8 }}><GhostBtn full={false} icon="arrowR" style={{ padding: "8px 11px", fontSize: 12 }} onClick={() => setPersona("lrs")}>View as LRS</GhostBtn></div></Card>
      )}
      <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--emerald)" style={{ marginTop: 14, color: "var(--paper)", transform: "rotate(-0.5deg)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.2, color: "var(--pop-2)", fontWeight: 700 }}>REMITTED THIS FY · HEADROOM</div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}><span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 30, letterSpacing: -1 }}>{usd(used)}</span><span style={{ fontFamily: "var(--font-mono)", fontSize: 12, opacity: 0.65 }}>of {usd(limit)}</span></div>
        <div style={{ height: 12, background: "rgba(255,255,255,.1)", border: "1.5px solid #f4ede0", borderRadius: 99, overflow: "hidden", display: "flex", marginTop: 10 }}><div style={{ width: "4.8%", background: "var(--emerald)" }} /><div style={{ width: "14.5%", background: "var(--pop-2)" }} /></div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 9.5, opacity: 0.75 }}><span><span style={{ color: "var(--emerald)" }}>■</span> below ₹10L · no TCS &nbsp;<span style={{ color: "var(--pop-2)" }}>■</span> TCS 20%</span><span style={{ color: "var(--emerald)", fontWeight: 800 }}>{usd(limit - used)} left</span></div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, opacity: 0.65, marginTop: 8 }}>₹40,23,708 AT RBI REFERENCE RATES · RESETS 01 APR</div>
      </Card>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
        <Card pad={12}><StatCell label="TCS paid · claimable" value="₹6,04,742" sub="Form 26AS · ITR credit" /></Card>
        <Card pad={12}><StatCell label="Entries" value="4" sub="3 imports · 1 manual" /></Card>
      </div>
      <SecHead label="Remittance ledger" right={<Tag>RBI REF</Tag>} />
      <ListCard>{LED.map(([d, a, fx, src], i) => <RowItem key={d} last={i === LED.length - 1} title={usd(a)} sub={`${d} · RBI ₹${fx} · ${src}`} right={money(a * fx)} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>TCS {money(Math.max(0, (a * fx) * 0.2))}</span>} />)}</ListCard>
      <SecHead label="Assumptions · yours to set" right={<GhostBtn full={false} icon={null} style={{ padding: "6px 10px", fontSize: 11.5 }} onClick={() => um.toast("Edit assumptions", "info")}>Edit</GhostBtn>} />
      <ListCard>{[["FY limit", "$250,000"], ["TCS threshold", "₹10,00,000"], ["Rate above threshold · investment", "20%"], ["FX for ₹ value", "RBI ref · trade date"]].map(([l, v], i, a) => <RowItem key={l} last={i === a.length - 1} title={l} right={v} />)}</ListCard>
      <Disclaimer>Not tax advice. We track what you tell us and what your statements say; limits, bands and eligibility are yours to verify with your CA.</Disclaimer>
    </SubPage>
  );
}

// ── 8 · Market preferences (You → Settings) ─────────────────────────────────
function UsPrefsScreen({ go, back, um }) {
  const [persona, setPersona] = usePersona();
  const [cur, setCur] = usS(persona === "nri" ? "usd" : "inr");
  return (
    <SubPage um={um} title="Market preferences" onBack={back}>
      <div style={{ marginTop: 12, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "var(--ink-3)" }}>Your two onboarding answers, editable. Nothing else in Settings moves.</div>
      <SecHead label="Markets & currency" right={<Tag bg="var(--paper-2)">{persona === "nri" ? "NRI · $ primary" : "LRS · ₹ primary"}</Tag>} />
      <ListCard>
        <RowItem title="Where do you invest?" sub="Onboarding question one" right={<Tag>India + US</Tag>} onClick={() => go("usfork")} />
        <RowItem title="Residency" sub="Drives the LRS tracker and which connect path we offer first" right={<Tag>{persona === "nri" ? "US · NRI" : "India · LRS"}</Tag>} onClick={() => setPersona(persona === "nri" ? "lrs" : "nri")} />
        <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1.5px solid var(--rule-soft)" }}><div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Primary currency</div><div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 2 }}>The other always stays visible</div></div><Seg grow={false} size={11} value={cur} onChange={setCur} options={[{ k: "usd", label: "$" }, { k: "inr", label: "₹" }]} /></div>
        <RowItem title="US market hours in" right={<Tag>{persona === "nri" ? "ET" : "IST"}</Tag>} last />
      </ListCard>
      <SecHead label="Connected US accounts" right={<GhostBtn full={false} icon={null} style={{ padding: "6px 10px", fontSize: 11.5 }} onClick={() => go("usconnect")}>+ Add</GhostBtn>} />
      <ListCard>
        <RowItem left={<UsTile ab="RH" bg="#00c805" fg="#0b2b0b" />} title="Robinhood" sub="8 positions · via SnapTrade" right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--gain-text)", fontWeight: 700 }}>● synced 2h</span>} />
        <RowItem left={<UsTile ab="FD" bg="#00945f" fg="#fff" />} title="Fidelity" sub="6 positions · session expired Jul 14" right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--loss)", fontWeight: 700 }}>↻ re-auth</span>} onClick={() => go("usoauth:fd:fail")} />
        <RowItem left={<UsTile ab="IM" bg="var(--pop-5)" fg="#fff" />} title="Vested · imported" sub="3 statements · last Apr 26" right={<Tag>import-only</Tag>} onClick={() => go("usimport")} last />
      </ListCard>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.6 }}>TOKENS ENCRYPTED AT REST · NO TRADING SCOPE, EVER · <span style={{ color: "var(--loss)", fontWeight: 700 }}>REVOKE ALL US ACCESS</span></div>
      <SecHead label="US data disclosure" />
      <Card pad={0} style={{ overflow: "hidden" }}>
        <div style={{ padding: "12px 14px", display: "flex", flexWrap: "wrap", gap: 6 }}><Tag>◷ end-of-day prices</Tag><Tag>SEC EDGAR</Tag><Tag>spot FX hourly · RBI ref for cost</Tag><Tag bg="var(--pop-1)" color="#fff" style={{ borderColor: "var(--ink)" }}>no live ticks · no execution</Tag></div>
        <div style={{ background: "var(--ink)", color: "var(--paper)", padding: "11px 14px", fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.7 }}><div><span style={{ opacity: 0.55 }}>prices  ›</span> third-party consolidated tape · <span style={{ color: "var(--pop-2)" }}>previous close</span></div><div><span style={{ opacity: 0.55 }}>filings ›</span> SEC EDGAR · 10-K 10-Q 8-K 3/4/5 13F</div><div><span style={{ opacity: 0.55 }}>fx      ›</span> <span style={{ color: "var(--pop-2)" }}>spot</span> for values · <span style={{ color: "var(--pop-2)" }}>RBI ref</span> for cost &amp; LRS</div><div><span style={{ opacity: 0.55 }}>orders  ›</span> <span style={{ color: "var(--pop-1)" }}>never</span></div></div>
      </Card>
      <Disclaimer>Analysis and education only — not investment advice. UseMoney is not a broker-dealer or a registered investment adviser in the US.</Disclaimer>
    </SubPage>
  );
}

Object.assign(window, { UsForkScreen, UsConnectScreen, UsOAuthScreen, UsImportScreen, UsStockScreen, UsPortfolioScreen, LrsScreen, UsPrefsScreen, US_HOLD, US_BOOK, FX_SPOT, usPair, usd, UsTile });
