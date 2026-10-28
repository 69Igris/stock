// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { Suspense } from "react";
import type { Metadata } from "next";
import { isDemoSession } from "@/lib/demo/session";
import AnalysisPageClient from "./client";
import { AnalysisSkeleton } from "@/components/skeletons";
import Sidebar from "@/components/Sidebar";

export const metadata: Metadata = {
  title: "Analysis Results",
};

export default async function AnalysisPage() {
  const isDemo = await isDemoSession();

  return (
    <Suspense
      fallback={
        <div className="pf-app min-h-screen">
          <Sidebar />
          <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
            <div className="p-6 pb-24">
              <AnalysisSkeleton />
            </div>
          </main>
        </div>
      }
    >
      <AnalysisPageClient isDemo={isDemo} />
    </Suspense>
  );
}
