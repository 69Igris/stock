/**
 * Research Lists - curated stock baskets shown on /discover/lists
 * (MONEY-197).
 *
 * v1 ships with seeded data inline so the page renders without a
 * Prisma migration. A follow-up ticket can move these to a
 * `ResearchList` collection if/when editorial workflow is needed.
 *
 * Each list has a methodology line, a tag (used for the colour pill),
 * a 1Y return, a benchmark return (Nifty 50), and the count of
 * constituent stocks. Lists are rebalanced monthly; the `updated`
 * field is human-formatted.
 */

export type ResearchListTone = "acc" | "vio" | "blue" | "warn" | "pos" | "neg";

export interface ResearchList {
  slug: string;
  name: string;
  description: string;
  stockCount: number;
  oneYearReturn: string;
  benchmarkReturn: string;
  updated: string;
  tag: string;
  tone: ResearchListTone;
}

export const RESEARCH_LISTS: readonly ResearchList[] = [
  {
    slug: "nifty-next-50-momentum",
    name: "Nifty Next 50 · Momentum Quintile",
    description: "Top 20% by 12-1 month momentum, rebalanced monthly",
    stockCount: 10,
    oneYearReturn: "+28.4%",
    benchmarkReturn: "+14.2%",
    updated: "Today",
    tag: "MOMENTUM",
    tone: "acc",
  },
  {
    slug: "india-dividend-kings",
    name: "India Dividend Kings",
    description: "15+ years of uninterrupted dividend growth · payout < 60%",
    stockCount: 14,
    oneYearReturn: "+12.8%",
    benchmarkReturn: "+14.2%",
    updated: "3d ago",
    tag: "INCOME",
    tone: "vio",
  },
  {
    slug: "midcap-quality-compounders",
    name: "Midcap Quality Compounders",
    description: "ROE > 20 · Debt/Equity < 0.5 · 5y EPS CAGR > 15",
    stockCount: 22,
    oneYearReturn: "+31.2%",
    benchmarkReturn: "+18.4%",
    updated: "Today",
    tag: "QUALITY",
    tone: "blue",
  },
  {
    slug: "emerging-export-plays",
    name: "Emerging Export Plays",
    description: "Export revenue > 40% · benefit from weak INR thesis",
    stockCount: 18,
    oneYearReturn: "+19.6%",
    benchmarkReturn: "+14.2%",
    updated: "Yesterday",
    tag: "THEMATIC",
    tone: "warn",
  },
  {
    slug: "turnaround-watch",
    name: "Turnaround Watch",
    description: "Debt reduction + margin recovery · high conviction",
    stockCount: 8,
    oneYearReturn: "+42.1%",
    benchmarkReturn: "+14.2%",
    updated: "Today",
    tag: "SPECIAL",
    tone: "acc",
  },
  {
    slug: "deep-value-below-book",
    name: "Deep Value · Below Book",
    description: "P/B < 1.2 · positive FCF · institutional holding > 15%",
    stockCount: 16,
    oneYearReturn: "+9.4%",
    benchmarkReturn: "+14.2%",
    updated: "5d ago",
    tag: "VALUE",
    tone: "blue",
  },
];

export const TONE_PILL: Record<ResearchListTone, string> = {
  acc: "bg-emerald-400/10 border-emerald-400/25 text-emerald-400",
  vio: "bg-violet-400/10 border-violet-400/25 text-violet-300",
  blue: "bg-sky-400/10 border-sky-400/25 text-sky-300",
  warn: "bg-amber-400/10 border-amber-400/25 text-amber-300",
  pos: "bg-emerald-400/10 border-emerald-400/25 text-emerald-400",
  neg: "bg-red-400/10 border-red-400/25 text-red-300",
};
