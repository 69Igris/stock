/**
 * Seed Glossary
 *
 * Migrates 132 glossary terms into the Post collection (contentType: GLOSSARY)
 * so both the public /glossary page and the authenticated /help glossary tab
 * share the same data source.
 *
 * - Finds an existing ContentAuthor (first available)
 * - Creates 11 category tags (Trading Basics, Mutual Funds, etc.)
 * - Creates Post records with BlockNote JSON content
 * - Idempotent: skips terms whose postUrl (slug) already exists
 *
 * Usage:
 *   # Local (uses DATABASE_URL from .env)
 *   npx tsx scripts/seed/seed-glossary.ts
 *
 *   # QA / Prod (pass DATABASE_URL directly)
 *   DATABASE_URL="mongodb+srv://user:pass@host/db" npx tsx scripts/seed/seed-glossary.ts
 *
 *   # Or fetch from GCP Secret Manager:
 *   DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL_QA --project=stock-book-483718) \
 *     npx tsx scripts/seed/seed-glossary.ts
 *
 *   DATABASE_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL_PROD --project=stock-book-483718) \
 *     npx tsx scripts/seed/seed-glossary.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── Glossary terms (same data as glossary-data.ts) ───────────────────────────
interface GlossaryTerm {
  term: string;
  definition: string;
  /** Tag slugs to assign */
  tags: string[];
}

// Category tag definitions
const TAG_DEFINITIONS: Record<
  string,
  { name: string; color: string; description: string }
> = {
  "trading-basics": {
    name: "Trading Basics",
    color: "#3b82f6",
    description: "Fundamental trading concepts and order types",
  },
  "market-indices": {
    name: "Market Indices & Exchanges",
    color: "#8b5cf6",
    description: "Stock exchanges, indices, and market structure",
  },
  "mutual-funds": {
    name: "Mutual Funds",
    color: "#10b981",
    description: "Mutual fund terms, NAV, SIP, and fund types",
  },
  derivatives: {
    name: "Derivatives (F&O)",
    color: "#f59e0b",
    description: "Futures, options, and derivative concepts",
  },
  "tax-regulations": {
    name: "Tax & Regulations",
    color: "#ef4444",
    description: "Tax rules, SEBI regulations, and compliance",
  },
  "technical-analysis": {
    name: "Technical Analysis",
    color: "#06b6d4",
    description: "Chart patterns, indicators, and technical tools",
  },
  "fundamental-analysis": {
    name: "Fundamental Analysis",
    color: "#84cc16",
    description: "Financial ratios, valuation metrics, and company analysis",
  },
  "portfolio-management": {
    name: "Portfolio Management",
    color: "#ec4899",
    description:
      "Portfolio construction, risk management, and investment strategy",
  },
  "fire-planning": {
    name: "FIRE Planning",
    color: "#f97316",
    description: "Financial independence and retirement planning",
  },
  "corporate-actions": {
    name: "Corporate Actions",
    color: "#a855f7",
    description: "Dividends, splits, bonuses, and other corporate events",
  },
  "indian-markets": {
    name: "Indian Markets",
    color: "#14b8a6",
    description: "India-specific market terms and institutions",
  },
};

