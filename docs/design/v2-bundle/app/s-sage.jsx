// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · Sage: chat (free) → deep research (credits) → report
// ─────────────────────────────────────────────────────────────────────────
const { useState: sgS, useEffect: sgE, useRef: sgR } = React;

function pickAnswer(q) {
  const s = q.toLowerCase();
  if (s.includes("reliance")) return SAGE_CANNED.reliance;
  if (s.includes("down")) return SAGE_CANNED.down;
  if (s.includes("financ") || s.includes("concentrat")) return SAGE_CANNED.fin;
  if (s.includes("ltcg") || s.includes("tax") || s.includes("infy")) return SAGE_CANNED.ltcg;
  return SAGE_CANNED.default;
}

// source citation chips
function SrcChips({ srcs, style }) {
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 9, ...style }}>
      {srcs.map((s, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, color: "var(--ink-2)", border: "1.5px solid var(--rule-soft)", background: "var(--paper-2)", borderRadius: 6, padding: "3px 7px", letterSpacing: 0.3 }}>
          <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--emerald)" }} />{s}
        </span>
      ))}
    </div>
  );
}

// streaming answer bubble
function SageBubble({ msg, onChip }) {
  return (
    <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
      <span style={{ width: 28, height: 28, borderRadius: 9, background: "var(--emerald)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0, transform: "rotate(-3deg)" }}>
        <Icon name="sparkles" size={14} color="#0b0b09" />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)" }}>STOCKSAGE · GEMINI 2.5</div>
        <div style={{ marginTop: 6, border: "2px solid var(--ink)", borderRadius: "4px 14px 14px 14px", background: "var(--paper-3)", padding: "12px 14px", boxShadow: "3px 3px 0 var(--ink)" }}>
          <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--ink)", whiteSpace: "pre-wrap" }}>
            {msg.shown}{msg.streaming && <span style={{ display: "inline-block", width: 8, height: 14, background: "var(--emerald)", marginLeft: 2, verticalAlign: "-2px", animation: "umpulse 0.9s infinite" }} />}
          </div>
          {!msg.streaming && msg.srcs && <SrcChips srcs={msg.srcs} />}
        </div>
        {!msg.streaming && msg.chips && (
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 9 }}>
            {msg.chips.map(c => (
              <button key={c} onClick={() => onChip(c)} style={{ border: "2px solid var(--ink)", background: "var(--paper)", color: "var(--ink)", borderRadius: 99, padding: "6px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)", boxShadow: "2px 2px 0 var(--ink)" }}>↪ {c}</button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SageScreenV2({ go, um }) {
  const [msgs, setMsgs] = sgS([]);
  const [input, setInput] = sgS("");
  const scRef = sgR(null);
  const timer = sgR(null);

  sgE(() => {
    if (um.sagePrefill) { const q = um.sagePrefill; um.setSagePrefill(null); setTimeout(() => ask(q), 220); }
    return () => clearInterval(timer.current);
  }, []);
  sgE(() => { if (scRef.current) scRef.current.scrollTop = scRef.current.scrollHeight; }, [msgs]);

  const ask = (q) => {
    if (!q.trim()) return;
    const ans = pickAnswer(q);
    setInput("");
    setMsgs(m => [...m, { role: "u", text: q }, { role: "a", full: ans.a, shown: "", srcs: ans.srcs, chips: ans.chips, streaming: true }]);
    clearInterval(timer.current);
    let i = 0;
    timer.current = setInterval(() => {
      i += 3 + Math.floor(Math.random() * 4);
      setMsgs(m => {
        const nm = [...m], last = { ...nm[nm.length - 1] };
        last.shown = last.full.slice(0, i);
        if (i >= last.full.length) { last.shown = last.full; last.streaming = false; clearInterval(timer.current); }
        nm[nm.length - 1] = last;
        return nm;
      });
    }, 30);
  };

  const researchConfirm = () => {
    const cost = RESEARCH_REPORT.cost;
    if (um.credits < cost) {
      um.setSheet({
        title: "Out of credits", body: (
          <div>
            <p style={{ margin: "2px 0 14px", fontSize: 13.5, lineHeight: 1.55, color: "var(--ink-2)" }}>Deep research on INFY costs <b>{cost} credits</b> — you have {um.credits}. Free credits reset Aug 1, or go PRO for 50/month.</p>
            <GateBanner tier="PRO ₹249/mo" line="50 research credits, unlimited roasts, risk & tax reports." onUpgrade={() => { um.setSheet(null); go("plan"); }} />
          </div>
        ),
      });
      return;
    }
    um.setSheet({
      title: "Deep research · INFY", body: <ResearchConfirm cost={cost} um={um} onRun={() => { um.setSheet(null); um.spend(cost); go("sageresearch"); }} />,
    });
  };

  const empty = msgs.length === 0;
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div ref={scRef} style={{ flex: 1, overflowY: "auto", padding: "0 18px 14px" }}>
        {empty ? (
          <>
            <PageHead eyebrow="StockSage · AI research" title="Ask anything" ser="about your money."
              sub="It has read every holding, every trade, all three brokers." />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
              <CostChip n={0} style={{ background: "var(--emerald)", color: "#0b0b09" }} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 0.5 }}>CHAT IS FREE · {um.credits} OF {USER.creditsMax} CREDITS LEFT ·</span>
              <button onClick={() => go("plan")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", padding: 0, letterSpacing: 0.5 }}>MANAGE</button>
            </div>
            <SecHead label="Try asking" />
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...(um.usFlag ? ["How's my US book doing vs my India book?"] : []), ...SAGE_SUGGESTIONS].map(s => (
                <button key={s} onClick={() => ask(s)} style={{ textAlign: "left", border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", borderRadius: 12, padding: "12px 14px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "var(--font-sans)", boxShadow: "3px 3px 0 var(--ink)", display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--emerald-text)", fontWeight: 800 }}>↪</span>{s}
                </button>
              ))}
            </div>
            <SecHead label="Deep research" right={<CostChip n={2} />} />
            <Card>
              <div style={{ display: "flex", gap: 11 }}>
                <span style={{ width: 38, height: 38, borderRadius: 11, background: "var(--pop-5)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0, transform: "rotate(-3deg)" }}><Icon name="brain" size={19} color="#1d1d1b" /></span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>Cited, auditable stock reports</div>
                  <div style={{ fontSize: 12.5, color: "var(--ink-3)", lineHeight: 1.5, marginTop: 3 }}>An agent reads filings, calls, quotes and <i>your own lots</i> — every claim links to a source.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <GhostBtn full={false} onClick={researchConfirm} style={{ flex: 1, padding: "11px 14px", fontSize: 13.5 }}>Research INFY</GhostBtn>
                <GhostBtn full={false} onClick={() => go("sagereport")} style={{ flex: 1, padding: "11px 14px", fontSize: 13.5 }} icon="file">Last report</GhostBtn>
              </div>
            </Card>
            <SecHead label="Recent chats" right={<button onClick={() => go("chathistory")} style={{ border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--emerald-text)", cursor: "pointer", letterSpacing: 0.5 }}>ALL →</button>} />
            <ListCard>
              {SAGE_HISTORY.slice(0, 3).map((c, i) => (
                <RowItem key={c.id} last={i === 2} onClick={() => c.research ? go("sagereport") : ask(c.title)}
                  left={<span style={{ width: 32, height: 32, borderRadius: 9, border: "2px solid var(--ink)", background: c.research ? "var(--pop-5)" : "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={c.research ? "brain" : "msg"} size={15} color="var(--ink-2)" /></span>}
                  title={c.title} sub={`${c.when} · ${c.n} messages`} />
              ))}
            </ListCard>
          </>
        ) : (
          <div style={{ paddingTop: 14 }}>
            {msgs.map((m, i) => m.role === "u" ? (
              <div key={i} style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
                <div style={{ maxWidth: "82%", border: "2px solid var(--ink)", borderRadius: "14px 4px 14px 14px", background: "var(--ink)", color: "var(--paper)", padding: "10px 14px", fontSize: 13.5, fontWeight: 600, lineHeight: 1.5 }}>{m.text}</div>
              </div>
            ) : (
              <SageBubble key={i} msg={m} onChip={(c) => ask(c)} />
            ))}
            {msgs.length > 1 && !msgs[msgs.length - 1].streaming && (
              <Press onClick={researchConfirm}>
                <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 10, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--pop-2)", padding: "11px 14px", boxShadow: "3px 3px 0 var(--ink)" }}>
                  <Icon name="brain" size={17} color="#1d1d1b" />
                  <span style={{ flex: 1, fontSize: 12.5, fontWeight: 800, color: "#1d1d1b" }}>Go deeper — run full research on INFY</span>
                  <CostChip n={2} style={{ background: "#fbf8eb" }} />
                </div>
              </Press>
            )}
          </div>
        )}
      </div>
      {/* composer */}
      <div style={{ flexShrink: 0, padding: "10px 16px 12px", borderTop: "2px solid var(--ink)", background: "var(--paper)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", padding: "4px 6px 4px 14px", boxShadow: "3px 3px 0 var(--ink)" }}>
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && ask(input)}
            placeholder="Ask anything about your money…"
            style={{ flex: 1, border: 0, outline: 0, background: "transparent", padding: "10px 0", fontSize: 14, color: "var(--ink)", fontFamily: "var(--font-sans)", minWidth: 0 }} />
          <button onClick={() => ask(input)} style={{ width: 38, height: 38, borderRadius: 10, border: "2px solid var(--ink)", background: input.trim() ? "var(--emerald)" : "var(--paper-2)", display: "grid", placeItems: "center", cursor: "pointer", transition: "background .15s" }}>
            <Icon name="send" size={16} color={input.trim() ? "#0b0b09" : "var(--ink-3)"} />
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 7, justifyContent: "space-between" }}>
          <button onClick={() => um.setSheet({ title: "Model", body: <ModelSheet /> })} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1.5px solid var(--rule-soft)", background: "var(--paper-3)", borderRadius: 99, padding: "4px 10px", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--ink-2)", letterSpacing: 0.5 }}>
            AUTO · GEMINI 2.5 <Icon name="chevronD" size={11} color="var(--ink-3)" />
          </button>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4 }}>READS YOUR PORTFOLIO · NOT ADVICE</span>
        </div>
      </div>
    </div>
  );
}

function ModelSheet() {
  const MODELS = [
    { n: "Auto", d: "Routes by task — Flash for chat, Pro for research", on: true, x: "×1" },
    { n: "Gemini 2.5 Pro", d: "Deepest reasoning, slower", x: "×1" },
    { n: "Gemini 2.5 Flash", d: "Fast answers, light tasks", x: "×0.5" },
    { n: "Claude / GPT", d: "Founder allowlist — coming to Premium", lock: true, x: "×2" },
  ];
  return (
    <div>
      {MODELS.map((m, i) => (
        <div key={m.n} style={{ display: "flex", alignItems: "center", gap: 11, padding: "12px 2px", borderBottom: i < MODELS.length - 1 ? "1.5px solid var(--rule-soft)" : "none", opacity: m.lock ? 0.55 : 1 }}>
          <span style={{ width: 20, height: 20, borderRadius: 99, border: "2px solid var(--ink)", background: m.on ? "var(--emerald)" : "var(--paper-3)", display: "grid", placeItems: "center", flexShrink: 0 }}>
            {m.on && <Icon name="check" size={11} color="#0b0b09" strokeWidth={3.4} />}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: "var(--ink)", display: "flex", alignItems: "center", gap: 7 }}>{m.n}{m.lock && <Icon name="lock" size={12} color="var(--ink-3)" />}</div>
            <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 1 }}>{m.d}</div>
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--ink-2)", border: "1.5px solid var(--rule-soft)", borderRadius: 6, padding: "2px 7px" }}>{m.x}</span>
        </div>
      ))}
      <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.4 }}>CREDIT MULTIPLIER APPLIES TO DEEP RESEARCH ONLY.</p>
    </div>
  );
}

