// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · Home (dashboard)
// ─────────────────────────────────────────────────────────────────────────
const { useState: hoS } = React;

function HomeScreenV2({ go, um }) {
  const [hide, setHide] = hoS(false);
  const [tipGone, setTipGone] = hoS(false);
  const anyErr = um.brokers.some(b => b.state === "expired" || b.state === "error");
  const movers = [...HOLDINGS].sort((a, b) => Math.abs(b.dayChg) - Math.abs(a.dayChg)).slice(0, 3);
  const heldNews = NEWS.filter(n => n.held).slice(0, 2);
  const mask = (s) => hide ? "₹ •••••••" : s;
  const QUICK = [
    { k: "sage", icon: "sparkles", t: "Ask Sage", c: "var(--pop-5)" },
    { k: "roast", icon: "flame", t: "Roast", c: "var(--pop-1)" },
    { k: "fire", icon: "target", t: "FIRE", c: "var(--pop-3)" },
    { k: "tax", icon: "receipt", t: "Tax", c: "var(--pop-2)" },
  ];
  return (
    <PullRefresh onRefresh={(done) => um.refresh(done)}>
      <div style={{ padding: "0 18px 28px" }}>
        <PageHead eyebrow="Good morning · markets open" title={`Hey ${USER.name}.`} ser="Today's tape."
          right={<SyncPill state={anyErr ? "err" : "ok"} onClick={() => go("brokers")} />} />

        {/* net worth hero */}
        <Press onClick={() => go("portfolio")}>
          <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 16, background: "var(--ink)", color: "var(--paper)", padding: "16px 18px", boxShadow: "4px 4px 0 var(--emerald)", position: "relative", overflow: "hidden" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1.2, opacity: 0.75 }}>TOTAL VALUE · {um.brokers.length} BROKERS</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={e => { e.stopPropagation(); setHide(h => !h); }} style={{ border: 0, background: "transparent", cursor: "pointer", display: "flex", padding: 2 }}>
                  <Icon name={hide ? "eyeC" : "eye"} size={15} color="var(--paper)" style={{ opacity: 0.8 }} />
                </button>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 800, background: "var(--pop-2)", color: "#1d1d1b", border: "1.5px solid var(--paper)", borderRadius: 7, padding: "3px 8px" }}>{pct(PORTFOLIO.dayPct, 2)}</span>
              </div>
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 34, letterSpacing: -1, margin: "8px 0 2px", fontVariantNumeric: "tabular-nums" }}>{mask(money(PORTFOLIO.total))}</div>
            <div style={{ display: "flex", gap: 18, marginTop: 10, borderTop: "1.5px dashed rgba(247,243,230,0.25)", paddingTop: 10 }}>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, opacity: 0.65 }}>TODAY</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: "var(--emerald)" }}>{hide ? "•••" : signMoney(PORTFOLIO.dayPnl)}</div></div>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, opacity: 0.65 }}>INVESTED</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800 }}>{mask(money(PORTFOLIO.inv))}</div></div>
              <div><div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, opacity: 0.65 }}>XIRR</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: "var(--pop-2)" }}>{PORTFOLIO.xirr}%</div></div>
              <div style={{ marginLeft: "auto", alignSelf: "center" }}><Icon name="chevronR" size={16} color="var(--paper)" style={{ opacity: 0.7 }} /></div>
            </div>
          </div>
        </Press>

        {/* v2.1 · US drop-in (flag on): dual currency + EOD honesty line */}
        {um.usFlag && <Press onClick={() => go("usportfolio")}>
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-3)", padding: "11px 13px", boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ width: 30, height: 30, borderRadius: 9, background: "var(--pop-3)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 11, color: "#f7f3e6", transform: "rotate(-3deg)" }}>US</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>Your US book · {window.usPair ? window.usPair(window.US_BOOK || 0, (window.__umUS || {}).persona || "nri")[0] : "$58,640"}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}>◷ AS OF JUL 18 CLOSE · SPOT ₹84.00/$ · OPENS 19:00 IST</div>
            </div>
            <Icon name="chevronR" size={15} color="var(--ink-3)" />
          </div>
        </Press>}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}><span onClick={() => go("homepresets")} style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, color: "var(--ink-3)", cursor: "pointer", letterSpacing: 0.6 }}>LAYOUT: {String(window.__umPreset || "intermediate").toUpperCase()} ▾</span></div>

        {/* broker attention strip */}
        {anyErr && (
          <Press onClick={() => go("brokers")}>
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-3)", padding: "11px 13px", boxShadow: "3px 3px 0 var(--pop-1)" }}>
              <span style={{ width: 30, height: 30, borderRadius: 9, background: "var(--pop-1)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="alert" size={15} color="#1d1d1b" strokeWidth={2.4} /></span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>Upstox token expired</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 1 }}>TCS & SBIN lots last synced Jul 14 — reconnect</div>
              </div>
              <Icon name="chevronR" size={15} color="var(--ink-3)" />
            </div>
          </Press>
        )}

        {/* quick actions */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginTop: 14 }}>
          {QUICK.map((q, i) => (
            <Press key={q.k} onClick={() => go(q.k)}>
              <div style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "11px 6px 9px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
                <span style={{ width: 34, height: 34, borderRadius: 10, background: q.c, border: "2px solid var(--ink)", display: "grid", placeItems: "center", transform: `rotate(${i % 2 ? 3 : -3}deg)` }}>
                  <Icon name={q.icon} size={17} color="#1d1d1b" strokeWidth={2.2} />
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: "var(--ink)" }}>{q.t}</span>
              </div>
            </Press>
          ))}
        </div>

        {/* Sage prompt card */}
        <Press onClick={() => go("sage")}>
          <div style={{ marginTop: 14, border: "2px solid var(--ink)", borderRadius: 14, background: "var(--pop-2)", padding: "14px 15px", boxShadow: "4px 4px 0 var(--ink)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <Icon name="sparkles" size={17} color="#1d1d1b" />
              <span style={{ fontWeight: 800, fontSize: 14.5, color: "#1d1d1b" }}>Ask Sage about your portfolio</span>
              <span style={{ marginLeft: "auto" }}><Icon name="arrowR" size={16} color="#1d1d1b" /></span>
            </div>
            <div style={{ display: "flex", gap: 7, marginTop: 11, flexWrap: "wrap" }}>
              {SAGE_SUGGESTIONS.slice(0, 2).map(s => (
                <button key={s} onClick={e => { e.stopPropagation(); um.setSagePrefill(s); go("sage"); }}
                  style={{ border: "2px solid #1d1d1b", background: "#fbf8eb", color: "#1d1d1b", borderRadius: 99, padding: "6px 11px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
                  ↪ {s}
                </button>
              ))}
            </div>
            <div style={{ marginTop: 9, fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "#1d1d1b", opacity: 0.75, letterSpacing: 0.6 }}>CHAT IS FREE · DEEP RESEARCH SPENDS CREDITS ({um.credits} LEFT)</div>
          </div>
        </Press>

        {/* movers in your book */}
        <SecHead label="Moving your book today" right={<button onClick={() => go("portfolio")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>SEE ALL →</button>} />
        <ListCard>
          {movers.map((h, i) => (
            <RowItem key={h.sym} last={i === movers.length - 1} onClick={() => go("stock:" + h.sym)}
              left={<SymTile sym={h.sym} size={36} rotate={i % 2 ? 2 : -2} />}
              title={h.sym} sub={`${h.qty} sh · ${compactINR(h.val)}`}
              right={hide ? "•••" : signMoney(h.dayPnl)} rightSub={<Num v={h.dayChg} fmt="pct" size={10.5} />} />
          ))}
        </ListCard>

        {/* allocation */}
        <SecHead label="Allocation" />
        <Card>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <Donut size={104} thick={15} centerTop={hide ? "•••" : compactINR(PORTFOLIO.total)} centerSub="13 HOLDINGS"
              parts={[{ v: PORTFOLIO.eq, color: "var(--emerald)" }, { v: MF_HELD[0].val + MF_HELD[1].val, color: "var(--pop-5)" }, { v: MF_HELD[2].val, color: "var(--pop-2)" }]} />
            <div style={{ flex: 1 }}>
              {[["Equity", PORTFOLIO.eq, "var(--emerald)"], ["Mutual funds", MF_HELD[0].val + MF_HELD[1].val, "var(--pop-5)"], ["Liquid / cash", MF_HELD[2].val, "var(--pop-2)"]].map(([l, v, c]) => (
                <div key={l} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: c, border: "1.5px solid var(--ink)" }} />
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", flex: 1 }}>{l}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: "var(--ink-2)" }}>{Math.round(v / PORTFOLIO.total * 100)}%</span>
                </div>
              ))}
              <button onClick={() => go("risk")} style={{ marginTop: 6, border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", padding: 0, letterSpacing: 0.5 }}>RISK REPORT →</button>
            </div>
          </div>
        </Card>

        {/* news for holdings */}
        <SecHead label="News · your holdings" right={<button onClick={() => go("discover:news")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>ALL NEWS →</button>} />
        <ListCard>
          {heldNews.map((n, i) => (
            <RowItem key={n.id} last={i === heldNews.length - 1} onClick={() => go("stock:" + n.sym)}
              left={<SymTile sym={n.sym} size={34} />}
              title={n.title} sub={`${n.sym} · ${n.src} · ${n.time} ago`} />
          ))}
        </ListCard>

        {/* upcoming events */}
        <SecHead label="Coming up" />
        <ListCard>
          {EVENTS.filter(e => e.held).slice(0, 3).map((e, i, arr) => (
            <RowItem key={e.d + e.sym} last={i === arr.length - 1} onClick={() => go("stock:" + e.sym)}
              left={<span style={{ width: 40, textAlign: "center", flexShrink: 0 }}><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--ink)", display: "block", border: "2px solid var(--ink)", borderRadius: 8, padding: "4px 2px", background: "var(--paper-2)", transform: "rotate(-2deg)" }}>{e.d.split(" ")[1]}<br /><span style={{ fontSize: 8, color: "var(--ink-3)" }}>{e.d.split(" ")[0].toUpperCase()}</span></span></span>}
              title={`${e.sym} · ${e.kind}`} sub={e.note} />
          ))}
        </ListCard>

        {/* upgrade teaser */}
        {um.plan === "free" && !tipGone && (
          <div style={{ marginTop: 22 }}>
            <GateBanner tier="PRO ₹249/mo" line={`You've used ${USER.creditsMax - um.credits} of ${USER.creditsMax} free credits this month. PRO gets you 50 — plus risk & tax reports and unlimited roasts.`} onUpgrade={() => go("plan")} />
          </div>
        )}
      </div>
    </PullRefresh>
  );
}

Object.assign(window, { HomeScreenV2 });
