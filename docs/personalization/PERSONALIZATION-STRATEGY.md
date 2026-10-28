# Personalization Strategy — Persona Engine & Adaptive Dashboards

_2026-07-03 · Owner: founder · Linear project: **Personalization — Persona Engine & Adaptive Dashboards** (initiative: 6-Month Goal — 1k paid · 50k free · VC-ready)_

## 0. Verdict on the two founding questions

**Persona questionnaire after signup?** Yes — but 4 questions, ≤30 seconds, skippable, editable later in Settings. It is a _cold-start prior only_ (confidence 0.6), never the final word. MONEY-397 already specs this modal; it moves into this project.

**Analyze portfolio + tradebook sync?** Yes — this is the _primary_ long-term signal and the one competitors can't copy (they see one broker; we see all of them + FIFO pairs). The nightly StockSage rollup already computes most inputs (`PortfolioBehaviorSnapshot`). Behavioral evidence overrides the questionnaire once enough samples accumulate; a manual user override outranks both.

**Resolution order:** `MANUAL (conf 1.0) > INFERRED (conf grows with evidence) > QUESTIONNAIRE (conf 0.6) > DEFAULT (BEGINNER, conf 0.1)`. If inference contradicts a manual choice for 60+ days, ask once — never silently reclassify a manual override.

## 1. What already exists (build on, don't rebuild)

| Piece                                                                                                                                                                                                                   | Status                                                          | Where                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `InvestorProfile` — riskAppetite, **experienceLevel (BEGINNER/INTERMEDIATE/ADVANCED enum already in prod schema)**, confidence, seededFrom, propensities (panicSeller/overtrader/fomoProne/dividendSeeker), traits Json | ✅ shipped                                                      | `packages/database/prisma/schema.prisma:1297`            |
| Self-learning memory: `UserEvent`, `PortfolioBehaviorSnapshot` (HHI, topWeight, positionCount, tradeCount30d, turnoverRatio30d, sector tilt, P&L), `PortfolioInsight`, `ConceptMastery` + nightly rollup                | ✅ merged (activation pending, MONEY-890/891)                   | schema.prisma:1330–1441                                  |
| Memory → prompt injection `assembleUserContext()` into chat + research                                                                                                                                                  | ✅ Done (MONEY-790)                                             | chat chokepoint                                          |
| Dashboard beginner/advanced variant toggle                                                                                                                                                                              | ✅ exists, **localStorage only** (`usemoney_dashboard_variant`) | `apps/web/components/dashboard/DashboardOverview.tsx:32` |
| Sidebar: static `sidenavConfig`, 4 groups, ~25 items, flag/demo gating                                                                                                                                                  | ✅                                                              | `apps/web/components/Sidebar.tsx:204+`                   |
| Command palette (hidden items stay reachable)                                                                                                                                                                           | ✅                                                              | `apps/web/components/CommandPalette.tsx`                 |
| Settings → Preferences tab (default-landing pref already lives here)                                                                                                                                                    | ✅ sparse                                                       | apps/web settings                                        |
| Chat-first IA: dashboard's empty state IS chat; persona prompt registry + chips                                                                                                                                         | ✅                                                              | DashboardOverview docblock, persona-selector             |
| Questionnaire modal spec                                                                                                                                                                                                | 🎫 MONEY-397 (Todo)                                             | —                                                        |
| Surface-delivery engine ("for surface X + user Y, show Z")                                                                                                                                                              | 🎫 MONEY-254 (Todo)                                             | —                                                        |

Gaps: user **type** dimension, server-persisted UI prefs, layout registry, sidebar visibility matrix, settings panel, inference→persona classifier, instrumentation.

## 2. Persona model: 3 levels × 4 types

`experienceLevel` (exists): BEGINNER · INTERMEDIATE · ADVANCED — drives **layout density + jargon**.
`userType` (new enum on InvestorProfile): FIRST_TIME · INVESTOR · TRADER · PORTFOLIO_MANAGER — drives **module mix ("accent pack")**.

Key simplification: **not 12 dashboards. 3 layouts × 4 accent packs.** Layout = f(level); which widgets/nav fill the slots = f(type). FIRST_TIME is transitional: no broker or empty portfolio → forces Beginner layout + activation checklist; auto-graduates on first sync.

|              | FIRST_TIME           | INVESTOR                     | TRADER                | PORTFOLIO_MANAGER              |
| ------------ | -------------------- | ---------------------------- | --------------------- | ------------------------------ |
| BEGINNER     | default signup state | SIP/MF learner               | paper-trading first   | (rare) family tracker          |
| INTERMEDIATE | — (graduated)        | core retail (largest cohort) | swing/F&O dabbler     | multi-account DIY              |
| ADVANCED     | —                    | factor/valuation nerd        | F&O active, multi-leg | 3+ brokers, ₹50L+, reports/API |