function ResearchConfirm({ cost, um, onRun }) {
  const [personal, setPersonal] = sgS(true);
  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <SymTile sym="INFY" size={40} />
        <div>
          <div style={{ fontWeight: 800, fontSize: 15, color: "var(--ink)" }}>Infosys · deep research</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>~2 MIN · READS FILINGS, CALLS, QUOTES + YOUR LOTS</div>
        </div>
      </div>
      <div style={{ marginTop: 14, border: "1.5px dashed var(--rule-soft)", borderRadius: 11, padding: "11px 13px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink)" }}>Personalise with my portfolio</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 1 }}>Position sizing, tax lots & concentration included</div>
        </div>
        <button onClick={() => setPersonal(p => !p)} style={{ width: 46, height: 27, borderRadius: 99, border: "2px solid var(--ink)", background: personal ? "var(--emerald)" : "var(--paper-2)", position: "relative", cursor: "pointer", transition: "background .15s" }}>
          <span style={{ position: "absolute", top: 2, left: personal ? 21 : 2, width: 19, height: 19, borderRadius: 99, background: "var(--paper)", border: "2px solid var(--ink)", transition: "left .15s" }} />
        </button>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--ink-2)" }}>COST</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CostChip n={cost} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>→ {um.credits - cost} left after</span>
        </span>
      </div>
      <div style={{ marginTop: 16 }}>
        <PrimaryBtn onClick={onRun}>Run research</PrimaryBtn>
      </div>
    </div>
  );
}

