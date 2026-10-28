// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · app shell: topbar, ticker, 5-slot tab bar (Sage center),
// global search overlay, sheet + toast hosts, sub-page header. No drawer.
// ─────────────────────────────────────────────────────────────────────────
const { useState: shS, useEffect: shE, useRef: shR } = React;

const TAB_ROOTS_V2 = ["dashboard", "portfolio", "sage", "discover", "you"];
const TABS_V2 = [
  { id: "dashboard", icon: "home", label: "Home" },
  { id: "portfolio", icon: "briefcase", label: "Portfolio" },
  { id: "sage", icon: "sparkles", label: "Sage", center: true },
  { id: "discover", icon: "trending", label: "Discover" },
  { id: "you", icon: "user", label: "You" },
];

function topPad(um) { return um.device === "android" ? 42 : 56; }

// ── Ticker tape ─────────────────────────────────────────────────────────────
function TickerTape({ go, um }) {
  const items = [
    ...INDICES.slice(0, 3).map(i => ({ s: i.sym, v: inr(i.v, i.v < 100 ? 2 : 0), c: i.chg })),
    ...(um && um.usFlag ? [{ s: "S&P 500", v: "7,428.78", c: 0.21, us: true }, { s: "NASDAQ", v: "24,876.91", c: -0.22, us: true }, { s: "USDINR", v: "84.00", c: -0.08, us: true }] : []),
    ...HOLDINGS.slice(0, 6).map(h => ({ s: h.sym, v: inr(h.ltp, 1), c: h.dayChg, sym: h.sym })),
  ];
  const row = items.map((it, i) => (
    <span key={i} onClick={() => go(it.sym ? "stock:" + it.sym : it.us ? "usportfolio" : "discover")} style={{ display: "inline-flex", gap: 6, alignItems: "center", marginRight: 22, cursor: "pointer" }}>
      <span style={{ color: "var(--ink-3)", fontWeight: 700 }}>{it.s}</span>
      <span style={{ color: "var(--ink)", fontWeight: 700 }}>{it.v}</span>
      <span style={{ color: it.c >= 0 ? "var(--gain-text)" : "var(--loss)", fontWeight: 700 }}>{pct(it.c, 2)}</span>
      {it.us && <span style={{ color: "var(--ink-3)", fontWeight: 600 }}>◷</span>}
    </span>
  ));
  return (
    <div style={{ borderBottom: "2px solid var(--ink)", background: "var(--paper-2)", overflow: "hidden", whiteSpace: "nowrap", padding: "6px 0", flexShrink: 0 }}>
      <style>{`@keyframes ummarq{from{transform:translateX(0)}to{transform:translateX(-50%)}}`}</style>
      <div style={{ display: "inline-flex", animation: "ummarq 40s linear infinite", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: 0.3 }}>
        <span>{row}</span><span>{row}</span>
      </div>
    </div>
  );
}

// ── Topbar (tab roots) ──────────────────────────────────────────────────────
function TopBarV2({ go, um }) {
  const unread = NOTIFS.some(n => n.unread);
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: `${topPad(um)}px 16px 10px`, borderBottom: "2px solid var(--ink)", background: "var(--paper)", flexShrink: 0, gap: 8 }}>
      <Press onClick={() => go("dashboard")}><Wordmark size={15.5} /></Press>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <CreditChip n={um.credits} onClick={() => go("plan")} />
        <button onClick={() => um.setSearchOpen(true)} style={{ width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}>
          <Icon name="search" size={16} color="var(--ink)" />
        </button>
        <button onClick={() => go("notifications")} style={{ position: "relative", width: 34, height: 34, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)" }}>
          <Icon name="bell" size={16} color="var(--ink)" />
          {unread && <span style={{ position: "absolute", top: -4, right: -4, width: 11, height: 11, borderRadius: 99, background: "var(--pop-1)", border: "2px solid var(--paper)" }} />}
        </button>
      </div>
    </div>
  );
}