// Term → tag mapping
function getTagsForTerm(term: string): string[] {
  const tagMap: Record<string, string[]> = {
    // Trading Basics
    "Ask Price": ["trading-basics"],
    "Average Price": ["trading-basics", "portfolio-management"],
    "Bid Price": ["trading-basics"],
    CMP: ["trading-basics"],
    "Day Trading": ["trading-basics"],
    "Delivery Trading": ["trading-basics"],
    "Intraday Trading": ["trading-basics"],
    "Limit Order": ["trading-basics"],
    "Market Order": ["trading-basics"],
    "Stop Loss": ["trading-basics"],
    "Trailing Stop Loss": ["trading-basics"],
    "T+1 Settlement": ["trading-basics", "indian-markets"],
    Brokerage: ["trading-basics", "indian-markets"],
    Leverage: ["trading-basics", "derivatives"],
    Liquidity: ["trading-basics"],
    Volume: ["trading-basics", "technical-analysis"],
    VWAP: ["trading-basics", "technical-analysis"],
    Watchlist: ["trading-basics", "portfolio-management"],
    "Market Maker": ["trading-basics"],

    // Market Indices & Exchanges
    BSE: ["market-indices", "indian-markets"],
    NSE: ["market-indices", "indian-markets"],
    "Nifty 50": ["market-indices", "indian-markets"],
    Sensex: ["market-indices", "indian-markets"],
    "Circuit Breaker": ["market-indices", "indian-markets"],
    "Upper / Lower Circuit": ["market-indices", "indian-markets"],
    "Free Float": ["market-indices"],
    "Market Cap": ["market-indices", "fundamental-analysis"],
    "Large Cap": ["market-indices"],
    "Mid Cap": ["market-indices"],
    "Small Cap": ["market-indices"],
    "Blue Chip": ["market-indices"],
    "52-Week High/Low": ["market-indices", "technical-analysis"],

    // Mutual Funds
    AMC: ["mutual-funds"],
    AUM: ["mutual-funds"],
    ETF: ["mutual-funds"],
    "Expense Ratio": ["mutual-funds"],
    "Index Fund": ["mutual-funds"],
    "Mutual Fund": ["mutual-funds"],
    NAV: ["mutual-funds"],
    NFO: ["mutual-funds"],
    SIP: ["mutual-funds", "fire-planning"],
    SWP: ["mutual-funds", "fire-planning"],
    "Lump Sum": ["mutual-funds", "fire-planning"],
    "Rupee Cost Averaging": ["mutual-funds", "fire-planning"],

    // Derivatives
    "F&O": ["derivatives"],
    "Call Option": ["derivatives"],
    "Put Option": ["derivatives"],
    "Futures Contract": ["derivatives"],
    "Lot Size": ["derivatives"],
    Margin: ["derivatives", "trading-basics"],
    "Margin Call": ["derivatives"],
    "Open Interest": ["derivatives"],
    "Option Premium": ["derivatives"],
    "Theta Decay": ["derivatives"],

    // Tax & Regulations
    "Capital Gain": ["tax-regulations"],
    LTCG: ["tax-regulations"],
    STCG: ["tax-regulations"],
    STT: ["tax-regulations", "indian-markets"],
    "80C Deduction": ["tax-regulations", "fire-planning"],
    PAN: ["tax-regulations", "indian-markets"],
    KYC: ["tax-regulations", "indian-markets"],
    SEBI: ["tax-regulations", "indian-markets"],
    "Insider Trading": ["tax-regulations"],

    // Technical Analysis
    "Bear Market": ["technical-analysis"],
    "Bull Market": ["technical-analysis"],
    Consolidation: ["technical-analysis"],
    "Gap Up / Gap Down": ["technical-analysis"],
    "Moving Average": ["technical-analysis"],
    Resistance: ["technical-analysis"],
    RSI: ["technical-analysis"],
    Support: ["technical-analysis"],
    "Technical Analysis": ["technical-analysis"],
    Volatility: ["technical-analysis"],

    // Fundamental Analysis
    "Book Value": ["fundamental-analysis"],
    CAGR: ["fundamental-analysis", "portfolio-management"],
    "Debt-to-Equity Ratio": ["fundamental-analysis"],
    EBITDA: ["fundamental-analysis"],
    EPS: ["fundamental-analysis"],
    "Fundamental Analysis": ["fundamental-analysis"],
    "P/B Ratio": ["fundamental-analysis"],
    "P/E Ratio": ["fundamental-analysis"],
    ROCE: ["fundamental-analysis"],
    ROE: ["fundamental-analysis"],
    "Working Capital": ["fundamental-analysis"],
    NPA: ["fundamental-analysis", "indian-markets"],

    // Portfolio Management
    Beta: ["portfolio-management", "technical-analysis"],
    Hedge: ["portfolio-management", "derivatives"],
    "P&L": ["portfolio-management"],
    Portfolio: ["portfolio-management"],
    "Sector Rotation": ["portfolio-management"],
    "Unrealized P&L": ["portfolio-management"],
    Pledge: ["portfolio-management"],
    "Demat Account": ["portfolio-management", "indian-markets"],
    FIFO: ["portfolio-management", "trading-basics"],
    XIRR: ["portfolio-management", "mutual-funds"],

    // FIRE Planning
    Corpus: ["fire-planning"],
    FIRE: ["fire-planning"],
    Inflation: ["fire-planning"],
    PPF: ["fire-planning", "tax-regulations"],
    Gratuity: ["fire-planning"],
    Yield: ["fire-planning", "fundamental-analysis"],
    YTD: ["fire-planning", "portfolio-management"],

    // Corporate Actions
    "Bonus Issue": ["corporate-actions"],
    Buyback: ["corporate-actions"],
    Dividend: ["corporate-actions"],
    "Dividend Yield": ["corporate-actions", "fundamental-analysis"],
    "DVR Shares": ["corporate-actions"],
    "Ex-Date": ["corporate-actions"],
    FPO: ["corporate-actions"],
    "Green Shoe Option": ["corporate-actions"],
    IPO: ["corporate-actions", "indian-markets"],
    OFS: ["corporate-actions"],
    "Record Date": ["corporate-actions"],
    "Rights Issue": ["corporate-actions"],
    "Stock Split": ["corporate-actions"],

    // Indian Markets
    CRR: ["indian-markets"],
    DII: ["indian-markets"],
    DRHP: ["indian-markets", "corporate-actions"],
    FII: ["indian-markets"],
    HNI: ["indian-markets"],
    "NRI Investment": ["indian-markets"],
    RBI: ["indian-markets"],
    SGB: ["indian-markets", "fire-planning"],
    SLB: ["indian-markets", "derivatives"],
    "Holding Period": ["indian-markets", "tax-regulations"],

    // Misc
    "Basis Point": ["trading-basics"],
    Equity: ["trading-basics"],
    "Face Value": ["fundamental-analysis"],
    NCD: ["fire-planning"],
    ULIP: ["fire-planning"],
    "Zero Coupon Bond": ["fire-planning"],
    Promoter: ["fundamental-analysis", "indian-markets"],
  };

  return tagMap[term] || ["trading-basics"];
}