// ── Research progress ───────────────────────────────────────────────────────
function SageResearchScreen({ go, back, um }) {
  const [step, setStep] = sgS(0);
  const STEPS = [
    { t: "Reading your position", d: "120 sh · 2 brokers · FIFO lots loaded" },
    { t: "Pulling filings & call transcripts", d: "Q1 FY27 call · annual report FY26" },
    { t: "Fetching market data", d: "NSE quotes · peer multiples · 5Y bands" },
    { t: "Cross-checking numbers", d: "2-model consensus on extracted figures" },
    { t: "Writing the report", d: "4 sections · 14 sources cited" },
  ];
  sgE(() => {
    if (step >= STEPS.length) { const t = setTimeout(() => go("sagereport", { replace: true }), 500); return () => clearTimeout(t); }
    const t = setTimeout(() => setStep(s => s + 1), step === 0 ? 900 : 1100);
    return () => clearTimeout(t);
  }, [step]);
  return (
    <SubPage um={um} title="Deep research · INFY" onBack={back} right={<CostChip n={2} />}>
      <div style={{ paddingTop: 22 }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 26 }}>
          <Sticker rotate={-3}>reading so <b>you</b> don't have to…</Sticker>
        </div>
        <ProgressSteps steps={STEPS} current={step} />
        <p style={{ marginTop: 22, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.5, textAlign: "center" }}>YOU CAN LEAVE — WE'LL NOTIFY YOU WHEN IT'S READY.</p>
      </div>
    </SubPage>
  );
}

