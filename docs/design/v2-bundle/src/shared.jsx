// ─────────────────────────────────────────────────────────────────────────
// UseMoney iOS · shared primitives
// Lucide-style icons, brand mark, buttons, fields, OTP input, screen wrapper.
// All tuned to the "Playful" neo-brutalist design system inside an iPhone frame.
// ─────────────────────────────────────────────────────────────────────────
const { useState, useRef, useEffect } = React;

// ── Icons (lucide-style: outline, 24 viewBox, stroke 2, round caps) ────────
const P = (d) => d;
function Icon({ name, size = 22, color = "currentColor", strokeWidth = 2, style }) {
  const paths = {
    arrowR: "M5 12h14M13 6l6 6-6 6",
    arrowL: "M19 12H5M11 18l-6-6 6-6",
    check: "M20 6 9 17l-5-5",
    chevronR: "M9 6l6 6-6 6",
    chevronL: "M15 6l-6 6 6 6",
    chevronD: "M6 9l6 6 6-6",
    x: "M18 6 6 18M6 6l12 12",
    mail: "M4 5h16v14H4zM4 7l8 6 8-6",
    phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z",
    lock: "M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z",
    eyeC: "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3 3.6M6.1 6.1A18 18 0 0 0 2 12s4 7 10 7a10 10 0 0 0 2.9-.4",
    shield: "M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z",
    shieldCheck: "M12 3l8 3v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6zM9 12l2 2 4-4",
    sparkles: "M12 3l1.8 4.8L18 9.6l-4.2 1.8L12 16l-1.8-4.6L6 9.6l4.2-1.8zM19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9z",
    zap: "M13 2L4 14h7l-1 8 9-12h-7z",
    flame: "M12 3c3 4 5 6 5 9a5 5 0 0 1-10 0c0-1.5.6-2.8 1.5-4C9 9 10 8 12 3z",
    trending: "M3 17l6-6 4 4 7-7M17 8h4v4",
    wallet: "M3 7h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12l2 3M17 13h.01",
    chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    search: "M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM21 21l-4.3-4.3",
    bell: "M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0",
    file: "M7 3h7l5 5v13H7zM14 3v5h5",
    scale: "M12 3v18M5 7h14M7 7l-3 7h6zM17 7l-3 7h6zM7 21h10",
    fingerprint: "M12 11a2 2 0 0 0-2 2c0 3-1 5-1 5M12 11a2 2 0 0 1 2 2c0 2 .5 4 .5 4M7 12a5 5 0 0 1 10 0c0 4 1 6 1 6M4 13a8 8 0 0 1 16 0M9 6.5a6 6 0 0 1 7 1.5",
    refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v4h-4",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0",
    users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0M17 3a4 4 0 0 1 0 8M22 21a7 7 0 0 0-5-6.7",
    home: "M3 11l9-8 9 8M5 10v10h14V10",
    layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
    target: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M12 12m-5 0a5 5 0 1 0 10 0 5 5 0 1 0-10 0M12 12m-1 0a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
    sliders: "M4 6h11M19 6h1M4 12h1M9 12h11M4 18h7M15 18h5M15 5v2M9 11v2M11 17v2",
    star: "M12 3l2.5 6 6.5.5-5 4.2 1.6 6.3L12 16.8 6.4 20l1.6-6.3-5-4.2 6.5-.5z",
    clock: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M12 7v5l3 2",
    send: "M22 2L11 13M22 2l-7 20-4-9-9-4z",
    link: "M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1",
    menu: "M3 6h18M3 12h18M3 18h18",
    briefcase: "M3 8h18v12H3zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18",
    list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    barChart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
    cards: "M4 7h11v13H4zM8 4h11a1 1 0 0 1 1 1v11",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 4v4h4M12 8v4l3 2",
    pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
    trophy: "M7 4h10v4a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3M9 17h6M8 21h8M12 17v4",
    receipt: "M5 3h14v18l-3-2-2 2-2-2-2 2-3-2zM8 8h8M8 12h8M8 16h5",
    filter: "M3 5h18l-7 8v6l-4-2v-4z",
    brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5 3 3 0 0 0 2 4 3 3 0 0 0 5 1V4.5A2.5 2.5 0 0 0 9 4zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5 3 3 0 0 1-2 4 3 3 0 0 1-5 1",
    newspaper: "M4 5h13v15H4zM17 8h3v9a2 2 0 0 1-2 2M7 9h7M7 13h7M7 17h4",
    calc: "M5 3h14v18H5zM8 7h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v4",
    graduation: "M12 4L2 9l10 5 10-5zM6 11v5c0 1 2.7 3 6 3s6-2 6-3v-5",
    settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.4 2.6a7 7 0 0 0-1.7 1l-2.3-1-2 3.4L3 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 2.6h5l.4-2.6a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5a7 7 0 0 0 .1-1z",
    logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
    moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    download: "M12 3v12M7 10l5 5 5-5M5 21h14",
    upload: "M12 21V9M7 14l5-5 5 5M5 3h14",
    edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
    book: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 5v14",
    msg: "M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z",
    heart: "M12 20s-7-4.5-9-9a4.5 4.5 0 0 1 8-2 4.5 4.5 0 0 1 8 2c-2 4.5-9 9-9 9z",
    play: "M6 4l14 8-14 8z",
    pause: "M7 4h4v16H7zM15 4h4v16h-4z",
    info: "M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0M12 8h.01M11 12h1v4h1",
    alert: "M12 3l9 16H3zM12 9v4M12 17h.01",
    external: "M14 4h6v6M20 4l-9 9M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6",
    pie: "M12 3a9 9 0 1 0 9 9h-9z M12 3v9h9A9 9 0 0 0 12 3z",
    activity: "M22 12h-4l-3 9-6-18-3 9H2",
    calendar: "M5 5h14v15H5zM5 9h14M8 3v4M16 3v4",
    bulb: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2z",
    gift: "M20 12v9H4v-9M2 7h20v5H2zM12 22V7M12 7S9 2 6.5 4 12 7 12 7zM12 7s3-5 5.5-3S12 7 12 7z",
    globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18",
    eyeOff: "M3 3l18 18M10.6 10.6a3 3 0 0 0 4.2 4.2M9.9 5.2A10 10 0 0 1 12 5c6 0 10 7 10 7a18 18 0 0 1-3 3.6M6.1 6.1A18 18 0 0 0 2 12s4 7 10 7a10 10 0 0 0 2.9-.4",
    line: "M3 17l6-6 4 4 7-7",
    scroll: "M5 4h11v13a3 3 0 0 0 3 3H8a3 3 0 0 1-3-3zM16 4h3v3h-3M5 8h8M5 12h8",
    dot: "",
  };
  if (name === "dot") {
    return <span style={{ display: "inline-block", width: size * 0.4, height: size * 0.4, borderRadius: 99, background: color, ...style }} />;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style}>
      <path d={paths[name] || ""} />
    </svg>
  );
}

