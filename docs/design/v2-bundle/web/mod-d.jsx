// ─────────────────────────────────────────────────────────────────────────
// Module D · US Launch — NRI onboarding, LRS import, US stock page, dual ₹/$
// ─────────────────────────────────────────────────────────────────────────
const { useState: mdS } = React;

function Dual({ inrV, usdV, cur }) {
  return cur === "INR"
    ? <span>{money(inrV)} <span style={{ fontSize: "0.72em", color: "var(--ink-3)" }}>(${usd(usdV)})</span></span>
    : <span>${usd(usdV)} <span style={{ fontSize: "0.72em", color: "var(--ink-3)" }}>({money(inrV)})</span></span>;
}

function ModuleD() {
  const [tab, setTab] = mdS("dash");
  const [cur, setCur] = mdS("INR");
  const [step, setStep] = mdS(0);
  const usVal = US_MIX.usHoldings.reduce((a, [s, q, p]) => a + q * p, 0);
  const usInr = usVal * US_MIX.fx;

  return (
    <WShell active="holdings" crumb="PORTFOLIO · US + INDIA" title="Two markets," ser="one truth."
      right={<div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Seg grow={false} size={10.5} value={cur} onChange={setCur} options={[{ k: "INR", label: "₹ primary" }, { k: "USD", label: "$ primary" }]} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>FX 83.42 · AS OF 09:00 IST</span>
      </div>}>
      <WTabs value={tab} onChange={setTab} tabs={[{ k: "dash", label: "Mixed dashboard" }, { k: "import", label: "LRS import wizard" }, { k: "stock", label: "US stock page" }, { k: "onboard", label: "NRI onboarding" }]} />

      {tab === "dash" && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
            <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--emerald)" style={{ color: "var(--paper)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.2, opacity: 0.7 }}>INDIA · 3 BROKERS · LIVE</div>
              <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 24, marginTop: 6 }}>{money(US_MIX.inr)}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--emerald)", marginTop: 3 }}>+₹8,130 TODAY · NSE OPEN</div>
            </Card>
            <Card pad={16}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.2, color: "var(--ink-3)" }}>US · STATEMENT IMPORT</span>
                <Delayed />
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 24, marginTop: 6 }}><Dual inrV={usInr} usdV={usVal} cur={cur} /></div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 3 }}>3 HOLDINGS · NASDAQ OPENS 19:00 IST</div>
            </Card>
            <Card pad={16} bg="var(--pop-2)" shadow="4px 4px 0 var(--ink)">
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.2, color: "#3a3a35" }}>LRS / TCS TRACKER · {LRS.fy.toUpperCase()}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 24, marginTop: 6, color: "#1d1d1b" }}>${usd(LRS.limit - LRS.used)}</div>
              <div style={{ height: 9, border: "1.5px solid var(--ink)", borderRadius: 99, background: "#fbf8eb", overflow: "hidden", marginTop: 8 }}>
                <div style={{ width: (LRS.used / LRS.limit * 100) + "%", minWidth: 6, height: "100%", background: "var(--ink)" }} />
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "#3a3a35", marginTop: 5 }}>USED ${usd(LRS.used)} OF $250,000 · TCS PAID ₹0</div>
            </Card>
          </div>
          <SecHead label="US holdings — imported from Vested statement · Jul 14" right={<Provenance src="STATEMENT IMPORT" asof="JUL 14" />} />
          <ListCard>
            {US_MIX.usHoldings.map(([s, q, p], i) => (
              <div key={s} onClick={() => setTab("stock")} style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 16px", borderBottom: i < US_MIX.usHoldings.length - 1 ? "1.5px solid var(--rule-soft)" : "none", cursor: "pointer" }}>
                <SymTile sym={s} size={34} />
                <b style={{ width: 80, fontFamily: "var(--font-mono)", fontSize: 13 }}>{s}</b>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{q} sh · ${usd(p, 2)}</span>
                <Delayed text="EOD" />
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800 }}><Dual inrV={q * p * US_MIX.fx} usdV={q * p} cur={cur} /></span>
              </div>
            ))}
          </ListCard>
        </div>
      )}

      {tab === "import" && (
        <div style={{ marginTop: 20, maxWidth: 700 }}>
          <StepBar total={3} current={step} />
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", margin: "10px 0 14px" }}>STEP {step + 1} / 3 — {["UPLOAD STATEMENT", "MAP COLUMNS", "REVIEW HOLDINGS"][step]}</div>
          {step === 0 && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                {["Vested", "INDmoney", "Schwab", "IBKR / CSV"].map((b, i) => (
                  <div key={b} style={{ border: "2px solid var(--ink)", borderRadius: 12, padding: "12px 13px", background: i === 0 ? "var(--pop-2)" : "var(--paper-3)", boxShadow: i === 0 ? "none" : "2px 2px 0 var(--ink)", fontWeight: 800, fontSize: 13, cursor: "pointer", textAlign: "center" }}>{b}</div>
                ))}
              </div>
              <div style={{ marginTop: 14, border: "2px dashed var(--ink)", borderRadius: 14, padding: "30px 16px", textAlign: "center", background: "var(--paper-2)", cursor: "pointer" }} onClick={() => setStep(1)}>
                <Icon name="upload" size={22} color="var(--ink-2)" />
                <div style={{ fontWeight: 800, fontSize: 14, marginTop: 8 }}>Drop your Vested statement (PDF / CSV)</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>WE DETECT THE FORMAT AND MAP COLUMNS AUTOMATICALLY</div>
              </div>
            </>
          )}
          {step === 1 && (
            <>
              <ListCard>
                {[["Symbol", "Symbol", 99], ["Quantity", "Quantity", 99], ["Avg cost (USD)", "Average price", 98], ["Account", "— skipped (not needed)", 0]].map(([c, m, conf], i, arr) => (
                  <div key={c} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 15px", borderBottom: i < arr.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: "var(--ink-3)", flex: 1 }}>{c}</span>
                    <Icon name="arrowR" size={13} color="var(--ink-4)" />
                    <span style={{ flex: 1, textAlign: "right", fontSize: 13, fontWeight: 800, color: conf ? "var(--ink)" : "var(--ink-4)" }}>{m}</span>
                    {conf > 0 && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, color: "var(--gain-text)" }}>{conf}%</span>}
                  </div>
                ))}
              </ListCard>
              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <GhostBtn full={false} onClick={() => setStep(0)} style={{ padding: "11px 16px" }}>Back</GhostBtn>
                <PrimaryBtn full={false} onClick={() => setStep(2)} style={{ padding: "12px 20px" }}>Looks right — import</PrimaryBtn>
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                {[["Holdings imported", "3"], ["Skipped columns", "1 — shown, never guessed"], ["FX applied", "83.42 · 09:00 IST"]].map(([l, v]) => (
                  <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 12, padding: "12px 14px", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800 }}>{v}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.8, color: "var(--ink-3)", marginTop: 3, textTransform: "uppercase" }}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 14 }}><PrimaryBtn full={false} style={{ padding: "12px 20px" }} onClick={() => setTab("dash")}>See the mixed dashboard →</PrimaryBtn></div>
            </>
          )}
        </div>
      )}

      {tab === "stock" && (
        <div style={{ marginTop: 20, maxWidth: 900 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <SymTile sym="AAPL" size={44} rotate={-2} />
            <div>
              <h2 style={{ margin: 0, fontWeight: 800, fontSize: 24, letterSpacing: -0.9 }}>{US_STOCK.name} <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--ink-3)" }}>NASDAQ · {US_STOCK.sym}</span></h2>
              <div style={{ display: "flex", gap: 8, marginTop: 5 }}><Delayed text={"EOD · " + US_STOCK.asof} /><Provenance src="SEC EDGAR" asof="10-K FILED MAR 14" /></div>
            </div>
            <div style={{ marginLeft: "auto", textAlign: "right" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 26 }}>${US_STOCK.px}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--gain-text)", fontWeight: 700 }}>{pct(US_STOCK.chg, 2)} · ₹{inr(US_STOCK.pxInr)}</div>
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16, alignItems: "start" }}>
            <div>
              <KV rows={[["Market cap", US_STOCK.mcap], ["P/E (TTM)", US_STOCK.pe + "×"], ["EPS", "$" + US_STOCK.eps], ["Dividend yield", US_STOCK.divy + "%"]]} />
              <SecHead label="Insider activity" right={<Provenance src="SEC FORM 4" asof="JUL 02" />} />
              <ListCard>
                {US_STOCK.insiders.map(([who, act, d], i) => (
                  <div key={who} style={{ display: "flex", gap: 10, padding: "10px 14px", borderBottom: i < US_STOCK.insiders.length - 1 ? "1.5px solid var(--rule-soft)" : "none", fontSize: 12.5 }}>
                    <b style={{ flex: 1 }}>{who}</b>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: act.startsWith("SELL") ? "var(--loss)" : "var(--gain-text)" }}>{act}</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>{d}</span>
                  </div>
                ))}
              </ListCard>
            </div>
            <div>
              <Card pad={14}>
                <SecHead label="Price · EOD series" style={{ margin: "0 0 6px" }} />
                <LineChart series={genSeries(77, 50, 0.002, 0.02, US_STOCK.px)} h={110} color="var(--emerald)" />
              </Card>
              <SecHead label="Top 13F holders" right={<Provenance src="SEC 13F" asof="Q1 2026" />} />
              <ListCard>
                {US_STOCK.holders13f.map(([n, w], i) => (
                  <div key={n} style={{ display: "flex", justifyContent: "space-between", padding: "10px 14px", borderBottom: i < US_STOCK.holders13f.length - 1 ? "1.5px solid var(--rule-soft)" : "none", fontSize: 12.5 }}>
                    <b>{n}</b><span style={{ fontFamily: "var(--font-mono)", fontWeight: 800 }}>{w}</span>
                  </div>
                ))}
              </ListCard>
            </div>
          </div>
        </div>
      )}

      {tab === "onboard" && (
        <div style={{ marginTop: 20, maxWidth: 560 }}>
          <StepBar total={4} current={1} />
          <h2 style={{ fontWeight: 800, fontSize: 26, letterSpacing: -1, margin: "16px 0 6px" }}>Where does your money <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>live?</span></h2>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)" }}>We'll set currencies, market hours and tax rules to match.</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
            {[["India only", "NSE & BSE · ₹ · STCG/LTCG", false], ["India + US (NRI / LRS)", "₹ primary, $ secondary · IST for both market clocks", true], ["US only", "statement import first · broker connect later", false]].map(([t, d, on]) => (
              <div key={t} style={{ display: "flex", alignItems: "center", gap: 12, border: "2px solid var(--ink)", borderRadius: 13, padding: "14px 16px", background: on ? "var(--pop-2)" : "var(--paper-3)", boxShadow: on ? "none" : "3px 3px 0 var(--ink)", cursor: "pointer" }}>
                <span style={{ width: 21, height: 21, borderRadius: 99, border: "2px solid var(--ink)", background: on ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center" }}>{on && <Icon name="check" size={11} color="var(--paper)" strokeWidth={3.5} />}</span>
                <div><b style={{ fontSize: 14.5 }}>{t}</b><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: on ? "#3a3a35" : "var(--ink-3)", marginTop: 2 }}>{d.toUpperCase()}</div></div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 16, border: "2px dashed var(--ink)", borderRadius: 12, padding: "12px 15px", display: "flex", gap: 10, alignItems: "center", opacity: 0.75 }}>
            <Icon name="link" size={15} color="var(--ink-3)" />
            <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}><b>Connect a US broker</b> — coming later. Statement import works today.</span>
          </div>
          <div style={{ marginTop: 16 }}><PrimaryBtn full={false} style={{ padding: "12px 22px" }} onClick={() => setTab("import")}>Continue → import a statement</PrimaryBtn></div>
        </div>
      )}
    </WShell>
  );
}
window.ModuleD = ModuleD;