// ── Research report ─────────────────────────────────────────────────────────
function SageReportScreen({ go, back, um }) {
  const R = RESEARCH_REPORT;
  return (
    <SubPage um={um} title={`Research · ${R.sym}`} onBack={back}
      right={<button onClick={() => um.toast("Report link copied")} style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}><Icon name="external" size={15} color="var(--ink)" /></button>}>
      <div style={{ paddingTop: 14 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, letterSpacing: 1, background: "var(--pop-2)", border: "2px solid var(--ink)", borderRadius: 7, padding: "4px 10px", color: "#1d1d1b" }}>{R.verdict}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 0.5 }}>CONVICTION {R.conviction}/100 · {R.date}</span>
        </div>
        <h1 style={{ fontWeight: 800, fontSize: 23, lineHeight: 1.1, letterSpacing: -0.8, margin: "12px 0 0", color: "var(--ink)" }}>{R.title}</h1>
        <div style={{ marginTop: 10, height: 10, border: "1.5px solid var(--ink)", borderRadius: 99, background: "var(--paper-2)", overflow: "hidden" }}>
          <div style={{ width: R.conviction + "%", height: "100%", background: "var(--emerald)" }} />
        </div>
        <Card style={{ marginTop: 16 }} bg="var(--paper-2)">
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--emerald-text)" }}>● TL;DR — YOUR POSITION</div>
          <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.6, color: "var(--ink)" }}>{R.summary}</p>
        </Card>
        {R.sections.map((s, i) => (
          <div key={i} style={{ marginTop: 18 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 9 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--paper)", background: "var(--ink)", borderRadius: 6, padding: "2px 7px", transform: "rotate(-1deg)" }}>{String(i + 1).padStart(2, "0")}</span>
              <h2 style={{ margin: 0, fontWeight: 800, fontSize: 16.5, letterSpacing: -0.4, color: "var(--ink)" }}>{s.h}</h2>
            </div>
            <p style={{ margin: "8px 0 0", fontSize: 13.5, lineHeight: 1.62, color: "var(--ink-2)" }}>{s.body}</p>
            <SrcChips srcs={s.srcs} />
          </div>
        ))}
        <div style={{ marginTop: 20, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Tag>{R.sources} sources</Tag><Tag>ran {R.duration}</Tag><Tag>cost {R.cost} credits</Tag><Tag>personalised</Tag>
        </div>
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 9 }}>
          <PrimaryBtn onClick={() => { um.setSagePrefill("Follow-up on the INFY report: what breaks the thesis?"); go("sage"); }}>Ask a follow-up</PrimaryBtn>
          <GhostBtn icon="eye" onClick={() => go("stock:INFY")}>Open INFY page</GhostBtn>
        </div>
        <p style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4, lineHeight: 1.6 }}>EDUCATION, NOT ADVICE. NUMBERS ARE COMPUTED FROM CITED SOURCES OR YOUR OWN TRADEBOOK — NEVER GUESSED.</p>
      </div>
    </SubPage>
  );
}

// ── Chat history ────────────────────────────────────────────────────────────
function ChatHistoryScreenV2({ go, back, um }) {
  return (
    <SubPage um={um} title="Chat history" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <ListCard>
          {SAGE_HISTORY.map((c, i) => (
            <RowItem key={c.id} last={i === SAGE_HISTORY.length - 1} onClick={() => c.research ? go("sagereport") : (um.setSagePrefill(c.title), go("sage"))}
              left={<span style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: c.research ? "var(--pop-5)" : "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={c.research ? "brain" : "msg"} size={16} color="var(--ink-2)" /></span>}
              title={c.title} sub={`${c.when} · ${c.n} messages${c.research ? " · deep research" : ""}`} />
          ))}
        </ListCard>
        <p style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.4 }}>CHATS ARE REMEMBERED TO PERSONALISE SAGE. MANAGE IN SETTINGS → MEMORY.</p>
      </div>
    </SubPage>
  );
}

Object.assign(window, { SageScreenV2, SageResearchScreen, SageReportScreen, ChatHistoryScreenV2, SrcChips });
