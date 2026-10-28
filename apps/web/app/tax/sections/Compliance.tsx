"use client";

/* =====================================================================
   Tax Report v2 — Compliance section (MONEY-485)
   Compliance calendar (real, deterministic dates derived from the FY),
   AIS reconcile (→ AIS upload dialog), residential status, clubbing.
   The compliance calendar is real (date math). AIS diff / residential /
   clubbing need data the backend doesn't yet supply → honest empties.
   ===================================================================== */

import { useState } from "react";
import { Check, Upload, Bell, UserCheck, GitMerge } from "lucide-react";
import type { TaxReportResult } from "@/lib/actions/tax";
import { AISUploadDialog } from "../components/TaxDialogs";
import {
  Card,
  Pill,
  Cite,
  SectionH,
  SubTabs,
  EmptyState,
  type Tone,
} from "../components/primitives";

type ComplianceTab = "calendar" | "reconcile" | "status" | "clubbing";

const TABS: Array<{ id: ComplianceTab; label: string }> = [
  { id: "calendar", label: "Compliance calendar" },
  { id: "reconcile", label: "AIS reconcile" },
  { id: "status", label: "Residential status" },
  { id: "clubbing", label: "Clubbing & gifts" },
];

/* Deterministic statutory dates for a given FY. FY "2024-25" → AY 2025-26. */
function complianceCalendar(fy: string): Array<{
  date: string;
  iso: string;
  task: string;
  priority: "high" | "med" | "low";
}> {
  const startYear = parseInt(fy.split("-")[0]!, 10);
  const ay = startYear + 1; // assessment year
  const mk = (
    label: string,
    isoDate: string,
    task: string,
    priority: "high" | "med" | "low"
  ) => ({
    date: label,
    iso: isoDate,
    task,
    priority,
  });
  return [
    mk("15 Mar", `${ay}-03-15`, "Q4 advance tax (100% of liability)", "high"),
    mk(
      "31 Mar",
      `${ay}-03-31`,
      `FY ${fy} close · last day for tax-saving`,
      "high"
    ),
    mk("15 Jun", `${ay}-06-15`, "Form 16 from employer (typical)", "med"),
    mk("31 Jul", `${ay}-07-31`, "ITR-2 filing deadline (non-audit)", "high"),
    mk("31 Oct", `${ay}-10-31`, "Tax audit u/s 44AB (if applicable)", "med"),
    mk("31 Dec", `${ay}-12-31`, "Belated / revised return cut-off", "low"),
  ];
}

function daysFromNow(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

export default function Compliance({
  report,
  fy,
  ask,
}: {
  report: TaxReportResult;
  fy: string;
  ask: (q: string) => void;
}) {
  const [tab, setTab] = useState<ComplianceTab>("calendar");
  const [aisOpen, setAisOpen] = useState(false);

  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <SectionH
        n="04 · COMPLIANCE"
        title={
          <>
            The boxes <span className="ser">we tick for you.</span>
          </>
        }
        meta={
          report.advanceTax.isApplicable
            ? "advance tax applicable"
            : "advance tax not applicable"
        }
      />

      <SubTabs items={TABS} active={tab} onChange={setTab} />

      <div style={{ marginTop: 4 }}>
        {tab === "calendar" && <ComplianceCalendar fy={fy} />}
        {tab === "reconcile" && (
          <AISReconcile onUpload={() => setAisOpen(true)} ask={ask} />
        )}
        {tab === "status" && <ResidentialStatus ask={ask} />}
        {tab === "clubbing" && <Clubbing ask={ask} />}
      </div>

      <AISUploadDialog open={aisOpen} onClose={() => setAisOpen(false)} />
    </div>
  );
}

/* ── Compliance calendar (real dates) ────────────────────────────── */