// ── Bottom tab bar (Sage center) ───────────────────────────────────────────
function TabBarV2({ active, go, um }) {
  return (
    <div style={{ position: "relative", flexShrink: 0, paddingBottom: um.device === "android" ? 14 : 26, paddingTop: 7, background: "var(--paper-3)", borderTop: "2px solid var(--ink)", display: "flex", alignItems: "flex-start", justifyContent: "space-around", zIndex: 20 }}>
      {TABS_V2.map(t => {
        const act = active === t.id;
        if (t.center) {
          return (
            <button key={t.id} onClick={() => go("sage")} style={{ marginTop: -28, width: 58, height: 58, borderRadius: 17, background: act ? "var(--emerald)" : "var(--ink)", border: "2px solid var(--ink)", boxShadow: act ? "3px 3px 0 var(--ink)" : "3px 3px 0 var(--emerald)", display: "grid", placeItems: "center", cursor: "pointer", transform: "rotate(-3deg)", transition: "background .15s" }}>
              <Icon name="sparkles" size={26} color={act ? "#0b0b09" : "var(--paper)"} />
            </button>
          );
        }
        return (
          <button key={t.id} onClick={() => go(t.id)} style={{ background: "transparent", border: 0, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "3px 10px", color: act ? "var(--ink)" : "var(--ink-3)", position: "relative" }}>
            {act && <span style={{ position: "absolute", top: -9, width: 22, height: 3, borderRadius: 99, background: "var(--emerald)" }} />}
            <Icon name={t.icon} size={21} color={act ? "var(--ink)" : "var(--ink-3)"} strokeWidth={act ? 2.4 : 2} />
            <span style={{ fontSize: 9.5, fontWeight: act ? 800 : 600, fontFamily: "var(--font-sans)" }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ── Demo banner ─────────────────────────────────────────────────────────────
function DemoBanner({ go, um }) {
  if (!um.demo) return null;
  return (
    <div onClick={() => go("signup")} style={{ background: "var(--pop-2)", borderBottom: "2px solid var(--ink)", padding: `${topPad(um) - 26}px 16px 7px`, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", flexShrink: 0 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 800, letterSpacing: 1, color: "#1d1d1b" }}>DEMO DATA</span>
      <span style={{ fontSize: 11.5, fontWeight: 700, color: "#1d1d1b" }}>— exploring as a guest · create free account →</span>
    </div>
  );
}

// ── Global search overlay ──────────────────────────────────────────────────
function SearchOverlay({ go, um }) {
  const [q, setQ] = shS("");
  shE(() => { if (!um.searchOpen) setQ(""); }, [um.searchOpen]);
  if (!um.searchOpen) return null;
  const close = () => um.setSearchOpen(false);
  const nav = (key) => { close(); go(key); };
  const ql = q.trim().toLowerCase();
  const stocks = Object.values(STOCKS).filter(s => !ql || s.sym.toLowerCase().includes(ql) || s.name.toLowerCase().includes(ql)).slice(0, ql ? 6 : 4);
  const usStocks = um.usFlag && window.US_HOLD ? window.US_HOLD.filter(s => !ql || s.sym.toLowerCase().includes(ql) || s.name.toLowerCase().includes(ql)).slice(0, ql ? 4 : 2) : [];
  const mfs = Object.values(MFS).filter(f => !ql || f.name.toLowerCase().includes(ql)).slice(0, ql ? 4 : 2);
  const ACTIONS = [
    { k: "roast", icon: "flame", t: "Run a portfolio roast" },
    { k: "import", icon: "upload", t: "Import trades (CSV)" },
    { k: "fire", icon: "target", t: "FIRE calculator" },
    { k: "tax", icon: "receipt", t: "Tax report" },
    { k: "compare", icon: "scale", t: "Compare stocks" },
    { k: "brokers", icon: "link", t: "Manage brokers" },
    ...(um.usFlag ? [{ k: "usconnect", icon: "link", t: "Link a US brokerage (SnapTrade)" }, { k: "usprefs", icon: "scale", t: "Market preferences" }] : []),
  ].filter(a => !ql || a.t.toLowerCase().includes(ql));
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 80, background: "var(--paper)", display: "flex", flexDirection: "column", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px)", backgroundSize: "9px 9px" }}>
      <div style={{ padding: `${topPad(um)}px 16px 12px`, borderBottom: "2px solid var(--ink)", display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 9, border: "2px solid var(--ink)", borderRadius: 11, background: "var(--paper-3)", padding: "0 12px", boxShadow: "3px 3px 0 var(--ink)" }}>
          <Icon name="search" size={16} color="var(--ink-3)" />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Stocks, funds, actions…"
            style={{ flex: 1, border: 0, outline: 0, background: "transparent", padding: "12px 0", fontSize: 15, color: "var(--ink)", fontFamily: "var(--font-sans)", minWidth: 0 }} />
          {q && <button onClick={() => setQ("")} style={{ border: 0, background: "transparent", cursor: "pointer", display: "flex" }}><Icon name="x" size={15} color="var(--ink-3)" /></button>}
        </div>
        <button onClick={close} style={{ border: 0, background: "transparent", cursor: "pointer", fontWeight: 800, fontSize: 13.5, color: "var(--ink)", fontFamily: "var(--font-sans)" }}>Cancel</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 16px 30px" }}>
        {stocks.length > 0 && <SecHead label="Stocks" />}
        {stocks.length > 0 && (
          <ListCard>
            {stocks.map((s, i) => (
              <RowItem key={s.sym} last={i === stocks.length - 1} onClick={() => nav("stock:" + s.sym)}
                left={<SymTile sym={s.sym} size={34} />}
                title={s.sym} sub={s.name}
                right={"₹" + inr(s.ltp, 1)} rightSub={<Num v={s.chg} fmt="pct" size={10.5} />} />
            ))}
          </ListCard>
        )}
        {usStocks.length > 0 && <SecHead label="US stocks" right={<Tag bg="var(--paper-2)">◷ EOD</Tag>} />}
        {usStocks.length > 0 && (
          <ListCard>
            {usStocks.map((s, i) => (
              <RowItem key={s.sym} last={i === usStocks.length - 1} onClick={() => nav("usstock:" + s.sym)}
                left={<SymTile sym={s.sym} size={34} />}
                title={<span>{s.sym} <Tag bg="var(--pop-3)" color="#1d1d1b" style={{ borderColor: "var(--ink)", fontSize: 8, marginLeft: 4 }}>US</Tag></span>} sub={s.name}
                right={"$" + s.ltp.toFixed(2)} rightSub={<Num v={s.chg} fmt="pct" dec={2} size={10.5} />} />
            ))}
          </ListCard>
        )}
        {mfs.length > 0 && <SecHead label="Mutual funds" />}
        {mfs.length > 0 && (
          <ListCard>
            {mfs.map((f, i) => (
              <RowItem key={f.id} last={i === mfs.length - 1} onClick={() => nav("mf:" + f.id)}
                left={<span style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--pop-5)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name="pie" size={16} color="#1d1d1b" /></span>}
                title={f.name} sub={f.cat}
                right={pct(f.ret1, 1)} rightSub={<span style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, color: "var(--ink-3)" }}>1Y</span>} />
            ))}
          </ListCard>
        )}
        {ACTIONS.length > 0 && <SecHead label="Actions" />}
        {ACTIONS.length > 0 && (
          <ListCard>
            {ACTIONS.map((a, i) => (
              <RowItem key={a.k} last={i === ACTIONS.length - 1} onClick={() => nav(a.k)}
                left={<span style={{ width: 34, height: 34, borderRadius: 9, border: "2px solid var(--ink)", background: "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0 }}><Icon name={a.icon} size={16} color="var(--ink-2)" /></span>}
                title={a.t} />
            ))}
          </ListCard>
        )}
        {stocks.length === 0 && usStocks.length === 0 && mfs.length === 0 && ACTIONS.length === 0 && (
          <EmptyState icon="search" title={`Nothing for “${q}”`} sub="Try a ticker like INFY, a fund name, or an action like roast." />
        )}
      </div>
    </div>
  );
}

// ── Page head for tab roots ─────────────────────────────────────────────────
function PageHead({ eyebrow, color = "var(--emerald-text)", title, ser, sub, right, style }) {
  return (
    <div style={{ padding: "16px 0 4px", ...style }}>
      {eyebrow && (
        <div style={{ display: "inline-flex", alignItems: "center", gap: 7, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color, letterSpacing: 1.3, textTransform: "uppercase" }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: color }} />{eyebrow}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 10 }}>
        <h1 style={{ margin: "8px 0 0", fontWeight: 800, fontSize: 27, lineHeight: 1.04, letterSpacing: -1.2, color: "var(--ink)" }}>
          {title}{ser && <> <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>{ser}</span></>}
        </h1>
        {right}
      </div>
      {sub && <div style={{ marginTop: 7, fontFamily: "var(--font-serif)", fontStyle: "italic", fontSize: 14.5, color: "var(--ink-3)" }}>{sub}</div>}
    </div>
  );
}

// ── Pushed sub-page (own header, no tab bar) ────────────────────────────────
function SubPage({ title, mono, onBack, right, children, footer, pad = 18, um, noPad, scrollRef }) {
  return (
    <div className="um" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper)", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px), radial-gradient(var(--dot-fg-2) 1px, transparent 1.5px)", backgroundSize: "7px 7px, 11px 11px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 11, padding: `${topPad(um)}px ${pad}px 10px`, borderBottom: "2px solid var(--ink)", background: "var(--paper)", flexShrink: 0 }}>
        <button onClick={onBack} style={{ width: 36, height: 36, borderRadius: 10, border: "2px solid var(--ink)", background: "var(--paper-3)", display: "grid", placeItems: "center", cursor: "pointer", boxShadow: "2px 2px 0 var(--ink)", flexShrink: 0 }}>
          <Icon name="arrowL" size={17} color="var(--ink)" />
        </button>
        <div style={{ flex: 1, minWidth: 0, fontWeight: 800, fontSize: 16.5, letterSpacing: -0.4, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: mono ? "var(--font-mono)" : undefined }}>{title}</div>
        {right}
      </div>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: noPad ? 0 : `4px ${pad}px 26px` }}>{children}</div>
      {footer && <div style={{ flexShrink: 0, padding: `12px ${pad}px calc(env(safe-area-inset-bottom) + 22px)`, borderTop: "1.5px dashed var(--rule-soft)", background: "var(--paper)" }}>{footer}</div>}
    </div>
  );
}

// ── Shell ───────────────────────────────────────────────────────────────────
function AppShellV2({ active, go, um, children }) {
  const isRoot = TAB_ROOTS_V2.includes(active);
  const showTicker = active === "dashboard" || active === "discover";
  return (
    <div className="um" style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--paper)", position: "relative", overflow: "hidden", backgroundImage: "radial-gradient(var(--dot-fg) 1px, transparent 1.5px), radial-gradient(var(--dot-fg-2) 1px, transparent 1.5px)", backgroundSize: "7px 7px, 11px 11px" }}>
      {isRoot ? (
        <>
          <DemoBanner go={go} um={um} />
          <TopBarV2 go={go} um={um} />
          {showTicker && <TickerTape go={go} um={um} />}
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column", position: "relative" }}>{children}</div>
          <TabBarV2 active={active} go={go} um={um} />
        </>
      ) : (
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>{children}</div>
      )}
      <SearchOverlay go={go} um={um} />
      <SheetHost sheet={um.sheet} onClose={() => um.setSheet(null)} />
      <ToastHost toast={um.toastData} />
    </div>
  );
}

Object.assign(window, { AppShellV2, TabBarV2, TopBarV2, TickerTape, SearchOverlay, PageHead, SubPage, DemoBanner, TAB_ROOTS_V2 });
