// ─────────────────────────────────────────────────────────────────────────
// Module A · Strategy Lab — catalog → detail → backtest → results · builder
// ─────────────────────────────────────────────────────────────────────────
const { useState: maS, useEffect: maE } = React;

function DualChart({ a, b, h = 150, la = "STRATEGY", lb = "NIFTY" }) {
  const all = [...a, ...b], min = Math.min(...all), max = Math.max(...all), rng = max - min || 1, w = 720;
  const path = (s) => s.map((v, i) => `${i ? "L" : "M"}${(i / (s.length - 1) * w).toFixed(1)},${(h - 8 - (v - min) / rng * (h - 18)).toFixed(1)}`).join(" ");
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
        <path d={path(a) + ` L${w},${h} L0,${h} Z`} fill="var(--emerald)" opacity="0.12" />
        <path d={path(b)} fill="none" stroke="var(--ink-3)" strokeWidth="1.8" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <path d={path(a)} fill="none" stroke="var(--emerald)" strokeWidth="2.4" vectorEffect="non-scaling-stroke" />
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700 }}>
        <span style={{ color: "var(--emerald-text)" }}>— {la}</span><span style={{ color: "var(--ink-3)" }}>┄ {lb}</span>
      </div>
    </div>
  );
}

const RULES_EN = ["ENTRY — RSI(14) < 30 AND close above the 200-DMA", "FILTER — NIFTY 100 · 20-day avg volume > ₹2 Cr", "SIZING — equal weight · max 12 positions", "EXIT — RSI(14) > 55 OR +5% gain · stop at -3% · median hold 12 days"];
const RULES_DSL = `strategy "rsi-mean-rev" {\n  universe: NIFTY100 where avg_volume(20d) > 2cr\n  entry:  rsi(14) < 30 and close > sma(200)\n  exit:   rsi(14) > 55 or gain(5%) or stop(3%)\n  size:   equal_weight(max: 12)\n  costs:  brokerage + stt + slippage(5bps)\n}`;

