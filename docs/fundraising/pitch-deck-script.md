# UseMoney Pitch Deck Script

> Paste this into Gemini or Canva AI Deck Builder to generate slides. Adjust
> numbers, pricing, and traction stats to match your latest data.

---

## SLIDE 1 - Title

**UseMoney** One dashboard for all your Indian stock market investments.

AI-powered portfolio management across Zerodha, Upstox, Groww, Angel One, Dhan &
Fyers.

usemoney.ai

---

## SLIDE 2 - The Problem

Indian retail investors are stuck in a fragmented mess.

- **80M+ demat accounts** in India, growing 30% YoY - yet no unified view
- Investors juggle 2–3 broker apps with no consolidated P&L
- Manual trade tracking in spreadsheets leads to missed tax deadlines and wrong
  cost basis
- Broker apps show holdings but not real performance - no FIFO pairing, no
  sector allocation, no risk metrics
- Zero AI assistance for the retail investor who needs it most

The result: retail investors fly blind while institutions have Bloomberg
terminals.

---

## SLIDE 3 - The Solution

UseMoney is the Bloomberg terminal for Indian retail investors.

Connect your brokers with one click. See everything in one place. Let AI do the
heavy lifting.

- **Multi-broker aggregation** - Holdings, positions, trades & mutual funds from
  6 brokers
- **Automatic FIFO trade pairing** - Accurate realized P&L without manual effort
- **AI-powered analysis** - Ask questions about your portfolio in plain English
- **Paper trading** - Practice strategies with virtual money, real market data
- **FIRE planning** - SIP projections, withdrawal rates, retirement corpus
  planning

---

## SLIDE 4 - Product Demo (Screenshots)

> [Insert 4 screenshots: Dashboard, Discover page, AI Chat, Trade Book]

1. **Dashboard** - Total portfolio value, day change, segment breakdown across
   all brokers
2. **Discover** - Real-time top gainers, losers, mutual funds, indices & ETFs
3. **AI Chat** - "How is my IT sector exposure?" answered with data from your
   actual portfolio
4. **Trade Book** - Every trade paired with FIFO, importable via CSV or
   auto-synced

---

## SLIDE 5 - How It Works

Three steps to portfolio clarity:

1. **Connect** - OAuth integration with 6 major Indian brokers. One-click
   authorization. Credentials encrypted with AES-256-GCM.

2. **Sync** - Holdings, positions, trades & mutual funds auto-synced. Background
   workers process data via Google Cloud Pub/Sub. Multi-layer cache (Memory +
   Redis) keeps it fast.

3. **Analyze** - AI chat powered by Gemini 2.0 Flash. Sector allocation, risk
   metrics, tax-loss harvesting suggestions. Paper trading to test ideas before
   committing capital.

---

## SLIDE 6 - Market Opportunity

**India's retail investing boom is just getting started.**

- **80M+** demat accounts (CDSL + NSDL), up from 40M in 2020
- **$4.2T** Indian stock market cap (5th largest globally)
- **30% YoY** growth in new investor registrations
- **55%** of investors are under 35 - digital-native, mobile-first
- Indian WealthTech market projected to reach **$63B by 2025** (RedSeer)

**TAM:** 80M investors x avg. willingness to pay for premium tools **SAM:** 15M
active traders who use 2+ brokers **SOM:** 500K power users in Year 1 target

---

## SLIDE 7 - Business Model

Freemium SaaS with tiered subscriptions.

| Tier             | Features                                                        | Price          |
| ---------------- | --------------------------------------------------------------- | -------------- |
| **Free**         | 1 broker connection, basic dashboard, paper trading             | Free forever   |
| **Pro**          | Unlimited brokers, AI chat (fast queries), advanced analytics   | INR 999/year   |
| **Premium**      | Everything + learning content, priority support, export reports | INR 999/month  |
| **AI Unlimited** | Unlimited AI queries (fast + advanced models)                   | INR 3999/month |

**Revenue drivers:**

- Subscription revenue (primary)
- Premium educational content (video courses, market analysis)
- Future: API access for developers, data insights for institutions

---

## SLIDE 8 - Competitive Landscape

