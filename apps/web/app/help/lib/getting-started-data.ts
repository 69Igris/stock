export interface GettingStartedStep {
  step: number;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
  icon: string;
}

export const gettingStartedSteps: GettingStartedStep[] = [
  {
    step: 1,
    title: "Create Your Account",
    description:
      "Sign up with your email or Google account. It takes less than a minute. Your data is secure and encrypted.",
    href: "/sign-up",
    linkLabel: "Sign Up",
    icon: "UserPlus",
  },
  {
    step: 2,
    title: "Connect Your First Broker",
    description:
      "Link your Zerodha, Upstox, Angel One, Groww, Dhan, or Fyers account. We use secure OAuth - your credentials are never shared with us.",
    href: "/brokers",
    linkLabel: "Connect Broker",
    icon: "Link2",
  },
  {
    step: 3,
    title: "View Your Portfolio Dashboard",
    description:
      "Once connected, your holdings, positions, and mutual funds sync automatically. See your total portfolio value, day change, and P&L at a glance.",
    href: "/dashboard",
    linkLabel: "Go to Dashboard",
    icon: "Activity",
  },
  {
    step: 4,
    title: "Import Trade History",
    description:
      "Upload CSV exports from your broker to import historical trades. UseMoney auto-detects the format and handles duplicates intelligently.",
    href: "/tradebook",
    linkLabel: "Import Trades",
    icon: "Upload",
  },
  {
    step: 5,
    title: "Ask StockSage Anything",
    description:
      "Use the AI chat on the dashboard to analyze your portfolio, research stocks, compare investments, or get personalized recommendations.",
    href: "/dashboard",
    linkLabel: "Try StockSage",
    icon: "Sparkles",
  },
  // "Practice with Paper Trading" step removed 2026-05-28 per product decision.
  // Remaining steps renumbered to stay contiguous.
  {
    step: 6,
    title: "Plan for FIRE",
    description:
      "Use the FIRE calculator to project your retirement corpus, estimate SIP returns, and calculate how many years until financial independence.",
    href: "/fire",
    linkLabel: "Open FIRE Calculator",
    icon: "Flame",
  },
  {
    step: 7,
    title: "Upgrade for More",
    description:
      "Unlock unlimited brokers, more AI queries, advanced analytics, and premium learning content by upgrading to Premium or Pro.",
    href: "/settings",
    linkLabel: "View Plans",
    icon: "Crown",
  },
];
