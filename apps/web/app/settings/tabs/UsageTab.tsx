"use client";

import { useEffect, useState } from "react";
import { SetSection } from "./primitives";
import type { SubscriptionData } from "@/lib/actions/subscription";
import { getResearchHistoryAction } from "@/lib/actions/research";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";

interface UsageTabProps {
  subscription: SubscriptionData | null;
}

/**
 * Map a session's skill string to its UI tier (mirrors the analysis
 * list's detectTier helper) so we can split usage into LLM calls vs
 * Research calls.
 */
function tierFromSkill(skill?: string): "L1" | "L2" | "L3" | "L4" {
  if (!skill) return "L2";
  if (skill.includes("advanced") || skill === "l4") return "L4";
  if (
    skill.includes("comprehensive") ||
    skill === "peer-comparison" ||
    skill === "l3"
  )
    return "L3";
  if (skill.includes("quick") || skill === "l1") return "L1";
  return "L2";
}

interface CycleMeter {
  k: string;
  used: number;
  total: number;
  unit: string;
  color: string;
}

function formatLakhs(n: number): string {
  const a = Math.abs(n);
  if (a >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (a >= 100_000) return `₹${(n / 100_000).toFixed(2)} L`;
  if (a >= 1_000) return `₹${(n / 1_000).toFixed(1)}K`;
  return `₹${n.toFixed(0)}`;
}

function StatCard({
  label,
  value,
  sub,
  delta,
  deltaTone,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  delta?: string;
  deltaTone?: "pos" | "neg";
  accent?: boolean;
}) {
  return (
    <div
      className="pf-card pf-stat flat"
      style={{
        background: accent ? "var(--emerald-bg)" : "var(--rule-softer)",
        borderColor: accent ? "var(--emerald)" : "var(--ink)",
      }}
    >
      <div className="l">{label}</div>
      <div className="v" style={{ fontSize: 24 }}>
        {value}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 6,
        }}
      >
        {delta && (
          <span
            className={`pf-pill${deltaTone === "pos" ? " emerald" : ""}`}
            style={
              deltaTone === "pos"
                ? { fontSize: 10 }
                : {
                    fontSize: 10,
                    background: "rgba(185,28,28,0.1)",
                    color: "#b91c1c",
                    borderColor: "#b91c1c",
                  }
            }
          >
            {delta}
          </span>
        )}
        {sub && (
          <span
            className="mono"
            style={{ fontSize: 11, color: "var(--ink-3)" }}
          >
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

export default function UsageTab({ subscription }: UsageTabProps) {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const planId = subscription?.planId || "FREE";
  // MONEY-866: one-time "lifetime" PRO is deprecated — a PRO with a billing
  // cycle is not lifetime (only legacy grandfathered PROs are).
  const isLifetime = planId === "PRO" && !subscription?.billingPeriod;

  const planLimits: Record<string, number> = {
    FREE: 5,
    PRO: 50,
    PREMIUM: 200,
    ULTIMATE: 750,
  };

  const creditsLimit = planLimits[planId] ?? subscription?.creditsLimit ?? 5;
  const creditsUsed = subscription?.creditsUsed ?? 0;
  // Pack credits accumulate from CREDIT_PACK_N purchases and never expire.
  const packCreditsLimit = subscription?.packCreditsLimit ?? 0;
  const packCreditsUsed = subscription?.packCreditsUsed ?? 0;

  // Research call counts - derived from research history. L3 (Comprehensive)
  // and L4 (Advanced) cost more credits per session, so they get a separate
  // meter. Total LLM calls includes everything (StockSage chat + research).
  const [researchCallsThisCycle, setResearchCallsThisCycle] = useState({
    total: 0,
    deepResearch: 0,
  });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getResearchHistoryAction(1, 100);
        if (cancelled || !result?.success || !result?.data) return;
        // Cycle anniversary = subscription start of month. Restrict counts
        // to current cycle so the meter resets monthly.
        const startDate = subscription?.startDate
          ? new Date(subscription.startDate)
          : new Date();
        const cycleStart = new Date();
        cycleStart.setDate(startDate.getDate());
        if (cycleStart > new Date()) {
          cycleStart.setMonth(cycleStart.getMonth() - 1);
        }
        const items = result.data.items.filter(
          (it) => new Date(it.createdAt) >= cycleStart
        );
        let deep = 0;
        for (const it of items) {
          const tier = tierFromSkill(it.skill);
          if (tier === "L3" || tier === "L4") deep += 1;
        }
        setResearchCallsThisCycle({ total: items.length, deepResearch: deep });
      } catch {
        // Silent fail - leave at 0
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [subscription?.startDate]);

  // Research credit limit - Comprehensive (L3) costs 6, Advanced (L4) costs
  // 12 in the design's plan grid. Keep the per-plan caps simple here.
  const researchLimit =
    planId === "FREE"
      ? 0
      : planId === "PRO"
        ? 10
        : planId === "PREMIUM"
          ? 40
          : -1;

  const cycle: CycleMeter[] = [
    {
      k: "LLM calls - all queries",
      used: creditsUsed,
      total: creditsLimit,
      unit: "credits",
      color: "var(--emerald)",
    },
    ...(packCreditsLimit > 0
      ? [
          {
            k: "Pack credits - never expire",
            used: packCreditsUsed,
            total: packCreditsLimit,
            unit: "credits",
            color: "var(--pop-5)",
          } as CycleMeter,
        ]
      : []),
    {
      k: "Research calls - Comprehensive (L3) + Advanced (L4)",
      used: researchCallsThisCycle.deepResearch,
      total: researchLimit > 0 ? researchLimit : 0,
      unit: "sessions",
      color: "var(--pop-5)",
    },
    ...(paperTradingEnabled
      ? [
          {
            k: "Paper trades",
            used: 0,
            total: 1000,
            unit: "trades",
            color: "var(--pop-2)",
          } as CycleMeter,
        ]
      : []),
    {
      k: "API calls",
      used: 0,
      total: planId === "FREE" ? 0 : 10000,
      unit: "calls",
      color: "var(--pop-3)",
    },
  ];

  // Cycle end calculation - assume monthly anchor on subscription start day.
  const startDate = subscription?.startDate
    ? new Date(subscription.startDate)
    : new Date();
  const cycleEnd = new Date(startDate);
  cycleEnd.setMonth(cycleEnd.getMonth() + 1);
  const cycleEndLabel = cycleEnd.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const startedYearMonth = startDate.toLocaleDateString("en-US", {
    month: "short",
    year: "numeric",
  });

  return (
    <div className="flex flex-col gap-4">
      {/* Stat cards — paper-trading kill-switch drops the Paper balance
          card and collapses the grid from 4 → 3 cols. */}
      <div
        className={`grid grid-cols-2 ${paperTradingEnabled ? "md:grid-cols-4" : "md:grid-cols-3"} gap-3`}
      >
        <StatCard
          label="Plan"
          value={planId}
          sub={isLifetime ? `Lifetime · since ${startedYearMonth}` : "Active"}
          accent
        />
        <StatCard label="Brokers" value="—" sub="of unlimited" />
        {paperTradingEnabled && (
          <StatCard
            label="Paper balance"
            value={formatLakhs(1048320)}
            delta="+4.83%"
            deltaTone="pos"
            sub="Virtual"
          />
        )}
        <StatCard
          label="Cycle ends"
          value={cycleEndLabel}
          sub="Resets monthly"
        />
      </div>

      {/* Cycle meters */}
      <SetSection
        title="This cycle"
        desc="Resets monthly on your subscription anniversary. Unused credits don't carry over."
      >
        {cycle.map((c, i, a) => {
          const pct = c.total > 0 ? Math.min(100, (c.used / c.total) * 100) : 0;
          return (
            <div
              key={c.k}
              style={{
                padding: "14px 22px",
                borderBottom:
                  i === a.length - 1 ? 0 : "1px dashed var(--rule-soft)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    fontSize: 13,
                    color: "var(--ink)",
                    fontWeight: 600,
                  }}
                >
                  {c.k}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink)",
                    fontWeight: 600,
                  }}
                >
                  {c.used.toLocaleString()}{" "}
                  <span style={{ color: "var(--ink-3)" }}>
                    / {c.total.toLocaleString()} {c.unit}
                  </span>
                </div>
              </div>
              <div
                style={{
                  height: 6,
                  background: "var(--rule-softer)",
                  borderRadius: 999,
                  overflow: "hidden",
                  border: "1px solid var(--rule-soft)",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    borderRadius: 999,
                    width: `${pct}%`,
                    background: c.color,
                  }}
                />
              </div>
            </div>
          );
        })}
      </SetSection>

      {/* History sparkline */}
      <SetSection title="History" desc="Last 30 days, daily.">
        <div style={{ padding: "20px 22px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "flex-end",
              gap: 4,
              height: 80,
            }}
          >
            {Array.from({ length: 30 }).map((_, i) => {
              // Deterministic mock - replace with real daily usage points
              const v =
                0.3 + Math.abs(Math.sin(i * 0.7) + Math.cos(i * 0.3)) * 0.35;
              return (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    borderRadius: 2,
                    height: `${v * 100}%`,
                    background:
                      i === 29 ? "var(--emerald)" : "var(--emerald-bg)",
                    border:
                      i === 29
                        ? "1px solid var(--emerald)"
                        : "1px solid var(--rule-soft)",
                  }}
                />
              );
            })}
          </div>
          <div
            className="mono"
            style={{
              display: "flex",
              justifyContent: "space-between",
              marginTop: 10,
              fontSize: 10,
              color: "var(--ink-3)",
            }}
          >
            <span>30d ago</span>
            <span>14d</span>
            <span>7d</span>
            <span>Today</span>
          </div>
        </div>
      </SetSection>
    </div>
  );
}
