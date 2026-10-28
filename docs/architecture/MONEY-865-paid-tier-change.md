# MONEY-865 — Paid tier-change fix (Issue #4: duplicate Dodo subscription / "could not start checkout")

> **Status: DESIGN — review before any code. Touches live billing.**

## 1. Symptom

Scenario (founder QA): 100%-coupon → PRO monthly (free grant) → 20%-coupon → PRO
annual (paid, Dodo sub created) → click **Upgrade to Premium** → _"We could not
start checkout. Please try again in a moment."_

The user's DB row at that point is clean: `PRO / annual / ACTIVE /
dodoSubscriptionId SET / scheduledPlanId null`. So the **upgrade itself fails**,
not a corrupt state.

## 2. Root cause — an asymmetry in how plan changes reach Dodo

| Transition                               | Path today                                           | Dodo call                                                               |
| ---------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| **Upgrade** (FREE/PRO → PRO/PREMIUM)     | `createCheckoutAction` → `createDodoCheckout`        | `subscriptions.create` — a **NEW** subscription                         |
| **Downgrade** (PRO/PREMIUM → lower/FREE) | `scheduleDowngradeAction` → `scheduledPlanId` → cron | `subscriptions.changePlan` (`full_immediately`) on the **existing** sub |
| **Cancel** (→ FREE)                      | `scheduleCancelAction` / cron                        | `subscriptions.update({ cancel_at_next_billing_date })`                 |

On upgrade, fulfillment (`callback/route.ts:470-486`, `webhooks/dodo:581-597`)
reads `previousDodoSubId = existingSub.dodoSubscriptionId` and sets the **old**
sub to `cancel_at_next_billing_date: true` — i.e. the intended design is
**create-new-then-cancel-old + bonus-days proration**.

That works when there is **no** existing paid Dodo subscription (FREE → paid,
coupon-grant → paid). It breaks when an **active paid Dodo subscription already
exists**, because `subscriptions.create` is asked to open a **second** active
subscription for the same customer:

- If Dodo rejects a concurrent subscription for the customer → the `create`
  throws → sanitized to "could not start checkout" (**the reported failure**).
- If Dodo allows it → there is a window with **two active subscriptions** until
  the old one's next billing date (overlap / double-charge risk).

The downgrade path already does the right thing (`changePlan` on the existing
sub). The upgrade path should too.

## 3. Key enabling fact

`dodoClient.subscriptions.changePlan(subId, { product_id, proration_billing_mode, quantity })`
supports three proration modes (per the cron's own comment, route.ts:138-146):

- `full_immediately` — charge the full new price now (used by the downgrade cron at term-end).
- `difference` / `prorated` — **mid-cycle** change: charge only the delta now.

So a mid-cycle **upgrade** is natively expressible as `changePlan` with
`prorated`/`difference` — no second subscription, no checkout page.

## 4. Proposed design — one seam, route by existing-sub state

Introduce `resolvePaidPlanChange({ userId, targetPlan, targetCycle, coupon? })`:

```
load Subscription (+ dodoSubscriptionId, status)

if NO active Dodo subscription            // FREE, coupon-grant, lapsed
    → KEEP today's create-new path (subscriptions.create + Dodo checkout page)   [UNCHANGED]

else (active Dodo subscription exists)
    if UPGRADE (target tier/price > current)
        → subscriptions.changePlan(dodoSubId, {
              product_id: target,
              proration_billing_mode: "prorated"  // or "difference" — verify
          })                                       // Dodo charges the delta on the saved card
    if DOWNGRADE
        → keep existing schedule-at-term-end path (scheduledPlanId)              [UNCHANGED]
    clear any pending scheduledPlanId on an upgrade
    local Subscription row is updated by the resulting webhook (idempotent)
```

Net: the `create`-a-second-subscription case **disappears** for users who already
have a paid Dodo subscription.

## 5. UX change (important)

Upgrades **from a paid sub** would no longer redirect to a Dodo checkout page —
`changePlan` charges the **saved** card immediately. Replace the redirect with an
in-app confirm: _"Upgrade now — ₹X prorated will be charged to your card on file;
your plan changes immediately."_ This is better UX (instant, no card re-entry)
but is a **different flow** than today's redirect, so the PlansTab upgrade
handler needs branching: paid→paid = changePlan confirm; free/grant→paid =
checkout redirect.

## 6. Edge cases to resolve

1. **Coupon on a paid→paid upgrade.** Does `changePlan` accept a `discount_code`?
   If not, a coupon can only apply on the checkout-page path (free→paid). Options:
   (a) disallow coupons on paid→paid upgrades, or (b) apply the discount as a
   one-time credit/adjustment. **Verify Dodo support first.**
2. **Cross-cycle upgrade** (PRO annual → PREMIUM monthly): `changePlan` to the
   PREMIUM-monthly product mid-term. Verify Dodo's proration across a cycle change.
3. **Coupon-grant (no dodoSubId) → paid**: routes to create-new (correct, unchanged).
4. **Bonus-days proration double-count**: today's flow credits "bonus days" for
   the unused old term (`lib/billing/proration.ts`). Dodo's `prorated` mode
   already credits the unused value. **Do NOT do both.** Recommend: trust Dodo's
   proration for paid→paid changePlan; keep our bonus-days only for the
   create-new path.
5. **Pending scheduled downgrade then upgrade**: clear `scheduledPlanId` /
   `scheduledEffectiveAt` as part of the upgrade.
6. **Webhook fulfillment of a changePlan**: confirm the webhook updates the local
   row + resets/extends credits on the plan-change event (it currently handles
   `subscription.active` / `subscription.renewed`). A changePlan may emit a
   different event — must be fulfilled idempotently.
7. **Failure atomicity**: never mutate the local Subscription row until Dodo
   confirms the change (today's idempotent `claimPaymentFulfillment` pattern).

## 7. Verification needed in a Dodo **sandbox** (no sandbox in this repo)

- `changePlan` with `prorated`/`difference`: does it charge the saved card
  immediately + return synchronously, and what webhook event fires?
- Does `changePlan` accept a `discount_code`?
- Cross-cycle (annual → monthly) behaviour + proration.
- Customer-with-active-subscription: confirm `subscriptions.create` really is
  what Dodo rejects (the assumed root cause) — capture the actual Dodo error.

## 8. Rejected alternative — cancel-old-immediately + create-new

Cancel the old sub up front, then create the new. Rejected: a coverage gap
between cancel and create; loses the old term's paid value (needs manual
bonus-days); **non-transactional** — if the `create` fails after the cancel, the
user is stranded with no plan. `changePlan` is Dodo-native, atomic, and already
proven on the downgrade path.

## 9. Scope / rollout

- New seam `resolvePaidPlanChange`; the create-new path is retained verbatim for
  no-Dodo-sub users (lowest risk).
- Gate behind Dodo `test_mode` on QA; capture the real Dodo error for Issue #4
  first to confirm the assumed cause before shipping.
- Independent of the already-committed coupon fixes on `test/MONEY-865`.

## 10. Open decision for review

- **A (recommended):** unify on `changePlan` for paid→paid (this doc).
- **Coupon-on-paid-upgrade:** allow (needs Dodo discount-on-changePlan) vs
  disallow (simplest) — pick after sandbox verification.
