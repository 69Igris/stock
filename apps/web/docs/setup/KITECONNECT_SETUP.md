# KiteConnect Integration Guide

## Overview

This document outlines the KiteConnect setup and market data strategy for TradeBook Pro.

---

## KiteConnect App Configuration

### App Type: **Personal (FREE)**

**Why Personal?**

- ✅ **FREE** - No monthly subscription costs
- ✅ **Multi-user support** - All users can sync their own Zerodha accounts
- ✅ **Complete portfolio APIs** - Holdings, positions, orders, trades, mutual funds
- ✅ **Includes current prices** - Last price, close price, day change in portfolio responses
- ✅ **Perfect for portfolio tracking** - Our primary use case

**What Personal Includes:**

- Investing, trading, and reports APIs
- Current market prices with portfolio data
- Mutual fund holdings with NAV
- Order and trade history

**What Personal Does NOT Include:**

- Historical chart data APIs (OHLCV candles)
- Live market quotes and WebSockets (real-time streaming)
- Intraday minute-level data

---

## App Details

### App Configuration

```
Type: Personal
App Name: UseMoney - Portfolio Sync
Redirect URL:
  - http://localhost:3000/api/brokers/zerodha/callback
  - https://yourdomain.com/api/brokers/zerodha/callback
Postback URL: (Leave blank)
Description: Portfolio tracking and tradebook management app that syncs Zerodha holdings, positions, trades, and mutual fund investments.
```

### Environment Variables

```env
# .env
ZERODHA_API_KEY=your_api_key_here
ZERODHA_API_SECRET=your_api_secret_here
NEXT_PUBLIC_BASE_URL=http://localhost:3000  # or your production URL
```

---

## Multi-User Support

### How it Works

- Each user authenticates with their **own Zerodha account**
- Personal app supports **unlimited users**
- Each user's access token is stored separately in our database
- Users can only see their own portfolio data
- No cross-user data access

### User Flow

1. User clicks "Connect Zerodha" in app
2. Redirected to Zerodha login page
3. User logs in with their Zerodha credentials
4. OAuth callback stores their access token securely
5. App fetches their personal portfolio data

**Personal app is perfect for this use case!** ✅

---

## Pricing Data Strategy

### How Prices are Provided

#### Real Portfolio (Zerodha Personal API)

When fetching holdings/positions, the API already includes:

- `lastPrice` - Current market price
- `closePrice` - Previous day close
- `averagePrice` - User's buy price
- `pnl` - Calculated profit/loss
- `dayChange` - Intraday change
- `dayChangePerc` - Percentage change

**No additional API calls needed for portfolio prices!**

#### Paper Trading & Analysis (Free Providers)

For features beyond real portfolio sync, use free market data providers.

---

## Market Data Providers

### Recommended: Yahoo Finance (Primary)

**Best for:** Paper trading, historical data, stock analysis

```bash
npm install yahoo-finance2
```

**Usage:**

```typescript
import yahooFinance from "yahoo-finance2";

// Get current quote
const quote = await yahooFinance.quote("RELIANCE.NS");
console.log(quote.regularMarketPrice);

// Get historical data (OHLCV)
const history = await yahooFinance.historical("TCS.NS", {
  period1: "2024-01-01",
  period2: "2024-12-31",
  interval: "1d", // '1d', '1wk', '1mo'
});

// Multiple symbols
const quotes = await yahooFinance.quote(["RELIANCE.NS", "TCS.NS", "INFY.NS"]);
```

**Symbol Format:**

- NSE stocks: `SYMBOL.NS` (e.g., `RELIANCE.NS`)
- BSE stocks: `SYMBOL.BO` (e.g., `500325.BO`)

**Pros:**

- ✅ Free, unlimited API calls
- ✅ Real-time-ish prices (15-20 min delay acceptable for portfolio tracking)
- ✅ Historical data with OHLCV
- ✅ Global coverage
- ✅ No API key required

**Cons:**

- ❌ Not real-time (15-20 min delay)
- ❌ Unofficial API (can change)

---

### Alternative: NSE India Official API

**Best for:** Real-time NSE data (free)

```typescript
// No package needed - direct fetch
const fetchNSEQuote = async (symbol: string) => {
  const response = await fetch(
    `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    }
  );
  return response.json();
};

// Usage
const data = await fetchNSEQuote("RELIANCE");
console.log(data.priceInfo.lastPrice);
```

**Pros:**

- ✅ Completely free
- ✅ Real-time data
- ✅ Official NSE source
- ✅ No API key needed

**Cons:**

- ❌ Requires session/cookie management
- ❌ Rate limiting (need caching)
- ❌ NSE only (no BSE direct)

---

### Alternative: Alpha Vantage

**Best for:** Technical indicators, fundamental data

```typescript
const API_KEY = "your_free_key";

// Current price
const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=RELIANCE.BSE&apikey=${API_KEY}`;

// Historical (daily)
const histUrl = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=RELIANCE.BSE&apikey=${API_KEY}`;

