# W11 · LRS / TCS tracker (`/tax` section + dashboard card, LRS persona only)

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: W00 (DualCurrency, DataGapBanner), W08 (statement imports seed remittances), W12 (persona `residency = INDIA_LRS`).

**Ticket:** `MONEY-{n}` "LRS / TCS tracker" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/v2 US Launch.dc.html` "Your $250,000, accounted for." section (NRI note "This surface is LRS-only — you're viewing it as the NRI persona … For an NRI it never appears: no dashboard card, no Tax row, no Settings entry."; REMITTED THIS FY · HEADROOM REMAINING "$48,200 of $250,000 · ₹40,23,708 at RBI reference rates on each trade date"; HEADROOM "$201,800 · 80.7% unused · resets 01 Apr"; band legend "■ below ₹10L · no TCS ■ above ₹10L · TCS applies · ● NOT TAX ADVICE · ASSUMPTIONS EDITABLE"; REMITTANCE LEDGER · FY 2026-27 (DATE · AMOUNT · RBI REF · ₹ VALUE · TCS · SOURCE; TOTAL row); "TCS PAID · CLAIMABLE ₹6,04,742 — TCS isn't a cost — it's tax collected in advance. Claim it against your income-tax liability, or as a refund when you file. Shows up in Form 26AS." + "Export for my CA"; ASSUMPTIONS · YOURS TO SET (FY limit $250,000 · TCS threshold ₹10,00,000 · Rate above threshold · investment 20% · FX for ₹ value RBI REF · TRADE DATE) "Pre-filled bands we believe apply to investment remittances; edit to match your CA's reading and every figure recalculates.") · dashboard DELTA 4 "LRS HEADROOM · FY 26-27 · LRS PERSONA ONLY · $201,800 left · 19.3% USED" · `app/s-us.jsx` `LrsScreen` (+ Add remittance; ledger rows with source "INDmoney · import / manual / Vested · import") · `Module Specs A-H.dc.html` §D ("LRS headroom > 80% notification").

## Read first
- `apps/web/app/tax/{page}.tsx`, `sections/*` (TaxSnapshot, IncomeGains, Optimize, Compliance, FileSection), `components/*` (FYSelector, AdvanceTaxTimeline, primitives, tax-calc.ts), `apps/web/lib/actions/{tax,tax-ledgers,gst-profile}.ts`, `packages/services/src/tax{,-logic}.service.ts`, `packages/services/src/gst/*` (RBI ref `rbi-fx.ts`, GST FY helpers), Prisma `GstInvoice` (FY/TCS conventions to mirror), `Trade` US lots (`fxRateOnTrade`, `currency`, source batch)
- `apps/web/components/dashboard/v2/*` (W01 card slot), `apps/web/app/settings/*` (W12 Market preferences links here)
- Notifications: `packages/services/src/notifications.service.ts` (`NotificationType` — add `LRS_HEADROOM`)
- Indian FY helpers (Apr–Mar) already used by tax; TCS rules: keep them **as editable assumptions**, not hardcoded law.

## Current state
No LRS/TCS concept. US lots (W08) carry trade date, USD amount and RBI ref — the seed for remittances.

## Build (renders only when `residency === "INDIA_LRS"` and `us-stocks-listing` is on)
1. **Tax page:** new section "LRS & TCS · FY {fy}" below the existing sections (FY follows `FYSelector`): headroom band (remitted vs limit, % used, resets 01 Apr), legend, "NOT TAX ADVICE · ASSUMPTIONS EDITABLE", ledger table (date · amount $ · RBI ref · ₹ value · TCS · source), TOTAL row, TCS PAID · CLAIMABLE card with the Form 26AS copy, "Export for my CA" (CSV/XLSX via existing export utilities), ASSUMPTIONS card with Edit sheet (FY limit, TCS threshold, rate above threshold — investment, FX rule fixed to RBI ref of trade date), "+ Add remittance" (manual entry: date, amount $, purpose, RBI ref auto-filled or "needs FX"). Every figure recalculates from assumptions live.
2. **Dashboard card (W01 slot):** "LRS HEADROOM · FY 26-27 · $201,800 left · 19.3% USED" → deep-link to the tax section.
3. **Settings → Market preferences (W12):** "LRS tracker assumptions" row links here.
4. **NRI persona:** nothing renders anywhere (no card, no Tax row, no Settings entry) — enforce in one selector `shouldShowLrs(persona, flags)` (tested).
5. **Notification:** `LRS_HEADROOM` when used > 80% of the limit (in-app + email; push via A01).

## Data wiring
- Prisma: `LrsRemittance` (userId, fy, date, amountUsd, rbiRef, inrValue, tcsPaid?, purpose, source `IMPORT|MANUAL|SNAPTRADE_ACTIVITY`, importBatchId?, tradeId?), `LrsAssumptions` (userId, fyLimitUsd default 250000, tcsThresholdInr default 1000000, tcsRatePct default 20, updatedAt). Seed remittances from W08 statement commits (one remittance per import batch or per lot — decide with a `LrsSeedLogic` that dedupes by `tradeId`) and from SnapTrade deposit activities where available.
- Services: `packages/services/src/lrs.service.ts` + `lrs-logic.ts` (FY bucketing Apr–Mar, headroom, TCS bands from assumptions, claimable total, > 80% trigger — unit-tested with fixtures incl. FY rollover and a missing RBI rate → row flagged, excluded from totals with a `DataGapBanner` count).
- Actions: `getLrsSummaryAction(fy)`, `addLrsRemittanceAction`, `updateLrsAssumptionsAction`, `exportLrsLedgerAction(fy)`.
- `apps/api` mirror in `/v1/tax`: `GET /lrs?fy=`, `POST /lrs/remittances`, `PATCH /lrs/assumptions`, `GET /lrs/export`.
- Copy guard: every LRS surface carries "Not tax advice. We track what you tell us and what your statements say; limits, bands and eligibility are yours to verify with your CA."

## Non-goals
Filing/26AS integration, TCS on non-investment purposes, NRI tax.

## Acceptance
- Committing the Vested fixture (W08) creates the expected remittance rows for FY 2026-27; headroom, % used and TCS follow the assumptions; editing the threshold recalculates instantly (unit + functional tests).
- NRI persona: selector returns false → no LRS UI anywhere (render tests on dashboard, tax, settings).
- Missing RBI ref → row flagged, totals exclude it with a visible count; never a silently wrong ₹ value.
- Export contains every ledger column; > 80% usage creates exactly one notification per FY crossing.
- TEST-COVERAGE.md; `verify:push`; `/code-review ultra` (tax figures).