// ── Brand glyphs ───────────────────────────────────────────────────────────
function GoogleGlyph({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}
function AppleGlyph({ size = 18, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <path d="M17.5 12.5c0-3.07 2.5-4.55 2.61-4.62-1.42-2.08-3.64-2.37-4.42-2.4-1.88-.19-3.66 1.11-4.62 1.11-.95 0-2.42-1.08-3.99-1.05-2.05.03-3.94 1.19-5 3.02-2.13 3.7-.55 9.18 1.54 12.18 1.02 1.47 2.23 3.12 3.83 3.06 1.54-.06 2.12-1 3.98-1s2.38 1 4 .97c1.65-.03 2.7-1.5 3.71-2.97 1.17-1.71 1.65-3.36 1.68-3.45-.04-.02-3.22-1.24-3.32-4.85zM14.84 4.16c.85-1.03 1.42-2.46 1.26-3.88-1.22.05-2.7.81-3.58 1.84-.79.91-1.48 2.36-1.29 3.76 1.36.11 2.75-.69 3.61-1.72z"/>
    </svg>
  );
}

// ── Brand mark + wordmark ───────────────────────────────────────────────────
function BrandMark({ size = 34, fill = "var(--ink)", glyph = "var(--paper)", rotate = -3 }) {
  return (
    <span style={{
      width: size, height: size, borderRadius: size * 0.22, background: fill, color: glyph,
      display: "grid", placeItems: "center", fontFamily: "var(--font-mono)", fontWeight: 800,
      fontSize: size * 0.56, transform: `rotate(${rotate}deg)`, flexShrink: 0, letterSpacing: -1,
    }}>U</span>
  );
}
function Wordmark({ size = 19, color = "var(--ink)" }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <BrandMark size={size * 1.7} />
      <span style={{ fontWeight: 800, fontSize: size, letterSpacing: -0.5, color }}>
        UseMoney<sup style={{ fontFamily: "var(--font-mono)", fontSize: size * 0.42, color: "var(--emerald)", fontWeight: 700, marginLeft: 1, top: "-0.7em" }}>AI</sup>
      </span>
    </span>
  );
}

