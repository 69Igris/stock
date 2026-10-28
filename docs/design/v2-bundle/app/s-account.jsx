// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · You: hub, brokers, notifications, plan/checkout,
// settings (incl. memory center), invite, help, feedback
// ─────────────────────────────────────────────────────────────────────────
const { useState: acS } = React;

function YouScreenV2({ go, um, dark, setDark }) {
  const groups = [
    { g: "Money", items: [["brokers", "link", "Brokers", um.brokers.some(b => b.state !== "connected") ? "1 needs attention" : `${um.brokers.length} connected`], ["import", "upload", "Import trades"], ["documents", "file", "Document vault"], ["tax", "receipt", "Tax report"], ["risk", "shield", "Risk report", um.plan === "free" ? "PRO" : null], ["calculators", "calc", "Calculators"]] },
    ...(um.usFlag ? [{ g: "US · flag on", items: [["usportfolio", "briefcase", "Holdings · both markets", "◷ EOD"], ["usconnect", "link", "US accounts", "3 via SnapTrade"], ["usprefs", "scale", "Market preferences", window.__umUS && window.__umUS.persona === "lrs" ? "LRS · ₹" : "NRI · $"], ...(window.__umUS && window.__umUS.persona === "lrs" ? [["lrs", "receipt", "LRS / TCS tracker", "$201,800 left"]] : [])] }] : []),
    { g: "Lab", items: [["strategies", "zap", "Strategies", "LAB"], ["devsettings", "settings", "Developer", "MCP"]] },
    { g: "App", items: [["notifications", "bell", "Notifications"], ["settings", "settings", "Settings & privacy"], ["chathistory", "history", "Chat history"]] },
    { g: "More", items: [["invitefriends", "gift", "Invite friends", "1 mo PRO each"], ["help", "info", "Help & docs"], ["feedback", "msg", "Feedback"], ["more", "scale", "About & legal"]] },
  ];
  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "0 18px 28px" }}>
      {/* profile head */}
      <div style={{ display: "flex", alignItems: "center", gap: 13, padding: "18px 0 4px" }}>
        <span style={{ width: 54, height: 54, borderRadius: 16, background: "var(--pop-2)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 20, color: "#1d1d1b", transform: "rotate(-3deg)", boxShadow: "3px 3px 0 var(--ink)" }}>RV</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 800, fontSize: 19, letterSpacing: -0.5, color: "var(--ink)" }}>{USER.full}</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>{USER.email.toUpperCase()} · SINCE {USER.since.toUpperCase()}</div>
        </div>
      </div>
      {/* plan card */}
      <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 14, background: "var(--ink)", color: "var(--paper)", padding: "14px 16px", boxShadow: "4px 4px 0 var(--pop-2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, letterSpacing: 1, background: um.plan === "free" ? "var(--paper)" : "var(--pop-2)", color: "#1d1d1b", padding: "3px 9px", borderRadius: 6 }}>{um.plan.toUpperCase()} PLAN</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--pop-2)" }}>⚡ {um.credits} CREDITS LEFT</span>
        </div>
        <div style={{ marginTop: 11, height: 9, border: "1.5px solid var(--paper)", borderRadius: 99, overflow: "hidden", background: "rgba(247,243,230,0.15)" }}>
          <div style={{ width: `${um.credits / (um.plan === "free" ? 5 : 50) * 100}%`, height: "100%", background: "var(--pop-2)" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: 0.8, opacity: 0.7 }}>RESETS AUG 1</span>
          {um.plan === "free" && (
            <button onClick={() => go("plan")} style={{ border: "2px solid var(--paper)", background: "var(--pop-2)", color: "#1d1d1b", borderRadius: 9, padding: "7px 13px", fontWeight: 800, fontSize: 12, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Upgrade to PRO →</button>
          )}
        </div>
      </div>
      {groups.map(grp => (
        <div key={grp.g}>
          <SecHead label={grp.g} />
          <ListCard>
            {grp.items.map(([k, ic, t, badge], i) => (
              <RowItem key={k} last={i === grp.items.length - 1} onClick={() => go(k)}
                left={<span style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={ic} size={16} color="var(--ink-2)" /></span>}
                title={t}
                rightSub={badge ? <Tag color={badge.includes("attention") ? "var(--loss)" : "var(--ink-3)"}>{badge}</Tag> : null} />
            ))}
          </ListCard>
        </div>
      ))}
      {/* appearance + signout */}
      <SecHead label="Appearance" />
      <ListCard>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px" }}>
          <span style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-2)", display: "grid", placeItems: "center" }}><Icon name={dark ? "moon" : "sun"} size={16} color="var(--ink-2)" /></span>
          <span style={{ flex: 1, fontSize: 13.5, fontWeight: 750, color: "var(--ink)" }}>Dark mode</span>
          <button onClick={() => setDark(d => !d)} style={{ width: 48, height: 28, borderRadius: 99, border: "2px solid var(--ink)", background: dark ? "var(--emerald)" : "var(--paper-2)", position: "relative", cursor: "pointer", transition: "background .15s" }}>
            <span style={{ position: "absolute", top: 2, left: dark ? 22 : 2, width: 20, height: 20, borderRadius: 99, background: "var(--paper)", border: "2px solid var(--ink)", transition: "left .15s" }} />
          </button>
        </div>
      </ListCard>
      <div style={{ marginTop: 18 }}>
        <GhostBtn icon="logout" accent="var(--loss)" onClick={() => go("welcome", { reset: true })}>Sign out</GhostBtn>
      </div>
      <p style={{ margin: "14px 0 0", textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.6 }}>USEMONEY v2.4.0 · MADE IN INDIA</p>
    </div>
  );
}

// ── Brokers manager ─────────────────────────────────────────────────────────
function BrokersScreenV2({ go, back, um }) {
  const [syncing, setSyncing] = acS(null);
  const connectedIds = um.brokers.map(b => b.id);
  const avail = Object.keys(BROKER_META).filter(id => !connectedIds.includes(id));
  const syncNow = (id) => {
    setSyncing(id);
    setTimeout(() => { setSyncing(null); um.toast("Synced — 0 new trades"); }, 1600);
  };
  const disconnect = (b) => um.setSheet({
    title: "Disconnect " + BROKER_META[b.id].name + "?", body: (
      <div>
        <p style={{ margin: "2px 0 14px", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.55 }}>Your {b.holdings} holdings and {b.trades} trades from this broker stay in UseMoney (marked stale). The read-only token is revoked immediately.</p>
        <PrimaryBtn style={{ background: "var(--loss)", borderColor: "var(--ink)", boxShadow: "4px 4px 0 var(--ink)" }} onClick={() => { um.disconnectBroker(b.id); um.setSheet(null); um.toast(BROKER_META[b.id].name + " disconnected", "info"); }}>Disconnect</PrimaryBtn>
        <div style={{ marginTop: 9 }}><GhostBtn onClick={() => um.setSheet(null)}>Keep it</GhostBtn></div>
      </div>
    ),
  });
  return (
    <SubPage um={um} title="Brokers" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <SecHead label={`Connected · ${um.brokers.length}`} style={{ marginTop: 6 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {um.brokers.map(b => {
            const m = BROKER_META[b.id];
            const err = b.state === "expired";
            const busy = syncing === b.id;
            return (
              <div key={b.id} style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-3)", boxShadow: `3px 3px 0 ${err ? "var(--pop-1)" : "var(--ink)"}`, padding: "13px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <BrokerLogo id={b.id} size={38} rotate={-2} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: 14.5, color: "var(--ink)" }}>{m.name}</div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginTop: 2 }}>{b.holdings} HOLDINGS · {b.trades} TRADES · LAST {b.lastSync.toUpperCase()}</div>
                  </div>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, padding: "4px 8px", borderRadius: 6, border: "2px solid var(--ink)", background: busy ? "var(--pop-2)" : err ? "var(--pop-1)" : "var(--emerald)", color: "#0b0b09" }}>
                    <span style={{ width: 5, height: 5, borderRadius: 99, background: "#0b0b09", animation: busy ? "umpulse 1s infinite" : "none" }} />
                    {busy ? "SYNCING" : err ? "EXPIRED" : "LIVE"}
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  {err ? (
                    <PrimaryBtn full={false} style={{ flex: 1, padding: "10px 8px", fontSize: 12.5 }} onClick={() => go("oauth:" + b.id + ":manage")}>Reconnect</PrimaryBtn>
                  ) : (
                    <GhostBtn full={false} style={{ flex: 1, padding: "10px 8px", fontSize: 12.5 }} icon={busy ? null : "refresh"} onClick={() => !busy && syncNow(b.id)}>{busy ? <span style={{ display: "inline-flex", gap: 7, alignItems: "center" }}><Spinner size={13} /> Syncing…</span> : "Sync now"}</GhostBtn>
                  )}
                  <GhostBtn full={false} style={{ flex: 1, padding: "10px 8px", fontSize: 12.5 }} accent="var(--loss)" onClick={() => disconnect(b)}>Disconnect</GhostBtn>
                </div>
                {err && <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--loss)", letterSpacing: 0.3 }}>⚠ UPSTOX ROTATES TOKENS DAILY — RECONNECT TAKES ~20 SECONDS.</div>}
              </div>
            );
          })}
        </div>
        <SecHead label="Add a broker" />
        {um.usFlag && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9, marginBottom: 14 }}>
              {[["rh", "Robinhood", "RH", "#00c805", "#0b2b0b"], ["fd", "Fidelity", "FD", "#00945f", "#fff"], ["sw", "Schwab", "SW", "#0033a0", "#fff"], ["wb", "Webull", "WB", "#1a4ae0", "#fff"]].map(([id, name, ab, bg, fg], i) => (
                <Press key={id} onClick={() => go("usoauth:" + id)}>
                  <div style={{ display: "flex", alignItems: "center", gap: 9, border: "1.5px solid var(--ink)", borderRadius: 11, padding: "10px 11px", background: "var(--paper-3)" }}>
                    <span style={{ width: 28, height: 28, borderRadius: 7, border: "2px solid var(--ink)", background: bg, color: fg, display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 10, transform: i % 2 ? "rotate(2deg)" : "rotate(-2deg)" }}>{ab}</span>
                    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 800, color: "var(--ink)" }}>{name}</div><div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--ink-3)" }}>US · SNAPTRADE</div></div>
                  </div>
                </Press>
              ))}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", marginBottom: 12 }}>US via SnapTrade · read-only · or <span onClick={() => go("usimport")} style={{ color: "var(--emerald-text)", fontWeight: 800, cursor: "pointer" }}>IMPORT A STATEMENT →</span></div>
            <SecHead label="India brokers" style={{ marginTop: 4 }} />
          </>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
          {avail.map((id, i) => (
            <Press key={id} onClick={() => go("oauth:" + id + ":manage")}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, border: "2px solid var(--ink)", borderRadius: 12, padding: "11px 12px", background: "var(--paper-3)", boxShadow: "2px 2px 0 var(--ink)" }}>
                <BrokerLogo id={id} size={26} />
                <span style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)", flex: 1 }}>{BROKER_META[id].name}</span>
                <Icon name="plus" size={13} color="var(--ink-3)" />
              </div>
            </Press>
          ))}
        </div>
        <p style={{ margin: "14px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4, lineHeight: 1.6 }}>ALL CONNECTIONS ARE READ-ONLY OAUTH. USEMONEY CANNOT PLACE ORDERS OR MOVE FUNDS — EVER.</p>
      </div>
    </SubPage>
  );
}

