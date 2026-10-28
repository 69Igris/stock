# P0-04 · US access becomes an entitlement · USD plans on Dodo · GateInline + /upgrade?market=US

Ticket: MONEY-1624 (+ MONEY-917) · Branch: `feat/MONEY-1624` · Flag(s): `us-upgrade` · Screens: S0.4 `/upgrade?market=US`, S0.5 GateInline · Depends on: P0-03 (and P0-01/P0-02 through it) · Parallel-safe with: P0-05

> Read docs/prompts/design-v2/00-shared-context.md and docs/prompts/us-fullstack/00-shared-context.md first — both are part of this prompt. This is a MONEY + ENTITLEMENT path: finish with `/code-review ultra`.

## Goal

"May this user see US data?" stops being a hand-edited email list and becomes a rule: a plan at or above `PRO`, OR the founder allowlist, under a global mode that defaults to today's behaviour and stays fail-closed. A FREE user with a US surface flagged on sees a `GateInline` card — never a modal — that names the real plan and the real price, and taps through to one `/upgrade?market=US` screen where Premium is recommended and prices are shown in the currency chosen by IP (₹ in India, $ elsewhere). USD checkout works on Dodo.

## Why / measured state today (verified 2026-09-24)

- **Rule:** `isUsMarketAllowed(email)` only (`packages/core/src/market-data/us-market-access.ts:67`), CSV env `US_MARKET_ALLOWED_EMAILS`, default founder (`:38`). After P0-03 every caller reaches it through `resolveUsLayer`, whose states are `on | absent`.
- **Plan rank already exists:** `isPlanAtLeast(planId, min)` (`packages/core/src/subscription/features.ts:114`, FREE 0 · PRO 1 · PREMIUM 2 · ULTIMATE 3). Plan lookup: `getSubscription(userId)` (`packages/services/src/subscription.service.ts:222`), used fail-closed by `apps/api/src/lib/premium-gate.ts:33`.
- **Precedent for a plan-or-allowlist rule:** Claude access, `isClaudeEntitled` + per-model `requiresPlan` (`packages/core/src/gemini/model-registry.ts:69`); root `CLAUDE.md` MONEY-1274 explains why one rule is read by both the picker and the route.
- **Every price is INR.** `PLAN_CONFIG` (`packages/core/src/subscription/plans.ts`, `currency: "INR"` on every plan) and `packages/core/src/payments/plan-config.ts:54-98`. Checkout is `createCheckoutAction` (`apps/web/lib/actions/subscription.ts:695`); the product comes from `getDodoProductInfo(planType, billingPeriod)` (`packages/services/src/product-sync.service.ts:127`), which queries `buildProductQuery` (`packages/services/src/product-sync-logic.ts:171`) = `{planType, billingPeriod, archived:false}` — **no currency**. `DodoProduct` already stores `currency` (`packages/database/prisma/schema.prisma:367`), `Payment.currency` defaults `"INR"` (`:198`).
- **⚠ Blast radius:** products are synced FROM Dodo by name (`PRODUCT_PLAN_MAPPING`, `product-sync-logic.ts:83`). The moment a USD product with a mapped name exists in Dodo, `findFirst` over `{planType, billingPeriod}` can return it for an Indian customer. The currency filter MUST ship before the founder creates any USD product.
- **No IP country is read anywhere** in `apps/web` (grep `x-vercel-ip-country` → 0).
- **No `/upgrade` route** (`apps/web/app/upgrade` absent). Upgrade intents land on `/settings?tab=plans` or `/pricing` (32 links in `apps/web/{components,app}`); design review DS-IA2 replaces them with one `/upgrade` (repointing all is DT2, not here).
- **No `GateInline`** exists (W00 not built); W00 specifies it at `apps/web/components/design-v2/GateInline.tsx` with `{ tier, line, ctaHref }` (`docs/prompts/design-v2/web/W00-design-primitives-and-shell.md:24`).
- **USD invoices:** the GST invoice engine is per currency (`packages/services/src/gst/invoice-engine.service.ts:58`) and converts through `getRbiReferenceRate`, whose live fetcher returns `null` (`packages/services/src/gst/rbi-fx.ts:73-79`, MONEY-217) — so a USD invoice needs an ops env override (`GST_FX_RATE_USD_<date>`) until MONEY-217 lands. Engine-gated; say so in the PR.

