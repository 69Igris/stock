// ─────────────────────────────────────────────────────────────────────────
// Module H · B2B / MCP Developer Console — keys, MCP connect, usage, catalog
// ─────────────────────────────────────────────────────────────────────────
const { useState: mhS } = React;

const PROV_COLORS = { "CONSENTED-BROKER": "var(--emerald)", "BHAVCOPY-DERIVED": "var(--pop-3)", "PURE-COMPUTE": "var(--pop-2)", "EDGAR": "var(--pop-5)" };
function ProvBadge({ p }) {
  return <span style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 800, letterSpacing: 0.6, background: PROV_COLORS[p], color: "#1d1d1b", border: "1.5px solid var(--ink)", borderRadius: 6, padding: "3px 8px" }}>{p}</span>;
}

function ModuleH() {
  const [tab, setTab] = mhS("keys");
  const [keys, setKeys] = mhS(API_KEYS);
  const [newKey, setNewKey] = mhS(null);
  const create = () => { setNewKey("um_live_" + Math.random().toString(36).slice(2, 8) + "…" + Math.random().toString(36).slice(2, 5)); setKeys(k => [{ id: "um_live_new…", name: "new-key", scopes: ["portfolio-read"], created: "just now", last: "—", live: true }, ...k]); };

  return (
    <WShell active="devconsole" crumb="DEVELOPER CONSOLE · MCP + REST" title="Build on the" ser="reconciled truth."
      right={<span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>ONLY SELLABLE-PROVENANCE TOOLS ARE LISTED</span>}>
      <WTabs value={tab} onChange={setTab} tabs={[{ k: "keys", label: "API keys" }, { k: "mcp", label: "MCP connect" }, { k: "usage", label: "Usage" }, { k: "catalog", label: "Tool catalog" }]} />

      {tab === "keys" && (
        <div style={{ marginTop: 20, maxWidth: 860 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <PrimaryBtn full={false} style={{ padding: "11px 18px", fontSize: 13.5 }} onClick={create}>Create key</PrimaryBtn>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-3)" }}>SCOPES: PORTFOLIO-READ · TAX · ANALYSIS — READ-ONLY BY CONSTRUCTION</span>
          </div>
          {newKey && (
            <div style={{ marginTop: 12, border: "2px solid var(--ink)", borderRadius: 12, background: "var(--pop-2)", padding: "12px 15px", boxShadow: "3px 3px 0 var(--ink)", display: "flex", alignItems: "center", gap: 12 }}>
              <Icon name="alert" size={15} color="#1d1d1b" />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, color: "#1d1d1b" }}>{newKey}</span>
              <span style={{ fontSize: 11.5, color: "#3a3a35", flex: 1 }}>shown once — copy it now.</span>
              <GhostBtn full={false} style={{ padding: "7px 13px", fontSize: 11.5 }} onClick={() => setNewKey(null)}>Copied ✓</GhostBtn>
            </div>
          )}
          <div style={{ marginTop: 14 }}>
            <ListCard>
              {keys.map((k, i) => (
                <div key={k.id + i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", borderBottom: i < keys.length - 1 ? "1.5px solid var(--rule-soft)" : "none", opacity: k.live ? 1 : 0.5 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 800, width: 170, textDecoration: k.live ? "none" : "line-through" }}>{k.id}</span>
                  <b style={{ fontSize: 12.5, width: 140 }}>{k.name}</b>
                  <span style={{ display: "flex", gap: 5 }}>{k.scopes.map(s => <span key={s} style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, fontWeight: 700, border: "1.5px solid var(--rule-soft)", borderRadius: 5, padding: "2px 6px", background: "var(--paper-2)", color: "var(--ink-2)" }}>{s}</span>)}</span>
                  <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>CREATED {k.created.toUpperCase()} · LAST {k.last.toUpperCase()}</span>
                  {k.live ? (
                    <span style={{ display: "flex", gap: 6 }}>
                      <button style={{ border: "2px solid var(--ink)", borderRadius: 7, background: "var(--paper-3)", padding: "5px 10px", fontWeight: 800, fontSize: 10.5, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Rotate</button>
                      <button onClick={() => setKeys(ks => ks.map((x, xi) => xi === i ? { ...x, live: false, last: "—" } : x))} style={{ border: "2px solid var(--loss)", color: "var(--loss)", borderRadius: 7, background: "var(--paper-3)", padding: "5px 10px", fontWeight: 800, fontSize: 10.5, cursor: "pointer", fontFamily: "var(--font-sans)" }}>Revoke</button>
                    </span>
                  ) : <Tag color="var(--loss)">revoked · kept for audit</Tag>}
                </div>
              ))}
            </ListCard>
          </div>
        </div>
      )}

      {tab === "mcp" && (
        <div style={{ marginTop: 20, maxWidth: 760 }}>
          <Card pad={16}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: 1, color: "var(--ink-3)" }}>HOSTED MCP ENDPOINT</div>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <span style={{ flex: 1, border: "2px solid var(--ink)", borderRadius: 9, background: "var(--paper-2)", padding: "10px 13px", fontFamily: "var(--font-mono)", fontSize: 12 }}>https://mcp.usemoney.ai/v1</span>
              <GhostBtn full={false} style={{ padding: "9px 15px", fontSize: 12.5 }}>Copy</GhostBtn>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              {[["01", "Add the endpoint in Claude / ChatGPT connector settings"], ["02", "OAuth opens — your user consents to read-only scopes"], ["03", "Tools appear; every call is logged in Usage"]].map(([n, t]) => (
                <div key={n} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, border: "2px solid var(--ink)", borderRadius: 7, padding: "3px 8px", background: "var(--paper-2)", transform: "rotate(-2deg)" }}>{n}</span>
                  <span style={{ fontSize: 13, fontWeight: 650 }}>{t}</span>
                </div>
              ))}
            </div>
          </Card>
          <SecHead label="Setup snippets" />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {[["CLAUDE (claude_desktop_config.json)", `{\n  "mcpServers": {\n    "usemoney": {\n      "url": "https://mcp.usemoney.ai/v1",\n      "auth": "oauth"\n    }\n  }\n}`], ["CHATGPT (connector)", `Name: UseMoney\nMCP server URL:\n  https://mcp.usemoney.ai/v1\nAuth: OAuth (read-only)\nScopes: portfolio-read, tax`]].map(([t, code]) => (
              <div key={t} style={{ border: "2px solid var(--ink)", borderRadius: 12, background: "var(--paper-2)", overflow: "hidden" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 13px", borderBottom: "1.5px solid var(--rule-soft)" }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, fontWeight: 800, letterSpacing: 0.8, color: "var(--ink-3)" }}>{t}</span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, fontWeight: 800, color: "var(--emerald-text)", cursor: "pointer" }}>COPY</span>
                </div>
                <pre style={{ margin: 0, padding: "12px 13px", fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{code}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === "usage" && (
        <div style={{ marginTop: 20, maxWidth: 860 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {[["API calls · 30d", inr(USAGE.calls)], ["Credits consumed", inr(USAGE.credits)], ["Plan", "DEV · ₹4,999/mo"]].map(([l, v]) => (
              <div key={l} style={{ border: "2px solid var(--ink)", borderRadius: 12, padding: "13px 15px", background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)" }}>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: 0.8, color: "var(--ink-3)", textTransform: "uppercase" }}>{l}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 20, fontWeight: 800, marginTop: 4 }}>{v}</div>
              </div>
            ))}
          </div>
          <Card pad={14} style={{ marginTop: 14 }}>
            <SecHead label="Calls per day" style={{ margin: "0 0 6px" }} />
            <LineChart series={USAGE.series} h={90} color="var(--pop-3)" />
          </Card>
          <SecHead label="Per-tool breakdown" />
          <ListCard>
            {MCP_TOOLS.map((t, i) => (
              <div key={t.n} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px", borderBottom: i < MCP_TOOLS.length - 1 ? "1.5px solid var(--rule-soft)" : "none" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800, width: 190 }}>{t.n}</span>
                <ProvBadge p={t.prov} />
                <span style={{ marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 800 }}>{inr(t.calls)} <span style={{ fontSize: 9, color: "var(--ink-3)" }}>CALLS</span></span>
              </div>
            ))}
          </ListCard>
        </div>
      )}

      {tab === "catalog" && (
        <div style={{ marginTop: 20, maxWidth: 860 }}>
          <p style={{ margin: "0 0 12px", fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.6 }}>Every tool declares where its data comes from — that's the product. If a tool's provenance can't be sold cleanly, it isn't listed.</p>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginBottom: 14 }}>
            {Object.keys(PROV_COLORS).map(p => <ProvBadge key={p} p={p} />)}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {MCP_TOOLS.map(t => (
              <div key={t.n} style={{ border: "2px solid var(--ink)", borderRadius: 13, background: "var(--paper-3)", boxShadow: "3px 3px 0 var(--ink)", padding: "14px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 800 }}>{t.n}</span>
                  <span style={{ marginLeft: "auto" }}><ProvBadge p={t.prov} /></span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--ink-2)", marginTop: 6 }}>{t.d}</div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--ink-3)", marginTop: 8 }}>READ-ONLY · PER-CALL LOGGED · DOCS →</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </WShell>
  );
}
window.ModuleH = ModuleH;
