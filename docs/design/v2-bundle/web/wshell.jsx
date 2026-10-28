// ─────────────────────────────────────────────────────────────────────────
// UseMoney web · shell (repo-matched sidebar + topbar) + module kit
// Reuses globals from shared.jsx (Icon…) and kit2.jsx (Card, Chip, Tag…)
// ─────────────────────────────────────────────────────────────────────────
const { useState: wsS } = React;

const WNAV = [
  { label: "WORKSPACE", items: [
    ["dashboard", "Dashboard", "grid"], ["stocksage", "StockSage", "sparkles", "emerald", "AI"],
    ["holdings", "Holdings", "pie"], ["watchlists", "Watchlists", "eye"],
    ["tradebook", "Tradebook", "book"], ["roast", "Portfolio Roast", "flame", "pink"],
  ]},
  { label: "DISCOVER", items: [
    ["markets", "Markets", "activity", "blue"],
    ["screener", "Screener", "search", null, null, ["Scans"]],
    ["strategies", "Strategies", "zap", "gold", "LAB", ["Signals", "ForwardRun"]],
    ["research", "Research List", "brain"], ["news", "News & Events", "newspaper"],
  ]},
  { label: "TOOLS", items: [
    ["fire", "FIRE Calculator", "target", "coral"], ["calculators", "Calculators", "calc"],
    ["risk", "Risk Report", "shield"], ["tax", "Tax Report", "receipt"], ["documents", "Document Vault", "file"],
  ]},
  { label: "ACCOUNT", items: [
    ["brokers", "Brokers", "link"], ["devconsole", "Dev Console", "external", null, "NEW"],
    ["settings", "Settings", "settings"], ["notifications", "Notifications", "bell"],
  ]},
];
const NAV_COLOR = { emerald: "var(--emerald)", pink: "var(--pop-4)", blue: "var(--pop-3)", coral: "var(--pop-1)", violet: "var(--pop-5)", gold: "var(--pop-2)" };