// Technical indicators
const smaUrl = `https://www.alphavantage.co/query?function=SMA&symbol=RELIANCE.BSE&interval=daily&time_period=50&apikey=${API_KEY}`;
```

**Pros:**

- ✅ Free tier available
- ✅ Technical indicators built-in
- ✅ Good documentation

**Cons:**

- ❌ 25 API calls/day (free tier)
- ❌ 5 calls/minute rate limit

---

### Alternative: Upstox Market Data API

**Best for:** Alternative to Zerodha with generous free tier

- Free tier: 10 API calls/second
- Historical data included
- WebSocket streaming available
- Similar to KiteConnect

**Setup:** https://upstox.com/developer/api-documentation/

---

## Recommended Architecture

### Market Data Service Layer

Create abstraction to support multiple providers:

```typescript
// lib/market-data/types.ts
export interface MarketDataProvider {
  getCurrentPrice(symbol: string, exchange: "NSE" | "BSE"): Promise<number>;
  getHistoricalData(
    symbol: string,
    from: Date,
    to: Date,
    interval: "1d" | "1wk" | "1mo"
  ): Promise<OHLCV[]>;
  getMultipleQuotes(symbols: string[]): Promise<Quote[]>;
  getMFNav(isin: string): Promise<{ nav: number; date: Date }>;
}

export interface OHLCV {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Quote {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: Date;
}
```

```typescript
// lib/market-data/providers/yahoo-finance.ts
import yahooFinance from "yahoo-finance2";

export class YahooFinanceProvider implements MarketDataProvider {
  private formatSymbol(symbol: string, exchange: "NSE" | "BSE"): string {
    const suffix = exchange === "NSE" ? ".NS" : ".BO";
    return `${symbol}${suffix}`;
  }

  async getCurrentPrice(
    symbol: string,
    exchange: "NSE" | "BSE"
  ): Promise<number> {
    const formatted = this.formatSymbol(symbol, exchange);
    const quote = await yahooFinance.quote(formatted);
    return quote.regularMarketPrice || 0;
  }

  async getHistoricalData(
    symbol: string,
    from: Date,
    to: Date,
    interval: "1d" | "1wk" | "1mo" = "1d"
  ): Promise<OHLCV[]> {
    const formatted = this.formatSymbol(symbol, "NSE");
    const history = await yahooFinance.historical(formatted, {
      period1: from,
      period2: to,
      interval,
    });

    return history.map((h) => ({
      date: h.date,
      open: h.open,
      high: h.high,
      low: h.low,
      close: h.close,
      volume: h.volume,
    }));
  }

  async getMultipleQuotes(symbols: string[]): Promise<Quote[]> {
    const formatted = symbols.map((s) => this.formatSymbol(s, "NSE"));
    const quotes = await yahooFinance.quote(formatted);

    return quotes.map((q) => ({
      symbol: q.symbol.replace(".NS", "").replace(".BO", ""),
      price: q.regularMarketPrice || 0,
      change: q.regularMarketChange || 0,
      changePercent: q.regularMarketChangePercent || 0,
      volume: q.regularMarketVolume || 0,
      timestamp: new Date(),
    }));
  }

  async getMFNav(isin: string): Promise<{ nav: number; date: Date }> {
    // Use AMFI API or MFCentral
    // Implementation depends on data source
    throw new Error("MF NAV not implemented for Yahoo Finance");
  }
}
```

```typescript
// lib/market-data/providers/nse.ts
export class NSEProvider implements MarketDataProvider {
  private async fetchWithHeaders(url: string) {
    return fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  }

  async getCurrentPrice(
    symbol: string,
    exchange: "NSE" | "BSE"
  ): Promise<number> {
    if (exchange !== "NSE") {
      throw new Error("NSE provider only supports NSE exchange");
    }

    const response = await this.fetchWithHeaders(
      `https://www.nseindia.com/api/quote-equity?symbol=${symbol}`
    );
    const data = await response.json();
    return data.priceInfo?.lastPrice || 0;
  }

  // Implement other methods...
}
```

```typescript
// lib/market-data/index.ts
import { YahooFinanceProvider } from "./providers/yahoo-finance";
import { NSEProvider } from "./providers/nse";

export class MarketDataService {
  private provider: MarketDataProvider;

  constructor(providerType: "yahoo" | "nse" | "alpha-vantage" = "yahoo") {
    switch (providerType) {
      case "yahoo":
        this.provider = new YahooFinanceProvider();
        break;
      case "nse":
        this.provider = new NSEProvider();
        break;
      default:
        this.provider = new YahooFinanceProvider();
    }
  }

  // Proxy all methods to the provider
  getCurrentPrice(symbol: string, exchange: "NSE" | "BSE" = "NSE") {
    return this.provider.getCurrentPrice(symbol, exchange);
  }

  getHistoricalData(symbol: string, from: Date, to: Date, interval = "1d") {
    return this.provider.getHistoricalData(symbol, from, to, interval);
  }

