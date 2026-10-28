// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · Portfolio: Holdings / Positions / Trades (+ CSV import)
// ─────────────────────────────────────────────────────────────────────────
const { useState: pfS, useEffect: pfE } = React;

function HoldingSheet({ h, go, um }) {
  const brokerRows = Object.entries(h.brokers);
  return (
    <div>
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <SymTile sym={h.sym} size={42} rotate={-2} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "var(--ink)" }}>{h.sym}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 1 }}>{h.name.toUpperCase()}</div>
        </div>
        <StarBtn on={um.watch.has(h.sym)} onClick={() => um.toggleWatch(h.sym)} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-3)", padding: "12px 14px", boxShadow: "3px 3px 0 var(--ink)" }}>
        <StatCell label="Value" value={money(h.val)} />
        <StatCell label="P&L" value={signMoney(h.pnl)} color={h.pnl >= 0 ? "var(--gain-text)" : "var(--loss)"} sub={pct(h.pnlPct)} align="center" />
        <StatCell label="Today" value={signMoney(h.dayPnl)} color={h.dayPnl >= 0 ? "var(--gain-text)" : "var(--loss)"} sub={pct(h.dayChg, 2)} align="right" />
      </div>
      <SecHead label={`Across brokers · ${brokerRows.length}`} style={{ margin: "16px 0 8px" }} />
      <ListCard>
        {brokerRows.map(([bid, qty], i) => (
          <RowItem key={bid} last={i === brokerRows.length - 1}
            left={<BrokerLogo id={bid} size={30} />}
            title={BROKER_META[bid].name} sub={`${qty} sh · avg ₹${inr(h.avg)}`}
            right={money(qty * h.ltp)} />
        ))}
      </ListCard>
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <PrimaryBtn style={{ flex: 1, padding: "13px 10px", fontSize: 14 }} onClick={() => { um.setSheet(null); go("stock:" + h.sym); }}>Open {h.sym}</PrimaryBtn>
        <GhostBtn full={false} icon="sparkles" style={{ flex: 1, padding: "12px 10px", fontSize: 13.5 }} onClick={() => { um.setSheet(null); um.setSagePrefill(`Tell me about my ${h.sym} position`); go("sage"); }}>Ask Sage</GhostBtn>
      </div>
    </div>
  );
}

