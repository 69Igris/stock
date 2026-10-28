// ─────────────────────────────────────────────────────────────────────────
// UseMoney iOS — app shell: device stage, router, theme, screen index
// ─────────────────────────────────────────────────────────────────────────
const { useState: uS, useEffect: uE } = React;

// light: true = white status icons; "theme" = follows theme; false = dark icons
// app: true = render inside the authenticated AppShell (topbar + ticker + tabs + drawer)
const SCREENS = {
  splash: { c: SplashScreen, light: true },
  onboarding: { c: OnboardingScreen, light: "theme" },
  welcome: { c: WelcomeScreen, light: "theme" },
  // auth
  signin: { c: SignInScreen, light: "theme" },
  signup: { c: SignUpScreen, light: "theme" },
  verify: { c: VerifyScreen, light: "theme" },
  phone: { c: PhoneScreen, light: "theme" },
  phoneotp: { c: PhoneOTPScreen, light: "theme" },
  twofa: { c: TwoFAScreen, light: "theme" },
  forgot: { c: ForgotScreen, light: "theme" },
  reset: { c: ResetScreen, light: "theme" },
  invite: { c: InviteScreen, light: "theme" },
  sso: { c: SSORedirectScreen, light: "theme" },
  profile: { c: InvestorProfileScreen, light: "theme" },
  // marketing / public
  features: { c: FeaturesScreen, light: "theme" },
  broker: { c: BrokerScreen, light: "theme" },
  sage: { c: SageScreen, light: "theme" },
  pricing: { c: PricingScreen, light: "theme" },
  compare: { c: CompareScreen, light: "theme" },
  security: { c: SecurityScreen, light: "theme" },
  about: { c: AboutScreen, light: "theme" },
  roadmap: { c: RoadmapScreen, light: "theme" },
  changelog: { c: ChangelogScreen, light: "theme" },
  blog: { c: BlogScreen, light: "theme" },
  docs: { c: DocsScreen, light: "theme" },
  glossary: { c: GlossaryScreen, light: "theme" },
  newsletter: { c: NewsletterScreen, light: "theme" },
  unsubscribe: { c: UnsubscribeScreen, light: "theme" },
  legal: { c: LegalHubScreen, light: "theme" },
  notfound: { c: NotFoundScreen, light: "theme" },
  more: { c: MoreScreen, light: "theme" },
  // ── authenticated app (inside AppShell) ──
  dashboard: { c: DashboardScreen, light: "theme", app: true },
  sagechat: { c: SageChatScreen, light: "theme", app: true },
  holdings: { c: HoldingsScreen, light: "theme", app: true },
  watchlist: { c: WatchlistScreen, light: "theme", app: true },
  tradebook: { c: TradebookScreen, light: "theme", app: true },
  roast: { c: RoastScreen, light: "theme", app: true },
  markets: { c: MarketsScreen, light: "theme", app: true },
  screener: { c: ScreenerScreen, light: "theme", app: true },
  strategies: { c: StrategiesScreen, light: "theme", app: true },
  strategybuild: { c: StrategyBuildScreen, light: "theme", app: true },
  research: { c: ResearchScreen, light: "theme", app: true },
  news: { c: NewsScreen, light: "theme", app: true },
  paper: { c: PaperScreen, light: "theme", app: true },
  fire: { c: FireScreen, light: "theme", app: true },
  calculators: { c: CalculatorsScreen, light: "theme", app: true },
  risk: { c: RiskScreen, light: "theme", app: true },
  tax: { c: TaxScreen, light: "theme", app: true },
  documents: { c: DocumentsScreen, light: "theme", app: true },
  brokers: { c: BrokersScreen, light: "theme", app: true },
  learning: { c: LearningScreen, light: "theme", app: true },
  tutor: { c: TutorScreen, light: "theme", app: true },
  quiz: { c: QuizScreen, light: "theme", app: true },
  settings: { c: SettingsScreen, light: "theme", app: true },
  notifications: { c: NotificationsScreen, light: "theme", app: true },
  chathistory: { c: ChatHistoryScreen, light: "theme", app: true },
  help: { c: HelpScreen, light: "theme", app: true },
  invitefriends: { c: InviteFriendsScreen, light: "theme", app: true },
  feedback: { c: FeedbackScreen, light: "theme", app: true },
};

