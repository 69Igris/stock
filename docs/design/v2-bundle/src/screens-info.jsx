// ─────────────────────────────────────────────────────────────────────────
// Public (pre-login) screens · part 2 — Broker-sync, Sage showcase, Pricing, Legal
// ─────────────────────────────────────────────────────────────────────────

// ── Broker-sync explainer ───────────────────────────────────────────────────
function BrokerScreen({ go, back }) {
  const brokers = ["zerodha", "groww", "upstox", "angel", "dhan", "fyers", "hdfc", "icici"];
  const steps = [
    { n: "01", t: "Pick your broker", d: "Choose from 8 supported Indian brokers — NSE & BSE." },
    { n: "02", t: "Authorise read-only", d: "Secure OAuth via the broker. You stay in control." },
    { n: "03", t: "We reconcile everything", d: "Holdings, trades & positions — FIFO-paired, unified." },
  ];
  return (
    <Screen onBack={back} topPad={60}
      footer={<PrimaryBtn onClick={() => go("signup")}>Create account to connect</PrimaryBtn>}>
      <Eyebrow>HOW IT WORKS · MULTI-BROKER SYNC</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 33, lineHeight: 1.02, letterSpacing: -1.4, marginTop: 12, color: "var(--ink)" }}>
        Connect every broker. <span className="ser">We can</span> <span className="hl-gold">never</span> place orders.
      </h1>

      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
        {brokers.map((b, k) => (
          <div key={b} style={{ aspectRatio: "1", borderRadius: 13, background: "var(--paper-3)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", boxShadow: "3px 3px 0 var(--ink)", padding: 9, transform: `rotate(${(k % 2 ? 1 : -1) * 1.5}deg)` }}>
            <img src={`assets/brokers/${b}.png`} alt={b} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, display: "flex", gap: 11, alignItems: "center", padding: 14, background: "var(--emerald-bg)", border: "2px solid var(--emerald)", borderRadius: 13 }}>
        <span style={{ width: 38, height: 38, borderRadius: 10, background: "var(--emerald)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="shieldCheck" size={20} color="#fff" /></span>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>Read-only OAuth · 256-bit AES-GCM</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>SEBI-aligned · Mumbai-region data centre</div>
        </div>
      </div>

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        {steps.map(s => (
          <div key={s.n} style={{ display: "flex", gap: 13, alignItems: "flex-start" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 14, color: "var(--paper)", background: "var(--ink)", borderRadius: 8, padding: "6px 9px", flexShrink: 0 }}>{s.n}</span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{s.t}</div>
              <div style={{ fontSize: 13.5, color: "var(--ink-2)", marginTop: 2, lineHeight: 1.45 }}>{s.d}</div>
            </div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

// ── StockSage showcase ──────────────────────────────────────────────────────
function SageScreen({ go, back }) {
  const feats = [
    { i: "sparkles", c: "var(--pop-5)", t: "Portfolio-aware", d: "Sage has read every holding across your brokers." },
    { i: "file", c: "var(--pop-3)", t: "Cited & auditable", d: "Every claim links to a source you can verify." },
    { i: "zap", c: "var(--pop-2)", t: "Free chat", d: "Deep research spends credits — simple chats are free." },
  ];
  return (
    <Screen onBack={back} topPad={60}
      footer={<PrimaryBtn onClick={() => go("signup")}>Ask Sage — free</PrimaryBtn>}>
      <Eyebrow color="var(--pop-5-text)">STOCKSAGE · AI RESEARCH</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 33, lineHeight: 1.02, letterSpacing: -1.4, marginTop: 12, color: "var(--ink)" }}>
        AI that's actually <span className="ser">read</span> your <span className="hl-gold">portfolio.</span>
      </h1>

      {/* chat mock */}
      <div style={{ marginTop: 20, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 16, padding: 14, boxShadow: "4px 4px 0 var(--ink)", display: "flex", flexDirection: "column", gap: 11 }}>
        <div style={{ alignSelf: "flex-end", maxWidth: "82%", background: "var(--ink)", color: "var(--paper)", padding: "10px 13px", borderRadius: "13px 13px 4px 13px", fontSize: 13.5 }}>Should I book profit on RELIANCE?</div>
        <div style={{ alignSelf: "flex-start", maxWidth: "94%" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: "var(--pop-5)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={13} color="#fff" /></span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>STOCKSAGE · GEMINI 2.5</span>
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>
            You hold <strong style={{ color: "var(--ink)" }}>48 sh</strong> at avg ₹2,410 — now <strong style={{ color: "var(--emerald-text)" }}>+22%</strong>. PE is 24.3×, above its 5-yr median. Booking half locks LTCG at <strong style={{ color: "var(--ink)" }}>10%</strong>.
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
            {["RELIANCE · NSE", "YOUR TRADEBOOK", "LTCG RULE"].map(t => <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, padding: "3px 7px", borderRadius: 99, background: "var(--paper)", color: "var(--ink-3)", border: "1.5px solid var(--rule-soft)" }}>{t}</span>)}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, padding: "9px 12px", border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper)" }}>
          <Icon name="search" size={15} color="var(--ink-3)" />
          <span style={{ fontSize: 13, color: "var(--ink-3)" }}>Ask anything about your money…</span>
          <span style={{ marginLeft: "auto", width: 26, height: 26, borderRadius: 7, background: "var(--ink)", display: "grid", placeItems: "center" }}><Icon name="send" size={13} color="var(--paper)" /></span>
        </div>
      </div>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 11 }}>
        {feats.map(f => (
          <div key={f.t} style={{ display: "flex", gap: 12, alignItems: "center", padding: 13, background: "var(--paper)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ width: 38, height: 38, borderRadius: 10, background: f.c, display: "grid", placeItems: "center", flexShrink: 0, border: "2px solid var(--ink)" }}><Icon name={f.i} size={19} color="#1d1d1b" /></span>
            <div>
              <div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)" }}>{f.t}</div>
              <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 1 }}>{f.d}</div>
            </div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

// ── Pricing ─────────────────────────────────────────────────────────────────
function PricingScreen({ go, back }) {
  const plans = [
    { name: "Free", price: "₹0", per: "forever", tag: "5 credits / mo", feats: ["Multi-broker sync", "Unified holdings", "Free Sage chat", "5 research credits"], accent: "var(--ink)", solid: false },
    { name: "PRO", price: "₹249", per: "/ month", tag: "Most popular", feats: ["Everything in Free", "100 credits / mo", "Portfolio Roast", "Paper trading & backtest", "FIRE calculator"], accent: "var(--pop-2)", solid: true },
    { name: "Premium", price: "₹1,499", per: "/ month", tag: "For power users", feats: ["Everything in PRO", "500 credits / mo", "Tax report (ITR-2)", "Risk report", "Priority Sage"], accent: "var(--pop-3)", solid: false },
    { name: "Ultimate", price: "₹4,999", per: "/ month", tag: "Unlimited", feats: ["Everything in Premium", "Unlimited credits", "Document vault", "Dedicated support"], accent: "var(--pop-5)", solid: false },
  ];
  return (
    <Screen onBack={back} topPad={60}
      footer={<PrimaryBtn onClick={() => go("signup")}>Start free — no card</PrimaryBtn>}>
      <Eyebrow>PRICING · FREE FOREVER PLAN</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 33, lineHeight: 1.02, letterSpacing: -1.4, marginTop: 12, color: "var(--ink)" }}>
        Start <span className="ser">free.</span> Upgrade <span className="hl-gold">only</span> when you want more.
      </h1>

      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
        {plans.map(p => (
          <div key={p.name} style={{
            position: "relative", borderRadius: 16, border: "2px solid var(--ink)", padding: 18,
            background: p.solid ? "var(--ink)" : "var(--paper-3)",
            color: p.solid ? "var(--paper)" : "var(--ink)",
            boxShadow: p.solid ? "5px 5px 0 var(--pop-2)" : "3px 3px 0 var(--ink)",
          }}>
            {p.solid && <span style={{ position: "absolute", top: -12, right: 16, padding: "4px 11px", background: "var(--pop-2)", color: "#1d1d1b", border: "2px solid var(--ink)", borderRadius: 99, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, letterSpacing: 0.8, transform: "rotate(3deg)" }}>★ POPULAR</span>}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontWeight: 800, fontSize: 19, letterSpacing: -0.5 }}>{p.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: p.solid ? "var(--pop-2)" : "var(--ink-3)", letterSpacing: 0.8, textTransform: "uppercase" }}>{p.tag}</span>
            </div>
            <div style={{ margintop: 6, display: "flex", alignItems: "baseline", gap: 6, marginTop: 6 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 32, letterSpacing: -1 }}>{p.price}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: p.solid ? "rgba(244,237,224,0.6)" : "var(--ink-3)" }}>{p.per}</span>
            </div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
              {p.feats.map(f => (
                <div key={f} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13.5 }}>
                  <Icon name="check" size={14} color={p.solid ? "var(--pop-2)" : "var(--emerald-text)"} strokeWidth={2.6} />
                  <span style={{ color: p.solid ? "var(--paper)" : "var(--ink-2)" }}>{f}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>
        Simple chats are free. Deep research costs 1–3 credits.<br />Cancel anytime · prices in ₹ incl. GST.
      </div>
    </Screen>
  );
}

// ── Legal / SEBI risk disclosure ────────────────────────────────────────────
function LegalScreen({ go, back }) {
  const points = [
    "UseMoney is a portfolio analytics & research workspace. We are not a SEBI-registered investment adviser and do not provide personalised investment advice.",
    "Investments in securities markets are subject to market risks. Read all related documents carefully before investing. Past performance is not indicative of future returns.",
    "Broker connections are strictly read-only via OAuth. UseMoney can never place, modify, or cancel orders on your behalf.",
    "StockSage outputs are AI-generated and may contain errors. Always verify with cited sources before acting. Nothing here is a recommendation to buy or sell.",
    "Your data is encrypted (256-bit AES-GCM) and stored in a Mumbai-region data centre, isolated per region.",
  ];
  return (
    <Screen onBack={back} topPad={60}
      footer={<GhostBtn icon={null} onClick={back}>I understand</GhostBtn>}>
      <Eyebrow color="var(--pop-1-text)" dot={true}>LEGAL · SEBI RISK DISCLOSURE</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 30, lineHeight: 1.04, letterSpacing: -1.2, marginTop: 12, color: "var(--ink)" }}>
        The honest <span className="ser">fine print.</span> No <span className="strike">jargon.</span>
      </h1>

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        {points.map((p, k) => (
          <div key={k} style={{ display: "flex", gap: 11, alignItems: "flex-start", padding: 13, background: "var(--paper-3)", border: "1.5px solid var(--rule-soft)", borderRadius: 12 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--pop-1-text)", flexShrink: 0, marginTop: 1 }}>{String(k + 1).padStart(2, "0")}</span>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-2)", margin: 0 }}>{p}</p>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 14, justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--emerald-text)" }}>
        <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>Privacy</span>
        <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>Terms</span>
        <span style={{ textDecoration: "underline", textUnderlineOffset: 2 }}>Refunds</span>
      </div>
      <div style={{ marginTop: 14, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)", letterSpacing: 1 }}>© 2026 DIS DIGITAL LLP · USEMONEY</div>
    </Screen>
  );
}

Object.assign(window, { BrokerScreen, SageScreen, PricingScreen, LegalScreen });