## Read first (verified paths)

- `packages/core/src/market-data/us-market-access.ts`, `packages/core/__tests__/market-data/us-market-access-wired.test.ts`, `packages/core/__tests__/market-data/us-market-access.test.ts`
- `packages/core/src/subscription/{plans,features}.ts`, `packages/core/src/payments/plan-config.ts`
- `packages/services/src/product-sync{.service,-logic}.ts`, `apps/web/lib/actions/subscription.ts:695-1240`
- `packages/core/src/gemini/model-registry.ts` (`requiresPlan` pattern), `apps/api/src/lib/premium-gate.ts`
- `apps/web/app/settings/tabs/PlansTab.tsx`, `apps/web/app/(marketing)/pricing/client.tsx` (existing plan copy + Dodo checkout wiring)
- `docs/gstack/ceo-review-2026-09-23-product-roadmap/product-plan-and-roadmap.md` rows DS-IA2, DS-UNRES1, OV-5 (D25), DS-ST3 `/upgrade + checkout` row
- `docs/design/v2-bundle/app/s-account.jsx` (`PlanScreenV2`)

## Build — in this order

### 1. The rule (pure, in core) — `packages/core/src/market-data/us-market-access.ts`

```ts
export type UsMarketMode = "off" | "allowlist" | "entitled";
/** The shipped mode. Widening it is a reviewed CODE diff (MONEY-1563), exactly like the allowlist. */
export const US_MARKET_MODE_SHIPPED: UsMarketMode = "allowlist";
export const US_MARKET_REQUIRES_PLAN = "PRO" as const; // one-field edit to narrow to PREMIUM

/** Env may only NARROW: "off" forces off; any other value is ignored. Literal compare, read per call. */
export function resolveUsMarketMode(
  env = process.env.US_MARKET_MODE,
): UsMarketMode;

export type UsAccessDecision =
  | { allowed: true; via: "allowlist" | "plan" }
  | { allowed: false; reason: "mode-off" | "not-listed" | "plan" | "unknown" };

export function mayUseUsMarket(a: {
  email: string | null | undefined;
  planId: string | null;
  mode: UsMarketMode;
}): UsAccessDecision;
```

