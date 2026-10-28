// ─────────────────────────────────────────────────────────────────────────
// ACCOUNT — Brokers, Learning, Sage Tutor, Quiz, Settings, Notifications
// MORE — Chat history, Help & docs, Invite friends, Feedback
// ─────────────────────────────────────────────────────────────────────────
const { useState: acS } = React;

const BROKERS = [
  { n: "zerodha", t: "Zerodha", st: "connected", since: "synced 2m ago" },
  { n: "groww", t: "Groww", st: "connected", since: "synced 5m ago" },
  { n: "upstox", t: "Upstox", st: "connected", since: "synced 8m ago" },
  { n: "angel", t: "Angel One", st: "connected", since: "synced 12m ago" },
  { n: "dhan", t: "Dhan", st: "available" },
  { n: "fyers", t: "Fyers", st: "available" },
  { n: "hdfc", t: "HDFC Sky", st: "available" },
  { n: "icici", t: "ICICI Direct", st: "available" },
];

// ── Brokers ─────────────────────────────────────────────────────────────────
function BrokersScreen({ go }) {
  return (
    <AppPage eyebrow="BROKERS · READ-ONLY OAUTH" title={<>Connect. We <span className="strike">can't</span> place orders.</>} sub="4 of 8 connected.">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {BROKERS.map(b => {
          const on = b.st === "connected";
          return (
            <div key={b.n} className="pf-row">
              <div className="ic" style={{ background: "var(--paper)", padding: 6 }}><img src={`assets/brokers/${b.n}.png`} alt={b.t} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{b.t}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: on ? "var(--emerald-text)" : "var(--ink-3)" }}>{on ? `● ${b.since}` : "Tap to connect"}</div>
              </div>
              <button style={{ padding: "8px 14px", borderRadius: 9, border: "2px solid var(--ink)", background: on ? "var(--paper)" : "var(--ink)", color: on ? "var(--ink-3)" : "var(--paper)", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>{on ? "Manage" : "Connect"}</button>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 9, padding: 13, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 12 }}>
        <Icon name="shieldCheck" size={16} color="var(--emerald-text)" /><span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Official OAuth only. We store an encrypted token — <strong>never your password</strong>.</span>
      </div>
    </AppPage>
  );
}

