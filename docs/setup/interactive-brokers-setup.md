# Interactive Brokers (IBKR) Integration Setup

## Overview

Interactive Brokers integration uses the IBKR Client Portal Web API with OAuth
2.0 authentication. This enables access to holdings, positions, orders, and
trade executions across 150+ global markets.

---

## 1. Register an IBKR App

1. Log in to your Interactive Brokers account at
   [https://www.interactivebrokers.com](https://www.interactivebrokers.com)
2. Navigate to **Settings > API > OAuth Applications** (or visit the
   [IBKR API Portal](https://www.interactivebrokers.com/en/trading/api-access.php))
3. Click **Create New Application**
4. Fill in the application details:
   - **App Name:** UseMoney
   - **App Type:** Web Application
   - **Redirect URI:**
     `https://usemoney.ai/api/brokers/interactive-brokers/callback` (production)
     or `http://localhost:3000/api/brokers/interactive-brokers/callback`
     (development)
   - **Scopes:** `trading` (covers portfolio, orders, trades)
5. Note down the **Client ID** and **Client Secret**

---

## 2. Required OAuth Scopes

| Scope     | Description                                        |
| --------- | -------------------------------------------------- |
| `trading` | Access to portfolio, positions, orders, and trades |

The `trading` scope provides access to all portfolio and trading data. IBKR's
OAuth implementation uses a single broad scope rather than granular permissions.

---

## 3. Environment Variables

Add the following to your `.env` file (or environment configuration):

```bash
# Interactive Brokers OAuth
INTERACTIVE_BROKERS_CLIENT_ID=your_client_id_here
INTERACTIVE_BROKERS_CLIENT_SECRET=your_client_secret_here
INTERACTIVE_BROKERS_REDIRECT_URI=http://localhost:3000/api/brokers/interactive-brokers/callback
```

### Production (Vercel)

Set these in your Vercel project settings under **Environment Variables**:

```
INTERACTIVE_BROKERS_CLIENT_ID=your_production_client_id
INTERACTIVE_BROKERS_CLIENT_SECRET=your_production_client_secret
INTERACTIVE_BROKERS_REDIRECT_URI=https://usemoney.ai/api/brokers/interactive-brokers/callback
```

---

## 4. Local Development Setup

### Option A: Client Portal Gateway (Recommended for Local Dev)

For local development without OAuth, you can use the IBKR Client Portal Gateway:

1. Download the Client Portal Gateway from
   [IBKR's API docs](https://www.interactivebrokers.com/api/doc.html#tag/Getting-Started)
2. Run the gateway locally:
   ```bash
   cd clientportal.gw
   bin/run.sh root/conf.yaml
   ```
3. Authenticate via the gateway's web interface at `https://localhost:5000`
4. The gateway proxies API requests to IBKR's servers

### Option B: OAuth Flow (Standard)

1. Set the environment variables with your IBKR app credentials
2. Start the Next.js dev server: `yarn dev`
3. Navigate to `/brokers` and click "Connect Interactive Brokers"
4. You'll be redirected to IBKR's OAuth consent page
5. After authorization, you'll be redirected back to the callback URL

### Mock Data Mode

If `INTERACTIVE_BROKERS_CLIENT_ID` or `INTERACTIVE_BROKERS_CLIENT_SECRET` are
not set, the adapter automatically falls back to mock data. This allows
development without an IBKR account.

---

## 5. Production Deployment Notes

### Token Lifecycle

| Property             | Value                                       |
| -------------------- | ------------------------------------------- |
| **Access Token**     | Valid for 24 hours                          |
| **Refresh Token**    | Used to obtain new access tokens            |
| **Refresh Strategy** | `on_expiry` - tokens refreshed when expired |

### Token Refresh Flow

1. User authenticates via OAuth and receives an access token + refresh token
2. Access token is stored encrypted (AES-256-GCM) in the database
3. When the token expires (24h), the system uses the refresh token to obtain a
   new access token
4. If refresh fails, the user is prompted to re-authenticate

### Multi-Currency Support

IBKR accounts may hold positions in multiple currencies (USD, EUR, GBP, INR,
etc.). The adapter:

- Returns raw currency values from IBKR
- Does not perform currency conversion (this is handled at the display layer)
- Maps exchange codes to normalized names (NASDAQ, NYSE, NSE, BSE, etc.)

### Rate Limits

IBKR's Client Portal API has the following rate limits:

- **General:** 10 requests per second
- **Market Data:** 1 request per second per instrument
- **Order Submission:** 50 orders per second

The adapter does not implement rate limiting internally. For high-frequency sync
operations, consider adding a rate limiter.

### Multi-Account Support

IBKR users may have multiple sub-accounts. The current implementation uses the
**first account** returned by `/portfolio/accounts`. To support multi-account:

1. List all accounts via `getProfile()`
2. Allow users to select which account to sync
3. Store the selected `accountId` in `brokerMetadata`

---

## 6. API Endpoints Used

| Endpoint                             | Method | Description             |
| ------------------------------------ | ------ | ----------------------- |
| `/portfolio/accounts`                | GET    | List portfolio accounts |
| `/portfolio/{accountId}/positions/0` | GET    | Get positions/holdings  |
| `/portfolio/{accountId}/summary`     | GET    | Account summary/margins |
| `/iserver/account/orders`            | GET    | Get orders              |
| `/iserver/account/trades`            | GET    | Get trade executions    |
| `/oauth/token`                       | POST   | Exchange/refresh tokens |

---

## 7. Troubleshooting

### "No IBKR accounts found"

- Ensure the OAuth token has the `trading` scope
- Verify the IBKR account has at least one funded sub-account
- Check if the account is a paper trading account (these work too)

### Token refresh fails

- IBKR refresh tokens may be invalidated if the user changes their password
- Ask the user to re-authenticate via the OAuth flow

### Exchange code mapping

- IBKR uses `SMART` routing by default, which is mapped to `NSE` as the primary
  exchange
- If positions appear on unexpected exchanges, check the `listingExchange` field
  in the raw API response

---

_Last Updated: March 2026_
