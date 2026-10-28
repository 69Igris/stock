// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · Tools: FIRE, calculators, risk (gated), tax, documents
// ─────────────────────────────────────────────────────────────────────────
const { useState: tlS } = React;

function SliderRow({ label, value, min, max, step = 1, onChange, fmt = (v) => v }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)" }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: "var(--ink)", background: "var(--pop-2)", border: "1.5px solid var(--ink)", borderRadius: 7, padding: "2px 8px" }}>{fmt(value)}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)}
        style={{ width: "100%", marginTop: 8, accentColor: "var(--ink)", height: 22 }} />
    </div>
  );
}

function FireScreenV2({ go, back, um }) {
  const [age, setAge] = tlS(FIRE_DEF.age);
  const [retire, setRetire] = tlS(FIRE_DEF.retire);
  const [sip, setSip] = tlS(FIRE_DEF.sip);
  const [expense, setExpense] = tlS(FIRE_DEF.expense);
  const [ret, setRet] = tlS(FIRE_DEF.ret);
  const [scen, setScen] = tlS("normal");
  const mult = { lean: 0.7, normal: 1, fat: 1.6 }[scen];
  const years = Math.max(retire - age, 1);
  const r = ret / 100, infl = FIRE_DEF.inflation / 100;
  const proj = [];
  let c = PORTFOLIO.total;
  for (let y = 0; y <= years; y++) { proj.push(c); c = c * (1 + r) + sip * 12; }
  const needAtRetire = (expense * mult * 12 * Math.pow(1 + infl, years)) / (FIRE_DEF.swr / 100);
  const have = proj[proj.length - 1];
  const onTrack = have >= needAtRetire;
  // find FIRE age
  let fireAge = null, cc = PORTFOLIO.total;
  for (let y = 0; y <= 40; y++) {
    const need = (expense * mult * 12 * Math.pow(1 + infl, y)) / (FIRE_DEF.swr / 100);
    if (cc >= need) { fireAge = age + y; break; }
    cc = cc * (1 + r) + sip * 12;
  }
  return (
    <SubPage um={um} title="FIRE calculator" onBack={back}
      footer={<PrimaryBtn icon="sparkles" onClick={() => { um.setSagePrefill(`Can I retire at ${retire} spending ₹${inr(expense * mult)}/month?`); go("sage"); }}>Sanity-check with Sage</PrimaryBtn>}>
      <div style={{ paddingTop: 14 }}>
        {/* verdict */}
        <div style={{ border: "2px solid var(--ink)", borderRadius: 16, background: "var(--ink)", color: "var(--paper)", padding: "16px 18px", boxShadow: `4px 4px 0 ${onTrack ? "var(--emerald)" : "var(--pop-1)"}` }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.2, opacity: 0.7 }}>AT THIS RATE, FIRE AT</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 44, letterSpacing: -2, color: onTrack ? "var(--emerald)" : "var(--pop-2)" }}>{fireAge || "60+"}</span>
            <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14 }}>{fireAge && fireAge <= retire ? `${retire - fireAge} yrs ahead of plan` : fireAge ? `${fireAge - retire} yrs behind your target of ${retire}` : "needs a bigger SIP"}</span>
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 10, borderTop: "1.5px dashed rgba(247,243,230,0.25)", paddingTop: 10, fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
            <span>NEED {compactINR(needAtRetire)}</span>
            <span style={{ color: onTrack ? "var(--emerald)" : "var(--pop-1)" }}>PROJECTED {compactINR(have)}</span>
          </div>
        </div>
        {/* scenario chips */}
        <div style={{ display: "flex", gap: 7, marginTop: 12 }}>
          {[["lean", "Lean FIRE"], ["normal", "Regular"], ["fat", "Fat FIRE"]].map(([k, l]) => <Chip key={k} active={scen === k} onClick={() => setScen(k)}>{l}</Chip>)}
          <span style={{ marginLeft: "auto", alignSelf: "center", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>SWR {FIRE_DEF.swr}% · CPI {FIRE_DEF.inflation}%</span>
        </div>
        {/* projection */}
        <SecHead label="Corpus projection" right={<Tag>₹ NOMINAL</Tag>} />
        <Card pad={12}>
          <LineChart series={proj} h={96} color={onTrack ? "var(--emerald)" : "var(--pop-1)"} baseline={needAtRetire} />
          <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", marginTop: 6 }}>
            <span>AGE {age}</span><span>— NEED LINE {compactINR(needAtRetire)}</span><span>AGE {retire}</span>
          </div>
        </Card>
        {/* inputs */}
        <SecHead label="Your numbers" />
        <Card pad={16}>
          <div style={{ marginTop: -8 }}>
            <SliderRow label="Age today" value={age} min={20} max={55} onChange={setAge} />
            <SliderRow label="Retire at" value={retire} min={35} max={65} onChange={setRetire} />
            <SliderRow label="Monthly SIP" value={sip} min={5000} max={300000} step={5000} onChange={setSip} fmt={v => "₹" + inr(v)} />
            <SliderRow label="Monthly spend (today)" value={expense} min={20000} max={400000} step={5000} onChange={setExpense} fmt={v => "₹" + inr(v)} />
            <SliderRow label="Expected return" value={ret} min={6} max={18} step={0.5} onChange={setRet} fmt={v => v + "%"} />
          </div>
        </Card>
        <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", lineHeight: 1.6, letterSpacing: 0.3 }}>STARTS FROM YOUR REAL CORPUS ({compactINR(PORTFOLIO.total)}). STCG/LTCG-AWARE WITHDRAWALS IN THE FULL PLAN — EDUCATION, NOT ADVICE.</p>
      </div>
    </SubPage>
  );
}

