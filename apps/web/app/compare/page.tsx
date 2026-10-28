// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

/**
 * Fund Comparison Page - Server Component
 *
 * Canonical: /compare?items=MF:119551,MF:120505,ETF:NIFTYBEES,INDEX:NIFTY 50
 * Legacy:    /compare?funds=...  (back-compat alias for the original schema)
 *
 * Single-item entries (count === 1) render the picker so the user can add
 * more funds inline instead of bouncing back to /discover. Empty / invalid
 * queries also surface the picker - no more silent redirects.
 *
 * Stock comparison flows through `/analysis` as a peer-comparison research
 * session - see the /discover stocks-Compare branch (`startResearchAction`
 * with skill `peer-comparison`). NOT this page.
 */

import {
  getComparisonDataAction,
  type ComparisonData,
} from "@/lib/actions/fund-comparison";
import { parseCompareQuery } from "@/lib/compare/schema";
import CompareClient from "./client";

interface ComparePageProps {
  searchParams: Promise<{ items?: string; funds?: string }>;
}

export default async function ComparePage({ searchParams }: ComparePageProps) {
  const { items, funds } = await searchParams;
  const parsed = parseCompareQuery(items, funds);

  // Empty or single-item - render the picker. CompareClient short-circuits
  // to its empty-state branch when funds.length === 0.
  if (parsed.items.length === 0 || parsed.needsPicker) {
    return (
      <CompareClient
        funds={[]}
        navHistory={{}}
        compositions={{}}
        seedItems={parsed.items}
        error={
          parsed.items.length === 0
            ? "Pick at least 2 funds to compare."
            : undefined
        }
      />
    );
  }

  const result = await getComparisonDataAction(parsed.items);
  const data: ComparisonData | null =
    result?.success && result?.data ? result?.data : null;

  return (
    <CompareClient
      funds={data?.funds ?? []}
      navHistory={data?.navHistory ?? {}}
      compositions={data?.compositions ?? {}}
      error={result?.success ? undefined : result?.error}
    />
  );
}

export function generateMetadata() {
  return {
    // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
    title: "Compare",
    description: "Compare stocks, mutual funds, and ETFs side by side",
  };
}
