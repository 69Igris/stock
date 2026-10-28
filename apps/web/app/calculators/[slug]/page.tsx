/**
 * /calculators/[slug] - generic per-calculator page (B8 in MONEY-218-followup).
 *
 * Server component: validates the slug, renders chrome + page guard,
 * delegates form + result rendering to the client island. Unknown slugs
 * trigger Next.js notFound() so dead links never silently 404.
 */

import { notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";

import { CALC_CONFIGS, CALC_SLUGS } from "./configs";
import CalculatorClient from "./client";

// Next 15+ : the shared <Sidebar/> chrome and the calculator client island both
// read request-time `useSearchParams()`, which makes static prerendering bail
// ("useSearchParams should be wrapped in a suspense boundary"). This page was
// never meaningfully static (auth-gated app shell), so render it dynamically —
// matching every other authenticated app page. No user-visible behavior change.
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return CALC_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const cfg = CALC_CONFIGS[params.slug];
  // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
  if (!cfg) return { title: "Calculator" };
  return {
    title: cfg.name,
    description: cfg.blurb,
  };
}

export default async function CalculatorSlugPage(props: {
  params: Promise<{ slug: string }>;
}) {
  const params = await props.params;
  const cfg = CALC_CONFIGS[params.slug];
  if (!cfg) notFound();

  // MONEY-392: PageGuard moved inside the chrome (was wrapping the whole
  // page, which stripped the Sidebar + title during the guard's loading
  // state and caused a width jump from 920px → 1600px → 920px).
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[920px] mx-auto">
          <Link
            href="/calculators"
            className="inline-flex items-center gap-1 text-[12px] text-[var(--ink-3)] hover:text-[var(--emerald-text)] mb-3 transition-colors"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            All calculators
          </Link>

          {/* Playful page header (pf-ph idiom, rendered inline). */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                TOOLS · CALCULATORS{cfg.badge ? ` · ${cfg.badge}` : ""}
              </div>
              <h1>{cfg.name}</h1>
              <div className="sub">{cfg.blurb}</div>
            </div>
            <div className="r">
              <span className="pf-pill outline">BETA</span>
            </div>
          </div>

          <PageGuard route="/discover" bare>
            <CalculatorClient config={cfg} />
          </PageGuard>
        </div>
      </main>
    </div>
  );
}