| Feature              | UseMoney        | Smallcase       | INDmoney | Tickertape | Spreadsheets |
| -------------------- | --------------- | --------------- | -------- | ---------- | ------------ |
| Multi-broker sync    | 6 brokers       | Partial         | 2–3      | None       | Manual       |
| FIFO trade pairing   | Automatic       | No              | No       | No         | Manual       |
| AI chat on portfolio | Yes (Gemini)    | No              | Basic    | No         | No           |
| Paper trading        | Yes             | No              | No       | No         | No           |
| FIRE planning        | Yes             | No              | Basic    | No         | Manual       |
| CSV import           | Smart detection | No              | No       | No         | Manual       |
| Open broker support  | 6 & growing     | Zerodha-centric | Limited  | None       | N/A          |

**Moat:** Deep broker integration + AI that understands your actual portfolio
data, not generic market advice.

---

## SLIDE 9 - Tech Architecture

Built for scale, speed, and security.

- **Frontend:** Next.js 15 + React 19, deployed on Vercel (edge-optimized)
- **Backend:** Next.js Server Actions + Hono API server on GCP Cloud Run
- **Database:** MongoDB Atlas with Prisma ORM
- **Cache:** Multi-layer - In-memory (10s) + Redis (5min) +
  stale-while-revalidate
- **AI:** Google Vertex AI (Gemini 2.0 Flash) with finance-specific guardrails
- **Security:** AES-256-GCM encryption for all broker credentials, per-user keys
- **Queue:** Google Cloud Pub/Sub for background sync jobs
- **Monorepo:** Turborepo with 12+ shared packages

Server-side rendering + RSC caching means back-navigation is instant. No
spinner, no re-fetch.

---

## SLIDE 10 - What's Built (Traction)

**Shipped and live at usemoney.ai:**

- 6 broker integrations (Zerodha, Upstox, Angel One, Groww, Dhan, Fyers)
- Full portfolio dashboard with real-time sync
- Trade book with automatic FIFO pairing & CSV import
- Mutual fund tracking across brokers
- AI chat with portfolio-aware context
- Paper trading simulator
- FIRE calculator with multiple scenarios
- Stock & MF discovery with real-time market data
- Secure premium content delivery (HLS video, PDF)
- 139 test files, 7,183 test cases, 100% pass rate

> [Update with actual user count, DAU, or waitlist numbers]

---

## SLIDE 11 - Roadmap

**Q1 2026 - Foundation (Done)**

- Multi-broker integration, trade pairing, AI chat, paper trading

**Q2 2026 - Growth**

- Mobile app (React Native via Hono API)
- Live market data with TradingView charts
- Advanced analytics (sector allocation, risk heatmaps)
- Tax report generation (ITR-compatible)

**Q3 2026 - Retention**

- Social features (share portfolio snapshots)
- Watchlist alerts & price notifications
- Dividend tracking & corporate action handling
- Strategy backtesting

**Q4 2026 - Monetization Scale**

- API marketplace for developers
- Institutional data insights
- White-label offering for financial advisors

---

## SLIDE 12 - Team

> [Insert team photos and bios]

- **[Founder Name]** - [Role]. [Background - e.g., "Ex-[Company], X years in
  fintech/trading"]
- **[Co-founder/CTO]** - [Role]. [Background]
- **Advisory:** [Names if applicable]

We are retail investors ourselves. We built UseMoney because we needed it.

---

## SLIDE 13 - The Ask

**Raising: [Amount]** **Use of funds:**

| Category                                       | Allocation |
| ---------------------------------------------- | ---------- |
| Engineering (mobile app, live data, analytics) | 45%        |
| Marketing & user acquisition                   | 25%        |
| Infrastructure & scaling                       | 15%        |
| Operations & compliance                        | 15%        |

**Key milestones this round unlocks:**

- Mobile app launch
- 100K registered users
- Revenue from paid subscriptions
- SEBI/regulatory compliance groundwork

---

## SLIDE 14 - Closing

**UseMoney** - Your entire portfolio. One dashboard. AI-powered.

India has 80M+ investors and zero unified portfolio tool. We're building the one
they'll all use.

usemoney.ai

[Contact email] [LinkedIn / Twitter handles]

---

## APPENDIX - Key Metrics to Fill In

Before presenting, update these placeholders with real numbers:

- [ ] Registered users
- [ ] Monthly active users (MAU)
- [ ] Daily active users (DAU)
- [ ] Broker connections made
- [ ] Trades tracked
- [ ] Waitlist size (if applicable)
- [ ] Revenue (if any)
- [ ] Subscription pricing finalized
- [ ] Team bios and photos
- [ ] Fundraise amount and valuation