  getMultipleQuotes(symbols: string[]) {
    return this.provider.getMultipleQuotes(symbols);
  }
}

// Export singleton
export const marketData = new MarketDataService("yahoo");
```

---

## Data Flow

### Real Portfolio Sync

```
User → Connect Zerodha → OAuth → Zerodha Personal API
                                       ↓
                    Holdings/Positions/Trades (with prices included)
                                       ↓
                                  Our Database
                                       ↓
                                   User Dashboard
```

### Paper Trading

```
User → Create Paper Trade → Need Current Price
                                    ↓
                        Yahoo Finance / NSE API
                                    ↓
                          Store in Paper Trading DB
```

### Stock Analysis

```
User → View Stock Analysis → Need Historical Data
                                     ↓
                         Yahoo Finance Historical API
                                     ↓
                           Generate Charts/Indicators
```

---

## When to Upgrade to KiteConnect "Connect" (Paid)

Consider upgrading to **Connect (₹500/month)** only when:

### You Need:

1. **Real-time streaming** - WebSocket ticks for live price updates
2. **Official historical data** - Direct from Zerodha with reliability guarantees
3. **Intraday data** - Minute-level OHLCV candles
4. **Chart data** - For building charting features
5. **Commercial scale** - High-volume API usage with SLA

### You're Building:

- Live trading platform with real-time order execution UI
- Advanced charting application
- Algorithmic trading system
- High-frequency features

### For TradeBook Pro:

**Personal (Free) is sufficient** because:

- Portfolio tracking doesn't need real-time streaming
- Current prices are included in portfolio API responses
- Paper trading can use delayed data (15-20 min is acceptable)
- Historical analysis can use Yahoo Finance free data

---

## Cost Comparison

| Scenario                        | KiteConnect          | Market Data                   | Total Cost |
| ------------------------------- | -------------------- | ----------------------------- | ---------- |
| **Current Setup (Recommended)** | Personal (Free)      | Yahoo Finance (Free)          | ₹0/month   |
| **Premium Setup**               | Connect (₹500/month) | Included                      | ₹500/month |
| **Hybrid Setup**                | Personal (Free)      | Alpha Vantage Pro (₹50/month) | ₹50/month  |

---

## Implementation Checklist

### Phase 1: KiteConnect Setup

- [ ] Create Personal app on KiteConnect
- [ ] Add redirect URLs (localhost + production)
- [ ] Set environment variables
- [ ] Test OAuth flow
- [ ] Verify portfolio data sync

### Phase 2: Market Data Integration (Future)

- [ ] Install yahoo-finance2
- [ ] Create MarketDataService abstraction
- [ ] Implement YahooFinanceProvider
- [ ] Add caching layer (Redis/in-memory)
- [ ] Test with paper trading

### Phase 3: Advanced Features (Optional)

- [ ] Implement NSE provider for real-time data
- [ ] Add Alpha Vantage for technical indicators
- [ ] Build chart components
- [ ] Add stock analysis features

---

## Security Best Practices

### API Keys

- Store in environment variables (never commit to git)
- Use different keys for dev/prod if possible
- Rotate keys periodically

### Access Tokens

- Encrypt before storing in database (use ENCRYPTION_KEY)
- Auto-refresh before expiry (Zerodha tokens expire at midnight)
- Clear expired tokens from database

### Rate Limiting

- Implement caching for market data (avoid repeated calls)
- Use Redis for shared cache across instances
- Set up rate limiting on API routes

---

## Support & Documentation

### KiteConnect

- Docs: https://kite.trade/docs/connect/v3/
- Forum: https://kite.trade/forum/
- Support: support@zerodha.com

### Yahoo Finance

- Package: https://github.com/gadicc/node-yahoo-finance2
- Docs: https://github.com/gadicc/node-yahoo-finance2/blob/devel/docs/README.md

### NSE India

- Website: https://www.nseindia.com/
- API Docs: (Unofficial - reverse engineered)

---

## FAQ

### Q: Will Personal app work for 1000+ users?

**A:** Yes! Personal app supports unlimited users. Each user syncs their own Zerodha account.

### Q: Do all users need their own Zerodha account?

**A:** Yes, users can only sync their own Zerodha account. They need an active Zerodha demat account.

### Q: Can I mix real and paper trading?

**A:** Yes! Real portfolio uses Zerodha API, paper trading can use Yahoo Finance for market data.

### Q: What about mutual fund NAV?

**A:** Zerodha Personal API provides current NAV for MF holdings. For paper MF, use AMFI or MFCentral APIs (free).

### Q: How often do prices update?

**A:**

- Zerodha holdings API: On-demand (when user refreshes)
- Yahoo Finance: 15-20 min delay
- NSE API: Real-time

### Q: Can I get historical data with Personal?

**A:** No, use Yahoo Finance or upgrade to Connect for official historical data.

---

## Conclusion

**Start with KiteConnect Personal (Free) + Yahoo Finance (Free)**

This combination gives you:

- ✅ Zero monthly costs
- ✅ Complete portfolio sync with current prices
- ✅ Paper trading capabilities
- ✅ Historical data for analysis
- ✅ Scalable to unlimited users

Upgrade to Connect only when you need real-time streaming or are generating revenue from the platform.