// ── Calculators hub ─────────────────────────────────────────────────────────
function SipMiniCalc({ um }) {
  const [amt, setAmt] = tlS(25000);
  const [yrs, setYrs] = tlS(15);
  const [r, setR] = tlS(12);
  const i = r / 1200, n = yrs * 12;
  const fv = amt * ((Math.pow(1 + i, n) - 1) / i) * (1 + i);
  return (
    <div>
      <SliderRow label="Monthly SIP" value={amt} min={1000} max={200000} step={1000} onChange={setAmt} fmt={v => "₹" + inr(v)} />
      <SliderRow label="Years" value={yrs} min={1} max={35} onChange={setYrs} />
      <SliderRow label="Return (CAGR)" value={r} min={6} max={18} step={0.5} onChange={setR} fmt={v => v + "%"} />
      <div style={{ marginTop: 18, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--ink)", color: "var(--paper)", padding: "13px 15px", boxShadow: "3px 3px 0 var(--emerald)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 1, opacity: 0.7 }}>FUTURE VALUE</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 800, color: "var(--emerald)" }}>{compactINR(fv)}</div>
        </div>
        <div style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontSize: 10 }}>
          <div style={{ opacity: 0.7 }}>INVESTED {compactINR(amt * n)}</div>
          <div style={{ color: "var(--pop-2)" }}>GAIN {compactINR(fv - amt * n)}</div>
        </div>
      </div>
    </div>
  );
}
function CalculatorsScreenV2({ go, back, um }) {
  const CALCS = [
    { k: "sip", icon: "refresh", t: "SIP future value", d: "what monthly investing becomes", body: <SipMiniCalc um={um} /> },
    { k: "ltcg", icon: "receipt", t: "Capital-gains tax", d: "STCG 20% · LTCG 12.5% over ₹1.25L", go: "tax" },
    { k: "cagr", icon: "trending", t: "CAGR / XIRR", d: "true annualised return of anything" },
    { k: "swp", icon: "wallet", t: "SWP drawdown", d: "how long a corpus lasts" },
    { k: "fire", icon: "target", t: "FIRE", d: "the big one — full planner", go: "fire" },
  ];
  return (
    <SubPage um={um} title="Calculators" onBack={back}>
      <div style={{ paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {CALCS.map((c, i) => (
          <Press key={c.k} onClick={() => c.go ? go(c.go) : um.setSheet({ title: c.t, body: c.body || <EmptyState icon={c.icon} title="Coming this sprint" sub="This one's being wired to your real tradebook." /> })}>
            <div style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 15px", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 38, height: 38, borderRadius: 11, border: "2px solid var(--ink)", background: SYM_COLORS[i % SYM_COLORS.length], display: "grid", placeItems: "center", flexShrink: 0, transform: i % 2 ? "rotate(3deg)" : "rotate(-3deg)" }}>
                <Icon name={c.icon} size={17} color="#1d1d1b" />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{c.t}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 2, letterSpacing: 0.3 }}>{c.d.toUpperCase()}</div>
              </div>
              <Icon name="chevronR" size={14} color="var(--ink-4)" />
            </div>
          </Press>
        ))}
      </div>
    </SubPage>
  );
}

