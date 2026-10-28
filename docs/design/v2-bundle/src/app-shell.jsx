// ─────────────────────────────────────────────────────────────────────────
// Authenticated app shell — topbar, live ticker, bottom tab bar, slide-in
// sidebar drawer (full sidenav), and the AppPage content primitive.
// ─────────────────────────────────────────────────────────────────────────
const { useState: aS, useEffect: aE } = React;

// Full sidenav config — mirrors apps/web sidenavConfig (catalog ids → screen ids)
const APP_NAV = [
  { label: "WORKSPACE", items: [
    { id: "dashboard", icon: "home", label: "Dashboard", color: "blue" },
    { id: "sagechat", icon: "sparkles", label: "StockSage", color: "emerald", badge: "AI" },
    { id: "holdings", icon: "briefcase", label: "Holdings", color: "gold" },
    { id: "watchlist", icon: "eye", label: "Watchlists" },
    { id: "tradebook", icon: "list", label: "Tradebook" },
    { id: "roast", icon: "flame", label: "Portfolio Roast", color: "pink", badge: "POP" },
  ]},
  { label: "DISCOVER", items: [
    { id: "markets", icon: "trending", label: "Markets", color: "violet" },
    { id: "screener", icon: "filter", label: "Screener" },
    { id: "strategies", icon: "zap", label: "Strategies" },
    { id: "research", icon: "brain", label: "Research list" },
    { id: "news", icon: "newspaper", label: "News & events" },
  ]},
  { label: "TOOLS", items: [
    { id: "paper", icon: "pen", label: "Paper trading", color: "coral" },
    { id: "fire", icon: "flame", label: "FIRE calculator" },
    { id: "calculators", icon: "calc", label: "Calculators" },
    { id: "risk", icon: "shield", label: "Risk report" },
    { id: "tax", icon: "receipt", label: "Tax report" },
    { id: "documents", icon: "file", label: "Document vault" },
  ]},
  { label: "ACCOUNT", items: [
    { id: "brokers", icon: "link", label: "Brokers" },
    { id: "learning", icon: "graduation", label: "Learning" },
    { id: "tutor", icon: "sparkles", label: "Sage Tutor" },
    { id: "quiz", icon: "trophy", label: "Quiz" },
    { id: "settings", icon: "settings", label: "Settings" },
    { id: "notifications", icon: "bell", label: "Notifications" },
  ]},
  { label: "MORE", items: [
    { id: "chathistory", icon: "history", label: "Chat history" },
    { id: "help", icon: "info", label: "Help & docs" },
    { id: "invitefriends", icon: "gift", label: "Invite friends" },
    { id: "feedback", icon: "msg", label: "Feedback" },
  ]},
];

const APP_LABELS = (() => {
  const m = {};
  APP_NAV.forEach(g => g.items.forEach(it => { m[it.id] = it.label; }));
  return m;
})();
const APP_ICON_COLOR = { blue: "var(--pop-3)", emerald: "var(--emerald)", gold: "var(--pop-2)", coral: "var(--pop-1)", pink: "var(--pop-4)", violet: "var(--pop-5)" };

