"use client";

/* =====================================================================
   Tax Report v2 — Optimize section (MONEY-485)
   LTCG harvest plan (real harvesting data → harvest-confirm dialog),
   regime sandbox old-vs-new (real CG tax + client-side salary, shared
   slab math), what-if rebalance, advance-tax 234ABC timeline (real
   advanceTax data), and a cross-link to the Risk report.
   ===================================================================== */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Shield, Sparkles, Scissors, Pencil } from "lucide-react";
import type { TaxReportResult } from "@/lib/actions/tax";
import AdvanceTaxTimeline from "../components/AdvanceTaxTimeline";
import { HarvestConfirmDialog } from "../components/TaxDialogs";
import {
  Card,
  Pill,
  Cite,
  SectionH,
  Bar,
  EmptyState,
  fmtINR,
} from "../components/primitives";
import {
  newRegimeTax,
  oldRegimeTax,
  NEW_REGIME_SLABS,
  OLD_REGIME_SLABS,
} from "../components/tax-calc";

const FIXED_DARK = "#1d1d1b";

export default function Optimize({
  report,
  salaryIncome,
  onSalaryChange,
  ask,
}: {
  report: TaxReportResult;
  salaryIncome: number;
  onSalaryChange: (n: number) => void;
  ask: (q: string) => void;
}) {
  const router = useRouter();
  const harvesting = report.harvesting;
  const cgTax =
    report.capitalGains.equity.stcg.tax + report.capitalGains.equity.ltcg.tax;

  const [harvestTarget, setHarvestTarget] = useState<{
    symbol: string;
    saving: number;
    loss: number;
  } | null>(null);

  const topOpp = harvesting.opportunities[0] ?? null;

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <SectionH
        n="03 · OPTIMIZE"
        title={
          <>
            Pay less tax, <span className="ser">legally.</span>
          </>
        }
        meta="auto-ranked by ₹ saved"
      />

      {/* ── Top move: harvest plan ── */}
      {harvesting.opportunities.length === 0 ? (
        <EmptyState
          title="No harvest opportunities right now"
          body={
            <>
              Tax-loss harvesting opportunities show up when you hold positions
              at an unrealized loss that can offset realised gains. We&rsquo;ll
              surface them here with the exact ₹ saved.
            </>
          }
          icon={<Scissors className="h-5 w-5" />}
          ticket="MONEY-486"
        />
      ) : (
        <>
          <Card
            tilt="l"
            style={{
              background: "var(--pop-2)",
              border: "2px solid var(--ink)",
              boxShadow: "var(--shadow-hard)",
            }}
          >
            <div
              className="flex items-start justify-between"
              style={{ flexWrap: "wrap", gap: 16 }}
            >
              <div style={{ flex: 1, minWidth: 280 }}>
                <div className="flex items-center gap-2">
                  <Pill
                    style={{
                      background: FIXED_DARK,
                      color: "var(--pop-2)",
                      borderColor: FIXED_DARK,
                    }}
                  >
                    ★ TOP MOVE
                  </Pill>
                  <span
                    className="mono"
                    style={{ fontSize: 11, color: "#3a3a35", letterSpacing: 1 }}
                  >
                    saves up to {fmtINR(harvesting.totalPotentialSaving)}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 10,
                    fontSize: 21,
                    fontWeight: 800,
                    color: FIXED_DARK,
                    letterSpacing: -0.6,
                    lineHeight: 1.25,
                  }}
                >
                  Harvest{" "}
                  <span
                    style={{
                      background: FIXED_DARK,
                      color: "var(--pop-2)",
                      padding: "0 7px",
                      borderRadius: 5,
                    }}
                  >
                    {fmtINR(Math.abs(topOpp?.unrealizedLoss ?? 0))} loss
                  </span>{" "}
                  across{" "}
                  <span className="ser">
                    {harvesting.opportunities.length} holding
                    {harvesting.opportunities.length === 1 ? "" : "s"}.
                  </span>
                </div>
                <div
                  className="ser"
                  style={{
                    marginTop: 8,
                    fontSize: 14,
                    color: "#3a3a35",
                    lineHeight: 1.5,
                  }}
                >
                  Top candidate:{" "}
                  <b
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontStyle: "normal",
                    }}
                  >
                    {topOpp?.symbol}
                  </b>
                  . Sell to book the loss, then re-enter after a 30-day gap to
                  avoid scrutiny.
                </div>
              </div>
              {topOpp ? (
                <button
                  type="button"
                  className="pf-bs sm"
                  style={{
                    background: FIXED_DARK,
                    borderColor: FIXED_DARK,
                    color: "var(--pop-2)",
                  }}
                  onClick={() =>
                    setHarvestTarget({
                      symbol: topOpp.symbol,
                      saving: topOpp.potentialTaxSaving,
                      loss: topOpp.unrealizedLoss,
                    })
                  }
                >
                  Show plan &rarr;
                </button>
              ) : null}
            </div>
          </Card>

          {/* Remaining opportunities */}
          {harvesting.opportunities.length > 1 ? (
            <div
              className="grid grid-cols-1 lg:grid-cols-2"
              style={{ gap: 14 }}
            >
              {harvesting.opportunities.slice(1).map((opp, i) => (
                <Card key={`${opp.symbol}-${i}`}>
                  <div className="flex items-center gap-3">
                    <span
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background:
                          opp.type === "STCG" ? "var(--pop-2)" : "var(--pop-3)",
                        color: opp.type === "STCG" ? "#1d1d1b" : "var(--paper)",
                        border: "1.5px solid var(--ink)",
                        display: "grid",
                        placeItems: "center",
                        transform: "rotate(-3deg)",
                        fontWeight: 800,
                        fontSize: 12,
                      }}
                      className="mono"
                    >
                      {i + 2}
                    </span>
                    <div
                      style={{
                        fontWeight: 800,
                        fontSize: 15,
                        letterSpacing: -0.3,
                        flex: 1,
                      }}
                    >
                      {opp.symbol}
                    </div>
                    <Pill tone="emerald">
                      saves {fmtINR(opp.potentialTaxSaving)}
                    </Pill>
                  </div>
                  <div
                    className="ser"
                    style={{
                      marginTop: 10,
                      fontSize: 14,
                      color: "var(--ink-3)",
                    }}
                  >
                    Unrealized loss {fmtINR(opp.unrealizedLoss)} · held{" "}
                    {opp.holdingDays} days · {opp.type}
                  </div>
                  <button
                    type="button"
                    className="pf-bf sm"
                    style={{ marginTop: 12 }}
                    onClick={() =>
                      setHarvestTarget({
                        symbol: opp.symbol,
                        saving: opp.potentialTaxSaving,
                        loss: opp.unrealizedLoss,
                      })
                    }
                  >
                    Show plan
                  </button>
                </Card>
              ))}
            </div>
          ) : null}
        </>
      )}

      {/* ── Regime sandbox ── */}
      <SectionH
        n="03 · REGIME SANDBOX"
        title={
          <>
            Old vs New, <span className="ser">side by side.</span>
          </>
        }
      />
      <RegimeSandbox
        salaryIncome={salaryIncome}
        onSalaryChange={onSalaryChange}
        cgTax={cgTax}
      />

      {/* ── What-if + advance tax ── */}
      <SectionH
        n="03 · ADVANCE TAX"
        title={
          <>
            The quarterly <span className="ser">clock.</span>
          </>
        }
        meta="s.234B / s.234C"
      />
      <AdvanceTaxTimeline advanceTax={report.advanceTax} />

      <EmptyState
        title="What-if rebalance simulator"
        body={
          <>
            Pick scrips to sell and instantly see the tax cost, regime impact,
            and surcharge-band change before you place a single order. Wiring
            this to live holdings is tracked under MONEY-486.
          </>
        }
        icon={<Sparkles className="h-5 w-5" />}
        cta={
          <button
            type="button"
            className="pf-bf sm"
            onClick={() =>
              ask("Simulate the tax cost of selling some holdings")
            }
          >
            Ask StockSage to simulate
          </button>
        }
      />

      {/* ── Cross-link to Risk ── */}
      <Card tilt="l" style={{ background: "var(--paper-2)" }}>
        <div
          className="flex items-center"
          style={{ gap: 18, flexWrap: "wrap" }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 11,
              background: "var(--pop-3)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "2px solid var(--ink)",
              transform: "rotate(-4deg)",
              boxShadow: "var(--shadow-soft)",
              flexShrink: 0,
            }}
          >
            <Shield className="h-5 w-5" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="ttl">TAX × RISK</div>
            <div
              style={{
                marginTop: 4,
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: -0.4,
              }}
            >
              See how a <span className="hl-gold">rebalance</span> plays out for
              both tax and risk.
            </div>
            <div
              className="ser"
              style={{ fontSize: 13.5, color: "var(--ink-3)", marginTop: 4 }}
            >
              The Risk report&rsquo;s rebalance suggestions can be cross-checked
              here for STCG/LTCG impact.
            </div>
          </div>
          <button
            type="button"
            className="pf-bs sm"
            onClick={() => router.push("/risk")}
          >
            Open Risk &rarr;
          </button>
        </div>
      </Card>

      <HarvestConfirmDialog
        open={harvestTarget !== null}
        onClose={() => setHarvestTarget(null)}
        symbol={harvestTarget?.symbol ?? null}
        potentialSaving={harvestTarget?.saving ?? 0}
        unrealizedLoss={harvestTarget?.loss ?? 0}
        gaarWarning={harvesting.gaarWarning}
      />
    </div>
  );
}

