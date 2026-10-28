// ─────────────────────────────────────────────────────────────────────────
// Module B · AI Hedge-Fund Analyst Board — setup → run → verdict board
// ─────────────────────────────────────────────────────────────────────────
const { useState: mbS, useEffect: mbE } = React;

const SIG_COLOR = { BULLISH: "var(--emerald)", BEARISH: "var(--pop-1)", NEUTRAL: "var(--pop-2)" };

function PersonaTile({ p, picked, onToggle, i }) {
  const locked = !p.free;
  return (
    <Press onClick={() => !locked && onToggle(p.id)}>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 13, background: picked ? "var(--pop-2)" : "var(--paper-3)", boxShadow: picked ? "none" : "3px 3px 0 var(--ink)", padding: "13px 14px", opacity: locked ? 0.65 : 1, position: "relative", height: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 38, height: 38, borderRadius: 11, border: "2px solid var(--ink)", background: SYM_COLORS[i % SYM_COLORS.length], display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 15, transform: i % 2 ? "rotate(3deg)" : "rotate(-3deg)", color: "#1d1d1b" }}>{p.n.split(" ").map(x => x[0]).join("")}</span>
          <div>
            <div style={{ fontWeight: 800, fontSize: 13.5 }}>{p.n}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.7, color: picked ? "#3a3a35" : "var(--ink-3)" }}>{p.tag.toUpperCase()}</div>
          </div>
          {locked ? <span style={{ marginLeft: "auto" }}><Icon name="lock" size={14} color="var(--ink-3)" /></span>
            : <span style={{ marginLeft: "auto", width: 20, height: 20, borderRadius: 99, border: "2px solid var(--ink)", background: picked ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center" }}>{picked && <Icon name="check" size={10} color="var(--paper)" strokeWidth={3.5} />}</span>}
        </div>
        {locked && <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, color: "var(--ink-3)", letterSpacing: 0.5 }}>PRO BOARD — FREE GETS 2 PERSONAS / 1 SYMBOL / DAY</div>}
      </div>
    </Press>
  );
}

