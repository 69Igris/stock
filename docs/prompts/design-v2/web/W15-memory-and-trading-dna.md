# W15 · Memory & Trading DNA (Module F) — "Your Investing DNA" · memory transparency center · in-chat MemoryChip · per-run personalisation toggle

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: W00 (EvidenceLink, MemoryChip), W14 (persona schema; `assembleUserContext` persona block). **Reconcile with what exists — a greenfield rebuild is a mistake.**

**Ticket:** `MONEY-{n}` "Memory + Trading DNA v1" → `feat/MONEY-{n}` (blueprint: `~/Documents/Claude/Projects/UseMoney - Research/memory-personalization-blueprint.md` §4 "Build design — packages/memory (all on existing infra)").
**Design sources:** `docs/design/v2-bundle/web/mod-f.jsx` (tabs Trading DNA · Memory center · In-chat indicators; DNA metric cards `{ t, v, ev, bad }` e.g. "You hold losers 2.4× longer than winners — Disposition ratio 2.4 — EVIDENCE: FROM 47 PAIRED TRADES →", flags "✓ No revenge-trading pattern detected", AI-GENERATED COACHING band "FROM THE DETERMINISTIC METRICS ABOVE · DELETABLE", footer "METRICS NEED ≥10 PAIRED TRADES — BELOW THAT WE SHOW 'NOT ENOUGH DATA', NEVER A WEAK STAT."; memory list rows `Tag` kind + text + pin/edit/delete, empty "Sage remembers nothing yet — It learns from chats and trades you make here — nothing is imported from anywhere else.", "Delete all remembered facts · DPDP RIGHT-TO-ERASURE · IMMEDIATE · IRREVERSIBLE"; in-chat chip "REMEMBERING: LONG-TERM, LOW-CHURN · TAX-FIRST · MANAGE"; research toggle "Personalise with my profile — Position sizing, tax lots, hold-style preferences woven into the report. Off = a clean-room report." with the two footers; evidence modal "Evidence — the trades behind the number … Deterministic: re-runs give the same answer.") · `web/wdata.js` `DNA`, `MEMORIES` (shapes) · `Module Specs A-H.dc.html` §F · `app/s-account.jsx` `SettingsScreenV2` "Sage memory · DPDP" (mobile seam).

## Read first
- Prisma `InvestorProfile` (propensities panicSeller/overtrader/fomoProne/dividendSeeker), `UserEvent`, `PortfolioBehaviorSnapshot`, `PortfolioInsight`, `ConceptMastery`, `DocumentEmbedding`, `PairedTradeView`, `ChatHistory`, `ResearchSession`; `packages/core/src/investor/*` (`capture.ts`, `context.ts` `assembleUserContext` — MONEY-790 injection, `mastery.ts`), `packages/core/src/embeddings.ts` (768-dim Vertex, model flag), `packages/research/src/data-sources/user-document-retriever.ts` (retrieval pattern to mirror), `workers/src/processors/{investor-rollup,intent-learning}.ts` (MONEY-890/891 rollups), `apps/web/app/api/chat/route.ts` (`sanitizeMemoryContext`, context assembly), `apps/web/components/chat/ResearchConfirmSheet.tsx`, `apps/web/app/settings/tabs/PreferencesTab.tsx`, `packages/services/src/account-deletion.service.ts` (erasure pattern)
- `apps/web/app/tradebook/*` (open the evidence trades), `packages/core/src/pairing/*`

## Current state
StockSage 2.0 memory schema exists (profile propensities, events, snapshots, insights, concept mastery, nightly rollup, context injection). No behavioural DNA metrics, no `MemoryItem` collection, no transparency UI, no chat chip, no per-run toggle.

