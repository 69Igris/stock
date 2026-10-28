// ─────────────────────────────────────────────────────────────────────────
// Strategies — unified surface: Lab (catalog/builder/mine) + Signals + ForwardRun
// UX: /strategies stays ONE nav destination (matches repo IA — strategies/[id]/
// backtest + forward routes already exist). Signals are strategy-scoped, so
// they live INSIDE, not as a sibling nav item. Lifecycle is the connective
// tissue: BROWSE → BACKTEST → VALIDATE → SIGNALS → FORWARDRUN.
// ─────────────────────────────────────────────────────────────────────────
const { useState: msS } = React;

function LifeJourney({ seg }) {
  const STEPS = [["Browse & build", "lab"], ["Backtest", "lab"], ["Validate", "lab"], ["Signals", "signals"], ["ForwardRun", "signals"]];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, flexWrap: "wrap" }}>
      {STEPS.map(([t, s], i) => (
        <React.Fragment key={t}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, letterSpacing: 0.6, border: "2px solid var(--ink)", borderRadius: 7, padding: "4px 10px", background: s === seg ? "var(--pop-2)" : "var(--paper-3)", color: "#1d1d1b", opacity: s === seg ? 1 : 0.65 }}>{t.toUpperCase()}</span>
          {i < STEPS.length - 1 && <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)", padding: "0 5px" }}>→</span>}
        </React.Fragment>
      ))}
    </div>
  );
}

function StrategiesPage({ start }) {
  const [seg, setSeg] = msS(start === "signals" ? "signals" : "lab");
  React.useEffect(() => {
    const h = (e) => setSeg(e.detail === "signals" ? "signals" : "lab");
    window.addEventListener("um-strat-seg", h);
    return () => window.removeEventListener("um-strat-seg", h);
  }, []);
  return (
    <WShell active="strategies" crumb="DISCOVER · STRATEGIES" title="Strategies" ser="— from idea to signal, one surface."
      right={<Seg grow={false} size={11.5} value={seg} onChange={setSeg} options={[{ k: "lab", label: "Lab" }, { k: "signals", label: "Signals" }]} />}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
        <LifeJourney seg={seg} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-4)", letterSpacing: 0.4 }}>ONE STRATEGY, ONE LIFECYCLE — NO SEPARATE NAV ITEM TO LOSE IT IN.</span>
      </div>
      {seg === "lab" ? <ModuleA embedded /> : <ModuleC embedded />}
    </WShell>
  );
}
window.StrategiesPage = StrategiesPage;