/* ── Regime sandbox — reuses shared slab math + client-side salary ── */

function RegimeSandbox({
  salaryIncome,
  onSalaryChange,
  cgTax,
}: {
  salaryIncome: number;
  onSalaryChange: (n: number) => void;
  cgTax: number;
}) {
  const [draft, setDraft] = useState(String(salaryIncome || ""));
  const [editing, setEditing] = useState(salaryIncome === 0);

  if (salaryIncome === 0 || editing) {
    return (
      <Card>
        <div className="flex items-center gap-3" style={{ flexWrap: "wrap" }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 9,
              background: "var(--emerald)",
              color: "var(--paper)",
              border: "1.5px solid var(--ink)",
              transform: "rotate(-3deg)",
              display: "grid",
              placeItems: "center",
              flexShrink: 0,
            }}
          >
            <Pencil className="h-4 w-4" />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontSize: 13.5, fontWeight: 800 }}>
              Add your salary to compare regimes
            </div>
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}
            >
              Annual gross — stays in your browser, never sent to our servers.
            </div>
          </div>
          <input
            type="text"
            inputMode="numeric"
            placeholder="e.g. 1440000"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            className="pf-input mono"
            style={{ padding: "8px 10px", fontSize: 13, width: 176 }}
          />
          <button
            type="button"
            className="pf-bs sm"
            onClick={() => {
              const n = parseInt(draft, 10) || 0;
              onSalaryChange(n);
              if (n > 0) setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      </Card>
    );
  }

  const newTax = newRegimeTax(salaryIncome) + cgTax;
  const oldTax = oldRegimeTax(salaryIncome) + cgTax;
  const newWins = newTax <= oldTax;
  const savings = Math.abs(newTax - oldTax);
  const slabNew = newRegimeTax(salaryIncome);
  const slabOld = oldRegimeTax(salaryIncome);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 14 }}>
      <Card style={{ background: newWins ? "var(--paper-2)" : "var(--paper)" }}>
        <div className="flex items-center justify-between">
          <div className="ttl">OLD REGIME</div>
          <Pill tone="outline">with 80C, 80D, HRA</Pill>
        </div>
        <div
          className="mono"
          style={{
            fontSize: 38,
            fontWeight: 800,
            marginTop: 12,
            letterSpacing: -1.2,
          }}
        >
          {fmtINR(oldTax)}
        </div>
        <div className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          indicative slab tax + CG tax
        </div>
        <div
          className="col"
          style={{
            marginTop: 14,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <Bar
            label="Slab tax (salary)"
            pct={oldTax > 0 ? (slabOld / oldTax) * 100 : 0}
            value={fmtINR(slabOld)}
            color="var(--ink-3)"
          />
          <Bar
            label="Capital gains tax"
            pct={oldTax > 0 ? (cgTax / oldTax) * 100 : 0}
            value={fmtINR(cgTax)}
            color="var(--pop-2)"
          />
        </div>
        <div
          className="col"
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {OLD_REGIME_SLABS.map(([range, rate]) => (
            <div
              key={range}
              className="mono flex justify-between"
              style={{ fontSize: 11, color: "var(--ink-3)", padding: "2px 0" }}
            >
              <span>{range}</span>
              <span style={{ color: "var(--ink-2)", fontWeight: 600 }}>
                {rate}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Card
        tilt="r"
        style={{
          background: newWins ? "var(--emerald)" : "var(--paper-2)",
          color: newWins ? "var(--paper)" : "var(--ink)",
        }}
      >
        <div className="flex items-center justify-between">
          <div
            className="ttl"
            style={{
              // var(--paper) flips with the theme: cream on light mode's
              // emerald, deep-ink on dark mode's brighter emerald (the fixed
              // cream rgba washed out there).
              color: newWins ? "var(--paper)" : "var(--ink-3)",
            }}
          >
            NEW REGIME {newWins ? "· YOUR PICK" : ""}
          </div>
          {newWins ? (
            <Pill
              style={{
                background: FIXED_DARK,
                // Constant-dark pill needs a constant-cream label —
                // var(--paper) flipped to deep-ink in dark mode (invisible).
                color: "var(--code-fg)",
                borderColor: FIXED_DARK,
              }}
            >
              ★ saves {fmtINR(savings)}
            </Pill>
          ) : (
            <Pill tone="outline">switch saves {fmtINR(savings)}</Pill>
          )}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 38,
            fontWeight: 800,
            marginTop: 12,
            letterSpacing: -1.2,
          }}
        >
          {fmtINR(newTax)}
        </div>
        <div
          className="mono"
          style={{
            fontSize: 11,
            color: newWins ? "rgba(247,243,230,0.7)" : "var(--ink-3)",
          }}
        >
          no deductions · lower slabs + CG tax
        </div>
        <div
          className="col"
          style={{
            marginTop: 14,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <Bar
            label="Slab tax (salary)"
            pct={newTax > 0 ? (slabNew / newTax) * 100 : 0}
            value={fmtINR(slabNew)}
            color={newWins ? "rgba(247,243,230,0.45)" : "var(--ink-3)"}
          />
          <Bar
            label="Capital gains tax"
            pct={newTax > 0 ? (cgTax / newTax) * 100 : 0}
            value={fmtINR(cgTax)}
            color="var(--pop-2)"
          />
        </div>
        <div
          className="col"
          style={{
            marginTop: 12,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {NEW_REGIME_SLABS.map(([range, rate]) => (
            <div
              key={range}
              className="mono flex justify-between"
              style={{
                fontSize: 11,
                color: newWins ? "rgba(247,243,230,0.7)" : "var(--ink-3)",
                padding: "2px 0",
              }}
            >
              <span>{range}</span>
              <span
                style={{
                  color: newWins ? "var(--paper)" : "var(--ink-2)",
                  fontWeight: 600,
                }}
              >
                {rate}
              </span>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="pf-bf sm"
          style={{
            marginTop: 14,
            borderColor: newWins ? "var(--paper)" : "var(--ink)",
            color: newWins ? "var(--paper)" : "var(--ink)",
            background: "transparent",
          }}
          onClick={() => setEditing(true)}
        >
          <Pencil className="h-3 w-3" /> Edit salary ({fmtINR(salaryIncome)})
        </button>
        <div
          className="mono"
          style={{
            marginTop: 10,
            fontSize: 10,
            color: newWins ? "rgba(247,243,230,0.6)" : "var(--ink-4)",
          }}
        >
          Indicative — 87A rebate excludes special-rate CG income{" "}
          <Cite>CBDT 2025</Cite>
        </div>
      </Card>
    </div>
  );
}
