// Android (Material 3) phone bezel — mirrors IOSDevice's overlay model so the
// exact same UseMoney screens render unchanged. Status bar + gesture nav are
// absolute overlays; content fills the full height and supplies its own top pad.
function AndroidPhone({ children, dark = false, width = 412, height = 892 }) {
  const c = dark ? "#f4ede0" : "#1d1d1b";
  return (
    <div style={{
      width, height, borderRadius: 44, overflow: "hidden", position: "relative",
      background: dark ? "#16140e" : "#f7f3e6",
      boxShadow: "0 40px 80px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.12)",
      border: "9px solid #0c0c0a", boxSizing: "border-box",
    }}>
      {/* center punch-hole camera */}
      <div style={{ position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", width: 13, height: 13, borderRadius: 99, background: "#000", zIndex: 50 }} />
      {/* status bar (absolute overlay, Android layout: time left · icons right) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 34, zIndex: 40, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", pointerEvents: "none" }}>
        <span style={{ fontFamily: "'Inter', system-ui, sans-serif", fontSize: 13.5, fontWeight: 700, color: c, letterSpacing: 0.2 }}>9:30</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* signal */}
          <svg width="16" height="12" viewBox="0 0 16 12"><path d="M14.5 11.5L0.8 5.6a10 10 0 0 1 13.7 0z" fill={c} /></svg>
          {/* wifi */}
          <svg width="15" height="12" viewBox="0 0 16 12"><path d="M14.7 14.7V1.3L1.3 14.7z" transform="scale(0.8)" fill={c} /></svg>
          {/* battery */}
          <svg width="22" height="12" viewBox="0 0 24 12"><rect x="1" y="1.5" width="20" height="9" rx="2.5" fill="none" stroke={c} strokeWidth="1.4" /><rect x="3" y="3.5" width="15" height="5" rx="1" fill={c} /><rect x="22" y="4" width="1.6" height="4" rx="0.8" fill={c} /></svg>
        </div>
      </div>
      {/* full-bleed content */}
      <div style={{ height: "100%", overflow: "hidden" }}>{children}</div>
      {/* gesture nav pill (absolute, on top) */}
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 22, zIndex: 60, display: "flex", justifyContent: "center", alignItems: "flex-end", paddingBottom: 7, pointerEvents: "none" }}>
        <div style={{ width: 132, height: 4, borderRadius: 99, background: dark ? "rgba(244,237,224,0.55)" : "rgba(29,29,27,0.4)" }} />
      </div>
    </div>
  );
}
window.AndroidPhone = AndroidPhone;