// ── Eyebrow (mono emerald label w/ live dot) ────────────────────────────────
function Eyebrow({ children, color = "var(--emerald)", dot = true }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color, letterSpacing: 1.4, textTransform: "uppercase" }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />}
      {children}
    </div>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────
function PrimaryBtn({ children, onClick, icon = "arrowR", disabled, full = true, style }) {
  const [press, setPress] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled}
      onPointerDown={() => setPress(true)} onPointerUp={() => setPress(false)} onPointerLeave={() => setPress(false)}
      style={{
        width: full ? "100%" : undefined, display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
        padding: "16px 20px", borderRadius: 12, border: "2px solid var(--ink)",
        background: "var(--ink)", color: "var(--paper)", fontFamily: "var(--font-sans)", fontWeight: 800, fontSize: 16,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
        boxShadow: press ? "2px 2px 0 var(--emerald)" : "4px 4px 0 var(--emerald)",
        transform: press ? "translate(2px,2px)" : "none", transition: "transform .1s, box-shadow .1s",
        ...style,
      }}>
      {children}{icon && <Icon name={icon} size={17} color="var(--paper)" />}
    </button>
  );
}
function GhostBtn({ children, onClick, icon, full = true, accent = "var(--ink)", style }) {
  const [press, setPress] = useState(false);
  return (
    <button onClick={onClick}
      onPointerDown={() => setPress(true)} onPointerUp={() => setPress(false)} onPointerLeave={() => setPress(false)}
      style={{
        width: full ? "100%" : undefined, display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
        padding: "15px 20px", borderRadius: 12, border: "2px solid var(--ink)",
        background: "var(--paper)", color: accent, fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 15,
        cursor: "pointer", boxShadow: press ? "1px 1px 0 var(--ink)" : "3px 3px 0 var(--ink)",
        transform: press ? "translate(2px,2px)" : "none", transition: "transform .1s, box-shadow .1s",
        ...style,
      }}>
      {icon && <Icon name={icon} size={16} color={accent} />}{children}
    </button>
  );
}
function OAuthBtn({ kind, onClick }) {
  const cfg = {
    apple: { glyph: <AppleGlyph color="var(--ink)" />, label: "Continue with Apple" },
    google: { glyph: <GoogleGlyph />, label: "Continue with Google" },
    phone: { glyph: <Icon name="phone" size={17} color="var(--ink)" />, label: "Continue with phone" },
  }[kind];
  const [press, setPress] = useState(false);
  return (
    <button onClick={onClick}
      onPointerDown={() => setPress(true)} onPointerUp={() => setPress(false)} onPointerLeave={() => setPress(false)}
      style={{
        width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
        padding: "13px 16px", borderRadius: 11, border: "2px solid var(--ink)", background: "var(--paper)",
        color: "var(--ink)", fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 14.5, cursor: "pointer",
        boxShadow: press ? "1px 1px 0 var(--ink)" : "3px 3px 0 var(--ink)",
        transform: press ? "translate(2px,2px)" : "none", transition: "transform .1s, box-shadow .1s",
      }}>
      {cfg.glyph} {cfg.label}
    </button>
  );
}