const INDEX_GROUPS = [
  { g: "Onboarding", items: [["splash", "Splash"], ["onboarding", "Onboarding"], ["welcome", "Welcome"]] },
  { g: "Auth (Clerk)", items: [["signin", "Sign in"], ["signup", "Sign up"], ["verify", "Verify email"], ["phone", "Add phone"], ["phoneotp", "SMS code"], ["twofa", "2FA code"], ["forgot", "Forgot password"], ["reset", "Set password"], ["profile", "Investor profile"], ["invite", "Invite / claim"], ["sso", "SSO redirect"]] },
  { g: "Marketing", items: [["features", "Features"], ["broker", "Broker sync"], ["sage", "StockSage"], ["pricing", "Pricing"], ["compare", "Compare"], ["security", "Security"], ["about", "About"], ["roadmap", "Roadmap"], ["changelog", "Changelog"], ["more", "More hub"]] },
  { g: "Resources", items: [["blog", "Blog"], ["docs", "Docs"], ["glossary", "Glossary"], ["newsletter", "Newsletter"], ["unsubscribe", "Unsubscribe"]] },
  { g: "Legal", items: [["legal", "Legal hub"], ["legal:privacy", "Privacy"], ["legal:terms", "Terms"], ["legal:risk", "Risk disclosure"], ["legal:data", "Data usage"], ["legal:subprocessors", "Subprocessors"], ["notfound", "404"]] },
  { g: "App · Workspace", items: [["dashboard", "Dashboard"], ["sagechat", "StockSage"], ["holdings", "Holdings"], ["watchlist", "Watchlists"], ["tradebook", "Tradebook"], ["roast", "Portfolio Roast"]] },
  { g: "App · Discover", items: [["markets", "Markets"], ["screener", "Screener"], ["strategies", "Strategies"], ["strategybuild", "Strategy builder"], ["research", "Research list"], ["news", "News & events"]] },
  { g: "App · Tools", items: [["paper", "Paper trading"], ["fire", "FIRE calculator"], ["calculators", "Calculators"], ["risk", "Risk report"], ["tax", "Tax report"], ["documents", "Document vault"]] },
  { g: "App · Account", items: [["brokers", "Brokers"], ["learning", "Learning"], ["tutor", "Sage Tutor"], ["quiz", "Quiz"], ["settings", "Settings"], ["notifications", "Notifications"]] },
  { g: "App · More", items: [["chathistory", "Chat history"], ["help", "Help & docs"], ["invitefriends", "Invite friends"], ["feedback", "Feedback"]] },
];

