# Dodo Payments Integration Guide

## Overview

This document explains how to set up Dodo Payments products in the dashboard to enable full payment functionality.

## Current Setup

- **API Key**: Configured in `.env` as `DODO_PAYMENTS_API_KEY`
- **Mode**: Test Mode (change to `live_mode` in `/app/lib/payments/dodo.ts` for production)
- **Fallback**: If products aren't configured, the app uses a mock checkout page

---

## Step 1: Access Dodo Payments Dashboard

1. Go to [https://dashboard.dodopayments.com](https://dashboard.dodopayments.com)
2. Sign in with your account credentials
3. Make sure you're in **Test Mode** (toggle at the top right) for testing

---

## Step 2: Create Products

Navigate to **Products** → **Create Product** and create the following:

### Product 1: Pro Trader Plan

| Field            | Value                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| **Product ID**   | `tradebook_pro`                                                                                  |
| **Name**         | Pro Trader - Lifetime Access                                                                     |
| **Description**  | Full broker sync, auto-sync holdings, positions, tradebook, stock discovery, 10 AI queries/month |
| **Price**        | ₹999 INR                                                                                         |
| **Type**         | One-time payment                                                                                 |
| **Tax Category** | Digital Services / Software                                                                      |

### Product 2: AI Query Pack

| Field            | Value                                                                       |
| ---------------- | --------------------------------------------------------------------------- |
| **Product ID**   | `tradebook_ai_addon`                                                        |
| **Name**         | AI Query Pack                                                               |
| **Description**  | 150 additional fast AI queries for portfolio analysis and trade suggestions |
| **Price**        | ₹99 INR                                                                     |
| **Type**         | One-time payment                                                            |
| **Tax Category** | Digital Services / Software                                                 |

### Product 3: AI Unlimited (Coming Soon)

| Field            | Value                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| **Product ID**   | `tradebook_ai_unlimited`                                                         |
| **Name**         | AI Unlimited - Monthly                                                           |
| **Description**  | 250 fast queries/month + unlimited slow queries, AI strategies, learning modules |
| **Price**        | ₹999 INR/month                                                                   |
| **Type**         | Subscription (Monthly)                                                           |
| **Tax Category** | Digital Services / Software                                                      |

### Product 4: AI Unlimited Annual

| Field            | Value                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| **Product ID**   | `tradebook_ai_unlimited_annual`                                                                |
| **Name**         | AI Unlimited - Annual                                                                          |
| **Description**  | 250 fast queries/month + unlimited slow queries, AI strategies, learning modules (17% savings) |
| **Price**        | ₹10,000 INR/year                                                                               |
| **Type**         | Subscription (Annual)                                                                          |
| **Tax Category** | Digital Services / Software                                                                    |

---

## Step 3: Configure Webhooks (per mode)

Dodo webhooks are configured **per mode** (Test / Live toggle, bottom-left of
the dashboard) and every event is delivered to **ALL endpoints registered in
that mode**. Each endpoint has its **own signing secret**.

Our deployment topology (two Vercel projects):

| Dodo mode | Endpoint URL                               | Serves                                         | Secret goes to                        |
| --------- | ------------------------------------------ | ---------------------------------------------- | ------------------------------------- |
| Test      | `https://qa.usemoney.ai/api/webhooks/dodo` | QA (Vercel project tracking `main`)            | QA project `DODO_WEBHOOK_SECRET`      |
| Test      | `https://play.svix.com/in/…` _(optional)_  | Delivery **inspector** for local/dev debugging | — (it is a sink; it forwards nothing) |
| Live      | `https://usemoney.ai/api/webhooks/dodo`    | Prod (Vercel project tracking `release`)       | Prod project `DODO_WEBHOOK_SECRET`    |

> ⚠️ The Svix Play URL only lets you _watch_ deliveries — it does not forward
> them to QA. The app endpoint must be registered as its own endpoint or QA
> receives nothing.

1. Toggle the mode → **Developer** → **Webhooks** → **Add Endpoint**
2. **URL**: the app endpoint from the table (the route is
   `app/api/webhooks/dodo/route.ts` — there is **no** `/api/payments/webhook`)
3. **Subscribed events** — at minimum:
   `payment.succeeded`, `payment.failed`, `subscription.active`,
   `subscription.renewed`, `subscription.on_hold`, `subscription.failed`,
   `subscription.expired`, `subscription.cancelled`, `refund.succeeded`
   (the envelope is `{ business_id, type, timestamp, data }` — the
   discriminator is `type`; there is no `payment.completed` in the spec)
4. Open the new endpoint → copy its **Signing Secret** (`whsec_…`) →
   set `DODO_WEBHOOK_SECRET` in the matching Vercel project → redeploy
5. Verify in the endpoint's **Logs**: deliveries return 200 and the app logs
   `[DODO WEBHOOK] Verified event`
6. **Backfill missed events** (endpoint added late): use the endpoint's
   **Replay** to re-deliver history — the `appliedAt` one-shot claim makes
   replays idempotent, and a paid-but-never-granted payment (claim untaken)
   is fulfilled by the replay.

Local dev: Dodo cannot reach `localhost` — inspect deliveries via the Svix
Play endpoint, or use the Dodo CLI test-mode listener to forward to a local
port.

---

## Step 4: Webhook Verification (already implemented)

Signature verification lives in `app/api/webhooks/dodo/route.ts` and uses the
`svix` library (Standard Webhooks): the `webhook-id` / `webhook-timestamp` /
`webhook-signature` headers are verified against `DODO_WEBHOOK_SECRET` before
any processing. Do **not** hand-roll HMAC verification for this route.

---

## Step 5: Switch to Live Mode

When ready for production:

1. In Dodo Dashboard, switch to **Live Mode**
2. Re-create all products in Live Mode
3. Get new **Live API Key** from Developer settings
4. Update `.env`:
   ```
   DODO_PAYMENTS_API_KEY=your_live_api_key
   ```
5. Update `/app/lib/payments/dodo.ts`:
   ```typescript
   environment: "live_mode";
   ```
6. Update webhook URL to production domain
7. Test with a real payment (use a small amount first)

---

## Step 6: Test the Integration

### Test Mode Testing

1. Go to `/pricing` page
2. Click "Upgrade Now" on Pro Trader
3. You'll be redirected to Dodo checkout
4. Use test card: `4242 4242 4242 4242` (any future date, any CVC)
5. Complete payment
6. Verify redirect to `/settings?tab=subscription&success=payment_complete`
7. Check that subscription is updated in database

### Verify in Dashboard

1. Go to Dodo Dashboard → Payments
2. You should see the test payment listed
3. Check payment status and metadata

---

## Troubleshooting

### Payment not showing in dashboard

- Verify API key is correct
- Check that products are created with correct IDs
- Look at server logs for errors

### Webhook not receiving events

- Verify webhook URL is publicly accessible
- Check webhook secret is correct
- Ensure HTTPS is configured properly

### Checkout redirect failing

- Check `NEXT_PUBLIC_BASE_URL` is set correctly
- Verify return URL is whitelisted in Dodo settings

---

## API Reference

### Create Payment Endpoint

```
POST /api/payments/create-checkout
Body: { "planId": "PRO" | "AI_ADDON" | "AI_UNLIMITED" }
Response: { "success": true, "checkoutUrl": "https://...", "paymentId": "..." }
```

### Payment Callback

```
GET /api/payments/callback?paymentId=xxx&planId=xxx
Redirects to /settings on success or /pricing on failure
```

### Webhook Events

```
POST /api/payments/webhook
Events: payment.completed, payment.failed, subscription.cancelled, subscription.renewed
```

---

## Files Modified for Integration

- `/app/lib/payments/dodo.ts` - Dodo client configuration
- `/app/app/api/payments/create-checkout/route.ts` - Creates checkout sessions
- `/app/app/api/payments/callback/route.ts` - Handles payment callbacks
- `/app/app/api/payments/webhook/route.ts` - Processes webhooks
- `/app/lib/actions/subscription.ts` - Subscription management
