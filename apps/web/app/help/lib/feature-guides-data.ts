export interface FeatureGuide {
  title: string;
  description: string;
  href: string;
  icon: string;
}

export const featureGuides: FeatureGuide[] = [
  {
    title: "StockSage Chat",
    description:
      "Your AI-powered trading assistant in a full-page chat interface. Ask anything about stocks, analyse your portfolio, screen for opportunities, and get AI-powered recommendations - all through natural language.",
    href: "/dashboard",
    icon: "Sparkles",
  },
  {
    title: "AI Analysis",
    description:
      "Get instant stock research with scores and recommendations. Use keywords like 'deep dive' or 'comprehensive' for deeper analysis. Each level provides more data - from key metrics to DCF valuations and scenario analysis.",
    href: "/dashboard",
    icon: "Brain",
  },
  {
    title: "Stock Screening",
    description:
      "Screen 2,000+ stocks using natural language. Combine fundamental filters (PE, ROE, debt) with technical indicators (RSI, MACD) in a single query. Use pre-built strategies or build your own.",
    // MONEY-1254: was "/discover", which is the All Stocks browse page — the
    // card's own copy describes the SCREENER (PE/ROE/debt filters, RSI/MACD,
    // saved strategies), none of which lives there. The sidebar has always
    // pointed at /discover/screener; this card had drifted.
    //
    // Fixed by correcting the link, NOT by redirecting /discover: that route
    // is deliberately alive. MONEY-1131 kept it fetching the full `allStocks`
    // universe BECAUSE it renders it (the grid filters client-side), while
    // /discover/markets and /discover/screener were moved to a row-free
    // summary. Shell.tsx also maps "Markets" there.
    href: "/discover/screener",
    icon: "Filter",
  },
  {
    title: "Holdings",
    description:
      "View all your stock holdings across connected brokers. Use @mention for quick stock research, compare held stocks, and see sector-wise allocation. Filter by broker and sort by any column.",
    href: "/holdings",
    icon: "Briefcase",
  },
  {
    title: "Positions",
    description:
      "Track your open positions including F&O contracts. See entry price, current market price, and real-time P&L.",
    href: "/positions",
    icon: "Target",
  },
  {
    title: "Tradebook",
    description:
      "Complete trade history with FIFO-paired entries and exits. Import trades via CSV, auto-pair with AI, and analyse trading patterns. See win rate, average P&L, and best/worst trades.",
    href: "/tradebook",
    icon: "BookOpen",
  },
  {
    title: "Mutual Funds",
    description:
      "Track mutual fund investments with current NAV, returns, and category analysis. Compare funds head-to-head, analyse SIP performance, and discover new funds to invest in.",
    href: "/holdings?tab=mf",
    icon: "Landmark",
  },
  // Paper Trading feature guide removed 2026-05-28 per product decision.
  {
    title: "FIRE Calculator",
    description:
      "Plan for Financial Independence with AI-powered projections. Create multiple scenarios, calculate SIP returns, estimate retirement corpus needs, and track your Coast FIRE number.",
    href: "/fire",
    icon: "Flame",
  },
  {
    title: "Discovery",
    description:
      "Discover new investment opportunities with 28+ pre-built screening strategies. Find value stocks, growth plays, high-dividend payers, and trending picks based on fundamental and technical analysis.",
    href: "/discover",
    icon: "Search",
  },
  {
    title: "Brokers",
    description:
      "Connect and manage 6 supported brokers - Zerodha, Upstox, Angel One, Groww, Dhan, and Fyers. Auto-sync holdings, positions, trades, and mutual funds via secure OAuth.",
    href: "/brokers",
    icon: "Link2",
  },
  {
    title: "Settings & Credits",
    description:
      "Manage your account, subscription plan, and AI credit usage. View credit balance, usage history, and billing. Upgrade to unlock deeper analysis and more credits.",
    href: "/settings",
    icon: "Settings",
  },
];
