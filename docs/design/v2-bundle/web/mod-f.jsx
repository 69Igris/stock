// ─────────────────────────────────────────────────────────────────────────
// Module F · Memory & Trading DNA — profile, transparency center, chat chips
// ─────────────────────────────────────────────────────────────────────────
const { useState: mfS } = React;

function ModuleF() {
  const [tab, setTab] = mfS("dna");
  const [mems, setMems] = mfS(MEMORIES);
  const [personalize, setPersonalize] = mfS(true);
  const [ev, setEv] = mfS(null);
  const togglePin = (i) => setMems(ms => ms.map((m, x) => x === i ? { ...m, pin: !m.pin } : m));
  const del = (i) => setMems(ms => ms.filter((_, x) => x !== i));

  return (
    <WShell active="settings" crumb="PROFILE · MEMORY & TRADING DNA" title="Your Investing DNA" ser="— inspectable, never creepy."
      right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>DPDP-COMPLIANT · EVERYTHING DELETABLE</span>}>
      <WTabs value={tab} onChange={setTab} tabs={[{ k: "dna", label: "Trading DNA" }, { k: "memory", label: "Memory center", badge: String(mems.length) }, { k: "chat", label: "In-chat indicators" }]} />

      {tab === "dna" && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 14 }}>
            {DNA.metrics.map((m, i) => (
              <div key={i} style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-3)", boxShadow: `3px 3px 0 ${m.bad ? "var(--pop-1)" : "var(--emerald)"}`, padding: "15px 17px" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <span style={{ width: 30, height: 30, borderRadius: 9, border: "2px solid var(--ink)", background: m.bad ? "var(--pop-1)" : "var(--emerald)", display: "grid", placeItems: "center", flexShrink: 0, transform: i % 2 ? "rotate(3deg)" : "rotate(-3deg)" }}>
                    <Icon name={m.bad ? "alert" : "check"} size={14} color="#0b0b09" strokeWidth={2.6} />
                  </span>
                  <div>
                    <b style={{ fontSize: 14.5, lineHeight: 1.35, display: "block" }}>{m.t}</b>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--ink-2)", marginTop: 6 }}>{m.v}</div>
                    <button onClick={() => setEv(m)} style={{ marginTop: 8, border: 0, background: "transparent", padding: 0, fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>EVIDENCE: {m.ev.toUpperCase()} →</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>{DNA.flags.map(f => <Tag key={f} color="var(--emerald-text)" bg="var(--paper-2)">✓ {f}</Tag>)}</div>
          <div style={{ marginTop: 16, border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-2)", padding: "16px 18px", maxWidth: 760 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, background: "var(--pop-5)", border: "1.5px solid var(--ink)", borderRadius: 5, padding: "2px 8px", color: "#1d1d1b" }}>AI-GENERATED COACHING</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)" }}>FROM THE DETERMINISTIC METRICS ABOVE · DELETABLE</span>
            </div>
            <p style={{ margin: "10px 0 0", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 16, lineHeight: 1.55, color: "var(--ink)" }}>"{DNA.narrative}"</p>
          </div>
          <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4 }}>METRICS NEED ≥10 PAIRED TRADES — BELOW THAT WE SHOW "NOT ENOUGH DATA", NEVER A WEAK STAT.</p>
        </div>
      )}

      {tab === "memory" && (
        <div style={{ marginTop: 20, maxWidth: 760 }}>
          <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>Everything Sage remembers about you, in one list. Memories accrue from chats, research runs and trades — each one is editable, pinnable, deletable.</p>
          {mems.length ? (
            <ListCard>
              {mems.map((m, i) => (
                <div key={m.t} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 16px", borderBottom: i < mems.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                  <Tag bg="var(--paper-2)">{m.k}</Tag>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 650 }}>{m.t}</span>
                  <button onClick={() => togglePin(i)} title={m.pin ? "Unpin" : "Pin — never auto-expires"} style={{ width: 28, height: 28, borderRadius: 8, border: "2px solid var(--ink)", background: m.pin ? "var(--pop-2)" : "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="star" size={12} color="#1d1d1b" strokeWidth={m.pin ? 2.8 : 2} /></button>
                  <button title="Edit" style={{ width: 28, height: 28, borderRadius: 8, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="pen" size={12} /></button>
                  <button onClick={() => del(i)} title="Delete" style={{ width: 28, height: 28, borderRadius: 8, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="x" size={12} color="var(--loss)" /></button>
                </div>
              ))}
            </ListCard>
          ) : (
            <EmptyState icon="brain" title="Sage remembers nothing yet" sub="It learns from chats and trades you make here — nothing is imported from anywhere else." />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14 }}>
            <GhostBtn full={false} accent="var(--loss)" style={{ padding: "11px 16px", fontSize: 13 }} onClick={() => setMems([])}>Delete all remembered facts</GhostBtn>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>DPDP RIGHT-TO-ERASURE · IMMEDIATE · IRREVERSIBLE</span>
          </div>
        </div>
      )}

      {tab === "chat" && (
        <div style={{ marginTop: 20, maxWidth: 720 }}>
          <SecHead label="In the chat composer" style={{ marginTop: 0 }} />
          <Card pad={16}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper)", padding: "11px 14px", fontSize: 13.5, color: "var(--ink-4)" }}>
              Ask anything about your money…<span style={{ marginLeft: "auto" }}><Icon name="send" size={15} color="var(--ink-3)" /></span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1.5px solid var(--rule-soft)", borderRadius: 99, background: "var(--paper-2)", padding: "4px 11px", fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--ink-2)" }}>
                <Icon name="brain" size={11} color="var(--emerald-text)" /> REMEMBERING: LONG-TERM, LOW-CHURN · TAX-FIRST
                <button style={{ border: 0, background: "transparent", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, color: "var(--emerald-text)", padding: 0 }}>MANAGE</button>
              </span>
            </div>
          </Card>
          <SecHead label="On research runs" />
          <Card pad={16}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ flex: 1 }}>
                <b style={{ fontSize: 14 }}>Personalise with my profile</b>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>Position sizing, tax lots, hold-style preferences woven into the report. Off = a clean-room report.</div>
              </div>
              <button onClick={() => setPersonalize(p => !p)} style={{ width: 48, height: 27, borderRadius: 99, border: "2px solid var(--ink)", background: personalize ? "var(--emerald)" : "var(--paper-2)", position: "relative", cursor: "pointer" }}>
                <span style={{ position: "absolute", top: 2, left: personalize ? 23 : 2, width: 19, height: 19, borderRadius: 99, background: "var(--paper)", border: "2px solid var(--ink)", transition: "left .15s" }} />
              </button>
            </div>
            <div style={{ marginTop: 12, borderTop: "1.5px dashed var(--rule-soft)", paddingTop: 11, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>
              {personalize ? "REPORTS WILL CARRY A \"PERSONALISED USING YOUR PROFILE\" TAG." : "OFF FOR THIS RUN — SAGE FORGETS YOU EXIST FOR 2 MINUTES."}
            </div>
          </Card>
        </div>
      )}

      <WModal open={!!ev} onClose={() => setEv(null)} title="Evidence — the trades behind the number">
        {ev && <>
          <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--ink-2)" }}><b>{ev.t}</b> — computed {ev.ev}. Deterministic: re-runs give the same answer.</p>
          <ListCard>
            {TRADES.slice(0, 4).map((t, i) => (
              <div key={t.id} style={{ display: "flex", gap: 12, padding: "10px 14px", borderBottom: i < 3 ? "1.5px solid var(--rule-soft)" : "none", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <b style={{ width: 90 }}>{t.sym}</b>
                <span style={{ color: "var(--ink-3)", flex: 1 }}>{t.bDate} → {t.sDate}</span>
                <span style={{ fontWeight: 800, color: t.pnl >= 0 ? "var(--gain-text)" : "var(--loss)" }}>{signMoney(t.pnl)}</span>
              </div>
            ))}
          </ListCard>
        </>}
      </WModal>
    </WShell>
  );
}
window.ModuleF = ModuleF;