// ── Learning ────────────────────────────────────────────────────────────────
function LearningScreen({ go }) {
  const courses = [
    { t: "Investing 101", p: 100, d: "12 lessons · done", c: "var(--emerald)" },
    { t: "Reading a balance sheet", p: 60, d: "6 of 10 lessons", c: "var(--pop-3)" },
    { t: "Options, simply", p: 20, d: "2 of 9 lessons", c: "var(--pop-5)" },
  ];
  return (
    <AppPage eyebrow="LEARNING · STREAK 12 🔥" title={<>Get <span className="ser">sharper,</span> daily.</>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 14 }}>
        <button onClick={() => go("tutor")} className="pf-card" style={{ padding: 15, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: "var(--pop-5)", border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={19} color="#fff" /></span>
          <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>Sage Tutor</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>1-on-1 lessons</div>
        </button>
        <button onClick={() => go("quiz")} className="pf-card" style={{ padding: 15, textAlign: "left", cursor: "pointer", display: "flex", flexDirection: "column", gap: 8 }}>
          <span style={{ width: 38, height: 38, borderRadius: 10, background: "var(--pop-2)", border: "2px solid var(--ink)", display: "grid", placeItems: "center" }}><Icon name="trophy" size={19} color="#1d1d1b" /></span>
          <div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>Quiz</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>Earn streak badges</div>
        </button>
      </div>
      <div className="pf-sec-h"><span className="n">📚</span><h3>Courses</h3><span className="rule" /></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
        {courses.map(c => (
          <div key={c.t} className="pf-card" style={{ padding: 15 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{c.t}</span><span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{c.p}%</span></div>
            <div style={{ marginTop: 9, height: 8, borderRadius: 99, background: "var(--rule-soft)", overflow: "hidden", border: "1.5px solid var(--ink)" }}><div style={{ width: `${c.p}%`, height: "100%", background: c.c }} /></div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 7 }}>{c.d}</div>
          </div>
        ))}
      </div>
    </AppPage>
  );
}

// ── Sage Tutor ───────────────────────────────────────────────────────────────
function TutorScreen({ go }) {
  return (
    <AppPage eyebrow="SAGE TUTOR · 1-ON-1" title={<>Learn at <span className="ser">your</span> pace.</>}>
      <div className="pf-card" style={{ padding: 16 }}>
        <div style={{ alignSelf: "flex-start", background: "var(--paper-2)", border: "2px solid var(--ink)", padding: "13px 15px", borderRadius: "14px 14px 14px 4px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}><span style={{ width: 22, height: 22, borderRadius: 6, background: "var(--pop-5)", display: "grid", placeItems: "center" }}><Icon name="sparkles" size={12} color="#fff" /></span><span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1 }}>TUTOR</span></div>
          <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--ink-2)" }}>Today let's cover <strong style={{ color: "var(--ink)" }}>P/E ratios</strong>. Quick question — if a stock earns ₹10/share and trades at ₹240, what's its P/E?</div>
        </div>
      </div>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
        {["24×", "2.4×", "240×"].map((o, i) => (
          <button key={o} style={{ display: "flex", alignItems: "center", gap: 12, padding: 15, textAlign: "left", borderRadius: 12, border: "2px solid var(--ink)", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, border: "2px solid var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 12, color: "var(--ink)" }}>{String.fromCharCode(65 + i)}</span>
            <span style={{ fontSize: 15.5, fontWeight: 700, color: "var(--ink)", fontFamily: "var(--font-mono)" }}>{o}</span>
          </button>
        ))}
      </div>
    </AppPage>
  );
}

// ── Quiz ───────────────────────────────────────────────────────────────────
function QuizScreen({ go }) {
  return (
    <AppPage eyebrow="QUIZ · DAILY · STREAK 12" title={<>Test what you <span className="hl">know.</span></>}>
      <div className="pf-card" style={{ padding: 18, background: "var(--ink)", color: "var(--paper)", boxShadow: "4px 4px 0 var(--pop-2)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--pop-2)", letterSpacing: 1.5 }}>QUESTION 3 OF 5</div>
        <div style={{ fontSize: 18, fontWeight: 800, marginTop: 10, lineHeight: 1.3 }}>What does a high XIRR tell you about an investment?</div>
      </div>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
        {["Strong time-weighted annual return", "It beat the index", "It paid high dividends", "Lower risk than peers"].map((o, i) => (
          <button key={o} style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, textAlign: "left", borderRadius: 12, border: "2px solid var(--ink)", background: i === 0 ? "var(--emerald-bg)" : "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", cursor: "pointer" }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, border: "2px solid var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 12, color: "var(--ink)", background: i === 0 ? "var(--emerald)" : "transparent" }}>{i === 0 ? <Icon name="check" size={13} color="#fff" strokeWidth={3} /> : String.fromCharCode(65 + i)}</span>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{o}</span>
          </button>
        ))}
      </div>
      <div style={{ marginTop: 16, display: "flex", gap: 8, justifyContent: "center" }}>
        {[1, 2, 3, 4, 5].map(n => <span key={n} style={{ width: 9, height: 9, borderRadius: 99, background: n <= 3 ? "var(--emerald)" : "var(--rule-soft)" }} />)}
      </div>
    </AppPage>
  );
}

// ── Settings ───────────────────────────────────────────────────────────────
function SetRow({ l, v, last }) {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: last ? 0 : "1px dashed var(--rule-soft)", gap: 12 }}><span style={{ fontSize: 13.5, color: "var(--ink-3)" }}>{l}</span><span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", textAlign: "right" }}>{v}</span></div>;
}
function SetToggle({ l, ic, on, fn, last }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 0", borderBottom: last ? 0 : "1px dashed var(--rule-soft)" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{ic && <Icon name={ic} size={17} color="var(--ink-3)" />}{l}</span>
      <div className={`pf-toggle ${on ? "on" : ""}`} onClick={fn} />
    </div>
  );
}
function SettingsScreen({ go, dark, setDark }) {
  const [tab, setTab] = acS("Account");
  const [t, setT] = acS({ push: true, faceid: true, email: true, weekly: true, priceAlerts: true, autodark: false });
  const tog = (k) => setT(s => ({ ...s, [k]: !s[k] }));
  const TABS = ["Account", "Plans", "Billing", "Usage", "Preferences", "Notifications", "Security", "Integrations", "Feedback"];
  const tIcon = { Account: "user", Plans: "star", Billing: "wallet", Usage: "activity", Preferences: "sliders", Notifications: "bell", Security: "shield", Integrations: "link", Feedback: "msg" };
  return (
    <AppPage eyebrow={`SETTINGS · ${tab.toUpperCase()}`} title={<>Settings, <span className="ser">your</span> <span className="hl">way.</span></>} sub="Sign-in, plan, and how we reach you."
      right={<span className="pf-pill violet" style={{ marginTop: 12 }}><Icon name="star" size={11} color="#fff" /> PRO</span>}>
      {/* tab rail */}
      <div style={{ display: "flex", gap: 7, overflowX: "auto", marginBottom: 16, paddingBottom: 4 }}>
        {TABS.map(x => <button key={x} onClick={() => setTab(x)} style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 9, border: "2px solid var(--ink)", background: tab === x ? "var(--ink)" : "var(--paper-3)", color: tab === x ? "var(--paper)" : "var(--ink)", fontSize: 12.5, fontWeight: 700, cursor: "pointer", boxShadow: tab === x ? "none" : "2px 2px 0 var(--ink)" }}><Icon name={tIcon[x]} size={13} color={tab === x ? "var(--paper)" : "var(--ink-2)"} />{x}</button>)}
      </div>

      {tab === "Account" && (
        <>
          <div className="pf-card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 13 }}>
            <span style={{ width: 52, height: 52, borderRadius: 13, background: "var(--pop-3)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 20, border: "2px solid var(--ink)", transform: "rotate(-3deg)", fontFamily: "var(--font-mono)" }}>RV</span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 16, color: "var(--ink)" }}>Rahul Vora</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>Member since Feb 2026</div></div>
            <button style={{ padding: "8px 13px", borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper)", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}>Edit</button>
          </div>
          <div className="pf-card" style={{ padding: "4px 14px", marginTop: 12 }}>
            <SetRow l="Full name" v="Rahul Vora" /><SetRow l="Email" v="rahul@usemoney.ai" /><SetRow l="Phone" v="+91 98765 43210" /><SetRow l="PAN" v="••••• 4821 F" /><SetRow l="Language" v="English" last />
          </div>
          <button onClick={() => go("profile")} className="pf-row" style={{ marginTop: 12, width: "100%", textAlign: "left", cursor: "pointer" }}>
            <span className="ic" style={{ background: "var(--pop-5)" }}><Icon name="target" size={17} color="#fff" /></span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>Investor profile</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>Explorer · retake</div></div>
            <Icon name="chevronR" size={16} color="var(--ink-3)" />
          </button>
        </>
      )}

      {tab === "Plans" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
          {[["FREE", "₹0", false, ["5 credits/mo", "Multi-broker sync"]], ["PRO", "₹249/mo", true, ["100 credits/mo", "Roast + Paper + FIRE"]], ["Premium", "₹1,499/mo", false, ["500 credits/mo", "Tax + Risk reports"]]].map(([n, p, cur, fts]) => (
            <div key={n} className="pf-card" style={{ padding: 16, background: cur ? "var(--ink)" : "var(--paper-3)", color: cur ? "var(--paper)" : "var(--ink)", boxShadow: cur ? "5px 5px 0 var(--pop-2)" : "3px 3px 0 var(--ink)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 800, fontSize: 18 }}>{n}</span>
                {cur ? <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--pop-2)" }}>● CURRENT</span> : <span style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 800 }}>{p}</span>}
              </div>
              {cur && <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, marginTop: 4 }}>{p}</div>}
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>{fts.map(f => <div key={f} style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 12.5 }}><Icon name="check" size={12} color={cur ? "var(--pop-2)" : "var(--emerald-text)"} strokeWidth={2.6} />{f}</div>)}</div>
              {!cur && <button style={{ marginTop: 12, padding: "9px", width: "100%", borderRadius: 9, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>Upgrade</button>}
            </div>
          ))}
        </div>
      )}

      {tab === "Billing" && (
        <>
          <div className="pf-card" style={{ padding: 16 }}>
            <div className="ttl">PAYMENT METHOD</div>
            <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 11 }}><span style={{ width: 40, height: 28, borderRadius: 6, background: "var(--pop-3)", border: "1.5px solid var(--ink)" }} /><div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--ink)" }}>•••• 4821</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>HDFC · expires 09/28</div></div><button style={{ padding: "6px 11px", borderRadius: 8, border: "2px solid var(--ink)", background: "var(--paper)", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Change</button></div>
          </div>
          <div className="pf-sec-h"><span className="n">₹</span><h3>History</h3><span className="rule" /></div>
          <div className="pf-card flat" style={{ padding: "4px 6px", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--ink)" }}>
            <table className="pf-tbl"><tbody>{[["12 May 2026", "PRO · monthly", "₹249", "PAID"], ["12 Apr 2026", "PRO · monthly", "₹249", "PAID"], ["12 Mar 2026", "PRO · monthly", "₹249", "PAID"]].map((r, i) => (
              <tr key={i}><td style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>{r[0]}</td><td style={{ fontSize: 12.5 }}>{r[1]}</td><td className="num">{r[2]}</td><td><span className="pf-pill emerald" style={{ fontSize: 8 }}>{r[3]}</span></td></tr>
            ))}</tbody></table>
          </div>
        </>
      )}

      {tab === "Usage" && (
        <>
          <div className="pf-card" style={{ padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><span className="ttl">CREDITS THIS MONTH</span><span style={{ fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>63 / 100</span></div>
            <div style={{ marginTop: 10, height: 12, borderRadius: 99, background: "var(--rule-soft)", border: "1.5px solid var(--ink)", overflow: "hidden" }}><div style={{ width: "63%", height: "100%", background: "var(--emerald)" }} /></div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 7 }}>Resets 12 Jun · 37 credits left</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 12 }}>
            {[["Sage chats", "284"], ["Deep research", "21"], ["Roasts run", "6"], ["Backtests", "12"]].map(([l, v]) => <div key={l} className="pf-card pf-stat" style={{ padding: 13 }}><div className="l">{l}</div><div className="v" style={{ fontSize: 20 }}>{v}</div></div>)}
          </div>
        </>
      )}

      {tab === "Preferences" && (
        <div className="pf-card" style={{ padding: "4px 14px" }}>
          <SetToggle l="Dark theme" ic="moon" on={dark} fn={() => setDark(d => !d)} />
          <SetToggle l="Auto dark at sunset" ic="sun" on={t.autodark} fn={() => tog("autodark")} />
          <SetRow l="Default page" v="Dashboard" />
          <SetRow l="Currency" v="₹ INR" />
          <SetRow l="Number format" v="Indian (1,24,180)" last />
        </div>
      )}

      {tab === "Notifications" && (
        <div className="pf-card" style={{ padding: "4px 14px" }}>
          <SetToggle l="Push notifications" ic="bell" on={t.push} fn={() => tog("push")} />
          <SetToggle l="Price alerts" ic="trending" on={t.priceAlerts} fn={() => tog("priceAlerts")} />
          <SetToggle l="Email digests" ic="mail" on={t.email} fn={() => tog("email")} />
          <SetToggle l="Weekly roast email" ic="flame" on={t.weekly} fn={() => tog("weekly")} last />
        </div>
      )}

      {tab === "Security" && (
        <>
          <div className="pf-card" style={{ padding: "4px 14px" }}>
            <SetToggle l="Face ID unlock" ic="fingerprint" on={t.faceid} fn={() => tog("faceid")} />
            <SetRow l="Two-factor auth" v="On · authenticator" />
            <SetRow l="Active sessions" v="2 devices" last />
          </div>
          <button style={{ width: "100%", marginTop: 12, padding: 12, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", fontWeight: 700, fontSize: 13.5, cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}>Change password</button>
          <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 9, padding: 13, background: "var(--emerald-bg)", border: "1.5px solid var(--emerald)", borderRadius: 12 }}><Icon name="shieldCheck" size={15} color="var(--emerald-text)" /><span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Secured by Clerk · AES-256 encrypted.</span></div>
        </>
      )}

      {tab === "Integrations" && (
        <button onClick={() => go("brokers")} className="pf-row" style={{ width: "100%", textAlign: "left", cursor: "pointer" }}>
          <span className="ic" style={{ background: "var(--pop-3)" }}><Icon name="link" size={17} color="#fff" /></span>
          <div style={{ flex: 1 }}><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)" }}>Broker connections</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>4 of 8 connected · read-only</div></div>
          <Icon name="chevronR" size={16} color="var(--ink-3)" />
        </button>
      )}

      {tab === "Feedback" && (
        <button onClick={() => go("feedback")} className="pf-card" style={{ width: "100%", textAlign: "left", padding: 16, cursor: "pointer" }}>
          <Icon name="msg" size={24} color="var(--emerald-text)" />
          <div style={{ fontWeight: 800, fontSize: 15, color: "var(--ink)", marginTop: 8 }}>Send feedback</div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4 }}>Idea, bug, or love note — we read every one.</div>
        </button>
      )}

      <button onClick={() => go("welcome")} style={{ width: "100%", marginTop: 16, padding: 13, borderRadius: 11, border: "2px solid var(--loss)", background: "var(--paper)", color: "var(--loss)", fontWeight: 800, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}><Icon name="logout" size={16} color="var(--loss)" /> Sign out</button>
    </AppPage>
  );
}