function ModuleB() {
  const [phase, setPhase] = mbS("setup");
  const [picked, setPicked] = mbS(["buffett", "lynch"]);
  const [thinking, setThinking] = mbS(0);
  const [debateOpen, setDebateOpen] = mbS(true);
  const [share, setShare] = mbS(false);
  const board = PERSONAS; // verdict shows all 5 for the demo run
  mbE(() => {
    if (phase !== "run") return;
    if (thinking >= 5) { const t = setTimeout(() => setPhase("board"), 500); return () => clearTimeout(t); }
    const t = setTimeout(() => setThinking(x => x + 1), 750);
    return () => clearTimeout(t);
  }, [phase, thinking]);
  const toggle = (id) => setPicked(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);

  return (
    <WShell active="research" crumb="RESEARCH · ANALYST BOARD" title="The INFY hearing" ser="— five investors walk into a room."
      right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>FREE: 2 PERSONAS · 1 SYMBOL / DAY</span>}>

      {phase === "setup" && (
        <div style={{ maxWidth: 880 }}>
          <SecHead label="Symbol" style={{ marginTop: 0 }} />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {["INFY", "RELIANCE", "HDFCBANK", "TCS", "TATAMOTORS"].map((s, i) => (
              <Chip key={s} active={i === 0}>{s}{HOLDINGS.find(h => h.sym === s) && " · you hold"}</Chip>
            ))}
            <Chip>⌕ Any symbol…</Chip>
          </div>
          <SecHead label="Pick your board · default 5 · full 13 with PRO" />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 12 }}>
            {PERSONAS.map((p, i) => <PersonaTile key={p.id} p={p} i={i} picked={picked.includes(p.id)} onToggle={toggle} />)}
          </div>
          <div style={{ marginTop: 14 }}>
            <WGate tier="PRO" line="Unlock the full 13-persona board — Graham, Munger, Wood, Dalio, Ackman and more." />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
            <PrimaryBtn full={false} style={{ padding: "13px 24px" }} onClick={() => { setThinking(0); setPhase("run"); }}>Convene the board <CostChip n={3} style={{ marginLeft: 8, background: "#fbf8eb" }} /></PrimaryBtn>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>~90s · PERSONAS ARE ANALYSIS LENSES, NOT ADVICE</span>
          </div>
        </div>
      )}

      {phase === "run" && (
        <div style={{ maxWidth: 880 }}>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 16, color: "var(--ink-2)", marginBottom: 16 }}>The room goes quiet. Everyone's reading…</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(270px, 1fr))", gap: 12 }}>
            {board.map((p, i) => {
              const state = i < thinking ? "done" : i === thinking ? "busy" : "wait";
              return (
                <div key={p.id} style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 14px", opacity: state === "wait" ? 0.45 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: SYM_COLORS[i % SYM_COLORS.length], display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13, color: "#1d1d1b" }}>{p.n.split(" ").map(x => x[0]).join("")}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 13 }}>{p.n}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)" }}>
                        {state === "done" ? "VERDICT SEALED ✓" : state === "busy" ? ["reading annual report…", "checking owner earnings…", "running the DCF…", "reading the call transcript…", "sizing the short case…"][i] : "WAITING"}
                      </div>
                    </div>
                    {state === "busy" && <Spinner size={15} />}
                    {state === "done" && <Icon name="check" size={15} color="var(--emerald-text)" strokeWidth={3} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {phase === "board" && (
        <div>
          {/* masthead */}
          <div style={{ border: "2px solid var(--ink)", borderRadius: 16, background: "var(--ink)", color: "var(--paper)", padding: "18px 22px", boxShadow: "5px 5px 0 var(--pop-2)", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1.6, opacity: 0.7 }}>THE VERDICT BOARD · JUL 20, 09:44 IST · 14 SOURCES</div>
              <div style={{ fontWeight: 800, fontSize: 30, letterSpacing: -1.3, marginTop: 4 }}>INFY — <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>hold, with one loud objection.</span></div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              {["2 BULLISH", "2 NEUTRAL", "1 BEARISH"].map((t, i) => (
                <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, background: [SIG_COLOR.BULLISH, SIG_COLOR.NEUTRAL, SIG_COLOR.BEARISH][i], color: "#0b0b09", border: "2px solid var(--paper)", borderRadius: 7, padding: "5px 10px" }}>{t}</span>
              ))}
            </div>
          </div>

          {/* verdict cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 14, marginTop: 18 }}>
            {board.map((p, i) => (
              <div key={p.id} style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "15px 16px", transform: i % 2 ? "rotate(0.4deg)" : "rotate(-0.4deg)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: SYM_COLORS[i % SYM_COLORS.length], display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13, color: "#1d1d1b", transform: "rotate(-3deg)" }}>{p.n.split(" ").map(x => x[0]).join("")}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 14 }}>{p.n}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.6, color: "var(--ink-3)" }}>{p.tag.toUpperCase()}</div>
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, background: SIG_COLOR[p.signal], color: "#0b0b09", border: "2px solid var(--ink)", borderRadius: 7, padding: "4px 9px" }}>{p.signal}</span>
                </div>
                <div style={{ margin: "11px 0 5px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, color: "var(--ink-3)" }}>CONVICTION</span>
                  <div style={{ flex: 1, height: 9, border: "1.5px solid var(--ink)", borderRadius: 99, background: "var(--paper-2)", overflow: "hidden" }}>
                    <div style={{ width: p.conv + "%", height: "100%", background: SIG_COLOR[p.signal] }} />
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800 }}>{p.conv}</span>
                </div>
                <p style={{ margin: "8px 0 0", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)" }}>"{p.thesis}"</p>
              </div>
            ))}
            {/* risk manager */}
            <div style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-2)", boxShadow: "3px 3px 0 var(--ink)", padding: "15px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--ink)", display: "grid", placeItems: "center" }}><Icon name="shield" size={17} color="var(--paper)" /></span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>Risk Manager</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--ink-3)", letterSpacing: 0.6 }}>DETERMINISTIC — NO OPINIONS</div>
                </div>
              </div>
              <div style={{ marginTop: 11, display: "flex", flexDirection: "column", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--ink-2)" }}>
                <span>POSITION CAP · 8% → MAX ₹1,37,900</span>
                <span>YOU HOLD · ₹1,93,248 (11.2%) — <span style={{ color: "var(--loss)" }}>OVER CAP</span></span>
                <span>IT SECTOR WEIGHT · 18.4% VS INDEX 13%</span>
                <span>ADD WOULD RAISE CORR-CLUSTER RISK · TCS 0.77</span>
              </div>
            </div>
          </div>

          {/* debate */}
          <SecHead label="Bull vs bear — 2 rounds" right={<Chip onClick={() => setDebateOpen(o => !o)} style={{ padding: "5px 11px", fontSize: 10.5 }}>{debateOpen ? "Collapse" : "Expand"}</Chip>} />
          {debateOpen && (
            <ListCard>
              {DEBATE.map((d, i) => (
                <div key={i} style={{ display: "flex", gap: 12, padding: "12px 18px", borderBottom: i < DEBATE.length - 1 ? "1.5px solid var(--rule-soft)" : "none", background: d.side === "bear" ? "color-mix(in oklab, var(--pop-1) 7%, var(--paper-3))" : "transparent" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, color: "#0b0b09", background: d.side === "bull" ? "var(--emerald)" : "var(--pop-1)", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px", height: "fit-content", flexShrink: 0 }}>R{d.r} · {d.who.toUpperCase()}</span>
                  <span style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>{d.text}</span>
                </div>
              ))}
            </ListCard>
          )}

          {/* final verdict + dissent */}
          <div style={{ marginTop: 18, border: "2px solid var(--ink)", borderRadius: 14, background: "var(--pop-2)", boxShadow: "4px 4px 0 var(--ink)", padding: "17px 20px" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "#3a3a35" }}>FINAL VERDICT · WEIGHTED BY CONVICTION</div>
            <div style={{ fontWeight: 800, fontSize: 21, letterSpacing: -0.6, color: "#1d1d1b", marginTop: 6 }}>HOLD — quality franchise at fair value; size is your real problem, not the stock.</div>
            <div style={{ marginTop: 10, display: "flex", gap: 9, alignItems: "flex-start", borderTop: "2px dashed rgba(29,29,27,0.3)", paddingTop: 10 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, background: "var(--pop-1)", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px", flexShrink: 0 }}>DISSENT</span>
              <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14.5, color: "#1d1d1b" }}>Burry disagrees: "the 20% margin floor is a story — one BFSI winter and this re-rates to 19×."</span>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>
            <PrimaryBtn full={false} style={{ padding: "12px 20px" }} icon="external" onClick={() => setShare(true)}>Share the board</PrimaryBtn>
            <GhostBtn full={false} style={{ padding: "11px 18px" }} icon="refresh" onClick={() => { setPhase("setup"); }}>New hearing</GhostBtn>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4 }}>PERSONAS CHANGE PRESENTATION, NEVER RECOMMENDATIONS · EDUCATION, NOT ADVICE</span>
          </div>

          <WModal open={share} onClose={() => setShare(false)} title="Share card">
            <div style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--ink)", color: "var(--paper)", padding: "18px 20px", boxShadow: "4px 4px 0 var(--pop-2)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><Wordmark size={12} color="var(--paper)" /><span style={{ fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1.2, opacity: 0.7 }}>ANALYST BOARD</span></div>
              <div style={{ fontWeight: 800, fontSize: 24, letterSpacing: -1, margin: "12px 0 4px" }}>INFY · HOLD <span style={{ color: "var(--pop-2)" }}>2-2-1</span></div>
              <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13, opacity: 0.9 }}>"Burry disagrees: one BFSI winter and this re-rates."</div>
              <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 8, letterSpacing: 1, opacity: 0.6 }}>NO PERSONAL NUMBERS · USEMONEY.AI</div>
            </div>
            <div style={{ marginTop: 12 }}><PrimaryBtn onClick={() => setShare(false)}>Copy image</PrimaryBtn></div>
          </WModal>
        </div>
      )}
    </WShell>
  );
}
window.ModuleB = ModuleB;