## 3. Inference signals (portfolio + tradebook sync)

All computable today from `PortfolioBehaviorSnapshot`, `PairedTradeView` (FIFO), `BrokerConnection`, `Trade`, `MutualFund`, paper trading, `ConceptMastery`, `UserEvent`.

| Signal                                             | Source           | BEGINNER       | INTERMEDIATE | ADVANCED                       |
| -------------------------------------------------- | ---------------- | -------------- | ------------ | ------------------------------ |
| tradeCount30d                                      | snapshot         | <5             | 5–40         | >40                            |
| F&O share of trades 90d                            | Trade segment    | 0              | <30%         | ≥30% or multi-leg options      |
| Median holding period (FIFO pairs)                 | PairedTradeView  | n/a or >1y     | weeks–months | days or mixed book             |
| turnoverRatio30d                                   | snapshot         | <0.1           | 0.1–0.5      | >0.5                           |
| positionCount / concentrationHHI                   | snapshot         | ≤5             | 5–25         | any, hedged                    |
| Brokers connected                                  | BrokerConnection | 0–1            | 1–2          | ≥2                             |
| MF/SIP share + regularity                          | MutualFund       | high (or none) | mixed        | low                            |
| Paper-vs-real ratio                                | PaperPosition    | paper-only     | mostly real  | real + strategies              |
| Tool usage (risk, screener, scans, research L3/L4) | UserEvent        | none           | occasional   | weekly                         |
| ConceptMastery breadth                             | mastery          | few, basics    | mid          | derivatives/valuation concepts |

Type rules (deterministic, explainable — SEBI-friendly; LLM only writes the _narrative_, never the class):

- **TRADER**: median hold <14d OR F&O share ≥25% OR intraday trades present.
- **INVESTOR**: median hold >90d AND turnover <0.2 (SIP regularity strengthens).
- **PORTFOLIO_MANAGER**: brokers ≥3 OR portfolio >₹50L OR (statement imports + tax/report usage + multiple family-style accounts).
- **FIRST_TIME**: no BrokerConnection AND no imports.
  Ties: TRADER beats INVESTOR if both fire; PM beats both when its rule fires. Classifier runs in the existing nightly rollup + immediately post-first-sync; writes `seededFrom` (audit trail) and bumps `confidence` (+0.05/consistent night, cap 0.95; contradiction decays 0.1). Reclassification proposal → `PortfolioInsight` row type `persona_shift` → soft in-app prompt, user confirms.

## 4. Questionnaire (30 seconds, skippable)

Runs inside the existing 5-step welcome wizard (one new step), stores to InvestorProfile with `source=QUESTIONNAIRE`:

1. **What describes you best?** First-time explorer / Long-term investor / Active trader / I manage multiple portfolios → `userType`
2. **Market experience?** Just starting / 1–3 years / 3+ years incl. F&O → `experienceLevel`
3. **Main goal here?** Learn investing / Grow long-term wealth / Improve my trading / Consolidate & track everything → accent-pack tiebreak + first-chat suggested prompts
4. **Risk comfort?** Conservative / Moderate / Aggressive → `riskAppetite` (exists)

Skipped → BEGINNER × FIRST_TIME defaults, inference takes over after first sync. Never block the wizard on it.

## 5. Memory layer = StockSage 2.0 memory (extend, don't fork)

The "personalization memory layer" is the **same** memory stack chat already consumes — one brain, many surfaces:

- Add `userType`, `personaSource` (QUESTIONNAIRE/INFERRED/MANUAL), `personaUpdatedAt` to InvestorProfile.
- Persona block joins `assembleUserContext()` → chat/research automatically adapt (depth, jargon, examples: Beginner gets "P/E explained", Advanced gets IV-skew talk). Zero new plumbing — MONEY-790 already injects.
- UI prefs (layout override, hidden nav items, module toggles) → `UserUiPreference` model (or `User.preferences` Json): `{ layoutOverride?, hiddenNavItems[], hiddenWidgets[], pinnedWidgets[] }` — server-persisted, replaces the localStorage variant key so it follows the user across devices.
- Persona changes logged as UserEvent (`kind: "persona_changed"`) → feeds the MONEY-791 bandit later (which layout/depth actually retains users — the self-improving loop).

## 6. Three dashboard layouts (chat always present — non-negotiable slot)

