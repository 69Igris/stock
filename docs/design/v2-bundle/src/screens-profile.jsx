// ─────────────────────────────────────────────────────────────────────────
// Post-signup investor profiling (5-step) → verdict. Routes into the app shell.
// ─────────────────────────────────────────────────────────────────────────
const { useState, useEffect } = React;

function InvestorProfileScreen({ go, back }) {
  const [step, setStep] = useState(0);
  const [ans, setAns] = useState({});
  const qs = [
    { k: "exp", q: "How long have you been investing?", opts: ["Just starting out", "1–3 years", "3–7 years", "7+ years, I know my way"] },
    { k: "goal", q: "What's your primary goal?", opts: ["Long-term wealth", "Retire early (FIRE)", "Regular income", "Active trading"] },
    { k: "risk", q: "How do you feel about risk?", opts: ["Keep it safe", "Balanced", "I can stomach swings", "High risk, high reward"] },
    { k: "freq", q: "How often do you check markets?", opts: ["Rarely", "Weekly", "Daily", "Multiple times a day"] },
    { k: "size", q: "Roughly, your portfolio size?", opts: ["Under ₹1 lakh", "₹1–10 lakh", "₹10–50 lakh", "₹50 lakh+"] },
  ];
  const total = qs.length;
  const cur = qs[step];
  const verdict = (() => {
    const e = ["Just starting out", "1–3 years"].includes(ans.exp);
    const pro = ["7+ years, I know my way"].includes(ans.exp) || ans.freq === "Multiple times a day";
    if (pro) return { name: "Pro", tag: "ADVANCED DENSITY", color: "var(--pop-5)", d: "Dense dashboard, advanced tools, raw numbers. We'll get out of your way." };
    if (e) return { name: "Beginner", tag: "GUIDED MODE", color: "var(--emerald)", d: "A calmer dashboard with explanations, Sage tutor, and gentle nudges." };
    return { name: "Explorer", tag: "BALANCED DENSITY", color: "var(--pop-3)", d: "A balanced view — key metrics up top, depth one tap away." };
  })();

  if (step >= total) {
    return (
      <Screen topPad={70} footer={<PrimaryBtn icon="arrowR" onClick={() => go("connect")}>Connect your broker</PrimaryBtn>}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
          <Eyebrow color={verdict.color}>PROFILE COMPLETE</Eyebrow>
          <div style={{ marginTop: 22, width: 120, height: 120, borderRadius: 28, background: verdict.color, border: "2px solid var(--ink)", boxShadow: "6px 6px 0 var(--ink)", display: "grid", placeItems: "center", transform: "rotate(-3deg)" }}>
            <Icon name={verdict.name === "Pro" ? "target" : verdict.name === "Beginner" ? "sparkles" : "layers"} size={52} color="#1d1d1b" />
          </div>
          <h1 style={{ fontWeight: 800, fontSize: 34, letterSpacing: -1.4, marginTop: 28, color: "var(--ink)" }}>You're a <span className="ser">{verdict.name}.</span></h1>
          <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1.5 }}>{verdict.tag}</div>
          <p style={{ marginTop: 14, fontSize: 15, lineHeight: 1.55, color: "var(--ink-2)", maxWidth: 300 }}>{verdict.d}</p>
          <button onClick={() => setStep(0)} style={{ marginTop: 18, border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", textDecoration: "underline", cursor: "pointer", letterSpacing: 0.5 }}>RETAKE</button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen onBack={step === 0 ? back : () => setStep(s => s - 1)} topPad={60}
      footer={<PrimaryBtn icon="arrowR" disabled={!ans[cur.k]} onClick={() => setStep(s => s + 1)}>{step === total - 1 ? "See my profile" : "Continue"}</PrimaryBtn>}>
      <div style={{ marginBottom: 4 }}><StepBar total={total} current={step} /></div>
      <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1 }}>QUESTION {step + 1} OF {total} · INVESTOR PROFILE</div>
      <h1 style={{ fontWeight: 800, fontSize: 29, lineHeight: 1.1, letterSpacing: -1.2, marginTop: 14, color: "var(--ink)", textWrap: "balance" }}>{cur.q}</h1>

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 11 }}>
        {cur.opts.map((o, i) => {
          const sel = ans[cur.k] === o;
          return (
            <button key={o} onClick={() => setAns(a => ({ ...a, [cur.k]: o }))} style={{
              display: "flex", alignItems: "center", gap: 13, padding: "16px 16px", textAlign: "left",
              borderRadius: 13, border: "2px solid var(--ink)", cursor: "pointer",
              background: sel ? "var(--ink)" : "var(--paper-3)", color: sel ? "var(--paper)" : "var(--ink)",
              boxShadow: sel ? "4px 4px 0 var(--emerald)" : "3px 3px 0 var(--ink)",
              transform: sel ? "translate(-1px,-1px)" : "none", transition: "transform .12s, box-shadow .12s",
            }}>
              <span style={{ width: 28, height: 28, borderRadius: 8, flexShrink: 0, border: "2px solid", borderColor: sel ? "var(--paper)" : "var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 13 }}>{sel ? <Icon name="check" size={15} color="var(--paper)" strokeWidth={3} /> : String.fromCharCode(65 + i)}</span>
              <span style={{ fontSize: 15.5, fontWeight: 600 }}>{o}</span>
            </button>
          );
        })}
      </div>
    </Screen>
  );
}

Object.assign(window, { InvestorProfileScreen });
