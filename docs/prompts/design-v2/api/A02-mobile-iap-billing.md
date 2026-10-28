# A02 · Native in-app purchases (StoreKit 2 + Google Play Billing) → the existing Subscription/credits ledger

Read `docs/prompts/design-v2/00-shared-context.md` — it is part of this prompt. Decision (Shaswat, 12-Sep-2026): **native IAP on mobile** (not the in-app UPI checkout shown in the mockup, not a web deep-link). Web billing stays Dodo Payments. This prompt is the **server side**; the client side is M19.

**Ticket:** `MONEY-{n}` "Mobile IAP — receipts, entitlements, reconciliation" → `feat/MONEY-{n}`.
**Design sources:** `docs/design/v2-bundle/app/s-account.jsx` `PlanScreenV2` (plan list with Monthly / "-20% Yearly" cycle, feature bullets, "most picked", CURRENT PLAN, success screen "You're PRO, officially. {credits} credits landed. Receipt's in your email."; footer "CREDITS POWER DEEP RESEARCH (1-3), ANALYST BOARDS (SOON) AND BACKTESTS (SOON). CHAT, SYNC & PORTFOLIO ARE FREE FOREVER.") — the UPI/checkout screen is **replaced** by the platform purchase sheet; `app/data.js` `PLANS` (names/prices as displayed today: Free · PRO ₹249/mo · Premium … — verify against `packages/core/src/subscription/plans.ts`, never hardcode).

## Read first
- `packages/core/src/subscription/plans.ts` (plan ids, prices, credits, `CREDIT_COSTS`), `packages/services/src/{subscription,subscription-logic,subscription-management,payment-provisioning,payment-grant,subscription-grants,credit,scheduled-plan-changes,entitlement-invalidation}.service.ts` (the Dodo grant path: `grantWebhookSubscription`, `applyPlanGrant`, claim/release fulfillment locks — **reuse the same grant functions**), Prisma `Subscription`, `Payment` (`dodoPaymentId` unique — add a provider discriminator), `PlanType`, `Coupon*`
- `apps/web/app/api/webhooks/{dodo,dodopayments}/route.ts` (idempotency + signature patterns), `apps/api/src/routes/v1/subscription.ts` (`GET /`, `/access`, `/ai-credits`, cancel/downgrade/schedule endpoints), `apps/web/app/api/cron/apply-scheduled-plan-changes`
- GST: `packages/services/src/gst/*` (invoices are issued for Dodo payments — decide with the GST rules whether store purchases need a GST invoice; Apple/Google are the merchant of record — document the decision in `docs/gst/`)
- Apple: App Store Server API v2 + App Store Server Notifications V2 (JWS-signed), StoreKit 2 transactions (`signedTransactionInfo`), sandbox vs production; Google: Play Developer API `purchases.subscriptionsv2`, Real-time developer notifications (Pub/Sub), acknowledgement within 3 days, India alternative billing not required when using Play Billing.

## Build
1. **Products:** map plan ids → store products: `PRO` monthly/yearly, `PREMIUM` monthly/yearly, `ULTIMATE` monthly/yearly, `QUERY_PACK` (consumable) — product ids in `packages/core/src/subscription/store-products.ts` (single source; tested mapping both ways). Prices are set in the stores (₹ tiers), never in code.
2. **Endpoints (`/v1/subscription` sub-paths):** `GET /store/products` (product ids + plan mapping for the client), `POST /store/apple/transactions` (client sends the JWS `signedTransactionInfo` after purchase/restore → server verifies with App Store Server API, maps to plan, grants via `applyPlanGrant` under the fulfillment claim lock; idempotent on `originalTransactionId`), `POST /store/google/purchases` (client sends `purchaseToken` → verify via Play Developer API, acknowledge, grant; idempotent on `orderId`/token), `POST /store/restore` (re-sync entitlements from the store for the signed-in user), `GET /store/status` (current source of entitlement: `DODO|APPLE|GOOGLE|NONE`, renewal date, manage URL).
3. **Webhooks:** `apps/api` routes (no Clerk auth; signature-verified): `POST /webhooks/apple` (App Store Server Notifications V2: DID_RENEW, DID_FAIL_TO_RENEW, EXPIRED, REFUND, DID_CHANGE_RENEWAL_STATUS, GRACE_PERIOD…), `POST /webhooks/google` (RTDN via Pub/Sub push: SUBSCRIPTION_RENEWED/CANCELED/ON_HOLD/IN_GRACE_PERIOD/EXPIRED/REVOKED) → the same provisioning functions (`provisionSubscriptionRenewed`, `provisionSubscriptionCancelled`, `provisionRefundSucceeded` equivalents) with a `provider` field; idempotent by notification id; dead-letter on failure.
4. **Entitlement rules:** one active paid source per user — if a Dodo subscription is active and a store purchase arrives, apply the higher tier and schedule the other to end (log + email); cancellations from the store flow into `Subscription.status`/`endDate` exactly like Dodo; credits reset on renewal via the existing credit reset logic; refunds revoke per the existing refund path.
5. **Client contract for M19:** `GET /store/products` shape; purchase → POST transaction → response `{ plan, credits, renewsAt }`; error codes `RECEIPT_INVALID`, `ALREADY_APPLIED`, `ENVIRONMENT_MISMATCH` (sandbox receipt on prod), `PLAN_CONFLICT`.
6. **Reconciliation job:** nightly worker `store-entitlement-reconcile` re-checks active store subscriptions (Apple `Get All Subscription Statuses`, Google `subscriptionsv2.get`) and fixes drift; metrics to Datadog.
7. **Compliance notes in `docs/reference/mobile-billing.md`:** Apple 3.1.1 (no external purchase links for digital goods in-app), Google Play billing policy, India alternative billing option (not used), tax/GST stance, refund policy text for store listings, "Manage subscription" deep links (`https://apps.apple.com/account/subscriptions`, `https://play.google.com/store/account/subscriptions`).

## Non-goals
Web checkout changes, consumable credit packs beyond `QUERY_PACK`, promotional offers/intro pricing (v2), family sharing.

## Acceptance
- Sandbox purchase on iOS and a test purchase on Android each result in the correct `Subscription.planId`, credits and `Payment` row with `provider` set; replaying the same transaction is a no-op (idempotency tests).
- Webhook signature verification tested with valid/invalid fixtures; renewal/expiry/refund notifications move `Subscription` through the same states as Dodo does (state-table test).
- `PLAN_CONFLICT` path tested (Dodo active + store purchase).
- Reconciliation corrects an injected drift fixture.
- TEST-COVERAGE.md; `verify:push`; `/code-review ultra` (billing).
