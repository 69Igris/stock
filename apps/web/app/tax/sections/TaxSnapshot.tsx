"use client";

/* =====================================================================
   Tax Report v2 — Snapshot section (MONEY-485)
   Dark anchor card with the estimated liability + STCG/LTCG/dividends/F&O
   breakdown (with citations), filing countdown, surcharge band, and an
   "in plain English" narration. All ₹ figures come from the real
   TaxReportResult. Things the backend can't supply (dividends, surcharge
   income, advance-tax-paid) render honest placeholders.
   ===================================================================== */

import { Flame, Sparkles, FileText } from "lucide-react";
import type { TaxReportResult } from "@/lib/actions/tax";
import { Card, Pill, Cite, fmtINR, fmtLakhs } from "../components/primitives";

const FIXED_DARK = "#1d1d1b";
const FIXED_CREAM = "#f7f3e6";

/* Last filing date for a given FY (non-audit ITR): 31 Jul of the assessment
   year. FY "2024-25" → AY 2025-26 → 31 Jul 2025. */
function filingDeadline(fy: string): Date {
  const [startStr] = fy.split("-");
  const assessmentYear = parseInt(startStr!, 10) + 1;
  return new Date(`${assessmentYear}-07-31T23:59:59.999Z`);
}

function daysUntil(target: Date): number {
  const now = new Date();
  return Math.max(
    0,
    Math.ceil((target.getTime() - now.getTime()) / 86_400_000)
  );
}

