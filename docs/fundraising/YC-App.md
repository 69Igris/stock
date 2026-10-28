# usemoney - YC Application Answers (Bottom-Up)

---

## 1. What is your company going to make? Please describe your product and what it does or will do.

usemoney is an AI-powered quant trading platform for Indian retail investors. It
connects to 8+ Indian brokers (Zerodha, Angel One, Upstox, Groww, Dhan, Fyers,
ICICI, HDFC) via a single unified interface, and layers multi-AI analysis on top

- using OpenAI, Gemini, and Perplexity to generate trade signals, sentiment
  analysis, and portfolio insights.

**What it does today (live beta):**

- **Unified multi-broker dashboard:** One login to see positions, holdings, and
  P&L across all your Indian brokerage accounts. No other tool does this.
- **AI-powered trade analysis:** Every stock in your portfolio gets real-time
  analysis from multiple AI models - not just one opinion, but a synthesis of
  three.
- **Strategy backtesting engine:** Build and test trading strategies against
  historical NSE/BSE data before risking real money.
- **Trade replay:** Replay your past trades to understand what went right or
  wrong, with AI commentary on each decision.
- **Live streaming data:** SSE-based real-time market data with sub-second
  updates.

**What we're building next:**

- One-click algo deployment with SEBI-compliant execution (leveraging the new
  2025 retail algo framework)
- AI-generated trade strategies personalized to your risk profile and portfolio
  size
- WhatsApp-native alerts and trade execution for Tier 2-3 investors who live on
  WhatsApp

**The core insight:** India's existing trading tools are fragmented. Zerodha
users get Streak. Angel One users get nothing comparable. Nobody aggregates
across brokers, and nobody brings AI analysis to the 120M+ demat account holders
in India. usemoney is the cross-broker intelligence layer.

---

## 2. How do or will you make money? How much could you make?

### Revenue Model

**SaaS subscription** with three tiers:

| Tier  | Price            | Target User                                            |
| ----- | ---------------- | ------------------------------------------------------ |
| Free  | ₹0               | Basic portfolio view, 1 broker, limited AI queries     |
| Pro   | ₹499/mo (~$6)    | Multi-broker, unlimited AI analysis, backtesting       |
| Quant | ₹1,499/mo (~$18) | Algo deployment, advanced strategies, priority signals |

**Additional revenue streams:**

- Transaction-based fees on algo-executed trades (₹10-20 per trade)
- Premium AI strategy marketplace (revenue share with strategy creators)
- Broker referral commissions (₹200-500 per new account opened via usemoney)

### Bottom-Up Market Sizing

**Starting point:** India has 21.6 crore (216 million) demat accounts as of
December 2025, with 13.6 crore (136 million) unique investors.

**Funnel:**

| Filter                                     | Number         | Rationale                                                             |
| ------------------------------------------ | -------------- | --------------------------------------------------------------------- |
| Total demat accounts (Dec 2025)            | 216M           | SEBI/CDSL/NSDL data                                                   |
| Active traders (trade at least 1x/month)   | ~30M           | ~14% of demat accounts are actively trading                           |
| Use 2+ brokers or want cross-broker tools  | ~6M            | ~20% of active traders hold accounts at multiple brokers              |
| Willing to pay for trading tools           | ~1.2M          | ~20% willingness-to-pay (Sensibull has ~500K paid users as benchmark) |
| **usemoney addressable market (Year 1-3)** | **1.2M users** |                                                                       |

**Revenue projection (Year 3):**

| Segment           | Users           | ARPU/yr        | Revenue            |
| ----------------- | --------------- | -------------- | ------------------ |
| Pro subscribers   | 50,000          | ₹5,988 ($72)   | ₹30Cr ($3.6M)      |
| Quant subscribers | 10,000          | ₹17,988 ($216) | ₹18Cr ($2.2M)      |
| Transaction fees  | 60,000 active   | ₹2,400 ($29)   | ₹14.4Cr ($1.7M)    |
| Broker referrals  | 100,000 signups | ₹300 ($3.6)    | ₹3Cr ($0.36M)      |
| **Total Year 3**  |                 |                | **₹65Cr (~$7.8M)** |

**Benchmark validation:** Smallcase hit ₹114Cr (~$13.7M) annual revenue in FY25
with 500K+ users. Sensibull charges ₹800/mo and is profitable within the Zerodha
ecosystem. The market clearly pays for trading intelligence tools.

**Long-term (5-year) TAM:** If even 2% of India's 136M investors use usemoney at
₹499/mo average, that's ₹1,630 Cr/year (~$196M). The Indian retail trading tools
market is a multi-billion-dollar opportunity barely scratched.

---

## 3. Who are your competitors? What do you understand about your business that they don't?

### Competitive Landscape