function ComplianceCalendar({ fy }: { fy: string }) {
  const items = complianceCalendar(fy);
  const priorityTone: Record<"high" | "med" | "low", Tone> = {
    high: "coral",
    med: "gold",
    low: "outline",
  };
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      {items.map((it, i) => {
        const days = daysFromNow(it.iso);
        const passed = days < 0;
        const urgent = !passed && days <= 30 && it.priority === "high";
        return (
          <div
            key={it.iso}
            className="flex items-center"
            style={{
              padding: 14,
              gap: 14,
              borderTop: i > 0 ? "1px dashed var(--rule-soft)" : "none",
              background: urgent ? "var(--rule-softer)" : "transparent",
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 9,
                flexShrink: 0,
                background: "var(--paper-2)",
                border: "1.5px solid var(--ink)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                transform: "rotate(-3deg)",
              }}
            >
              <div
                className="mono"
                style={{ fontSize: 9, color: "var(--ink-3)" }}
              >
                {it.date.split(" ")[1]?.toUpperCase()}
              </div>
              <div className="mono" style={{ fontSize: 15, fontWeight: 800 }}>
                {it.date.split(" ")[0]}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{it.task}</div>
              <div
                className="mono"
                style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}
              >
                {passed ? "passed" : `${days} days from now`}
              </div>
            </div>
            <Pill tone={priorityTone[it.priority]}>{it.priority}</Pill>
            <button
              type="button"
              className="pf-bf sm"
              disabled
              style={{ opacity: 0.6 }}
            >
              <Bell className="h-3 w-3" /> Remind
            </button>
          </div>
        );
      })}
    </Card>
  );
}

/* ── AIS reconcile (flow entry) ──────────────────────────────────── */

function AISReconcile({
  onUpload,
  ask,
}: {
  onUpload: () => void;
  ask: (q: string) => void;
}) {
  return (
    <div
      className="col"
      style={{ display: "flex", flexDirection: "column", gap: 14 }}
    >
      <Card tilt="l">
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
            <Upload className="h-5 w-5" />
          </div>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div className="ttl">AIS RECONCILE</div>
            <div
              style={{
                marginTop: 4,
                fontSize: 16,
                fontWeight: 800,
                letterSpacing: -0.4,
              }}
            >
              Match against the{" "}
              <span className="hl-gold">IT Department&rsquo;s</span> data.
            </div>
            <div
              className="ser"
              style={{ fontSize: 13.5, color: "var(--ink-3)", marginTop: 4 }}
            >
              Your Annual Information Statement is what the tax department sees.
              Reconciling early avoids notices later.
            </div>
          </div>
          <button type="button" className="pf-bs sm" onClick={onUpload}>
            <Upload className="h-3 w-3" /> Upload AIS &rarr;
          </button>
        </div>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 14 }}>
        {[
          {
            l: "MATCHES",
            tone: "emerald" as Tone,
            note: "after you upload AIS",
          },
          {
            l: "FLAGGED · NEEDS YOU",
            tone: "gold" as Tone,
            note: "missing in your tradebook",
          },
          {
            l: "DISPUTE",
            tone: "coral" as Tone,
            note: "draft feedback letters",
          },
        ].map((c) => (
          <Card key={c.l} style={{ background: "var(--paper-2)" }}>
            <div className="ttl">{c.l}</div>
            <div
              className="mono"
              style={{
                fontSize: 32,
                fontWeight: 800,
                marginTop: 8,
                letterSpacing: -1,
                color: "var(--ink-3)",
              }}
            >
              —
            </div>
            <div
              className="mono"
              style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}
            >
              {c.note}
            </div>
          </Card>
        ))}
      </div>

      <EmptyState
        title="Line-by-line AIS diff"
        body={
          <>
            Upload your AIS PDF and we&rsquo;ll diff it against your synced
            trades, dividends, and TDS &mdash; flagging date, quantity, and
            cost-basis mismatches with one-click resolutions. Reconcile engine
            tracked under MONEY-486.
          </>
        }
        icon={<Upload className="h-5 w-5" />}
        cta={
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => ask("How do I reconcile my AIS with my trades?")}
          >
            Ask StockSage about AIS
          </button>
        }
      />
    </div>
  );
}