export default function TaxSnapshot({
  report,
  fy,
  ask,
}: {
  report: TaxReportResult;
  fy: string;
  ask: (q: string) => void;
}) {
  const cg = report.capitalGains;
  const stcg = cg.equity.stcg;
  const ltcg = cg.equity.ltcg;
  const fno = cg.fno;
  const hero = fmtLakhs(cg.totalTax);
  const deadline = filingDeadline(fy);
  const daysLeft = daysUntil(deadline);
  const deadlineLabel = deadline.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  // Window progress for the filing ribbon: assume a ~120-day filing window.
  const filingPct = Math.max(8, Math.min(100, ((120 - daysLeft) / 120) * 100));

  const breakdown = [
    {
      l: "STCG · 20%",
      v: fmtINR(stcg.tax),
      d: `net ${fmtINR(stcg.net)}`,
      cite: "s.111A",
    },
    {
      l: "LTCG · 12.5%",
      v: fmtINR(ltcg.tax),
      d:
        ltcg.exemption > 0
          ? `₹${(ltcg.exemption / 1e5).toFixed(2)}L exempt`
          : "above exempt cap",
      cite: "s.112A",
    },
    {
      l: "DIVIDENDS",
      v: "needs data",
      d: "Schedule OS · MONEY-486",
      cite: "s.194",
      muted: true,
    },
    {
      l: "F&O BUSINESS",
      v: fno.net !== 0 ? fmtINR(fno.net) : "—",
      d: fno.net !== 0 ? "ITR-3 required" : "no F&O this FY",
      cite: "s.43(5)",
    },
  ];

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 22 }}
    >
      {/* ── Dark anchor card ── */}
      <Card
        tilt="l"
        style={{ background: FIXED_DARK, color: FIXED_CREAM, padding: 22 }}
      >
        <div
          className="grid grid-cols-1 lg:grid-cols-2"
          style={{ gap: 28, alignItems: "center" }}
        >
          <div>
            <div
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                color: "var(--pop-2)",
              }}
            >
              ESTIMATED LIABILITY · FY {fy}
            </div>
            <div
              className="mono"
              style={{
                marginTop: 8,
                fontSize: 64,
                fontWeight: 800,
                letterSpacing: -3,
                color: "var(--pop-2)",
                lineHeight: 0.95,
              }}
            >
              {cg.totalTax >= 1e5 ? (
                <>
                  ₹{hero.value}
                  <span
                    style={{ fontSize: 30, fontWeight: 700, marginLeft: 6 }}
                  >
                    {hero.unit}
                  </span>
                </>
              ) : (
                fmtINR(cg.totalTax)
              )}
            </div>
            <div
              className="ser"
              style={{
                marginTop: 10,
                fontSize: 16,
                color: "rgba(247,243,230,0.82)",
                lineHeight: 1.4,
              }}
            >
              <span
                style={{
                  fontFamily: "Inter, sans-serif",
                  fontStyle: "normal",
                  fontWeight: 700,
                  color: "var(--pop-2)",
                }}
              >
                New regime
              </span>{" "}
              assumed for capital-gains tax. Effective rate{" "}
              {(cg.effectiveRate * 100).toFixed(1)}%.
            </div>
            <div
              className="flex items-center gap-2"
              style={{ marginTop: 14, flexWrap: "wrap" }}
            >
              <Pill
                style={{
                  background: "var(--pop-2)",
                  color: FIXED_DARK,
                  borderColor: "var(--pop-2)",
                }}
              >
                effective rate · {(cg.effectiveRate * 100).toFixed(1)}%
              </Pill>
              <Pill
                style={{
                  background: "rgba(247,243,230,0.08)",
                  color: "rgba(247,243,230,0.72)",
                  borderColor: "rgba(247,243,230,0.22)",
                }}
              >
                {cg.trades.length} closed trades
              </Pill>
            </div>
          </div>

          <div className="grid grid-cols-2" style={{ gap: 12 }}>
            {breakdown.map((m) => (
              <div
                key={m.l}
                style={{
                  padding: 14,
                  background: "rgba(247,243,230,0.06)",
                  borderRadius: 10,
                  border: "1px solid rgba(247,243,230,0.1)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    letterSpacing: 1.2,
                    color: "rgba(247,243,230,0.65)",
                    fontWeight: 700,
                  }}
                >
                  {m.l}
                </div>
                <div
                  className="mono"
                  style={{
                    marginTop: 5,
                    fontSize: m.muted ? 14 : 20,
                    fontWeight: 800,
                    color: m.muted ? "rgba(247,243,230,0.5)" : FIXED_CREAM,
                    letterSpacing: -0.5,
                  }}
                >
                  {m.v}
                </div>
                <div
                  className="flex items-center justify-between"
                  style={{ marginTop: 4, gap: 6 }}
                >
                  <span
                    className="mono"
                    style={{ fontSize: 10, color: "rgba(247,243,230,0.55)" }}
                  >
                    {m.d}
                  </span>
                  <span
                    className="mono"
                    style={{
                      fontSize: 9,
                      color: "var(--pop-2)",
                      background: "rgba(252,211,77,0.12)",
                      padding: "1px 5px",
                      borderRadius: 3,
                      fontWeight: 600,
                    }}
                  >
                    {m.cite}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className="mono"
          style={{
            marginTop: 22,
            paddingTop: 14,
            borderTop: "1.5px dashed rgba(247,243,230,0.16)",
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            justifyContent: "space-between",
            fontSize: 11,
            color: "rgba(247,243,230,0.6)",
          }}
        >
          <span>Advance tax paid · needs data (MONEY-486)</span>
          <span style={{ color: "#4ade80" }}>
            ● Self-assessment due — verify before {deadlineLabel}
          </span>
          <span>Source: synced tradebook · cross-referenced</span>
        </div>
      </Card>

      {/* ── In plain English ── */}
      <Card
        style={{
          background: "var(--pop-2)",
          border: "2px solid var(--ink)",
          boxShadow: "var(--shadow-hard)",
          position: "relative",
        }}
      >
        <div className="flex gap-4" style={{ alignItems: "flex-start" }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 10,
              background: FIXED_DARK,
              color: "var(--pop-2)",
              display: "grid",
              placeItems: "center",
              border: "2px solid #1d1d1b",
              transform: "rotate(-4deg)",
              flexShrink: 0,
            }}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div style={{ flex: 1 }}>
            <div
              className="mono"
              style={{
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1.5,
                color: "#3a3a35",
              }}
            >
              IN PLAIN ENGLISH
            </div>
            <div
              style={{
                marginTop: 6,
                fontSize: 16,
                fontWeight: 800,
                color: FIXED_DARK,
                letterSpacing: -0.4,
                lineHeight: 1.45,
              }}
            >
              You&rsquo;ll owe approximately{" "}
              <span
                style={{
                  background: FIXED_DARK,
                  color: "var(--pop-2)",
                  padding: "0 6px",
                  borderRadius: 4,
                }}
              >
                {fmtINR(cg.totalTax)}
              </span>{" "}
              for FY {fy}.{" "}
              {stcg.tax >= ltcg.tax ? (
                <>
                  Most of it comes from{" "}
                  <em style={{ fontFamily: "Instrument Serif, serif" }}>
                    short-term equity sales
                  </em>{" "}
                  &mdash; taxed at the 20% rate.
                </>
              ) : (
                <>
                  Most of it comes from{" "}
                  <em style={{ fontFamily: "Instrument Serif, serif" }}>
                    long-term equity gains
                  </em>{" "}
                  above the ₹1.25L exempt cap.
                </>
              )}
            </div>
            <div
              className="flex items-center gap-2"
              style={{ marginTop: 12, flexWrap: "wrap" }}
            >
              <button
                type="button"
                className="pf-bf sm"
                style={{
                  borderColor: FIXED_DARK,
                  color: FIXED_DARK,
                  background: "transparent",
                }}
                onClick={() => ask("What can I do right now to lower my tax?")}
              >
                What can I do right now?
              </button>
              <button
                type="button"
                className="pf-bf sm"
                style={{
                  borderColor: FIXED_DARK,
                  color: FIXED_DARK,
                  background: "transparent",
                }}
                onClick={() => ask("Compare Old vs New regime for my income")}
              >
                Old vs New regime?
              </button>
              <button
                type="button"
                className="pf-bs sm"
                style={{
                  background: FIXED_DARK,
                  borderColor: FIXED_DARK,
                  color: "var(--pop-2)",
                }}
                onClick={() =>
                  ask("Why does 23 Jul 2024 matter for capital gains tax?")
                }
              >
                Why 23 Jul 2024 matters &rarr;
              </button>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Filing countdown + surcharge ── */}
      <div className="grid grid-cols-1 lg:grid-cols-3" style={{ gap: 14 }}>
        <Card className="lg:col-span-2">
          <div
            className="flex items-center"
            style={{ flexWrap: "wrap", gap: 18 }}
          >
            <div
              className="flex gap-3"
              style={{ flex: 1, minWidth: 240, alignItems: "center" }}
            >
              <span
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 11,
                  background: "var(--pop-1)",
                  color: "var(--paper)",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid var(--ink)",
                  transform: "rotate(-3deg)",
                  boxShadow: "var(--shadow-soft)",
                  flexShrink: 0,
                }}
              >
                <Flame className="h-5 w-5" />
              </span>
              <div>
                <div className="ttl" style={{ color: "var(--pop-1-text)" }}>
                  FILING DEADLINE
                </div>
                <div
                  style={{
                    fontSize: 30,
                    fontWeight: 800,
                    letterSpacing: -1,
                    marginTop: 2,
                  }}
                >
                  {daysLeft}
                  <span
                    className="ser"
                    style={{
                      fontSize: 18,
                      marginLeft: 6,
                      color: "var(--ink-3)",
                    }}
                  >
                    days
                  </span>
                </div>
                <div
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  Last date: {deadlineLabel} · ITR-2
                </div>
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: 4 }}
              >
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  Now
                </span>
                <span
                  className="mono"
                  style={{
                    fontSize: 11,
                    color: "var(--pop-1-text)",
                    fontWeight: 700,
                  }}
                >
                  {deadline.toLocaleDateString("en-IN", {
                    day: "2-digit",
                    month: "short",
                  })}
                </span>
              </div>
              <div
                style={{
                  position: "relative",
                  height: 14,
                  background: "var(--rule-softer)",
                  border: "1.5px solid var(--ink)",
                  borderRadius: 99,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${filingPct}%`,
                    background:
                      "linear-gradient(90deg, var(--emerald), var(--pop-2), var(--pop-1))",
                  }}
                />
              </div>
              <div
                className="mono"
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: "var(--ink-3)",
                  lineHeight: 1.5,
                }}
              >
                Belated return cut-off: 31 Dec{" "}
                {parseInt(fy.split("-")[0]!, 10) + 1} <Cite>s.234F</Cite>
              </div>
            </div>
          </div>
        </Card>

        {/* Surcharge band — honest placeholder (needs total taxable income) */}
        <Card style={{ background: "var(--paper-2)" }}>
          <div className="ttl">SURCHARGE BAND</div>
          <div
            className="ser"
            style={{
              fontSize: 15,
              marginTop: 8,
              lineHeight: 1.4,
              color: "var(--ink-2)",
            }}
          >
            Surcharge starts at total income above{" "}
            <span className="hl-gold">₹50 L</span>.
          </div>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--ink-3)",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            We need your full taxable income (salary + other heads) to place you
            on the band.
          </div>
          <div style={{ marginTop: 10 }}>
            <Pill tone="gold">needs salary data · MONEY-486</Pill>
          </div>
          <button
            type="button"
            className="pf-bf sm"
            style={{ marginTop: 12 }}
            onClick={() => ask("Explain India's tax surcharge bands")}
          >
            <FileText className="h-3 w-3" /> How surcharge works
          </button>
        </Card>
      </div>
    </div>
  );
}
