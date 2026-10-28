# Broker Integration Setup Guide

Step-by-step instructions for setting up each broker's API integration on the
UseMoney platform. Covers credential registration, environment variables, and
testing.

> **Status**: Zerodha is live. Upstox, Fyers, Angel One, and Groww are active.
> Dhan is coded but Coming Soon (pending partner login integration). ICICI
> Direct and HDFC Securities need code changes before activation.

---

## Quick Reference

| Broker          | Auth Method                                | Token Lifetime                    | API Cost                         | Status          |
| --------------- | ------------------------------------------ | --------------------------------- | -------------------------------- | --------------- |
| Zerodha         | OAuth2 redirect                            | Until midnight                    | Free (Kite Connect subscription) | **Live**        |
| Upstox          | OAuth2 redirect                            | 1 year                            | Free                             | **Active**      |
| Fyers           | OAuth2 redirect                            | 1 day (15-day refresh, needs PIN) | Free                             | **Active**      |
| Angel One       | Publisher Login redirect                   | Auto-renewing                     | Free                             | **Active**      |
| Groww           | API Key + SHA256/TOTP (dialog)             | 1 day (6AM IST)                   | ₹499+/month                      | **Active**      |
| Dhan            | API Key (dialog) → Partner Login (planned) | 30 days                           | Free                             | **Coming Soon** |
| ICICI Direct    | OAuth2 redirect                            | Until midnight                    | ₹1000/year                       | **Needs code**  |
| HDFC Securities | OAuth2 redirect                            | Until midnight                    | ₹999/year                        | **Needs code**  |

### Auth flow types

| Flow                                | User experience                                                               | Brokers                                     |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| **OAuth2/Publisher Login redirect** | Click Connect → log in on broker's page → redirected back automatically       | Zerodha, Upstox, Fyers, Angel One           |
| **API Key dialog**                  | Click Connect → enter credentials in a dialog → platform validates and stores | Groww, Dhan                                 |
| **Partner Login (planned)**         | Same as redirect - requires partner registration with broker                  | Dhan (apply at dhan.co/authorised-partner/) |

---

## 1. Zerodha (Kite Connect)

**Portal**: https://kite.trade  
**Docs**: https://kite.trade/docs/connect/v3/

### Setup Steps

1. Log in to https://kite.trade with your Zerodha credentials
2. Create a new app (or use existing)
3. Set **Redirect URL**: `https://usemoney.ai/api/brokers/zerodha/callback`
4. Note the **API Key** and **API Secret**
5. Subscribe to "Kite Connect" (free for personal use)
6. For Historical API (chart data): subscribe to "Historical Data" add-on

### Environment Variables

```bash
ZERODHA_API_KEY=<your-api-key>
ZERODHA_API_SECRET=<your-api-secret>
```

### Testing

1. Navigate to `/brokers` → Click "Connect" on Zerodha
2. Complete OAuth login on Kite
3. Verify redirect back to `/brokers?success=connected`
4. Check holdings sync in `/holdings`

### Notes

- Token expires at midnight IST daily - user must reconnect next day
- Only broker with MF API support (getMFHoldings endpoint)
- Historical API subscription needed for TradingView chart data
- WebSocket client exists at `apps/web/lib/brokers/ws/zerodha-ws.ts`

---

## 2. Upstox

**Portal**: https://account.upstox.com/developer/apps  
**Docs**: https://upstox.com/developer/api-documentation/

### Setup Steps

1. Log in to Upstox Developer Portal
2. Create a new app ("usemoney-production")
3. Set **Redirect URL**: `https://usemoney.ai/api/brokers/upstox/callback`
4. Note the **API Key** and **API Secret**
5. No additional subscription required - API is free

### Environment Variables

```bash
UPSTOX_API_KEY=<your-api-key>
UPSTOX_API_SECRET=<your-api-secret>
UPSTOX_REDIRECT_URI=https://usemoney.ai/api/brokers/upstox/callback
```

### Testing

1. Navigate to `/brokers` → Click "Connect" on Upstox
2. Complete OAuth login
3. Verify holdings, positions, trades sync

### Notes

- **Best "set and forget" broker** - extended token lasts 1 year
- Token exchange requires `application/x-www-form-urlencoded` (not JSON)
- No MF API - mutual fund data not available through Upstox
- `price` field in trades is often 0; use `average_price` as execution price
- Exchange field doubles as segment: `NSE_EQ` = cash, `NSE_FO` = F&O

---

## 3. Fyers

**Portal**: https://myapi.fyers.in/dashboard  
**Docs**: https://myapi.fyers.in/docsv3

### Setup Steps

1. Log in to Fyers MyAPI Dashboard
2. Create a new app ("usemoney-prod")
3. Set **Redirect URL**: `https://usemoney.ai/api/brokers/fyers/callback`
4. Note the **App ID** and **Secret Key**

