// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · first-run: connect broker → OAuth → sync → ready (+demo)
// ─────────────────────────────────────────────────────────────────────────
const { useState: frS, useEffect: frE } = React;

function ConnectIntroScreen({ go, um }) {
  const ALL = Object.keys(BROKER_META);
  return (
    <Screen topPad={64}
      footer={
        <div>
          <GhostBtn onClick={() => { um.setDemo(true); go("dashboard"); }}>Skip — explore with demo data</GhostBtn>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}><ClerkRow>Read-only OAuth · we can't place orders</ClerkRow></div>
        </div>
      }>
      <StepBar total={4} current={3} />
      <div style={{ marginTop: 18 }}>
        <Eyebrow>STEP 04 · LAST ONE</Eyebrow>
        <h1 style={{ fontWeight: 800, fontSize: 30, lineHeight: 1.05, letterSpacing: -1.4, margin: "12px 0 8px", color: "var(--ink)" }}>
          Connect your <span className="ser" style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>first broker.</span>
        </h1>
        <p style={{ margin: 0, fontSize: 14, color: "var(--ink-3)", lineHeight: 1.55 }}>Holdings, tradebook and positions sync in about a minute. Add more brokers any time.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 20 }}>
        {ALL.map((id, i) => (
          <Press key={id} onClick={() => go("oauth:" + id)}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 13, padding: "12px 12px", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
              <BrokerLogo id={id} size={30} rotate={i % 2 ? 2 : -2} />
              <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)", flex: 1 }}>{BROKER_META[id].name}</span>
              <Icon name="chevronR" size={13} color="var(--ink-4)" />
            </div>
          </Press>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
        <Sticker rotate={-3} style={{ fontSize: 13.5 }}>or <b>import a CSV</b> — no login needed</Sticker>
      </div>
      {um.usFlag && (
        <Press onClick={() => go("usfork")}>
          <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-3)", padding: "11px 13px", boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: "var(--pop-3)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 11, color: "#f7f3e6", transform: "rotate(-3deg)" }}>US</span>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>Invest in the US too?</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}>TWO QUESTIONS · SETS CURRENCY + CONNECT PATH</div></div>
            <Icon name="chevronR" size={15} color="var(--ink-3)" />
          </div>
        </Press>
      )}
    </Screen>
  );
}

