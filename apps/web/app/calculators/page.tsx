// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

/**
 * Calculators index - Dhan-parity suite (MONEY-208).
 *
 * Lists all financial + mutual-fund calculators with brief descriptions.
 * Per-calculator pages live at /calculators/[slug] and are wired to the
 * pure math primitives in @usemoney/core/calc.
 *
 * v1 ships the index + the math + tests; per-calc pages can be filled
 * in incrementally - each is a thin form over a single primitive.
 *
 * MONEY-485: re-skinned to the playful design system (pf-* primitives in
 * playful-app.css). The calculator grid renders as tilted-icon pf-cards;
 * the page wrapper/Sidebar shell + PageGuard are unchanged.
 */

import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import {
  Calculator,
  TrendingUp,
  Receipt,
  Banknote,
  PiggyBank,
  Target,
  Sparkles,
  Wallet,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";

export const metadata = {
  // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
  title: "Calculators",
  description:
    "SIP, EMI, FD, RD, NPS, Income Tax, Goal SIP, Step-up SIP, MF SWP, and XIRR calculators tailored for Indian markets.",
};

interface CalcEntry {
  slug: string;
  name: string;
  description: string;
  icon: typeof Calculator;
  /** pop-color CSS var for the tilted icon chip. */
  color: string;
}

const FINANCIAL: CalcEntry[] = [
  {
    slug: "sip",
    name: "SIP",
    description: "Systematic Investment Plan - fixed monthly + assumed return.",
    icon: TrendingUp,
    color: "var(--emerald)",
  },
  {
    slug: "lumpsum",
    name: "Lumpsum",
    description: "One-time investment compounded annually.",
    icon: Banknote,
    color: "var(--pop-3)",
  },
  {
    slug: "step-up-sip",
    name: "Step-up SIP",
    description: "Monthly SIP with annual percentage increase.",
    icon: TrendingUp,
    color: "var(--pop-2)",
  },
  {
    slug: "emi",
    name: "EMI",
    description: "Loan EMI + amortisation schedule.",
    icon: Calculator,
    color: "var(--pop-1)",
  },
  {
    slug: "fd",
    name: "FD",
    description: "Fixed deposit maturity with compounding frequency.",
    icon: PiggyBank,
    color: "var(--pop-5)",
  },
  {
    slug: "rd",
    name: "RD",
    description: "Recurring deposit with quarterly compounding.",
    icon: PiggyBank,
    color: "var(--pop-4)",
  },
  {
    slug: "nps",
    name: "NPS",
    description: "Retirement corpus + lump-sum / annuity split.",
    icon: Wallet,
    color: "var(--emerald)",
  },
  {
    slug: "income-tax",
    name: "Income Tax",
    description: "Old vs new regime comparison (FY 25-26).",
    icon: Receipt,
    color: "var(--pop-3)",
  },
];

const MUTUAL_FUND: CalcEntry[] = [
  {
    slug: "mf-lumpsum",
    name: "MF Lumpsum",
    description: "One-time MF investment with assumed or actual-fund return.",
    icon: Banknote,
    color: "var(--pop-3)",
  },
  {
    slug: "mf-sip",
    name: "MF SIP",
    description:
      "Monthly SIP - switch to actual-fund mode to use the chosen scheme's historical XIRR.",
    icon: TrendingUp,
    color: "var(--emerald)",
  },
  {
    slug: "mf-step-up-sip",
    name: "MF Step-up SIP",
    description: "Monthly SIP with annual step-up + assumed/actual return.",
    icon: TrendingUp,
    color: "var(--pop-2)",
  },
  {
    slug: "mf-goal-sip",
    name: "Goal SIP",
    description: "Back-solve monthly SIP to reach a target corpus.",
    icon: Target,
    color: "var(--pop-1)",
  },
  {
    slug: "mf-inflation-sip",
    name: "Inflation-adjusted SIP",
    description: "Real-return projection using nominal − inflation.",
    icon: Sparkles,
    color: "var(--pop-5)",
  },
  {
    slug: "mf-returns-xirr",
    name: "MF Returns (XIRR)",
    description: "Compute XIRR from your actual cashflow series.",
    icon: Calculator,
    color: "var(--pop-4)",
  },
  {
    slug: "mf-swp",
    name: "SWP",
    description: "Systematic withdrawal - projects when corpus depletes.",
    icon: Wallet,
    color: "var(--pop-3)",
  },
];

export default function CalculatorsIndexPage() {
  // MONEY-392: chrome (Sidebar + max-w-[1200px] container + title) lives
  // OUTSIDE PageGuard so the header stays visible during the guard's
  // loading state. PageGuard `bare` gates only the inner sections so it
  // doesn't render its own Sidebar/max-w-[1600px] chrome.
  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-4 sm:px-6 py-6 max-w-[1200px] mx-auto">
          {/* Playful page header (pf-ph idiom, rendered inline). */}
          <div className="pf-ph">
            <div className="l">
              <div className="eyebrow">
                <span className="d" aria-hidden />
                {FINANCIAL.length + MUTUAL_FUND.length} CALCULATORS · INR NATIVE
                · NSE-ACCURATE
              </div>
              <h1>
                The math, <span className="ser">we do.</span>
              </h1>
              <div className="sub">
                SIP, lumpsum, EMI, FD, NPS, PPF, STCG/LTCG — all with Indian
                assumptions baked in.
              </div>
            </div>
          </div>

          <PageGuard route="/discover" bare>
            <CalcSection
              title="Financial calculators"
              subtitle="Indian retail planning toolkit"
              entries={FINANCIAL}
              badge="BETA"
            />

            <div className="mt-6" />

            <CalcSection
              title="Mutual fund calculators"
              subtitle="Default assumed-return mode. Actual-fund XIRR mode (pick a scheme from your portfolio / watchlist) is planned."
              entries={MUTUAL_FUND}
              badge="BETA"
            />
          </PageGuard>
        </div>
      </main>
    </div>
  );
}

function CalcSection({
  title,
  subtitle,
  entries,
  badge,
}: {
  title: string;
  subtitle: string;
  entries: CalcEntry[];
  badge?: string;
}) {
  return (
    <section>
      <div className="pf-sec-h">
        <span className="n">{badge ?? "CALC"}</span>
        <h3>{title}</h3>
        <span className="rule" />
      </div>
      <p className="text-[12.5px] text-[var(--ink-3)] -mt-1 mb-3.5">
        {subtitle}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {entries.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.slug}
              href={`/calculators/${c.slug}`}
              className="pf-card"
              style={{
                padding: 18,
                textDecoration: "none",
                color: "var(--ink)",
                minHeight: 130,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              <span
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 10,
                  background: c.color,
                  color: "var(--paper)",
                  display: "grid",
                  placeItems: "center",
                  border: "1.5px solid var(--ink)",
                  transform: "rotate(-3deg)",
                  boxShadow: "2px 2px 0 var(--ink)",
                }}
              >
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <div className="text-[17px] font-extrabold tracking-[-0.4px]">
                {c.name}
              </div>
              <div className="text-[12.5px] text-[var(--ink-3)] leading-snug">
                {c.description}
              </div>
              <div className="mt-auto flex items-center justify-between">
                <span className="mono text-[10.5px] text-[var(--ink-3)] tracking-[1px]">
                  /calculators/{c.slug}
                </span>
                <ArrowRight
                  className="h-[13px] w-[13px]"
                  style={{ color: "var(--emerald-text)" }}
                />
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