// ── Text field ──────────────────────────────────────────────────────────────
function Field({ label, hint, type = "text", value, onChange, placeholder, prefix, right, autoFocus }) {
  const [focus, setFocus] = useState(false);
  const [show, setShow] = useState(false);
  const isPw = type === "password";
  return (
    <label style={{ display: "block", marginTop: 16, minWidth: 0 }}>
      {label && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 7, gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink-2)", letterSpacing: 0.2, whiteSpace: "nowrap" }}>{label}</span>
          {hint && <span style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{hint}</span>}
        </div>
      )}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "0 14px", width: "100%",
        border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)",
        boxShadow: focus ? "3px 3px 0 var(--ink)" : "none", transform: focus ? "translate(-1px,-1px)" : "none",
        transition: "transform .12s, box-shadow .12s",
      }}>
        {prefix && <span style={{ fontFamily: "var(--font-mono)", fontSize: 14.5, color: "var(--ink-3)", fontWeight: 600 }}>{prefix}</span>}
        <input
          type={isPw && !show ? "password" : type === "password" ? "text" : type}
          value={value} onChange={(e) => onChange && onChange(e.target.value)}
          placeholder={placeholder} autoFocus={autoFocus}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
          style={{
            flex: 1, border: 0, outline: 0, background: "transparent", padding: "14px 0",
            fontSize: 15.5, color: "var(--ink)", fontFamily: "var(--font-sans)", minWidth: 0,
          }} />
        {isPw && (
          <button type="button" onClick={(e) => { e.preventDefault(); setShow(s => !s); }} style={{ border: 0, background: "transparent", cursor: "pointer", padding: 4, display: "flex" }}>
            <Icon name={show ? "eyeC" : "eye"} size={18} color="var(--ink-3)" />
          </button>
        )}
        {right}
      </div>
    </label>
  );
}

// ── OTP input (interactive) ─────────────────────────────────────────────────
function OTPInput({ length = 6, value = "", onChange, autoFocus }) {
  const refs = useRef([]);
  const set = (i, v) => {
    const digit = v.replace(/\D/g, "").slice(-1);
    const arr = value.padEnd(length, " ").split("");
    arr[i] = digit || " ";
    const next = arr.join("").replace(/ /g, "").padEnd(value.length, "");
    let s = value.split("");
    s[i] = digit;
    const joined = s.join("").slice(0, length);
    onChange && onChange(joined);
    if (digit && i < length - 1) refs.current[i + 1]?.focus();
  };
  const key = (i, e) => {
    if (e.key === "Backspace" && !value[i] && i > 0) refs.current[i - 1]?.focus();
  };
  return (
    <div style={{ display: "flex", gap: 9, justifyContent: "space-between" }}>
      {Array.from({ length }).map((_, i) => {
        const filled = !!value[i];
        return (
          <input key={i} ref={(el) => (refs.current[i] = el)}
            inputMode="numeric" maxLength={1} value={value[i] || ""}
            autoFocus={autoFocus && i === 0}
            onChange={(e) => set(i, e.target.value)} onKeyDown={(e) => key(i, e)}
            onFocus={(e) => e.target.select()}
            style={{
              width: 48, height: 58, textAlign: "center", border: "2px solid var(--ink)", borderRadius: 11,
              background: filled ? "var(--paper-3)" : "var(--paper-2)",
              boxShadow: filled ? "3px 3px 0 var(--ink)" : "none",
              fontFamily: "var(--font-mono)", fontSize: 24, fontWeight: 800, color: "var(--ink)",
              outline: "none", transition: "box-shadow .12s, background .12s",
            }} />
        );
      })}
    </div>
  );
}

