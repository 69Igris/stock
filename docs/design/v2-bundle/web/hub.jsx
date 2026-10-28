// ─────────────────────────────────────────────────────────────────────────
// A–H hub — one page, every module, clickable switcher
// ─────────────────────────────────────────────────────────────────────────
const { useState: hbS } = React;

const HUB = [
  ["A", "Strategy Lab", (k) => <StrategiesPage key={k} start="lab" />],
  ["B", "Analyst Board", (k) => <ModuleB key={k} />],
  ["C", "Signals & FwdRun", (k) => <StrategiesPage key={k} start="signals" />],
  ["D", "US Launch", (k) => <ModuleD key={k} />],
  ["E", "Personalization", (k) => <ModuleE key={k} />],
  ["F", "Memory & DNA", (k) => <ModuleF key={k} />],
  ["G", "Model Picker", (k) => <ModuleG key={k} />],
  ["H", "Dev Console", (k) => <ModuleH key={k} />],
];

function ModulesHub() {
  const [i, setI] = hbS(0);
  return (
    <div>
      {HUB[i][2](HUB[i][0])}
      <div style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 80, display: "flex", alignItems: "center", gap: 6, border: "2px solid #1d1d1b", borderRadius: 99, background: "#fbf8eb", padding: "6px 8px", boxShadow: "3px 3px 0 #1d1d1b", fontFamily: "'JetBrains Mono', monospace" }}>
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: "#6b6b62", padding: "0 4px" }}>2026H2</span>
        {HUB.map(([L, name], x) => (
          <button key={L} onClick={() => setI(x)} title={name}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "2px solid #1d1d1b", borderRadius: 99, cursor: "pointer", padding: x === i ? "6px 12px" : "6px 9px", background: x === i ? "#1d1d1b" : "#f7f3e6", color: x === i ? "#f7f3e6" : "#1d1d1b", fontWeight: 800, fontSize: 11, fontFamily: "'JetBrains Mono', monospace", transition: "all .12s" }}>
            {L}{x === i && <span style={{ fontSize: 10, fontFamily: "'Inter', sans-serif", fontWeight: 700 }}>{name}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
window.ModulesHub = ModulesHub;
