// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · Portfolio Roast: scope → run → score → share
// ─────────────────────────────────────────────────────────────────────────
const { useState: roS, useEffect: roE } = React;

const HEAT = { spicy: "var(--pop-1)", burn: "var(--pop-1)", mild: "var(--pop-2)" };

function ScoreDial({ score, size = 148 }) {
  const R = (size - 18) / 2, C = 2 * Math.PI * R;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--rule-soft)" strokeWidth="14" />
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--pop-2)" strokeWidth="14" strokeLinecap="round"
          strokeDasharray={`${score / 100 * C} ${C}`} style={{ transition: "stroke-dasharray 1s cubic-bezier(.22,.61,.36,1)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 44, letterSpacing: -2, color: "var(--pop-2)", lineHeight: 1 }}>{score}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: 1.4, color: "var(--paper)", opacity: 0.7, marginTop: 4 }}>/ 100</div>
        </div>
      </div>
    </div>
  );
}

function RoastShareSheet({ um }) {
  return (
    <div>
      <div style={{ border: "2px solid var(--ink)", borderRadius: 16, background: "var(--ink)", color: "var(--paper)", padding: "20px 18px", boxShadow: "4px 4px 0 var(--pop-2)", position: "relative", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Wordmark size={13} color="var(--paper)" />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1.2, opacity: 0.7 }}>PORTFOLIO ROAST</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 16 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 56, letterSpacing: -3, color: "var(--pop-2)" }}>{ROAST.score}</div>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15, lineHeight: 1.4 }}>"{ROAST.line}"</div>
        </div>
        <div style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, opacity: 0.65 }}>{ROAST.stats.xirr.toUpperCase()} · GET YOURS AT USEMONEY.AI</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginTop: 16 }}>
        {["WhatsApp", "X / Twitter", "Save image", "Copy link"].map(t => (
          <GhostBtn key={t} full onClick={() => { um.setSheet(null); um.toast(t === "Copy link" ? "Link copied" : "Shared to " + t); }} style={{ padding: "12px 8px", fontSize: 13 }}>{t}</GhostBtn>
        ))}
      </div>
      <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", letterSpacing: 0.4, textAlign: "center" }}>YOUR NUMBERS STAY PRIVATE — ONLY SCORE + ONE-LINER GO OUT.</p>
    </div>
  );
}