// ── Notifications ────────────────────────────────────────────────────────────
function NotificationsScreen({ go }) {
  const notifs = [
    { i: "trending", c: "var(--emerald)", t: "RELIANCE hit your ₹2,950 alert", d: "12 min ago", unread: true },
    { i: "link", c: "var(--pop-1)", t: "Zerodha token expires in 3 days", d: "Reauth needed · 1h ago", unread: true },
    { i: "flame", c: "var(--pop-4)", t: "Your weekly roast is ready", d: "Score: 62 · 3h ago", unread: false },
    { i: "receipt", c: "var(--pop-5)", t: "PRO renews on 12 Jun", d: "₹249 · 1 day ago", unread: false },
  ];
  return (
    <AppPage eyebrow="NOTIFICATIONS · 2 NEW" title={<>What <span className="ser">needs</span> you.</>} right={<button style={{ marginTop: 12, border: 0, background: "transparent", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--emerald-text)", textDecoration: "underline", cursor: "pointer" }}>Mark all read</button>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {notifs.map((n, i) => (
          <div key={i} className="pf-row" style={{ background: n.unread ? "var(--paper-3)" : "var(--paper-2)", alignItems: "flex-start" }}>
            <span className="ic" style={{ background: n.c }}><Icon name={n.i} size={18} color="#1d1d1b" /></span>
            <div style={{ flex: 1 }}><div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)", lineHeight: 1.3 }}>{n.t}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 3 }}>{n.d}</div></div>
            {n.unread && <span style={{ width: 9, height: 9, borderRadius: 99, background: "var(--pop-1)", flexShrink: 0, marginTop: 4 }} />}
          </div>
        ))}
      </div>
    </AppPage>
  );
}

