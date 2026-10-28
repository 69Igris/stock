# Broker API Configuration Guide

## Overview

This document explains how to configure broker API keys for TradeBook Pro.

## Environment Variables Required

Add these variables to your `.env` file:

```env
# Encryption key for storing credentials (generate with: openssl rand -hex 32)
ENCRYPTION_KEY=your_64_char_hex_encryption_key

# ============= ZERODHA (Kite Connect) =============
# Get from: https://developers.kite.trade/apps
ZERODHA_API_KEY=your_kite_api_key
ZERODHA_API_SECRET=your_kite_api_secret
ZERODHA_REDIRECT_URI=https://your-domain.com/api/brokers/zerodha/callback

# ============= UPSTOX =============
# Get from: https://developer.upstox.com/
UPSTOX_API_KEY=your_upstox_api_key
UPSTOX_API_SECRET=your_upstox_api_secret
UPSTOX_REDIRECT_URI=https://your-domain.com/api/brokers/upstox/callback

# ============= FYERS =============
# Get from: https://myapi.fyers.in/dashboard/
FYERS_APP_ID=your_fyers_app_id
FYERS_SECRET_KEY=your_fyers_secret_key
FYERS_REDIRECT_URI=https://your-domain.com/api/brokers/fyers/callback

# ============= DHAN =============
# Get from: https://dhanhq.co/partner-api/
# Note: Dhan uses API key auth, users enter their own credentials
DHAN_CLIENT_ID=optional_default_client_id
DHAN_ACCESS_TOKEN=optional_default_token

# ============= ANGEL ONE (SmartAPI) =============
# Get from: https://smartapi.angelbroking.com/
ANGEL_API_KEY=your_angel_api_key
ANGEL_CLIENT_ID=your_angel_client_id

# ============= GROWW =============
# Get from: https://groww.in/developer
GROWW_API_KEY=your_groww_api_key
GROWW_API_SECRET=your_groww_api_secret

# ============= ICICI DIRECT (Breeze) =============
# Get from: https://api.icicidirect.com/
ICICI_API_KEY=your_icici_api_key
ICICI_API_SECRET=your_icici_api_secret
ICICI_REDIRECT_URI=https://your-domain.com/api/brokers/icici/callback

# ============= HDFC SECURITIES =============
# Get from: https://api.hdfcsec.com/
HDFC_API_KEY=your_hdfc_api_key
HDFC_API_SECRET=your_hdfc_api_secret
HDFC_REDIRECT_URI=https://your-domain.com/api/brokers/hdfc/callback
```

---

## Broker-Specific Setup Instructions

### 1. Zerodha (Kite Connect)

**Cost:** ₹500/month + ₹2000 one-time

**Steps:**

1. Go to [Kite Connect Developer Portal](https://developers.kite.trade/)
2. Create a new app
3. Set Redirect URL to: `https://your-domain.com/api/brokers/zerodha/callback`
4. Copy API Key and API Secret to `.env`
5. Submit for review and pay fees

**Token Info:**

- Tokens expire at 3:30 AM IST daily
- Users need to re-authenticate every day
- No auto-refresh supported

---

### 2. Upstox

**Cost:** FREE (for personal use)

**Steps:**

1. Go to [Upstox Developer Portal](https://developer.upstox.com/)
2. Create an app
3. Set Redirect URL to: `https://your-domain.com/api/brokers/upstox/callback`
4. Copy API Key and Secret to `.env`

**Token Info:**

- Tokens valid for 1 year
- Best choice for long-term access
- Refresh token available

---

### 3. Fyers

**Cost:** FREE

**Steps:**

1. Go to [Fyers API Dashboard](https://myapi.fyers.in/dashboard/)
2. Create an app
3. Set Redirect URL to: `https://your-domain.com/api/brokers/fyers/callback`
4. Copy App ID and Secret Key to `.env`

**Token Info:**

- Tokens expire daily (7:00 AM IST)
- Refresh token available for auto-renewal
- Good for automated systems

---

### 4. Dhan

**Cost:** FREE

**Steps:**

1. Users need to generate their own access token
2. Go to Dhan Web → Settings → API Access
3. Generate Access Token
4. Enter Client ID and Access Token in the app

**Token Info:**

- Tokens valid for 30 days
- Users self-manage credentials
- No OAuth flow needed

---

### 5. Angel One (SmartAPI)

**Cost:** FREE

**Steps:**

1. Go to [SmartAPI Dashboard](https://smartapi.angelbroking.com/)
2. Create an app
3. Get API Key and Client ID
4. Users need to authenticate with TOTP

**Token Info:**

- Tokens expire at end of day
- TOTP required for login
- Complex but comprehensive API

---

## Authentication Flow

### OAuth Flow (Zerodha, Upstox, Fyers, ICICI, HDFC)

1. User clicks "Connect" on broker
2. App redirects to broker's login page
3. User logs in and approves access
4. Broker redirects back with auth code
5. App exchanges code for access token
6. Token is encrypted and stored in database

### API Key Flow (Dhan, Angel One, Groww)

1. User generates credentials on broker's portal
2. User enters Client ID and Access Token in app
3. App validates credentials by making test API call
4. If valid, credentials are encrypted and stored

---

## Security

- All credentials encrypted with AES-256-GCM
- Encryption key stored in environment variable
- Tokens never exposed to frontend
- Read-only access (no trading)

---

## Token Refresh Schedule

| Broker    | Token Validity | Auto-Refresh |
| --------- | -------------- | ------------ |
| Zerodha   | Until 3:30 AM  | No           |
| Upstox    | 1 year         | Yes          |
| Fyers     | Daily          | Yes          |
| Dhan      | 30 days        | No           |
| Angel One | Daily          | No           |
| Groww     | 30 days        | No           |
| ICICI     | Daily          | No           |
| HDFC      | Daily          | No           |

---

## API Endpoints

### OAuth Callbacks

- `GET /api/brokers/zerodha/callback` - Zerodha OAuth callback
- `GET /api/brokers/upstox/callback` - Upstox OAuth callback
- `GET /api/brokers/fyers/callback` - Fyers OAuth callback
- `GET /api/brokers/icici/callback` - ICICI OAuth callback
- `GET /api/brokers/hdfc/callback` - HDFC OAuth callback

### API Key Connection

- `POST /api/brokers/dhan/connect` - Connect Dhan with API key
- `POST /api/brokers/angel/connect` - Connect Angel One with API key
- `POST /api/brokers/groww/connect` - Connect Groww with API key

### Data Sync

All syncing handled via server actions:

- `syncBrokerDataAction(broker, ['holdings', 'positions', 'trades'])`

---

## Troubleshooting

### "API key not configured"

- Ensure broker env variables are set in `.env`
- Restart server after adding env variables

### "OAuth callback failed"

- Check redirect URI matches exactly (including https)
- Verify API key and secret are correct

### "Invalid credentials" (API key brokers)

- Verify Client ID and Access Token
- Check if token has expired
- Regenerate token from broker portal

### "Token expired"

- For daily-expiry brokers, user needs to re-authenticate
- Click "Re-auth" button on connected broker card