// All 192 terms
const GLOSSARY_TERMS: GlossaryTerm[] = [
  // A
  {
    term: "AMC",
    definition:
      "Asset Management Company. A firm that invests pooled funds from investors into securities such as stocks and bonds. Examples in India include SBI MF, HDFC AMC, and ICICI Prudential AMC.",
    tags: [],
  },
  {
    term: "Ask Price",
    definition:
      "The lowest price at which a seller is willing to sell a security. Also called the offer price. The difference between ask and bid price is the spread.",
    tags: [],
  },
  {
    term: "AUM",
    definition:
      "Assets Under Management. The total market value of investments managed by a mutual fund or portfolio manager. Larger AUM generally indicates investor confidence.",
    tags: [],
  },
  {
    term: "Average Price",
    definition:
      "The weighted average cost at which you purchased shares of a stock, calculated by dividing total cost by total quantity. Used for P&L calculations in UseMoney.",
    tags: [],
  },
  // B
  {
    term: "Basis Point",
    definition:
      "One-hundredth of a percentage point (0.01%). Used to describe small changes in interest rates, yields, or expense ratios. 100 basis points = 1%.",
    tags: [],
  },
  {
    term: "Bear Market",
    definition:
      "A market condition where prices are falling or expected to fall, typically defined as a decline of 20% or more from recent highs.",
    tags: [],
  },
  {
    term: "Beta",
    definition:
      "A measure of a stock's volatility relative to the overall market. Beta of 1 means the stock moves with the market; above 1 means more volatile; below 1 means less volatile.",
    tags: [],
  },
  {
    term: "Bid Price",
    definition:
      "The highest price a buyer is willing to pay for a security. Together with the ask price, it forms the bid-ask spread.",
    tags: [],
  },
  {
    term: "Blue Chip",
    definition:
      "Large, well-established companies with a history of reliable performance, strong financials, and consistent dividends. In India, companies like Reliance, TCS, and HDFC Bank are considered blue chips.",
    tags: [],
  },
  {
    term: "Bonus Issue",
    definition:
      "Free additional shares given by a company to existing shareholders in a fixed ratio (e.g., 1:1 means one free share for every share held). The stock price adjusts proportionally.",
    tags: [],
  },
  {
    term: "Book Value",
    definition:
      "The net asset value of a company, calculated as total assets minus intangible assets and liabilities, divided by number of outstanding shares.",
    tags: [],
  },
  {
    term: "Brokerage",
    definition:
      "The commission or fee charged by a broker for executing buy or sell orders. Discount brokers in India typically charge flat fees (e.g., Rs 20 per order) or zero for delivery trades.",
    tags: [],
  },
  {
    term: "BSE",
    definition:
      "Bombay Stock Exchange. India's oldest stock exchange, established in 1875, located in Mumbai. Its benchmark index is the Sensex.",
    tags: [],
  },
  {
    term: "Bull Market",
    definition:
      "A market condition where prices are rising or expected to rise, characterized by investor optimism and sustained upward trends.",
    tags: [],
  },
  {
    term: "Buyback",
    definition:
      "When a company repurchases its own shares from the market, reducing the number of outstanding shares. Often signals that the company believes its stock is undervalued.",
    tags: [],
  },
  // C
  {
    term: "CAGR",
    definition:
      "Compound Annual Growth Rate. The annualized rate of return that smooths out volatility, showing how an investment would have grown if it grew at a steady rate.",
    tags: [],
  },
  {
    term: "Call Option",
    definition:
      "A derivative contract that gives the buyer the right (but not obligation) to buy an underlying asset at a specified strike price before or on the expiry date.",
    tags: [],
  },
  {
    term: "Capital Gain",
    definition:
      "The profit realized when a security is sold for more than its purchase price. In India, classified as short-term (held <=12 months) or long-term (held >12 months) for tax purposes.",
    tags: [],
  },
  {
    term: "Circuit Breaker",
    definition:
      "A mechanism that temporarily halts trading on a stock or the entire market when prices move beyond specified limits (upper or lower circuit). SEBI sets these limits to prevent extreme volatility.",
    tags: [],
  },
  {
    term: "CMP",
    definition:
      "Current Market Price. The latest traded price of a security on the exchange. Used as the reference for real-time P&L calculations.",
    tags: [],
  },
  {
    term: "Consolidation",
    definition:
      "A period where a stock's price moves sideways within a narrow range, indicating indecision between buyers and sellers before a breakout or breakdown.",
    tags: [],
  },
  {
    term: "Corpus",
    definition:
      "The total accumulated amount of money in an investment portfolio or fund. In FIRE planning, the target corpus is the amount needed to sustain retirement expenses.",
    tags: [],
  },
  {
    term: "CRR",
    definition:
      "Cash Reserve Ratio. The percentage of deposits that banks must keep with the RBI as liquid cash. Changes in CRR affect liquidity in the banking system and indirectly impact stock markets.",
    tags: [],
  },
  // D
  {
    term: "Day Trading",
    definition:
      "See Intraday Trading. Buying and selling securities within the same trading day to profit from short-term price movements.",
    tags: [],
  },
  {
    term: "Debt-to-Equity Ratio",
    definition:
      "A leverage ratio calculated by dividing total debt by shareholders' equity. A lower ratio indicates less reliance on borrowed funds. Generally, below 1 is considered healthy.",
    tags: [],
  },
  {
    term: "Delivery Trading",
    definition:
      "Buying shares and holding them in your demat account beyond the trading day (T+1 settlement). Unlike intraday, you take actual ownership of the shares.",
    tags: [],
  },
  {
    term: "Demat Account",
    definition:
      "A dematerialized account that holds shares and securities in electronic form, eliminating the need for physical certificates. Required to trade on Indian stock exchanges.",
    tags: [],
  },
  {
    term: "DII",
    definition:
      "Domestic Institutional Investor. Indian institutions such as mutual funds, insurance companies, and banks that invest in the stock market. DII flows often counterbalance FII activity.",
    tags: [],
  },
  {
    term: "Dividend",
    definition:
      "A portion of a company's profits distributed to shareholders, usually per share. Can be in the form of cash or additional shares. Dividend yield is calculated as annual dividend divided by share price.",
    tags: [],
  },
  {
    term: "Dividend Yield",
    definition:
      "Annual dividend per share divided by the current share price, expressed as a percentage. A high yield may indicate value but could also signal a falling stock price.",
    tags: [],
  },
  {
    term: "DRHP",
    definition:
      "Draft Red Herring Prospectus. A preliminary document filed with SEBI by a company planning an IPO, containing financial details and information about the offering.",
    tags: [],
  },
  {
    term: "DVR Shares",
    definition:
      "Differential Voting Rights shares. Shares that have fewer voting rights compared to ordinary shares but may offer higher dividends. Tata Motors DVR is a well-known example in India.",
    tags: [],
  },
  // E
  {
    term: "EBITDA",
    definition:
      "Earnings Before Interest, Taxes, Depreciation, and Amortization. A measure of a company's operating performance that strips out non-operational costs.",
    tags: [],
  },
  {
    term: "EPS",
    definition:
      "Earnings Per Share. A company's net profit divided by its total outstanding shares, indicating profitability on a per-share basis.",
    tags: [],
  },
  {
    term: "Equity",
    definition:
      "Ownership interest in a company, represented by shares. Equity shareholders bear the highest risk but also have the potential for the highest returns.",
    tags: [],
  },
  {
    term: "ETF",
    definition:
      "Exchange-Traded Fund. A fund that tracks an index, commodity, or basket of assets and is traded on stock exchanges like regular shares. Nifty BeES and Gold BeES are popular Indian ETFs.",
    tags: [],
  },
  {
    term: "Ex-Date",
    definition:
      "The date on or after which a stock trades without the declared dividend, bonus, or split. You must own the stock before the ex-date to be eligible for the corporate action.",
    tags: [],
  },
  {
    term: "Expense Ratio",
    definition:
      "The annual fee charged by a mutual fund or ETF as a percentage of assets under management. Lower expense ratios mean more of your returns stay with you.",
    tags: [],
  },
  // F
  {
    term: "F&O",
    definition:
      "Futures & Options. Derivative instruments traded on NSE/BSE that derive their value from underlying assets like stocks or indices. Used for hedging and speculation.",
    tags: [],
  },
  {
    term: "Face Value",
    definition:
      "The nominal or par value of a share as stated in the company's charter. In India, common face values are Rs 1, Rs 2, Rs 5, or Rs 10. Not to be confused with market price.",
    tags: [],
  },
  {
    term: "FIFO",
    definition:
      "First In, First Out. A method of matching buy and sell trades where the earliest purchased shares are considered sold first. UseMoney uses FIFO for trade pairing.",
    tags: [],
  },
  {
    term: "FII",
    definition:
      "Foreign Institutional Investor. An investor or fund registered in a country outside India that invests in Indian financial markets. FII flows significantly impact market direction.",
    tags: [],
  },
  {
    term: "FIRE",
    definition:
      "Financial Independence, Retire Early. A movement focused on aggressive saving and investing to achieve financial independence and retire much earlier than traditional retirement age.",
    tags: [],
  },
  {
    term: "FPO",
    definition:
      "Follow-on Public Offer. An issuance of shares by a company that is already publicly listed, used to raise additional capital.",
    tags: [],
  },
  {
    term: "Free Float",
    definition:
      "The portion of a company's shares that are available for trading by the general public, excluding promoter holdings, locked-in shares, and strategic holdings.",
    tags: [],
  },
  {
    term: "Fundamental Analysis",
    definition:
      "A method of evaluating a security by examining financial statements, industry conditions, management quality, and economic factors to determine its intrinsic value.",
    tags: [],
  },
  {
    term: "Futures Contract",
    definition:
      "A standardized agreement to buy or sell an asset at a predetermined price on a specific future date. In India, stock and index futures expire on the last Thursday of each month.",
    tags: [],
  },
  // G
  {
    term: "Gap Up / Gap Down",
    definition:
      "When a stock opens significantly higher (gap up) or lower (gap down) than the previous day's close, creating a visible gap on the price chart. Often caused by overnight news or events.",
    tags: [],
  },
  {
    term: "Gratuity",
    definition:
      "A lump-sum benefit paid by an employer to an employee upon retirement or resignation, based on years of service. Relevant for FIRE planning as a retirement income component.",
    tags: [],
  },
  {
    term: "Green Shoe Option",
    definition:
      "An over-allotment option in an IPO that allows underwriters to sell additional shares (up to 15% more) if demand exceeds the original offering size.",
    tags: [],
  },
  // H
  {
    term: "Hedge",
    definition:
      "An investment strategy to reduce risk of adverse price movements. In India, traders commonly hedge equity positions using Nifty or stock futures and options.",
    tags: [],
  },
  {
    term: "HNI",
    definition:
      "High Net-worth Individual. In IPO context, investors applying for shares worth more than Rs 2 lakh are categorized as HNIs (Non-Institutional Investors).",
    tags: [],
  },
  {
    term: "Holding Period",
    definition:
      "The duration for which an investor holds a security. Determines tax treatment: equity held over 12 months qualifies for LTCG rates in India.",
    tags: [],
  },
  // I
  {
    term: "Index Fund",
    definition:
      "A mutual fund or ETF that replicates a market index (like Nifty 50 or Sensex) by holding the same stocks in the same proportions. Known for low expense ratios and passive management.",
    tags: [],
  },
  {
    term: "Inflation",
    definition:
      "The rate at which the general level of prices for goods and services rises, eroding purchasing power. Critical for FIRE planning - your corpus must grow faster than inflation.",
    tags: [],
  },
  {
    term: "Insider Trading",
    definition:
      "Illegal practice of trading securities based on material, non-public information. SEBI actively monitors and penalizes insider trading in Indian markets.",
    tags: [],
  },
  {
    term: "Intraday Trading",
    definition:
      "Buying and selling securities within the same trading day. All positions are squared off before market close, with no overnight holding.",
    tags: [],
  },
  {
    term: "IPO",
    definition:
      "Initial Public Offering. The first time a company offers its shares to the public on a stock exchange, allowing retail investors to buy ownership stakes.",
    tags: [],
  },
  // K
  {
    term: "KYC",
    definition:
      "Know Your Customer. A mandatory verification process required by SEBI before opening a demat or trading account. Involves identity and address verification via Aadhaar, PAN, etc.",
    tags: [],
  },
  // L
  {
    term: "Large Cap",
    definition:
      "Companies ranked 1st to 100th by market capitalization on NSE. These are well-established, financially stable companies like Reliance, TCS, and HDFC Bank.",
    tags: [],
  },
  {
    term: "Leverage",
    definition:
      "Using borrowed capital to increase the potential return of an investment. In F&O trading, leverage allows controlling larger positions with smaller margin amounts.",
    tags: [],
  },
  {
    term: "Limit Order",
    definition:
      "An order to buy or sell a stock at a specific price or better. A buy limit order executes at or below the limit price; a sell limit order at or above.",
    tags: [],
  },
  {
    term: "Liquidity",
    definition:
      "The ease with which a security can be bought or sold without significantly affecting its price. High-volume stocks like Reliance and TCS have high liquidity.",
    tags: [],
  },
  {
    term: "Lot Size",
    definition:
      "The fixed number of shares in one F&O contract. Each stock has a different lot size set by the exchange (e.g., Nifty lot size is 25, Bank Nifty is 15).",
    tags: [],
  },
  {
    term: "LTCG",
    definition:
      "Long Term Capital Gains. Profits from selling equity shares held for more than 12 months. In India, LTCG above 1.25 lakh per year is taxed at 12.5%.",
    tags: [],
  },
  {
    term: "Lump Sum",
    definition:
      "Investing a large amount of money at one time, as opposed to spreading it over regular intervals (SIP). Timing matters more with lump sum investing.",
    tags: [],
  },
  // M
  {
    term: "Margin",
    definition:
      "The collateral deposited with a broker to cover the risk of a trade. In F&O, initial margin and maintenance margin are required. In intraday, brokers offer margin funding for higher exposure.",
    tags: [],
  },
  {
    term: "Margin Call",
    definition:
      "A demand from a broker for the investor to deposit additional funds or securities when the margin account falls below the maintenance requirement.",
    tags: [],
  },
  {
    term: "Market Cap",
    definition:
      "Market Capitalization. The total market value of a company's outstanding shares, calculated as share price multiplied by total shares outstanding.",
    tags: [],
  },
  {
    term: "Market Maker",
    definition:
      "A firm or individual that provides liquidity by continuously quoting buy and sell prices for securities, facilitating smooth trading.",
    tags: [],
  },
  {
    term: "Market Order",
    definition:
      "An order to buy or sell a stock immediately at the best available current price. Guarantees execution but not the exact price.",
    tags: [],
  },
  {
    term: "Mid Cap",
    definition:
      "Companies ranked 101st to 250th by market capitalization on NSE. These offer a balance between growth potential and stability.",
    tags: [],
  },
  {
    term: "Moving Average",
    definition:
      "A technical indicator that smooths price data over a specific period (e.g., 50-day or 200-day MA). Used to identify trends and support/resistance levels.",
    tags: [],
  },
  {
    term: "Mutual Fund",
    definition:
      "A professionally managed investment fund that pools money from many investors to purchase a diversified portfolio of stocks, bonds, or other securities.",
    tags: [],
  },
  // N
  {
    term: "NAV",
    definition:
      "Net Asset Value. The per-unit value of a mutual fund, calculated by dividing the total value of all assets minus liabilities by the number of outstanding units.",
    tags: [],
  },
  {
    term: "NCD",
    definition:
      "Non-Convertible Debenture. A fixed-income debt instrument that cannot be converted into equity. Offers higher interest rates than fixed deposits but carries credit risk.",
    tags: [],
  },
  {
    term: "NFO",
    definition:
      "New Fund Offer. The initial subscription period for a new mutual fund scheme, similar to an IPO for stocks. Units are typically offered at Rs 10 NAV.",
    tags: [],
  },
  {
    term: "Nifty 50",
    definition:
      "The benchmark stock market index of NSE, comprising 50 of the largest and most liquid Indian companies across 13 sectors.",
    tags: [],
  },
  {
    term: "NPA",
    definition:
      "Non-Performing Asset. A loan or advance where the borrower has stopped making interest or principal payments. A key metric for evaluating banking stocks.",
    tags: [],
  },
  {
    term: "NRI Investment",
    definition:
      "Non-Resident Indians can invest in Indian markets through Portfolio Investment Scheme (PIS) via NRE/NRO demat accounts with SEBI-registered brokers.",
    tags: [],
  },
  {
    term: "NSE",
    definition:
      "National Stock Exchange of India. The leading stock exchange in India by trading volume, headquartered in Mumbai.",
    tags: [],
  },
  // O
  {
    term: "OFS",
    definition:
      "Offer For Sale. A mechanism for promoters of listed companies to sell shares to the public through the stock exchange. Common for government disinvestment.",
    tags: [],
  },
  {
    term: "Open Interest",
    definition:
      "The total number of outstanding F&O contracts that have not been settled. Rising open interest with rising prices suggests a strong uptrend.",
    tags: [],
  },
  {
    term: "Option Premium",
    definition:
      "The price paid by the buyer to the seller for an options contract. Comprises intrinsic value (in-the-money amount) and time value.",
    tags: [],
  },
  // P
  {
    term: "P/B Ratio",
    definition:
      "Price-to-Book Ratio. A stock's market price divided by its book value per share. A lower P/B may indicate an undervalued stock.",
    tags: [],
  },
  {
    term: "P/E Ratio",
    definition:
      "Price-to-Earnings Ratio. A stock's current price divided by its earnings per share. Used to assess whether a stock is overvalued or undervalued relative to its earnings.",
    tags: [],
  },
  {
    term: "P&L",
    definition:
      "Profit and Loss. The net gain or loss from your investments. UseMoney tracks both realized P&L (closed trades) and unrealized P&L (open holdings).",
    tags: [],
  },
  {
    term: "PAN",
    definition:
      "Permanent Account Number. A 10-digit alphanumeric identity issued by the Income Tax Department. Mandatory for all stock market transactions and KYC in India.",
    tags: [],
  },
  {
    term: "Pledge",
    definition:
      "Shares held in a demat account that are pledged as collateral to a lender or broker. Pledged shares remain in your account but cannot be sold until released.",
    tags: [],
  },
  {
    term: "Portfolio",
    definition:
      "The collection of all financial investments held by an individual or institution, including stocks, mutual funds, bonds, and other assets.",
    tags: [],
  },
  {
    term: "PPF",
    definition:
      "Public Provident Fund. A government-backed long-term savings scheme with tax benefits under Section 80C. Lock-in period of 15 years. Relevant for FIRE planning as a safe asset.",
    tags: [],
  },
  {
    term: "Promoter",
    definition:
      "The founders or controlling shareholders of a company. High promoter holding (above 50%) can indicate management confidence. SEBI mandates disclosure of promoter holdings.",
    tags: [],
  },
  {
    term: "Put Option",
    definition:
      "A derivative contract that gives the buyer the right (but not obligation) to sell an underlying asset at a specified strike price before or on the expiry date.",
    tags: [],
  },
  // R
  {
    term: "RBI",
    definition:
      "Reserve Bank of India. India's central bank that controls monetary policy, interest rates, and banking regulation. RBI decisions significantly impact stock and bond markets.",
    tags: [],
  },
  {
    term: "Record Date",
    definition:
      "The date set by a company to determine which shareholders are eligible to receive dividends, bonuses, or participate in rights issues.",
    tags: [],
  },
  {
    term: "Resistance",
    definition:
      "A price level where selling pressure tends to prevent a stock from rising further. A technical analysis concept used to identify potential exit points.",
    tags: [],
  },
  {
    term: "Rights Issue",
    definition:
      "An offer by a company to existing shareholders to purchase additional shares at a discounted price, in proportion to their current holdings.",
    tags: [],
  },
  {
    term: "ROCE",
    definition:
      "Return on Capital Employed. A profitability ratio that measures how efficiently a company generates profits from its total capital (equity + debt).",
    tags: [],
  },
  {
    term: "ROE",
    definition:
      "Return on Equity. Net income divided by shareholders' equity, measuring how effectively a company uses equity to generate profits. Higher ROE indicates better profitability.",
    tags: [],
  },
  {
    term: "RSI",
    definition:
      "Relative Strength Index. A momentum indicator ranging from 0 to 100. RSI above 70 suggests overbought conditions; below 30 suggests oversold conditions.",
    tags: [],
  },
  {
    term: "Rupee Cost Averaging",
    definition:
      "The strategy of investing a fixed amount at regular intervals (via SIP), which automatically buys more units when prices are low and fewer when prices are high.",
    tags: [],
  },
  // S
  {
    term: "SEBI",
    definition:
      "Securities and Exchange Board of India. The regulatory authority that oversees and regulates the securities market in India to protect investor interests.",
    tags: [],
  },
  {
    term: "Sector Rotation",
    definition:
      "The movement of investment capital from one industry sector to another as investors anticipate the next stage of the economic cycle.",
    tags: [],
  },
  {
    term: "Sensex",
    definition:
      "The benchmark index of BSE (Bombay Stock Exchange), comprising 30 of the largest and most actively traded companies on BSE.",
    tags: [],
  },
  {
    term: "SGB",
    definition:
      "Sovereign Gold Bond. Government securities denominated in grams of gold, issued by RBI. Offer an alternative to holding physical gold with 2.5% annual interest.",
    tags: [],
  },
  {
    term: "SIP",
    definition:
      "Systematic Investment Plan. A method of investing a fixed amount regularly (usually monthly) in a mutual fund, enabling rupee-cost averaging and disciplined investing.",
    tags: [],
  },
  {
    term: "SLB",
    definition:
      "Securities Lending and Borrowing. A mechanism where an investor lends securities they own to a borrower in exchange for a fee, facilitating short selling.",
    tags: [],
  },
  {
    term: "Small Cap",
    definition:
      "Companies ranked 251st and below by market capitalization on NSE. These are smaller companies with higher growth potential but also higher risk.",
    tags: [],
  },
  {
    term: "STCG",
    definition:
      "Short Term Capital Gains. Profits from selling equity shares held for 12 months or less. In India, STCG on equity is taxed at 20%.",
    tags: [],
  },
  {
    term: "Stock Split",
    definition:
      "A corporate action where a company divides its existing shares into multiple shares (e.g., 1:5 split turns one Rs 500 share into five Rs 100 shares). Total value stays the same.",
    tags: [],
  },
  {
    term: "Stop Loss",
    definition:
      "An order placed to sell a security when it reaches a specific price, designed to limit potential losses on a position. Essential for risk management.",
    tags: [],
  },
  {
    term: "STT",
    definition:
      "Securities Transaction Tax. A tax levied on every purchase and sale of securities listed on Indian stock exchanges. Applied at the time of transaction.",
    tags: [],
  },
  {
    term: "Support",
    definition:
      "A price level where buying pressure tends to prevent a stock from falling further. A technical analysis concept used to identify potential entry points.",
    tags: [],
  },
  {
    term: "SWP",
    definition:
      "Systematic Withdrawal Plan. A facility to withdraw a fixed amount from a mutual fund at regular intervals. Often used in retirement to create a steady income stream.",
    tags: [],
  },
  // T
  {
    term: "T+1 Settlement",
    definition:
      "India's stock settlement cycle where trades settle one business day after execution. Shares are credited/debited to demat accounts on T+1.",
    tags: [],
  },
  {
    term: "Technical Analysis",
    definition:
      "A method of evaluating securities by analyzing price charts, volume, and statistical indicators. Focuses on historical price patterns to predict future movements.",
    tags: [],
  },
  {
    term: "Theta Decay",
    definition:
      "The rate at which an option's value decreases as it approaches expiry. Options lose time value faster as expiration nears, which benefits option sellers.",
    tags: [],
  },
  {
    term: "Trailing Stop Loss",
    definition:
      "A dynamic stop loss that moves with the price. If a stock rises, the stop loss rises too, locking in profits while still providing downside protection.",
    tags: [],
  },
  // U
  {
    term: "ULIP",
    definition:
      "Unit Linked Insurance Plan. An insurance-cum-investment product that offers both life cover and market-linked returns. Has higher charges compared to term insurance + mutual funds.",
    tags: [],
  },
  {
    term: "Unrealized P&L",
    definition:
      "The profit or loss on open holdings calculated at the current market price. It becomes realized P&L only when the position is closed (sold).",
    tags: [],
  },
  {
    term: "Upper / Lower Circuit",
    definition:
      "The maximum price a stock can rise (upper) or fall (lower) in a single trading day. When hit, trading is halted. SEBI sets circuit limits at 2%, 5%, 10%, or 20%.",
    tags: [],
  },
  // V
  {
    term: "Volatility",
    definition:
      "A statistical measure of the dispersion of returns for a security. Higher volatility means the price can change dramatically in either direction over a short period.",
    tags: [],
  },
  {
    term: "Volume",
    definition:
      "The number of shares or contracts traded during a given period. High volume indicates strong interest and liquidity; low volume may signal weak conviction.",
    tags: [],
  },
  {
    term: "VWAP",
    definition:
      "Volume Weighted Average Price. The average price a stock traded at throughout the day, weighted by volume. Used by institutional traders to assess trade execution quality.",
    tags: [],
  },
  // W
  {
    term: "Watchlist",
    definition:
      "A curated list of securities you are monitoring without owning. UseMoney allows you to create watchlists to track potential investments before committing capital.",
    tags: [],
  },
  {
    term: "Working Capital",
    definition:
      "Current assets minus current liabilities. A measure of a company's short-term financial health and its ability to meet day-to-day operational expenses.",
    tags: [],
  },
  // X
  {
    term: "XIRR",
    definition:
      "Extended Internal Rate of Return. A method to calculate returns on investments with irregular cash flows (like SIPs). More accurate than CAGR for mutual fund SIP returns.",
    tags: [],
  },
  // Y
  {
    term: "Yield",
    definition:
      "The income return on an investment, expressed as a percentage. For stocks, this is dividend yield; for bonds, it is the coupon rate relative to the current price.",
    tags: [],
  },
  {
    term: "YTD",
    definition:
      "Year To Date. The period from the beginning of the current calendar year to the present date. YTD returns show how an investment has performed since January 1st.",
    tags: [],
  },
  // Z
  {
    term: "Zero Coupon Bond",
    definition:
      "A bond that does not pay periodic interest. Instead, it is issued at a discount to its face value and redeemed at par on maturity. The difference is the investor's return.",
    tags: [],
  },
  // Numeric
  {
    term: "52-Week High/Low",
    definition:
      "The highest and lowest prices at which a stock has traded during the past 52 weeks (one year). Stocks near 52-week highs may indicate strength; near 52-week lows may indicate weakness or value.",
    tags: [],
  },
  {
    term: "80C Deduction",
    definition:
      "Section 80C of the Income Tax Act allows deductions up to Rs 1.5 lakh per year for investments in ELSS mutual funds, PPF, EPF, NPS, and other specified instruments.",
    tags: [],
  },
].map((t) => ({ ...t, tags: getTagsForTerm(t.term) }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(term: string): string {
  return term
    .toLowerCase()
    .replace(/[&]/g, "and")
    .replace(/[/]/g, "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build minimal BlockNote JSON content from a definition string.
 */
function toBlockNoteJson(definition: string): string {
  return JSON.stringify([
    {
      id: Math.random().toString(36).substring(2, 10),
      type: "paragraph",
      props: {
        textColor: "default",
        backgroundColor: "default",
        textAlignment: "left",
      },
      content: [{ type: "text", text: definition }],
      children: [],
    },
  ]);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Seed Glossary ===\n");

  // 1. Find author by canonical email, then fallback to any author
  const DEFAULT_AUTHOR_EMAIL = "deepshaswat@gmail.com";
  let author = await prisma.contentAuthor.findFirst({
    where: { email: DEFAULT_AUTHOR_EMAIL },
  });

  if (!author) {
    // Fallback: try finding any existing author
    author = await prisma.contentAuthor.findFirst();
  }

  if (!author) {
    console.error("No ContentAuthor found. Create one in the CMS first.");
    console.error(
      `  Expected: ContentAuthor with email "${DEFAULT_AUTHOR_EMAIL}"`,
    );
    console.error(
      "  Or: at least one ContentAuthor record in content_authors collection.",
    );
    process.exit(1);
  }

  console.log(`Using author: ${author.name || author.username} (${author.id})`);

  // 2. Create/find tags
  const tagIdMap = new Map<string, string>();
  for (const [slug, def] of Object.entries(TAG_DEFINITIONS)) {
    let tag = await prisma.tag.findUnique({ where: { slug } });
    if (!tag) {
      tag = await prisma.tag.create({
        data: {
          slug,
          name: def.name,
          color: def.color,
          description: def.description,
        },
      });
      console.log(`  Created tag: ${def.name}`);
    }
    tagIdMap.set(slug, tag.id);
  }

  console.log(`\n${tagIdMap.size} tags ready.`);

  // 3. Create glossary posts
  let created = 0;
  let skipped = 0;

  for (const term of GLOSSARY_TERMS) {
    const postUrl = slugify(term.term);

    // Check if already exists
    const existing = await prisma.post.findUnique({ where: { postUrl } });
    if (existing) {
      skipped++;
      continue;
    }

    await prisma.post.create({
      data: {
        contentPlatform: "STOCKBOOK",
        contentType: "GLOSSARY",
        title: term.term,
        content: toBlockNoteJson(term.definition),
        postUrl,
        excerpt: term.definition,
        publishDate: new Date(),
        status: "PUBLISHED",
        isFeatured: false,
        isPremium: false,
        authorId: author.id,
        viewCount: 0,
        metadataTitle: `${term.term} - Financial Glossary`,
        metadataDescription: term.definition.substring(0, 160),
        metadataKeywords: `${term.term}, financial glossary, stock market terms, ${term.tags
          .map((t) => TAG_DEFINITIONS[t]?.name)
          .filter(Boolean)
          .join(", ")}`,
        tags: {
          create: term.tags
            .filter((slug) => tagIdMap.has(slug))
            .map((slug) => ({ tagId: tagIdMap.get(slug)! })),
        },
      },
    });

    created++;
  }

  console.log(`\nGlossary seed complete:`);
  console.log(`  Created: ${created}`);
  console.log(`  Skipped (already exist): ${skipped}`);
  console.log(`  Total terms: ${GLOSSARY_TERMS.length}`);
}

main()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