// ── Chat history ─────────────────────────────────────────────────────────────
function ChatHistoryScreen({ go }) {
  const chats = [
    { t: "RELIANCE profit booking?", d: "Today · 4 messages" }, { t: "IT concentration check", d: "Yesterday · 6 messages" },
    { t: "FIRE plan at ₹45k SIP", d: "2 days ago · 9 messages" }, { t: "Best dividend stocks FY26", d: "5 days ago · 3 messages" },
  ];
  return (
    <AppPage eyebrow="CHAT HISTORY · SEARCHABLE" title={<>Every <span className="ser">Sage</span> chat.</>}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", border: "2px solid var(--ink)", borderRadius: 10, background: "var(--paper-3)", marginBottom: 14 }}><Icon name="search" size={15} color="var(--ink-3)" /><span style={{ fontSize: 13, color: "var(--ink-3)" }}>Search conversations…</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {chats.map(c => (
          <button key={c.t} onClick={() => go("sagechat")} className="pf-row" style={{ cursor: "pointer", textAlign: "left", width: "100%" }}>
            <span className="ic" style={{ background: "var(--pop-5)" }}><Icon name="sparkles" size={17} color="#fff" /></span>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 700, fontSize: 14, color: "var(--ink)" }}>{c.t}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)" }}>{c.d}</div></div>
            <Icon name="chevronR" size={16} color="var(--ink-3)" />
          </button>
        ))}
      </div>
    </AppPage>
  );
}

