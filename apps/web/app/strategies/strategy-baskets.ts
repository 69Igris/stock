/**
 * Default stock baskets per strategy - what the backtest / forward run
 * against until the user customises the bucket. Each strategy gets ~9
 * NIFTY 500 names that fit its filter conditions, chosen by hand for
 * realistic per-stock credit math (1 × N for backtest, 3 × N for
 * forward).
 *
 * The catalog page renders these as a multi-select bucket on the
 * Detail page so the user can add / remove stocks before triggering a
 * run.
 */

export const DEFAULT_BASKETS: Record<string, string[]> = {
  "golden-cross": [
    "RELIANCE",
    "TCS",
    "HDFCBANK",
    "INFY",
    "ITC",
    "LT",
    "BAJFINANCE",
    "ASIANPAINT",
    "MARUTI",
  ],
  "12m-momentum": [
    "ADANIENT",
    "TATAMOTORS",
    "M&M",
    "TITAN",
    "BAJAJ-AUTO",
    "JSWSTEEL",
    "ADANIPORTS",
    "EICHERMOT",
    "POWERGRID",
  ],
  "magic-formula": [
    "HCLTECH",
    "TCS",
    "NMDC",
    "COALINDIA",
    "ONGC",
    "POWERGRID",
    "ITC",
    "GAIL",
    "NTPC",
  ],
  "roic-quality": [
    "ASIANPAINT",
    "PIDILITIND",
    "HINDUNILVR",
    "NESTLEIND",
    "BERGEPAINT",
    "PAGEIND",
    "TITAN",
    "BAJAJHLDNG",
    "AVANTIFEED",
  ],
  "rsi-mean-rev": [
    "PAYTM",
    "ZOMATO",
    "ADANIGREEN",
    "VEDL",
    "SAIL",
    "TATAPOWER",
    "JINDALSTEL",
    "DLF",
    "RECLTD",
  ],
  "cup-and-handle": [
    "TATASTEEL",
    "ULTRACEMCO",
    "GRASIM",
    "DRREDDY",
    "CIPLA",
    "TECHM",
    "WIPRO",
    "BHARTIARTL",
    "AXISBANK",
  ],
  "defensive-flexicap": [
    "HINDUNILVR",
    "NESTLEIND",
    "ITC",
    "BRITANNIA",
    "DABUR",
    "GODREJCP",
    "MARICO",
    "COLPAL",
    "PIDILITIND",
  ],
  "low-vol": [
    "HINDUNILVR",
    "NESTLEIND",
    "ITC",
    "BRITANNIA",
    "ASIANPAINT",
    "TCS",
    "INFY",
    "HCLTECH",
    "WIPRO",
  ],
  "dividend-aristocrats": [
    "ITC",
    "HINDUNILVR",
    "INFY",
    "TCS",
    "HDFCBANK",
    "POWERGRID",
    "COALINDIA",
    "NTPC",
    "ONGC",
  ],
  "52w-breakout": [
    "ADANIENT",
    "TATAMOTORS",
    "BAJFINANCE",
    "TITAN",
    "PERSISTENT",
    "MPHASIS",
    "DIVISLAB",
    "TVSMOTOR",
    "BHARTIARTL",
  ],
  "sector-rotation": [
    "INFY",
    "TCS",
    "RELIANCE",
    "ONGC",
    "TATAMOTORS",
    "MARUTI",
    "TATASTEEL",
    "JSWSTEEL",
    "HCLTECH",
  ],
  "deep-value": [
    "ONGC",
    "COALINDIA",
    "NMDC",
    "SAIL",
    "VEDL",
    "GAIL",
    "BPCL",
    "IOC",
    "HINDPETRO",
  ],
  "smallcap-momentum": [
    "FEDERALBNK",
    "RBLBANK",
    "IDFCFIRSTB",
    "INDIAMART",
    "POLYCAB",
    "ABBOTINDIA",
    "ASTRAL",
    "JUBLFOOD",
    "DEEPAKNTR",
  ],
  "earnings-surprise": [
    "RELIANCE",
    "INFY",
    "TCS",
    "HDFCBANK",
    "ICICIBANK",
    "BAJFINANCE",
    "MARUTI",
    "ASIANPAINT",
    "TITAN",
  ],
};

/**
 * Per-stock credit cost (cycle-5 user direction):
 *   Backtest = 1 credit × N stocks
 *   Forward  = 3 credits × N stocks
 */
export const CREDIT_PER_STOCK = {
  backtest: 1,
  forward: 3,
} as const;

export function getDefaultBasket(strategyId: string): string[] {
  return DEFAULT_BASKETS[strategyId] ?? [];
}

export function computeBacktestCredits(basket: string[]): number {
  return Math.max(1, basket.length) * CREDIT_PER_STOCK.backtest;
}

export function computeForwardCredits(basket: string[]): number {
  return Math.max(1, basket.length) * CREDIT_PER_STOCK.forward;
}