function WSidebar({ active }) {
  return (
    <div style={{ width: 236, flexShrink: 0, borderRight: "2px solid var(--ink)", background: "var(--paper-3)", display: "flex", flexDirection: "column", height: "100vh", position: "sticky", top: 0 }}>
      <div style={{ padding: "15px 18px 13px", borderBottom: "1.5px solid var(--rule-soft)", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <span style={{ width: 28, height: 28, borderRadius: 7, background: "var(--ink)", color: "var(--paper)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 14, transform: "rotate(-3deg)" }}>U</span>
        <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: -0.3, color: "var(--ink)" }}>UseMoney<span style={{ color: "var(--emerald-text)" }}> AI</span></span>
      </div>
      <div style={{ margin: "10px 14px 2px", border: "2px solid var(--ink)", borderRadius: 9, background: "var(--paper)", padding: "7px 11px", display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--ink-4)", cursor: "pointer" }}>
        <Icon name="search" size={13} color="var(--ink-3)" />Search markets…
        <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9, border: "1.5px solid var(--rule-soft)", borderRadius: 4, padding: "1px 4px", color: "var(--ink-3)" }}>⌘K</span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 14px 10px" }}>
        {WNAV.map(sec => (
          <div key={sec.label}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 3px 5px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1.6, color: "var(--ink-3)" }}>{sec.label}</span>
              <span style={{ flex: 1, height: 1.5, background: "var(--ink)", opacity: 0.18 }} />
            </div>
            {sec.items.map(([id, label, ic, color, badge, subs]) => {
              const act = active === id;
              return (
                <div key={id}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6.5px 9px", borderRadius: 9, cursor: "pointer", background: act ? "var(--ink)" : "transparent", color: act ? "var(--paper)" : "var(--ink-2)", marginBottom: 1 }}>
                    <span style={{ width: 22, height: 22, borderRadius: 6, border: "1.5px solid " + (act ? "var(--paper)" : "var(--ink)"), background: color ? NAV_COLOR[color] : (act ? "var(--ink)" : "var(--paper)"), display: "grid", placeItems: "center", flexShrink: 0 }}>
                      <Icon name={ic} size={12} color={color ? "#1d1d1b" : (act ? "var(--paper)" : "var(--ink-2)")} strokeWidth={2.2} />
                    </span>
                    <span style={{ fontSize: 12.5, fontWeight: act ? 800 : 650 }}>{label}</span>
                    {badge && <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 8, fontWeight: 800, letterSpacing: 0.6, background: badge === "AI" ? "var(--emerald)" : "var(--pop-2)", color: "#0b0b09", border: "1.5px solid var(--ink)", borderRadius: 5, padding: "1px 5px" }}>{badge}</span>}
                    {subs && <Icon name="chevronD" size={11} color={act ? "var(--paper)" : "var(--ink-3)"} style={{ marginLeft: badge ? 0 : "auto" }} />}
                  </div>
                  {subs && subs.map(s => (
                    <div key={s} style={{ display: "flex", alignItems: "center", gap: 7, padding: "3px 9px 3px 41px", fontSize: 11.5, fontWeight: 600, color: "var(--ink-3)", cursor: "pointer" }}>↳ {s}</div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
        <div style={{ marginTop: 16, background: "var(--pop-2)", border: "2px solid var(--ink)", borderRadius: 11, padding: "11px 13px", transform: "rotate(-1deg)", boxShadow: "3px 3px 0 var(--ink)", fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 13, color: "#1d1d1b", cursor: "pointer" }}>
          <b>Upgrade?</b> Unlock backtests &amp; deep research.
          <div style={{ fontFamily: "var(--font-mono)", fontStyle: "normal", fontSize: 10, fontWeight: 800, marginTop: 5 }}>GO PRO →</div>
        </div>
      </div>
      <div style={{ flexShrink: 0, borderTop: "1.5px solid var(--rule-soft)", padding: "10px 14px", display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ width: 28, height: 28, borderRadius: 9, background: "var(--pop-2)", border: "2px solid var(--ink)", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 11, transform: "rotate(-3deg)" }}>RV</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: "var(--ink)" }}>Rahul Verma</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, color: "var(--ink-3)" }}>FREE · ⚡ 2 CREDITS</div>
        </div>
        <Icon name="chevronD" size={12} color="var(--ink-3)" />
      </div>
    </div>
  );
}

function WShell({ active, crumb, title, ser, right, children }) {
  return (
    <div style={{ display: "flex", minHeight: "100vh", background: "var(--paper)", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px), radial-gradient(var(--dot-fg-2) 1px, transparent 1.5px)", backgroundSize: "7px 7px, 11px 11px", color: "var(--ink)", fontFamily: "var(--font-sans)" }}>
      <WSidebar active={active} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ borderBottom: "2px solid var(--ink)", background: "var(--paper)", padding: "14px 28px 13px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 14px", position: "sticky", top: 0, zIndex: 40 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1.4, color: "var(--emerald-text)" }}>● {crumb}</div>
            <div style={{ fontWeight: 800, fontSize: 21, letterSpacing: -0.7, marginTop: 2 }}>{title}{ser && <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400, color: "var(--ink-2)" }}> {ser}</span>}</div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexShrink: 0, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>NSE OPEN · 09:42 IST</span>
            {right}
            <CreditChip n={2} onClick={() => {}} />
            <span style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", boxShadow: "2px 2px 0 var(--ink)" }}><Icon name="bell" size={15} /></span>
          </div>
        </div>
        <div style={{ flex: 1, padding: "24px 28px 80px", maxWidth: 1200, width: "100%" }}>{children}</div>
        <div style={{ position: "fixed", right: 22, bottom: 20, zIndex: 60, display: "inline-flex", alignItems: "center", gap: 8, border: "2px solid var(--ink)", borderRadius: 99, background: "var(--ink)", color: "var(--paper)", padding: "12px 19px", fontWeight: 800, fontSize: 13.5, boxShadow: "3px 3px 0 var(--emerald)", cursor: "pointer" }}>
          <Icon name="sparkles" size={16} color="var(--emerald)" /> Ask Sage
        </div>
      </div>
    </div>
  );
}

