// ─────────────────────────────────────────────────────────────────────────
// Content & legal screens — Blog, Docs, Glossary (list+detail), Newsletter,
// Unsubscribe, Legal hub + docs, 404, Invite/claim, SSO redirect.
// ─────────────────────────────────────────────────────────────────────────
const { useState, useEffect } = React;

function MHead2({ eyebrow, h, lede, color }) {
  return (
    <div>
      <Eyebrow color={color}>{eyebrow}</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 31, lineHeight: 1.04, letterSpacing: -1.4, marginTop: 12, color: "var(--ink)", textWrap: "balance" }}>{h}</h1>
      {lede && <p style={{ marginTop: 11, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 16.5, lineHeight: 1.4, color: "var(--ink-2)" }}>{lede}</p>}
    </div>
  );
}

// ── Blog (list + post) ──────────────────────────────────────────────────────
const BLOG = [
  { tag: "PORTFOLIO", read: "6 MIN", t: "How concentrated is too concentrated?", ex: "A practical rule for sector and single-stock limits — and how Sage flags them.", body: ["Concentration risk is the quiet killer of retail portfolios. When one stock or one sector dominates, a single bad quarter can wipe out a year of gains.", "Our rule of thumb: no single stock above 10% of equity, no single sector above 25%. StockSage watches both and nudges you when you drift past the line you set.", "The fix isn't always to sell. Sometimes it's to let new contributions flow elsewhere until the weights rebalance themselves."] },
  { tag: "TAXES", read: "8 MIN", t: "STCG vs LTCG: the ₹1 lakh question", ex: "When to book, when to hold, and how the ₹1.25L LTCG exemption actually works.", body: ["Short-term capital gains (held under 1 year) are taxed at 20%. Long-term gains above ₹1.25 lakh a year are taxed at 12.5%.", "That gap is real money. Holding a winner past the one-year mark, and harvesting gains up to the exemption each year, can meaningfully cut your bill.", "UseMoney's tradebook is FIFO-paired, so it knows exactly which lots qualify. The tax report does the math for ITR-2."] },
  { tag: "AI", read: "5 MIN", t: "Why we cite every answer", ex: "Generic AI tips are worthless for money. Here's how StockSage stays auditable.", body: ["An AI that can't show its work has no business near your portfolio. Every StockSage answer links to the source — your tradebook, a filing, a live quote.", "That means you can verify before you act. Nothing is a recommendation; everything is grounded.", "It's slower to build than a chatbot that bluffs. We think it's the only honest way to do this."] },
];
function BlogScreen({ go, back }) {
  const [post, setPost] = useState(null);
  if (post != null) {
    const p = BLOG[post];
    return (
      <Screen onBack={() => setPost(null)} topPad={60}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--emerald-text)", letterSpacing: 1 }}>{p.tag}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>· {p.read} READ</span>
        </div>
        <h1 style={{ fontWeight: 800, fontSize: 28, lineHeight: 1.1, letterSpacing: -1.2, marginTop: 10, color: "var(--ink)" }}>{p.t}</h1>
        <div style={{ marginTop: 14, height: 140, borderRadius: 14, background: "var(--paper-2)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", boxShadow: "3px 3px 0 var(--ink)" }}>
          <Icon name="file" size={40} color="var(--ink-3)" />
        </div>
        {p.body.map((para, i) => <p key={i} style={{ marginTop: 16, fontSize: 15, lineHeight: 1.65, color: "var(--ink-2)" }}>{para}</p>)}
        <div style={{ marginTop: 22 }}><GhostBtn icon={null} onClick={() => go("newsletter")}>Get posts like this →</GhostBtn></div>
      </Screen>
    );
  }
  return (
    <Screen onBack={back} topPad={60}>
      <MHead2 eyebrow="BLOG · WRITING ON MONEY" h={<>Notes on <span className="hl-gold">your money,</span> <span className="ser">in public.</span></>} />
      <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 12 }}>
        {BLOG.map((b, i) => (
          <button key={b.t} onClick={() => setPost(i)} style={{ textAlign: "left", padding: 16, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, color: "var(--emerald-text)", letterSpacing: 1 }}>{b.tag}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>· {b.read}</span>
            </div>
            <div style={{ marginTop: 7, fontWeight: 800, fontSize: 17, color: "var(--ink)", letterSpacing: -0.4, lineHeight: 1.15 }}>{b.t}</div>
            <div style={{ marginTop: 6, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.45 }}>{b.ex}</div>
            <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--emerald-text)" }}>Read →</div>
          </button>
        ))}
      </div>
    </Screen>
  );
}

