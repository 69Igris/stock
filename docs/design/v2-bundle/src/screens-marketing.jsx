// ─────────────────────────────────────────────────────────────────────────
// Marketing screens — Features, Security, About, Compare, Roadmap, Changelog
// Content lifted/condensed from the stockbook-monorepo marketing routes.
// ─────────────────────────────────────────────────────────────────────────

function MHead({ eyebrow, h, lede, color }) {
  return (
    <div>
      <Eyebrow color={color}>{eyebrow}</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 32, lineHeight: 1.02, letterSpacing: -1.5, marginTop: 12, color: "var(--ink)", textWrap: "balance" }}>{h}</h1>
      {lede && <p style={{ marginTop: 12, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 17, lineHeight: 1.4, color: "var(--ink-2)", textWrap: "pretty" }}>{lede}</p>}
    </div>
  );
}
function NumTag({ children }) {
  return <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1.5, marginBottom: 8 }}>{children}</div>;
}

// ── Features ────────────────────────────────────────────────────────────────
function FeaturesScreen({ go, back }) {
  const feats = [
    { i: "layers", c: "var(--pop-3)", t: "Multi-broker sync", d: "8 brokers, read-only OAuth. Holdings, tradebook & positions — reconciled, FIFO-paired." },
    { i: "sparkles", c: "var(--pop-5)", t: "StockSage AI", d: "Gemini 2.5 Pro + Flash. Cited, auditable, portfolio-aware research & chat." },
    { i: "flame", c: "var(--pop-1)", t: "Portfolio Roast", d: "An honest AI score & critique of your holdings — concentration, risk, fees." },
    { i: "chart", c: "var(--pop-2)", t: "FIRE calculator", d: "Retirement planning in ₹ — STCG, LTCG, PPF & EPF aware." },
    { i: "target", c: "var(--emerald)", t: "Paper trade & backtest", d: "Test strategies on live NSE ticks before you risk a rupee." },
    { i: "search", c: "var(--pop-4)", t: "Discovery & screener", d: "7,000+ instruments and 14,000+ mutual funds, filtered your way." },
    { i: "file", c: "var(--pop-3)", t: "Tax & risk reports", d: "ITR-2 capital-gains export and a full portfolio risk read-out." },
  ];
  return (
    <Screen onBack={back} topPad={60} footer={<PrimaryBtn onClick={() => go("signup")}>Start free — no card</PrimaryBtn>}>
      <MHead eyebrow="FEATURES · ONE WORKSPACE" h={<>Everything your money <span className="hl-gold">needs.</span> <span className="ser">Nothing it doesn't.</span></>} lede="Every broker, one AI workspace — built for Indian retail investors." />
      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 11 }}>
        {feats.map(f => (
          <div key={f.t} style={{ display: "flex", gap: 13, alignItems: "flex-start", padding: 15, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "3px 3px 0 var(--ink)" }}>
            <span style={{ width: 42, height: 42, borderRadius: 11, background: f.c, border: "2px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={f.i} size={21} color="#1d1d1b" /></span>
            <div><div style={{ fontSize: 15.5, fontWeight: 800, color: "var(--ink)", letterSpacing: -0.3 }}>{f.t}</div><div style={{ fontSize: 13.5, color: "var(--ink-2)", marginTop: 2, lineHeight: 1.45 }}>{f.d}</div></div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

// ── Security ────────────────────────────────────────────────────────────────
function SecurityScreen({ go, back }) {
  const pillars = [
    { i: "lock", t: "Official OAuth, eight brokers", d: "No scrapers, no screen automation — only official broker APIs.", m: "OAUTH · READ-ONLY SCOPE" },
    { i: "shield", t: "No passwords stored. Ever.", d: "We store only the encrypted OAuth token. Your password never enters our servers.", m: "TOKEN · AES-256 ENCRYPTED" },
    { i: "x", t: "Cannot place orders, by design", d: "The order-placement scope is never requested. Broker-enforced, not just our promise.", m: "SCOPE-RESTRICTED" },
  ];
  const nos = ["We never sell your data.", "We never place trades on your behalf.", "We never use your portfolio or chats to train AI models.", "We never share identifiable data with other users."];
  return (
    <Screen onBack={back} topPad={60} footer={<PrimaryBtn onClick={() => go("broker")}>Connect a broker safely</PrimaryBtn>}>
      <MHead eyebrow="SECURITY AT USEMONEY" h={<>We never <span className="strike">place trades.</span> <span className="ser">The rest matches.</span></>} lede="Read-only OAuth. AES-256-GCM per-user encryption. TLS 1.2+. Never used to train AI." />

      <NumTag>{""}</NumTag>
      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 11 }}>
        {pillars.map(p => (
          <div key={p.t} style={{ padding: 15, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 36, height: 36, borderRadius: 9, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", display: "grid", placeItems: "center" }}><Icon name={p.i} size={18} color="var(--emerald-text)" /></span>
              <span style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>{p.t}</span>
            </div>
            <p style={{ marginTop: 9, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>{p.d}</p>
            <div style={{ marginTop: 9, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1 }}>{p.m}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, padding: 16, background: "var(--ink)", color: "var(--paper)", borderRadius: 14, boxShadow: "4px 4px 0 var(--pop-1)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--pop-2)", letterSpacing: 1.5 }}>FOUR HARD NOS</div>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
          {nos.map(n => (
            <div key={n} style={{ display: "flex", gap: 9, alignItems: "flex-start", fontSize: 13.5, lineHeight: 1.4 }}>
              <Icon name="x" size={15} color="var(--pop-1)" strokeWidth={3} style={{ flexShrink: 0, marginTop: 1 }} />
              <span style={{ color: "var(--paper)" }}>{n}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {[["Encryption", "AES-256-GCM, per-user keys. TLS 1.2+ in transit, HSTS enforced."], ["Infrastructure", "MongoDB Atlas · Google Cloud (us-central1) · Vercel. Auth via Clerk."], ["AI engine", "Google Gemini via Vertex AI. Anonymised context only — never your name or credentials."], ["Compliance", "Pre-RIA — SEBI IA registration in motion. We won't claim SOC 2 / ISO until earned."]].map(([l, d]) => (
          <div key={l} style={{ display: "flex", gap: 12, padding: "12px 0", borderBottom: "1.5px solid var(--rule-soft)" }}>
            <span style={{ width: 96, flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 0.5, textTransform: "uppercase" }}>{l}</span>
            <span style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>{d}</span>
          </div>
        ))}
      </div>
    </Screen>
  );
}

// ── About ───────────────────────────────────────────────────────────────────
function AboutScreen({ go, back }) {
  return (
    <Screen onBack={back} topPad={60} footer={<PrimaryBtn onClick={() => go("signup")}>Join us — start free</PrimaryBtn>}>
      <MHead eyebrow="ABOUT · BOOTSTRAPPED, IN PUBLIC" h={<>Built because <span className="strike">spreadsheets</span> <span className="ser">aren't a plan.</span></>} />
      <div style={{ marginTop: 18 }}>
        <Sticker rotate={-2} style={{ display: "inline-block" }}>"Five broker tabs and a Google sheet is not how anyone should run a portfolio."</Sticker>
      </div>
      <p style={{ marginTop: 20, fontSize: 15, lineHeight: 1.6, color: "var(--ink-2)" }}>
        We started UseMoney because that's exactly how we ran ours. Eight brokers between us, no single source of truth, and AI tools that had never actually read our holdings.
      </p>
      <p style={{ marginTop: 14, fontSize: 15, lineHeight: 1.6, color: "var(--ink-2)" }}>
        So we built the workspace we wanted: every broker synced read-only, an AI that cites its sources, and honest numbers in ₹. We're bootstrapped and we build in public — the roadmap is live, dates are honest.
      </p>

      <div style={{ marginTop: 22, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {[["12,840", "USERS"], ["8", "BROKERS"], ["4.2 M", "TRADES SYNCED"], ["99.98%", "UPTIME · 90D"]].map(([v, l]) => (
          <div key={l} style={{ padding: 16, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 26, color: "var(--ink)", letterSpacing: -0.5 }}>{v}</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1.2, marginTop: 2 }}>{l}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 18, padding: 15, background: "var(--emerald-bg)", border: "2px solid var(--emerald)", borderRadius: 13 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>We read every email.</div>
        <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>The roadmap follows what users actually use. Email <span style={{ fontFamily: "var(--font-mono)", color: "var(--emerald-text)" }}>hello@usemoney.ai</span> with what you'd ship first.</div>
      </div>
      <div style={{ marginTop: 14, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)", letterSpacing: 1, textAlign: "center" }}>BY DIS DIGITAL LLP · MADE IN INDIA</div>
    </Screen>
  );
}

// ── Compare / Alternatives ──────────────────────────────────────────────────
function CompareScreen({ go, back }) {
  const rows = [
    ["Every broker in one view", true, false, false],
    ["AI that read your portfolio", true, false, false],
    ["Cited, auditable answers", true, false, false],
    ["Read-only · can't place orders", true, true, false],
    ["FIRE & tax in ₹", true, false, false],
    ["Always up to date", true, false, true],
  ];
  const cols = ["UseMoney", "Broker app", "Spreadsheet"];
  return (
    <Screen onBack={back} topPad={60} footer={<PrimaryBtn onClick={() => go("signup")}>Switch to UseMoney</PrimaryBtn>}>
      <MHead eyebrow="WHY USEMONEY" h={<>The honest <span className="hl-gold">comparison.</span></>} lede="What a single-broker app and a spreadsheet can't do." />
      <div style={{ marginTop: 22, border: "2px solid var(--ink)", borderRadius: 14, overflow: "hidden", boxShadow: "4px 4px 0 var(--ink)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr", background: "var(--ink)", color: "var(--paper)" }}>
          <div style={{ padding: "11px 12px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 0.5 }}></div>
          {cols.map((c, i) => <div key={c} style={{ padding: "11px 6px", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, textAlign: "center", letterSpacing: 0.3, color: i === 0 ? "var(--pop-2)" : "var(--paper)" }}>{c}</div>)}
        </div>
        {rows.map((r, k) => (
          <div key={k} style={{ display: "grid", gridTemplateColumns: "1.5fr 1fr 1fr 1fr", background: k % 2 ? "var(--paper-2)" : "var(--paper-3)", borderTop: "1.5px solid var(--rule-soft)" }}>
            <div style={{ padding: "12px 12px", fontSize: 12.5, fontWeight: 600, color: "var(--ink)", lineHeight: 1.3 }}>{r[0]}</div>
            {[r[1], r[2], r[3]].map((v, i) => (
              <div key={i} style={{ display: "grid", placeItems: "center", padding: "12px 0" }}>
                {v ? <span style={{ width: 24, height: 24, borderRadius: 99, background: i === 0 ? "var(--emerald)" : "var(--ink-3)", display: "grid", placeItems: "center" }}><Icon name="check" size={14} color="#fff" strokeWidth={3} /></span>
                  : <Icon name="x" size={16} color="var(--rule-soft)" strokeWidth={2.5} />}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 16, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", lineHeight: 1.5 }}>Migrate in 60 seconds. Your data stays yours.</div>
    </Screen>
  );
}

// ── Roadmap ─────────────────────────────────────────────────────────────────
function RoadmapScreen({ go, back }) {
  const rel = [
    { v: "Now shipping", date: "MAY 2026", tag: "SHIPPING", tagc: "var(--emerald)", h: "The big repositioning.", items: ["Playful design system across the app", "StockSage 3-pane chat", "Newsletter + public roadmap", "Eight brokers staged · Zerodha in beta"] },
    { v: "SEBI & Live charts", date: "JUNE 2026", tag: "SCHEDULED", tagc: "var(--pop-3)", h: "Registration in motion.", items: ["All 8 brokers → Live", "SEBI IA filing submitted", "BSE live data feed", "Strategy builder backtest UI"] },
    { v: "Alerts & Strategy v2", date: "JULY 2026", tag: "PLANNED", tagc: "var(--pop-2)", h: "Alerts you can act on.", items: ["Email + push alerts", "60+ pre-built strategies", "Live source citations", "Earnings calendar v2"] },
    { v: "Mobile beta & Tax v2", date: "AUG 2026", tag: "PLANNED", tagc: "var(--pop-2)", h: "Mobile, in your pocket.", items: ["iOS + Android beta · read-only", "ITR-2 capital-gains export", "Per-broker XIRR + CAGR", "Macro tab: FII/DII, RBI, USD/INR"] },
  ];
  return (
    <Screen onBack={back} topPad={60} footer={<GhostBtn icon={null} onClick={() => go("changelog")}>See what shipped →</GhostBtn>}>
      <MHead eyebrow="ROADMAP · UPDATED AS WE SHIP" h={<>Three months out. <span className="ser">Honestly.</span></>} lede="No quarterly fantasy. Just what we're building, with a bias to ship." />
      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
        {rel.map(r => (
          <div key={r.v} style={{ padding: 16, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "3px 3px 0 var(--ink)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1 }}>{r.date}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 1, color: "#1d1d1b", background: r.tagc, border: "1.5px solid var(--ink)", borderRadius: 99, padding: "3px 8px" }}>{r.tag}</span>
            </div>
            <div style={{ marginTop: 8, fontWeight: 800, fontSize: 17, color: "var(--ink)", letterSpacing: -0.4 }}>{r.h}</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 7 }}>
              {r.items.map(it => (
                <div key={it} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>
                  <Icon name="check" size={13} color="var(--emerald-text)" strokeWidth={2.6} style={{ flexShrink: 0, marginTop: 2 }} />{it}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

// ── Changelog ───────────────────────────────────────────────────────────────
function ChangelogScreen({ go, back }) {
  const rel = [
    { ver: "v3.0", date: "MAY 2026", h: "Playful, everywhere.", tags: [["Added", "var(--emerald)"]], items: ["Playful design system on every page", "AI-first homepage + newsletter", "Eight brokers staged"] },
    { ver: "v2.8", date: "APR 2026", h: "StockSage gets cited.", tags: [["Added", "var(--emerald)"], ["Fixed", "var(--pop-3)"]], items: ["Source citations on every research card", "Portfolio Roast v2", "Faster Flash-first routing"] },
    { ver: "v2.6", date: "MAR 2026", h: "Tax season, sorted.", tags: [["Added", "var(--emerald)"]], items: ["ITR-2 capital-gains export", "FIFO trade pairing", "Per-broker XIRR"] },
    { ver: "v2.4", date: "FEB 2026", h: "Paper trading is live.", tags: [["Added", "var(--emerald)"], ["Fixed", "var(--pop-3)"]], items: ["Paper trade on live NSE ticks", "Backtest engine", "Watchlist sync fixes"] },
  ];
  return (
    <Screen onBack={back} topPad={60} footer={<GhostBtn icon={null} onClick={() => go("roadmap")}>See what's next →</GhostBtn>}>
      <MHead eyebrow="CHANGELOG · WHAT SHIPPED" h={<>Every release, <span className="ser">in public.</span></>} />
      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 0 }}>
        {rel.map((r, k) => (
          <div key={r.ver} style={{ display: "flex", gap: 14 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
              <span style={{ width: 14, height: 14, borderRadius: 99, background: k === 0 ? "var(--emerald)" : "var(--paper-3)", border: "2px solid var(--ink)", marginTop: 4 }} />
              {k < rel.length - 1 && <span style={{ flex: 1, width: 2, background: "var(--rule-soft)", marginTop: 4 }} />}
            </div>
            <div style={{ paddingBottom: 22, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 15, color: "var(--ink)" }}>{r.ver}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1 }}>{r.date}</span>
                {r.tags.map(([t, c]) => <span key={t} style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, color: "#1d1d1b", background: c, borderRadius: 99, padding: "2px 7px" }}>{t.toUpperCase()}</span>)}
              </div>
              <div style={{ marginTop: 6, fontWeight: 800, fontSize: 16, color: "var(--ink)", letterSpacing: -0.3 }}>{r.h}</div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
                {r.items.map(it => <div key={it} style={{ display: "flex", gap: 7, alignItems: "flex-start", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}><span style={{ color: "var(--ink-4)", marginTop: -1 }}>›</span>{it}</div>)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </Screen>
  );
}

Object.assign(window, { FeaturesScreen, SecurityScreen, AboutScreen, CompareScreen, RoadmapScreen, ChangelogScreen });