// ── Notifications ───────────────────────────────────────────────────────────
function NotificationsScreenV2({ go, back, um }) {
  const [read, setRead] = acS(false);
  return (
    <SubPage um={um} title="Notifications" onBack={back}
      right={<Chip onClick={() => { setRead(true); um.toast("All caught up"); }} style={{ padding: "5px 10px", fontSize: 10.5 }}>Mark read</Chip>}>
      <div style={{ paddingTop: 14 }}>
        <ListCard>
          {um.usFlag && <RowItem onClick={() => go("usoauth:fd:fail")} left={<span style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--pop-1)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="alert" size={15} color="#1d1d1b" strokeWidth={2.4} /></span>} title="Fidelity needs re-authorising" sub="2H AGO · SNAPTRADE SESSION EXPIRED JUL 14" rightSub={<Tag bg="var(--pop-3)" color="#1d1d1b" style={{ borderColor: "var(--ink)" }}>US</Tag>} />}
          {um.usFlag && <RowItem onClick={() => go("usportfolio")} left={<span style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="clock" size={15} color="var(--ink-2)" /></span>} title="US close · your book +$1,284" sub="01:30 IST · EOD PRICES UPDATED · JUL 18" rightSub={<Tag bg="var(--pop-3)" color="#1d1d1b" style={{ borderColor: "var(--ink)" }}>US</Tag>} />}
          {NOTIFS.map((n, i) => (
            <RowItem key={n.id} last={i === NOTIFS.length - 1} onClick={n.go ? () => go(n.go) : undefined}
              left={
                <span style={{ position: "relative", flexShrink: 0 }}>
                  <span style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: n.kind === "BROKER" ? "var(--pop-1)" : n.kind === "ROAST" ? "var(--pop-2)" : "var(--paper-2)", display: "grid", placeItems: "center" }}>
                    <Icon name={n.icon} size={16} color="var(--ink-2)" />
                  </span>
                  {n.unread && !read && <span style={{ position: "absolute", top: -4, right: -4, width: 10, height: 10, borderRadius: 99, background: "var(--pop-1)", border: "2px solid var(--paper-3)" }} />}
                </span>
              }
              title={n.title} sub={`${n.kind} · ${n.time} ago — ${n.sub}`} />
          ))}
        </ListCard>
        <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.4 }}>TUNE WHAT NOTIFIES YOU IN SETTINGS → ALERTS.</p>
      </div>
    </SubPage>
  );
}