// ── Docs (list + article) ───────────────────────────────────────────────────
const DOCS = {
  "Getting started": [
    { t: "Create your account", body: ["Sign up with email or Google. Verify the 6-digit code we email you, and you're in — no card needed.", "New accounts land on the dashboard with 5 free Sage credits a month."] },
    { t: "Connect your first broker", body: ["Go to Brokers, pick yours, and authorise via the broker's own OAuth screen. We receive a read-only token — never your password.", "Holdings and tradebook sync within seconds and reconcile automatically."] },
  ],
  "StockSage": [
    { t: "Free chat vs deep research", body: ["Simple chats are free. Deep research spends 1–3 credits depending on depth (L1 Flash to L4 advanced).", "Every answer is cited so you can verify before acting."] },
    { t: "Slash commands & mentions", body: ["Type / for 24 commands, or @ to mention a holding, watchlist, or document as context.", "Sage is portfolio-aware by default — it has already read your holdings."] },
  ],
  "Tools": [
    { t: "FIRE calculator", body: ["Plan retirement in ₹. The calculator is STCG, LTCG, PPF and EPF aware and projects your FIRE number and age.", "Adjust contributions and return assumptions to see the timeline shift live."] },
    { t: "Paper trading & backtest", body: ["Test strategies on live NSE ticks without risking capital. Backtest walk-forward on historical data.", "Promote a paper strategy to a watchlist when you're confident."] },
  ],
};
function DocsScreen({ go, back }) {
  const [art, setArt] = useState(null);
  const groups = Object.keys(DOCS);
  if (art) {
    const [g, i] = art;
    const a = DOCS[g][i];
    return (
      <Screen onBack={() => setArt(null)} topPad={60}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1 }}>DOCS · {g.toUpperCase()}</div>
        <h1 style={{ fontWeight: 800, fontSize: 27, lineHeight: 1.1, letterSpacing: -1.2, marginTop: 10, color: "var(--ink)" }}>{a.t}</h1>
        {a.body.map((para, k) => <p key={k} style={{ marginTop: 15, fontSize: 15, lineHeight: 1.65, color: "var(--ink-2)" }}>{para}</p>)}
        <div style={{ marginTop: 22, padding: 14, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 12, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Still stuck? Email <span style={{ fontFamily: "var(--font-mono)", color: "var(--emerald-text)" }}>hello@usemoney.ai</span> — we read every one.
        </div>
      </Screen>
    );
  }
  return (
    <Screen onBack={back} topPad={60}>
      <MHead2 eyebrow="DOCS · HOW IT WORKS" h={<>Everything, <span className="ser">documented.</span></>} />
      <div style={{ marginTop: 18, display: "flex", alignItems: "center", gap: 9, padding: "11px 14px", border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)" }}>
        <Icon name="search" size={16} color="var(--ink-3)" /><span style={{ fontSize: 13.5, color: "var(--ink-3)" }}>Search the docs…</span>
      </div>
      {groups.map(g => (
        <div key={g} style={{ marginTop: 20 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1.2 }}>{g.toUpperCase()}</div>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 9 }}>
            {DOCS[g].map((a, i) => (
              <button key={a.t} onClick={() => setArt([g, i])} style={{ display: "flex", alignItems: "center", gap: 11, padding: 14, textAlign: "left", background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 12, boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
                <Icon name="file" size={17} color="var(--ink-3)" />
                <span style={{ flex: 1, fontSize: 14.5, fontWeight: 700, color: "var(--ink)" }}>{a.t}</span>
                <Icon name="chevronR" size={16} color="var(--ink-3)" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </Screen>
  );
}

// ── Glossary (list + term) ──────────────────────────────────────────────────
const GLOSSARY = [
  { t: "XIRR", d: "Extended Internal Rate of Return — your portfolio's true annualised return accounting for the timing of every cash flow (SIPs, lump sums, withdrawals)." },
  { t: "STCG", d: "Short-Term Capital Gains — profit on assets held under 12 months, taxed at 20% for listed equity in India." },
  { t: "LTCG", d: "Long-Term Capital Gains — profit on listed equity held 12 months+. Taxed at 12.5% above the ₹1.25 lakh annual exemption." },
  { t: "FIFO", d: "First In, First Out — the lot-matching method used to pair buys with sells when computing realised gains." },
  { t: "FIRE", d: "Financial Independence, Retire Early — a target corpus (often 25–30× annual expenses) that lets investment income cover your life." },
  { t: "PE ratio", d: "Price-to-Earnings — a stock's price divided by earnings per share. A quick gauge of how richly a stock is valued." },
  { t: "Basis points", d: "One hundredth of a percent (0.01%). 340 bps = 3.40%. Used for precise changes in rates and returns." },
];
function GlossaryScreen({ go, back }) {
  const [term, setTerm] = useState(null);
  if (term != null) {
    const g = GLOSSARY[term];
    return (
      <Screen onBack={() => setTerm(null)} topPad={60}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 1 }}>GLOSSARY</div>
        <h1 style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 40, letterSpacing: -1.5, marginTop: 10, color: "var(--ink)" }}>{g.t}</h1>
        <p style={{ marginTop: 14, fontSize: 16, lineHeight: 1.6, color: "var(--ink-2)" }}>{g.d}</p>
        <div style={{ marginTop: 24, padding: 15, background: "var(--pop-2)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", transform: "rotate(-0.5deg)" }}>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15, color: "#1d1d1b" }}>Ask Sage to apply <strong style={{ fontStyle: "normal" }}>{g.t}</strong> to your own portfolio.</div>
        </div>
      </Screen>
    );
  }
  return (
    <Screen onBack={back} topPad={60}>
      <MHead2 eyebrow="GLOSSARY · PLAIN ENGLISH" h={<>Money words, <span className="ser">unjargoned.</span></>} />
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 9 }}>
        {GLOSSARY.map((g, i) => (
          <button key={g.t} onClick={() => setTerm(i)} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, textAlign: "left", background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 12, boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 14, color: "var(--ink)", minWidth: 64 }}>{g.t}</span>
            <span style={{ flex: 1, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{g.d}</span>
            <Icon name="chevronR" size={15} color="var(--ink-3)" />
          </button>
        ))}
      </div>
    </Screen>
  );
}

