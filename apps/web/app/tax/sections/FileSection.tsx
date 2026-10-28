"use client";

/* =====================================================================
   Tax Report v2 — File section (MONEY-485)
   3-step ITR-2 wizard, the 19 ITR-2 schedules walkthrough (Schedule CG
   wired to real itrSchedule data), export center (real CSV download via
   ExportDialog), and CA hand-off. Schedule values that the backend can't
   compute show honest "needs data" markers.
   ===================================================================== */

import { useState } from "react";
import { Download, GraduationCap, Check } from "lucide-react";
import type { TaxReportResult } from "@/lib/actions/tax";
import { ExportDialog } from "../components/TaxDialogs";
import { Card, Pill, SectionH, fmtINR } from "../components/primitives";

const FIXED_DARK = "#1d1d1b";

type SchedStatus = "ready" | "review" | "skip";

export default function FileSection({
  report,
  fy,
  ask,
}: {
  report: TaxReportResult;
  fy: string;
  ask: (q: string) => void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const cg = report.capitalGains;
  const itr = report.itrSchedule;

  // ITR-2 has 19 schedules. Schedule CG / SI / TI / TTI are partly wired to
  // the real computation; everything else is a "review" placeholder until the
  // backend supplies the figure (MONEY-486).
  const schedules: Array<{
    id: string;
    name: string;
    status: SchedStatus;
    value: string;
  }> = [
    { id: "S", name: "Salary", status: "review", value: "add Form 16" },
    {
      id: "HP",
      name: "House Property",
      status: "review",
      value: "add property",
    },
    {
      id: "CG",
      name: "Capital Gains",
      status: "ready",
      value: `${fmtINR(cg.equity.stcg.net + cg.equity.ltcg.net)} net`,
    },
    {
      id: "112A",
      name: "LTCG equity (scrip-wise)",
      status: "ready",
      value: `${fmtINR(itr.scheduleCG.s112A.ltcgGains)}`,
    },
    {
      id: "OS",
      name: "Other Sources",
      status: "review",
      value: "dividends · interest",
    },
    {
      id: "VDA",
      name: "Crypto / VDA",
      status: "review",
      value: "add exchange",
    },
    {
      id: "EI",
      name: "Exempt Income",
      status: "review",
      value: "auto from heads",
    },
    {
      id: "VIA",
      name: "Chapter VI-A Deductions",
      status: "review",
      value: "80C / 80D / 80G",
    },
    { id: "80G", name: "Donations", status: "skip", value: "none declared" },
    {
      id: "CYLA",
      name: "Current-year loss adjust.",
      status: "review",
      value: "set-off ladder",
    },
    {
      id: "BFLA",
      name: "Brought-forward loss adjust.",
      status: "review",
      value: "prior FY losses",
    },
    {
      id: "CFL",
      name: "Carry-forward losses",
      status: "review",
      value: "next 8 years",
    },
    { id: "FA", name: "Foreign Assets", status: "review", value: "add IBKR" },
    {
      id: "AL",
      name: "Assets & Liabilities",
      status: "review",
      value: "if income > ₹50L",
    },
    {
      id: "TR",
      name: "Foreign Tax Relief (DTAA)",
      status: "review",
      value: "Form 67",
    },
    { id: "5A", name: "Clubbing", status: "review", value: "spouse / minor" },
    {
      id: "SI",
      name: "Special-income summary",
      status: "ready",
      value: "auto from CG",
    },
    {
      id: "TI",
      name: "Total Income",
      status: "ready",
      value: fmtINR(cg.totalTax > 0 ? cg.totalTax : 0),
    },
    {
      id: "TTI",
      name: "Tax Computation",
      status: "ready",
      value: `${fmtINR(cg.totalTax)} tax`,
    },
  ];

  const readyCount = schedules.filter((s) => s.status === "ready").length;

  const steps: Array<{
    num: string;
    title: React.ReactNode;
    body: string;
    code: string[];
  }> = [
    {
      num: "01",
      title: (
        <>
          Pick the <span className="ser">right form.</span>
        </>
      ),
      body:
        cg.fno.net !== 0
          ? "ITR-3 (you have F&O business income). Auto-detected from your trades."
          : "ITR-2 (capital gains, no F&O business). Auto-detected from your trades.",
      code: [
        `form     · ${cg.fno.net !== 0 ? "ITR-3" : "ITR-2"}`,
        "regime   · New",
        "audit    · not required",
      ],
    },
    {
      num: "02",
      title: (
        <>
          Cross-check <span className="ser">AIS.</span>
        </>
      ),
      body: "Reconcile your trades, dividends, and TDS against the AIS before filing. Upload it in Compliance.",
      code: ["matches  · pending", "flagged  · pending", "dispute  · pending"],
    },
    {
      num: "03",
      title: (
        <>
          Generate & <span className="ser">e-verify.</span>
        </>
      ),
      body: "We pre-fill every schedule we can compute. You sign with Aadhaar OTP.",
      code: [
        `sched.CG · ${fmtINR(itr.scheduleCG.s111A.stcgGains + itr.scheduleCG.s112A.ltcgGains)}`,
        `sched.TI · ${fmtINR(cg.totalTax)}`,
        "ready    · e-verify",
      ],
    },
  ];

  const statusTone = (s: SchedStatus) =>
    s === "ready" ? "emerald" : s === "review" ? "gold" : "outline";

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <SectionH
        n="05 · FILE"
        title={
          <>
            Your{" "}
            <span className="ser">{cg.fno.net !== 0 ? "ITR-3" : "ITR-2"},</span>{" "}
            already drafted.
          </>
        }
        actions={
          <button
            type="button"
            className="pf-bs sm"
            onClick={() => setExportOpen(true)}
          >
            <Download className="h-3 w-3" /> Export
          </button>
        }
      />

      {/* 3-step wizard */}
      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
        {steps.map((s) => (
          <Card key={s.num}>
            <Pill tone="gold" style={{ marginBottom: 14 }}>
              STEP {s.num}
            </Pill>
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                letterSpacing: -0.4,
                lineHeight: 1.2,
              }}
            >
              {s.title}
            </div>
            <div
              style={{
                marginTop: 8,
                fontSize: 13,
                color: "var(--ink-3)",
                lineHeight: 1.5,
              }}
            >
              {s.body}
            </div>
            <div className="pf-codeblock" style={{ marginTop: 14 }}>
              {s.code.map((l, i) => {
                const [k, v] = l.split("·").map((p) => p.trim());
                return (
                  <div key={i}>
                    <span className="em">&rarr;</span>{" "}
                    <span className="dim">{k}</span>{" "}
                    <span className="gold">·</span> {v}
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
      </div>

      {/* 19 ITR schedules walkthrough */}
      <SectionH
        n="05 · SCHEDULES"
        title={
          <>
            Every schedule, <span className="ser">walked through.</span>
          </>
        }
        meta={`${readyCount} of ${schedules.length} auto-filled`}
      />
      <Card style={{ padding: 0, overflow: "hidden" }}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {schedules.map((s, i) => (
            <div
              key={s.id}
              className="flex items-center"
              style={{
                gap: 12,
                padding: "13px 16px",
                borderBottom: "1px dashed var(--rule-soft)",
                borderRight: "1px dashed var(--rule-soft)",
              }}
            >
              <span
                className="mono"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 7,
                  flexShrink: 0,
                  background:
                    s.status === "ready"
                      ? "var(--emerald)"
                      : s.status === "review"
                        ? "var(--pop-2)"
                        : "var(--paper-2)",
                  color:
                    s.status === "review"
                      ? "#1d1d1b"
                      : s.status === "ready"
                        ? "var(--paper)"
                        : "var(--ink-3)",
                  border: "1.5px solid var(--ink)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 9.5,
                  fontWeight: 800,
                  transform: "rotate(-3deg)",
                }}
              >
                {s.id}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>
                  {s.name}
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color: "var(--ink-3)",
                    marginTop: 2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {s.value}
                </div>
              </div>
              <Pill tone={statusTone(s.status)} style={{ flexShrink: 0 }}>
                {s.status === "ready" ? (
                  <Check className="h-2.5 w-2.5" />
                ) : (
                  s.status
                )}
              </Pill>
            </div>
          ))}
        </div>
      </Card>

      {/* Export center summary card */}
      <Card>
        <div
          className="flex items-center"
          style={{ gap: 18, flexWrap: "wrap" }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 11,
              background: "var(--emerald)",
              color: "var(--paper)",
              display: "grid",
              placeItems: "center",
              border: "2px solid var(--ink)",
              transform: "rotate(-4deg)",
              boxShadow: "var(--shadow-soft)",
              flexShrink: 0,
            }}
          >
            <Download className="h-5 w-5" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="ttl">EXPORT CENTER</div>
            <div
              style={{
                marginTop: 4,
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: -0.4,
              }}
            >
              Take it <span className="hl-gold">elsewhere.</span>
            </div>
            <div
              className="ser"
              style={{ fontSize: 13.5, color: "var(--ink-3)", marginTop: 4 }}
            >
              Capital-gains CSV is ready now. ITR-2 JSON and CA-ready PDF are on
              the way (MONEY-486).
            </div>
          </div>
          <button
            type="button"
            className="pf-bs sm"
            onClick={() => setExportOpen(true)}
          >
            Open export center &rarr;
          </button>
        </div>
      </Card>

      {/* CA hand-off */}
      <Card tilt="l" style={{ background: FIXED_DARK, color: "#f7f3e6" }}>
        <div
          className="flex items-center"
          style={{ gap: 18, flexWrap: "wrap" }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 12,
              background: "var(--pop-2)",
              color: FIXED_DARK,
              display: "grid",
              placeItems: "center",
              border: "2px solid var(--pop-2)",
              transform: "rotate(-4deg)",
              boxShadow: "3px 3px 0 #000",
              flexShrink: 0,
            }}
          >
            <GraduationCap className="h-6 w-6" />
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div className="ttl" style={{ color: "var(--pop-2)" }}>
              WANT A CA TO REVIEW?
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 17,
                fontWeight: 800,
                letterSpacing: -0.4,
              }}
            >
              We <span className="ser">pair you</span> with a qualified CA for
              the hand-off.
            </div>
            <div
              className="ser"
              style={{
                fontSize: 13.5,
                color: "rgba(247,243,230,0.7)",
                marginTop: 4,
              }}
            >
              They read your draft, flag issues, and e-sign with you. CA
              marketplace tracked under MONEY-486.
            </div>
          </div>
          <button
            type="button"
            className="pf-bs sm"
            style={{
              background: "var(--pop-2)",
              color: FIXED_DARK,
              borderColor: "var(--pop-2)",
            }}
            onClick={() => ask("Connect me with a CA to review my ITR")}
          >
            Talk to a CA &rarr;
          </button>
        </div>
      </Card>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        csvData={itr.csvData}
        summary={itr.summary}
        fy={fy}
      />
    </div>
  );
}