### Environment Variables

```bash
FYERS_APP_ID=<your-app-id>
FYERS_SECRET_KEY=<your-secret-key>
FYERS_REDIRECT_URI=https://usemoney.ai/api/brokers/fyers/callback
```

### Testing

1. Navigate to `/brokers` → Click "Connect" on Fyers
2. Complete OAuth login (HMAC SHA256 signing handled automatically)
3. Verify holdings, positions, trades sync

### Notes

- Auth header format: `Authorization: {APP_ID}:{access_token}` (not Bearer)
- Token exchange uses `appIdHash = SHA-256("{APP_ID}:{SECRET_KEY}")`
- Refresh token valid for 15 days but requires user's 4-digit Fyers PIN
- No MF API endpoint despite Fyers platform supporting MF
- Response format: `{ s: "ok", code: 200, data: [...] }`

---

## 4. Dhan

**Portal**: https://dhanhq.co/  
**Docs**: https://dhanhq.co/docs/v2/  
**Credential page**: https://web.dhan.co/profile/api-access  
**Status**: Coming Soon - pending partner login integration

### Current flow (API key dialog)

User manually generates Access Token from Dhan dashboard and enters it in a
dialog. Works but requires manual credential copy-paste every 30 days.

### Planned flow (Partner Login redirect)

Dhan offers a redirect-based Partner Login flow similar to OAuth:

1. Server calls `POST https://auth.dhan.co/partner/generate-consent` with
   `partner_id` + `partner_secret`
2. User redirected to `https://auth.dhan.co/consent-login?consentId=...`
3. User logs in with Dhan credentials + 2FA
4. Redirect back with `?tokenId=...`
5. Server calls `https://auth.dhan.co/partner/consume-consent?tokenId=...` to
   get `accessToken`

**To enable**: Apply for partner status at https://dhan.co/authorised-partner/
to get `partner_id` and `partner_secret`.

### Environment Variables

```bash
DHAN_CLIENT_ID=<your-client-id>
DHAN_ACCESS_TOKEN=<your-access-token>
# After partner approval:
# DHAN_PARTNER_ID=<partner-id>
# DHAN_PARTNER_SECRET=<partner-secret>
```

### Notes

- Current: API key auth, user enters Client ID + Access Token in dialog
- Token valid for 30 days, then user must regenerate from Dhan dashboard
- No MF support
- Base URL: `https://api.dhan.co/v2`

---

## 5. Angel One (SmartAPI)

**Portal**: https://smartapi.angelone.in/  
**Docs**: https://smartapi.angelone.in/docs  
**App management**: https://smartapi.angelone.in/publisher

### Setup Steps

1. Register on SmartAPI portal with your Angel One demat account
2. Create a new app:
   - App name: `usemoney-prod`
   - **Redirect URL**: `https://usemoney.ai/api/brokers/angel-one/callback`
   - Note the **API Key**
3. No TOTP setup needed - the Publisher Login flow handles auth on Angel One's
   page

### Environment Variables

```bash
ANGEL_API_KEY=<your-api-key>
```

### How it works

Angel One uses **Publisher Login** - a redirect-based flow similar to OAuth:

1. User clicks "Connect" → redirected to
   `https://smartapi.angelone.in/publisher-login?api_key={KEY}`
2. User logs in on Angel One's page with mobile number + OTP + 4-digit PIN
3. Angel One redirects back to
   `/api/brokers/angel-one/callback?auth_token={JWT}`
4. Platform stores the JWT token - no manual credential entry needed

### Testing

1. Navigate to `/brokers` → Click "Connect" on Angel One
2. Log in on Angel One's page (mobile + OTP + PIN)
3. Verify redirect back to `/brokers?success=connected`
4. Verify holdings, positions, trades sync

### Notes

- **Auto-renewing session** - token expires at midnight IST but platform
  silently refreshes via `generateTokens` API (no user action needed). Only
  broker with true auto-refresh.
- Requires custom headers on every API request: `X-UserType`, `X-SourceID`,
  `X-ClientLocalIP`, `X-ClientPublicIP`, `X-MACAddress`, `X-PrivateKey`
- No MF API endpoint in official SDKs (verified against Python/Node SDKs)
- HTTPS redirect URL required (no localhost, no HTTP)
- Base URL: `https://apiconnect.angelone.in`
- Fallback: TOTP connect route still available at
  `/api/brokers/angel-one/connect` if publisher login is unavailable

---

## 6. Groww (Trade API)

**Portal**: https://groww.in/trade-api/docs  
**Docs**: https://groww.in/trade-api/docs/curl  
**API Keys page**: https://groww.in/trade-api/api-keys

### Setup Steps