Chat is already the dashboard's empty state; every layout keeps StockSage as (a) the hero panel or (b) a persistent composer + right-rail. Persona changes _suggested chips_, never removes chat. Full visual spec → `archive-docs/quant-prompts/14-persona-dashboards-design.md`.

**BEGINNER — "Guide me"** (calm, 1-col + rail): greeting + net-worth card (big number, 1-line day change, no Greeks); activation checklist (connect broker → first roast → first lesson — FIRST_TIME accent); portfolio health score (roast-lite ring); Ask Sage hero with beginner chips ("Explain my portfolio like I'm new", "Is my portfolio too risky?"); Learn-next (ConceptMastery glow); paper-trading card. **Banned:** VaR, Greeks, F&O ladders, dense tables.

**INTERMEDIATE — "Keep me sharp"** (2-col): stat strip (value, day P&L, invested, XIRR); allocation donut + concentration flag (topWeight from snapshot); top holdings table; recent FIFO pairs (realized P&L); roast score + top fix; watchlist snap; news/insights rail; **tax preview teaser** (STCG/LTCG YTD — the FIFO moat); Sage panel with chips ("What's my XIRR vs NIFTY?", "Roast my portfolio").

**ADVANCED — "Get out of my way"** (3-col dense, terminal-luxe density): positions (day/overnight) with MTM; realized vs unrealized P&L split; risk strip (VaR, max DD, β, concentration); F&O book by expiry (TRADER accent); strategy/signals card (Epic 5 hook); multi-broker breakdown chips; corp-actions feed; screener/scan shortcuts; Sage composer pinned bottom ("Hedge check on my book", "Where am I overexposed?").

**Accent packs** swap 2–3 slots: INVESTOR → SIP tracker, MF x-ray/overlap, dividend upcoming; TRADER → pairing win-rate + streaks, intraday P&L, expiry ladder; PORTFOLIO_MANAGER → account switcher, consolidated statement/report exports, per-broker P&L; FIRST_TIME → checklist + demo data invite.

## 7. Sidebar noise reduction (25 items → persona defaults)