function RoastScreenV2({ go, back, um }) {
  const [phase, setPhase] = roS("intro");
  const [scope, setScope] = roS("full");
  const [step, setStep] = roS(0);
  const STEPS = [
    { t: "Reading 13 holdings across 3 brokers", d: "equity + MF, FIFO lots" },
    { t: "Judging concentration & overlap", d: "sector weights, MF-stock overlap" },
    { t: "Auditing your costs", d: "expense ratios, idle cash, churn" },
    { t: "Checking your behaviour", d: "disposition, hold times, drift" },
    { t: "Sharpening the verdict", d: "no sugar-coating" },
  ];
  roE(() => {
    if (phase !== "run") return;
    if (step >= STEPS.length) { const t = setTimeout(() => setPhase("done"), 400); return () => clearTimeout(t); }
    const t = setTimeout(() => setStep(s => s + 1), step === 0 ? 800 : 950);
    return () => clearTimeout(t);
  }, [phase, step]);

  if (phase === "run") {
    return (
      <SubPage um={um} title="Portfolio roast" onBack={() => setPhase("intro")}>
        <PageHead eyebrow="Portfolio roast · running" color="var(--pop-1)" title="Judging" ser="everything." />
        <div style={{ display: "flex", justifyContent: "center", margin: "18px 0 24px" }}>
          <span style={{ width: 74, height: 74, borderRadius: 20, background: "var(--pop-1)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", transform: "rotate(-4deg)", boxShadow: "4px 4px 0 var(--ink)", animation: "umpulse 1.4s infinite" }}>
            <Icon name="flame" size={36} color="#1d1d1b" />
          </span>
        </div>
        <ProgressSteps steps={STEPS} current={step} />
      </SubPage>
    );
  }

  if (phase === "done") {
    return (
      <SubPage um={um} title="Roast · verdict" onBack={back}>
        <PageHead eyebrow="Portfolio roast · verdict" color="var(--pop-1)" title="The good, " ser="the bad, the ugly." />
        <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 16, background: "var(--ink)", padding: "18px 16px", boxShadow: "4px 4px 0 var(--pop-1)", display: "flex", gap: 16, alignItems: "center" }}>
          <ScoreDial score={ROAST.score} size={124} />
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14.5, lineHeight: 1.45, color: "var(--paper)" }}>"{ROAST.line}"</div>
            <div style={{ marginTop: 9, fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, color: "var(--emerald)" }}>{ROAST.delta.toUpperCase()} · {ROAST.tag}</div>
          </div>
        </div>
        <SecHead label="The verdict" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ROAST.cards.map((c, i) => {
            const col = c.kind === "good" ? "var(--emerald)" : c.kind === "bad" ? "var(--pop-1)" : "var(--pop-2)";
            return (
              <div key={i} style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 14px", display: "flex", gap: 11 }}>
                <span style={{ width: 30, height: 30, borderRadius: 9, background: col, border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0, transform: i % 2 ? "rotate(3deg)" : "rotate(-3deg)" }}>
                  <Icon name={c.icon} size={15} color="#1d1d1b" strokeWidth={2.4} />
                </span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--ink)" }}>{c.title}</div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5, marginTop: 3 }}>{c.body}</div>
                </div>
              </div>
            );
          })}
        </div>
        <SecHead label="Holding by holding" />
        <ListCard>
          {ROAST.holdings.map((h, i) => (
            <div key={h.sym} style={{ padding: "12px 14px", borderBottom: i < ROAST.holdings.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 800, color: "var(--ink)" }}>{h.sym}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, padding: "2px 7px", borderRadius: 5, border: "1.5px solid var(--ink)", background: HEAT[h.heat], color: "#1d1d1b" }}>{h.heat.toUpperCase()}</span>
              </div>
              <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13.5, color: "var(--ink-2)", marginTop: 5, lineHeight: 1.45 }}>{h.line}</div>
            </div>
          ))}
        </ListCard>
        <div style={{ display: "flex", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
          {Object.values(ROAST.stats).map(s => <Tag key={s}>{s}</Tag>)}
        </div>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 9 }}>
          <PrimaryBtn icon="sparkles" onClick={() => { um.setSagePrefill("My roast says I'm over-concentrated in financials. How do I fix it?"); go("sage"); }}>Ask Sage how to fix it</PrimaryBtn>
          <div style={{ display: "flex", gap: 9 }}>
            <GhostBtn full={false} style={{ flex: 1 }} icon="external" onClick={() => um.setSheet({ title: "Share your roast", body: <RoastShareSheet um={um} /> })}>Share</GhostBtn>
            <GhostBtn full={false} style={{ flex: 1 }} icon="refresh" onClick={() => { setStep(0); setPhase("intro"); }}>Roast again</GhostBtn>
          </div>
        </div>
      </SubPage>
    );
  }

  // intro
  return (
    <SubPage um={um} title="Portfolio roast" onBack={back}>
      <PageHead eyebrow="Portfolio roast · honest" color="var(--pop-1)" title="Can your book" ser="take a punch?" sub="AI scores your holdings. Not a hit-piece — just real." />
      <div style={{ display: "flex", justifyContent: "flex-end", margin: "4px 6px 0 0" }}>
        <Sticker rotate={4} style={{ fontSize: 13 }}>last roast: <b>58</b> · Jul 12</Sticker>
      </div>
      <SecHead label="What gets roasted" />
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {[["full", "Full portfolio", "13 holdings · equity + MF · all 3 brokers"], ["equity", "Equity only", "10 stocks · ₹11.1L"], ["watch", "A watchlist", "roast stocks before you buy them"]].map(([k, t, d]) => (
          <Press key={k} onClick={() => setScope(k)}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, border: "2px solid var(--ink)", borderRadius: 13, padding: "13px 14px", background: scope === k ? "var(--pop-2)" : "var(--paper-3)", boxShadow: scope === k ? "none" : "3px 3px 0 var(--ink)" }}>
              <span style={{ width: 21, height: 21, borderRadius: 99, border: "2px solid var(--ink)", background: scope === k ? "var(--ink)" : "var(--paper)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                {scope === k && <Icon name="check" size={11} color="var(--paper)" strokeWidth={3.5} />}
              </span>
              <div>
                <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>{t}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: scope === k ? "#3a3a35" : "var(--ink-3)", marginTop: 2, letterSpacing: 0.3 }}>{d.toUpperCase()}</div>
              </div>
            </div>
          </Press>
        ))}
      </div>
      <div style={{ marginTop: 18 }}>
        <PrimaryBtn icon="flame" onClick={() => { setStep(0); setPhase("run"); }}>Roast me</PrimaryBtn>
        <p style={{ margin: "10px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.5, textAlign: "center" }}>FREE PLAN: 1 ROAST / MONTH · PRO: UNLIMITED</p>
      </div>
    </SubPage>
  );
}

Object.assign(window, { RoastScreenV2, ScoreDial });