/* ── Residential status (educational placeholder) ────────────────── */

function ResidentialStatus({ ask }: { ask: (q: string) => void }) {
  const states = [
    {
      label: "Resident",
      desc: "Global income taxed. Schedule FA required.",
      tone: "emerald" as Tone,
    },
    {
      label: "RNOR",
      desc: "Indian income + foreign income from an Indian business. No FA for 2y after returning.",
      tone: "outline" as Tone,
    },
    {
      label: "NRI",
      desc: "Only Indian income taxed. ITR-2 mandatory if income > ₹2.5L.",
      tone: "outline" as Tone,
    },
  ];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 14 }}>
      <EmptyState
        title="Residential status — needs your travel data"
        body={
          <>
            Your status (Resident / RNOR / NRI) is decided by days spent in
            India under s.6. Add your travel dates and we&rsquo;ll apply the
            182-day and 60+365-day tests automatically.
          </>
        }
        icon={<UserCheck className="h-5 w-5" />}
        cta={
          <button
            type="button"
            className="pf-bf sm"
            onClick={() =>
              ask("Help me determine my residential status under section 6")
            }
          >
            Ask StockSage to check
          </button>
        }
      />
      <Card>
        <div className="ttl">
          THE THREE STATUSES <Cite>s.6</Cite>
        </div>
        <div
          className="col"
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {states.map((st) => (
            <div
              key={st.label}
              style={{
                padding: 12,
                background: "var(--paper-2)",
                borderRadius: 8,
                border: "1.5px solid var(--rule-soft)",
              }}
            >
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: 4 }}
              >
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>
                  {st.label}
                </span>
                <Pill tone={st.tone}>
                  {st.label === "Resident" ? "most common" : "conditional"}
                </Pill>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 11.5,
                  color: "var(--ink-3)",
                  lineHeight: 1.45,
                }}
              >
                {st.desc}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/* ── Clubbing & gifts (educational placeholder) ──────────────────── */

function Clubbing({ ask }: { ask: (q: string) => void }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2" style={{ gap: 14 }}>
      <EmptyState
        title="Clubbing of income — needs declaration"
        body={
          <>
            Income from assets gifted to a spouse, minor child, or
            daughter-in-law is added to your income, not theirs. Declare those
            gifts and we&rsquo;ll fold the clubbed income into Schedule 5A.
          </>
        }
        icon={<GitMerge className="h-5 w-5" />}
        cta={
          <button
            type="button"
            className="pf-bf sm"
            onClick={() => ask("How does clubbing of income work?")}
          >
            Ask StockSage about clubbing
          </button>
        }
      />
      <Card>
        <div className="ttl">WHO GETS CLUBBED</div>
        <div
          className="col"
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {[
            { who: "Spouse — income on a gifted asset", cite: "s.64(1)(iv)" },
            {
              who: "Minor child — interest/income on a gift",
              cite: "s.64(1A)",
            },
            {
              who: "Daughter-in-law — income on a transfer",
              cite: "s.64(1)(vi)",
            },
          ].map((r) => (
            <div
              key={r.cite}
              className="flex items-center justify-between"
              style={{
                padding: 10,
                background: "var(--paper-2)",
                borderRadius: 8,
              }}
            >
              <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
                {r.who}
              </span>
              <Cite>{r.cite}</Cite>
            </div>
          ))}
        </div>
        <div
          className="flex gap-2"
          style={{
            marginTop: 12,
            padding: 10,
            background: "var(--emerald-bg)",
            borderRadius: 8,
            border: "1.5px solid var(--emerald)",
          }}
        >
          <Check
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--emerald-text)" }}
          />
          <span
            style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.45 }}
          >
            Once declared, clubbed income is auto-added to Schedule 5A of your
            ITR-2.
          </span>
        </div>
      </Card>
    </div>
  );
}
