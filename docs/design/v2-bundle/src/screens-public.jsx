// ─────────────────────────────────────────────────────────────────────────
// Public (pre-login) screens · part 1 — Splash, Onboarding, Welcome
// ─────────────────────────────────────────────────────────────────────────
const { useState, useEffect, useRef } = React;

// ── Splash ──────────────────────────────────────────────────────────────────
function SplashScreen({ go }) {
  useEffect(() => {
    const t = setTimeout(() => go("onboarding"), 2100);
    return () => clearTimeout(t);
  }, []);
  return (
    <div onClick={() => go("onboarding")} style={{
      height: "100%", background: "#1d1d1b", color: "#f7f3e6", display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", position: "relative", cursor: "pointer", overflow: "hidden",
      backgroundImage: "radial-gradient(rgba(247,243,230,0.05) 1px, transparent 1.5px)", backgroundSize: "9px 9px",
    }}>
      <style>{`@keyframes umpop{0%{transform:scale(.7) rotate(-3deg);opacity:0}60%{transform:scale(1.08) rotate(-3deg)}100%{transform:scale(1) rotate(-3deg);opacity:1}}
        @keyframes umfade{to{opacity:1;transform:none}} @keyframes umbar{0%{width:0}100%{width:128px}}`}</style>
      <div style={{ width: 96, height: 96, borderRadius: 22, background: "#f7f3e6", color: "#1d1d1b", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 56, letterSpacing: -2, animation: "umpop .7s cubic-bezier(.22,.61,.36,1) both", boxShadow: "6px 6px 0 #000" }}>U</div>
      <div style={{ marginTop: 30, fontWeight: 800, fontSize: 26, letterSpacing: -0.6, opacity: 0, animation: "umfade .5s .5s forwards" }}>
        UseMoney<sup style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#34d399", marginLeft: 2 }}>AI</sup>
      </div>
      <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 2, color: "rgba(244,237,224,0.6)", opacity: 0, animation: "umfade .5s .8s forwards", textTransform: "uppercase" }}>Use money. Intelligently.</div>
      <div style={{ position: "absolute", bottom: 90, height: 4, borderRadius: 99, background: "#34d399", animation: "umbar 1.6s .4s cubic-bezier(.22,.61,.36,1) forwards" }} />
      <div style={{ position: "absolute", bottom: 56, fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(244,237,224,0.35)", letterSpacing: 1.5 }}>NSE · BSE · 8 BROKERS</div>
    </div>
  );
}