// ── Plan / paywall / checkout ───────────────────────────────────────────────
function PlanScreenV2({ go, back, um }) {
  const [cycle, setCycle] = acS("mo");
  const [phase, setPhase] = acS("list");
  const [pick, setPick] = acS("pro");
  const price = (p) => cycle === "yr" ? Math.round(p * 0.8) : p;

  if (phase === "success") {
    const plan = PLANS.find(p => p.id === pick);
    return (
      <SubPage um={um} title="Welcome to PRO" onBack={() => { go("you", { reset: true }); }}>
        <div style={{ paddingTop: 30, textAlign: "center" }}>
          <span style={{ display: "inline-grid", placeItems: "center", width: 76, height: 76, borderRadius: 22, background: "var(--emerald)", border: "2px solid var(--ink)", boxShadow: "4px 4px 0 var(--ink)", transform: "rotate(-4deg)" }}>
            <Icon name="check" size={38} color="#0b0b09" strokeWidth={3} />
          </span>
          <h1 style={{ fontWeight: 800, fontSize: 28, letterSpacing: -1.2, margin: "20px 0 6px", color: "var(--ink)" }}>You're {plan.name}, <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>officially.</span></h1>
          <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-3)" }}>{plan.credits} credits landed. Receipt's in your email.</p>
          <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
            <Sticker rotate={3}>+{plan.credits} credits · <b>unlimited roasts</b></Sticker>
          </div>
          <div style={{ marginTop: 26 }}>
            <PrimaryBtn onClick={() => go("sage", { reset: true })}>Spend one on deep research</PrimaryBtn>
          </div>
        </div>
      </SubPage>
    );
  }

  if (phase === "pay") {
    const plan = PLANS.find(p => p.id === pick);
    return (
      <SubPage um={um} title="Checkout" onBack={() => setPhase("list")}
        footer={<PrimaryBtn onClick={() => { um.upgrade(pick, plan.credits); setPhase("success"); }}>Pay {money(price(plan.price))} via UPI</PrimaryBtn>}>
        <div style={{ paddingTop: 16 }}>
          <Card pad={15}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16.5, color: "var(--ink)" }}>UseMoney {plan.name}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", marginTop: 2 }}>{cycle === "yr" ? "BILLED YEARLY (-20%)" : "BILLED MONTHLY"} · CANCEL ANYTIME</div>
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 22, color: "var(--ink)" }}>₹{inr(price(plan.price))}<span style={{ fontSize: 10, color: "var(--ink-3)" }}>/mo</span></div>
            </div>
          </Card>
          <SecHead label="Pay with UPI" />
          <Field label="UPI ID" value={"rahul.verma@okhdfc"} onChange={() => {}} right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--emerald-text)", fontWeight: 800 }}>VERIFIED ✓</span>} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
            {["GPay", "PhonePe", "Paytm"].map(u => (
              <div key={u} style={{ border: "2px solid var(--ink)", borderRadius: 11, padding: "10px 4px", textAlign: "center", fontWeight: 800, fontSize: 12.5, color: "var(--ink)", background: "var(--paper-3)", boxShadow: "2px 2px 0 var(--ink)" }}>{u}</div>
            ))}
          </div>
          <p style={{ margin: "16px 0 0", fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4, lineHeight: 1.6 }}>HANDLED BY DODO PAYMENTS · GST INVOICE ISSUED · REFUND WITHIN 7 DAYS IF YOU HATE IT (YOU WON'T).</p>
        </div>
      </SubPage>
    );
  }

  return (
    <SubPage um={um} title="Plans & credits" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 15, color: "var(--ink-2)" }}>Simple chats are free. Depth costs credits.</div>
          <Seg grow={false} value={cycle} onChange={setCycle} size={10.5} options={[{ k: "mo", label: "Monthly" }, { k: "yr", label: "-20% Yearly" }]} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 16 }}>
          {PLANS.map(p => {
            const cur = um.plan === p.id;
            return (
              <div key={p.id} style={{ position: "relative", border: "2px solid var(--ink)", borderRadius: 15, background: p.pop ? "var(--ink)" : "var(--paper-3)", color: p.pop ? "var(--paper)" : "var(--ink)", boxShadow: p.pop ? "4px 4px 0 var(--pop-2)" : "3px 3px 0 var(--ink)", padding: "15px 16px" }}>
                {p.pop && <span style={{ position: "absolute", top: -12, right: 14, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 12.5, background: "var(--pop-2)", color: "#1d1d1b", border: "2px solid var(--ink)", borderRadius: 8, padding: "3px 10px", transform: "rotate(3deg)", boxShadow: "2px 2px 0 #000" }}>most picked</span>}
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <span style={{ fontWeight: 800, fontSize: 17 }}>{p.name}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 19 }}>{p.price === 0 ? "₹0" : "₹" + inr(price(p.price))}<span style={{ fontSize: 9.5, opacity: 0.6 }}>/{p.tagline.includes("month") ? "mo" : p.tagline}</span></span>
                </div>
                <div style={{ marginTop: 9, display: "flex", flexDirection: "column", gap: 5 }}>
                  {p.feats.map(f => (
                    <div key={f} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12.5, fontWeight: 600, opacity: 0.92 }}>
                      <span style={{ color: p.pop ? "var(--emerald)" : "var(--emerald-text)", fontWeight: 800 }}>✦</span>{f}
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 13 }}>
                  {cur ? (
                    <div style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, letterSpacing: 1, padding: "10px 0", border: "2px dashed " + (p.pop ? "rgba(247,243,230,0.4)" : "var(--rule-soft)"), borderRadius: 10, opacity: 0.75 }}>CURRENT PLAN</div>
                  ) : p.id === "free" ? null : (
                    <button onClick={() => { setPick(p.id); setPhase("pay"); }} style={{ width: "100%", padding: "12px 0", borderRadius: 11, border: "2px solid " + (p.pop ? "var(--paper)" : "var(--ink)"), background: p.pop ? "var(--pop-2)" : "var(--ink)", color: p.pop ? "#1d1d1b" : "var(--paper)", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Get {p.name}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p style={{ margin: "16px 0 0", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)", letterSpacing: 0.4, lineHeight: 1.7 }}>CREDITS POWER DEEP RESEARCH (1-3), ANALYST BOARDS (SOON) AND BACKTESTS (SOON). CHAT, SYNC & PORTFOLIO ARE FREE FOREVER.</p>
      </div>
    </SubPage>
  );
}

// ── Settings (incl. memory transparency seam) ──────────────────────────────
function SettingsScreenV2({ go, back, um, dark, setDark }) {
  const [twofa, setTwofa] = acS(true);
  const MEM = [
    { k: "PREFERENCE", t: "Prefers long-term, low-churn investing" },
    { k: "FACT", t: "Tax regime: new · files via CA" },
    { k: "INSIGHT", t: "Watches IT sector closely (INFY, TCS)" },
  ];
  const Toggle = ({ on, set }) => (
    <button onClick={() => set(v => !v)} style={{ width: 46, height: 27, borderRadius: 99, border: "2px solid var(--ink)", background: on ? "var(--emerald)" : "var(--paper-2)", position: "relative", cursor: "pointer", flexShrink: 0, transition: "background .15s" }}>
      <span style={{ position: "absolute", top: 2, left: on ? 21 : 2, width: 19, height: 19, borderRadius: 99, background: "var(--paper)", border: "2px solid var(--ink)", transition: "left .15s" }} />
    </button>
  );
  return (
    <SubPage um={um} title="Settings & privacy" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <SecHead label="Account" style={{ marginTop: 4 }} />
        <ListCard>
          <RowItem left={<Icon name="user" size={17} color="var(--ink-2)" />} title={USER.full} sub={USER.email.toUpperCase()} onClick={() => um.toast("Profile editing mock", "info")} />
          <RowItem left={<Icon name="phone" size={17} color="var(--ink-2)" />} title={USER.phone} sub="VERIFIED FOR ALERTS" last />
        </ListCard>
        <SecHead label="Security" />
        <ListCard>
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", borderBottom: "1.5px solid var(--rule-soft)" }}>
            <Icon name="shieldCheck" size={17} color="var(--ink-2)" />
            <span style={{ flex: 1, fontSize: 13.5, fontWeight: 750, color: "var(--ink)" }}>Two-factor auth</span>
            <Toggle on={twofa} set={setTwofa} />
          </div>
          <RowItem left={<Icon name="lock" size={17} color="var(--ink-2)" />} title="Change password" onClick={() => go("reset")} />
          <RowItem left={<Icon name="fingerprint" size={17} color="var(--ink-2)" />} title="Active sessions" sub="THIS PHONE · CHROME (DELHI)" last onClick={() => um.toast("2 sessions active", "info")} />
        </ListCard>
        {um.usFlag && (
          <>
            <SecHead label="Markets" right={<Tag bg="var(--pop-3)" color="#1d1d1b" style={{ borderColor: "var(--ink)" }}>NEW</Tag>} />
            <ListCard>
              <RowItem left={<Icon name="globe" size={17} color="var(--ink-2)" />} title="Market preferences" sub={((window.__umUS || {}).persona === "lrs" ? "INDIA + US · LRS · ₹ PRIMARY" : "INDIA + US · NRI · $ PRIMARY")} onClick={() => go("usprefs")} />
              <RowItem left={<Icon name="link" size={17} color="var(--ink-2)" />} title="Connected US accounts" sub="3 VIA SNAPTRADE · 1 NEEDS RE-AUTH" onClick={() => go("usprefs")} last />
            </ListCard>
          </>
        )}
        <SecHead label="Sage memory" right={<Tag>DPDP</Tag>} />
        <ListCard>
          {MEM.map((m, i) => (
            <div key={m.t} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderBottom: "1.5px solid var(--rule-soft)" }}>
              <Tag bg="var(--paper-2)">{m.k}</Tag>
              <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: "var(--ink)", lineHeight: 1.4 }}>{m.t}</span>
              <button onClick={() => um.toast("Memory deleted", "info")} style={{ border: 0, background: "transparent", cursor: "pointer", display: "flex" }}><Icon name="x" size={14} color="var(--ink-3)" /></button>
            </div>
          ))}
          <div style={{ padding: "11px 14px" }}>
            <button onClick={() => um.toast("All memories deleted", "info")} style={{ border: 0, background: "transparent", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--loss)", letterSpacing: 0.6, padding: 0 }}>DELETE ALL REMEMBERED FACTS</button>
          </div>
        </ListCard>
        <SecHead label="Data" />
        <ListCard>
          <RowItem left={<Icon name="download" size={17} color="var(--ink-2)" />} title="Export everything (CSV)" onClick={() => um.toast("Export emailed to you")} />
          <RowItem left={<Icon name="alert" size={17} color="var(--loss)" />} title={<span style={{ color: "var(--loss)" }}>Delete account</span>} sub="30-DAY GRACE, THEN GONE" last onClick={() => um.toast("We'd rather roast you than lose you", "info")} />
        </ListCard>
      </div>
    </SubPage>
  );
}