- `off` → `mode-off` for everyone, founder included (a kill switch that exempts someone is not a kill switch).
- `allowlist` → today's behaviour; a non-listed user is `not-listed` (→ ABSENT, no upsell: US is not for sale yet).
- `entitled` → allowlisted OR `isPlanAtLeast(planId, US_MARKET_REQUIRES_PLAN)` → allowed; otherwise `plan` (→ GATED: the layer exists for this user, behind a price).
- Missing email or plan (`null`) → `unknown` (absent). Fail closed on every indeterminate input.
- `isUsMarketAllowed` stays as the allowlist half; `mayUseUsMarket` is the only function callers use (the P0-03 scan's "no direct `isUsMarketAllowed`" case already enforces it).

Decision-log note in the file header: why a code constant and not an env var — the licence boundary must move by reviewed diff (`00-shared-context.md` §3); the env can only turn it off.

### 2. Services

- `packages/services/src/us/access-status.service.ts`: load `email` + `getSubscription(userId)` (fail-closed: a failed plan read → `planId:null` → `unknown`), call `mayUseUsMarket`. `UsAccessStatus` gains `reason: "ok" | "plan" | "none"` and `requiredPlan: "PRO"`. Keep the determined-only cache (key includes nothing plan-specific, so **invalidate it on plan change**: call the existing entitlement invalidation hook — `packages/services/src/entitlement-invalidation.ts` — and clear this cache there).
- `packages/services/src/us/us-layer-logic.ts`: `UsLayerState = "on" | "gated" | "absent"`. `gated` iff licence refused with `reason:"plan"` AND the surface flag is on AND `us-upgrade` is on. Otherwise refused → `absent`. Data routes treat `gated` exactly like `absent` (no prices, same 200 shape) — only UI renders the difference.
- `packages/services/src/us/upgrade-offer-logic.ts` + `upgrade-offer.service.ts`:

```ts
export const UpgradeOfferInput = z
  .object({
    market: z.enum(["US", "IN"]).default("US"),
    country: z.string().length(2).nullable(),
  })
  .strict();
export interface UpgradeOffer {
  currency: "INR" | "USD";
  currencyReason: "ip-india" | "ip-abroad" | "ip-unknown" | "usd-unavailable";
  recommended: "PREMIUM";
  currentPlan: string; // from getSubscription
  plans: Array<{
    planId: "PRO" | "PREMIUM";
    name: string;
    monthly: number | null;
    annual: number | null;
    unlocksUs: boolean;
  }>;
}
export function pickPriceCurrency(
  country: string | null,
  usdAvailable: boolean,
): Pick<UpgradeOffer, "currency" | "currencyReason">;
// "IN" → INR/ip-india; known non-IN + usd rows exist → USD/ip-abroad; known non-IN, no usd rows → INR/usd-unavailable; null → INR/ip-unknown
```

Prices come ONLY from non-archived `DodoProduct` rows (the checkout's own source) for that currency — never a second price table. A missing row renders the price as absent (`null`), never a guess. `unlocksUs = isPlanAtLeast(planId, US_MARKET_REQUIRES_PLAN)`.

- **MONEY-917, USD on Dodo (money path):**
  - `buildProductQuery(planType, billingPeriod, currency = "INR")` adds `currency` — ship this FIRST, with a test that an INR lookup never returns a USD row.
  - `PRODUCT_PLAN_MAPPING`: add `usemoney_pro_monthly_usd`, `usemoney_pro_annual_usd`, `usemoney_premium_usd`, `usemoney_premium_annual_usd` (same plan/period as the INR names). The founder creates these four in Dodo test + live with the same names; list that in the PR as a founder step.
  - `getDodoProductInfo(planType, period, currency = "INR")`; `createCheckoutAction(planId, period, discountCode?, currency: "INR" | "USD" = "INR")`. Every INR literal on the checkout path that describes THIS payment (`subscription.ts:254`, `:521`, `:974`, `:1024` — re-read each) takes the chosen currency; the paise/cents ÷100 boundary at `product-sync.service.ts` holds for USD (Dodo uses the smallest unit for both).
  - The checkout currency is re-derived server-side from `pickPriceCurrency` (IP + product availability). A client-sent currency is IGNORED — otherwise an Indian user can buy the USD SKU.
  - USD fulfilment grants the same plan (plan grant is currency-blind). USD GST invoicing is engine-gated on MONEY-217 (see above) — do not touch the invoice engine here.

### 3. Server actions

- `apps/web/lib/actions/us-upgrade-offer.ts` — `getUpgradeOfferAction({market})`: `getAuthenticatedUser` → country from `headers().get("x-vercel-ip-country")` → `getUpgradeOffer(userId, {market, country})`. Signed-out → offer with `currentPlan:"FREE"` (the /upgrade page itself requires sign-in; see screens).
- `createCheckoutAction` stays in `apps/web/lib/actions/subscription.ts` (not a US surface); it gains the server-derived currency.

### 4. `/v1/us` routes + `US_SURFACES`

- `GET /v1/us/upgrade-offer?market=US` → same JSON; country from the request's `x-vercel-ip-country` header (apps/api runs on Vercel; if absent, `null`). Row `{surface:"upgrade-offer", flag:"us-upgrade", usAccess:"none", serviceExport:"getUpgradeOffer", serviceFile:"packages/services/src/us/upgrade-offer.service.ts", actionFile:"apps/web/lib/actions/us-upgrade-offer.ts", routeFile:"apps/api/src/routes/v1/us/upgrade-offer.ts", routePath:"/v1/us/upgrade-offer"}`. Mobile checkout is native IAP (design-v2 A02) — no `/v1` checkout here.
- `access-status` row unchanged; its JSON gains `reason`, `requiredPlan`.

### 5. UI

- `apps/web/components/design-v2/GateInline.tsx` (+ `gate-inline-logic.ts`): props `{ requiredPlan: "PRO" | "PREMIUM"; line: string; price: { amount: number; currency: "INR" | "USD"; period: "mo" } | null; ctaHref: string }`. Inline card, never a modal, no dismiss. Price absent → the line without a price, never "$0".
- `apps/web/app/upgrade/page.tsx` + `client.tsx`: server component reads `us-upgrade` via `usLayerForRequest`'s flag path; flag off → `redirect("/settings?tab=plans")` (today's surface). Signed-out → Clerk sign-in with `redirect_url=/upgrade?market=US`. Checkout button → `createCheckoutAction(planId, period, undefined)` (currency derived server-side).
- First GateInline mount (the only US surface that exists): `/stock/[symbol]` US branch (`page.tsx:185-215`). Layer `gated` → render the US page shell (symbol, name, exchange from `resolveInstrument`, no price, no chart) with GateInline in the price slot. `absent` → today's behaviour (India fallback / not-found). Later surfaces mount GateInline themselves.

## Screens

### S0.5 GateInline — 375px (in the stock-page price slot)

```
┌──────────────────────────────────────┐
│ ← AAPL · NASDAQ                   ☆  │
│ Apple Inc.                           │
│ ┌──────────────────────────────────┐ │
│ │ 🔒 PRO                           │ │
│ │ US markets are part of PRO       │ │
│ │ $9.99/mo · prices, charts, news  │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ See plans →                  │ │ │
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
│ ◷ End-of-day prices · not advice     │
└──────────────────────────────────────┘
```

(`$9.99` is illustrative: it is `offer.plans[PRO].monthly` or omitted.) 1280px: same card, max-width 560, inline in the right column; never a modal, no overlay.

### S0.4 /upgrade?market=US — 375px

```
┌──────────────────────────────────────┐
│ ←  Upgrade                           │
│ UNLOCK US MARKETS                    │
│ Pick a plan.                         │
│ [ Monthly | Annual ]                 │
│ ┌──────────────────────────────────┐ │
│ │ ★ RECOMMENDED                    │ │
│ │ Premium          $19.99/mo       │ │
│ │ ✓ US + India  ✓ more credits     │ │
│ │ ┌──────────────────────────────┐ │ │
│ │ │ Get Premium →                │ │ │
│ │ └──────────────────────────────┘ │ │
│ └──────────────────────────────────┘ │
│ ┌──────────────────────────────────┐ │
│ │ Pro              $9.99/mo        │ │
│ │ ✓ US + India     [ Get Pro ]     │ │
│ └──────────────────────────────────┘ │
│ Prices in USD (based on location).   │
│ You're on FREE.                      │
└──────────────────────────────────────┘
```

1280px: two plan cards side by side, max-width 880, Premium first with the hard shadow; toggle above. Recommended copy/credits come from `PLAN_CONFIG` (E5 single source), never hardcoded here.

### States

| State                   | GateInline (S0.5)                                       | /upgrade (S0.4)                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loading                 | card skeleton at final size                             | two card skeletons, toggle disabled                                                                                                                                                     |
| empty                   | n/a                                                     | no product rows for the currency → cards render without price + "Checkout unavailable right now", CTA disabled                                                                          |
| error                   | offer read failed → card without price, CTA still links | "Couldn't load plans · retry" inline                                                                                                                                                    |
| DataGap                 | n/a (no market data)                                    | `currencyReason:"usd-unavailable"` → "Prices in ₹ — USD billing isn't live yet"                                                                                                         |
| gated                   | this IS the gated state                                 | n/a                                                                                                                                                                                     |
| flag-off (`us-upgrade`) | absent (surface renders `absent` path)                  | redirect `/settings?tab=plans`                                                                                                                                                          |
| demo                    | absent (demo is `absent`)                               | redirect to sign-up (demo cannot buy)                                                                                                                                                   |
| checkout (DS-ST3)       | —                                                       | "Opening secure checkout…" · fail: "Your card wasn't charged. Try another method." [Retry] · pending: "Confirming with your bank… we'll email you" · success: "You're PRO, officially." |

### U1–U7

| User                  | GateInline                                                | /upgrade                                      |
| --------------------- | --------------------------------------------------------- | --------------------------------------------- |
| U1 India-only         | never sees a US surface → none                            | reachable only from India intents (unchanged) |
| U2 new, US-interested | FREE + mode `entitled` → shown; mode `allowlist` → absent | USD if abroad, ₹ in India                     |
| U3 existing India     | as U1 until they add US (P0-07)                           | unchanged                                     |
| U4 demo               | absent                                                    | → sign-up                                     |
| U5 FREE, flag on      | shown with real plan + price                              | full screen, Premium recommended              |
| U6 PRO/PREMIUM        | never (layer `on`)                                        | shows "You're on PRO"; Premium upgrade only   |
| U7 founder            | never (allowlist)                                         | normal                                        |

## Cross-surface access (§6)

1. Search — n/a: a gated user's search shows no US rows (P0-03). 2. Watchlist — n/a: gated users cannot add US rows. 3. Sage — n/a in Phase 0. 4. Home — the S0.7 card (P0-07) links here for FREE users. 5. Deep link — `/upgrade?market=US` round-trips through sign-in; not in the sitemap (auth-only). 6. API — `/v1/us/upgrade-offer` + `access-status.reason`. 7. Demo — redirect to sign-up; no fixture. 8. Telemetry — `us_gate_viewed {surface, requiredPlan, flag:"us-upgrade"}` on GateInline first render; `upgrade_viewed {market, currency, currencyReason}`; `upgrade_checkout_started {planId, period, currency}`.

## Tests

- `packages/core/__tests__/market-data/us-market-access.test.ts` — full `mayUseUsMarket` table (3 modes × allowlisted/not × FREE/PRO/PREMIUM/null); env `US_MARKET_MODE=entitled` does NOT widen from shipped `allowlist`; `off` blocks the founder.
- `packages/core/__tests__/market-data/us-market-access-wired.test.ts` — keep the cloudbuild guard; add: `US_MARKET_MODE_SHIPPED` equals `"allowlist"` (a widening must edit this test in the same diff — that is the review surface).
- `packages/services/__tests__/us/us-layer-logic.test.ts` — `gated` only when reason `plan` + surface flag + `us-upgrade`; otherwise `absent`.
- `packages/services/__tests__/us/upgrade-offer-logic.test.ts` — `pickPriceCurrency` four branches; missing product row → `null` price.
- `packages/services/__tests__/product-sync-currency.test.ts` — INR lookup with a USD row present returns the INR row (**mutation:** drop `currency` from `buildProductQuery` → red).
- `apps/web/__tests__/actions/checkout-currency.test.ts` — a client passing `currency:"USD"` with an `IN` IP gets INR.
- `apps/api/__tests__/routes/us-upgrade-offer-contract.test.ts` — envelope; header `x-vercel-ip-country: US` + USD rows → USD.
- `apps/web/__tests__/design-v2/gate-inline.test.tsx` — renders no `role="dialog"`, never "$0"/"₹0", link = `/upgrade?market=US`.
- Parity test (P0-01) picks up the new row automatically.

## Acceptance

- [ ] With `US_MARKET_MODE_SHIPPED="allowlist"` (shipped): behaviour identical to today for every user (the founder sees US; nobody else sees US or a gate).
- [ ] Locally with the constant set to `entitled`: a FREE test user with `us-stocks-listing` + `us-upgrade` on sees GateInline on `/stock/AAPL`; a PRO test user sees the page; the founder sees it on FREE. Screenshots U1/U2/U5, 375 + 1280, light + dark.
- [ ] INR checkout unchanged end to end in Dodo test mode; USD checkout succeeds in test mode once the four USD test products exist (founder step) — if they do not exist yet, the offer shows `usd-unavailable` and nothing breaks.
- [ ] `verify:push`; `/code-review ultra`; PR lists founder steps (create USD products; MONEY-1563 flips the constant).

## Out of scope / hand-offs

- Flipping `US_MARKET_MODE_SHIPPED` to `entitled` and widening the allowlist → **MONEY-1563** (founder, one reviewed diff).
- Repointing every "Go PRO" link to `/upgrade` and deleting `PageAccessModal` → design-review DT2 (not in this program's table).
- USD GST invoices → MONEY-217 (RBI fetcher).
- Mobile purchase → design-v2 A02 (native IAP).