// ── Newsletter ──────────────────────────────────────────────────────────────
function NewsletterScreen({ go, back }) {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);
  return (
    <Screen onBack={back} topPad={60}
      footer={done ? <PrimaryBtn icon="arrowR" onClick={() => go("blog")}>Read the latest</PrimaryBtn> : <PrimaryBtn icon="send" disabled={!email} onClick={() => setDone(true)}>Subscribe — free</PrimaryBtn>}>
      <MHead2 eyebrow="NEWSLETTER · WEEKLY LONG-READ" h={done ? <>You're <span className="hl-gold">in.</span></> : <>One <span className="ser">honest</span> email a week.</>} lede={done ? null : "Markets, taxes, and AI for Indian retail — no hype, no spam."} />
      {done ? (
        <div style={{ marginTop: 24, padding: 18, background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 14, boxShadow: "4px 4px 0 var(--ink)", textAlign: "center" }}>
          <span style={{ width: 54, height: 54, borderRadius: 14, background: "var(--emerald)", display: "inline-grid", placeItems: "center", marginBottom: 12 }}><Icon name="check" size={26} color="#fff" strokeWidth={3} /></span>
          <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>Confirmed — {email}</div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.5 }}>First issue lands this Sunday. Unsubscribe in one tap, any time.</div>
        </div>
      ) : (
        <>
          <Field label="Email address" type="email" placeholder="you@email.com" value={email} onChange={setEmail} autoFocus />
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            {["Cited market reads, not hot takes", "Tax & FIRE playbooks in ₹", "Product notes, shipped in public"].map(t => (
              <div key={t} style={{ display: "flex", gap: 9, alignItems: "center", fontSize: 13.5, color: "var(--ink-2)" }}><span style={{ color: "var(--emerald-text)" }}>✦</span>{t}</div>
            ))}
          </div>
        </>
      )}
    </Screen>
  );
}