1. Subscribe to Groww Trade API (**₹499+tax/month**) via Groww dashboard
2. Go to https://groww.in/trade-api/api-keys → Generate **API Key** and **API
   Secret**
3. Optionally set up TOTP for faster authentication (avoids daily approval
   requirement)

### Environment Variables

```bash
GROWW_API_KEY=<your-api-key>
GROWW_API_SECRET=<your-api-secret>
```

### Testing

1. Navigate to `/brokers` → Click "Connect" on Groww
2. Enter API Key, API Secret, and optionally TOTP
3. Platform calls `POST /v1/token/api/access` with SHA256 checksum
4. Verify holdings, positions, orders sync

### Notes

- **NOT OAuth2** - uses API Key + SHA256(api_secret + epoch_seconds) checksum or
  TOTP
- Token expires daily at 6AM IST, no refresh mechanism
- Paid API: ₹499+tax/month subscription required from Groww
- No MF endpoints despite Groww being a major MF platform (Trade API covers
  CASH/FNO/COMMODITY only)
- No US Stocks endpoints in the API
- No standalone tradebook - trades fetched per-order via
  `GET /v1/order/trades/{order_id}`
- Base URL: `https://api.groww.in`
- Launched October 2025

---

## 7. ICICI Direct (Breeze API)

**Portal**: https://api.icicidirect.com  
**Docs**: https://api.icicidirect.com/breezeapi/

### Setup Steps

1. Subscribe to Breeze API (₹1000/year) on ICICI Direct
2. Create an app → Set redirect URL
3. Note the **API Key** and **API Secret**

### Environment Variables

```bash
ICICI_API_KEY=<your-api-key>
ICICI_API_SECRET=<your-api-secret>
ICICI_REDIRECT_URI=https://usemoney.ai/api/brokers/icici/callback
```

### Code Changes Required

> **Status**: Adapter and tests exist, but the OAuth callback route is
> **MISSING**.

- [ ] Create `apps/web/app/api/brokers/icici/callback/route.ts` (model on Upstox
      callback)
- [ ] Add `case "ICICI"` to `handleOAuthCallbackAction` in
      `broker-connection.ts`
- [ ] Test end-to-end with real credentials
- [ ] Flip `comingSoon: false` in broker cards

### Notes

- OAuth2 flow (Breeze API)
- Token expires at midnight IST
- Has MF support via API
- Base URL: `https://api.icicidirect.com/breezeapi/api/v1`

---

## 8. HDFC Securities

**Portal**: https://developer.hdfcsec.com  
**Docs**: https://developer.hdfcsec.com/docs

### Setup Steps

1. Subscribe to HDFC Securities API (₹999/year)
2. Create an app → Set redirect URL
3. Note the **API Key** and **API Secret**

### Environment Variables

```bash
HDFC_API_KEY=<your-api-key>
HDFC_API_SECRET=<your-api-secret>
HDFC_REDIRECT_URI=https://usemoney.ai/api/brokers/hdfc/callback
```

### Code Changes Required

> **Status**: Adapter and tests exist, but the OAuth callback route is
> **MISSING**.

- [ ] Create `apps/web/app/api/brokers/hdfc/callback/route.ts` (model on Upstox
      callback)
- [ ] Add `case "HDFC"` to `handleOAuthCallbackAction` in `broker-connection.ts`
- [ ] Test end-to-end with real credentials
- [ ] Flip `comingSoon: false` in broker cards

### Notes

- OAuth2 flow
- Token expires at midnight IST
- Has MF support via API
- Base URL: `https://developer.hdfcsec.com/oapi/v1`

---

## Vercel Environment Variables

After registering apps on each broker portal, add the variables to Vercel:

```bash
# Add for production
vercel env add UPSTOX_API_KEY production
vercel env add UPSTOX_API_SECRET production
# ... repeat for each broker

# Add for preview (for PR testing)
vercel env add UPSTOX_API_KEY preview
# ... etc
```

Or via the Vercel dashboard: Project Settings → Environment Variables.

## GCP Secret Manager (for Workers)

If background sync workers need broker credentials (system-level):

```bash
# Create secrets
gcloud secrets create UPSTOX_API_KEY_PROD --data-file=-
gcloud secrets create FYERS_APP_ID_PROD --data-file=-
# ... etc

# Update workers/cloudbuild.prod.yaml to mount secrets
```

## Testing Checklist (per broker)

- [ ] OAuth/connect flow completes without error
- [ ] Holdings sync returns real data (not mock)
- [ ] Positions sync works (if user has open positions)
- [ ] Trade history sync works
- [ ] Disconnect removes encrypted credentials
- [ ] Reconnect after disconnect works
- [ ] Token expiry handling: shows "Reconnect" banner when expired
- [ ] Multiple accounts of same broker work (different Client IDs)
- [ ] CSV tradebook import for this broker's format works