// ── Module kit ──────────────────────────────────────────────────────────────
function WTabs({ tabs, value, onChange }) {
  return (
    <div style={{ display: "inline-flex", border: "2px solid var(--ink)", borderRadius: 11, overflow: "hidden", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
      {tabs.map((t, i) => (
        <button key={t.k} onClick={() => onChange(t.k)} style={{ padding: "10px 18px", border: 0, borderLeft: i ? "2px solid var(--ink)" : 0, background: value === t.k ? "var(--ink)" : "transparent", color: value === t.k ? "var(--paper)" : "var(--ink-2)", fontFamily: "var(--font-sans)", fontWeight: value === t.k ? 800 : 650, fontSize: 13, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 }}>
          {t.label}{t.badge && <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, background: "var(--pop-2)", color: "#1d1d1b", borderRadius: 4, padding: "1px 5px", border: "1.5px solid " + (value === t.k ? "var(--paper)" : "var(--ink)") }}>{t.badge}</span>}
        </button>
      ))}
    </div>
  );
}
function Provenance({ src, asof, style }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, color: "var(--ink-2)", border: "1.5px solid var(--rule-soft)", background: "var(--paper-2)", borderRadius: 6, padding: "3px 8px", letterSpacing: 0.3, ...style }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: "var(--emerald)" }} />{src}{asof && <span style={{ color: "var(--ink-4)" }}>· {asof}</span>}
    </span>
  );
}
function Consensus({ n = 2, disagree }) {
  return (
    <span title={disagree ? "Models disagree — number withheld, flagged for review" : `Extracted independently by ${n} models and matched`} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, color: "#0b0b09", background: disagree ? "var(--pop-1)" : "var(--emerald)", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px", letterSpacing: 0.4, cursor: "help" }}>
      {disagree ? "✕ MODELS DISAGREE" : `✓ VERIFIED ×${n}`}
    </span>
  );
}
function DataGap({ text, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, border: "2px dashed var(--ink)", borderRadius: 11, background: "var(--pop-2)", padding: "10px 14px", ...style }}>
      <Icon name="alert" size={15} color="#1d1d1b" />
      <span style={{ fontSize: 12.5, fontWeight: 700, color: "#1d1d1b" }}>{text}</span>
      <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, color: "#1d1d1b", cursor: "pointer" }}>RE-RUN →</span>
    </div>
  );
}
const LIFE_COLORS = { DRAFT: "var(--paper-2)", BACKTESTED: "var(--pop-3)", VALIDATED: "var(--emerald)", FORWARD: "var(--pop-2)", RETIRED: "var(--pop-1)" };
function Lifecycle({ s }) {
  return <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.8, background: LIFE_COLORS[s] || "var(--paper-2)", color: "#1d1d1b", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px" }}>{s}</span>;
}
function Delayed({ text = "EOD · as of Jul 18 close" }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 700, color: "var(--ink-2)", border: "1.5px solid var(--ink)", background: "var(--paper-2)", borderRadius: 6, padding: "3px 8px" }}><Icon name="clock" size={10} color="var(--ink-3)" />{text}</span>;
}
function WGate({ tier = "PRO", line, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--ink)", color: "var(--paper)", padding: "12px 16px", boxShadow: "3px 3px 0 var(--pop-2)", ...style }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1, background: "var(--pop-2)", color: "#1d1d1b", padding: "3px 8px", borderRadius: 6, border: "1.5px solid var(--paper)" }}>{tier}</span>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{line}</span>
      <span style={{ border: "2px solid var(--paper)", background: "var(--pop-2)", color: "#1d1d1b", borderRadius: 8, padding: "7px 13px", fontWeight: 800, fontSize: 12, cursor: "pointer", whiteSpace: "nowrap" }}>See plans →</span>
    </div>
  );
}
function WModal({ open, onClose, title, children, w = 560 }) {
  if (!open) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(20,18,12,0.55)", display: "grid", placeItems: "center", backdropFilter: "blur(2px)" }}>
      <div onClick={e => e.stopPropagation()} style={{ width: w, maxWidth: "92vw", maxHeight: "84vh", overflowY: "auto", background: "var(--paper)", border: "2px solid var(--ink)", borderRadius: 16, boxShadow: "6px 6px 0 var(--ink)", padding: "20px 22px", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px)", backgroundSize: "9px 9px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: -0.4 }}>{title}</div>
          <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer" }}><Icon name="x" size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}
function KV({ rows, mono = true }) {
  return (
    <div style={{ border: "2px solid var(--ink)", borderRadius: 12, overflow: "hidden", background: "var(--paper-3)" }}>
      {rows.map(([k, v], i) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 14px", borderTop: i ? "1.5px solid var(--rule-soft)" : "none", fontSize: 12.5 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: "var(--ink-3)", textTransform: "uppercase", alignSelf: "center" }}>{k}</span>
          <span style={{ fontFamily: mono ? "var(--font-mono)" : undefined, fontWeight: 800, textAlign: "right" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}
const OVERFIT = { low: ["LOW OVERFIT RISK", "var(--emerald)"], medium: ["MEDIUM OVERFIT RISK", "var(--pop-2)"], high: ["HIGH OVERFIT RISK", "var(--pop-1)"] };
function OverfitBadge({ level, onClick }) {
  if (!level) return null;
  const [t, c] = OVERFIT[level];
  return <button onClick={onClick} style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 0.6, background: c, color: "#1d1d1b", border: "2px solid var(--ink)", borderRadius: 7, padding: "4px 9px", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}>{t} ?</button>;
}

Object.assign(window, { WShell, WSidebar, WTabs, Provenance, Consensus, DataGap, Lifecycle, Delayed, WGate, WModal, KV, OverfitBadge, WNAV });