## Build (flag `memory-dna`, default OFF)
1. **Nightly DNA rollup** (extend `investor-rollup`): deterministic metrics over `PairedTradeView` — win rate × hold-duration buckets (<1 mo / 1–12 mo / >1 yr), by sector, by time-of-day; expectancy; disposition ratio (median hold of losers ÷ winners); revenge-trade flags (entry < N min after a realized loss AND size escalation); streak size-drift (avg size after a 2-win streak vs baseline); churn vs platform median. Each metric stores `evidenceRefs` (trade ids, N). `< 10 paired trades → "not enough data"` per metric. Pure functions in `packages/core/src/investor/dna-logic.ts` with golden fixtures (incl. disposition ratio edge cases, revenge flag boundaries).
2. **"Your Investing DNA" page** (`/settings?tab=personalization#dna` or `/profile/dna` — pick the route consistent with the sidebar; Module Specs says "Investing DNA under Profile"): metric cards (✓/! icon, declarative title, value line, `EvidenceLink` → sheet with the trades), flags row, one AI-GENERATED COACHING paragraph (LLM narrates the computed numbers only — the prompt receives metrics, never raw trades; label + "deletable"), footer rule. Mobile seam consumed by M19.
3. **`MemoryItem` collection:** `{ userId, kind: FACT|PREFERENCE|EPISODE|INSIGHT|TRADING_DNA, text, embedding (existing helper), pinned, supersededBy?, source: CHAT|RESEARCH|TRADE|MANUAL, sourceRefId, createdAt, lastUsedAt }`; **post-chat / post-research extraction worker** (`workers/src/processors/memory-extract.ts`, Gemini Flash structured output, ADD-biased, dedupe cosine > 0.9 → supersede, never in the request path, idempotent on redelivery by `sourceRefId`).
4. **`getContext(userId, query)`** in `packages/core/src/investor/memory-retrieval.ts`: vector top-k + temporal decay + MMR + pinned-always → ≤ 10 bullets injected into `assembleUserContext` (behind the per-run toggle); respects `sanitizeMemoryContext`.
5. **Memory transparency center (Settings → Privacy & memory):** list (kind tag, text, pin/edit/delete), "Delete all remembered facts" (DPDP erasure = hard delete of items + embeddings, immediate, irreversible, confirm sheet), empty state copy; export as part of the existing data export.
6. **In-chat `MemoryChip`** under the composer ("REMEMBERING: …" summarising the top pinned/used items + MANAGE link) — always dismissible, never blocks; **research confirm sheet toggle** "Personalise with my profile" (default on; off = clean-room run; the report carries a "PERSONALISED USING YOUR PROFILE" tag when on).

## Data wiring
- Actions: `getTradingDnaAction`, `getDnaEvidenceAction(metricId)`, `listMemoryItemsAction`, `updateMemoryItemAction`, `pinMemoryItemAction`, `deleteMemoryItemAction`, `deleteAllMemoryAction`, `setRunPersonalisationAction` (per research run param, not a global).
- Services: `packages/services/src/memory.service.ts` (+ `memory-logic.ts`: dedupe/supersede rules, decay/MMR ranking — tested), `dna.service.ts`.
- Research/chat: `startResearchAction` gains `personalise: boolean`; `apps/web/app/api/chat/route.ts` reads memory bullets via `getContext` when the user has items; `sanitizeMemoryContext` guards remain.
- `apps/api` mirror: `GET /v1/me/dna`, `GET /v1/me/memory`, `PATCH /v1/me/memory/:id`, `DELETE /v1/me/memory/:id`, `DELETE /v1/me/memory` (erase all), `POST /v1/research` `personalise` flag.
- Logging: nothing memory-related in logs beyond ids (test with a log spy).

## Non-goals
Importing memories from other assistants, cross-user insights, LLM-invented metrics.

## Acceptance
- DNA metrics reproducible from fixture trade sets (golden tests incl. disposition ratio + revenge edge cases); < 10 pairs → "not enough data" for every metric (test).
- Extraction worker idempotent on redelivery; dedupe supersedes near-duplicates (fixture with cosine > 0.9).
- Erasure removes items **and** embeddings verifiably (count = 0 after; test), and the chip disappears.
- Memory bullets change a research run only when the toggle is on (assert context assembly in both modes); coaching paragraph never contains trade ids or raw numbers not present in the metrics input.
- TEST-COVERAGE.md; `verify:push`; `/code-review ultra` (user-data surface).
