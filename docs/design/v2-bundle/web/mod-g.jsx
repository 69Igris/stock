// ─────────────────────────────────────────────────────────────────────────
// Module G · Model Picker & Research Upgrades — consensus, provenance, gaps
// ─────────────────────────────────────────────────────────────────────────
const { useState: mgS } = React;

function ModuleG() {
  const [model, setModel] = mgS("Auto");
  const [rerun, setRerun] = mgS(false);

  return (
    <WShell active="stocksage" crumb="STOCKSAGE · MODEL PICKER & PROVENANCE" title="Consensus" ser="over confidence."
      right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>NUMBERS ARE VERIFIED OR WITHHELD — NEVER GUESSED</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "380px 1fr", gap: 20, alignItems: "start" }}>
        {/* composer + model selector */}
        <div>
          <SecHead label="Research composer" style={{ marginTop: 0 }} />
          <Card pad={16}>
            <div style={{ border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper)", padding: "11px 14px", fontSize: 13.5, color: "var(--ink)" }}>Deep research on <b>INFY</b> — margin thesis</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", margin: "14px 0 8px" }}>MODEL</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {MODELS_W.map(m => (
                <div key={m.n} onClick={() => !m.lock && setModel(m.n)} style={{ display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 11, padding: "10px 12px", background: model === m.n ? "var(--pop-2)" : "var(--paper-3)", opacity: m.lock ? 0.6 : 1, cursor: m.lock ? "not-allowed" : "pointer", boxShadow: model === m.n ? "none" : "2px 2px 0 var(--ink)" }}>
                  <span style={{ width: 19, height: 19, borderRadius: 99, border: "2px solid var(--ink)", background: model === m.n ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center", flexShrink: 0 }}>{model === m.n && <Icon name="check" size={10} color="var(--paper)" strokeWidth={3.5} />}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 13, display: "flex", alignItems: "center", gap: 7 }}>{m.n}{m.lock && <Icon name="lock" size={11} color="var(--ink-3)" />}</div>
                    <div style={{ fontSize: 10.5, color: model === m.n ? "#3a3a35" : "var(--ink-3)", marginTop: 1 }}>{m.d}</div>
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, border: "1.5px solid var(--ink)", borderRadius: 6, padding: "2px 7px", background: m.x === "×2" ? "var(--pop-1)" : m.x === "×0.5" ? "var(--emerald)" : "var(--paper-2)", color: "#1d1d1b" }}>{m.x}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", lineHeight: 1.6 }}>CLAUDE / GPT-5: FOUNDER ALLOWLIST WHILE COSTS SETTLE — VISIBLE SO YOU KNOW IT'S COMING, LOCKED SO NOBODY'S SURPRISED. MULTIPLIER APPLIES TO DEEP RESEARCH ONLY.</div>
            <div style={{ marginTop: 12 }}><PrimaryBtn>Run research <CostChip n={model === "Gemini 2.5 Flash" ? 1 : 2} style={{ marginLeft: 8, background: "#fbf8eb" }} /></PrimaryBtn></div>
          </Card>
        </div>

        {/* upgraded report */}
        <div>
          <SecHead label="Report — with provenance, consensus & gap states" style={{ marginTop: 0 }} />
          <Card pad={0} style={{ overflow: "hidden" }}>
            <div style={{ padding: "16px 20px", borderBottom: "2px solid var(--ink)", background: "var(--paper-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, background: "var(--pop-2)", border: "2px solid var(--ink)", borderRadius: 7, padding: "3px 9px" }}>HOLD</span>
                <b style={{ fontSize: 17, letterSpacing: -0.4 }}>Infosys — hold thesis intact, watch the margin band</b>
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)" }}>PERSONALISED · 14 SOURCES</span>
              </div>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <b style={{ fontSize: 14 }}>Q1 FY27 revenue</b>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800 }}>₹40,986 Cr</span>
                <Consensus n={2} />
                <Provenance src="NSE FILING" asof="JUL 17" />
              </div>
              <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>Extracted independently by Gemini Pro and Flash; figures matched to the rupee. Growth of 3.9% cc sits inside the 3-5% guide.</p>

              <div style={{ marginTop: 16, borderTop: "1.5px dashed var(--rule-soft)", paddingTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 14 }}>GenAI bookings (TCV)</b>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: "var(--ink-4)" }}>— withheld</span>
                  <Consensus disagree />
                </div>
                <p style={{ margin: "8px 0 0", fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>One model read $380M, the other $410M from the call transcript. We don't average disagreements — the number is flagged for review instead of guessed.</p>
              </div>

              <div style={{ marginTop: 16 }}>
                <DataGap text="Peer-multiple source degraded (Yahoo rate-limited) — this section used yesterday's cache." />
              </div>

              <div style={{ marginTop: 16, borderTop: "1.5px dashed var(--rule-soft)", paddingTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                  <b style={{ fontSize: 14 }}>Valuation vs peers</b>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800 }}>24.3× vs 27.1× (TCS)</span>
                  <Provenance src="DB-CACHE" asof="JUL 19" />
                  {!rerun ? (
                    <button onClick={() => { setRerun(true); setTimeout(() => setRerun("done"), 1500); }} style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, border: "2px solid var(--ink)", borderRadius: 8, background: "var(--paper-3)", padding: "6px 12px", fontWeight: 800, fontSize: 11.5, cursor: "pointer", fontFamily: "var(--font-sans)", boxShadow: "2px 2px 0 var(--ink)" }}><Icon name="refresh" size={12} /> Re-run section <CostChip n={1} /></button>
                  ) : rerun === "done" ? (
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--gain-text)" }}>✓ REFRESHED FROM NSE LIVE · 24.3× CONFIRMED</span>
                  ) : (
                    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 7, alignItems: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}><Spinner size={13} /> RE-RUNNING…</span>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 16, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[["EDGAR", "10-K MAR 14"], ["NSE", "LIVE 09:42 IST"], ["YAHOO", "DEGRADED"], ["DB-CACHE", "JUL 19"], ["YOUR TRADEBOOK", "FIFO · LIVE"]].map(([s, a]) => <Provenance key={s} src={s} asof={a} />)}
              </div>
            </div>
          </Card>
          <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4, lineHeight: 1.7 }}>NEVER "AI IS CONFIDENT" — ALWAYS WHAT WAS CHECKED: EXTRACTED FROM THE FILING · MATCHED BY 2 MODELS · OR WITHHELD.</p>
        </div>
      </div>
    </WShell>
  );
}
window.ModuleG = ModuleG;
