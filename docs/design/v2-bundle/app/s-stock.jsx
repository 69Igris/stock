// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · instrument pages: Stock detail, MF detail, Compare
// ─────────────────────────────────────────────────────────────────────────
const { useState: stS } = React;

const RANGES = ["1D", "1W", "1M", "1Y", "5Y"];

function FundGrid({ st }) {
  const cells = [["P/E", st.pe + "×"], ["P/B", st.pb + "×"], ["ROE", st.roe + "%"], ["D/E", st.de], ["Div yield", st.divy + "%"], ["EPS (TTM)", "₹" + st.eps], ["Beta", st.beta], ["Mkt cap", st.mcap]];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginTop: 12 }}>
      {cells.map(([l, v]) => (
        <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 11, padding: "10px 12px", background: "var(--paper-3)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 0.8, color: "var(--ink-3)", textTransform: "uppercase" }}>{l}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13.5, fontWeight: 800, color: "var(--ink)" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

function StockScreenV2({ go, back, param, um }) {
  const sym = (param || "RELIANCE").toUpperCase();
  const st = STOCKS[sym] || STOCKS.RELIANCE;
  const [range, setRange] = stS("1D");
  const [tab, setTab] = stS("overview");
  const held = HOLDINGS.find(h => h.sym === st.sym);
  const series = st.series[range];
  const rangeChg = (series[series.length - 1] - series[0]) / series[0] * 100;
  const up = rangeChg >= 0;
  const myTrades = TRADES.filter(t => t.sym === st.sym);
  const news = NEWS.filter(n => n.sym === st.sym);
  const events = EVENTS.filter(e => e.sym === st.sym);
  const pos52 = Math.min(Math.max((st.ltp - st.wk52l) / (st.wk52h - st.wk52l), 0), 1);
  const qtr = genSeries(st.sym.length * 7, 6, 0.04, 0.06, 100);

  return (
    <SubPage um={um} title={st.sym} mono onBack={back}
      right={<div style={{ display: "flex", gap: 8 }}>
        <StarBtn on={um.watch.has(st.sym)} onClick={() => { um.toggleWatch(st.sym); um.toast(um.watch.has(st.sym) ? "Removed from watchlist" : "Added to Core watch"); }} />
        <button onClick={() => go("compare:" + st.sym)} style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}><Icon name="scale" size={16} color="var(--ink)" /></button>
      </div>}
      footer={
        <div style={{ display: "flex", gap: 8 }}>
          <PrimaryBtn style={{ flex: 1.3, padding: "13px 10px", fontSize: 14 }} icon="sparkles" onClick={() => { um.setSagePrefill(`Tell me about ${held ? "my position in " : ""}${st.sym}`); go("sage"); }}>Ask Sage</PrimaryBtn>
          <GhostBtn full={false} style={{ flex: 1, padding: "12px 8px", fontSize: 13 }} onClick={() => { um.setSagePrefill(`Run deep research on ${st.sym}`); go("sage"); }}>Research <CostChip n={2} style={{ marginLeft: 2 }} /></GhostBtn>
        </div>
      }>
      <div style={{ paddingTop: 14 }}>
        {/* header */}
        <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
          <SymTile sym={st.sym} size={44} rotate={-2} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: -0.4, color: "var(--ink)" }}>{st.name}</div>
            <div style={{ display: "flex", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
              <Tag>NSE</Tag><Tag>{st.sector}</Tag>{held && <Tag color="var(--emerald-text)" bg="var(--paper-2)">● You hold {held.qty}</Tag>}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 14 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 32, letterSpacing: -1, color: "var(--ink)" }}>₹{inr(st.ltp, 2)}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, padding: "3px 9px", borderRadius: 7, border: "2px solid var(--ink)", background: st.chg >= 0 ? "var(--emerald)" : "var(--pop-1)", color: "#0b0b09" }}>{pct(st.chg, 2)}</span>
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 4, letterSpacing: 0.5 }}>LIVE · 09:42 AM IST · {range} {pct(rangeChg, 1)}</div>

        {/* chart */}
        <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "14px 10px 8px" }}>
          <LineChart series={series} h={110} color={up ? "var(--emerald)" : "var(--pop-1)"} baseline={range === "1D" ? series[0] : null} />
          <div style={{ display: "flex", gap: 5, padding: "10px 4px 4px" }}>
            {RANGES.map(r => (
              <button key={r} onClick={() => setRange(r)} style={{ flex: 1, padding: "6px 0", borderRadius: 8, border: "2px solid " + (range === r ? "var(--ink)" : "transparent"), background: range === r ? "var(--pop-2)" : "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 800, color: "var(--ink)", cursor: "pointer" }}>{r}</button>
            ))}
          </div>
        </div>

        {/* OHLC + 52wk */}
        <div style={{ display: "flex", gap: 14, marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-2)", fontWeight: 700 }}>
          <span>O {inr(st.o)}</span><span>H {inr(st.h)}</span><span>L {inr(st.l)}</span>
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ position: "relative", height: 8, borderRadius: 99, border: "1.5px solid var(--ink)", background: "linear-gradient(90deg, var(--pop-1), var(--pop-2), var(--emerald))" }}>
            <span style={{ position: "absolute", left: `calc(${(pos52 * 100).toFixed(0)}% - 7px)`, top: -5, width: 14, height: 14, borderRadius: 99, background: "var(--paper)", border: "2.5px solid var(--ink)" }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>
            <span>52W LOW ₹{inr(st.wk52l)}</span><span>52W HIGH ₹{inr(st.wk52h)}</span>
          </div>
        </div>

        {/* your position */}
        {held && (
          <>
            <SecHead label="Your position" right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>{Object.keys(held.brokers).length} BROKERS</span>} />
            <Card pad={14} bg="var(--paper-2)">
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <StatCell label="Qty · Avg" value={`${held.qty} @ ₹${inr(held.avg)}`} />
                <StatCell label="Value" value={money(held.val)} align="center" />
                <StatCell label="P&L" value={signMoney(held.pnl)} color={held.pnl >= 0 ? "var(--gain-text)" : "var(--loss)"} sub={pct(held.pnlPct)} align="right" />
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
                {Object.entries(held.brokers).map(([b, q]) => (
                  <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1.5px solid var(--rule-soft)", borderRadius: 99, padding: "4px 10px 4px 5px", background: "var(--paper-3)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-2)" }}>
                    <BrokerLogo id={b} size={20} />{q} SH
                  </span>
                ))}
                <button onClick={() => um.setSheet({ title: null, body: <HoldingSheet h={held} go={go} um={um} /> })} style={{ marginLeft: "auto", border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>DETAIL →</button>
              </div>
            </Card>
          </>
        )}

        {/* tabs */}
        <div style={{ marginTop: 18 }}>
          <Seg value={tab} onChange={setTab} size={11.5} options={[{ k: "overview", label: "Overview" }, { k: "fin", label: "Financials" }, { k: "news", label: "News" }, { k: "trades", label: "My trades" }]} />
        </div>

        {tab === "overview" && (
          <>
            <p style={{ margin: "14px 0 0", fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-2)" }}>{st.about}</p>
            <FundGrid st={st} />
            <Press onClick={() => { um.setSagePrefill(`Is ${st.sym} expensive at ${st.pe}× PE?`); go("sage"); }}>
              <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 9, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--pop-2)", padding: "11px 13px", boxShadow: "3px 3px 0 var(--ink)" }}>
                <Icon name="sparkles" size={15} color="#1d1d1b" />
                <span style={{ flex: 1, fontSize: 12, fontWeight: 800, color: "#1d1d1b" }}>“Is {st.sym} expensive at {st.pe}× PE?”</span>
                <Icon name="arrowR" size={14} color="#1d1d1b" />
              </div>
            </Press>
          </>
        )}

        {tab === "fin" && (
          <>
            <SecHead label="Revenue · last 6 quarters" right={<Tag>YoY +12.4%</Tag>} />
            <Card pad={14}>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 90 }}>
                {qtr.map((v, i) => (
                  <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                    <div style={{ width: "100%", height: `${(v / Math.max(...qtr)) * 72}px`, background: i === qtr.length - 1 ? "var(--emerald)" : "var(--pop-5)", border: "2px solid var(--ink)", borderRadius: "6px 6px 0 0" }} />
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 8, color: "var(--ink-3)" }}>Q{(i % 4) + 1}</span>
                  </div>
                ))}
              </div>
            </Card>
            <SecHead label="Profitability" />
            <ListCard>
              {[["Sales growth (3Y CAGR)", "+11.8%"], ["Net profit margin", "18.2%"], ["Operating margin", "24.6%"], ["Cash from ops (FY26)", "₹" + inr(48120) + " Cr"]].map(([l, v], i, arr) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "11px 14px", borderBottom: i < arr.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{l}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>{v}</span>
                </div>
              ))}
            </ListCard>
            <p style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4 }}>SOURCE: EXCHANGE FILINGS · AS OF Q1 FY27 · ILLUSTRATIVE IN DEMO</p>
          </>
        )}

        {tab === "news" && (
          <>
            {events.length > 0 && <SecHead label="Events" />}
            {events.length > 0 && (
              <ListCard>
                {events.map((e, i) => (
                  <RowItem key={e.d} last={i === events.length - 1}
                    left={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, border: "2px solid var(--ink)", borderRadius: 8, padding: "6px 8px", background: "var(--pop-2)", color: "#1d1d1b", transform: "rotate(-2deg)" }}>{e.d.toUpperCase()}</span>}
                    title={e.kind} sub={e.note} />
                ))}
              </ListCard>
            )}
            <SecHead label="News" />
            {news.length ? (
              <ListCard>
                {news.map((n, i) => (
                  <RowItem key={n.id} last={i === news.length - 1}
                    left={<Tag bg="var(--paper-2)">{n.tag}</Tag>}
                    title={n.title} sub={`${n.src} · ${n.time} ago`} />
                ))}
              </ListCard>
            ) : (
              <EmptyState icon="newspaper" title="Quiet on the wire" sub={`No ${st.sym} stories in the last week. We'll surface anything material.`} />
            )}
          </>
        )}

        {tab === "trades" && (
          myTrades.length || held ? (
            <>
              {held && <SecHead label="Open lots (FIFO)" />}
              {held && (
                <ListCard>
                  {Object.entries(held.brokers).map(([b, q], i, arr) => (
                    <RowItem key={b} last={i === arr.length - 1}
                      left={<BrokerLogo id={b} size={28} />}
                      title={`${q} sh @ ₹${inr(held.avg)}`} sub={`${BROKER_META[b].name} · LT on Sep 12`}
                      right={money(q * held.ltp)} />
                  ))}
                </ListCard>
              )}
              {myTrades.length > 0 && <SecHead label="Closed pairs" />}
              {myTrades.length > 0 && (
                <ListCard>
                  {myTrades.map((t, i) => (
                    <RowItem key={t.id} last={i === myTrades.length - 1} onClick={() => um.setSheet({ title: null, body: <PairSheet t={t} go={go} um={um} /> })}
                      left={<SymTile sym={t.sym} size={32} />}
                      title={`${t.qty} sh · ${t.term === "LT" ? "long" : "short"}-term`} sub={`${t.bDate.slice(3)} → ${t.sDate}`}
                      right={signMoney(t.pnl)} />
                  ))}
                </ListCard>
              )}
            </>
          ) : (
            <EmptyState icon="list" title={`No ${st.sym} trades yet`} sub="Trades appear here once a connected broker reports them, or import a CSV." cta="Import trades" onCta={() => go("import")} />
          )
        )}
      </div>
    </SubPage>
  );
}