// ── Onboarding carousel ─────────────────────────────────────────────────────
function OnboardingScreen({ go }) {
  const [i, setI] = useState(0);
  const slides = [
    {
      eyebrow: "01 · EVERY BROKER",
      vis: <ObBrokers />,
      h: <>Every broker. <span className="ser">One</span> <span className="hl-gold">workspace.</span></>,
      sub: "Zerodha, Groww, Angel One, Upstox and more — synced read-only into a single, reconciled portfolio.",
    },
    {
      eyebrow: "02 · ASK SAGE",
      vis: <ObSage />,
      h: <>Ask anything about <span className="ser">your</span> <span className="hl-gold">money.</span></>,
      sub: "StockSage has actually read your portfolio. Cited answers, not generic tips. No more guesswork.",
    },
    {
      eyebrow: "03 · SEE THE TRUTH",
      vis: <ObRoast />,
      h: <>Get your portfolio <span className="hl-gold">roasted.</span></>,
      sub: "An honest AI score on your holdings — concentration, risk, fees. Not a hit-piece. Just real.",
    },
    {
      eyebrow: "04 · PLAN YOUR FIRE",
      vis: <ObFire />,
      h: <>Retire on <span className="ser">Indian</span> numbers.</>,
      sub: "FIRE planning in ₹ — STCG, LTCG, PPF and EPF aware. Backtest and paper-trade on live NSE ticks.",
    },
  ];
  const last = i === slides.length - 1;
  const s = slides[i];
  return (
    <Screen scroll={false} topPad={58}
      headerRight={!last && <button onClick={() => go("welcome")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)", letterSpacing: 1, cursor: "pointer", textTransform: "uppercase" }}>Skip</button>}
      footer={
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <Dots count={slides.length} active={i} onDot={setI} />
          <PrimaryBtn full={false} icon={last ? "arrowR" : null} onClick={() => last ? go("welcome") : setI(i + 1)} style={{ minWidth: last ? 150 : 56, padding: last ? "14px 22px" : "14px 18px" }}>
            {last ? "Get started" : <Icon name="arrowR" size={18} color="var(--paper)" />}
          </PrimaryBtn>
        </div>
      }>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", paddingTop: 8 }}>
        <div key={i} style={{ animation: "umslide .4s cubic-bezier(.22,.61,.36,1) both" }}>
          <style>{`@keyframes umslide{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}`}</style>
          <div style={{ height: 280, marginBottom: 28, display: "flex", alignItems: "center", justifyContent: "center" }}>{s.vis}</div>
          <Eyebrow>{s.eyebrow}</Eyebrow>
          <h1 style={{ fontWeight: 800, fontSize: 36, lineHeight: 1.02, letterSpacing: -1.6, marginTop: 12, color: "var(--ink)", textWrap: "balance" }}>{s.h}</h1>
          <p style={{ marginTop: 14, fontSize: 15.5, lineHeight: 1.55, color: "var(--ink-2)", textWrap: "pretty" }}>{s.sub}</p>
        </div>
      </div>
    </Screen>
  );
}

// Onboarding visuals (type + colour blocks, no stock imagery) ────────────────
function ObBrokers() {
  const list = [
    { n: "zerodha", c: "#387ed1" }, { n: "groww", c: "#00b386" }, { n: "upstox", c: "#7b2ff7" }, { n: "angel", c: "#e85454" },
    { n: "dhan", c: "#f59e42" }, { n: "fyers", c: "#2196f3" }, { n: "hdfc", c: "#004c8f" }, { n: "icici", c: "#b8860b" },
  ];
  return (
    <div style={{ position: "relative", width: 250, height: 250 }}>
      <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, placeItems: "center" }}>
        {list.map((b, k) => (
          <div key={b.n} style={{ width: 66, height: 66, borderRadius: 14, background: "var(--paper-3)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", boxShadow: "3px 3px 0 var(--ink)", transform: `rotate(${(k % 3 - 1) * 3}deg)`, padding: 8 }}>
            <img src={`assets/brokers/${b.n}.png`} alt={b.n} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%,-50%) rotate(-3deg)", width: 66, height: 66, borderRadius: 16, background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 38, boxShadow: "4px 4px 0 var(--emerald)", border: "2px solid var(--ink)" }}>U</div>
    </div>
  );
}
function ObSage() {
  return (
    <div style={{ width: 286, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ alignSelf: "flex-end", maxWidth: "78%", background: "var(--ink)", color: "var(--paper)", padding: "12px 15px", borderRadius: "14px 14px 4px 14px", fontSize: 14, fontWeight: 500, boxShadow: "3px 3px 0 var(--emerald)" }}>Is my portfolio too concentrated in IT?</div>
      <div style={{ alignSelf: "flex-start", maxWidth: "88%", background: "var(--paper-3)", border: "2px solid var(--ink)", padding: "13px 15px", borderRadius: "14px 14px 14px 4px", boxShadow: "3px 3px 0 var(--ink)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: "var(--emerald)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={13} color="#fff" /></span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>STOCKSAGE</span>
        </div>
        <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--ink-2)" }}>Yes — IT is <strong style={{ color: "var(--ink)" }}>42%</strong> of equity, above the 25% you set. INFY + TCS alone are <strong style={{ color: "var(--ink)" }}>₹4.1L</strong>.</div>
        <div style={{ display: "flex", gap: 6, marginTop: 9 }}>
          {["INFY", "TCS", "PORTFOLIO"].map(t => <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, padding: "3px 7px", borderRadius: 99, background: "var(--emerald-bg)", color: "var(--emerald-text)", border: "1px solid var(--emerald)" }}>{t}</span>)}
        </div>
      </div>
    </div>
  );
}
function ObRoast() {
  return (
    <div style={{ width: 220, height: 220, borderRadius: 24, background: "var(--ink)", border: "2px solid var(--ink)", boxShadow: "6px 6px 0 var(--pop-1)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--paper)", position: "relative" }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: 2, color: "rgba(244,237,224,0.6)" }}>ROAST SCORE</div>
      <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 78, lineHeight: 1, color: "var(--pop-2)" }}>62</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(244,237,224,0.6)" }}>/ 100 · FAIR</div>
      <div style={{ position: "absolute", bottom: -14, padding: "6px 12px", background: "var(--pop-1)", color: "#fff", border: "2px solid var(--ink)", borderRadius: 99, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, transform: "rotate(-3deg)" }}>over-diversified.</div>
    </div>
  );
}
function ObFire() {
  return (
    <div style={{ width: 270 }}>
      <div style={{ background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 16, padding: 18, boxShadow: "4px 4px 0 var(--ink)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1.5 }}>FIRE NUMBER</div>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 34, color: "var(--ink)", letterSpacing: -1, marginTop: 4 }}>₹3.2 <span style={{ fontSize: 18 }}>Cr</span></div>
        <div style={{ marginTop: 14, height: 80, display: "flex", alignItems: "flex-end", gap: 6 }}>
          {[20, 30, 38, 50, 58, 70, 82, 100].map((h, k) => (
            <div key={k} style={{ flex: 1, height: `${h}%`, borderRadius: "4px 4px 0 0", background: k === 7 ? "var(--emerald)" : "var(--ink)", border: "1.5px solid var(--ink)" }} />
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}><span>NOW</span><span style={{ color: "var(--emerald-text)", fontWeight: 700 }}>AGE 47 ✦</span></div>
      </div>
    </div>
  );
}

// ── Welcome / hero ──────────────────────────────────────────────────────────
function WelcomeScreen({ go }) {
  return (
    <Screen scroll={true} topPad={60}
      footer={
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <PrimaryBtn onClick={() => go("signup")}>Create free account</PrimaryBtn>
          <GhostBtn icon={null} onClick={() => go("signin")}>I already have an account</GhostBtn>
          <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 4 }}>
            <button onClick={() => go("pricing")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase", textDecoration: "underline", textUnderlineOffset: 2 }}>See plans</button>
            <button onClick={() => go("broker")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase", textDecoration: "underline", textUnderlineOffset: 2 }}>How it works</button>
          </div>
        </div>
      }>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Wordmark size={18} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1, border: "1.5px solid var(--rule-soft)", borderRadius: 99, padding: "4px 9px" }}>NSE · BSE</span>
      </div>

      <div style={{ marginTop: 28 }}>
        <Eyebrow>USE MONEY. INTELLIGENTLY.</Eyebrow>
        <h1 style={{ fontWeight: 800, fontSize: 40, lineHeight: 0.99, letterSpacing: -2, marginTop: 14, color: "var(--ink)", textWrap: "balance" }}>
          Ask anything about your <span className="ser">money.</span> <span className="hl-gold">No more</span> <span className="strike">guesswork.</span>
        </h1>
        <p style={{ marginTop: 15, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 17.5, lineHeight: 1.4, color: "var(--ink-2)", textWrap: "pretty" }}>
          AI that's actually read your portfolio — every broker, every holding. Real answers, not generic tips.
        </p>
      </div>

      {/* try asking — prompt chips */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1.2, marginBottom: 9 }}>TRY ASKING →</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {["Roast my portfolio", "My real sector concentration?", "Did my trades beat a Nifty SIP?"].map(p => (
            <button key={p} onClick={() => go("signup")} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 99, border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", fontSize: 12.5, fontWeight: 600, cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}>
              <span style={{ color: "var(--ink-3)" }}>›</span>{p}
            </button>
          ))}
        </div>
      </div>

      {/* sage answer preview — AI that's read your portfolio */}
      <div style={{ marginTop: 18, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 16, padding: 15, boxShadow: "4px 4px 0 var(--ink)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 8 }}>
          <span style={{ width: 24, height: 24, borderRadius: 7, background: "var(--pop-5)", border: "1.5px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={13} color="#1d1d1b" /></span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>STOCKSAGE · READ YOUR PORTFOLIO</span>
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.5, color: "var(--ink-2)" }}>Your IT exposure is <strong style={{ color: "var(--ink)" }}>42%</strong> — above the 25% you set. INFY + TCS alone are <strong style={{ color: "var(--ink)" }}>₹4.1L</strong> across 2 brokers.</div>
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          {["INFY", "TCS", "YOUR TRADEBOOK"].map(t => <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, padding: "3px 7px", borderRadius: 99, background: "var(--emerald-bg)", color: "var(--emerald-text)", border: "1px solid var(--emerald)" }}>{t}</span>)}
        </div>
      </div>

      {/* actually shipped sticker */}
      <div style={{ marginTop: 18 }}>
        <Sticker rotate={-2} style={{ display: "inline-block", fontSize: 14 }}><strong>actually shipped:</strong> AI chat · roast · strategies · backtest</Sticker>
      </div>

      <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {["✦ Read-only · we can't place orders", "✦ 5 free credits / month, forever", "✦ PRO ₹249/mo · 50% off"].map(t => (
          <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-2)", letterSpacing: 0.2 }}>{t}</span>
        ))}
      </div>
    </Screen>
  );
}

Object.assign(window, { SplashScreen, OnboardingScreen, WelcomeScreen });
