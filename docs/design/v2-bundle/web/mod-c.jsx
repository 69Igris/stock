// ─────────────────────────────────────────────────────────────────────────
// Module C · Signals & ForwardRun — feed, webhook setup, shadow portfolio
// ─────────────────────────────────────────────────────────────────────────
const { useState: mcS } = React;

const SIG_ST = { NEW: "var(--pop-2)", TRIGGERED: "var(--emerald)", EXPIRED: "var(--paper-2)" };

function ModuleC({ embedded }) {
  const [tab, setTab] = mcS("feed");
  const [sel, setSel] = mcS(null);
  const [ping, setPing] = mcS(null); // null | busy | ok
  const testPing = () => { setPing("busy"); setTimeout(() => setPing("ok"), 1300); };
  const st = STOCKS[sel ? sel.sym : "HAL"];

  const body = (
    <React.Fragment>
      <WTabs value={tab} onChange={(k) => { setTab(k); setSel(null); }} tabs={[{ k: "feed", label: "Signals feed", badge: "2" }, { k: "webhook", label: "TradingView webhook" }, { k: "fwd", label: "ForwardRun", badge: "SIM" }]} />

      {tab === "feed" && !sel && (
        <div style={{ marginTop: 20, maxWidth: 860 }}>
          {["RSI < 30 mean-reversion", "12-month momentum", "50/200 DMA crossover"].map(strat => {
            const rows = SIGNALS_FEED.filter(s => s.strat === strat);
            if (!rows.length) return null;
            return (
              <div key={strat} style={{ marginBottom: 18 }}>
                <SecHead label={strat} right={<Chip style={{ padding: "5px 11px", fontSize: 10.5 }}>⚙ Alerts: in-app + email</Chip>} style={{ marginTop: 0 }} />
                <ListCard>
                  {rows.map((s, i) => (
                    <div key={s.id} onClick={() => setSel(s)} style={{ display: "flex", alignItems: "center", gap: 13, padding: "12px 16px", borderBottom: i < rows.length - 1 ? "1.5px solid var(--rule-soft)" : "none", cursor: "pointer", opacity: s.status === "EXPIRED" ? 0.55 : 1 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.6, background: SIG_ST[s.status], color: "#1d1d1b", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px", width: 76, textAlign: "center" }}>{s.status}</span>
                      <SymTile sym={s.sym} size={32} />
                      <div style={{ flex: 1 }}>
                        <b style={{ fontSize: 13.5 }}>{s.sym} — {s.rule}</b>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 2 }}>{s.at.toUpperCase()} · @₹{inr(s.px)}</div>
                      </div>
                      <Icon name="chevronR" size={14} color="var(--ink-4)" />
                    </div>
                  ))}
                </ListCard>
              </div>
            );
          })}
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-4)", letterSpacing: 0.4 }}>SIGNALS ARE NOTIFICATIONS, NOT ORDERS. EXECUTION: COMING LATER.</p>
        </div>
      )}

      {tab === "feed" && sel && (
        <div style={{ marginTop: 20, maxWidth: 780 }}>
          <button onClick={() => setSel(null)} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--ink-2)", cursor: "pointer", padding: 0 }}>← ALL SIGNALS</button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "12px 0" }}>
            <SymTile sym={sel.sym} size={42} rotate={-2} />
            <div>
              <h2 style={{ margin: 0, fontWeight: 800, fontSize: 24, letterSpacing: -0.9 }}>{sel.sym} <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>signal detail</span></h2>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>{sel.strat.toUpperCase()} · {sel.at.toUpperCase()}</div>
            </div>
            <span style={{ marginLeft: "auto" }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, background: SIG_ST[sel.status], border: "2px solid var(--ink)", borderRadius: 7, padding: "4px 10px" }}>{sel.status}</span></span>
          </div>
          <Card pad={16}>
            <LineChart series={st.series["1M"]} h={130} color="var(--emerald)" baseline={sel.px} />
            <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 6 }}>
              <span>1M</span><span>┄ ENTRY MARKER ₹{inr(sel.px)}</span><span>LTP ₹{inr(st.ltp, 1)}</span>
            </div>
          </Card>
          <Card pad={16} style={{ marginTop: 14 }} bg="var(--paper-2)">
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)" }}>THE RULE THAT FIRED</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 800, marginTop: 6 }}>{sel.rule}</div>
            <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.5 }}>Values at trigger: RSI(14) = 34.2 · volume 2.8× 20-day avg · above 200 DMA. This is an observation from your strategy's rules — what you do with it is up to you.</div>
          </Card>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <GhostBtn full={false} icon="sparkles" style={{ padding: "11px 16px" }}>Ask Sage about {sel.sym}</GhostBtn>
            <GhostBtn full={false} icon="bell" style={{ padding: "11px 16px" }}>Alert config</GhostBtn>
          </div>
        </div>
      )}

      {tab === "webhook" && (
        <div style={{ marginTop: 20, maxWidth: 720 }}>
          <p style={{ margin: "0 0 14px", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>Pipe TradingView alerts into your signals feed. Paste this URL into a TradingView alert's webhook field — the HMAC secret keeps strangers out.</p>
          <Card pad={16}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)" }}>YOUR WEBHOOK URL</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ flex: 1, border: "2px solid var(--ink)", borderRadius: 9, background: "var(--paper-2)", padding: "10px 13px", fontFamily: "var(--font-mono)", fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>https://hooks.usemoney.ai/tv/u_4f2a…?sig=HMAC</span>
              <GhostBtn full={false} style={{ padding: "9px 15px", fontSize: 12.5 }}>Copy</GhostBtn>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", marginTop: 14 }}>HMAC SECRET</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ flex: 1, border: "2px solid var(--ink)", borderRadius: 9, background: "var(--paper-2)", padding: "10px 13px", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>whsec_ ••••••••••••••••</span>
              <GhostBtn full={false} style={{ padding: "9px 15px", fontSize: 12.5 }}>Reveal</GhostBtn>
              <GhostBtn full={false} style={{ padding: "9px 15px", fontSize: 12.5 }} icon="refresh">Rotate</GhostBtn>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, borderTop: "1.5px dashed var(--rule-soft)", paddingTop: 14 }}>
              <PrimaryBtn full={false} style={{ padding: "11px 18px", fontSize: 13.5 }} onClick={testPing} disabled={ping === "busy"}>{ping === "busy" ? <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}><Spinner size={14} color="var(--paper)" /> Pinging…</span> : "Send test ping"}</PrimaryBtn>
              {ping === "ok" && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--gain-text)" }}>✓ 200 OK · SIGNATURE VALID · 84MS</span>}
            </div>
          </Card>
          <SecHead label="Last 5 pings" />
          <ListCard>
            {[["09:12 IST", "alert: SUPERTREND BUY LT", "200"], ["Fri 15:24", "alert: RSI<30 ASIANPAINT", "200"], ["Fri 11:02", "bad signature", "401"], ["Thu 15:31", "alert: VWAP fade NIFTY", "200"], ["Thu 09:20", "test ping", "200"]].map(([t, m, c], i, arr) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "9px 16px", borderBottom: i < arr.length - 1 ? "1.5px solid var(--rule-soft)" : "none", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span style={{ color: "var(--ink-3)", width: 74 }}>{t}</span>
                <span style={{ flex: 1, color: "var(--ink-2)" }}>{m}</span>
                <span style={{ fontWeight: 800, color: c === "200" ? "var(--gain-text)" : "var(--loss)" }}>{c}</span>
              </div>
            ))}
          </ListCard>
        </div>
      )}

      {tab === "fwd" && (
        <div style={{ marginTop: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontWeight: 800, fontSize: 22, letterSpacing: -0.8 }}>{FWDRUN.strat} <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>— shadow portfolio</span></h2>
            <Lifecycle s="FORWARD" />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>SINCE {FWDRUN.since.toUpperCase()} · HYPOTHETICAL — NO REAL ORDERS WERE OR CAN BE PLACED</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 330px", gap: 18, marginTop: 16, alignItems: "start" }}>
            <div>
              <StatBand tilt={false} stats={[["SIM RETURN", "+24.2%", "var(--pop-2)"], ["NIFTY", "+11.1%"], ["BAND (1σ)", "16–29%"], ["TRADES", "4"], ["COSTS", "MODELLED"]]} />
              <Card pad={16} style={{ marginTop: 14 }}>
                <SecHead label="Hypothetical P&L vs NIFTY · ₹100 start" style={{ margin: "0 0 8px" }} />
                <DualChart a={FWDRUN.curve} b={FWDRUN.benchCurve} la="FORWARDRUN (SIM)" lb="NIFTY" h={140} />
              </Card>
              <SecHead label="Per-trade ledger — simulated fills incl. costs" />
              <ListCard>
                {FWDRUN.ledger.map((t, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: i < FWDRUN.ledger.length - 1 ? "1.5px solid var(--rule-soft)" : "none", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>
                    <b style={{ width: 90 }}>{t.sym}</b>
                    <span style={{ fontSize: 8.5, fontWeight: 800, background: "var(--emerald)", border: "1.5px solid var(--ink)", borderRadius: 5, padding: "2px 6px", color: "#0b0b09" }}>{t.side}</span>
                    <span style={{ color: "var(--ink-3)" }}>{t.qty} × ₹{t.in} → {t.out}</span>
                    {t.open && <span style={{ fontSize: 8.5, fontWeight: 800, background: "var(--pop-2)", border: "1.5px solid var(--ink)", borderRadius: 5, padding: "2px 6px" }}>OPEN</span>}
                    <span style={{ marginLeft: "auto", fontWeight: 800, color: t.pnl >= 0 ? "var(--gain-text)" : "var(--loss)" }}>{signMoney(t.pnl)}</span>
                  </div>
                ))}
              </ListCard>
            </div>
            <div>
              <KV rows={[["Started", FWDRUN.since], ["Divergence checks", "NIGHTLY"], ["Alerts", "IN-APP + EMAIL"], ["Execution", "COMING LATER"]]} />
              <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--emerald)", padding: "12px 15px", boxShadow: "3px 3px 0 var(--ink)" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 1, color: "#0b0b09" }}>DIVERGENCE FROM BACKTEST</div>
                <div style={{ fontWeight: 800, fontSize: 15, color: "#0b0b09", marginTop: 5 }}>Inside the band — behaving as tested.</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "#1d1d1b", marginTop: 4 }}>+24.2% VS EXPECTED 16–29%. AMBER OUTSIDE 1σ, RED BEYOND 2σ.</div>
              </div>
              <div style={{ marginTop: 12, border: "2px dashed var(--ink)", borderRadius: 12, padding: "12px 15px", opacity: 0.7 }}>
                <div style={{ fontWeight: 800, fontSize: 13.5, display: "flex", alignItems: "center", gap: 8 }}><Icon name="lock" size={14} /> Execute for real</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 4 }}>EXECUTION: COMING LATER. THIS SEAM IS INTENTIONAL.</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </React.Fragment>
  );
  if (embedded) return body;
  return (
    <WShell active="strategies" crumb="DISCOVER · STRATEGIES" title="Signals" ser="— rules that watch the tape for you.">{body}</WShell>
  );
}
window.ModuleC = ModuleC;