// ── Mutual fund detail ──────────────────────────────────────────────────────
function MFScreenV2({ go, back, param, um }) {
  const f = MFS[param] || MFS.PPFCF;
  const held = MF_HELD.find(x => x.id === f.id);
  const TOPH = [["HDFCBANK", 8.1], ["ITC", 6.4], ["ICICI Bank", 5.9], ["Alphabet Inc", 5.2], ["Coal India", 4.8]];
  return (
    <SubPage um={um} title={f.name} onBack={back}
      footer={<PrimaryBtn icon="sparkles" onClick={() => { um.setSagePrefill(`Should I keep my SIP in ${f.name}?`); go("sage"); }}>Ask Sage about this fund</PrimaryBtn>}>
      <div style={{ paddingTop: 14 }}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Tag>{f.cat}</Tag><Tag>AUM {f.aum}</Tag><Tag color={f.risk === "Low" ? "var(--emerald-text)" : "var(--loss)"}>{f.risk} risk</Tag>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 28, letterSpacing: -1, color: "var(--ink)" }}>₹{inr(f.nav, 2)}</span>
          <Num v={f.navChg} fmt="pct" dec={2} size={13} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>NAV · JUL 18</span>
        </div>
        <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
          {[["1Y", f.ret1], ["3Y", f.ret3], ["5Y", f.ret5]].map(([l, v]) => (
            <div key={l} style={{ flex: 1, border: "2px solid var(--ink)", borderRadius: 11, padding: "10px 12px", background: "var(--paper-3)", boxShadow: "2px 2px 0 var(--ink)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 1, color: "var(--ink-3)" }}>{l} CAGR</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 800, color: "var(--gain-text)", marginTop: 3 }}>{v}%</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-2)", fontWeight: 700 }}>
          <span>EXPENSE {f.exp}%</span><span>DIRECT · GROWTH</span>
        </div>
        {held && (
          <>
            <SecHead label="Your holding" />
            <Card pad={14} bg="var(--paper-2)">
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <StatCell label="Units" value={inr(held.held.units, 1)} />
                <StatCell label="Value" value={money(held.val)} align="center" />
                <StatCell label="P&L" value={signMoney(held.pnl)} color="var(--gain-text)" sub={pct(held.pnlPct)} align="right" />
              </div>
              {held.held.sip > 0 && (
                <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 8, borderTop: "1.5px dashed var(--rule-soft)", paddingTop: 11 }}>
                  <Icon name="refresh" size={14} color="var(--emerald-text)" />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>SIP ₹{inr(held.held.sip)}/mo · next on Aug 1</span>
                </div>
              )}
            </Card>
          </>
        )}
        {f.overlap > 15 && (
          <div style={{ marginTop: 14, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--pop-2)", padding: "12px 14px", boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Icon name="alert" size={15} color="#1d1d1b" />
              <span style={{ fontWeight: 800, fontSize: 13, color: "#1d1d1b" }}>{f.overlap}% overlap with your stocks</span>
            </div>
            <div style={{ fontSize: 12, color: "#1d1d1b", marginTop: 5, lineHeight: 1.5 }}>This fund holds names you already own directly — you're doubling up without knowing it.</div>
          </div>
        )}
        <SecHead label="Top holdings" />
        <Card pad={8}>
          {TOPH.map(([n, w], i) => <HBar key={n} label={n} value={w} max={10} right={w + "%"} color={i === 0 ? "var(--emerald)" : "var(--pop-5)"} />)}
          <div style={{ height: 8 }} />
        </Card>
      </div>
    </SubPage>
  );
}

