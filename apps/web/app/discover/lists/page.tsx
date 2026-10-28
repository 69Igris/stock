/**
 * Research Lists - curated stock baskets (MONEY-197).
 *
 * v1: static seed data from `lib/data/research-lists`. A follow-up
 * ticket migrates this to a `ResearchList` Prisma model with editorial
 * workflow. The page shape is final; only the data source changes.
 *
 * MONEY-485: re-skinned to the playful (pf-*) design system — the
 * design's Curated Lists screen (3-col card grid). Data + behaviour
 * unchanged; only the presentation moved to pf-app / pf-card / pf-pill.
 */

import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { PfPageHead } from "@/components/playful/PfPageHead";
import {
  ArrowRight,
  TrendingUp,
  Crown,
  Gem,
  Sparkles,
  Award,
} from "lucide-react";
import {
  RESEARCH_LISTS,
  type ResearchList,
  type ResearchListTone,
} from "@/lib/data/research-lists";

export const metadata = {
  // MONEY-394 N - bare title; root layout's template adds `| UseMoney`.
  title: "Research Lists",
  description:
    "Curated stock baskets maintained by UseMoney research - momentum, value, quality, income themes.",
};

// Next 15+ : the shared <Sidebar/> chrome reads request-time `useSearchParams()`,
// which makes static prerendering bail. This authenticated app page renders the
// dynamic shell anyway (it was never beneficially static), so opt into dynamic
// rendering — matching the other discover/* pages. No behavior change.
export const dynamic = "force-dynamic";

// Tone → playful accent CSS var (theme-aware via playful-app.css).
const TONE_COLOR: Record<ResearchListTone, string> = {
  acc: "var(--emerald)",
  vio: "var(--pop-5)",
  blue: "var(--pop-3)",
  warn: "var(--pop-2)",
  pos: "var(--emerald)",
  neg: "var(--pop-1)",
};

// Per-tag icon, falling back to a trophy for unmapped tags.
const TAG_ICON: Record<string, typeof TrendingUp> = {
  MOMENTUM: TrendingUp,
  INCOME: Crown,
  QUALITY: Award,
  THEMATIC: Sparkles,
  SPECIAL: Sparkles,
  VALUE: Gem,
};

export default function ResearchListsPage() {
  return (
    <PageGuard
      route="/discover"
      containerClassName="px-6 py-6 max-w-[1200px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page">
            <PfPageHead
              eyebrow={`${RESEARCH_LISTS.length} LISTS · REBALANCED MONTHLY · CURATED BY RESEARCH`}
              title={
                <>
                  Lists that <span className="ser">do the</span>{" "}
                  <span className="hl-gold">sifting.</span>
                </>
              }
              sub="Curated stock baskets maintained by UseMoney research. Each list is rebalanced monthly with full methodology transparency."
            />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
                gap: 14,
              }}
            >
              {RESEARCH_LISTS.map((list) => (
                <ResearchListCard key={list.slug} list={list} />
              ))}
            </div>
          </div>
        </main>
      </div>
    </PageGuard>
  );
}

function ResearchListCard({ list }: { list: ResearchList }) {
  const beatsBenchmark =
    parseFloat(list.oneYearReturn) > parseFloat(list.benchmarkReturn);
  const color = TONE_COLOR[list.tone];
  const Icon = TAG_ICON[list.tag] ?? Award;

  return (
    <div className="pf-card" style={{ padding: 16 }}>
      {/* Header — icon tile + name + tag/updated meta */}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: color,
            color: "var(--paper)",
            display: "grid",
            placeItems: "center",
            border: "1.5px solid var(--ink)",
            transform: "rotate(-3deg)",
            flexShrink: 0,
          }}
        >
          <Icon size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: -0.3,
              color: "var(--ink)",
              lineHeight: 1.25,
            }}
          >
            {list.name}
          </div>
          <div
            style={{
              marginTop: 4,
              display: "flex",
              gap: 6,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <span
              className="pf-pill"
              style={{
                fontSize: 9,
                padding: "1px 7px",
                background: color,
                color: "var(--paper)",
                borderColor: color,
              }}
            >
              {list.tag}
            </span>
            <span
              className="mono"
              style={{ fontSize: 10.5, color: "var(--ink-3)" }}
            >
              Updated {list.updated}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 10,
          fontSize: 12.5,
          color: "var(--ink-3)",
          lineHeight: 1.45,
        }}
      >
        {list.description}
      </div>

      {/* Stat footer — stock count, 1Y return, vs NIFTY + View CTA */}
      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: "1.5px dashed var(--rule-soft)",
          display: "flex",
          alignItems: "flex-end",
          gap: 16,
        }}
      >
        <FooterStat label="STOCKS" value={String(list.stockCount)} />
        <FooterStat
          label="1Y RETURN"
          value={list.oneYearReturn}
          valueColor="var(--emerald-text)"
        />
        <FooterStat
          label="VS NIFTY 50"
          value={list.benchmarkReturn}
          valueColor={beatsBenchmark ? "var(--emerald-text)" : "#b91c1c"}
        />
        <button
          type="button"
          className="pf-bs sm"
          style={{ marginLeft: "auto", flexShrink: 0 }}
          title="View list methodology + holdings"
        >
          View
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function FooterStat({
  label,
  value,
  valueColor = "var(--ink)",
}: {
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span
        className="mono"
        style={{
          fontSize: 9.5,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: "var(--ink-3)",
          fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <span
        className="mono"
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: valueColor,
          marginTop: 3,
        }}
      >
        {value}
      </span>
    </div>
  );
}