Registry: every nav item gets `{ id, minLevel, types?, core? }`. Core (always): Dashboard, StockSage, Brokers, Settings, Notifications. Hidden ≠ gone: command palette + Settings can re-enable anything (MONEY-230's parity philosophy).

| Item                                                       | BEG | INT | ADV | Accent unhide |
| ---------------------------------------------------------- | --- | --- | --- | ------------- |
| Dashboard / StockSage / Brokers / Settings / Notifications | ✅  | ✅  | ✅  | core          |
| Holdings                                                   | ✅  | ✅  | ✅  | —             |
| Learning (Courses/Tutor/Quiz)                              | ✅  | ✅  | opt | —             |
| Portfolio Roast                                            | ✅  | ✅  | ✅  | —             |
| FIRE Calculator                                            | ✅  | ✅  | opt | INVESTOR      |
| Watchlists · Markets · News                                | —   | ✅  | ✅  | INVESTOR@BEG  |
| Tradebook                                                  | —   | ✅  | ✅  | TRADER@BEG    |
| Calculators · Tax Report                                   | —   | ✅  | ✅  | PM@any        |
| Screener · Scans · Strategies · Research List              | —   | —   | ✅  | TRADER@INT    |
| Risk Report                                                | —   | opt | ✅  | PM@INT        |
| Document Vault                                             | —   | —   | ✅  | PM@any        |

Beginner sees ~9 items instead of 25. Mobile bottom bar follows the same matrix (5 slots).

## 8. Settings — user control (trust requirement)

Settings → **Personalization** panel: shows detected persona + _why_ ("2 brokers, 47 trades/30d, F&O 38% → Advanced Trader" — straight from `seededFrom`); override level/type (sets MANUAL); layout picker (auto/B/I/A); nav-item checklist; widget show/hide; "Reset to recommended". Transparency of the _why_ is itself a differentiator — nobody in Indian fintech shows their reasoning.

## 9. MOAT — what to show that only UseMoney can show

Broker apps are single-broker; official broker MCPs (Zerodha/Upstox/Groww) are raw single-broker data; INDmoney/ET Money lack FIFO pairing + F&O analytics + AI memory. The moat widgets per persona:

| Persona           | Moat widget (lead the layout with it)                                                               | Why competitors can't                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| BEGINNER          | Portfolio health score + plain-language roast across ALL brokers                                    | needs consolidated view + roast engine                                  |
| INTERMEDIATE      | **Tax preview (STCG/LTCG live from FIFO pairs)** + XIRR vs NIFTY                                    | needs cross-broker FIFO engine (our #1 asset)                           |
| ADV TRADER        | Pairing analytics (win rate, hold time, realized by strategy/expiry) + corp-action-adjusted history | Console does 1 broker; nobody does cross-broker                         |
| ADV INVESTOR      | Factor/concentration x-ray + research with memory                                                   | 114-tool research agent + ConceptMastery                                |
| PORTFOLIO_MANAGER | One consolidated statement + report exports (+ future API/MCP access — B2B Epic 13 tie-in)          | aggregation + docs engine                                               |
| All               | **Chat that remembers you** (panicSeller nudge: "3rd time selling a quality name on a red day")     | InvestorProfile propensities + memory injection — compounding data moat |

Anti-moat rule: never lead with quotes/charts (delayed Yahoo) — foreground _derived intelligence_, not ticks.

## 10. SEBI guardrail

Persona changes **presentation** (density, jargon, module order, education), never **advice**. No "beginners should buy X". Suitability language stays education-framed; output filter (MONEY-148) applies to all personas identically; persona-conditioned disclaimers (Beginner gets the plainest one). Log persona at answer-time in UserEvent for auditability.

## 11. Instrumentation & KPIs (prereq: MONEY-904 bot-filter/events)

Events: `persona_questionnaire_completed|skipped`, `persona_inferred{from,to,conf}`, `persona_overridden`, `layout_rendered{layout,accent}`, `nav_item_unhidden`, `widget_hidden|pinned`. KPIs: questionnaire completion ≥70%; override rate <15% (misclassification proxy); D7 retention by persona vs flat baseline; broker-connect rate for FIRST_TIME (activation north star); widget CTR by layout. Review in the weekly KPI ritual (MONEY-907).

## 12. Phasing

- **P0 (1–2 wks, ride with US-launch onboarding — new NRI users get persona onboarding day-1):** schema fields + questionnaire step (MONEY-397) + server UI prefs + 3 layouts (upgrade existing variant toggle) + sidebar matrix + settings panel v0.
- **P1 (wks 3–4):** inference classifier in nightly rollup + reconciliation prompts + persona block into assembleUserContext + persona chips/depth in chat + instrumentation.
- **P2 (Aug+):** moat widgets (tax preview, pairing analytics), accent packs full, demo-mode personas ×3 (sales asset), bandit-optimized layouts (MONEY-791), MONEY-254 engine generalized to notifications/email.

## 13. Linear map

Project: [Personalization — Persona Engine & Adaptive Dashboards](https://linear.app/dis-digital/project/personalization-persona-engine-and-adaptive-dashboards-b2f22fdabe17) (High · target Oct 31 · under the 6-Month Goal initiative).

| Ticket     | Phase | Title                                                                                               |
| ---------- | ----- | --------------------------------------------------------------------------------------------------- |
| MONEY-999  | P0    | Persona schema: userType + provenance + server-persisted UI prefs (foundation — blocks most others) |
| MONEY-397  | P0    | Post-signup persona questionnaire modal (moved in from Onboarding & Activation)                     |
| MONEY-1000 | P0    | Dashboard layout registry: 3 layouts, chat always present                                           |
| MONEY-1005 | P0    | Sidebar visibility matrix (25 → ~9 for beginners) + overrides                                       |
| MONEY-1006 | P0    | Settings → Personalization panel (persona + "why", toggles, reset)                                  |
| MONEY-1012 | P0    | Run design prompt 14 → 3 dashboard design sets                                                      |
| MONEY-1004 | P1    | Behavioral inference classifier (nightly rollup + post-first-sync)                                  |
| MONEY-1008 | P1    | Persona-aware chat/research defaults via assembleUserContext                                        |
| MONEY-1010 | P1    | Persona instrumentation + KPIs (rides MONEY-904/907)                                                |
| MONEY-1013 | P1    | SEBI guardrail: presentation-not-advice + audit log                                                 |
| MONEY-1007 | P2    | Accent packs (INVESTOR/TRADER/PM/FIRST_TIME)                                                        |
| MONEY-1009 | P2    | Moat widgets v1 (tax preview, pairing analytics, health score)                                      |
| MONEY-1011 | P2    | Demo-mode personas ×3                                                                               |
| MONEY-254  | P2    | Personalization delivery engine, all 11 surfaces (moved in from AI-Native Transition)               |

Design brief for the 3 dashboard sets: `archive-docs/quant-prompts/14-persona-dashboards-design.md`. B2B/MCP sibling epic: `archive-docs/quant-prompts/13-b2b-broker-mcp-platform.md`.
