export const meta = {
  name: 'theme-tokenize-ink-paper',
  description: 'Tokenize hardcoded #1d1d1b/#f7f3e6 to var(--ink)/var(--paper) across 67 files so elements are theme-aware in dark mode (context-aware: preserve text-on-fixed-accent + hard-shadows)',
  phases: [{ title: 'Tokenize', detail: '11 area agents tokenize hardcoded ink/paper hexes with per-site judgment' }],
}

const RULES = `
You are fixing a theme-awareness bug in the UseMoney web app (apps/web). Hardcoded ink/paper hexes don't flip in dark mode. In LIGHT theme: --ink === #1d1d1b and --paper === #f7f3e6 (so tokenizing is a NO-OP in light); in DARK theme the tokens flip (--ink→cream #f4ede0, --paper→deep-ink #16140e). So replacing the hex with the token makes the element theme-aware with ZERO light-mode change.

For EACH occurrence of "#1d1d1b" or "#f7f3e6" in YOUR assigned files, classify by CONTEXT and transform:

1. background / backgroundColor: "#1d1d1b" → var(--ink) ; "#f7f3e6" → var(--paper).  (element bg flips → stays contrasted on the theme-aware page)
2. border / borderColor / outline (and "Npx solid #1d1d1b"): "#1d1d1b" → var(--ink) ; "#f7f3e6" → var(--paper).
3. color (TEXT): tokenize ONLY IF the element's background is theme-aware (var(--paper*), transparent, white, or a --ink* surface):
     "#1d1d1b" → var(--ink) ; "#f7f3e6" → var(--paper).
   *** CRITICAL EXCEPTION ***: if the text sits on a FIXED-COLOUR background that does NOT flip with theme — i.e. var(--pop-1)/var(--pop-2)/.../var(--pop-5), var(--emerald), a gold/coral accent, or any fixed hex bg — KEEP the hardcoded "#1d1d1b" (dark) / "#f7f3e6" (light) text. Tokenizing it would make e.g. cream text on a gold card in dark mode = unreadable. To decide: look at the SAME element's (or its parent card's) background. If that bg is a fixed accent → KEEP the text hex.
4. box-shadow / boxShadow containing "#1d1d1b" (e.g. "4px 4px 0 #1d1d1b", "6px 6px 0 #1d1d1b"): LEAVE UNCHANGED. Hard-shadows intentionally stay black in dark mode (playful-app.css keeps --shadow-* black in dark). Do NOT tokenize shadow colors.
5. Rare: a background:"#1d1d1b" that is an INTENTIONAL fixed-dark brand accent meant to stay dark in BOTH themes (e.g. a deliberately-dark hero/CTA block whose whole point is a dark contrast block) — if tokenizing to var(--ink) would clearly break the intended design, KEEP it and add it to "flagged". When unsure, PREFER tokenizing (it's almost always correct + maintains page contrast).

CONSTRAINTS: change ONLY color values per the rules — no layout/logic/markup changes. Do NOT edit playful-app.css. TypeScript strict. After editing, the files must still compile. When done, run \`cd apps/web && npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "<your file basenames>"\` to confirm no new errors in your files (the repo has 0 baseline errors).
`