// ── Compare ─────────────────────────────────────────────────────────────────
function CompareScreenV2({ go, back, param, um }) {
  const first = param && STOCKS[param.toUpperCase()] ? param.toUpperCase() : "HDFCBANK";
  const peers = { HDFCBANK: "SBIN", SBIN: "HDFCBANK", INFY: "TCS", TCS: "INFY", RELIANCE: "LT", TATAMOTORS: "MARUTI", MARUTI: "TATAMOTORS" };
  const [sel, setSel] = stS([first, peers[first] || "INFY"]);
  const toggle = (s) => setSel(cur => cur.includes(s) ? (cur.length > 2 ? cur.filter(x => x !== s) : cur) : cur.length < 3 ? [...cur, s] : [...cur.slice(0, 2), s]);
  const ret1 = (s) => { const sr = STOCKS[s].series["1Y"]; return (sr[sr.length - 1] - sr[0]) / sr[0] * 100; };
  const ROWS = [
    { l: "Price", f: s => "₹" + inr(STOCKS[s].ltp, 1) },
    { l: "1Y return", f: s => pct(ret1(s)), best: (a, b) => ret1(a) > ret1(b) },
    { l: "P/E", f: s => STOCKS[s].pe + "×", best: (a, b) => STOCKS[a].pe < STOCKS[b].pe },
    { l: "P/B", f: s => STOCKS[s].pb + "×", best: (a, b) => STOCKS[a].pb < STOCKS[b].pb },
    { l: "ROE", f: s => STOCKS[s].roe + "%", best: (a, b) => STOCKS[a].roe > STOCKS[b].roe },
    { l: "Div yield", f: s => STOCKS[s].divy + "%", best: (a, b) => STOCKS[a].divy > STOCKS[b].divy },
    { l: "D/E", f: s => STOCKS[s].de, best: (a, b) => STOCKS[a].de < STOCKS[b].de },
    { l: "Beta", f: s => STOCKS[s].beta },
    { l: "Mkt cap", f: s => STOCKS[s].mcap },
  ];
  const bestOf = (row) => row.best ? sel.reduce((w, s) => row.best(s, w) ? s : w, sel[0]) : null;
  const POPULAR = ["HDFCBANK", "SBIN", "INFY", "TCS", "RELIANCE", "ITC", "TATAMOTORS", "MARUTI", "BAJFINANCE"];
  return (
    <SubPage um={um} title="Compare" onBack={back}
      footer={<PrimaryBtn icon="sparkles" onClick={() => { um.setSagePrefill(`Compare ${sel.join(" vs ")} for a 3-year hold`); go("sage"); }}>Ask Sage to pick a winner</PrimaryBtn>}>
      <div style={{ paddingTop: 14 }}>
        <div style={{ display: "flex", gap: 7, overflowX: "auto", paddingBottom: 6 }}>
          {POPULAR.map(s => <Chip key={s} active={sel.includes(s)} onClick={() => toggle(s)}>{s}</Chip>)}
        </div>
        <p style={{ margin: "8px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.5 }}>PICK 2-3 · <span style={{ background: "var(--pop-2)", padding: "1px 5px", borderRadius: 4, color: "#1d1d1b", fontWeight: 800 }}>GOLD</span> = BETTER ON THAT LINE</p>
        <div style={{ marginTop: 14, border: "2px solid var(--ink)", borderRadius: 14, overflow: "hidden", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
          <div style={{ display: "grid", gridTemplateColumns: `92px repeat(${sel.length}, 1fr)` }}>
            <div style={{ padding: "10px 12px", background: "var(--ink)" }} />
            {sel.map(s => (
              <div key={s} onClick={() => go("stock:" + s)} style={{ padding: "10px 8px", background: "var(--ink)", color: "var(--paper)", textAlign: "center", cursor: "pointer" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 800 }}>{s}</div>
                <Num v={STOCKS[s].chg} fmt="pct" size={9} style={{ color: STOCKS[s].chg >= 0 ? "var(--emerald)" : "var(--pop-1)" }} />
              </div>
            ))}
            {ROWS.map((row, ri) => {
              const best = bestOf(row);
              return (
                <React.Fragment key={row.l}>
                  <div style={{ padding: "10px 12px", borderTop: "1.5px solid var(--rule-soft)", fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: 0.4 }}>{row.l}</div>
                  {sel.map(s => (
                    <div key={s} style={{ padding: "10px 6px", borderTop: "1.5px solid var(--rule-soft)", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 800, color: "var(--ink)", background: best === s ? "var(--pop-2)" : "transparent" }}>{row.f(s)}</div>
                  ))}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </SubPage>
  );
}

Object.assign(window, { StockScreenV2, MFScreenV2, CompareScreenV2 });