// mock broker OAuth page → sync
function BrokerOAuthScreen({ go, back, param, um }) {
  const [id, ctx] = (param || "zerodha").split(":");
  const meta = BROKER_META[id] || BROKER_META.zerodha;
  const [busy, setBusy] = frS(false);
  const authorize = () => {
    setBusy(true);
    setTimeout(() => {
      um.connectBroker(id);
      if (ctx === "manage") { go("brokers", { replace: true }); um.toast(`${meta.name} connected — syncing`); }
      else go("firstsync:" + id, { replace: true });
    }, 1100);
  };
  return (
    <div className="um" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper)" }}>
      {/* faux browser bar */}
      <div style={{ padding: `${um.device === "android" ? 42 : 56}px 16px 10px`, background: meta.color, borderBottom: "2px solid var(--ink)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <button onClick={back} style={{ width: 30, height: 30, borderRadius: 8, border: "2px solid rgba(0,0,0,0.35)", background: "rgba(255,255,255,0.9)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="x" size={14} color="#1d1d1b" /></button>
          <div style={{ flex: 1, background: "rgba(255,255,255,0.92)", border: "2px solid rgba(0,0,0,0.35)", borderRadius: 99, padding: "6px 13px", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "#1d1d1b", display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="lock" size={11} color="#16a34a" /> connect.{id}.com/oauth
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "26px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BrokerLogo id={id} size={46} />
          <Icon name="arrowR" size={16} color="var(--ink-3)" />
          <BrandMark size={44} />
        </div>
        <h1 style={{ fontWeight: 800, fontSize: 24, letterSpacing: -1, margin: "18px 0 6px", color: "var(--ink)" }}>{meta.name} → UseMoney</h1>
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55 }}>UseMoney is asking for <b style={{ color: "var(--ink)" }}>read-only</b> access to this account.</p>
        <div style={{ marginTop: 18, border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", overflow: "hidden", boxShadow: "3px 3px 0 var(--ink)" }}>
          {[["check", "Read holdings & positions", true], ["check", "Read tradebook & ledger", true], ["x", "Place or modify orders", false], ["x", "Withdraw funds", false]].map(([ic, t, ok], i, arr) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: i < arr.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
              <span style={{ width: 22, height: 22, borderRadius: 7, border: "2px solid var(--ink)", background: ok ? "var(--emerald)" : "var(--pop-1)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                <Icon name={ic} size={11} color="#0b0b09" strokeWidth={3} />
              </span>
              <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", textDecoration: ok ? "none" : "line-through", opacity: ok ? 1 : 0.6 }}>{t}</span>
              <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, color: ok ? "var(--emerald-text)" : "var(--loss)" }}>{ok ? "ALLOWED" : "NEVER"}</span>
            </div>
          ))}
        </div>
        <p style={{ margin: "14px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", lineHeight: 1.6, letterSpacing: 0.3 }}>TOKENS ARE ENCRYPTED (AES-256-GCM) AND REVOCABLE ANY TIME FROM SETTINGS OR YOUR BROKER.</p>
      </div>
      <div style={{ flexShrink: 0, padding: "12px 22px calc(env(safe-area-inset-bottom) + 26px)", borderTop: "1.5px dashed var(--rule-soft)" }}>
        <PrimaryBtn onClick={authorize} disabled={busy} icon={busy ? null : "arrowR"}>{busy ? <span style={{ display: "inline-flex", gap: 9, alignItems: "center" }}><Spinner size={16} color="var(--paper)" /> Authorising…</span> : `Authorise — read-only`}</PrimaryBtn>
        <div style={{ marginTop: 10, textAlign: "center" }}>
          <button onClick={back} style={{ border: 0, background: "transparent", fontSize: 13, fontWeight: 700, color: "var(--ink-3)", cursor: "pointer", fontFamily: "var(--font-sans)" }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// first sync progress → ready
function FirstSyncScreen({ go, param, um }) {
  const id = (param || "zerodha").split(":")[0];
  const meta = BROKER_META[id] || BROKER_META.zerodha;
  const [step, setStep] = frS(0);
  const STEPS = [
    { t: "Handshake with " + meta.name, d: "read-only token stored encrypted" },
    { t: "Fetching holdings", d: "12 instruments found" },
    { t: "Importing tradebook", d: "214 trades · Apr 2025 → today" },
    { t: "FIFO pairing & reconciling", d: "42 pairs matched, 0 conflicts" },
    { t: "Computing P&L and XIRR", d: "XIRR 16.4% · day P&L live" },
  ];
  frE(() => {
    if (step >= STEPS.length) { const t = setTimeout(() => go("firstready", { replace: true }), 600); return () => clearTimeout(t); }
    const t = setTimeout(() => setStep(s => s + 1), step === 0 ? 800 : 1000);
    return () => clearTimeout(t);
  }, [step]);
  return (
    <Screen topPad={70}>
      <Eyebrow>FIRST SYNC · {meta.name.toUpperCase()}</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 28, lineHeight: 1.05, letterSpacing: -1.2, margin: "12px 0 20px", color: "var(--ink)" }}>
        Building your <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>reconciled book.</span>
      </h1>
      <ProgressSteps steps={STEPS} current={step} />
      <div style={{ display: "flex", justifyContent: "center", marginTop: 26 }}>
        <Sticker rotate={3} style={{ fontSize: 13.5 }}>read-only. <b>always.</b></Sticker>
      </div>
    </Screen>
  );
}

function FirstReadyScreen({ go, um }) {
  return (
    <Screen topPad={70} footer={<PrimaryBtn onClick={() => go("dashboard", { reset: true })}>Take me to my money</PrimaryBtn>}>
      <Eyebrow>PORTFOLIO READY</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 32, lineHeight: 1.04, letterSpacing: -1.5, margin: "12px 0 8px", color: "var(--ink)" }}>
        Every rupee, <mark style={{ background: "var(--pop-2)", color: "#1d1d1b", padding: "0 5px" }}>accounted for.</mark>
      </h1>
      <p style={{ margin: 0, fontSize: 14, color: "var(--ink-3)", lineHeight: 1.55 }}>Zerodha synced. Here's what we reconciled — add Groww or Upstox later for the full picture.</p>
      <div style={{ marginTop: 20, border: "2px solid var(--ink)", borderRadius: 16, background: "var(--ink)", color: "var(--paper)", padding: "16px 18px", boxShadow: "4px 4px 0 var(--emerald)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.2, opacity: 0.7 }}>TOTAL VALUE · 1 BROKER</div>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 32, letterSpacing: -1, margin: "6px 0 2px" }}>{money(PORTFOLIO.total)}</div>
        <div style={{ display: "flex", gap: 16, marginTop: 10, borderTop: "1.5px dashed rgba(247,243,230,0.25)", paddingTop: 10, fontFamily: "var(--font-mono)", fontSize: 11 }}>
          <span>12 HOLDINGS</span><span>214 TRADES</span><span style={{ color: "var(--emerald)" }}>42 PAIRS</span>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
        {[["flame", "Get roasted", "AI scores your book", "roast"], ["sparkles", "Ask Sage", "anything about it", "sage"]].map(([ic, t, d, k]) => (
          <Press key={k} onClick={() => go(k, { reset: true })}>
            <div style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 13px" }}>
              <Icon name={ic} size={19} color="var(--ink)" />
              <div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--ink)", marginTop: 7 }}>{t}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 2 }}>{d.toUpperCase()}</div>
            </div>
          </Press>
        ))}
      </div>
    </Screen>
  );
}

Object.assign(window, { ConnectIntroScreen, BrokerOAuthScreen, FirstSyncScreen, FirstReadyScreen });