const GROUPS = [
  { label: 'risk', files: ['app/risk/components/CorrelationHeatmap.tsx','app/risk/components/RiskTabs.tsx','app/risk/sections/DecideSection.tsx','app/risk/sections/DiagnoseSection.tsx','app/risk/sections/SnapshotSection.tsx'] },
  { label: 'settings', files: ['app/settings/client.tsx','app/settings/investor-profile/client.tsx','app/settings/tabs/AccountTab.tsx','app/settings/tabs/BillingTab.tsx','app/settings/tabs/PlansTab.tsx','app/settings/tabs/PreferencesTab.tsx'] },
  { label: 'strategies', files: ['app/strategies/[id]/backtest/client.tsx','app/strategies/[id]/client.tsx','app/strategies/[id]/forward/client.tsx','app/strategies/build/client.tsx','app/strategies/create/client.tsx'] },
  { label: 'tax', files: ['app/tax/components/primitives.tsx','app/tax/sections/FileSection.tsx','app/tax/sections/Optimize.tsx','app/tax/sections/TaxSnapshot.tsx'] },
  { label: 'tradebook-paper-etf', files: ['app/tradebook/client.tsx','app/tradebook/export/client.tsx','app/tradebook/import/client.tsx','app/paper-trading/client.tsx','app/etf/[symbol]/client.tsx'] },
  { label: 'dashboard-chat-analysis', files: ['components/dashboard/DashboardOverview.tsx','components/chat/ChatMessage.tsx','app/analysis/client.tsx','app/dashboard/client.tsx'] },
  { label: 'help', files: ['components/help/DocsTab.tsx','components/help/FAQTab.tsx','components/help/GettingStartedTab.tsx','components/help/GuidesTab.tsx','components/help/ResourcesTab.tsx','components/help/SlashCommandsTab.tsx'] },
  { label: 'notifs-credits-tickers', files: ['components/NotificationDropdown.tsx','components/NotificationBell.tsx','components/MarketTicker.tsx','components/marketing/PlayfulTicker.tsx','components/credits/CreditCounter.tsx','components/credits/PurchaseCreditsModal.tsx','components/banners/TrialEndingBanner.tsx'] },
  { label: 'modals-misc-components', files: ['components/CommandPalette.tsx','components/PageAccessModal.tsx','components/NoCreditDialog.tsx','components/UpgradePrompt.tsx','components/ComingSoon.tsx','components/ThemedToaster.tsx','components/pricing/PlanChangeConfirmDialog.tsx','components/playful/PfFilterPills.tsx','components/auth/AuthShell.tsx','components/roast/RoastResults.tsx'] },
  { label: 'app-misc-a', files: ['app/(marketing)/features/client.tsx','app/(marketing)/not-found.tsx','app/(public)/not-found.tsx','app/not-found.tsx','app/global-error.tsx','app/calculators/[slug]/client.tsx','app/calculators/[slug]/loading.tsx','app/welcome/client.tsx'] },
  { label: 'app-misc-b', files: ['app/chat-history/client.tsx','app/quizzes/client.tsx','app/fire/client.tsx','app/documents/client.tsx','app/notifications/client.tsx','app/discover/news/NewAlertDrawer.tsx','app/discover/news/NewFeedDrawer.tsx'] },
]

const OUT = {
  type: 'object', additionalProperties: false,
  required: ['label', 'filesChanged', 'sitesChanged', 'compiles', 'summary'],
  properties: {
    label: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    sitesChanged: { type: 'number' },
    keptOnFixedAccent: { type: 'number', description: 'count of color:#1d1d1b/#f7f3e6 kept because on a fixed accent bg' },
    shadowsLeft: { type: 'number', description: 'count of box-shadow #1d1d1b left untouched' },
    flagged: { type: 'array', items: { type: 'string' }, description: 'intentional fixed-dark accents kept (file:line + why)' },
    compiles: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

log(`Theme tokenization sweep: ${GROUPS.length} area agents over ${GROUPS.reduce((n,g)=>n+g.files.length,0)} files`)
phase('Tokenize')
const results = await parallel(
  GROUPS.map((g) => () =>
    agent(
      RULES + `\n\n=== YOUR FILES (apps/web/...) ===\n` + g.files.map((f) => 'apps/web/' + f).join('\n') +
      `\n\nGo file by file. For each hardcoded #1d1d1b / #f7f3e6, apply the classification rules above. Report counts + any flagged intentional-fixed accents.`,
      { schema: OUT, phase: 'Tokenize', label: `theme:${g.label}` },
    ),
  ),
)
return { results: results.filter(Boolean) }