// ── Invite / help / feedback ────────────────────────────────────────────────
function InviteScreenV2({ go, back, um }) {
  return (
    <SubPage um={um} title="Invite friends" onBack={back}>
      <div style={{ paddingTop: 16 }}>
        <div style={{ border: "2px solid var(--ink)", borderRadius: 16, background: "var(--pop-2)", padding: "18px 16px", boxShadow: "4px 4px 0 var(--ink)", textAlign: "center", transform: "rotate(-1deg)" }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1.2, color: "#1d1d1b" }}>YOUR CODE</div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 30, letterSpacing: 2, color: "#1d1d1b", margin: "8px 0" }}>RAHUL-4X2</div>
          <div style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14, color: "#1d1d1b" }}>you both get a month of PRO. free.</div>
        </div>
        <div style={{ display: "flex", gap: 9, marginTop: 16 }}>
          <PrimaryBtn full={false} style={{ flex: 1 }} onClick={() => um.toast("Code copied")}>Copy code</PrimaryBtn>
          <GhostBtn full={false} style={{ flex: 1 }} icon="external" onClick={() => um.toast("Share sheet opened")}>Share</GhostBtn>
        </div>
        <SecHead label="How it works" />
        <ListCard>
          {[["01", "Friend signs up with your code"], ["02", "They connect any broker"], ["03", "You both get PRO for a month"]].map(([n, t], i, arr) => (
            <RowItem key={n} last={i === arr.length - 1}
              left={<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 800, border: "2px solid var(--ink)", borderRadius: 8, padding: "6px 8px", background: "var(--paper-2)", transform: "rotate(-2deg)" }}>{n}</span>}
              title={t} />
          ))}
        </ListCard>
        <SecHead label="Invited so far" right={<Tag>2 JOINED</Tag>} />
        <ListCard>
          <RowItem left={<SymTile sym="AM" size={32} />} title="Aman M." sub="JOINED · PRO CREDITED" rightSub={<Tag color="var(--emerald-text)">done</Tag>} />
          <RowItem left={<SymTile sym="PK" size={32} />} title="Priya K." sub="SIGNED UP · NO BROKER YET" last rightSub={<Tag>pending</Tag>} />
        </ListCard>
      </div>
    </SubPage>
  );
}