// ── Help & docs ───────────────────────────────────────────────────────────────
function HelpScreen({ go }) {
  const faqs = ["How does broker sync work?", "Can UseMoney place trades?", "What are credits?", "How is my data secured?"];
  return (
    <AppPage eyebrow="HELP & DOCS" title={<>Stuck? <span className="ser">We've got you.</span></>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <button onClick={() => go("docs")} className="pf-card" style={{ padding: 15, textAlign: "left", cursor: "pointer" }}><Icon name="book" size={22} color="var(--pop-3)" /><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)", marginTop: 8 }}>Read the docs</div></button>
        <button onClick={() => go("feedback")} className="pf-card" style={{ padding: 15, textAlign: "left", cursor: "pointer" }}><Icon name="msg" size={22} color="var(--emerald-text)" /><div style={{ fontWeight: 800, fontSize: 14, color: "var(--ink)", marginTop: 8 }}>Contact us</div></button>
      </div>
      <div className="pf-sec-h"><span className="n">?</span><h3>Top questions</h3><span className="rule" /></div>
      <div className="pf-card" style={{ padding: "4px 14px" }}>
        {faqs.map((f, i) => (
          <div key={f} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 0", borderBottom: i < faqs.length - 1 ? "1px dashed var(--rule-soft)" : 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--ink)" }}>{f}</span><Icon name="chevronD" size={16} color="var(--ink-3)" />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 14, textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>We read every email · hello@usemoney.ai</div>
    </AppPage>
  );
}

// ── Invite friends ───────────────────────────────────────────────────────────
function InviteFriendsScreen({ go }) {
  return (
    <AppPage eyebrow="INVITE · EARN FREE PRO" title={<>Give a month, <span className="ser">get</span> a month.</>}>
      <div className="pf-card" style={{ padding: 18, textAlign: "center", background: "var(--pop-4)", color: "#fff", boxShadow: "4px 4px 0 var(--ink)" }}>
        <Icon name="gift" size={40} color="#fff" />
        <div style={{ fontWeight: 800, fontSize: 22, marginTop: 12, letterSpacing: -0.5 }}>1 month PRO, free</div>
        <div style={{ fontSize: 13.5, marginTop: 6, opacity: 0.95 }}>For you and your friend, when they subscribe.</div>
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", letterSpacing: 1, marginBottom: 8 }}>YOUR REFERRAL CODE</div>
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, padding: "13px 16px", border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 18, color: "var(--ink)", letterSpacing: 2, textAlign: "center" }}>RAHUL50</div>
          <button style={{ padding: "0 18px", borderRadius: 11, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 700, fontSize: 13.5, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)" }}>Copy</button>
        </div>
      </div>
      <button style={{ width: "100%", marginTop: 14, padding: 14, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--paper-3)", color: "var(--ink)", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}><Icon name="send" size={17} color="var(--ink)" /> Share invite link</button>
      <div style={{ marginTop: 16, display: "flex", justifyContent: "space-around", textAlign: "center" }}>
        {[["3", "INVITED"], ["1", "JOINED"], ["1 mo", "EARNED"]].map(([v, l]) => (
          <div key={l}><div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 22, color: "var(--ink)" }}>{v}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 1 }}>{l}</div></div>
        ))}
      </div>
    </AppPage>
  );
}