// ── Risk report (PRO-gated) ─────────────────────────────────────────────────
function RiskScreenV2({ go, back, um }) {
  const gated = um.plan === "free";
  return (
    <SubPage um={um} title="Risk report" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--pop-1)" style={{ color: "var(--paper)", filter: gated ? "none" : "none" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.2, opacity: 0.7 }}>1-DAY VALUE AT RISK · 95%</div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 30, letterSpacing: -1, margin: "6px 0 2px", color: "var(--pop-1)", filter: gated ? "blur(7px)" : "none" }}>-{money(RISK.var95)}</div>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13, opacity: 0.85 }}>a bad-but-normal day costs about this much.</div>
        </Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12, filter: gated ? "blur(5px)" : "none", pointerEvents: gated ? "none" : "auto" }}>
          {[["Beta vs NIFTY", RISK.beta], ["Volatility (ann.)", RISK.vol + "%"], ["Max drawdown", RISK.maxDD + "%"], ["Sharpe (3Y)", RISK.sharpe]].map(([l, v]) => (
            <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 12, padding: "11px 13px", background: "var(--paper-3)", boxShadow: "2px 2px 0 var(--ink)" }}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.8, color: "var(--ink-3)", textTransform: "uppercase" }}>{l}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 17, fontWeight: 800, color: "var(--ink)", marginTop: 3 }}>{v}</div>
            </div>
          ))}
        </div>
        {gated ? (
          <div style={{ marginTop: 14 }}>
            <GateBanner tier="PRO" line="VaR, drawdown, correlation heatmap and concentration flags — computed nightly from your real book." onUpgrade={() => go("plan")} />
          </div>
        ) : (
          <>
            <SecHead label="Concentration" />
            {um.usFlag && (
              <Card pad={12} style={{ marginBottom: 12 }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "var(--ink-3)" }}>CURRENCY EXPOSURE</div>
                <HBar label="USD · via US stocks" value={45} max={100} color="var(--pop-3)" right="45%" />
                <HBar label="INR" value={55} max={100} color="var(--pop-5)" right="55%" />
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8, lineHeight: 1.5 }}>A 1% move in USDINR moves your total by about ₹7,800. Spot rate hourly; not hedged.</div>
              </Card>
            )}
            <ListCard>
              {RISK.conc.map((c, i) => (
                <div key={c.label} style={{ display: "flex", justifyContent: "space-between", padding: "11px 14px", borderBottom: i < RISK.conc.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{c.label}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: "var(--loss)" }}>{c.v}</span>
                </div>
              ))}
            </ListCard>
            <SecHead label="Moves together" />
            <ListCard>
              {RISK.corr.map(([a, b, v], i) => (
                <div key={a + b} style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 14px", borderBottom: i < RISK.corr.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 800, color: "var(--ink)" }}>{a} ↔ {b}</span>
                  <div style={{ flex: 1, height: 8, border: "1.5px solid var(--ink)", borderRadius: 99, background: "var(--paper-2)", overflow: "hidden" }}>
                    <div style={{ width: (v * 100) + "%", height: "100%", background: v > 0.75 ? "var(--pop-1)" : "var(--pop-2)" }} />
                  </div>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--ink-2)" }}>{v}</span>
                </div>
              ))}
            </ListCard>
            <div style={{ marginTop: 14 }}>
              <GhostBtn icon="sparkles" onClick={() => { um.setSagePrefill("Explain my risk report — what should I actually change?"); go("sage"); }}>Ask Sage to translate this</GhostBtn>
            </div>
          </>
        )}
      </div>
    </SubPage>
  );
}

