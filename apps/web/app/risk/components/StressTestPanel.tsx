"use client";

/**
 * StressTestPanel - design Risk.jsx (Image #40).
 *
 * 6 scenario rows: icon + name + date·duration + multi-line narrative,
 * portfolio % impact right-aligned with PORTFOLIO caption.
 *
 * Data sourced from PortfolioRiskResult.stressTest computed by
 * packages/services/src/risk-stress-test.ts against the user's real
 * sector mix - no fixture rows.
 */

import type { PortfolioRiskResult } from "@/lib/actions/risk";
import {
  TrendingDown,
  Pill,
  Vote,
  TrendingUp,
  DollarSign,
  Cpu,
  type LucideIcon,
} from "lucide-react";

interface Props {
  data: PortfolioRiskResult;
}

const ICON: Record<string, LucideIcon> = {
  gfc: TrendingDown,
  covid: Pill,
  election: Vote,
  rate: TrendingUp,
  fx: DollarSign,
  sector: Cpu,
};

// Tilted-chip background colors per scenario, mapped to playful pop tokens.
// gfc uses --neg-text (red-700 light / bright coral dark) so the chip and its
// var(--paper) icon keep contrast in dark mode — a fixed #b91c1c fill went
// dark-on-dark against the flipped paper icon.
const TONE_COLOR: Record<string, string> = {
  gfc: "var(--neg-text)",
  covid: "var(--pop-1)",
  election: "var(--pop-2)",
  rate: "var(--pop-5)",
  fx: "var(--emerald)",
  sector: "var(--pop-3)",
};

// Text-contrast siblings of TONE_COLOR (AA on cream in light mode). Used for
// the % impact number; the chip background keeps the bright TONE_COLOR.
const TONE_TEXT_COLOR: Record<string, string> = {
  gfc: "var(--neg-text)",
  covid: "var(--pop-1-text)",
  election: "var(--pop-2-text)",
  rate: "var(--pop-5-text)",
  fx: "var(--emerald-text)",
  sector: "var(--pop-3-text)",
};

function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "−";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

export default function StressTestPanel({ data }: Props) {
  const scenarios = data.stressTest?.scenarios ?? [];
  if (scenarios.length === 0) return null;

  return (
    <>
      {/* Section header (design: "things go sideways") */}
      <div className="pf-sec-h">
        <span className="n">SCENARIOS</span>
        <h3>
          What happens if <span className="ser">things go sideways.</span>
        </h3>
        <span className="rule" />
        <span className="meta">{scenarios.length} scenarios · sector mix</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {scenarios.map((s) => {
          const Icon = ICON[s.iconKey] ?? TrendingDown;
          const color =
            s.tone === "pos"
              ? "var(--emerald)"
              : (TONE_COLOR[s.iconKey] ?? "var(--neg-text)");
          const textColor =
            s.tone === "pos"
              ? "var(--emerald-text)"
              : (TONE_TEXT_COLOR[s.iconKey] ?? "var(--neg-text)");
          return (
            <div key={s.id} className="pf-card" style={{ padding: 16 }}>
              <div className="flex items-center gap-2.5 mb-2.5">
                <span
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: color,
                    color: "var(--paper)",
                    display: "grid",
                    placeItems: "center",
                    border: "1.5px solid var(--ink)",
                    transform: "rotate(-3deg)",
                    flexShrink: 0,
                  }}
                >
                  <Icon className="h-[15px] w-[15px]" />
                </span>
                <div className="text-[14px] font-extrabold tracking-[-0.2px] text-[var(--ink)]">
                  {s.label}
                </div>
              </div>
              <div
                className="mono"
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  color: textColor,
                  letterSpacing: -0.5,
                }}
              >
                {fmtPct(s.pct)}
              </div>
              <div className="mt-2 text-[12px] text-[var(--ink-3)] leading-snug">
                {s.narrative}
              </div>
              <div className="mono mt-2 text-[10.5px] text-[var(--ink-3)]">
                {s.date} · {s.duration}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
