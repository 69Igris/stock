// ─────────────────────────────────────────────────────────────────────────
// UseMoney mobile v2 · root: router, um store, device stage (iOS/Android),
// theme, flow-grouped screen index. Exposes window.UMRoot for the DC mount.
// ─────────────────────────────────────────────────────────────────────────
const { useState: rtS, useEffect: rtE, useRef: rtR } = React;

// public explore hub (marketing/legal, reused old screens)
function MoreScreenV2({ go, back }) {
  const groups = [
    { g: "Product", items: [["features", "Features", "layers"], ["broker", "Broker sync", "link"], ["sagemkt", "StockSage AI", "sparkles"], ["pricing", "Pricing", "wallet"], ["comparemkt", "Why UseMoney", "target"]] },
    { g: "Company", items: [["about", "About", "users"], ["security", "Security", "shield"], ["roadmap", "Roadmap", "trending"], ["changelog", "Changelog", "clock"]] },
    { g: "Resources", items: [["blog", "Blog", "file"], ["docs", "Docs", "search"], ["glossary", "Glossary", "star"], ["newsletter", "Newsletter", "mail"]] },
    { g: "Legal", items: [["legal", "Legal & privacy", "scale"], ["unsubscribe", "Email preferences", "bell"]] },
  ];
  return (
    <Screen onBack={back} topPad={60} footer={<PrimaryBtn onClick={() => go("signup")}>Create free account</PrimaryBtn>}>
      <Eyebrow>EXPLORE · USEMONEY</Eyebrow>
      <h1 style={{ fontWeight: 800, fontSize: 30, lineHeight: 1.04, letterSpacing: -1.3, marginTop: 12, color: "var(--ink)" }}>Everything, <span className="ser">one tap away.</span></h1>
      {groups.map(grp => (
        <div key={grp.g} style={{ marginTop: 20 }}>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, color: "var(--ink-3)", letterSpacing: 1.2 }}>{grp.g.toUpperCase()}</div>
          <div style={{ marginTop: 10, border: "2px solid var(--ink)", borderRadius: 13, overflow: "hidden", boxShadow: "3px 3px 0 var(--ink)", background: "var(--paper-3)" }}>
            {grp.items.map(([k, t, ic], i) => (
              <button key={k} onClick={() => go(k)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "13px 14px", textAlign: "left", background: "transparent", border: 0, borderTop: i ? "1.5px solid var(--rule-soft)" : 0, cursor: "pointer" }}>
                <Icon name={ic} size={18} color="var(--ink-2)" />
                <span style={{ flex: 1, fontSize: 14.5, fontWeight: 600, color: "var(--ink)" }}>{t}</span>
                <Icon name="chevronR" size={15} color="var(--ink-3)" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </Screen>
  );
}

// ── Registry ────────────────────────────────────────────────────────────────
// kind: "public" (own chrome) | "root" (tab root in shell) | "push" (app sub-page)
const REG = {
  splash: { c: SplashScreen, kind: "public", light: true },
  onboarding: { c: OnboardingScreen, kind: "public" },
  welcome: { c: WelcomeScreen, kind: "public" },
  signin: { c: SignInScreen, kind: "public" }, signup: { c: SignUpScreen, kind: "public" },
  verify: { c: VerifyScreen, kind: "public" }, phone: { c: PhoneScreen, kind: "public" },
  phoneotp: { c: PhoneOTPScreen, kind: "public" }, twofa: { c: TwoFAScreen, kind: "public" },
  forgot: { c: ForgotScreen, kind: "public" }, reset: { c: ResetScreen, kind: "public" },
  invite: { c: InviteScreen, kind: "public" }, sso: { c: SSORedirectScreen, kind: "public" },
  profile: { c: InvestorProfileScreen, kind: "public" },
  connect: { c: ConnectIntroScreen, kind: "public" },
  oauth: { c: BrokerOAuthScreen, kind: "public" },
  firstsync: { c: FirstSyncScreen, kind: "public" },
  firstready: { c: FirstReadyScreen, kind: "public" },
  // marketing / resources / legal (reused)
  features: { c: FeaturesScreen, kind: "public" }, broker: { c: BrokerScreen, kind: "public" },
  sagemkt: { c: SageScreen, kind: "public" }, pricing: { c: PricingScreen, kind: "public" },
  comparemkt: { c: CompareScreen, kind: "public" }, security: { c: SecurityScreen, kind: "public" },
  about: { c: AboutScreen, kind: "public" }, roadmap: { c: RoadmapScreen, kind: "public" },
  changelog: { c: ChangelogScreen, kind: "public" }, blog: { c: BlogScreen, kind: "public" },
  docs: { c: DocsScreen, kind: "public" }, glossary: { c: GlossaryScreen, kind: "public" },
  newsletter: { c: NewsletterScreen, kind: "public" }, unsubscribe: { c: UnsubscribeScreen, kind: "public" },
  legal: { c: LegalHubScreen, kind: "public" }, notfound: { c: NotFoundScreen, kind: "public" },
  more: { c: MoreScreenV2, kind: "public" },
  // app roots
  dashboard: { c: HomeScreenV2, kind: "root" },
  portfolio: { c: PortfolioScreenV2, kind: "root" },
  sage: { c: SageScreenV2, kind: "root" },
  discover: { c: DiscoverScreenV2, kind: "root" },
  you: { c: YouScreenV2, kind: "root" },
  // app pushes
  stock: { c: StockScreenV2, kind: "push" }, mf: { c: MFScreenV2, kind: "push" },
  compare: { c: CompareScreenV2, kind: "push" }, sector: { c: SectorScreenV2, kind: "push" },
  import: { c: ImportScreenV2, kind: "push" },
  sageresearch: { c: SageResearchScreen, kind: "push" }, sagereport: { c: SageReportScreen, kind: "push" },
  chathistory: { c: ChatHistoryScreenV2, kind: "push" },
  roast: { c: RoastScreenV2, kind: "push" },
  fire: { c: FireScreenV2, kind: "push" }, calculators: { c: CalculatorsScreenV2, kind: "push" },
  risk: { c: RiskScreenV2, kind: "push" }, tax: { c: TaxScreenV2, kind: "push" },
  documents: { c: DocumentsScreenV2, kind: "push" },
  brokers: { c: BrokersScreenV2, kind: "push" }, notifications: { c: NotificationsScreenV2, kind: "push" },
  plan: { c: PlanScreenV2, kind: "push" }, settings: { c: SettingsScreenV2, kind: "push" },
  invitefriends: { c: InviteScreenV2, kind: "push" }, help: { c: HelpScreenV2, kind: "push" },
  feedback: { c: FeedbackScreenV2, kind: "push" },
  // v2.1 · US layer
  usfork: { c: UsForkScreen, kind: "public" },
  usconnect: { c: UsConnectScreen, kind: "push" }, usoauth: { c: UsOAuthScreen, kind: "push" },
  usimport: { c: UsImportScreen, kind: "push" }, usstock: { c: UsStockScreen, kind: "push" },
  usportfolio: { c: UsPortfolioScreen, kind: "push" }, lrs: { c: LrsScreen, kind: "push" }, usprefs: { c: UsPrefsScreen, kind: "push" },
  // v2.1 · web-v2 parity
  screener2: { c: ScreenerV2Screen, kind: "push" }, strategies: { c: StrategiesScreen, kind: "push" }, strategy: { c: StrategyDetailScreen, kind: "push" },
  homepresets: { c: HomePresetsScreen, kind: "push" }, devsettings: { c: DevSettingsScreen, kind: "push" },
};
const ALIAS = { home: "dashboard", holdings: "portfolio", sagechat: "sage", markets: "discover:markets", watchlist: "discover:watchlist", tradebook: "portfolio:trades", screener: "discover:screener", news: "discover:news" };

const FLOW_INDEX = [
  { g: "Start here", items: [["splash", "Splash"], ["onboarding", "Onboarding"], ["welcome", "Welcome"]] },
  { g: "Auth (Clerk)", items: [["signup", "Sign up"], ["signin", "Sign in"], ["verify", "Verify email"], ["phone", "Add phone"], ["phoneotp", "SMS code"], ["twofa", "2FA"], ["forgot", "Forgot"], ["reset", "Set password"], ["profile", "Investor profile"], ["invite", "Invite claim"], ["sso", "SSO redirect"]] },
  { g: "First run — connect & sync", items: [["connect", "Pick broker"], ["usfork", "Where you invest · US flag"], ["oauth:zerodha", "OAuth (read-only)"], ["firstsync:zerodha", "First sync"], ["firstready", "Portfolio ready"]] },
  { g: "App — tabs", items: [["dashboard", "Home"], ["portfolio", "Portfolio"], ["sage", "Sage"], ["discover", "Discover"], ["you", "You"]] },
  { g: "Portfolio flow", items: [["portfolio:holdings", "Holdings"], ["portfolio:positions", "Positions"], ["portfolio:trades", "Trades (FIFO)"], ["import", "CSV import"], ["stock:RELIANCE", "Stock page"], ["mf:PPFCF", "MF page"], ["compare:HDFCBANK", "Compare"]] },
  { g: "Sage flow", items: [["sage", "Chat"], ["sageresearch", "Research run"], ["sagereport", "Cited report"], ["chathistory", "History"]] },
  { g: "Discover flow", items: [["discover:markets", "Markets"], ["discover:screener", "Screener"], ["discover:sectors", "Sectors"], ["sector:it", "Sector page"], ["discover:news", "News & events"], ["discover:watchlist", "Watchlists"]] },
  { g: "Roast flow", items: [["roast", "Scope → run → verdict"]] },
  { g: "Tools", items: [["fire", "FIRE"], ["calculators", "Calculators"], ["risk", "Risk (PRO gate)"], ["tax", "Tax report"], ["documents", "Documents"]] },
  { g: "Account & money ops", items: [["brokers", "Brokers & sync"], ["oauth:upstox:manage", "Reconnect OAuth"], ["notifications", "Notifications"], ["plan", "Plans & paywall"], ["settings", "Settings & memory"], ["invitefriends", "Invite friends"], ["help", "Help"], ["feedback", "Feedback"]] },
  { g: "US layer — v2.1 (flag us-stocks-listing)", items: [["usfork", "Onboarding · where you invest"], ["usconnect", "Link (SnapTrade) or import"], ["usoauth:rh", "SnapTrade consent → sync"], ["usoauth:fd:fail", "Re-auth needed"], ["usimport", "Statement import"], ["usstock:AAPL", "US stock page"], ["usportfolio", "Holdings · both markets"], ["lrs", "LRS / TCS tracker"], ["usprefs", "Market preferences"]] },
  { g: "Web-v2 parity — v2.1", items: [["screener2", "Screener · scans sheet"], ["strategies", "Strategies · lifecycle"], ["strategy:mom12", "Strategy · FORWARD"], ["strategy:defflexi", "Strategy · DRAFT"], ["homepresets", "Home layout presets"], ["devsettings", "Settings → Developer"]] },
  { g: "Marketing (public)", items: [["features", "Features"], ["broker", "Broker sync"], ["sagemkt", "StockSage"], ["pricing", "Pricing"], ["comparemkt", "Why UseMoney"], ["security", "Security"], ["about", "About"], ["roadmap", "Roadmap"], ["changelog", "Changelog"], ["more", "Explore hub"]] },
  { g: "Resources & legal", items: [["blog", "Blog"], ["docs", "Docs"], ["glossary", "Glossary"], ["newsletter", "Newsletter"], ["unsubscribe", "Unsubscribe"], ["legal", "Legal hub"], ["legal:privacy", "Privacy"], ["legal:terms", "Terms"], ["notfound", "404"]] },
];

// v2.1 · every screen that exists only when us-stocks-listing is on
const US_SCREENS = new Set(["usfork", "usconnect", "usoauth", "usimport", "usstock", "usportfolio", "lrs", "usprefs"]);
function FlagOffScreen({ go, back, um, onFlag }) {
  return (
    <SubPage um={um} title="Not here yet" onBack={back} footer={<PrimaryBtn onClick={onFlag}>Turn the flag on</PrimaryBtn>}>
      <Card pad={16} bg="var(--ink)" shadow="4px 4px 0 var(--pop-2)" style={{ marginTop: 16, color: "var(--paper)" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 9.5, letterSpacing: 1.4, color: "var(--pop-2)", fontWeight: 800 }}>FLAG us-stocks-listing · OFF</div>
        <div style={{ fontWeight: 800, fontSize: 22, letterSpacing: -0.7, marginTop: 8, lineHeight: 1.1 }}>Nothing. <span style={{ fontFamily: "var(--font-serif)", fontStyle: "italic", fontWeight: 400 }}>The US layer isn't there.</span></div>
        <div style={{ fontSize: 13, opacity: 0.85, marginTop: 8, lineHeight: 1.5 }}>No pre-GA, no waitlist. With the flag off this route doesn't exist: no US tile on Home, no US group in You, no US pill in the screener. The India app is today's app. At launch the gate becomes a pricing tier.</div>
      </Card>
      <div style={{ marginTop: 14 }}><GhostBtn icon="arrowL" onClick={() => go("dashboard")}>Back to Home</GhostBtn></div>
    </SubPage>
  );
}

function labelFor2(cur) {
  for (const g of FLOW_INDEX) for (const [k, t] of g.items) if (k === cur) return t;
  const base = cur.split(":")[0];
  for (const g of FLOW_INDEX) for (const [k, t] of g.items) if (k.split(":")[0] === base) return t;
  return cur;
}

function UMRoot(props = {}) {
  const [hist, setHist] = rtS([props.start && REG[String(props.start).split(":")[0]] ? String(props.start) : "splash"]);
  const [dark, setDarkRaw] = rtS(!!props.dark);
  const [usFlag, setUsFlag] = rtS(props.us !== "0");
  window.__umUS = window.__umUS || { persona: "nri" }; window.__umUS.usFlag = usFlag;
  const [device, setDevice] = rtS(props.device === "ios" || props.device === "android" ? props.device : (window.__UM_DEVICE_NAME === "ios" ? "ios" : "android"));
  const [showIndex, setShowIndex] = rtS(false);
  const [scale, setScale] = rtS(1);
  // um store
  const [credits, setCredits] = rtS(USER.credits);
  const [plan, setPlan] = rtS(USER.plan);
  const [demo, setDemo] = rtS(false);
  const [brokers, setBrokers] = rtS(BROKERS_SEED);
  const [watchlists, setWatchlists] = rtS(WATCHLISTS_SEED);
  const [sheet, setSheet] = rtS(null);
  const [toastData, setToastData] = rtS(null);
  const [searchOpen, setSearchOpen] = rtS(false);
  const [sagePrefill, setSagePrefill] = rtS(null);
  const toastTimer = rtR(null);

  const setDark = (v) => setDarkRaw(typeof v === "function" ? v : () => v);
  rtE(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  rtE(() => {
    const fit = () => {
      const W = device === "android" ? 412 : 402, H = device === "android" ? 892 : 874;
      setScale(Math.max(0.4, Math.min((window.innerWidth - 36) / W, (window.innerHeight - 132) / H, 1)));
    };
    fit(); window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit);
  }, [device]);

  const toast = (msg, kind = "ok") => {
    clearTimeout(toastTimer.current);
    setToastData({ id: Date.now(), msg, kind });
    toastTimer.current = setTimeout(() => setToastData(null), 2400);
  };
  const watch = new Set(watchlists.flatMap(w => w.syms));
  const um = {
    device, credits, plan, demo, setDemo, brokers, watchlists, setWatchlists, watch, usFlag, setUsFlag,
    sheet, setSheet, toastData, toast, searchOpen, setSearchOpen, sagePrefill, setSagePrefill,
    spend: (n) => setCredits(c => Math.max(0, c - n)),
    upgrade: (p, cr) => { setPlan(p); setCredits(cr); },
    connectBroker: (id) => setBrokers(bs => {
      const ex = bs.find(b => b.id === id);
      if (ex) return bs.map(b => b.id === id ? { ...b, state: "connected", lastSync: "just now" } : b);
      return [...bs, { id, state: "connected", lastSync: "just now", holdings: 0, trades: 0 }];
    }),
    disconnectBroker: (id) => setBrokers(bs => bs.filter(b => b.id !== id)),
    toggleWatch: (sym) => setWatchlists(ws => {
      const has = ws.some(w => w.syms.includes(sym));
      if (has) return ws.map(w => ({ ...w, syms: w.syms.filter(s => s !== sym) }));
      return ws.map((w, i) => i === 0 ? { ...w, syms: [...w.syms, sym] } : w);
    }),
    refresh: (done) => { setTimeout(() => { done(); toast("Synced · 3 brokers · just now"); }, 1400); },
  };

  const cur = hist[hist.length - 1];
  const [base, ...rest] = cur.split(":");
  const param = rest.join(":") || null;
  const resolved = ALIAS[base] || null;
  const meta = REG[base] || REG.notfound;

  const go = (key, opts = {}) => {
    const b = key.split(":")[0];
    const target = ALIAS[b] ? ALIAS[b] + (key.includes(":") ? ":" + key.split(":").slice(1).join(":") : "") : key;
    setSheet(null); setSearchOpen(false); setShowIndex(false);
    setHist(h => opts.reset ? [target] : opts.replace ? [...h.slice(0, -1), target] : [...h, target]);
  };
  const back = () => { setSheet(null); setHist(h => (h.length > 1 ? h.slice(0, -1) : h)); };
  const jump = (key) => { setSheet(null); setSearchOpen(false); setShowIndex(false); setHist([key]); };

  rtE(() => { if (resolved) jump(resolved + (param ? ":" + param : "")); }, [cur]);

  const statusLight = meta.light === true ? true : dark;
  const Comp = meta.c;
  const Device = device === "android" && window.AndroidPhone ? window.AndroidPhone : window.IOSDevice;
  const isApp = meta.kind === "root" || meta.kind === "push";
  let screenEl = <Comp go={go} back={back} param={param} um={um} dark={dark} setDark={setDark} />;
  if (!usFlag && US_SCREENS.has(base)) screenEl = <FlagOffScreen go={go} back={back} um={um} onFlag={() => setUsFlag(true)} />;
  if (base === "legal" && param) screenEl = <LegalDoc docKey={param} back={back} go={go} />;
  if (isApp) screenEl = <AppShellV2 active={base} go={go} um={um}>{screenEl}</AppShellV2>;
  else screenEl = <div style={{ height: "100%", position: "relative" }}>{screenEl}<SheetHost sheet={um.sheet} onClose={() => um.setSheet(null)} /><ToastHost toast={um.toastData} /></div>;

  const ctrl = (disabled) => ({
    padding: "8px 13px", borderRadius: 99, border: "2px solid #1d1d1b", background: "#fbf8eb", color: "#1d1d1b",
    fontSize: 11, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
    boxShadow: "2px 2px 0 #1d1d1b", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.3, whiteSpace: "nowrap",
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "#e7e2d3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", backgroundImage: "radial-gradient(rgba(0,0,0,0.045) 1px, transparent 1.5px)", backgroundSize: "22px 22px" }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}>
        <Device dark={statusLight} key={device + (statusLight ? "d" : "l")}>
          <div key={meta.kind === "root" ? "approot" : cur} style={{ height: "100%", animation: meta.kind === "root" ? "none" : meta.kind === "push" ? "umpush .24s cubic-bezier(.22,.61,.36,1)" : "umscreen2 .26s cubic-bezier(.22,.61,.36,1)" }}>
            <style>{`@keyframes umscreen2{from{transform:translateY(8px);opacity:.6}to{transform:none;opacity:1}}@keyframes umpush{from{transform:translateX(26px);opacity:.5}to{transform:none;opacity:1}}`}</style>
            {screenEl}
          </div>
        </Device>
      </div>

      {/* stage controls */}
      <div style={{ position: "fixed", bottom: 14, left: 0, right: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontFamily: "'JetBrains Mono', monospace", flexWrap: "wrap", padding: "0 10px" }}>
        <button onClick={back} disabled={hist.length < 2} style={ctrl(hist.length < 2)}>‹ Back</button>
        <button onClick={() => setShowIndex(true)} style={ctrl(false)}>☰ Flows</button>
        <div style={{ padding: "8px 12px", borderRadius: 99, background: "#1d1d1b", color: "#f7f3e6", fontSize: 11, letterSpacing: 0.5, fontWeight: 600, maxWidth: 168, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelFor2(cur)}</div>
        <div style={{ display: "inline-flex", border: "2px solid #1d1d1b", borderRadius: 99, overflow: "hidden", boxShadow: "2px 2px 0 #1d1d1b" }}>
          {["android", "ios"].map(d => (
            <button key={d} onClick={() => setDevice(d)} style={{ padding: "8px 12px", border: 0, background: device === d ? "#1d1d1b" : "#fbf8eb", color: device === d ? "#f7f3e6" : "#1d1d1b", fontSize: 10.5, fontWeight: 800, cursor: "pointer", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.5 }}>{d === "android" ? "Android" : "iOS"}</button>
          ))}
        </div>
        <button onClick={() => setDark(d => !d)} style={ctrl(false)}>{dark ? "☀ Light" : "☾ Dark"}</button>
        <button onClick={() => setUsFlag(f => !f)} title="PostHog flag us-stocks-listing" style={{ ...ctrl(false), background: usFlag ? "#16a34a" : "#fbf8eb", color: usFlag ? "#0b0b09" : "#1d1d1b" }}>US flag: {usFlag ? "ON" : "OFF"}</button>
      </div>

      {/* flow index overlay */}
      {showIndex && (
        <div onClick={() => setShowIndex(false)} style={{ position: "fixed", inset: 0, background: "rgba(20,18,12,0.55)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center", backdropFilter: "blur(3px)" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(620px, 95vw)", maxHeight: "84vh", overflowY: "auto", background: "#f7f3e6", borderRadius: "20px 20px 0 0", border: "2px solid #1d1d1b", borderBottom: 0, padding: "18px 18px 30px", fontFamily: "'Inter', sans-serif", boxShadow: "0 -20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
              <div style={{ fontWeight: 800, fontSize: 18, color: "#1d1d1b", letterSpacing: -0.5 }}>User flows <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#6b6b62", fontWeight: 600 }}>· {Object.keys(REG).length} screens · v2.1</span></div>
              <button onClick={() => setShowIndex(false)} style={{ width: 32, height: 32, borderRadius: 9, border: "2px solid #1d1d1b", background: "#f7f3e6", cursor: "pointer", fontSize: 15, fontWeight: 700 }}>✕</button>
            </div>
            {FLOW_INDEX.map(grp => {
              const usGrp = grp.g.startsWith("US layer");
              return (
              <div key={grp.g} style={{ marginTop: 15, opacity: usGrp && !usFlag ? 0.45 : 1 }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 700, color: "#6b6b62", letterSpacing: 1.2, marginBottom: 8 }}>{grp.g.toUpperCase()}{usGrp && <span style={{ marginLeft: 8, padding: "1px 7px", borderRadius: 5, border: "1.5px solid #1d1d1b", background: usFlag ? "#16a34a" : "#fbf8eb", color: "#1d1d1b" }}>FLAG {usFlag ? "ON" : "OFF"}</span>}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {grp.items.map(([k, t]) => {
                    const active = cur === k;
                    return (
                      <button key={k} onClick={() => jump(k)} style={{ padding: "8px 13px", borderRadius: 10, border: "2px solid #1d1d1b", cursor: "pointer", background: active ? "#1d1d1b" : "#fbf8eb", color: active ? "#f7f3e6" : "#1d1d1b", fontSize: 12.5, fontWeight: 600, boxShadow: active ? "none" : "2px 2px 0 #1d1d1b", fontFamily: "'Inter', sans-serif" }}>{t}</button>
                    );
                  })}
                </div>
              </div>
            ); })}
            <div style={{ marginTop: 18, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "#6b6b62", lineHeight: 1.7 }}>EXCLUDED PER DIRECTION: PAPER TRADING · LEARNING/QUIZ/TUTOR. SEAMS RESERVED FOR 2026H2 MODULES (STRATEGY LAB, ANALYST BOARD, SIGNALS, US/NRI, PERSONAS, MEMORY, MODEL PICKER).</div>
          </div>
        </div>
      )}
    </div>
  );
}

window.UMRoot = UMRoot;