function HelpScreenV2({ go, back, um }) {
  const [open, setOpen] = acS(0);
  const FAQ = [
    ["Is UseMoney safe?", "Read-only OAuth — we mathematically cannot place orders or move funds. Tokens are AES-256-GCM encrypted and revocable from Settings or your broker."],
    ["Why don't my numbers match my broker app?", "We FIFO-pair across ALL brokers and include charges. Broker apps show per-broker, pre-charge numbers. Ours is the tax-true view."],
    ["What do credits pay for?", "Deep research (1-3), analyst boards & backtests (soon). Chat, sync, holdings and tradebook are free forever."],
    ["How fresh is the data?", "Quotes are live during NSE hours (9:15–15:30 IST). Broker holdings sync each morning and on pull-to-refresh."],
  ];
  return (
    <SubPage um={um} title="Help & docs" onBack={back}>
      <div style={{ paddingTop: 14 }}>
        <ListCard>
          {FAQ.map(([q, a], i) => (
            <div key={q} style={{ borderBottom: i < FAQ.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
              <button onClick={() => setOpen(open === i ? -1 : i)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", border: 0, background: "transparent", cursor: "pointer", textAlign: "left" }}>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 800, color: "var(--ink)", fontFamily: "var(--font-sans)" }}>{q}</span>
                <Icon name={open === i ? "minus" : "plus"} size={15} color="var(--ink-3)" />
              </button>
              {open === i && <p style={{ margin: 0, padding: "0 14px 13px", fontSize: 12.5, lineHeight: 1.6, color: "var(--ink-2)" }}>{a}</p>}
            </div>
          ))}
        </ListCard>
        <SecHead label="Still stuck?" />
        <div style={{ display: "flex", gap: 9 }}>
          <GhostBtn full={false} style={{ flex: 1 }} icon="mail" onClick={() => um.toast("hello@usemoney.ai — we read every email")}>Email us</GhostBtn>
          <GhostBtn full={false} style={{ flex: 1 }} icon="msg" onClick={() => go("feedback")}>Feedback</GhostBtn>
        </div>
      </div>
    </SubPage>
  );
}

function FeedbackScreenV2({ go, back, um }) {
  const [kind, setKind] = acS("idea");
  const [txt, setTxt] = acS("");
  return (
    <SubPage um={um} title="Feedback" onBack={back}
      footer={<PrimaryBtn disabled={!txt.trim()} onClick={() => { um.toast("Sent. We read every one — really."); go("you", { replace: true }); }}>Send it</PrimaryBtn>}>
      <div style={{ paddingTop: 16 }}>
        <div style={{ display: "flex", gap: 7 }}>
          {[["idea", "Idea"], ["bug", "Bug"], ["love", "Love"], ["gripe", "Gripe"]].map(([k, l]) => <Chip key={k} active={kind === k} onClick={() => setKind(k)}>{l}</Chip>)}
        </div>
        <div style={{ marginTop: 14, border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
          <textarea value={txt} onChange={e => setTxt(e.target.value)} rows={6} placeholder={kind === "bug" ? "What broke? What did you expect?" : "Say anything — feature wishes, pricing gripes, the works."}
            style={{ width: "100%", border: 0, outline: 0, background: "transparent", padding: "13px 14px", fontSize: 14, color: "var(--ink)", fontFamily: "var(--font-sans)", resize: "none", lineHeight: 1.55 }} />
        </div>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 18 }}>
          <Sticker rotate={-3} style={{ fontSize: 13 }}>founder reads these <b>daily.</b></Sticker>
        </div>
      </div>
    </SubPage>
  );
}

Object.assign(window, { YouScreenV2, BrokersScreenV2, NotificationsScreenV2, PlanScreenV2, SettingsScreenV2, InviteScreenV2, HelpScreenV2, FeedbackScreenV2 });
