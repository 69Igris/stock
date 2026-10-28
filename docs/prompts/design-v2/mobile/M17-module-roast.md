# M17 · Module: Portfolio Roast — scope → run → verdict → share card

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Prerequisites: M00, M10. Related: M14 (Ask Sage prefill), M19 (plan gate), A01 (push on completion).

**Ticket:** `MONEY-{n}` "Mobile — Roast" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/app/s-roast.jsx` (`RoastScreenV2`: intro `PageHead` "Can your book take a punch?" + "AI scores your holdings. Not a hit-piece — just real.", sticker "last roast: 58 · Jul 12", scope options Full portfolio ("13 holdings · equity + MF · all 3 brokers") / Equity only / A watchlist ("roast stocks before you buy them"), "Roast me" + "FREE PLAN: 1 ROAST / MONTH · PRO: UNLIMITED"; run phase `PageHead` "Judging everything." + flame tile + 5 `ProgressSteps` (Reading N holdings across N brokers · Judging concentration & overlap · Auditing your costs · Checking your behaviour · Sharpening the verdict); verdict phase: `ScoreDial` /100, one-liner quote, delta + tag, "The verdict" cards (good/bad/warn icon + title + body), "Holding by holding" rows (symbol · heat SPICY/BURN/MILD · line), stat tags, "Ask Sage how to fix it", Share → `RoastShareSheet` (dark card: score, quote, "GET YOURS AT USEMONEY.AI"; buttons WhatsApp · X / Twitter · Save image · Copy link; "YOUR NUMBERS STAY PRIVATE — ONLY SCORE + ONE-LINER GO OUT."), "Roast again") · `Module Specs A-H.dc.html` notification touchpoints (roast complete).

## Read first
- `apps/api/src/routes/v1/roast.ts`: `GET /v1/roast` (history), `GET /v1/roast/can-use` (quota/plan), `GET /v1/roast/running`, `POST /v1/roast` (start; scope param? — check the web `startRoastAction` in `apps/web/lib/actions/roast.ts` for scope support: full/equity/watchlist; add `scope` to the API if the service supports it, else v1 = full portfolio only and the other two options render disabled with "coming soon"), `GET /:sessionId/status`, `GET /:sessionId`, `POST /:sessionId/cancel`, `DELETE /:id`
- `packages/roast` (6-step pipeline → the 5 progress labels map to its stages; result schema: score, headline, sections/cards, per-holding heat), `packages/services/src/roast.service.ts`, `packages/core/src/subscription/plans.ts` (`portfolio_roast: 5` credits; FREE monthly allowance `freeRoastsUsedThisMonth`), `workers/src/processors/roast.ts`
- Share: `expo-sharing` + `react-native-view-shot` (render the share card off-screen → PNG), `expo-clipboard`

## Build
1. **Intro:** last roast sticker from `/v1/roast` history (date + score; hidden if none), scope selector (server-supported scopes only), CTA + plan line from `/v1/roast/can-use` (FREE remaining this month / PRO unlimited; exhausted → `GateBanner` and the CTA disabled).
2. **Run:** `POST /v1/roast {scope}` → poll `/status` (map pipeline stage → step index; sub-lines from the status payload counts — holdings/brokers — never invented); leaving the screen keeps polling in the background (query stays mounted in a small store) and A01 push deep-links back; cancel via the back button confirm sheet.
3. **Verdict:** from `GET /:sessionId`: `ScoreDial`, headline quote, delta vs previous roast (compute from history — "+4 since Jul 12"; omit if no previous), verdict cards, per-holding heat rows (colour by heat), stat tags (from the result's stats block), actions: "Ask Sage how to fix it" (prefill with the top bad card's title), Share, Roast again.
4. **Share sheet:** dark card image (score + quote + wordmark; **no holdings, no amounts**), WhatsApp/X via the system share sheet with the image + link (`https://usemoney.ai/roast/{id}` — public share page exists? check `apps/web/app/roast/[id]`; if it requires auth, share the image only), Save image (media library permission just-in-time), Copy link.
5. **States:** running elsewhere (`/running` → resume), failed (message + refund note; retry), gated, demo (static demo verdict).

## Non-goals
Roasting a watchlist if the service lacks it, editing the verdict, comments.

## Acceptance
- Full-portfolio roast on QA completes with steps advancing on real stages; the verdict renders every field from the result schema (fixture render test); credits/allowance move exactly once.
- FREE user with the allowance exhausted sees the gate and `POST /v1/roast` is never called (test).
- Share image contains only score + quote + wordmark (snapshot test of the share view); WhatsApp/X share opens the system sheet.
- Push on completion deep-links to the verdict (manual on device).
- Screenshots (intro, run, verdict, share; light/dark); `verify:push`; `/code-review`.
