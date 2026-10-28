// ─────────────────────────────────────────────────────────────────────────
// Module E · Personalization — persona switcher, questionnaire, settings
// ─────────────────────────────────────────────────────────────────────────
const { useState: meS } = React;

const P_DEFS = {
  beginner: { n: "Beginner", tag: "GUIDE ME", d: "Sentences, not stats. 9 nav items. VaR/Greeks vocabulary banned." },
  intermediate: { n: "Intermediate", tag: "KEEP ME SHARP", d: "The default + tax-preview moat widget + insights feed." },
  advanced: { n: "Advanced", tag: "GET OUT OF MY WAY", d: "3-column dense terminal. Numbers first, adjectives never." },
};

function MiniDash({ p }) {
  if (p === "beginner") return (
    <div>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 12, background: "var(--ink)", color: "var(--paper)", padding: "14px 16px", boxShadow: "3px 3px 0 var(--emerald)" }}>
        <div style={{ fontSize: 15.5, lineHeight: 1.45, fontWeight: 650 }}>You've invested <b style={{ fontFamily: "var(--font-mono)" }}>₹15.2L</b> — now worth <b style={{ fontFamily: "var(--font-mono)", color: "var(--emerald)" }}>₹17,24,169</b>. Today it grew by <mark style={{ background: "var(--pop-2)", color: "#1d1d1b", padding: "0 5px", fontWeight: 800 }}>₹8,130</mark>.</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginTop: 10 }}>
        {["! Reconnect Upstox — 20s fix", "62 · Read your roast"].map(t => (
          <div key={t} style={{ border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)", padding: "10px 12px", fontSize: 12, fontWeight: 750, boxShadow: "2px 2px 0 var(--ink)" }}>{t}</div>
        ))}
      </div>
      <div style={{ marginTop: 10, border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)", padding: "9px 12px", fontSize: 12 }}><b>Dixon</b> rose a lot · <b>Zomato</b> fell a bit — nothing needs panic.</div>
    </div>
  );
  if (p === "intermediate") return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
        {[["VALUE", "₹17.24L", null], ["TODAY", "+₹8,130", "up"], ["XIRR", "16.4%", null], ["TAX HEADROOM", "₹63,880", "gold"]].map(([l, v, k]) => (
          <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 10, background: k === "gold" ? "var(--pop-2)" : "var(--paper-3)", padding: "9px 11px", boxShadow: "2px 2px 0 var(--ink)" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 7.5, letterSpacing: 0.8, color: k === "gold" ? "#3a3a35" : "var(--ink-3)" }}>{l}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, marginTop: 2, color: k === "up" ? "var(--gain-text)" : "var(--ink)" }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)", overflow: "hidden", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
        {[["INFY", "₹1,93,248", "+8.7%"], ["RELIANCE", "₹1,41,245", "+22.1%"], ["ITC", "₹1,38,690", "+12.8%"]].map(([s, v, p2], i) => (
          <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "6px 11px", borderTop: i ? "1.5px solid var(--rule-soft)" : "none" }}><b>{s}</b><span>{v}</span><span style={{ color: "var(--gain-text)", fontWeight: 700 }}>{p2}</span></div>
        ))}
      </div>
      <div style={{ marginTop: 10, border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-2)", padding: "8px 12px", fontSize: 11.5 }}><b>Insight:</b> 84 INFY shares turn long-term Aug 3 — waiting saves ₹1,144.</div>
    </div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 110px", gap: 8 }}>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 8.5 }}>
        <div style={{ letterSpacing: 0.8, color: "var(--ink-3)", marginBottom: 4 }}>WATCH</div>
        {[["HAL", "+1.8"], ["LT", "+1.2"], ["DIXON", "+3.2"], ["ZOMATO", "-2.1"]].map(([s, c]) => <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "2.5px 0" }}><b>{s}</b><span style={{ color: c.startsWith("-") ? "var(--loss)" : "var(--gain-text)", fontWeight: 700 }}>{c}</span></div>)}
      </div>
      <div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {[["VALUE", "₹17.24L"], ["VAR95", "-24.8k"], ["BETA", "1.08"]].map(([l, v]) => (
            <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 8, background: "var(--paper-3)", padding: "6px 8px" }}><div style={{ fontFamily: "var(--font-mono)", fontSize: 7, letterSpacing: 0.7, color: "var(--ink-3)" }}>{l}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, marginTop: 1 }}>{v}</div></div>
          ))}
        </div>
        <div style={{ marginTop: 6, border: "2px solid var(--ink)", borderRadius: 8, background: "var(--paper-3)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
          {[["INFY", "1,610.4", "-0.4"], ["RELIANCE", "2,942.6", "+1.2"], ["TCS", "3,895.2", "+0.8"], ["SBIN", "802.5", "+0.9"]].map(([s, v, c], i) => (
            <div key={s} style={{ display: "flex", justifyContent: "space-between", padding: "4px 9px", borderTop: i ? "1.5px solid var(--rule-soft)" : "none" }}><b>{s}</b><span>{v}</span><span style={{ color: c.startsWith("-") ? "var(--loss)" : "var(--gain-text)", fontWeight: 700 }}>{c}</span></div>
          ))}
        </div>
      </div>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)", padding: "7px 8px", fontFamily: "var(--font-mono)", fontSize: 8.5 }}>
        <div style={{ letterSpacing: 0.8, color: "var(--ink-3)", marginBottom: 4 }}>SIGNALS</div>
        <div style={{ border: "1.5px solid var(--ink)", borderRadius: 6, background: "var(--emerald)", padding: "3px 6px", fontWeight: 800, color: "#0b0b09" }}>TRIG · HAL</div>
        <div style={{ border: "1.5px solid var(--ink)", borderRadius: 6, background: "var(--pop-2)", padding: "3px 6px", fontWeight: 800, marginTop: 4 }}>NEW · LT</div>
        <div style={{ marginTop: 6, color: "var(--ink-3)" }}>FWD +2.4% vs +1.1%</div>
      </div>
    </div>
  );
}