function PairSheet({ t, go, um }) {
  const gross = (t.sell - t.buy) * t.qty;
  return (
    <div>
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <SymTile sym={t.sym} size={42} rotate={2} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "var(--ink)" }}>{t.sym} · {t.qty} sh</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 1 }}>FIFO PAIRED · {BROKER_META[t.broker].name.toUpperCase()}</div>
        </div>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, letterSpacing: 0.8, padding: "4px 9px", borderRadius: 7, border: "2px solid var(--ink)", background: t.term === "LT" ? "var(--emerald)" : "var(--pop-2)", color: "#0b0b09" }}>{t.term === "LT" ? "LONG TERM" : "SHORT TERM"}</span>
      </div>
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 8, alignItems: "center" }}>
        <div style={{ border: "2px solid var(--ink)", borderRadius: 11, padding: "10px 12px", background: "var(--paper-3)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, color: "var(--ink-3)" }}>BOUGHT · {t.bDate.toUpperCase()}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: "var(--ink)", marginTop: 3 }}>₹{inr(t.buy, 2)}</div>
        </div>
        <Icon name="arrowR" size={17} color="var(--ink-3)" />
        <div style={{ border: "2px solid var(--ink)", borderRadius: 11, padding: "10px 12px", background: "var(--paper-3)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, color: "var(--ink-3)" }}>SOLD · {t.sDate.toUpperCase()}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, color: "var(--ink)", marginTop: 3 }}>₹{inr(t.sell, 2)}</div>
        </div>
      </div>
      <div style={{ marginTop: 12, border: "1.5px dashed var(--rule-soft)", borderRadius: 11, padding: "11px 14px" }}>
        {[["Gross P&L", signMoney(gross)], ["Charges & taxes", "-" + money(t.charges)], ["Net P&L", signMoney(t.pnl)]].map(([l, v], i) => (
          <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: i === 2 ? 800 : 600, color: i === 2 ? (t.pnl >= 0 ? "var(--gain-text)" : "var(--loss)") : "var(--ink-2)", borderTop: i === 2 ? "1.5px solid var(--rule-soft)" : "none", marginTop: i === 2 ? 4 : 0, paddingTop: i === 2 ? 8 : 4 }}>
            <span>{l}</span><span>{v}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14 }}>
        <GhostBtn icon="sparkles" onClick={() => { um.setSheet(null); um.setSagePrefill(`What's the tax on my ${t.sym} trade?`); go("sage"); }}>Ask Sage about the tax</GhostBtn>
      </div>
    </div>
  );
}

function PortfolioScreenV2({ go, um, param }) {
  const [seg, setSeg] = pfS(param || "holdings");
  const [broker, setBroker] = pfS("all");
  const [sort, setSort] = pfS("val");
  const [termF, setTermF] = pfS("all");
  pfE(() => { if (param) setSeg(param); }, [param]);

  let rows = HOLDINGS.filter(h => broker === "all" || h.brokers[broker]);
  rows = [...rows].sort((a, b) => sort === "val" ? b.val - a.val : sort === "pnl" ? b.pnlPct - a.pnlPct : Math.abs(b.dayChg) - Math.abs(a.dayChg));
  const eqVal = rows.reduce((a, h) => a + h.val, 0);
  const mtm = POSITIONS.reduce((a, p) => a + p.mtm, 0);
  const trades = TRADES.filter(t => termF === "all" || t.term === termF.toUpperCase());
  const realized = TRADES.reduce((a, t) => a + t.pnl, 0);
  const SORT_LABEL = { val: "BY VALUE", pnl: "BY P&L", day: "BY TODAY" };

  return (
    <PullRefresh onRefresh={(done) => um.refresh(done)}>
      <div style={{ padding: "0 18px 28px" }}>
        <PageHead eyebrow={um.usFlag ? "Portfolio · 3 brokers + 3 US accounts" : "Portfolio · 3 brokers · live"} title="Your" ser="reconciled book."
          right={<SyncPill state={um.brokers.some(b => b.state !== "connected") ? "err" : "ok"} onClick={() => go("brokers")} />} />
        <Card pad={14} style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <StatCell label="Current" value={money(PORTFOLIO.total)} />
            <StatCell label="Today" value={signMoney(PORTFOLIO.dayPnl)} color={"var(--gain-text)"} sub={pct(PORTFOLIO.dayPct, 2)} align="center" />
            <StatCell label="Overall" value={signMoney(PORTFOLIO.pnl)} color={"var(--gain-text)"} sub={pct(PORTFOLIO.pnlPct)} align="right" />
          </div>
        </Card>
        <div style={{ marginTop: 14 }}>
          <Seg value={seg} onChange={(k) => setSeg(k)} options={[{ k: "holdings", label: "Holdings" }, { k: "positions", label: "Positions" }, { k: "trades", label: "Trades" }]} />
        </div>

        {seg === "holdings" && (
          <>
            {um.usFlag && (
              <Press onClick={() => go("usportfolio")}>
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-3)", padding: "11px 13px", boxShadow: "3px 3px 0 var(--ink)" }}>
                  <span style={{ width: 10, height: 30, borderRadius: 4, background: "var(--pop-3)", border: "1.5px solid var(--ink)", flexShrink: 0 }} />
                  <div style={{ flex: 1 }}><div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>United States · 4 symbols · {window.usPair ? window.usPair(window.US_BOOK || 0, (window.__umUS || {}).persona || "nri")[0] : "$58,640"}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}>◷ EOD JUL 18 · SPOT ₹84.00/$ · VIEW BOTH MARKETS</div></div>
                  <Icon name="chevronR" size={15} color="var(--ink-3)" />
                </div>
              </Press>
            )}
            <div style={{ display: "flex", gap: 7, marginTop: 12, overflowX: "auto", paddingBottom: 4 }}>
              <Chip active={broker === "all"} onClick={() => setBroker("all")}>All brokers</Chip>
              {um.brokers.map(b => <Chip key={b.id} active={broker === b.id} onClick={() => setBroker(b.id)}>{BROKER_META[b.id].name}</Chip>)}
              <Chip onClick={() => setSort(s => s === "val" ? "pnl" : s === "pnl" ? "day" : "val")} style={{ marginLeft: "auto" }}>⇅ {SORT_LABEL[sort]}</Chip>
            </div>
            <SecHead label={um.usFlag ? `India equity · ${rows.length}` : `Equity · ${rows.length}`} right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-2)" }}>{compactINR(eqVal)}</span>} />
            <ListCard>
              {rows.map((h, i) => (
                <RowItem key={h.sym} last={i === rows.length - 1} onClick={() => um.setSheet({ title: null, body: <HoldingSheet h={h} go={go} um={um} /> })}
                  left={<SymTile sym={h.sym} size={38} rotate={i % 3 === 0 ? -2 : i % 3 === 1 ? 2 : 0} />}
                  title={h.sym} sub={`${h.qty} @ ₹${inr(h.avg)}${broker !== "all" ? ` · ${h.brokers[broker]} here` : ""}`}
                  right={money(h.val)}
                  rightSub={<span style={{ display: "inline-flex", gap: 6 }}><Num v={h.pnlPct} fmt="pct" size={10.5} /><span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-4)" }}>·</span><Num v={h.dayChg} fmt="pct" size={10.5} /></span>} />
              ))}
            </ListCard>
            <SecHead label={`Mutual funds · ${MF_HELD.length}`} right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-2)" }}>{compactINR(PORTFOLIO.mf)}</span>} />
            <ListCard>
              {MF_HELD.map((f, i) => (
                <RowItem key={f.id} last={i === MF_HELD.length - 1} onClick={() => go("mf:" + f.id)}
                  left={<span style={{ width: 38, height: 38, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--pop-5)", display: "grid", placeItems: "center", flexShrink: 0, transform: i % 2 ? "rotate(2deg)" : "rotate(-2deg)" }}><Icon name="pie" size={17} color="#1d1d1b" /></span>}
                  title={f.name} sub={f.held.sip ? `SIP ₹${inr(f.held.sip)}/mo · NAV ₹${inr(f.nav, 2)}` : `NAV ₹${inr(f.nav, 2)}`}
                  right={money(f.val)} rightSub={<Num v={f.pnlPct} fmt="pct" size={10.5} />} />
              ))}
            </ListCard>
            <div style={{ marginTop: 14 }}>
              <GhostBtn icon="upload" onClick={() => go("import")}>Import trades (CSV)</GhostBtn>
            </div>
          </>
        )}

        {seg === "positions" && (
          <>
            <Card pad={14} style={{ marginTop: 14 }} bg="var(--ink)" shadow="3px 3px 0 var(--emerald)">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.2, color: "var(--paper)", opacity: 0.7 }}>MTM · {POSITIONS.length} OPEN</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: mtm >= 0 ? "var(--emerald)" : "var(--pop-1)" }}>{signMoney(mtm)}</span>
              </div>
            </Card>
            <SecHead label="Open positions" />
            <ListCard>
              {POSITIONS.map((p, i) => (
                <div key={p.id} style={{ padding: "12px 14px", borderBottom: i < POSITIONS.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, padding: "3px 7px", borderRadius: 6, border: "2px solid var(--ink)", background: p.side === "BUY" ? "var(--emerald)" : "var(--pop-1)", color: "#0b0b09" }}>{p.side}</span>
                    <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.sym}</span>
                    <Num v={p.mtm} size={13} />
                  </div>
                  <div style={{ display: "flex", gap: 14, marginTop: 7, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>
                    <span>QTY {p.qty}</span><span>AVG {inr(p.avg, 1)}</span><span>LTP {inr(p.ltp, 1)}</span>
                    <span style={{ marginLeft: "auto" }}>{BROKER_META[p.broker].name.toUpperCase()} · {p.product}</span>
                  </div>
                </div>
              ))}
            </ListCard>
            <p style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.4, lineHeight: 1.6 }}>READ-ONLY MIRROR OF YOUR BROKER TERMINALS. USEMONEY NEVER PLACES ORDERS.</p>
          </>
        )}

        {seg === "trades" && (
          <>
            <Card pad={14} style={{ marginTop: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <StatCell label="Realized FY27" value={signMoney(realized)} color="var(--gain-text)" />
                <StatCell label="Pairs" value={TRADES.length} align="center" />
                <StatCell label="Win rate" value="75%" sub="6 of 8" align="right" />
              </div>
            </Card>
            <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
              <Chip active={termF === "all"} onClick={() => setTermF("all")}>All</Chip>
              <Chip active={termF === "st"} onClick={() => setTermF("st")}>Short-term</Chip>
              <Chip active={termF === "lt"} onClick={() => setTermF("lt")}>Long-term</Chip>
              <Chip onClick={() => go("import")} style={{ marginLeft: "auto" }}>↑ Import</Chip>
            </div>
            <SecHead label={`FIFO pairs · ${trades.length}`} right={<button onClick={() => go("tax")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>TAX REPORT →</button>} />
            <ListCard>
              {trades.map((t, i) => (
                <RowItem key={t.id} last={i === trades.length - 1} onClick={() => um.setSheet({ title: null, body: <PairSheet t={t} go={go} um={um} /> })}
                  left={<SymTile sym={t.sym} size={36} />}
                  title={`${t.sym} · ${t.qty} sh`} sub={`${t.bDate.slice(3)} → ${t.sDate}`}
                  right={signMoney(t.pnl)}
                  rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 0.6, color: t.term === "LT" ? "var(--gain-text)" : "var(--ink-3)" }}>{t.term === "LT" ? "LTCG" : "STCG"}</span>} />
              ))}
            </ListCard>
            {um.usFlag && (
              <>
                <SecHead label="US lots · imported & linked" right={<Tag>RBI REF ON TRADE</Tag>} />
                <ListCard>
                  {[["AAPL", "4.28 sh", "18 Apr 26 · $204.11 · ₹83.10", "Vested"], ["NVDA", "6 sh", "02 Apr 26 · $168.42 · ₹83.42", "Vested"], ["MSFT", "31 sh", "12 Mar 26 · $362.40 · ₹83.66", "Fidelity"]].map(([s, q, d, src], i) => (
                    <RowItem key={s} last={i === 2} onClick={() => go("usstock:" + s)} left={<SymTile sym={s} size={36} />} title={`${s} · ${q}`} sub={d} right={<Tag>{src}</Tag>} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 0.6, color: "var(--ink-3)" }}>OPEN LOT</span>} />
                  ))}
                </ListCard>
                <div style={{ marginTop: 8, fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5 }}>US lots land in the same ledger. ₹ cost basis is frozen at the RBI reference rate of the trade date; US gains are not computed for Indian tax yet.</div>
              </>
            )}
          </>
        )}
      </div>
    </PullRefresh>
  );
}