// ── Feedback ───────────────────────────────────────────────────────────────
function FeedbackScreen({ go }) {
  const [sent, setSent] = acS(false);
  const [pick, setPick] = acS(null);
  const kinds = [["bulb", "Idea"], ["alert", "Bug"], ["heart", "Love it"], ["msg", "Other"]];
  if (sent) return (
    <AppPage noHead>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "60px 10px" }}>
        <span style={{ width: 60, height: 60, borderRadius: 16, background: "var(--emerald)", display: "grid", placeItems: "center", boxShadow: "4px 4px 0 var(--ink)" }}><Icon name="check" size={28} color="#fff" strokeWidth={3} /></span>
        <h1 style={{ fontWeight: 800, fontSize: 26, letterSpacing: -1, marginTop: 22, color: "var(--ink)" }}>Got it. <span className="ser">Thank you.</span></h1>
        <p style={{ marginTop: 10, fontSize: 14, color: "var(--ink-2)", maxWidth: 260 }}>We read every one — and the roadmap follows what you use.</p>
        <button onClick={() => go("dashboard")} style={{ marginTop: 20, padding: "12px 22px", borderRadius: 11, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 14, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)" }}>Back to dashboard</button>
      </div>
    </AppPage>
  );
  return (
    <AppPage eyebrow="FEEDBACK · WE READ EVERY ONE" title={<>Tell us what's <span className="strike">broken.</span></>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
        {kinds.map(([ic, l]) => (
          <button key={l} onClick={() => setPick(l)} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "13px 4px", borderRadius: 12, border: "2px solid var(--ink)", background: pick === l ? "var(--ink)" : "var(--paper-3)", color: pick === l ? "var(--paper)" : "var(--ink)", cursor: "pointer", boxShadow: pick === l ? "none" : "2px 2px 0 var(--ink)" }}>
            <Icon name={ic} size={19} color={pick === l ? "var(--paper)" : "var(--ink)"} /><span style={{ fontSize: 11, fontWeight: 700 }}>{l}</span>
          </button>
        ))}
      </div>
      <textarea className="pf-input" rows={5} placeholder="What happened? The more detail, the better…" style={{ resize: "none", lineHeight: 1.5 }} />
      <button onClick={() => setSent(true)} style={{ width: "100%", marginTop: 14, padding: 14, borderRadius: 12, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", fontWeight: 800, fontSize: 15, cursor: "pointer", boxShadow: "3px 3px 0 var(--emerald)", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}><Icon name="send" size={16} color="var(--paper)" /> Send feedback</button>
    </AppPage>
  );
}

Object.assign(window, { BrokersScreen, LearningScreen, TutorScreen, QuizScreen, SettingsScreen, NotificationsScreen, ChatHistoryScreen, HelpScreen, InviteFriendsScreen, FeedbackScreen });