// ── Sparkline ────────────────────────────────────────────────────────────────
function Spark({ up = true, color, w = 64, h = 22 }) {
  const path = up
    ? "M2,18 L10,15 L18,16 L26,12 L34,14 L42,10 L50,11 L58,7 L62,5"
    : "M2,5 L10,7 L18,6 L26,10 L34,9 L42,12 L50,11 L58,15 L62,17";
  const c = color || (up ? "var(--emerald-text)" : "var(--loss)");
  return <svg viewBox="0 0 64 22" width={w} height={h} style={{ display: "block" }}><path d={path} fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ── Page content wrapper ──────────────────────────────────────────────────────
function AppPage({ eyebrow, eyebrowColor, title, sub, right, children, noHead }) {
  return (
    <div className="pf-page">
      {!noHead && (
        <div className="pf-ph">
          {eyebrow && <div className="eyebrow" style={eyebrowColor ? { color: eyebrowColor } : undefined}><span className="d" style={eyebrowColor ? { background: eyebrowColor } : undefined} />{eyebrow}</div>}
          <h1>{title}</h1>
          {sub && <div className="sub">{sub}</div>}
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

// ── Bottom tab bar ────────────────────────────────────────────────────────────
const TABS = [
  { id: "dashboard", icon: "home", label: "Home" },
  { id: "markets", icon: "trending", label: "Markets" },
  { id: "sagechat", icon: "sparkles", label: "Sage", center: true },
  { id: "holdings", icon: "briefcase", label: "Holdings" },
  { id: "__more", icon: "menu", label: "More" },
];
function BottomNav({ active, go, openDrawer }) {
  return (
    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)", paddingTop: 8, background: "var(--paper-3)", borderTop: "2px solid var(--ink)", display: "flex", alignItems: "center", justifyContent: "space-around", zIndex: 20 }}>
      {TABS.map(t => {
        const act = active === t.id || (t.id === "dashboard" && active === "dashboard");
        if (t.center) {
          return (
            <button key={t.id} onClick={() => go(t.id)} style={{ marginTop: -26, width: 56, height: 56, borderRadius: 16, background: active === t.id ? "var(--emerald)" : "var(--ink)", border: "2px solid var(--ink)", boxShadow: "3px 3px 0 var(--emerald)", display: "grid", placeItems: "center", cursor: "pointer", transform: "rotate(-3deg)" }}>
              <Icon name={t.icon} size={25} color="var(--paper)" />
            </button>
          );
        }
        return (
          <button key={t.id} onClick={() => t.id === "__more" ? openDrawer() : go(t.id)} style={{ background: "transparent", border: 0, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "2px 8px", color: act ? "var(--ink)" : "var(--ink-3)" }}>
            <Icon name={t.icon} size={21} color={act ? "var(--ink)" : "var(--ink-3)"} strokeWidth={act ? 2.4 : 2} />
            <span style={{ fontSize: 9.5, fontWeight: act ? 800 : 600 }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Slide-in sidebar drawer ────────────────────────────────────────────────────
function Drawer({ active, go, onClose, dark, setDark }) {
  return (
    <div onClick={onClose} style={{ position: "absolute", inset: 0, zIndex: 50, display: "flex" }}>
      <style>{`@keyframes umdraw{from{transform:translateX(-100%)}to{transform:none}} @keyframes umscrim{from{opacity:0}to{opacity:1}}`}</style>
      <div onClick={e => e.stopPropagation()} style={{ width: "87%", maxWidth: 360, height: "100%", background: "var(--paper)", borderRight: "2px solid var(--ink)", display: "flex", flexDirection: "column", animation: "umdraw .24s cubic-bezier(.22,.61,.36,1) both", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px)", backgroundSize: "9px 9px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${(window.__UM_DEVICE_NAME === "android" ? 38 : 54)}px 16px 12px`, borderBottom: "2px solid var(--ink)", flexShrink: 0 }}>
          <Wordmark size={16} />
          <button onClick={onClose} style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="x" size={16} color="var(--ink)" /></button>
        </div>
        {/* profile card */}
        <div style={{ margin: "14px 16px 4px", padding: "13px 14px", border: "2px solid var(--ink)", borderRadius: 13, background: "var(--pop-2)", boxShadow: "3px 3px 0 var(--ink)", transform: "rotate(-1deg)", display: "flex", alignItems: "center", gap: 11 }}>
          <span style={{ width: 40, height: 40, borderRadius: 9, background: "var(--pop-3)", color: "#fff", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 15, border: "1.5px solid #1d1d1b", transform: "rotate(3deg)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>RV</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: "#1d1d1b", lineHeight: 1.1 }}>Rahul V. <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>— hey there.</span></div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#3a3a35", marginTop: 3 }}>rahul@usemoney.ai</div>
          </div>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, padding: "3px 8px", borderRadius: 99, background: "#1d1d1b", color: "#f7f3e6" }}>PRO</span>
        </div>
        {/* nav */}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 14px 16px" }}>
          {APP_NAV.map(g => (
            <div key={g.label}>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1.6, color: "var(--ink-3)", padding: "14px 6px 7px" }}>{g.label}</div>
              {g.items.map(it => {
                const on = active === it.id;
                return (
                  <button key={it.id} onClick={() => go(it.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "10px 11px", borderRadius: 10, border: 0, marginBottom: 2, cursor: "pointer", textAlign: "left", background: on ? "var(--ink)" : "transparent", color: on ? "var(--paper)" : "var(--ink-2)", fontSize: 14.5, fontWeight: on ? 700 : 600 }}>
                    <span style={{ width: 22, display: "grid", placeItems: "center", color: on ? "var(--paper)" : (it.color ? APP_ICON_COLOR[it.color] : "var(--ink-2)") }}><Icon name={it.icon} size={17} color="currentColor" /></span>
                    <span style={{ flex: 1 }}>{it.label}</span>
                    {it.badge && <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, padding: "2px 6px", borderRadius: 99, background: on ? "var(--emerald)" : "var(--emerald)", color: "#fff" }}>{it.badge}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        {/* footer */}
        <div style={{ borderTop: "2px solid var(--ink)", padding: "10px 14px calc(env(safe-area-inset-bottom) + 16px)", display: "flex", gap: 7, flexShrink: 0, background: "var(--paper)" }}>
          <button onClick={() => setDark(d => !d)} style={drawFootBtn}><Icon name={dark ? "sun" : "moon"} size={13} color="var(--ink-2)" /> Theme</button>
          <button onClick={() => go("settings")} style={drawFootBtn}><Icon name="settings" size={13} color="var(--ink-2)" /> Settings</button>
          <button onClick={() => go("welcome")} style={{ ...drawFootBtn, background: "var(--ink)", color: "var(--paper)", borderColor: "var(--ink)" }}><Icon name="logout" size={13} color="var(--paper)" /> Sign out</button>
        </div>
      </div>
      <div style={{ flex: 1, background: "rgba(20,18,12,0.5)", backdropFilter: "blur(2px)", animation: "umscrim .2s ease both" }} />
    </div>
  );
}
const drawFootBtn = { flex: 1, padding: "9px 6px", borderRadius: 9, border: "1.5px solid var(--rule-soft)", background: "var(--paper)", color: "var(--ink-2)", fontSize: 11.5, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, cursor: "pointer", fontFamily: "var(--font-sans)" };

// ── The shell ──────────────────────────────────────────────────────────────────
function AppShell({ active, go, dark, setDark, ticker = true, children }) {
  const [drawer, setDrawer] = aS(false);
  const ANDROID = window.__UM_DEVICE_NAME === "android";
  const topPad = ANDROID ? 38 : 54;
  aE(() => { setDrawer(false); }, [active]);
  const title = APP_LABELS[active] || "UseMoney";
  const tk = [
    { s: "NIFTY 50", v: "24,810", c: "+0.62%", up: true },
    { s: "SENSEX", v: "81,420", c: "+0.54%", up: true },
    { s: "RELIANCE", v: "2,942", c: "+1.3%", up: true },
    { s: "INFY", v: "1,610", c: "-0.4%", up: false },
    { s: "BANKNIFTY", v: "52,180", c: "+0.21%", up: true },
    { s: "USD/INR", v: "83.41", c: "-0.08%", up: false },
  ];
  return (
    <div className="um pf-app" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper)", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px), radial-gradient(var(--dot-fg-2) 1px, transparent 1.5px)", backgroundSize: "7px 7px, 11px 11px", backgroundPosition: "0 0, 3px 3px", position: "relative", overflow: "hidden" }}>
      {/* top bar */}
      <div style={{ flexShrink: 0, padding: `${topPad}px 14px 10px`, display: "flex", alignItems: "center", gap: 10, borderBottom: "2px solid var(--ink)" }}>
        <button onClick={() => setDrawer(true)} style={{ width: 40, height: 40, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--ink)", cursor: "pointer", flexShrink: 0 }}><Icon name="menu" size={19} color="var(--ink)" /></button>
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: -0.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        </div>
        <button onClick={() => go("notifications")} style={{ width: 40, height: 40, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--ink)", cursor: "pointer", flexShrink: 0, position: "relative" }}>
          <Icon name="bell" size={18} color="var(--ink)" />
          <span style={{ position: "absolute", top: 6, right: 7, width: 8, height: 8, borderRadius: 99, background: "var(--pop-1)", border: "1.5px solid var(--paper-3)" }} />
        </button>
        <button onClick={() => go("settings")} style={{ width: 40, height: 40, borderRadius: 11, border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--emerald)", cursor: "pointer", flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 12 }}>RV</button>
      </div>

      {/* ticker */}
      {ticker && (
        <div style={{ flexShrink: 0, overflow: "hidden", borderBottom: "1.5px solid var(--rule-soft)", padding: "7px 0", background: "var(--paper-2)" }}>
          <div style={{ display: "flex", gap: 20, padding: "0 14px", animation: "umtick 26s linear infinite", whiteSpace: "nowrap", width: "max-content" }}>
            <style>{`@keyframes umtick{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
            {[...tk, ...tk].map((t, k) => (
              <span key={k} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 11 }}>
                <span style={{ color: "var(--ink-3)", fontWeight: 700 }}>{t.s}</span>
                <span style={{ color: "var(--ink)", fontWeight: 600 }}>{t.v}</span>
                <span style={{ color: t.up ? "var(--emerald-text)" : "var(--loss)", fontWeight: 700 }}>{t.c}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* scroll body */}
      <div key={active} style={{ flex: 1, overflowY: "auto", paddingBottom: 84 }}>
        {children}
      </div>

      <BottomNav active={active} go={go} openDrawer={() => setDrawer(true)} />
      {drawer && <Drawer active={active} go={go} onClose={() => setDrawer(false)} dark={dark} setDark={setDark} />}
    </div>
  );
}

Object.assign(window, { APP_NAV, APP_LABELS, AppShell, AppPage, Spark, BottomNav, Drawer });
