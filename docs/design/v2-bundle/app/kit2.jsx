// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · new primitives: sheets, toasts, charts, chips, search
// (extends shared.jsx — Icon, PrimaryBtn, GhostBtn, Screen etc. are globals)
// ─────────────────────────────────────────────────────────────────────────
const { useState: k2S, useEffect: k2E, useRef: k2R } = React;

// ── Card ────────────────────────────────────────────────────────────────────
function Card({ children, style, onClick, pad = 16, shadow = "3px 3px 0 var(--ink)", bg = "var(--paper-3)" }) {
  return (
    <div onClick={onClick}
      style={{ border: "2px solid var(--ink)", borderRadius: 14, background: bg, boxShadow: shadow, padding: pad, cursor: onClick ? "pointer" : "default", ...style }}>
      {children}
    </div>
  );
}

// ── Press wrapper (tap feedback) ────────────────────────────────────────────
function Press({ children, onClick, style, disabled }) {
  const [p, setP] = React.useState(false);
  return (
    <div onClick={disabled ? undefined : onClick}
      onPointerDown={() => setP(true)} onPointerUp={() => setP(false)} onPointerLeave={() => setP(false)}
      style={{ cursor: disabled ? "default" : "pointer", transform: p && !disabled ? "scale(0.985)" : "none", transition: "transform .09s", ...style }}>
      {children}
    </div>
  );
}

// ── Segmented control (stamped active) ──────────────────────────────────────
function Seg({ options, value, onChange, size = 12.5, grow = true, style }) {
  return (
    <div style={{ display: "flex", gap: 0, border: "2px solid var(--ink)", borderRadius: 11, overflow: "hidden", background: "var(--paper-3)", ...style }}>
      {options.map((o, i) => {
        const act = o.k === value;
        return (
          <button key={o.k} onClick={() => onChange(o.k)} style={{
            flex: grow ? 1 : undefined, padding: "9px 12px", border: 0, borderLeft: i ? "2px solid var(--ink)" : 0,
            background: act ? "var(--ink)" : "transparent", color: act ? "var(--paper)" : "var(--ink-2)",
            fontFamily: "var(--font-sans)", fontWeight: act ? 800 : 600, fontSize: size, cursor: "pointer", whiteSpace: "nowrap",
            transition: "background .12s",
          }}>{o.label}</button>
        );
      })}
    </div>
  );
}

// ── Pill chip ───────────────────────────────────────────────────────────────
function Chip({ children, active, onClick, color = "var(--ink)", style }) {
  return (
    <button onClick={onClick} style={{
      padding: "7px 13px", borderRadius: 99, border: "2px solid var(--ink)", cursor: onClick ? "pointer" : "default",
      background: active ? color : "var(--paper-3)", color: active ? "var(--paper)" : "var(--ink-2)",
      fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap",
      boxShadow: active ? "none" : "2px 2px 0 var(--ink)", transition: "background .12s", ...style,
    }}>{children}</button>
  );
}

// ── Mono tag (ticker/label) ────────────────────────────────────────────────
function Tag({ children, color = "var(--ink-3)", bg = "transparent", border = true, style }) {
  return (
    <span style={{
      fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase",
      color, background: bg, padding: "3px 7px", borderRadius: 6,
      border: border ? "1.5px solid var(--rule-soft)" : "none", whiteSpace: "nowrap", ...style,
    }}>{children}</span>
  );
}

// ── Credits chip (topbar) + cost chip (actions) ────────────────────────────
function CreditChip({ n, onClick, size = "md" }) {
  return (
    <button onClick={onClick} style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: size === "md" ? "6px 11px" : "4px 9px",
      borderRadius: 99, border: "2px solid var(--ink)", background: "var(--pop-2)", color: "#1d1d1b",
      fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: size === "md" ? 12 : 11, cursor: "pointer",
      boxShadow: "2px 2px 0 var(--ink)",
    }}>
      <Icon name="zap" size={12} color="#1d1d1b" strokeWidth={2.6} />{n}
    </button>
  );
}
function CostChip({ n, style }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "#1d1d1b", background: "var(--pop-2)", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "2px 7px", letterSpacing: 0.4, ...style }}>
      <Icon name="zap" size={10} color="#1d1d1b" strokeWidth={2.8} />{n} {n === 1 ? "credit" : "credits"}
    </span>
  );
}

