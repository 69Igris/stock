"use client";

// Next 15+ : this authenticated app page renders the shared <Sidebar/> shell
// (which reads request-time useSearchParams), so static prerendering bails.
// It was never beneficially static (auth-gated, per-user data) — render it
// dynamically, matching the rest of the app. No user-visible behavior change.
export const dynamic = "force-dynamic";

import { useState, useEffect, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import { PfPageHead } from "@/components/playful/PfPageHead";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@usemoney/ui/select";
import { ArrowLeft, Gem, Clock, Filter, Loader2 } from "lucide-react";
import Link from "next/link";
import {
  getCreditUsageHistoryAction,
  getCreditBalanceAction,
  type CreditUsageRecord,
  type CreditBalance,
} from "@/lib/actions/credits";

/** Human-readable action labels */
const ACTION_LABELS: Record<string, string> = {
  l1_flash: "Quick Answer",
  l1_definition: "Definition",
  follow_up: "Follow-up",
  portfolio_query: "Portfolio Query",
  l2_research_fast: "Research (Quick)",
  l2_research_advanced: "Research (Deep)",
  l2_earnings_analysis: "Earnings Analysis",
  l2_financial_deep_dive: "Financial Deep Dive",
  l2_investment_thesis: "Investment Thesis",
  l2_dcf_valuation: "DCF Valuation",
  l2_stock_screener: "Stock Screener",
  l3_comprehensive_stock: "Comprehensive Analysis",
  l3_multi_comparison_base: "Multi-Stock Compare",
  l3_portfolio_optimization: "Portfolio Optimization",
  portfolio_roast: "Portfolio Roast",
  risk_analysis: "Risk Analysis",
  tax_report: "Tax Report",
  document_analysis: "Document Analysis",
};

// Tier accent — emerald / blue / violet, mapped to playful tokens.
// TIER_COLOR drives the bright pill border; TIER_TEXT_COLOR is the
// AA-safe variant used wherever the accent is rendered as text.
const TIER_COLOR: Record<string, string> = {
  L1: "var(--emerald)",
  L2: "var(--pop-3)",
  L3: "var(--pop-5)",
};
const TIER_TEXT_COLOR: Record<string, string> = {
  L1: "var(--emerald-text)",
  L2: "var(--pop-3-text)",
  L3: "var(--pop-5-text)",
};

export default function UsageHistoryPage() {
  const [items, setItems] = useState<CreditUsageRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [balance, setBalance] = useState<CreditBalance | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const PAGE_SIZE = 20;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    const [usageResult, balanceResult] = await Promise.all([
      getCreditUsageHistoryAction({
        skip: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        action: actionFilter === "all" ? undefined : actionFilter,
      }),
      getCreditBalanceAction(),
    ]);

    if (usageResult.success && usageResult.data) {
      setItems(usageResult.data.items);
      setTotal(usageResult.data.total);
    }
    if (balanceResult.success && balanceResult.data) {
      setBalance(balanceResult.data);
    }
    setIsLoading(false);
  }, [page, actionFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const balanceCells: Array<[string, string]> = balance
    ? [
        ["Plan Credits", `${balance.plan} / ${balance.planLimit}`],
        ["Pack Credits", `${balance.pack} / ${balance.packLimit}`],
        ["Total Available", `${balance.total}`],
      ]
    : [];

  return (
    <div className="pf-app min-h-screen">
      <Sidebar />
      <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
        <div className="px-6 pb-24 pt-6 max-w-5xl mx-auto">
          <PfPageHead
            eyebrow="SETTINGS · CREDIT USAGE"
            title={
              <>
                Every <span className="ser">credit,</span>{" "}
                <span className="hl">accounted for.</span>
              </>
            }
            sub="A line-by-line ledger of where your AI credits went."
            right={
              <Link href="/settings?tab=usage" className="pf-bf">
                <ArrowLeft className="h-3.5 w-3.5" /> Back to usage
              </Link>
            }
          />

          {/* Balance Summary */}
          {balance && (
            <div
              className="grid grid-cols-1 sm:grid-cols-3 gap-3"
              style={{ marginBottom: 16 }}
            >
              {balanceCells.map(([k, v], i) => (
                <div
                  key={k}
                  className="pf-card pf-stat flat"
                  style={{
                    background:
                      i === 2 ? "var(--emerald-bg)" : "var(--rule-softer)",
                    borderColor: i === 2 ? "var(--emerald)" : "var(--ink)",
                  }}
                >
                  <div className="l">{k}</div>
                  <div
                    className="v"
                    style={{
                      fontSize: 24,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    {i === 2 && (
                      <Gem
                        className="h-5 w-5"
                        style={{ color: "var(--emerald)" }}
                      />
                    )}
                    {v}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Filter */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 14,
            }}
          >
            <Filter className="h-4 w-4" style={{ color: "var(--ink-3)" }} />
            <Select
              value={actionFilter}
              onValueChange={(v) => {
                setActionFilter(v);
                setPage(0);
              }}
            >
              <SelectTrigger className="w-48 h-9 text-xs">
                <SelectValue placeholder="All actions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                <SelectItem value="l2_research_fast">
                  Research (Quick)
                </SelectItem>
                <SelectItem value="l2_research_advanced">
                  Research (Deep)
                </SelectItem>
                <SelectItem value="l3_comprehensive_stock">
                  Comprehensive
                </SelectItem>
                <SelectItem value="portfolio_roast">Portfolio Roast</SelectItem>
                <SelectItem value="risk_analysis">Risk Analysis</SelectItem>
              </SelectContent>
            </Select>
            <span
              className="mono"
              style={{
                fontSize: 11,
                color: "var(--ink-3)",
                marginLeft: "auto",
              }}
            >
              {total} total records
            </span>
          </div>

          {/* Usage List */}
          <div
            className="pf-card flat"
            style={{ padding: 0, overflow: "hidden" }}
          >
            <div
              style={{
                padding: "14px 22px",
                borderBottom: "1.5px dashed var(--rule-soft)",
                background: "var(--paper-2)",
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: -0.3,
                color: "var(--ink)",
              }}
            >
              Recent Usage
            </div>

            {isLoading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "40px 0",
                  color: "var(--ink-3)",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 13,
                }}
              >
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
              </div>
            ) : items.length === 0 ? (
              <p
                style={{
                  fontSize: 13,
                  color: "var(--ink-3)",
                  textAlign: "center",
                  padding: "32px 0",
                }}
              >
                No credit usage recorded yet.
              </p>
            ) : (
              items.map((item, i, arr) => (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    padding: "12px 22px",
                    borderBottom:
                      i === arr.length - 1 ? 0 : "1px dashed var(--rule-soft)",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <span
                      className="pf-pill"
                      style={{
                        fontSize: 10,
                        color: TIER_TEXT_COLOR[item.tier] ?? "var(--ink)",
                        borderColor: TIER_COLOR[item.tier] ?? "var(--ink)",
                      }}
                    >
                      {item.tier}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: "var(--ink)",
                        }}
                      >
                        {ACTION_LABELS[item.action] ?? item.action}
                      </div>
                      {item.query && (
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "var(--ink-3)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 300,
                          }}
                        >
                          {item.query}
                        </div>
                      )}
                      {item.symbols.length > 0 && (
                        <div
                          style={{
                            display: "flex",
                            gap: 4,
                            marginTop: 4,
                            flexWrap: "wrap",
                          }}
                        >
                          {item.symbols.map((s) => (
                            <span
                              key={s}
                              className="pf-pill outline"
                              style={{ fontSize: 9.5, padding: "1px 6px" }}
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div
                      className="mono"
                      style={{ fontSize: 13.5, fontWeight: 700 }}
                    >
                      {item.creditsUsed === 0 ? (
                        <span style={{ color: "var(--emerald-text)" }}>
                          Free
                        </span>
                      ) : (
                        <span style={{ color: "var(--ink)" }}>
                          -{item.creditsUsed}
                        </span>
                      )}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: "var(--ink-3)",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        justifyContent: "flex-end",
                        marginTop: 2,
                      }}
                    >
                      <Clock className="h-2.5 w-2.5" />
                      {new Date(item.createdAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                </div>
              ))
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  padding: "16px 22px",
                  borderTop: "1.5px dashed var(--rule-soft)",
                }}
              >
                <button
                  type="button"
                  className="pf-bf sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  style={{
                    opacity: page === 0 ? 0.5 : 1,
                    cursor: page === 0 ? "not-allowed" : "pointer",
                  }}
                >
                  Previous
                </button>
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  Page {page + 1} of {totalPages}
                </span>
                <button
                  type="button"
                  className="pf-bf sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                  style={{
                    opacity: page >= totalPages - 1 ? 0.5 : 1,
                    cursor: page >= totalPages - 1 ? "not-allowed" : "pointer",
                  }}
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