// ── CSV import wizard ───────────────────────────────────────────────────────
function ImportScreenV2({ go, back, um }) {
  const [step, setStep] = pfS(0);
  const [picked, setPicked] = pfS(null);
  const [file, setFile] = pfS(false);
  const P = IMPORT_PREVIEW;
  const BROKER_TPL = ["zerodha", "groww", "upstox", "angel"];
  return (
    <SubPage um={um} title="Import trades" onBack={step === 0 ? back : () => setStep(s => s - 1)}
      footer={
        step === 0 ? <PrimaryBtn disabled={!file} onClick={() => setStep(1)}>Preview mapping</PrimaryBtn>
          : step === 1 ? <PrimaryBtn onClick={() => setStep(2)}>Looks right — import</PrimaryBtn>
            : <PrimaryBtn onClick={() => { um.toast("206 trades imported · 42 pairs matched"); go("portfolio:trades", { replace: true }); }}>Done</PrimaryBtn>
      }>
      <div style={{ paddingTop: 16 }}>
        <StepBar total={3} current={step} />
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", marginTop: 10 }}>STEP {step + 1} / 3 — {["UPLOAD", "MAP COLUMNS", "REVIEW"][step]}</div>

        {step === 0 && (
          <>
            <h2 style={{ fontWeight: 800, fontSize: 22, letterSpacing: -0.8, margin: "10px 0 4px", color: "var(--ink)" }}>Broker CSV or contract notes.</h2>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55 }}>We detect the format, dedupe against synced trades, and FIFO-pair everything.</p>
            <SecHead label="Format" right={um.usFlag ? <Chip onClick={() => go("usimport")} style={{ padding: "5px 10px", fontSize: 10.5 }}>US statement →</Chip> : null} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
              {BROKER_TPL.map(b => (
                <Press key={b} onClick={() => setPicked(b)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, border: "2px solid var(--ink)", borderRadius: 12, padding: "11px 12px", background: picked === b ? "var(--pop-2)" : "var(--paper-3)", boxShadow: picked === b ? "none" : "2px 2px 0 var(--ink)" }}>
                    <BrokerLogo id={b} size={26} />
                    <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>{BROKER_META[b].name}</span>
                  </div>
                </Press>
              ))}
            </div>
            <SecHead label="File" />
            <Press onClick={() => { setFile(true); if (!picked) setPicked("zerodha"); }}>
              <div style={{ border: "2px dashed var(--ink)", borderRadius: 14, padding: "26px 16px", textAlign: "center", background: file ? "var(--paper-3)" : "var(--paper-2)" }}>
                {file ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "center" }}>
                    <span style={{ width: 34, height: 34, borderRadius: 9, background: "var(--emerald)", border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name="check" size={16} color="#0b0b09" strokeWidth={3} /></span>
                    <div style={{ textAlign: "left" }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, color: "var(--ink)" }}>{P.file}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>{P.rows} ROWS · 24 KB</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <Icon name="upload" size={22} color="var(--ink-2)" />
                    <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)", marginTop: 8 }}>Tap to choose a file</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 4 }}>CSV · XLSX · CONTRACT-NOTE PDF</div>
                  </>
                )}
              </div>
            </Press>
          </>
        )}

        {step === 1 && (
          <>
            <h2 style={{ fontWeight: 800, fontSize: 22, letterSpacing: -0.8, margin: "10px 0 4px", color: "var(--ink)" }}>We read it like this.</h2>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)", lineHeight: 1.55 }}>Zerodha tradebook detected — all 6 columns mapped automatically.</p>
            <SecHead label="Column mapping" />
            <ListCard>
              {Object.entries(P.mapped).map(([c, m], i, arr) => (
                <div key={c} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", borderBottom: i < arr.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--ink-3)", flex: 1 }}>{c}</span>
                  <Icon name="arrowR" size={13} color="var(--ink-4)" />
                  <span style={{ flex: 1, textAlign: "right", fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>{m} <Icon name="check" size={11} color="var(--emerald-text)" strokeWidth={3} style={{ marginLeft: 3 }} /></span>
                </div>
              ))}
            </ListCard>
            <SecHead label="First rows" />
            <div style={{ border: "2px solid var(--ink)", borderRadius: 12, overflow: "hidden", background: "var(--paper-3)" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 9.5, width: "100%" }}>
                  <thead><tr>{P.cols.map(c => <th key={c} style={{ padding: "7px 9px", background: "var(--ink)", color: "var(--paper)", textAlign: "left", fontWeight: 700, whiteSpace: "nowrap" }}>{c}</th>)}</tr></thead>
                  <tbody>{P.sample.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={{ padding: "7px 9px", borderTop: "1.5px solid var(--rule-soft)", color: "var(--ink-2)", whiteSpace: "nowrap" }}>{v}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 style={{ fontWeight: 800, fontSize: 22, letterSpacing: -0.8, margin: "10px 0 4px", color: "var(--ink)" }}>Clean import, <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>zero double-counting.</span></h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
              {[["Imported", P.result.imported, "var(--emerald)"], ["Duplicates skipped", P.result.dupes, "var(--pop-2)"], ["FIFO pairs matched", P.result.pairs, "var(--pop-5)"], ["Span", P.result.span, "var(--pop-3)"]].map(([l, v, c]) => (
                <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 12, padding: "12px 13px", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
                  <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: c, border: "1.5px solid var(--ink)" }} />
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: String(v).length > 8 ? 11 : 19, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>{v}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 0.8, color: "var(--ink-3)", marginTop: 2, textTransform: "uppercase" }}>{l}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 16, display: "flex", justifyContent: "center" }}>
              <Sticker rotate={3}>dupes caught: <b>8</b> — your P&L stays honest.</Sticker>
            </div>
          </>
        )}
      </div>
    </SubPage>
  );
}

Object.assign(window, { PortfolioScreenV2, ImportScreenV2, HoldingSheet, PairSheet });