// ── Tax report ──────────────────────────────────────────────────────────────
function TaxScreenV2({ go, back, um }) {
  return (
    <SubPage um={um} title="Tax report" onBack={back} right={<Chip style={{ padding: "5px 11px" }}>{TAX.fy} ▾</Chip>}>
      <div style={{ paddingTop: 14 }}>
        <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--pop-2)" style={{ color: "var(--paper)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.2, opacity: 0.7 }}>TAX DUE SO FAR · {TAX.fy.toUpperCase()}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 32, letterSpacing: -1, margin: "6px 0 2px", color: "var(--pop-2)" }}>{money(TAX.taxDue)}</div>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13, opacity: 0.85 }}>all of it from short-term gains. Long-term is riding free.</div>
        </Card>
        <SecHead label="Realised gains" />
        {um.usFlag && (
          <Card pad={12} style={{ marginBottom: 12, background: "var(--paper-2)" }} onClick={() => (window.__umUS || {}).persona === "lrs" ? go("lrs") : undefined}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Tag bg="var(--pop-3)" color="#1d1d1b" style={{ borderColor: "var(--ink)" }}>US</Tag><b style={{ flex: 1, fontSize: 13.5, color: "var(--ink)" }}>US holdings are tracked, not taxed here</b>{(window.__umUS || {}).persona === "lrs" && <Icon name="chevronR" size={15} color="var(--ink-3)" />}</div>
            <div style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>No 1099 / W-8BEN / PFIC computation. ₹ cost basis is frozen at the RBI reference rate of each trade date.{(window.__umUS || {}).persona === "lrs" ? " LRS remittances and TCS paid (₹6,04,742, claimable) live in the LRS tracker →" : ""}</div>
          </Card>
        )}
        <ListCard>
          {TAX.breakdown.map((b, i) => (
            <div key={b.label} style={{ padding: "12px 14px", borderBottom: i < TAX.breakdown.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>{b.label}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>{money(b.v)}</span>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 3 }}>{b.note.toUpperCase()}</div>
            </div>
          ))}
        </ListCard>
        <SecHead label="Exemption meter" right={<Tag>LTCG · ₹1.25L FREE</Tag>} />
        <Card pad={14}>
          <HBar label={`Used ${money(TAX.ltcg)} of ₹1,25,000`} value={TAX.ltcg} max={125000} right={compactINR(TAX.exemptLeft) + " left"} color="var(--emerald)" />
          <div style={{ height: 6 }} />
        </Card>
        <SecHead label="Harvest before March" />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {TAX.harvest.map(h => (
            <div key={h.sym} style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "13px 14px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <SymTile sym={h.sym} size={32} />
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, fontWeight: 800, color: "var(--ink)", flex: 1 }}>{h.sym}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, color: "var(--loss)" }}>{signMoney(h.unreal)}</span>
              </div>
              <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 7, lineHeight: 1.5 }}>{h.note} — saves about <mark style={{ background: "var(--pop-2)", padding: "0 4px", fontWeight: 800 }}>{money(h.save)}</mark> in tax.</div>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <PrimaryBtn icon="sparkles" onClick={() => { um.setSagePrefill("Walk me through harvesting my TATAMOTORS loss"); go("sage"); }}>Plan it with Sage</PrimaryBtn>
        </div>
        <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", lineHeight: 1.6, letterSpacing: 0.3 }}>COMPUTED FROM FIFO-PAIRED TRADES ACROSS ALL BROKERS. VERIFY WITH YOUR CA BEFORE FILING.</p>
      </div>
    </SubPage>
  );
}

// ── Documents vault ─────────────────────────────────────────────────────────
function DocumentsScreenV2({ go, back, um }) {
  const DOCS = [
    { n: "Zerodha P&L FY26.pdf", s: "parsed", d: "42 trades extracted · Jul 02" },
    { n: "CAMS CAS statement.pdf", s: "parsed", d: "3 folios matched · Jun 18" },
    { n: "HDFC contract note 14-Jul.pdf", s: "processing", d: "extracting tables…" },
  ];
  return (
    <SubPage um={um} title="Document vault" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <Press onClick={() => um.toast("Upload queued — parsing starts now")}>
          <div style={{ border: "2px dashed var(--ink)", borderRadius: 14, padding: "22px 16px", textAlign: "center", background: "var(--paper-2)" }}>
            <Icon name="upload" size={20} color="var(--ink-2)" />
            <div style={{ fontWeight: 800, fontSize: 13.5, color: "var(--ink)", marginTop: 7 }}>Drop a statement or contract note</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 3 }}>PDF · CSV · TEXT IS EXTRACTED & LINKED TO TRADES</div>
          </div>
        </Press>
        <SecHead label="Your documents" />
        <ListCard>
          {DOCS.map((d, i) => (
            <RowItem key={d.n} last={i === DOCS.length - 1}
              left={<span style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: d.s === "parsed" ? "var(--emerald)" : "var(--pop-2)", display: "grid", placeItems: "center", flexShrink: 0 }}>{d.s === "parsed" ? <Icon name="file" size={16} color="#0b0b09" /> : <Spinner size={15} color="#1d1d1b" />}</span>}
              title={d.n} sub={d.d.toUpperCase()}
              rightSub={<Tag color={d.s === "parsed" ? "var(--emerald-text)" : "var(--ink-3)"}>{d.s}</Tag>} />
          ))}
        </ListCard>
      </div>
    </SubPage>
  );
}

Object.assign(window, { FireScreenV2, CalculatorsScreenV2, RiskScreenV2, TaxScreenV2, DocumentsScreenV2, SliderRow });