// ── In-app "explore" hub (public index) ─────────────────────────────────────
function MoreScreen({ go, back }) {
  const groups = [
    { g: "Product", items: [["features", "Features", "layers"], ["broker", "Broker sync", "link"], ["sage", "StockSage AI", "sparkles"], ["pricing", "Pricing", "wallet"], ["compare", "Why UseMoney", "target"]] },
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

// ── Root app ────────────────────────────────────────────────────────────────
function App() {
  const [hist, setHist] = uS(["splash"]);
  const [dark, setDark] = uS(false);
  const [showIndex, setShowIndex] = uS(false);
  const [scale, setScale] = uS(1);
  const cur = hist[hist.length - 1];
  const base = cur.split(":")[0];
  const meta = SCREENS[base] || SCREENS.welcome;

  const go = (key) => { setHist(h => [...h, key]); setShowIndex(false); };
  const back = () => setHist(h => (h.length > 1 ? h.slice(0, -1) : h));
  const jump = (key) => { setHist([key]); setShowIndex(false); };

  uE(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  uE(() => {
    const fit = () => {
      const s = Math.min((window.innerWidth - 36) / (window.__UM_DEVICE_NAME === "android" ? 412 : 402), (window.innerHeight - 150) / (window.__UM_DEVICE_NAME === "android" ? 892 : 874), 1);
      setScale(Math.max(0.4, s));
    };
    fit(); window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit);
  }, []);

  const statusLight = meta.light === true ? true : meta.light === "theme" ? dark : false;
  const Comp = meta.c;
  const ANDROID = window.__UM_DEVICE_NAME === "android";
  const Device = (ANDROID && window.AndroidPhone) ? window.AndroidPhone : IOSDevice;
  const DW = ANDROID ? 412 : 402, DH = ANDROID ? 892 : 874;
  let screenEl;
  if (base === "legal" && cur.includes(":")) {
    screenEl = <LegalDoc docKey={cur.split(":")[1]} back={back} go={go} />;
  } else if (meta.app) {
    screenEl = (
      <AppShell active={base} go={go} dark={dark} setDark={setDark} ticker={base !== "sagechat"}>
        <Comp go={go} back={back} dark={dark} setDark={setDark} />
      </AppShell>
    );
  } else {
    screenEl = <Comp go={go} back={back} dark={dark} setDark={setDark} />;
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#e7e2d3", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", overflow: "hidden", backgroundImage: "radial-gradient(rgba(0,0,0,0.04) 1px, transparent 1.5px)", backgroundSize: "22px 22px" }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: "center center" }}>
        <Device dark={statusLight} key={statusLight ? "d" : "l"}>
          <div key={meta.app ? "app" : cur} style={{ height: "100%", animation: meta.app ? "none" : "umscreen .26s cubic-bezier(.22,.61,.36,1)" }}>
            <style>{`@keyframes umscreen{from{transform:translateY(8px)}to{transform:none}}`}</style>
            {screenEl}
          </div>
        </Device>
      </div>

      {/* controls */}
      <div style={{ position: "fixed", bottom: 16, left: 0, right: 0, display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: "'JetBrains Mono', monospace" }}>
        <button onClick={back} disabled={hist.length < 2} title="Back" style={ctrlStyle(hist.length < 2)}>‹ Back</button>
        <button onClick={() => setShowIndex(true)} style={ctrlStyle(false)}>☰ Screens</button>
        <div style={{ padding: "8px 12px", borderRadius: 99, background: "#1d1d1b", color: "#f7f3e6", fontSize: 11, letterSpacing: 0.5, fontWeight: 600, maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labelFor(cur)}</div>
        <button onClick={() => setDark(d => !d)} title="Theme" style={ctrlStyle(false)}>{dark ? "☀ Light" : "☾ Dark"}</button>
      </div>

      {/* screen index overlay */}
      {showIndex && (
        <div onClick={() => setShowIndex(false)} style={{ position: "fixed", inset: 0, background: "rgba(20,18,12,0.55)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center", backdropFilter: "blur(3px)" }}>
          <div onClick={e => e.stopPropagation()} style={{ width: "min(600px, 95vw)", maxHeight: "84vh", overflowY: "auto", background: "#f7f3e6", borderRadius: "20px 20px 0 0", border: "2px solid #1d1d1b", borderBottom: 0, padding: "18px 18px 30px", fontFamily: "'Inter', sans-serif", boxShadow: "0 -20px 60px rgba(0,0,0,0.3)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, position: "sticky", top: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 18, color: "#1d1d1b", letterSpacing: -0.5 }}>Screen index <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#6b6b62", fontWeight: 600 }}>· {Object.keys(SCREENS).length} screens</span></div>
              <button onClick={() => setShowIndex(false)} style={{ width: 32, height: 32, borderRadius: 9, border: "2px solid #1d1d1b", background: "#f7f3e6", cursor: "pointer", fontSize: 15, fontWeight: 700 }}>✕</button>
            </div>
            {INDEX_GROUPS.map(grp => (
              <div key={grp.g} style={{ marginTop: 15 }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5, fontWeight: 700, color: "#6b6b62", letterSpacing: 1.2, marginBottom: 8 }}>{grp.g.toUpperCase()}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {grp.items.map(([k, t]) => {
                    const active = cur === k;
                    return (
                      <button key={k} onClick={() => jump(k)} style={{
                        padding: "8px 13px", borderRadius: 10, border: "2px solid #1d1d1b", cursor: "pointer",
                        background: active ? "#1d1d1b" : "#fbf8eb", color: active ? "#f7f3e6" : "#1d1d1b",
                        fontSize: 13, fontWeight: 600, boxShadow: active ? "none" : "2px 2px 0 #1d1d1b",
                      }}>{t}</button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ctrlStyle(disabled) {
  return {
    padding: "8px 13px", borderRadius: 99, border: "2px solid #1d1d1b",
    background: "#fbf8eb", color: "#1d1d1b", fontSize: 11.5, fontWeight: 700,
    cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
    boxShadow: "2px 2px 0 #1d1d1b", fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.3,
  };
}
function labelFor(cur) {
  for (const grp of INDEX_GROUPS) for (const [k, t] of grp.items) if (k === cur) return t;
  if (cur.startsWith("legal:")) return "Legal · " + cur.split(":")[1];
  return cur;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