// ── Gold sticker ────────────────────────────────────────────────────────────
function Sticker({ children, rotate = 4, style }) {
  return (
    <div style={{
      padding: "11px 15px", background: "var(--pop-2)", color: "#1d1d1b",
      border: "2px solid #1d1d1b", borderRadius: 12, boxShadow: "4px 4px 0 #000",
      transform: `rotate(${rotate}deg)`, fontFamily: "var(--font-serif)", fontStyle: "italic",
      fontSize: 15.5, lineHeight: 1.25, ...style,
    }}>{children}</div>
  );
}

// ── Carousel dots ───────────────────────────────────────────────────────────
function Dots({ count, active, onDot }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {Array.from({ length: count }).map((_, i) => (
        <span key={i} onClick={() => onDot && onDot(i)} style={{
          width: i === active ? 26 : 8, height: 8, borderRadius: 99,
          background: i === active ? "var(--ink)" : "var(--rule-soft)", cursor: "pointer",
          transition: "width .2s, background .2s",
        }} />
      ))}
    </div>
  );
}

// ── Auth step bar ───────────────────────────────────────────────────────────
function StepBar({ total, current }) {
  return (
    <div style={{ display: "flex", gap: 7 }}>
      {Array.from({ length: total }).map((_, i) => (
        <span key={i} style={{
          flex: 1, height: 5, borderRadius: 99,
          background: i < current ? "var(--emerald)" : i === current ? "var(--ink)" : "var(--rule-soft)",
        }} />
      ))}
    </div>
  );
}

// ── Phone screen wrapper ────────────────────────────────────────────────────
// Cream paper + dot-grid, top safe-area, scroll body, optional pinned footer.
function Screen({ children, footer, bg = "var(--paper)", pad = 22, topPad = 64, scroll = true, dotGrid = true, onBack, headerRight }) {
  return (
    <div className="um" style={{
      height: "100%", display: "flex", flexDirection: "column", background: bg,
      backgroundImage: dotGrid ? "radial-gradient(var(--dot-fg) 1px, transparent 1.5px), radial-gradient(var(--dot-fg-2) 1px, transparent 1.5px)" : "none",
      backgroundSize: "7px 7px, 11px 11px", backgroundPosition: "0 0, 3px 3px",
    }}>
      {(onBack || headerRight) && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${topPad - 6}px ${pad}px 4px`, flexShrink: 0 }}>
          {onBack ? (
            <button onClick={onBack} style={{ width: 38, height: 38, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}>
              <Icon name="arrowL" size={18} color="var(--ink)" />
            </button>
          ) : <span />}
          {headerRight}
        </div>
      )}
      <div style={{
        flex: 1, overflowY: scroll ? "auto" : "hidden", padding: `${(onBack || headerRight) ? 8 : topPad}px ${pad}px 16px`,
        display: "flex", flexDirection: "column",
      }}>
        {children}
      </div>
      {footer && (
        <div style={{ flexShrink: 0, padding: `12px ${pad}px calc(env(safe-area-inset-bottom) + 30px)`, background: bg, borderTop: "1.5px dashed var(--rule-soft)" }}>
          {footer}
        </div>
      )}
    </div>
  );
}

// ── Trust footnote (Clerk row) ──────────────────────────────────────────────
function ClerkRow({ children = "Secured by Clerk · encrypted" }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--ink-3)", letterSpacing: 0.5, textTransform: "uppercase" }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--emerald)" }} />
      {children}
    </div>
  );
}

Object.assign(window, {
  Icon, GoogleGlyph, AppleGlyph, BrandMark, Wordmark, Eyebrow,
  PrimaryBtn, GhostBtn, OAuthBtn, Field, OTPInput, Sticker, Dots, StepBar, Screen, ClerkRow,
});
