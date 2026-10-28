// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · Discover: Markets / Screener / Sectors / News / Watchlists
// ─────────────────────────────────────────────────────────────────────────
const { useState: dsS, useEffect: dsE } = React;

function MoverRow({ sym, i, last, go }) {
  const st = STOCKS[sym];
  return (
    <RowItem last={last} onClick={() => go("stock:" + sym)}
      left={<span style={{ display: "flex", alignItems: "center", gap: 9 }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--ink-4)", width: 14 }}>{i + 1}</span><SymTile sym={sym} size={34} /></span>}
      title={sym} sub={st.sector}
      right={"₹" + inr(st.ltp, 1)} rightSub={<Num v={st.chg} fmt="pct" size={10.5} />} />
  );
}

function DiscoverScreenV2({ go, um, param }) {
  const [tab, setTab] = dsS(param || "markets");
  const [mv, setMv] = dsS("gainers");
  const [scan, setScan] = dsS(null);
  const [newsF, setNewsF] = dsS("all");
  const [wl, setWl] = dsS(um.watchlists[0].id);
  dsE(() => { if (param) setTab(param); }, [param]);
  const TABS = [["markets", "Markets"], ["screener", "Screener"], ["sectors", "Sectors"], ["news", "News"], ["watchlist", "Watchlists"]];
  const news = newsF === "us" ? [] : NEWS.filter(n => newsF === "all" || (newsF === "held" ? n.held : !n.sym));
  const list = um.watchlists.find(w => w.id === wl) || um.watchlists[0];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "0 18px" }}>
        <PageHead eyebrow="NSE · BSE · live" title="The market," ser="in one breath." />
        <div style={{ display: "flex", gap: 7, margin: "10px 0 4px", overflowX: "auto", paddingBottom: 6 }}>
          {TABS.map(([k, l]) => <Chip key={k} active={tab === k} onClick={() => { setTab(k); setScan(null); }}>{l}</Chip>)}
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 18px 28px" }}>

        {tab === "markets" && (
          <>
            {um.usFlag && (
              <Card pad={12} style={{ marginTop: 12 }} onClick={() => go("usportfolio")}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "var(--ink-3)", flex: 1 }}>US MARKETS</span><Tag bg="var(--paper-2)">◷ EOD JUL 18</Tag></div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 10 }}>
                  {[["S&P 500", "7,428.78", 0.21], ["NASDAQ", "24,876.91", -0.22], ["USDINR", "84.00", -0.08]].map(([k, v, c]) => <div key={k}><div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.8, color: "var(--ink-3)", fontWeight: 700 }}>{k}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, color: "var(--ink)", marginTop: 2 }}>{v}</div><Num v={c} fmt="pct" dec={2} size={10.5} /></div>)}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 8 }}>OPENS 19:00 IST · 09:30 ET · SPOT FX HOURLY</div>
              </Card>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
              {INDICES.map(ix => (
                <div key={ix.sym} style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "11px 12px 8px" }}>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: 0.8, color: "var(--ink-3)" }}>{ix.sym}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 800, color: "var(--ink)", margin: "3px 0 1px" }}>{inr(ix.v, ix.v < 100 ? 2 : 0)}</div>
                  <Num v={ix.chg} fmt="pct" dec={2} size={10.5} />
                  <LineChart series={ix.series} h={30} color={ix.chg >= 0 ? "var(--emerald)" : "var(--pop-1)"} fill={false} strokeWidth={1.8} />
                </div>
              ))}
            </div>
            <SecHead label="Flows · FII / DII" right={<Tag>{FII_DII.date}</Tag>} />
            <Card pad={13}>
              {[["FII (cash)", FII_DII.fii], ["DII (cash)", FII_DII.dii]].map(([l, v]) => (
                <div key={l} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
                  <span style={{ width: 74, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-2)" }}>{l}</span>
                  <div style={{ flex: 1, height: 12, position: "relative" }}>
                    <span style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1.5, background: "var(--ink)" }} />
                    <span style={{ position: "absolute", top: 1, bottom: 1, borderRadius: 4, border: "1.5px solid var(--ink)", background: v >= 0 ? "var(--emerald)" : "var(--pop-1)", left: v >= 0 ? "50%" : `${50 - Math.min(Math.abs(v) / 50, 46)}%`, width: `${Math.min(Math.abs(v) / 50, 46)}%` }} />
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 800, color: v >= 0 ? "var(--gain-text)" : "var(--loss)", width: 78, textAlign: "right" }}>{(v >= 0 ? "+" : "-") + "₹" + inr(Math.abs(v)) + " Cr"}</span>
                </div>
              ))}
            </Card>
            <SecHead label="Movers" right={
              <div style={{ display: "flex", gap: 5 }}>
                <Chip active={mv === "gainers"} onClick={() => setMv("gainers")} color="var(--emerald)" style={{ padding: "5px 10px", fontSize: 10.5 }}>Gainers</Chip>
                <Chip active={mv === "losers"} onClick={() => setMv("losers")} color="var(--pop-1)" style={{ padding: "5px 10px", fontSize: 10.5 }}>Losers</Chip>
              </div>} />
            <ListCard>
              {MOVERS[mv].map((s, i) => <MoverRow key={s} sym={s} i={i} last={i === MOVERS[mv].length - 1} go={go} />)}
            </ListCard>
            <SecHead label="Sector pulse" right={<button onClick={() => setTab("sectors")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>ALL →</button>} />
            <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
              {SECTORS.slice(0, 8).map(s => (
                <button key={s.id} onClick={() => go("sector:" + s.id)} style={{ border: "2px solid var(--ink)", borderRadius: 10, padding: "7px 11px", background: s.chg >= 0 ? "color-mix(in oklab, var(--emerald) 22%, var(--paper-3))" : "color-mix(in oklab, var(--pop-1) 22%, var(--paper-3))", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 800, color: "var(--ink)", boxShadow: "2px 2px 0 var(--ink)" }}>
                  {s.name} {pct(s.chg, 1)}
                </button>
              ))}
            </div>
          </>
        )}

        {tab === "screener" && !scan && (
          <>
            {um.usFlag && <Press onClick={() => go("screener2")}><div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--pop-2)", padding: "10px 13px", boxShadow: "3px 3px 0 var(--ink)", color: "#1d1d1b" }}><span style={{ flex: 1, fontSize: 12.5, fontWeight: 800 }}>Screener v2 · INDIA | US pill, scans library</span><Icon name="chevronR" size={15} color="#1d1d1b" /></div></Press>}
            <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ink-3)", lineHeight: 1.5 }}>Curated scans over 7,000+ instruments. Tap one to see today's matches.</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
              {SCANS.map((s, i) => (
                <Press key={s.id} onClick={() => setScan(s.id)}>
                  <div style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 15px", display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: SYM_COLORS[i % SYM_COLORS.length], display: "grid", placeItems: "center", flexShrink: 0, transform: i % 2 ? "rotate(3deg)" : "rotate(-3deg)" }}>
                      <Icon name="filter" size={16} color="#1d1d1b" />
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>{s.name}</div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>{s.desc.toUpperCase()}</div>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, background: "var(--ink)", color: "var(--paper)", borderRadius: 7, padding: "4px 8px" }}>{s.count}</span>
                  </div>
                </Press>
              ))}
            </div>
            <div style={{ marginTop: 16 }}>
              <GateBanner tier="PRO" line="Build custom scans — your own filters over fundamentals, technicals and your holdings." onUpgrade={() => go("plan")} />
            </div>
          </>
        )}

        {tab === "screener" && scan && (() => {
          const s = SCANS.find(x => x.id === scan);
          return (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 12 }}>
                <button onClick={() => setScan(null)} style={{ width: 32, height: 32, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}><Icon name="arrowL" size={15} color="var(--ink)" /></button>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 15.5, color: "var(--ink)" }}>{s.name}</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>{s.desc.toUpperCase()}</div>
                </div>
              </div>
              <SecHead label={`Top matches · ${s.syms.length} of ${s.count}`} />
              <ListCard>
                {s.syms.map((sym, i) => <MoverRow key={sym} sym={sym} i={i} last={i === s.syms.length - 1} go={go} />)}
              </ListCard>
              <p style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.4 }}>FULL LIST OF {s.count} IS A PRO FEATURE.</p>
            </>
          );
        })()}

        {tab === "sectors" && (
          <>
            <SecHead label="By NIFTY weight" style={{ marginTop: 14 }} />
            <ListCard>
              {SECTORS.map((s, i) => (
                <RowItem key={s.id} last={i === SECTORS.length - 1} onClick={() => go("sector:" + s.id)}
                  left={<span style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: s.chg >= 0 ? "var(--emerald)" : "var(--pop-1)", display: "grid", placeItems: "center", flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 12, color: "#0b0b09", transform: i % 2 ? "rotate(2deg)" : "rotate(-2deg)" }}>{s.name[0]}</span>}
                  title={s.name} sub={`${s.w}% of NIFTY · ${s.top.length} tracked`}
                  right={pct(s.chg, 2)} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>TODAY</span>} />
              ))}
            </ListCard>
          </>
        )}

        {tab === "news" && (
          <>
            <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
              <Chip active={newsF === "all"} onClick={() => setNewsF("all")}>All</Chip>
              <Chip active={newsF === "held"} onClick={() => setNewsF("held")}>Your holdings</Chip>
              <Chip active={newsF === "macro"} onClick={() => setNewsF("macro")}>Macro</Chip>
              {um.usFlag && <Chip active={newsF === "us"} onClick={() => setNewsF("us")}>US</Chip>}
            </div>
            {newsF === "us" && (
              <ListCard style={{ marginTop: 12 }}>
                {[["AAPL", "Apple 10-Q filed · services margin 74%", "SEC EDGAR · May 02"], ["NVDA", "Form 4 · director sale 12,000 sh", "SEC EDGAR · Jul 11"], ["SPX", "US CPI 2.9% · Fed holds", "Macro · Jul 16"]].map(([s, t, src], i) => <RowItem key={t} last={i === 2} onClick={() => s !== "SPX" && go("usstock:" + s)} left={<SymTile sym={s} size={34} />} title={t} sub={src} right={<Tag bg="var(--pop-3)" color="#1d1d1b" style={{ borderColor: "var(--ink)" }}>US</Tag>} />)}
              </ListCard>
            )}
            {news.length > 0 && <SecHead label="Today" />}
            {news.length > 0 && <ListCard>
              {news.map((n, i) => (
                <RowItem key={n.id} last={i === news.length - 1} onClick={n.sym ? () => go("stock:" + n.sym) : undefined}
                  left={n.sym ? <SymTile sym={n.sym} size={34} /> : <span style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="globe" size={15} color="var(--ink-2)" /></span>}
                  title={n.title} sub={`${n.tag} · ${n.src} · ${n.time} ago${n.held ? " · you hold this" : ""}`} />
              ))}
            </ListCard>}
            <SecHead label="This week" />
            <ListCard>
              {EVENTS.map((e, i) => (
                <RowItem key={e.d + (e.sym || "")} last={i === EVENTS.length - 1} onClick={e.sym ? () => go("stock:" + e.sym) : undefined}
                  left={<span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, border: "2px solid var(--ink)", borderRadius: 8, padding: "5px 7px", background: e.held ? "var(--pop-2)" : "var(--paper-2)", color: "var(--ink)", transform: "rotate(-2deg)", flexShrink: 0 }}>{e.d.toUpperCase()}</span>}
                  title={e.sym ? `${e.sym} · ${e.kind}` : e.kind} sub={e.note} />
              ))}
            </ListCard>
          </>
        )}

        {tab === "watchlist" && (
          <>
            <div style={{ display: "flex", gap: 7, marginTop: 12, overflowX: "auto", paddingBottom: 4 }}>
              {um.watchlists.map(w => <Chip key={w.id} active={wl === w.id} onClick={() => setWl(w.id)}>{w.name} · {w.syms.length}</Chip>)}
              <Chip onClick={() => um.toast("New lists come with PRO", "info")}>+ New</Chip>
            </div>
            {list.syms.length ? (
              <>
                <SecHead label={list.name} />
                <ListCard>
                  {list.syms.map((sym, i) => {
                    const st = STOCKS[sym];
                    return (
                      <RowItem key={sym} last={i === list.syms.length - 1} onClick={() => go("stock:" + sym)}
                        left={<SymTile sym={sym} size={36} />}
                        title={sym} sub={st.name}
                        right={"₹" + inr(st.ltp, 1)} rightSub={<Num v={st.chg} fmt="pct" size={10.5} />} />
                    );
                  })}
                </ListCard>
                <div style={{ marginTop: 12 }}>
                  <GhostBtn icon="search" onClick={() => um.setSearchOpen(true)}>Add a stock</GhostBtn>
                </div>
              </>
            ) : (
              <EmptyState icon="eye" title="Empty list" sub="Star any stock — from search, a screener, or a stock page — to track it here." cta="Find stocks" onCta={() => um.setSearchOpen(true)} />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Sector detail ───────────────────────────────────────────────────────────
function SectorScreenV2({ go, back, param, um }) {
  const s = SECTORS.find(x => x.id === param) || SECTORS[0];
  const held = HOLDINGS.filter(h => s.top.includes(h.sym));
  return (
    <SubPage um={um} title={s.name} onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, color: s.chg >= 0 ? "var(--gain-text)" : "var(--loss)" }}>{pct(s.chg, 2)}</span>
          <Tag>{s.w}% OF NIFTY</Tag>
        </div>
        <p style={{ margin: "10px 0 0", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15, color: "var(--ink-2)", lineHeight: 1.5 }}>{s.line}</p>
        {held.length > 0 && (
          <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--pop-2)", padding: "10px 13px", display: "flex", alignItems: "center", gap: 8, boxShadow: "3px 3px 0 var(--ink)" }}>
            <Icon name="briefcase" size={14} color="#1d1d1b" />
            <span style={{ fontSize: 12, fontWeight: 800, color: "#1d1d1b" }}>You hold {held.length} name{held.length > 1 ? "s" : ""} here — {compactINR(held.reduce((a, h) => a + h.val, 0))}</span>
          </div>
        )}
        <SecHead label="Tracked stocks" />
        <ListCard>
          {s.top.map((sym, i) => {
            const st = STOCKS[sym];
            if (!st) return null;
            return (
              <RowItem key={sym} last={i === s.top.length - 1} onClick={() => go("stock:" + sym)}
                left={<SymTile sym={sym} size={36} />}
                title={sym} sub={st.name}
                right={"₹" + inr(st.ltp, 1)} rightSub={<Num v={st.chg} fmt="pct" size={10.5} />} />
            );
          })}
        </ListCard>
        <div style={{ marginTop: 14 }}>
          <GhostBtn icon="sparkles" onClick={() => { um.setSagePrefill(`What's happening in ${s.name} today?`); go("sage"); }}>Ask Sage about {s.name}</GhostBtn>
        </div>
      </div>
    </SubPage>
  );
}

Object.assign(window, { DiscoverScreenV2, SectorScreenV2 });
