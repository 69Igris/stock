# TODOS

## Design system: sweep hard-coded colors to tokens (P3, after 2027-01-05)

- **What:** Replace hex literals in apps/web with DESIGN.md tokens; converge on the playful pf button system.
- **Why:** Hard-coded colors break dark mode and cause contrast drift on older screens.
- **Pros:** Dark mode and AA contrast hold everywhere; one button vocabulary.
- **Cons:** Wide diff (143 files), visual regressions to check.
- **Context:** Measured 2026-09-23 by /plan-design-review: 853 six-digit hex literals across 143 .tsx files in app/ + components/ (top: #1d1d1b ×124, #b91c1c ×87, #34d399 ×58 — the last is the discarded Terminal Luxe palette, still in tailwind.config.js as um-emerald/um-navy); 6,930 inline `style={{`; three button systems (415 pf-bs/pf-bf, 90 shadcn Button, ad-hoc inline). New screens follow DESIGN.md (DS-SYS1). Start with DashboardOverview.tsx and welcome/client.tsx.
- **Depends on / blocked by:** DESIGN.md (DT8) and the fill-as-text lint rule (DT9).
- **Effort:** human L / CC M.

## DX: `yarn ticket:start MONEY-n` (P3, after 2027-01-05)

- **What:** One command that validates the {type}/MONEY-n branch name, branches from origin/main, fetches the Linear ticket, and writes .claude/ticket.md linking only the relevant docs/reference pages and plan task IDs.
- **Why:** Claude sessions run 20+ hours; each starts by hand-building context across 6 doc homes.
- **Pros:** Consistent session starts; enforces branch naming; less context spent on setup.
- **Cons:** Needs a Linear API token locally; one more script.
- **Context:** Deferred by founder in /plan-devex-review D10 (23-Sep-2026). Pairs with DX-CTX (CLAUDE.md index + docs/reference per system) — build after that lands.
- **Depends on / blocked by:** XT2 (CLAUDE.md index).
- **Effort:** human M / CC S.

## Design audit 2026-09-23 — NEW findings not covered by plan decisions (report: ~/.gstack/projects/UseMoney-AI-stockbook-monorepo/designs/design-audit-20260923/)

- **F-4 (HIGH, responsive):** logged-out mobile marketing home shows the signed-in app bottom nav (Holdings · Screener · + · Brokers · More); every tab bounces to sign-in. Hide GlobalMobileBottomNav on marketing/public routes. Quick win.
- **F-10 (MEDIUM, interaction):** Google One Tap fires inside demo mode and errors ("Not signed in with the identity provider"). Suppress One Tap when the demo cookie is present. Quick win.
- **F-11 (MEDIUM, states):** StockSage recent-chats spinner never resolves in demo. Verify; likely needs demo chat fixture (fold into DS-ST2 coherent demo fixture).
- **F-13 (POLISH, typography):** two `<h1>` on the marketing home (hero + in-mockup "Good evening, Shaswat."). Demote the mockup heading.
- F-3 detail for DS-ST2: demo holdings show XIRR −19.0% / CAGR −17.5% beside +7.06% unrealised — the demo fixture's agreement test must also check return figures are consistent.
