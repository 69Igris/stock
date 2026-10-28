export interface FAQItem {
  question: string;
  answer: string;
}

export interface FAQSection {
  id: string;
  title: string;
  icon: string;
  items: FAQItem[];
}

export const faqSections: FAQSection[] = [
  {
    id: "account-billing",
    title: "Account & Billing",
    icon: "CreditCard",
    items: [
      {
        question: "What plans does UseMoney offer?",
        answer:
          "UseMoney offers three plans: Free (1 broker, basic analytics), Premium (unlimited brokers, AI chat, learning content), and Pro (everything in Premium plus advanced analytics and priority support). Visit the pricing page for current rates.",
      },
      {
        question: "How do I upgrade my plan?",
        answer:
          "Go to Settings > Subscription and click 'Upgrade'. You can pay via UPI, cards, or net banking through our payment partner Dodo Payments. Upgrades take effect immediately.",
      },
      {
        question: "Can I try premium features before paying?",
        answer:
          "Free accounts get a limited number of AI queries to try StockSage. The FIRE calculator is available on all plans. Connect one broker for free to explore the dashboard.",
      },
      {
        question: "How do I cancel my subscription?",
        answer:
          "Go to Settings > Subscription and click 'Manage Subscription'. You can downgrade at any time. Your premium features remain active until the end of your billing period.",
      },
      {
        question: "Is my payment information secure?",
        answer:
          "UseMoney never stores your payment details. All payments are processed securely by Dodo Payments, a PCI DSS compliant payment processor.",
      },
      {
        question: "Do you offer refunds?",
        answer:
          "We do not offer refunds. When you cancel or downgrade, your current billing term is honored to its expiry date and the plan changes only after that — you continue to enjoy your paid features until the term ends, so no time is lost. If a payment was processed in error, contact support through the Settings page.",
      },
    ],
  },
  {
    id: "broker-data",
    title: "Broker & Data",
    icon: "Link2",
    items: [
      {
        question: "Which brokers does UseMoney support?",
        answer:
          "UseMoney supports six Indian brokers: Zerodha (Kite), Upstox, Angel One (SmartAPI), Groww, Dhan, and Fyers. We're actively adding more brokers.",
      },
      {
        question: "Is it safe to connect my broker account?",
        answer:
          "Absolutely. We use OAuth-based authentication - you log in directly on your broker's website and grant read-only access. Your broker credentials are never shared with us. API tokens are encrypted with AES-256-GCM encryption at rest.",
      },
      {
        question: "How often does portfolio data sync?",
        answer:
          "Portfolio data is synced when you log in and can be manually refreshed anytime using the Sync button on the dashboard. Data is cached with a multi-layer system (memory + Redis) for fast loading.",
      },
      {
        question: "Can I import trades from CSV files?",
        answer:
          "Yes! Go to Tradebook > Import and upload your broker's CSV export. UseMoney auto-detects the broker format, handles duplicate detection across sources, and maintains import history.",
      },
      {
        question: "How does the FIFO trade pairing work?",
        answer:
          "UseMoney uses First In, First Out (FIFO) matching to pair your buy and sell trades. Trades are grouped by symbol, exchange, and broker. Partial fills are handled through row splitting to give accurate P&L for each trade pair.",
      },
      {
        question: "Why don't I see all my trades?",
        answer:
          "Broker APIs typically provide the last 1-2 years of trade history. For older trades, use the CSV import feature. Also check that your broker connection is active in the Brokers page.",
      },
      {
        question: "Can I connect multiple accounts from the same broker?",
        answer:
          "Currently, UseMoney supports one connection per broker. If you have multiple Zerodha accounts, for example, you can connect one and import trades from the other via CSV.",
      },
    ],
  },
  {
    id: "ai-chat",
    title: "AI & Chat",
    icon: "Sparkles",
    items: [
      {
        question: "What is StockSage?",
        answer:
          "StockSage is UseMoney's AI-powered trading assistant built on Google Gemini. It can analyze your portfolio, research stocks, answer investment questions, and provide insights based on your actual holdings and trades.",
      },
      {
        question: "What's the difference between fast and advanced queries?",
        answer:
          "Fast queries use a lighter AI model for quick answers like portfolio lookups and simple calculations. Advanced queries use a more powerful model for complex analysis like DCF valuations, multi-stock comparisons, and detailed research.",
      },
      {
        question: "How many AI queries do I get?",
        answer:
          "Query limits depend on your plan. Free users get a limited trial. Premium users get a generous monthly allocation of both fast and advanced queries. Pro users get higher limits. Check Settings > Subscription for your current usage.",
      },
      {
        question: "Can StockSage execute trades for me?",
        answer:
          "No. StockSage is an analysis and advisory tool only. It cannot place, modify, or cancel orders on your behalf. All trading actions must be done directly through your broker's platform.",
      },
      {
        question: "Is my chat history saved?",
        answer:
          "Yes, your conversations are saved and accessible from the Chat History page in the sidebar. You can revisit past analyses and continue previous conversations.",
      },
      {
        question: "What kind of questions can I ask StockSage?",
        answer:
          "You can ask about your portfolio (holdings, P&L, trades), research any stock (fundamentals, valuation, comparison), plan for FIRE (retirement corpus, SIP projections), or get general investment education. Check the Prompt Library tab for example prompts.",
      },
    ],
  },
  {
    id: "portfolio-analytics",
    title: "Portfolio & Analytics",
    icon: "PieChart",
    items: [
      {
        question: "How is my portfolio value calculated?",
        answer:
          "Your total portfolio value is the sum of all holdings (at current market price), open F&O positions, and mutual fund investments across all connected brokers.",
      },
      {
        question: "What does 'day change' mean?",
        answer:
          "Day change shows the total profit or loss across your portfolio since the market opened today. It includes changes in holdings value, open positions, and mutual fund NAV movements.",
      },
      {
        question: "How are realized and unrealized P&L different?",
        answer:
          "Realized P&L is the actual profit/loss from closed trades (you've sold the shares). Unrealized P&L is the paper profit/loss on holdings you still own, calculated using current market price vs your average buy price.",
      },
      {
        question: "Can I see sector-wise allocation?",
        answer:
          "Yes! Ask StockSage 'Show my holdings grouped by sector with allocation percentage' or use the Investment Analysis page for a detailed breakdown of your portfolio by sector, market cap, and more.",
      },
      {
        question: "How do I export my trade data?",
        answer:
          "Currently, you can view all trade data in the Tradebook page. Export functionality is being enhanced. In the meantime, you can use the AI chat to generate summaries and analysis of your trading performance.",
      },
    ],
  },
  // Paper Trading FAQ section removed 2026-05-28 per product decision.
  {
    id: "fire-planning",
    title: "FIRE & Retirement",
    icon: "Flame",
    items: [
      {
        question: "What is the FIRE Calculator?",
        answer:
          "FIRE stands for Financial Independence, Retire Early. The calculator helps you plan your path to financial independence by projecting SIP returns, estimating retirement corpus needs, and calculating how many years until you can retire based on your savings rate.",
      },
      {
        question: "What is a FIRE number?",
        answer:
          "Your FIRE number is the corpus you need to sustain your lifestyle without working. It's typically calculated as 25x to 30x your annual expenses (based on the 4% or 3.3% safe withdrawal rate).",
      },
      {
        question: "What is Coast FIRE?",
        answer:
          "Coast FIRE is the point where your existing investments will grow to your full FIRE number by your target retirement age, even if you stop contributing. After reaching Coast FIRE, you only need to cover current expenses.",
      },
      {
        question: "How does the SIP projection work?",
        answer:
          "The SIP projection calculates future value of regular monthly investments at an expected rate of return, factoring in compounding. You can adjust the monthly amount, duration, and expected return rate.",
      },
      {
        question: "Does the FIRE calculator account for inflation?",
        answer:
          "Yes. When creating a FIRE scenario, you can set an expected inflation rate. The calculator adjusts your required corpus and projections to account for rising costs over time.",
      },
    ],
  },
  {
    id: "features-market",
    title: "Features & Indian Market",
    icon: "IndianRupee",
    items: [
      {
        question: "Does UseMoney support BSE stocks?",
        answer:
          "Yes! UseMoney supports stocks listed on both NSE and BSE. Your holdings and trades from either exchange are tracked and paired correctly.",
      },
      {
        question: "Can I track F&O positions?",
        answer:
          "Yes. UseMoney tracks Futures & Options positions from supported brokers. Open F&O positions are shown in the Positions page with real-time P&L calculations.",
      },
      {
        question: "Does UseMoney generate tax reports?",
        answer:
          "Tax report generation is on our roadmap. Currently, you can use the Tradebook's P&L data and export features to assist with tax filing. Full STCG/LTCG report generation is coming soon.",
      },
      {
        question: "What are the market trading hours?",
        answer:
          "Indian stock markets (NSE/BSE) trade from 9:15 AM to 3:30 PM IST on weekdays. Pre-open session is 9:00-9:15 AM. Markets are closed on weekends and designated holidays.",
      },
      {
        question: "Does UseMoney support mutual fund tracking?",
        answer:
          "Yes. Mutual funds synced from connected brokers (like Zerodha's Coin) appear in the Holdings page under the MF tab, showing current NAV, invested amount, and returns.",
      },
    ],
  },
  {
    id: "security-privacy",
    title: "Security & Privacy",
    icon: "Shield",
    items: [
      {
        question: "How is my data protected?",
        answer:
          "Your data is encrypted at rest and in transit. Broker API tokens are encrypted with AES-256-GCM encryption. We use Clerk for secure authentication with support for 2FA. All database access goes through server-side actions only.",
      },
      {
        question:
          "Can UseMoney access my broker's funds or trade on my behalf?",
        answer:
          "No. UseMoney only has read-only access to your broker data (holdings, positions, trades). We cannot place orders, transfer funds, or modify anything in your broker account.",
      },
      {
        question: "Who can see my portfolio data?",
        answer:
          "Only you. Your portfolio data is private and tied to your account. UseMoney employees do not have access to individual user portfolio data. There are no social or sharing features enabled by default.",
      },
      {
        question: "Can I delete my account and all data?",
        answer:
          "Yes. Contact support through Settings to request complete account deletion. All your data including portfolio history, chat logs, and broker connections will be permanently removed.",
      },
    ],
  },
];
