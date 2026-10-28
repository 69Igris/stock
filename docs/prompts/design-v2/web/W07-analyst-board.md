# W07 · AI Hedge-Fund Analyst Board (Module B) — setup → hearing → verdict board → share

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: W00 (VerdictCard, DebateTranscript, GateInline, CreditChip, DataGapBanner), W06 (research US arm optional).

**Ticket:** `MONEY-{n}` "Analyst Board v1" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/web/mod-b.jsx` (three phases: `setup` — symbol chips with "· you hold", `PersonaTile` grid with locked tiles "PRO BOARD — FREE GETS 2 PERSONAS / 1 SYMBOL / DAY", `WGate` PRO line, "Convene the board ⚡3 · ~90s · PERSONAS ARE ANALYSIS LENSES, NOT ADVICE"; `run` — "The room goes quiet. Everyone's reading…" staggered per-persona status strings; `board` — masthead "THE VERDICT BOARD · JUL 20, 09:44 IST · 14 SOURCES", tally pills "2 BULLISH / 2 NEUTRAL / 1 BEARISH", `VerdictCard`s, Risk Manager panel "DETERMINISTIC — NO OPINIONS" (position cap, you hold vs cap, sector weight vs index, correlation-cluster note), "Bull vs bear — 2 rounds" `DebateTranscript`, FINAL VERDICT · WEIGHTED BY CONVICTION + mandatory DISSENT line, "Share the board" modal (score + dissent, "NO PERSONAL NUMBERS"), "New hearing") · `web/wdata.js` `PERSONAS`, `DEBATE` (shapes + voice, not data) · `Module Specs A-H.dc.html` §B.

## Read first
- `packages/research/src/{agent,planner,executor}.ts`, `packages/research/src/skills/*` (how a skill declares tasks), `packages/research/README.md`; `apps/web/lib/actions/research.ts` (job/credit/refund pattern), `workers/src/processors/research{,-logic}.ts` (Pub/Sub research job), `packages/services/src/research.service.ts`, `analysis.service.ts` (L3 sessions)
- `packages/core/src/gemini/model-registry.ts` (founder gating), `packages/core/src/subscription/plans.ts` (`CREDIT_COSTS` — add `analyst_board: 3` and `analyst_board_pro: 5`)
- `apps/web/app/analysis/*` (Research List — where sessions live), `apps/web/app/stock/[symbol]/client.tsx` (launch point), `apps/web/components/chat/SlashCommandMenu.tsx` (`/board` command), `apps/web/lib/actions/risk.ts` + `packages/services/src/risk.service.ts` (concentration/correlation numbers for the Risk Manager)
- `docs/quant/LINEAR-MAP.md` Project 4 (persona agent framework MONEY-961…) — the full 13-persona framework is engine work; v1 here is TS-only on the existing research loop.

## Current state
No board surface. The research agent runs skills/tools and synthesises a report; L3 analysis sessions exist (`AnalysisSession`). Risk metrics exist (`risk.service.ts`).

## Build (flag `analyst-board`, default OFF)
1. **Entry points:** stock page action "Convene the board" (`/analysis/board?symbol=INFY`), Sage `/board INFY` slash command, Discover entry card (Research List). Route: `apps/web/app/analysis/board/{page,client}.tsx` (+ `[sessionId]`).
2. **Setup:** symbol picker (search + "you hold" tag from holdings), persona tiles — default board of 5 (Buffett · Lynch · Burry · Damodaran · Jhunjhunwala) with one-line philosophies; full 13 (Graham, Munger, Wood, Dalio, Ackman, …) locked behind PRO with `GateInline`; FREE = 2 personas / 1 symbol / day (quota meter shows remaining); "Convene the board ⚡{CREDIT_COSTS.analyst_board}" + "~90s · PERSONAS ARE ANALYSIS LENSES, NOT ADVICE".
3. **Run:** persona tiles flip through real progress states from the job ("reading annual report…", "checking owner earnings…", "running the DCF…", "reading the call transcript…", "sizing the short case…") → "VERDICT SEALED ✓"; a persona that fails shows "couldn't finish reading — re-run", never a fabricated verdict.
4. **Board:** masthead (symbol · time IST · sources count), tally pills, per-persona `VerdictCard` `{signal, conviction 0–100, thesis ≤ 2 lines}`, Risk Manager panel with **deterministic numbers only** from `risk.service`/holdings (position cap % → ₹ max, "YOU HOLD · ₹x (y%) — OVER CAP", sector weight vs index, correlation-cluster warning), `DebateTranscript` (2 rounds bull vs bear, speaker-labelled, collapsible), FINAL VERDICT weighted by conviction + **mandatory dissent line** (the highest-conviction opposing persona; always present), share card (symbol · verdict · tally · dissent quote · "NO PERSONAL NUMBERS · USEMONEY.AI"; PNG via existing share/export utilities if present, else copy-to-clipboard text), "New hearing". Footer: "PERSONAS CHANGE PRESENTATION, NEVER RECOMMENDATIONS · EDUCATION, NOT ADVICE".
5. **States:** FREE quota exhausted (`GateInline`), filings stale (`DataGapBanner`), partial board, session history in Research List with the board badge.

## Data wiring
- Run as a **research-mode variant** (`mode: "board"`) through the existing Pub/Sub research job — do not invent a second job system: `startResearchAction({ mode:"board", symbol, personas })` → worker → `packages/research` orchestrates: shared data-gathering tasks once (fundamentals, filings/calls, quotes, user's position via `assembleUserContext`), then one structured-output call per persona from a prompt file (`packages/research/src/personas/{id}.md` — voice + framework + hard "no advice" rule), then 2 debate rounds (bull = highest bullish, bear = highest bearish), then a deterministic aggregator (`board-logic.ts`: weighted verdict, dissent selection, tally) and a code-computed Risk Manager (`risk-manager-logic.ts`: caps from plan config, portfolio fit from holdings + correlation from `risk.service`). Persist to `ResearchSession.result` with `board: { verdicts[], debate[], final, dissent, risk }`; debate renders from stored transcript (no regeneration on view).
- Zod: `AnalystVerdictSchema` — malformed persona output → that persona "failed", never 50-defaults; the run still completes if ≥ 2 personas succeed.
- Credits: consume on accept, refund on failure; FREE teaser quota in `credit.service`/entitlements (`analyst_board_free_daily = 1`).
- Signals persist per `packages/types` contract so roast/screener can read them later (`PersonaSignal { personaId, symbol, signal, conviction, asOf }`).
- `apps/api` mirror: `POST /v1/research` with `mode:"board"`; `GET /v1/research/:sessionId/result` returns the board payload; `GET /v1/research/board/quota`.
- Flags: `analyst-board`; PRO/FREE via entitlements.

## Non-goals
The 13-persona quant framework internals (engine programme), portfolio-level boards (v2), sharing images with personal numbers.

## Acceptance
- Persona outputs validate against the Zod schema; a malformed one is marked failed (test with a malformed fixture) and the board still renders with the dissent line present (test: dissent never omitted when ≥ 1 opposing persona exists).
- Risk Manager numbers reproducible from inputs (unit test); no LLM text in that panel.
- FREE user: 2 personas, 1 symbol/day enforced server-side; PRO: full board; credits refunded on failure.
- Debate renders from the stored transcript (no model call on view — assert no provider call in a view test).
- Copy exactly per design (no "buy"/"sell" verbs — grep the persona prompt files and rendered output).
- TEST-COVERAGE.md; `verify:push`; `/code-review`.