// ── Gain/loss number ────────────────────────────────────────────────────────
function Num({ v, fmt = "money", dec = 0, size = 13, mono = true, sign = true, style }) {
  const pos = v >= 0;
  const txt = fmt === "pct" ? pct(v, dec) : sign ? signMoney(v, dec) : money(v, dec);
  return <span style={{ fontFamily: mono ? "var(--font-mono)" : undefined, fontSize: size, fontWeight: 700, color: pos ? "var(--gain-text)" : "var(--loss)", fontVariantNumeric: "tabular-nums", ...style }}>{txt}</span>;
}

// ── Stat cell ───────────────────────────────────────────────────────────────
function StatCell({ label, value, sub, color = "var(--ink)", subColor = "var(--ink-3)", align = "left" }) {
  return (
    <div style={{ textAlign: align, minWidth: 0 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 16, fontWeight: 800, color, marginTop: 3, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</div>
      {sub && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, color: subColor, marginTop: 2, whiteSpace: "nowrap" }}>{sub}</div>}
    </div>
  );
}

// ── Broker logo tile ────────────────────────────────────────────────────────
function BrokerLogo({ id, size = 30, rotate = 0 }) {
  const m = BROKER_META[id];
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.26, border: "2px solid var(--ink)", background: "#fff", display: "grid", placeItems: "center", overflow: "hidden", flexShrink: 0, transform: rotate ? `rotate(${rotate}deg)` : "none" }}>
      <img src={m.logo} alt={m.name} style={{ width: "68%", height: "68%", objectFit: "contain" }} />
    </span>
  );
}

// ── Symbol avatar (letter tile) ────────────────────────────────────────────
const SYM_COLORS = ["var(--pop-2)", "var(--pop-1)", "var(--pop-3)", "var(--pop-4)", "var(--pop-5)", "var(--emerald)"];
function SymTile({ sym, size = 38, rotate = 0 }) {
  const i = (sym.charCodeAt(0) + sym.length) % SYM_COLORS.length;
  return (
    <span style={{ width: size, height: size, borderRadius: size * 0.26, border: "2px solid var(--ink)", background: SYM_COLORS[i], color: "#1d1d1b", display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: size * 0.4, flexShrink: 0, transform: rotate ? `rotate(${rotate}deg)` : "none" }}>
      {sym[0]}
    </span>
  );
}

// ── Line / area chart (svg) ────────────────────────────────────────────────
function LineChart({ series, w = 320, h = 90, color = "var(--emerald)", fill = true, strokeWidth = 2.2, baseline }) {
  if (!series || series.length < 2) return <div style={{ height: h }} />;
  const min = Math.min(...series), max = Math.max(...series), rng = max - min || 1;
  const pts = series.map((v, i) => [i / (series.length - 1) * w, h - 6 - (v - min) / rng * (h - 14)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
  const area = d + ` L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" style={{ display: "block" }}>
      {fill && <path d={area} fill={color} opacity="0.13" />}
      {baseline != null && <line x1="0" x2={w} y1={h - 6 - (baseline - min) / rng * (h - 14)} y2={h - 6 - (baseline - min) / rng * (h - 14)} stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="3 4" />}
      <path d={d} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3.4" fill={color} stroke="var(--paper-3)" strokeWidth="1.6" />
    </svg>
  );
}

// ── Donut (allocation) ─────────────────────────────────────────────────────
function Donut({ parts, size = 108, thick = 16, centerTop, centerSub }) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  const R = (size - thick) / 2, C = 2 * Math.PI * R;
  let acc = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={R} fill="none" stroke="var(--rule-soft)" strokeWidth={thick} />
        {parts.map((p, i) => {
          const frac = p.v / total, off = acc; acc += frac;
          return <circle key={i} cx={size / 2} cy={size / 2} r={R} fill="none" stroke={p.color} strokeWidth={thick}
            strokeDasharray={`${Math.max(frac * C - 3, 0)} ${C}`} strokeDashoffset={-off * C} strokeLinecap="butt" />;
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div style={{ fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 15, color: "var(--ink)" }}>{centerTop}</div>
          {centerSub && <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", fontWeight: 600, letterSpacing: 0.6 }}>{centerSub}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Horizontal bar row ─────────────────────────────────────────────────────
function HBar({ label, value, max, color = "var(--emerald)", right }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)" }}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 700, color: "var(--ink-2)" }}>{right}</span>
      </div>
      <div style={{ height: 10, border: "1.5px solid var(--ink)", borderRadius: 99, background: "var(--paper-2)", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(value / max * 100, 100)}%`, height: "100%", background: color, transition: "width .5s cubic-bezier(.22,.61,.36,1)" }} />
      </div>
    </div>
  );
}