// ── Unsubscribe ─────────────────────────────────────────────────────────────
function UnsubscribeScreen({ go, back }) {
  const [done, setDone] = useState(false);
  return (
    <Screen onBack={back} topPad={70}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        {done ? (
          <>
            <span style={{ width: 64, height: 64, borderRadius: 16, background: "var(--paper-2)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", boxShadow: "4px 4px 0 var(--ink)" }}><Icon name="mail" size={30} color="var(--ink-3)" /></span>
            <h1 style={{ fontWeight: 800, fontSize: 28, letterSpacing: -1.2, marginTop: 22, color: "var(--ink)" }}>You're <span className="ser">unsubscribed.</span></h1>
            <p style={{ marginTop: 12, fontSize: 14.5, color: "var(--ink-2)", maxWidth: 280, lineHeight: 1.5 }}>No more newsletter emails. Changed your mind?</p>
            <div style={{ marginTop: 18, width: "100%", maxWidth: 280 }}><GhostBtn icon={null} onClick={() => setDone(false)}>Resubscribe</GhostBtn></div>
          </>
        ) : (
          <>
            <Eyebrow color="var(--pop-1-text)">EMAIL PREFERENCES</Eyebrow>
            <h1 style={{ fontWeight: 800, fontSize: 28, letterSpacing: -1.2, marginTop: 14, color: "var(--ink)" }}>Unsubscribe from <span className="ser">the weekly?</span></h1>
            <p style={{ marginTop: 12, fontSize: 14.5, color: "var(--ink-2)", maxWidth: 290, lineHeight: 1.5 }}>You'll still get essential account & security emails. You can resubscribe any time.</p>
            <div style={{ marginTop: 22, width: "100%", maxWidth: 300, display: "flex", flexDirection: "column", gap: 10 }}>
              <PrimaryBtn icon={null} onClick={() => setDone(true)}>Unsubscribe</PrimaryBtn>
              <GhostBtn icon={null} onClick={back}>Keep me subscribed</GhostBtn>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

// ── Legal hub + docs ────────────────────────────────────────────────────────
const LEGAL = {
  privacy: { t: "Privacy Policy", up: "UPDATED MAY 2026", secs: [["What we collect", "Account details (name, email), broker holdings & trades via read-only OAuth, and your chat history with StockSage. We never collect your broker password."], ["How we use it", "To run your portfolio workspace and power Sage. Anonymised context (symbol + quantity) is sent to Gemini for responses — never your name, email, or credentials."], ["What we never do", "We never sell your data, never use it to train AI models, and never share identifiable data with other users."], ["Your control", "Delete your account any time — all data is removed within 30 days. Disconnect a broker to remove its credentials immediately."]] },
  terms: { t: "Terms of Service", up: "UPDATED MAY 2026", secs: [["The service", "UseMoney is a portfolio analytics & research workspace. It is not investment advice and we are not (yet) a SEBI-registered investment adviser."], ["Read-only access", "Broker connections are strictly read-only. UseMoney can never place, modify, or cancel orders on your behalf."], ["Acceptable use", "Don't abuse the API, scrape other users' data, or attempt to place orders through us — it isn't possible by design."], ["Billing", "Free forever plan included. Paid plans bill monthly in ₹ incl. GST and cancel any time."]] },
  risk: { t: "SEBI Risk Disclosure", up: "MANDATORY DISCLOSURE", secs: [["Market risk", "Investments in securities markets are subject to market risks. Read all related documents carefully before investing."], ["Past performance", "Past performance is not indicative of future returns. Nothing in UseMoney is a recommendation to buy or sell."], ["AI outputs", "StockSage outputs are AI-generated and may contain errors. Always verify with cited sources before acting."], ["Not advice", "We are pre-RIA. UseMoney does not provide personalised investment advice."]] },
  data: { t: "Data Usage", up: "UPDATED MAY 2026", secs: [["Encryption", "All sensitive data is encrypted at rest with AES-256-GCM using per-user keys. TLS 1.2+ in transit, HSTS enforced."], ["Where it lives", "MongoDB Atlas, Google Cloud (us-central1), and Vercel. Market data cached in Redis with short TTLs."], ["AI processing", "Chat context is processed by Google Gemini via Vertex AI. Stored chat history is never used for training and is deletable any time."]] },
  subprocessors: { t: "Subprocessors", up: "UPDATED MAY 2026", secs: [["Infrastructure", "Google Cloud Platform (hosting & Vertex AI), Vercel (edge), MongoDB Atlas (database)."], ["Auth & payments", "Clerk (authentication & MFA), and a PCI-compliant payments processor for subscriptions."], ["Market data", "TradingView (charts) and official broker APIs for live quotes and holdings."]] },
};
function LegalDoc({ docKey, back }) {
  const d = LEGAL[docKey];
  return (
    <Screen onBack={back} topPad={60}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--pop-1-text)", letterSpacing: 1.2, fontWeight: 700 }}>{d.up}</div>
      <h1 style={{ fontWeight: 800, fontSize: 30, lineHeight: 1.04, letterSpacing: -1.3, marginTop: 10, color: "var(--ink)" }}>{d.t}</h1>
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
        {d.secs.map(([h, body], i) => (
          <div key={i}>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)" }}>{h}</div>
            <p style={{ marginTop: 6, fontSize: 13.5, lineHeight: 1.6, color: "var(--ink-2)" }}>{body}</p>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 22, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-4)", letterSpacing: 1, textAlign: "center" }}>© 2026 DIS DIGITAL LLP · USEMONEY</div>
    </Screen>
  );
}
function LegalHubScreen({ go, back }) {
  const items = [
    { k: "privacy", i: "shield", t: "Privacy Policy", d: "What we collect & how we use it" },
    { k: "terms", i: "file", t: "Terms of Service", d: "The rules of the road" },
    { k: "risk", i: "scale", t: "SEBI Risk Disclosure", d: "Mandatory market-risk notice" },
    { k: "data", i: "lock", t: "Data Usage", d: "Encryption, storage & AI" },
    { k: "subprocessors", i: "layers", t: "Subprocessors", d: "Third parties we rely on" },
  ];
  return (
    <Screen onBack={back} topPad={60}>
      <MHead2 eyebrow="LEGAL · THE FINE PRINT" h={<>Plain-English <span className="ser">legal.</span></>} color="var(--pop-1-text)" />
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map(it => (
          <button key={it.k} onClick={() => go("legal:" + it.k)} style={{ display: "flex", alignItems: "center", gap: 13, padding: 15, textAlign: "left", background: "var(--paper-3)", border: "2px solid var(--ink)", borderRadius: 13, boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ width: 40, height: 40, borderRadius: 10, background: "var(--paper-2)", border: "1.5px solid var(--ink)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={it.i} size={19} color="var(--ink)" /></span>
            <div style={{ flex: 1 }}><div style={{ fontSize: 14.5, fontWeight: 800, color: "var(--ink)" }}>{it.t}</div><div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{it.d}</div></div>
            <Icon name="chevronR" size={16} color="var(--ink-3)" />
          </button>
        ))}
      </div>
    </Screen>
  );
}

// ── 404 / not found ─────────────────────────────────────────────────────────
function NotFoundScreen({ go, back }) {
  return (
    <Screen onBack={back} topPad={70} footer={<PrimaryBtn icon="home" onClick={() => go("welcome")}>Back to home</PrimaryBtn>}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 84, letterSpacing: -4, color: "var(--ink)", lineHeight: 1 }}>404</div>
        <div style={{ marginTop: 8 }}><Sticker rotate={-3} style={{ display: "inline-block" }}>this page <strong style={{ fontStyle: "normal" }}>doesn't exist.</strong></Sticker></div>
        <p style={{ marginTop: 24, fontSize: 15, color: "var(--ink-2)", maxWidth: 280, lineHeight: 1.5 }}>The page moved, or never existed. Your portfolio is fine — promise.</p>
      </div>
    </Screen>
  );
}

// ── Invite / claim offer ────────────────────────────────────────────────────
function InviteScreen({ go, back }) {
  return (
    <Screen onBack={back} topPad={70} footer={
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <PrimaryBtn icon="arrowR" onClick={() => go("signup")}>Sign in to claim</PrimaryBtn>
        <div style={{ textAlign: "center", fontSize: 11.5, color: "var(--ink-3)" }}>By claiming, you agree to our Terms of Service.</div>
      </div>
    }>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center" }}>
        <span style={{ width: 80, height: 80, borderRadius: 20, background: "var(--pop-4)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", boxShadow: "5px 5px 0 var(--ink)", transform: "rotate(-3deg)" }}>
          <Icon name="star" size={38} color="#1d1d1b" />
        </span>
        <h1 style={{ fontWeight: 800, fontSize: 32, letterSpacing: -1.4, marginTop: 26, color: "var(--ink)" }}>You're <span className="ser">invited.</span></h1>
        <p style={{ marginTop: 12, fontSize: 15, color: "var(--ink-2)", maxWidth: 290, lineHeight: 1.5 }}>You've been invited to join UseMoney with the <strong style={{ color: "var(--ink)" }}>PRO</strong> plan.</p>
        <div style={{ marginTop: 18, display: "inline-flex", alignItems: "center", gap: 8, padding: "9px 14px", background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 99 }}>
          <span style={{ fontSize: 12.5, color: "var(--emerald-text)" }}>Discount code</span>
          <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, color: "var(--ink)", background: "var(--paper)", padding: "3px 8px", borderRadius: 6, border: "1.5px solid var(--emerald)" }}>FRIEND50</code>
        </div>
        <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>applied at checkout</div>
      </div>
    </Screen>
  );
}

// ── SSO callback / redirecting ──────────────────────────────────────────────
function SSORedirectScreen({ go }) {
  useEffect(() => { const t = setTimeout(() => go("dashboard"), 2000); return () => clearTimeout(t); }, []);
  return (
    <div className="um" style={{ height: "100%", background: "var(--paper)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 22, backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px)", backgroundSize: "9px 9px" }}>
      <style>{`@keyframes umspin{to{transform:rotate(360deg)}}`}</style>
      <BrandMark size={64} />
      <div style={{ width: 30, height: 30, borderRadius: 99, border: "3px solid var(--rule-soft)", borderTopColor: "var(--emerald)", animation: "umspin .8s linear infinite" }} />
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)", letterSpacing: 1.5 }}>REDIRECTING TO DASHBOARD…</div>
    </div>
  );
}

Object.assign(window, { BlogScreen, DocsScreen, GlossaryScreen, NewsletterScreen, UnsubscribeScreen, LegalDoc, LegalHubScreen, NotFoundScreen, InviteScreen, SSORedirectScreen });