function ModuleE() {
  const [persona, setPersona] = meS("intermediate");
  const [preview, setPreview] = meS(null);
  const [qOpen, setQOpen] = meS(false);
  const [qStep, setQStep] = meS(0);
  const QS = [
    ["How long have you been investing?", ["Just starting", "1-3 years", "3-10 years", "10+"]],
    ["What do you check daily?", ["Nothing — monthly at best", "My portfolio total", "Individual positions", "F&O + levels"]],
    ["Comfort with VaR, beta, drawdown?", ["What are those?", "Roughly", "Fluent"]],
    ["What should the dashboard do?", ["Guide me", "Keep me sharp", "Get out of my way"]],
  ];
  const active = preview || persona;
  return (
    <WShell active="settings" crumb="SETTINGS · PERSONALIZATION" title="One product," ser="three temperaments."
      right={<Chip onClick={() => { setQOpen(true); setQStep(0); }} style={{ padding: "6px 13px" }}>Retake questionnaire · 30s</Chip>}>
      <div style={{ display: "grid", gridTemplateColumns: "340px 1fr", gap: 20, alignItems: "start" }}>
        <div>
          <SecHead label="Dashboard persona" style={{ marginTop: 0 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {Object.entries(P_DEFS).map(([k, p]) => (
              <div key={k} style={{ border: "2px solid var(--ink)", borderRadius: 13, background: persona === k ? "var(--pop-2)" : "var(--paper-3)", boxShadow: persona === k ? "none" : "3px 3px 0 var(--ink)", padding: "13px 15px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ width: 20, height: 20, borderRadius: 99, border: "2px solid var(--ink)", background: persona === k ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center", cursor: "pointer" }} onClick={() => { setPersona(k); setPreview(null); }}>{persona === k && <Icon name="check" size={10} color="var(--paper)" strokeWidth={3.5} />}</span>
                  <b style={{ fontSize: 14.5 }}>{p.n}</b>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.7, color: persona === k ? "#3a3a35" : "var(--ink-3)" }}>"{p.tag}"</span>
                </div>
                <div style={{ fontSize: 12, color: persona === k ? "#3a3a35" : "var(--ink-3)", marginTop: 6, lineHeight: 1.5 }}>{p.d}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                  <button onClick={() => setPreview(k)} style={{ border: "2px solid var(--ink)", borderRadius: 8, background: "var(--paper)", padding: "5px 11px", fontWeight: 800, fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Preview →</button>
                  {preview === k && <button onClick={() => { setPersona(k); setPreview(null); }} style={{ border: "2px solid var(--ink)", borderRadius: 8, background: "var(--ink)", color: "var(--paper)", padding: "5px 11px", fontWeight: 800, fontSize: 11, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Apply</button>}
                </div>
              </div>
            ))}
          </div>
          <SecHead label="Why am I seeing this layout?" />
          <Card pad={14} bg="var(--paper-2)">
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.6, color: "var(--ink-2)" }}>You answered "3-10 years" + "keep me sharp" in the onboarding questionnaire (Jul 20). Persona changes <b>presentation only</b> — same computed numbers, same recommendations-free product. Override it any time here.</p>
          </Card>
          <SecHead label="Per-widget overrides" />
          <ListCard>
            {[["Tax-preview widget", true], ["Insights feed", true], ["VaR / risk tiles", false], ["Learning nudges", false]].map(([w, on], i, arr) => (
              <div key={w} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: i < arr.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700 }}>{w}</span>
                <span style={{ width: 40, height: 23, borderRadius: 99, border: "2px solid var(--ink)", background: on ? "var(--emerald)" : "var(--paper-2)", position: "relative", cursor: "pointer" }}><span style={{ position: "absolute", top: 1.5, left: on ? 18 : 2, width: 15, height: 15, borderRadius: 99, background: "var(--paper)", border: "2px solid var(--ink)" }} /></span>
              </div>
            ))}
          </ListCard>
        </div>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SecHead label={preview ? `Previewing · ${P_DEFS[preview].n} (not applied)` : `Live layout · ${P_DEFS[persona].n}`} style={{ margin: 0 }} />
            {preview && <Chip onClick={() => setPreview(null)} style={{ padding: "4px 10px", fontSize: 10 }}>✕ exit preview</Chip>}
          </div>
          <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 16, background: "var(--paper)", boxShadow: "5px 5px 0 var(--ink)", padding: "16px 18px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 1, background: "var(--pop-2)", border: "1.5px solid var(--ink)", borderRadius: 5, padding: "2px 7px" }}>{P_DEFS[active].tag}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)" }}>SAME DATA · ₹17,24,169 · +₹8,130 · XIRR 16.4%</span>
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, border: "2px solid var(--ink)", borderRadius: 99, background: "var(--ink)", color: "var(--paper)", padding: "5px 11px", fontWeight: 800, fontSize: 10.5 }}><Icon name="sparkles" size={11} color="var(--emerald)" /> Ask Sage — always here</span>
            </div>
            <MiniDash p={active} />
          </div>
          <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-4)", letterSpacing: 0.4, lineHeight: 1.7 }}>BEGINNER HIDES: STRATEGY LAB · SIGNALS · RISK · TRADEBOOK · SCREENER · DEV CONSOLE (SIDEBAR 16 → 9). CHAT IS NEVER REMOVED.</p>
        </div>
      </div>

      <WModal open={qOpen} onClose={() => setQOpen(false)} title={`Question ${Math.min(qStep + 1, 4)} of 4 · ~30s`} w={520}>
        {qStep < QS.length ? (
          <div>
            <StepBar total={4} current={qStep} />
            <h3 style={{ fontWeight: 800, fontSize: 19, letterSpacing: -0.5, margin: "16px 0 12px" }}>{QS[qStep][0]}</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {QS[qStep][1].map(o => (
                <button key={o} onClick={() => setQStep(s => s + 1)} style={{ textAlign: "left", border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)", padding: "12px 14px", fontWeight: 750, fontSize: 13.5, cursor: "pointer", fontFamily: "var(--font-sans)", boxShadow: "2px 2px 0 var(--ink)" }}>{o}</button>
              ))}
            </div>
            <button onClick={() => setQOpen(false)} style={{ marginTop: 12, border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)", cursor: "pointer", padding: 0 }}>SKIP — KEEP MY CURRENT LAYOUT</button>
          </div>
        ) : (
          <div style={{ textAlign: "center", padding: "10px 0" }}>
            <Sticker rotate={-3} style={{ display: "inline-block" }}>you're an <b>intermediate</b> — "keep me sharp."</Sticker>
            <p style={{ fontSize: 13, color: "var(--ink-2)", margin: "16px 0" }}>Applied. Preview the other two any time in Settings.</p>
            <PrimaryBtn onClick={() => { setPersona("intermediate"); setQOpen(false); }}>Done</PrimaryBtn>
          </div>
        )}
      </WModal>
    </WShell>
  );
}
window.ModuleE = ModuleE;