| Competitor    | What They Do                                    | Pricing                  | Limitation                                                 |
| ------------- | ----------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| **Smallcase** | Themed stock portfolios (buy baskets of stocks) | ₹100/txn + subscription  | Portfolio-only, no trading intelligence or algo execution  |
| **Sensibull** | Options chain analysis & strategy builder       | Free (Zerodha) / ₹800/mo | Options-only, Zerodha-locked, no cross-broker, no AI       |
| **Streak**    | No-code algo builder (semi-automated)           | Free for Zerodha users   | Zerodha-only, no multi-broker, limited strategy complexity |
| **Tradetron** | Algo strategy marketplace                       | ₹300-2,000/mo            | Complex UX, no AI analysis, marketplace-dependent          |
| **AlgoTest**  | Options backtesting                             | ₹499/mo                  | Backtesting only, no live execution across brokers         |
| **Opstra**    | Options analytics for quants                    | ₹10,000/yr               | Niche, no cross-broker, steep learning curve               |

### What we understand that they don't:

**1. The multi-broker problem is real and unsolved.** India's market is uniquely
fragmented - unlike the US where most people use one brokerage. Indian retail
investors routinely hold 2-3 accounts (Zerodha for equity, Angel One for IPOs,
Groww for mutual funds). No tool aggregates across them. Every competitor is
locked to one broker ecosystem. usemoney is broker-agnostic.

**2. AI changes the game from "tools for experts" to "intelligence for
everyone."** Sensibull, Streak, and Tradetron all assume the user knows what
strategy to run. They're strategy _execution_ tools. usemoney flips this - AI
tells you _what_ to do based on your portfolio, risk tolerance, and market
conditions. The 91% of retail derivatives traders who lose money (per SEBI data)
don't need more tools; they need smarter guidance.

**3. The next 100M investors won't use desktop trading terminals.** 75% of new
demat accounts in 2025 were opened by people under 30, predominantly from Tier
2-3 cities. They trade on mobile, they communicate on WhatsApp, and they want
simple answers - not complex option chains. Our WhatsApp-native alerts and AI
explanations in Hindi are built for this user, not for the sophisticated options
trader that Sensibull and Opstra serve.

**4. SEBI's new retail algo framework (2025) is a massive tailwind.** SEBI has
legitimized retail algo trading with clear regulatory guardrails. Algorithmic
participation on NSE has grown from 39% in FY15 to 73% in FY26 for stock
futures. But no platform makes algo trading _simple and safe_ for the average
retail investor. We're building the Robinhood of algo trading for India -
regulated, AI-powered, and accessible.

---

## 4. Why did you pick this idea to work on? Do you have domain expertise in this area? How do you know people need what you're making?

### Why this idea:

**I am the user.** I'm an active Indian retail investor who has traded across
Zerodha, Angel One, and Upstox. I've personally felt the pain of:

- Logging into 3 different broker apps to check my positions
- Manually tracking P&L across accounts in spreadsheets
- Losing money on F&O trades because I didn't have institutional-grade analysis
- Wanting to automate my strategies but finding Streak too limited and Tradetron
  too complex

This isn't a market I'm entering from the outside - it's a problem I've been
solving for myself.

### Domain expertise:

**Technical:** 10+ years of enterprise engineering experience at Harness
(DevOps/CI-CD), AppDynamics (APM/monitoring), RSA (security), and HP. I've built
distributed systems, real-time data pipelines, and multi-tenant SaaS platforms
at scale. The technical challenges of usemoney - multi-broker API integration,
real-time streaming, AI orchestration - are problems I've solved variants of
throughout my career.

**Financial markets:** I run a Hindi-language YouTube channel called
**"Investing Common Sense"** (youtube.com/@InvestingCommonSense) focused on
stock market and investment education for Indian retail investors. This gives me
a direct feedback loop with exactly the audience usemoney serves. I hear their
questions, frustrations, and needs every day. I'm also pursuing the NISM Series
X-A Investment Adviser certification to ensure regulatory compliance.

**Builder credibility:** I've shipped multiple products - RateCreator (content
creator discovery), Naviya AI (K-12 tutoring), Ship.build (AI DevOps). usemoney
is the product I keep coming back to because the market pull is strongest.

### How I know people need this:

1. **My YouTube audience asks for it.** The #1 request from my viewers is "how
   do I use AI to trade smarter?" and "which tool works across all brokers?"

2. **The data proves it.** India crossed 216M demat accounts in Dec 2025, adding
   23.5M in just 9 months. Monthly SIP contributions hit ₹29,500 crore. Yet SEBI
   reports 91% of retail F&O traders lose money. The gap between participation
   and outcomes is enormous - that's our market.

3. **20 beta users, 10 paying.** Even in early beta at an introductory ₹10/year
   price, 50% of our users converted to paid. We're launching the full paid
   product in April 2026.

4. **The regulatory moment is now.** SEBI's 2025 retail algo framework has
   created a greenfield opportunity. For the first time, retail investors can
   legally run algos through registered platforms. We're positioning usemoney to
   be the default platform for this new category.

---

_usemoney.ai - Democratizing quant trading for 136 million Indian investors._