// ── Spinner ────────────────────────────────────────────────────────────────
function Spinner({ size = 18, color = "var(--ink)" }) {
  return (
    <span style={{ display: "inline-block", width: size, height: size, flexShrink: 0 }}>
      <style>{`@keyframes umspin{to{transform:rotate(360deg)}}`}</style>
      <svg viewBox="0 0 24 24" width={size} height={size} style={{ animation: "umspin .8s linear infinite", display: "block" }}>
        <circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="3" opacity="0.18" />
        <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

// ── Progress steps (sync / research runs) ───────────────────────────────────
function ProgressSteps({ steps, current }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {steps.map((s, i) => {
        const done = i < current, act = i === current;
        return (
          <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", opacity: done || act ? 1 : 0.38 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <span style={{ width: 26, height: 26, borderRadius: 8, border: "2px solid var(--ink)", background: done ? "var(--emerald)" : act ? "var(--pop-2)" : "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                {done ? <Icon name="check" size={13} color="#0b0b09" strokeWidth={3} /> : act ? <Spinner size={13} color="#1d1d1b" /> : <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, color: "var(--ink-3)" }}>{i + 1}</span>}
              </span>
              {i < steps.length - 1 && <span style={{ width: 2, height: 22, background: done ? "var(--emerald)" : "var(--rule-soft)" }} />}
            </div>
            <div style={{ paddingTop: 4, paddingBottom: 8 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{s.t}</div>
              {s.d && (done || act) && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 2 }}>{s.d}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
function EmptyState({ icon = "search", title, sub, cta, onCta, sticker }) {
  return (
    <div style={{ padding: "34px 18px", textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <span style={{ width: 56, height: 56, borderRadius: 16, border: "2px solid var(--ink)", background: "var(--paper-2)", display: "grid", placeItems: "center", transform: "rotate(-3deg)", boxShadow: "3px 3px 0 var(--ink)", marginBottom: 8 }}>
        <Icon name={icon} size={26} color="var(--ink-2)" />
      </span>
      <div style={{ fontWeight: 800, fontSize: 16.5, letterSpacing: -0.4, color: "var(--ink)" }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: "var(--ink-3)", maxWidth: 250, lineHeight: 1.5 }}>{sub}</div>}
      {sticker && <div style={{ marginTop: 10 }}><Sticker rotate={-3} style={{ fontSize: 13.5 }}>{sticker}</Sticker></div>}
      {cta && <div style={{ marginTop: 14, width: "100%", maxWidth: 240 }}><PrimaryBtn onClick={onCta}>{cta}</PrimaryBtn></div>}
    </div>
  );
}

// ── Bottom sheet (inside phone) ────────────────────────────────────────────
function SheetHost({ sheet, onClose }) {
  const [drag, setDrag] = React.useState(0);
  const startY = k2R(null);
  k2E(() => { setDrag(0); }, [sheet]);
  if (!sheet) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 70, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <style>{`@keyframes umsheet{from{transform:translateY(100%)}to{transform:none}}@keyframes umscrim2{from{opacity:0}to{opacity:1}}`}</style>
      <div onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(20,18,12,0.5)", animation: "umscrim2 .2s both" }} />
      <div
        onPointerDown={e => { startY.current = e.clientY; }}
        onPointerMove={e => { if (startY.current != null) setDrag(Math.max(0, e.clientY - startY.current)); }}
        onPointerUp={() => { if (drag > 90) onClose(); else setDrag(0); startY.current = null; }}
        style={{
          position: "relative", maxHeight: "88%", background: "var(--paper)", borderTop: "2px solid var(--ink)",
          borderRadius: "20px 20px 0 0", animation: "umsheet .26s cubic-bezier(.22,.61,.36,1) both",
          transform: drag ? `translateY(${drag}px)` : undefined, transition: drag ? "none" : "transform .2s",
          display: "flex", flexDirection: "column", boxShadow: "0 -14px 40px rgba(0,0,0,0.25)",
          backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px)", backgroundSize: "9px 9px",
        }}>
        <div style={{ padding: "10px 0 4px", display: "grid", placeItems: "center", flexShrink: 0, cursor: "grab", touchAction: "none" }}>
          <span style={{ width: 44, height: 5, borderRadius: 99, background: "var(--ink)", opacity: 0.7 }} />
        </div>
        {sheet.title && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 20px 10px", borderBottom: "1.5px dashed var(--rule-soft)", flexShrink: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 17, letterSpacing: -0.4, color: "var(--ink)" }}>{sheet.title}</div>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer" }}>
              <Icon name="x" size={14} color="var(--ink)" strokeWidth={2.5} />
            </button>
          </div>
        )}
        <div style={{ overflowY: "auto", padding: "14px 20px calc(env(safe-area-inset-bottom) + 28px)" }}>
          {sheet.body}
        </div>
      </div>
    </div>
  );
}

// ── Toast host ─────────────────────────────────────────────────────────────
function ToastHost({ toast }) {
  if (!toast) return null;
  const kindIcon = { ok: "check", err: "alert", info: "info" }[toast.kind || "ok"];
  const kindBg = { ok: "var(--emerald)", err: "var(--pop-1)", info: "var(--pop-2)" }[toast.kind || "ok"];
  return (
    <div style={{ position: "absolute", left: 16, right: 16, bottom: 96, zIndex: 90, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <style>{`@keyframes umtoast{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}`}</style>
      <div key={toast.id} style={{
        display: "inline-flex", alignItems: "center", gap: 9, padding: "11px 16px", borderRadius: 12,
        border: "2px solid var(--ink)", background: "var(--ink)", color: "var(--paper)",
        fontSize: 13, fontWeight: 700, boxShadow: "3px 3px 0 " + kindBg, animation: "umtoast .22s cubic-bezier(.22,.61,.36,1) both", maxWidth: "100%",
      }}>
        <span style={{ width: 20, height: 20, borderRadius: 6, background: kindBg, display: "grid", placeItems: "center", flexShrink: 0 }}>
          <Icon name={kindIcon} size={12} color="#0b0b09" strokeWidth={3} />
        </span>
        {toast.msg}
      </div>
    </div>
  );
}

// ── Sync pill ──────────────────────────────────────────────────────────────
function SyncPill({ state = "ok", label, onClick }) {
  const cfg = {
    ok: { c: "var(--emerald)", t: label || "Synced 09:31 am" },
    busy: { c: "var(--pop-2)", t: label || "Syncing…" },
    err: { c: "var(--pop-1)", t: label || "1 broker needs attention" },
  }[state];
  return (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 99, border: "1.5px solid var(--rule-soft)", background: "var(--paper-3)", cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: "var(--ink-2)", textTransform: "uppercase" }}>
      <span className={state === "busy" ? "" : undefined} style={{ width: 6, height: 6, borderRadius: 99, background: cfg.c, animation: state !== "ok" ? "umpulse 1.6s infinite" : "none" }} />
      <style>{`@keyframes umpulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
      {cfg.t}
      {state === "err" && <Icon name="chevronR" size={11} color="var(--ink-3)" />}
    </button>
  );
}

// ── Gate banner (tier lock, inline upsell) ─────────────────────────────────
function GateBanner({ tier = "PRO", line, onUpgrade, style }) {
  return (
    <div style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--ink)", color: "var(--paper)", padding: "14px 16px", boxShadow: "3px 3px 0 var(--pop-2)", ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 1, background: "var(--pop-2)", color: "#1d1d1b", padding: "3px 8px", borderRadius: 6, border: "1.5px solid var(--paper)" }}>{tier}</span>
        <Icon name="lock" size={14} color="var(--paper)" />
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 600, lineHeight: 1.45, marginTop: 8 }}>{line}</div>
      <button onClick={onUpgrade} style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 7, padding: "9px 15px", borderRadius: 9, border: "2px solid var(--paper)", background: "var(--pop-2)", color: "#1d1d1b", fontWeight: 800, fontSize: 12.5, cursor: "pointer", fontFamily: "var(--font-sans)" }}>
        See plans <Icon name="arrowR" size={13} color="#1d1d1b" strokeWidth={2.6} />
      </button>
    </div>
  );
}

// ── Section head (in-page) ─────────────────────────────────────────────────
function SecHead({ label, right, style }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "22px 0 10px", ...style }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 7, height: 7, background: "var(--ink)", borderRadius: 2, transform: "rotate(-8deg)" }} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, letterSpacing: 1.2, color: "var(--ink-3)", textTransform: "uppercase" }}>{label}</span>
      </div>
      {right}
    </div>
  );
}

// ── List row (generic) ─────────────────────────────────────────────────────
function RowItem({ left, title, sub, right, rightSub, onClick, last, pad = "12px 14px" }) {
  const [p, setP] = React.useState(false);
  return (
    <div onClick={onClick}
      onPointerDown={() => setP(true)} onPointerUp={() => setP(false)} onPointerLeave={() => setP(false)}
      style={{ display: "flex", alignItems: "center", gap: 12, padding: pad, borderBottom: last ? "none" : "1.5px solid var(--rule-soft)", cursor: onClick ? "pointer" : "default", background: p && onClick ? "var(--paper-2)" : "transparent", transition: "background .1s" }}>
      {left}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 750, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
        {sub && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", marginTop: 2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{sub}</div>}
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        {right && <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{right}</div>}
        {rightSub && <div style={{ marginTop: 2 }}>{rightSub}</div>}
      </div>
      {onClick && <Icon name="chevronR" size={14} color="var(--ink-4)" style={{ flexShrink: 0, marginLeft: -4 }} />}
    </div>
  );
}
function ListCard({ children, style }) {
  return <div style={{ border: "2px solid var(--ink)", borderRadius: 14, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", overflow: "hidden", ...style }}>{children}</div>;
}

// ── Pull-to-refresh wrapper (simulated) ────────────────────────────────────
function PullRefresh({ onRefresh, children }) {
  const [pull, setPull] = React.useState(0);
  const [busy, setBusy] = React.useState(false);
  const start = k2R(null);
  const ref = k2R(null);
  return (
    <div
      onPointerDown={e => { if (ref.current && ref.current.scrollTop <= 0) start.current = e.clientY; }}
      onPointerMove={e => { if (start.current != null && !busy) { const d = e.clientY - start.current; if (d > 0 && ref.current.scrollTop <= 0) setPull(Math.min(d * 0.5, 74)); } }}
      onPointerUp={() => {
        if (pull > 56 && !busy) { setBusy(true); setPull(48); onRefresh(() => { setBusy(false); setPull(0); }); }
        else setPull(0);
        start.current = null;
      }}
      style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: pull, display: "grid", placeItems: "center", flexShrink: 0, transition: busy ? "height .2s" : pull === 0 ? "height .25s" : "none", overflow: "hidden" }}>
        {(pull > 8) && (busy ? <Spinner size={17} /> : <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)" }}>{pull > 56 ? "RELEASE TO SYNC" : "PULL TO SYNC"}</span>)}
      </div>
      <div ref={ref} style={{ flex: 1, overflowY: "auto", touchAction: "pan-y" }}>{children}</div>
    </div>
  );
}

// ── Watch star ─────────────────────────────────────────────────────────────
function StarBtn({ on, onClick, size = 34 }) {
  return (
    <button onClick={e => { e.stopPropagation(); onClick(); }} style={{ width: size, height: size, borderRadius: 9, border: "2px solid var(--ink)", background: on ? "var(--pop-2)" : "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)", flexShrink: 0 }}>
      <Icon name="star" size={size * 0.46} color="#1d1d1b" strokeWidth={on ? 2.6 : 2} />
    </button>
  );
}

Object.assign(window, {
  Card, Press, Seg, Chip, Tag, CreditChip, CostChip, Num, StatCell, BrokerLogo, SymTile,
  LineChart, Donut, HBar, Spinner, ProgressSteps, EmptyState, SheetHost, ToastHost,
  SyncPill, GateBanner, SecHead, RowItem, ListCard, PullRefresh, StarBtn,
});