// pf-sec-h style section header (matches current UI kit)
function WSecH({ n, h, ser, meta, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, margin: "24px 0 12px", ...style }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1.2, padding: "3px 7px", border: "1.5px solid var(--ink)", borderRadius: 5, background: "var(--paper)", transform: "rotate(-1.2deg)" }}>{n}</span>
      <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, letterSpacing: -0.4 }}>{h} {ser && <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{ser}</span>}</h3>
      <span style={{ flex: 1, height: 1.5, background: "var(--ink)", opacity: 0.14 }} />
      {meta && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 0.4 }}>{meta}</span>}
    </div>
  );
}
// dark ink stat band (matches current UI kit's backtest summary)
function StatBand({ stats, tilt = true }) {
  return (
    <div style={{ border: "2px solid var(--ink)", borderRadius: 14, padding: "20px 24px", background: "#1d1d1b", color: "#f7f3e6", boxShadow: "4px 4px 0 var(--ink)", transform: tilt ? "rotate(-0.4deg)" : "none" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${stats.length}, 1fr)`, gap: 20 }}>
        {stats.map(([l, v, c]) => (
          <div key={l}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 1.5, color: "rgba(244,237,224,0.55)", fontWeight: 700, whiteSpace: "nowrap" }}>{l}</div>
            <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 24, fontWeight: 800, color: c || "#f7f3e6", letterSpacing: -0.5, whiteSpace: "nowrap" }}>{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
// DSL codeblock (matches pf-codeblock)
function CodeBlock({ lines }) {
  return (
    <div style={{ background: "var(--paper-2)", border: "1.5px solid var(--rule-soft)", borderRadius: 10, padding: "13px 15px", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.85 }}>
      {lines.map(([k, v], i) => (
        <div key={i}>{k ? <><span style={{ color: "var(--emerald-text)", fontWeight: 800 }}>{k}</span><span style={{ color: "var(--ink-2)" }}> · {v}</span></> : <span style={{ color: "var(--ink-4)" }}>{v}</span>}</div>
      ))}
    </div>
  );
}
// pf-tbl style table
function PfTbl({ cols, children }) {
  return (
    <div style={{ border: "2px solid var(--ink)", borderRadius: 13, overflow: "hidden", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{cols.map((c, i) => <th key={i} style={{ padding: "10px 14px", paddingLeft: i === 0 ? 18 : 14, textAlign: c.r ? "right" : "left", fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", background: "var(--paper-2)", borderBottom: "2px solid var(--ink)", whiteSpace: "nowrap" }}>{c.l}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
const tdS = (extra) => ({ padding: "10px 14px", borderTop: "1.5px solid var(--rule-soft)", fontFamily: "var(--font-mono)", fontSize: 11.5, fontVariantNumeric: "tabular-nums", ...extra });

function ModuleA({ embedded }) {
  const [tab, setTab] = maS("catalog");
  const [theme, setTheme] = maS("All");
  const [sel, setSel] = maS(null);
  const [view, setView] = maS("detail"); // detail | config | running | results
  const [code, setCode] = maS(false);
  const [step, setStep] = maS(0);
  const [overfitOpen, setOverfitOpen] = maS(false);
  const [rules, setRules] = maS([["RSI(14)", "crosses below", "30"], ["Volume", ">", "3× 20d avg"]]);
  const [valid, setValid] = maS(null);
  const themes = ["All", "Trend", "Momentum", "Value", "Quality", "Mean-reversion", "Pattern", "Custom"];
  const list = STRATS.filter(s => theme === "All" || s.theme === theme);
  const RUN_STEPS = [{ t: "Loading NIFTY 200 universe", d: "2019-2026 · survivorship-bias free" }, { t: "Simulating 2,140 trades", d: "brokerage + STT + 5bps slippage included" }, { t: "Walk-forward validation", d: "5 train/test splits" }, { t: "Overfitting checks", d: "CPCV · deflated Sharpe · PBO" }];
  maE(() => {
    if (view !== "running") return;
    if (step >= RUN_STEPS.length) { const t = setTimeout(() => setView("results"), 400); return () => clearTimeout(t); }
    const t = setTimeout(() => setStep(s => s + 1), 800);
    return () => clearTimeout(t);
  }, [view, step]);

  const openStrat = (s) => { setSel(s); setView("detail"); };

  const body = (
    <React.Fragment>
      {!sel && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <WTabs value={tab} onChange={setTab} tabs={[{ k: "catalog", label: "Catalog" }, { k: "builder", label: "Build your own" }, { k: "mine", label: "My strategies", badge: "5" }]} />
            {tab === "catalog" && <div style={{ display: "flex", gap: 7 }}>{themes.map(t => <Chip key={t} active={theme === t} onClick={() => setTheme(t)}>{t}</Chip>)}</div>}
          </div>

          {tab === "catalog" && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 16, marginTop: 20 }}>
              {list.map((s, i) => (
                <Press key={s.id} onClick={() => openStrat(s)}>
                  <div style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "16px 17px", height: "100%" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      <span style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: SYM_COLORS[i % SYM_COLORS.length], display: "grid", placeItems: "center", transform: i % 2 ? "rotate(3deg)" : "rotate(-3deg)" }}><Icon name="zap" size={16} color="#1d1d1b" /></span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 800, fontSize: 15 }}>{s.name}</div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", letterSpacing: 0.6 }}>{s.theme.toUpperCase()} · {s.runs} RUNS</div>
                      </div>
                      <Lifecycle s={s.status} />
                    </div>
                    <p style={{ margin: "10px 0 0", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.5 }}>{s.desc}</p>
                    {s.cagr != null ? (
                      <div style={{ display: "flex", gap: 14, marginTop: 12, borderTop: "1.5px dashed var(--rule-soft)", paddingTop: 10, alignItems: "flex-end" }}>
                        <StatCell label="CAGR" value={s.cagr + "%"} color="var(--gain-text)" />
                        <StatCell label="Sharpe" value={s.sharpe} />
                        <StatCell label="Max DD" value={s.dd + "%"} color="var(--loss)" />
                        <StatCell label="Win" value={s.win + "%"} />
                        <span style={{ flex: 1, minWidth: 54 }}><LineChart series={s.curve} h={30} color="var(--emerald)" fill={false} strokeWidth={1.8} /></span>
                      </div>
                    ) : (
                      <div style={{ marginTop: 12, border: "2px dashed var(--rule-soft)", borderRadius: 10, padding: "10px 12px", display: "flex", alignItems: "center", gap: 9 }}>
                        <Icon name="info" size={14} color="var(--ink-3)" />
                        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 0.5 }}>NOT YET BACKTESTED — NO NUMBERS SHOWN UNTIL COMPUTED</span>
                      </div>
                    )}
                  </div>
                </Press>
              ))}
            </div>
          )}

          {tab === "builder" && (
            <div style={{ marginTop: 20 }}>
              {/* 4-step stepper — current-UI pattern */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", border: "2px solid var(--ink)", borderRadius: 12, overflow: "hidden", background: "var(--paper)", marginBottom: 20 }}>
                {[{ n: "01", l: "Universe", s: "NIFTY 100 · liquid", done: true }, { n: "02", l: "Entry rules", s: rules.length + " condition" + (rules.length === 1 ? "" : "s"), active: true }, { n: "03", l: "Exit & sizing", s: "trailing · equal wt" }, { n: "04", l: "Backtest", s: "FY19 – FY26" }].map((s, i) => (
                  <div key={s.n} style={{ padding: "13px 16px", borderRight: i < 3 ? "2px solid var(--ink)" : 0, background: s.active ? "var(--ink)" : s.done ? "color-mix(in oklab, var(--emerald) 18%, var(--paper))" : "var(--paper)", color: s.active ? "var(--paper)" : s.done ? "var(--emerald-text)" : "var(--ink-3)", display: "flex", alignItems: "center", gap: 11 }}>
                    <span style={{ width: 27, height: 27, borderRadius: 99, border: "1.5px solid currentColor", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, background: s.done ? "var(--emerald)" : "transparent", color: s.done ? "#0b0b09" : "inherit", borderColor: s.done ? "var(--emerald)" : "currentColor", flexShrink: 0 }}>{s.done ? "✓" : s.n}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: -0.2, whiteSpace: "nowrap" }}>{s.l}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, opacity: 0.75, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.s}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 18, alignItems: "start" }}>
              <div>
                <Card pad={18}>
                  <SecHead label="Entry conditions" style={{ margin: "0 0 10px" }} />
                  {rules.map((r, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 9 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--paper)", background: "var(--ink)", borderRadius: 6, padding: "3px 7px" }}>{i === 0 ? "IF" : "AND"}</span>
                      {r.map((v, j) => (
                        <span key={j} style={{ border: "2px solid var(--ink)", borderRadius: 9, background: "var(--paper)", padding: "8px 12px", fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 6 }}>{v}<Icon name="chevronD" size={10} color="var(--ink-3)" /></span>
                      ))}
                      <button onClick={() => { setRules(rules.filter((_, x) => x !== i)); setValid(null); }} style={{ marginLeft: "auto", border: 0, background: "transparent", cursor: "pointer" }}><Icon name="x" size={14} color="var(--ink-3)" /></button>
                    </div>
                  ))}
                  <button onClick={() => { setRules([...rules, ["SMA(50)", "crosses above", "SMA(200)"]]); setValid(null); }} style={{ border: "2px dashed var(--ink)", borderRadius: 9, background: "transparent", padding: "8px 14px", fontWeight: 800, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)", color: "var(--ink-2)" }}>+ Add condition</button>
                  <SecHead label="Exit · filters · sizing" style={{ margin: "18px 0 10px" }} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {["EXIT: RSI(14) > 55", "STOP: 8%", "TIME: 40 days", "FILTER: mcap > 10k Cr", "SIZE: equal · max 12"].map(c => (
                      <span key={c} style={{ border: "2px solid var(--ink)", borderRadius: 99, background: "var(--paper-2)", padding: "7px 13px", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700 }}>{c}</span>
                    ))}
                  </div>
                </Card>
                <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "center" }}>
                  <GhostBtn full={false} icon="check" onClick={() => setValid(rules.length >= 2 ? "ok" : "err")} style={{ padding: "11px 18px" }}>Validate</GhostBtn>
                  <PrimaryBtn full={false} disabled={valid !== "ok"} onClick={() => { setSel({ ...STRATS[0], name: "My draft strategy" }); setView("config"); }} style={{ padding: "12px 18px" }}>Backtest <CostChip n={1} style={{ marginLeft: 6 }} /></PrimaryBtn>
                  {valid === "ok" && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 800, color: "var(--gain-text)" }}>✓ VALID DSL — READY TO RUN</span>}
                  {valid === "err" && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 800, color: "var(--loss)" }}>✕ NEEDS ≥2 CONDITIONS — ONE-RULE STRATEGIES OVERFIT</span>}
                </div>
              </div>
              <Card pad={16} bg="var(--paper-2)" style={{ transform: "rotate(0.5deg)" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)" }}>LIVE PREVIEW</div>
                <div style={{ margin: "8px 0 10px", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14.5, lineHeight: 1.4 }}>"RSI dip on liquid NIFTY 100 names, out on recovery or -3%."</div>
                <CodeBlock lines={[[null, "// auto-generated DSL"], ["universe", "NIFTY_100 · vol(20d) > ₹2Cr"], ["entry", rules.map(r => r.join(" ")).join(" && ") || "—"], ["exit", "rsi(14) > 55 || stop(3%)"], ["size", "equal · max 12"]]} />
                <div style={{ marginTop: 12, padding: 12, background: "var(--rule-softer, rgba(0,0,0,0.05))", borderRadius: 9 }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1, color: "var(--ink-3)", fontWeight: 700 }}>EST. TRADES / YEAR</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 23, fontWeight: 800, marginTop: 3 }}>~{40 + rules.length * 12}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>BASED ON 7Y SAMPLE · UPDATES AS YOU EDIT</div>
                </div>
              </Card>
            </div>
            </div>
          )}

          {tab === "mine" && (
            <div style={{ marginTop: 20 }}>
              <ListCard>
                {STRATS.map((s, i) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "13px 18px", borderBottom: i < STRATS.length - 1 ? "1.5px solid var(--rule-soft)" : "none", cursor: "pointer" }} onClick={() => openStrat(s)}>
                    <b style={{ width: 220, fontSize: 13.5 }}>{s.name}</b>
                    <Lifecycle s={s.status} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", width: 130 }}>{s.runs} backtests</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, width: 110, color: s.cagr != null ? "var(--gain-text)" : "var(--ink-4)" }}>{s.cagr != null ? "CAGR " + s.cagr + "%" : "no data yet"}</span>
                    {s.overfit && <OverfitBadge level={s.overfit} onClick={(e) => { e.stopPropagation(); setOverfitOpen(true); }} />}
                    <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: s.status === "VALIDATED" ? "var(--emerald-text)" : "var(--ink-4)" }}>{s.status === "VALIDATED" ? "PROMOTE TO FORWARDRUN →" : ""}</span>
                  </div>
                ))}
              </ListCard>
              <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-4)", letterSpacing: 0.4 }}>LIFECYCLE: DRAFT → BACKTESTED → VALIDATED → FORWARD → RETIRED. FORWARDRUN NEVER PLACES REAL ORDERS.</p>
            </div>
          )}
        </>
      )}

      {sel && view === "detail" && (() => {
        const mySignals = SIGNALS_FEED.filter(s => s.strat === sel.name);
        const goSignals = () => window.dispatchEvent(new CustomEvent("um-strat-seg", { detail: "signals" }));
        const TRADELOG = [
          ["12 Mar 26", "OPEN", "HAL", "4,410", "—", "+1.7%", "—", "open"],
          ["08 Mar 26", "OPEN", "ASIANPAINT", "2,247", "—", "+0.9%", "—", "open"],
          ["14 Feb 26", "02 Mar 26", "HDFCBANK", "1,612", "1,694", "+5.1%", "+5% target", "up"],
          ["22 Dec 25", "30 Dec 25", "TATAMOTORS", "704", "683", "-3.0%", "Stop -3%", "dn"],
          ["14 Nov 25", "28 Nov 25", "SUNPHARMA", "1,604", "1,684", "+5.0%", "+5% target", "up"],
          ["02 Sep 25", "11 Sep 25", "ITC", "443", "462", "+4.2%", "RSI > 55", "up"],
        ];
        return (
        <div>
          <button onClick={() => setSel(null)} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--ink-2)", cursor: "pointer", padding: 0 }}>← BACK TO CATALOG</button>
          {/* header — current-UI pattern: pills · serif h1 · italic sub · action row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 20, alignItems: "center", padding: "14px 0 16px", borderBottom: "2px solid var(--ink)", marginBottom: 20 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <Lifecycle s={sel.status} />
                <Tag bg="var(--paper-2)">{sel.theme}</Tag>
                <Tag bg="var(--paper-2)">v{sel.runs || 1} · {sel.runs} runs</Tag>
                {sel.overfit && <OverfitBadge level={sel.overfit} onClick={() => setOverfitOpen(true)} />}
              </div>
              <h1 style={{ margin: 0, fontSize: 33, fontWeight: 800, letterSpacing: -1.4, lineHeight: 1.02 }}>{sel.name.split(" ").slice(0, -1).join(" ")} <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{sel.name.split(" ").slice(-1)[0]}</span></h1>
              <div style={{ marginTop: 8, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15.5, color: "var(--ink-3)" }}>{sel.desc}</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end", maxWidth: 300 }}>
              <GhostBtn full={false} style={{ padding: "9px 14px", fontSize: 12.5 }}>Clone</GhostBtn>
              <GhostBtn full={false} style={{ padding: "9px 14px", fontSize: 12.5 }} onClick={() => { setSel(null); setTab("builder"); }}>Edit</GhostBtn>
              <PrimaryBtn full={false} style={{ padding: "10px 16px", fontSize: 13 }} onClick={() => setView("config")}>Run backtest <CostChip n={1} style={{ marginLeft: 6, background: "#fbf8eb" }} /></PrimaryBtn>
              {(sel.status === "VALIDATED") && <GhostBtn full={false} accent="var(--emerald-text)" style={{ padding: "9px 14px", fontSize: 12.5 }} icon="trending" onClick={goSignals}>Promote to ForwardRun</GhostBtn>}
            </div>
          </div>
          {/* dark stat band or honesty state */}
          {sel.cagr != null ? (
            <StatBand stats={[["CAGR", sel.cagr + "%", "var(--pop-2)"], ["SHARPE", sel.sharpe], ["DEFLATED", sel.dsharpe], ["MAX DD", sel.dd + "%", "#ff8a8a"], ["WIN-RATE", sel.win + "%"], ["AVG HOLD", sel.hold]]} />
          ) : (
            <div style={{ border: "2px dashed var(--ink)", borderRadius: 13, padding: "16px 20px", display: "flex", alignItems: "center", gap: 12, background: "var(--paper-2)" }}>
              <Icon name="info" size={17} color="var(--ink-3)" />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 0.5 }}>NOT YET BACKTESTED — NO NUMBERS SHOWN UNTIL COMPUTED. RUN ONE (1 CREDIT).</span>
            </div>
          )}
          {/* equity + DSL */}
          <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 18, marginTop: 18, alignItems: "start" }}>
            <Card pad={18}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: "var(--ink-3)" }}>EQUITY CURVE vs NIFTY · LAST RUN</span>
                {sel.cagr != null ? (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, display: "flex", gap: 14 }}><span style={{ color: "var(--emerald-text)", fontWeight: 700 }}>● Strategy {Math.round((Math.pow(1 + sel.cagr / 100, 7) - 1) * 100) > 0 ? "+" : ""}{Math.round((Math.pow(1 + sel.cagr / 100, 7) - 1) * 100)}%</span><span style={{ color: "var(--ink-3)" }}>─ ─ NIFTY +82%</span></span>
                ) : (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-4)" }}>NO RUNS YET</span>
                )}
              </div>
              {sel.cagr != null ? <DualChart a={BT_RESULT.curve} b={BT_RESULT.bench} h={170} la="" lb="" /> : <div style={{ height: 120, display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-4)" }}>NO RUN YET — NOTHING TO DRAW</div>}
            </Card>
            <Card pad={18}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: "var(--ink-3)" }}>STRATEGY DSL</span>
                <Seg grow={false} size={10} value={code ? "code" : "en"} onChange={(k) => setCode(k === "code")} options={[{ k: "en", label: "English" }, { k: "code", label: "Code" }]} />
              </div>
              {!code ? (
                <div>
                  {RULES_EN.map((r, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: i ? "1.5px solid var(--rule-soft)" : "none", fontSize: 12.5 }}>
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, color: "var(--paper)", background: "var(--ink)", borderRadius: 5, padding: "2px 6px", height: "fit-content", transform: "rotate(-1deg)" }}>{String(i + 1).padStart(2, "0")}</span>
                      <span style={{ lineHeight: 1.5 }}><b>{r.split(" — ")[0]}</b> — {r.split(" — ")[1]}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <CodeBlock lines={[[null, "// auto-generated DSL"], ["universe", "NIFTY_100 · vol(20d) > ₹2Cr"], ["entry", "rsi(14) < 30 && close > sma(200)"], ["exit", "rsi(14) > 55 || gain(5%) || stop(3%)"], ["size", "equal · max 12 positions"], ["costs", "brokerage + stt + slip(5bps)"]]} />
              )}
              <GhostBtn style={{ marginTop: 12, padding: "9px 12px", fontSize: 12 }} icon="pen" onClick={() => { setSel(null); setTab("builder"); }}>Edit in builder</GhostBtn>
            </Card>
          </div>
          {/* trade log — current-UI table */}
          <WSecH n="TRADES" h="Backtest" ser="trade log." meta={sel.cagr != null ? "2,140 TRADES · FY19-FY26 · SHOWING 6" : "NO RUNS YET"} />
          {sel.cagr != null ? (
            <PfTbl cols={[{ l: "OPENED" }, { l: "CLOSED" }, { l: "SYMBOL" }, { l: "ENTRY", r: 1 }, { l: "EXIT", r: 1 }, { l: "P&L %", r: 1 }, { l: "REASON" }]}>
              {TRADELOG.map((r, i) => (
                <tr key={i}>
                  <td style={tdS({ paddingLeft: 18, color: "var(--ink-2)" })}>{r[0]}</td>
                  <td style={tdS({ color: r[7] === "open" ? "var(--emerald-text)" : "var(--ink-3)", fontWeight: r[7] === "open" ? 800 : 400 })}>{r[1]}</td>
                  <td style={tdS({ fontWeight: 800 })}>{r[2]}</td>
                  <td style={tdS({ textAlign: "right" })}>₹{r[3]}</td>
                  <td style={tdS({ textAlign: "right" })}>{r[4] === "—" ? "—" : "₹" + r[4]}</td>
                  <td style={tdS({ textAlign: "right", fontWeight: 800, color: r[7] === "dn" ? "var(--loss)" : "var(--gain-text)" })}>{r[5]}</td>
                  <td style={tdS()}>{r[6] === "—" ? <span style={{ color: "var(--ink-4)" }}>—</span> : <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, border: "1.5px solid var(--rule-soft)", borderRadius: 6, padding: "2px 7px", background: "var(--paper-2)" }}>{r[6]}</span>}</td>
                </tr>
              ))}
            </PfTbl>
          ) : (
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-4)" }}>THE TRADE LOG APPEARS AFTER THE FIRST BACKTEST.</div>
          )}
          {/* live section — signals + forwardrun scoped to THIS strategy */}
          <WSecH n="LIVE" h="This strategy," ser="live." meta={`${mySignals.length} SIGNAL${mySignals.length === 1 ? "" : "S"} · EOD SCAN 16:05 IST`} />
          {mySignals.length > 0 ? (
            <PfTbl cols={[{ l: "STATUS" }, { l: "SYMBOL" }, { l: "RULE THAT FIRED" }, { l: "WHEN", r: 1 }, { l: "AT PRICE", r: 1 }]}>
              {mySignals.map((s, i) => (
                <tr key={s.id} style={{ cursor: "pointer" }} onClick={goSignals}>
                  <td style={tdS({ paddingLeft: 18 })}><span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.6, background: s.status === "TRIGGERED" ? "var(--emerald)" : s.status === "NEW" ? "var(--pop-2)" : "var(--paper-2)", color: "#1d1d1b", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px" }}>{s.status}</span></td>
                  <td style={tdS({ fontWeight: 800 })}>{s.sym}</td>
                  <td style={tdS({ fontFamily: "var(--font-sans)", fontSize: 12.5 })}>{s.rule}</td>
                  <td style={tdS({ textAlign: "right", color: "var(--ink-3)" })}>{s.at}</td>
                  <td style={tdS({ textAlign: "right" })}>₹{inr(s.px)}</td>
                </tr>
              ))}
            </PfTbl>
          ) : (
            <div style={{ border: "2px dashed var(--ink)", borderRadius: 12, padding: "13px 16px", display: "flex", alignItems: "center", gap: 11, background: "var(--paper-2)" }}>
              <Icon name="bell" size={15} color="var(--ink-3)" />
              <span style={{ fontSize: 12.5, color: "var(--ink-2)", flex: 1 }}>No signal watch on this strategy yet — schedule an EOD scan and it reports here.</span>
              <GhostBtn full={false} style={{ padding: "8px 13px", fontSize: 12 }} onClick={goSignals}>Create watch</GhostBtn>
            </div>
          )}
          {sel.status === "FORWARD" && (
            <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 13, background: "var(--emerald)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 17px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1, color: "#0b0b09" }}>FORWARDRUN · SIM · SINCE MAY 12</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: "#0b0b09" }}>+24.2% <span style={{ fontSize: 10.5, opacity: 0.7 }}>vs NIFTY +11.1%</span></span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px", background: "#fbf8eb", color: "#1d1d1b" }}>INSIDE BACKTEST BAND · 16–29%</span>
              <button onClick={goSignals} style={{ marginLeft: "auto", border: "2px solid var(--ink)", borderRadius: 9, background: "#1d1d1b", color: "#f7f3e6", padding: "8px 14px", fontWeight: 800, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Open ForwardRun →</button>
            </div>
          )}
          <p style={{ margin: "14px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.3 }}>SIGNALS ARE OBSERVATIONS, FORWARDRUN IS SIMULATION — NO REAL ORDERS. HISTORICAL RESULTS INCLUDE COSTS AND ARE NOT INDICATIVE OF FUTURE RETURNS.</p>
        </div>
        );
      })()}

      {sel && view === "config" && (
        <div style={{ maxWidth: 640 }}>
          <button onClick={() => setView("detail")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--ink-2)", cursor: "pointer", padding: 0 }}>← {sel.name.toUpperCase()}</button>
          <h2 style={{ margin: "12px 0 4px", fontWeight: 800, fontSize: 24, letterSpacing: -0.9 }}>Backtest config</h2>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)" }}>Costs are always included — brokerage, STT, and 5bps slippage.</p>
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
            {[["Period", ["3Y", "5Y", "7Y (2019-26)", "Max"], 2], ["Universe", ["NIFTY 50", "NIFTY 200", "NIFTY 500", "Midcap 150"], 1], ["Cost preset", ["Discount broker", "Full service", "Zero (why?)"], 0]].map(([label, opts, def]) => (
              <div key={label}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", marginBottom: 7 }}>{label.toUpperCase()}</div>
                <div style={{ display: "flex", gap: 8 }}>{opts.map((o, i) => <Chip key={o} active={i === def}>{o}</Chip>)}</div>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
            <PrimaryBtn full={false} style={{ padding: "13px 22px" }} onClick={() => { setStep(0); setView("running"); }}>Run — 1 credit</PrimaryBtn>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>~40s · YOU HAVE 2 CREDITS</span>
          </div>
        </div>
      )}

      {sel && view === "running" && (
        <div style={{ maxWidth: 560 }}>
          <h2 style={{ fontWeight: 800, fontSize: 24, letterSpacing: -0.9, margin: "6px 0 18px" }}>Running <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{sel.name}…</span></h2>
          <ProgressSteps steps={RUN_STEPS} current={step} />
        </div>
      )}

      {sel && view === "results" && (
        <div>
          <button onClick={() => setView("detail")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--ink-2)", cursor: "pointer", padding: 0 }}>← {sel.name.toUpperCase()}</button>
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "12px 0 4px" }}>
            <h2 style={{ margin: 0, fontWeight: 800, fontSize: 26, letterSpacing: -1 }}>Results — <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{BT_RESULT.period}</span></h2>
            <OverfitBadge level={sel.overfit || "low"} onClick={() => setOverfitOpen(true)} />
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>{BT_RESULT.universe} · {inr(BT_RESULT.trades)} TRADES · COSTS INCLUDED</div>
          <div style={{ marginTop: 16 }}>
            <StatBand stats={[["CAGR", "18.4%", "var(--pop-2)"], ["SHARPE", "1.31"], ["DEFLATED", "0.92"], ["MAX DD", "-14.2%", "#ff8a8a"], ["WIN-RATE", "58%"], ["TRADES", "2,140"]]} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 18, marginTop: 16, alignItems: "start" }}>
            <div>
              <Card pad={16}>
                <SecHead label="Equity curve vs NIFTY (₹100 start)" style={{ margin: "0 0 8px" }} />
                <DualChart a={BT_RESULT.curve} b={BT_RESULT.bench} />
              </Card>
              <Card pad={16} style={{ marginTop: 14 }}>
                <SecHead label="Drawdown" style={{ margin: "0 0 8px" }} />
                <LineChart series={BT_RESULT.ddSeries} h={70} color="var(--pop-1)" />
              </Card>
              <Card pad={16} style={{ marginTop: 14 }}>
                <SecHead label="Walk-forward — train → unseen test" style={{ margin: "0 0 8px" }} />
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  {BT_RESULT.walk.map(([w, v]) => (
                    <div key={w} style={{ border: "2px solid var(--ink)", borderRadius: 10, padding: "9px 13px", background: w.includes("test") || w.includes("live") ? "var(--pop-2)" : "var(--paper-2)" }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.8, color: "var(--ink-2)" }}>{w.toUpperCase()}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, marginTop: 2 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
            <div>
              <KV rows={[["Turnover", "4.2×/yr"], ["Costs paid", "₹12,480"], ["Avg hold", "12d"], ["Best / worst trade", "+9.4% / -3.1%"]]} />
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                <PrimaryBtn onClick={() => setTab("mine") || setSel(null)}>Save to my strategies</PrimaryBtn>
                <GhostBtn icon="trending" onClick={() => { window.location.href = "Module C - Signals - ForwardRun.html"; }}>Promote to ForwardRun</GhostBtn>
              </div>
              <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", lineHeight: 1.7, letterSpacing: 0.3 }}>HISTORICAL SIMULATION INCLUDING COSTS — NOT INDICATIVE OF FUTURE RETURNS.</p>
            </div>
          </div>
        </div>
      )}

      <WModal open={overfitOpen} onClose={() => setOverfitOpen(false)} title="Overfitting risk — what we test">
        <p style={{ margin: "0 0 12px", fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-2)" }}>A strategy can look brilliant simply because it memorised the past. Before showing you numbers, we stress it three ways:</p>
        {[["Walk-forward", "Train on one period, test on a later unseen one. Profits must survive the jump."], ["CPCV", "Re-runs the test over many shuffled time-splits — a fluke wins once, not fifty times."], ["Deflated Sharpe", "Discounts the Sharpe ratio for how many strategy variations were tried. 0.92 of 1.31 survives here."]].map(([t, d]) => (
          <div key={t} style={{ display: "flex", gap: 10, padding: "9px 0", borderTop: "1.5px solid var(--rule-soft)" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, background: "var(--pop-2)", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "2px 8px", height: "fit-content" }}>{t}</span>
            <span style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--ink-2)" }}>{d}</span>
          </div>
        ))}
        <p style={{ margin: "12px 0 0", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13.5, color: "var(--ink-2)" }}>Green = passed all three. Amber = passed with caveats. Red = probably memorising — we say so.</p>
      </WModal>
    </React.Fragment>
  );
  if (embedded) return body;
  return (
    <WShell active="strategies" crumb="DISCOVER · STRATEGIES" title="Strategy Lab" ser="— tested, not vibes.">{body}</WShell>
  );
}
window.ModuleA = ModuleA;
