/**
 * Stress-test scenarios for /risk.
 *
 * Applies fixed historical-event impact factors per asset class /
 * sector to the current portfolio's sector weights. This is a first-
 * cut compute that runs entirely on already-loaded holdings - no
 * external data fetch required. A heavier implementation that walks
 * each historical event's per-stock daily returns can replace
 * `SCENARIO_IMPACTS` later without touching the consumer.
 *
 * The impact factors are calibrated against published peak-to-trough
 * sector moves for each named event. Source notes:
 *   - 2020 COVID: NSE NIFTY 50 −38% Feb-Mar 2020; banks ~-50%, IT ~-25%
 *   - 2008 GFC: SENSEX −58% Jan'08-Oct'08; financials ~-65%, IT ~-50%
 *   - 2024 Election: NIFTY −5.9% on Jun 4 2024; PSU banks −15%
 *   - Rate cut +50bps: banks +6%, NBFC +8%, rate-sensitives positive
 *   - INR depreciation 5%: IT +6% (export beneficiary), oil −4%
 */

import { sectorKeyMatches } from "@usemoney/core/sector-key-match";

export type ScenarioIconKey =
  | "gfc"
  | "covid"
  | "election"
  | "rate"
  | "fx"
  | "sector";

export interface StressScenario {
  id: string;
  label: string;
  description: string;
  /** Display metadata for the design-spec row (Image #40). */
  iconKey: ScenarioIconKey;
  date: string; // e.g. "Sep 2008", "Mar 2020", "Jun 4"
  duration: string; // e.g. "6mo path", "21 trading days", "1-day shock"
  narrative: string; // multi-line "Nifty -38%. Banking -47%. Recovery: 14mo."
  /** Sector keyword → impact factor (as % e.g. -30 means a 30% drop) */
  sectorImpacts: Record<string, number>;
  /** Default impact applied when no sector keyword matches */
  defaultImpact: number;
  tone: "neg" | "pos";
}

export const SCENARIOS: StressScenario[] = [
  {
    id: "gfc-2008",
    label: "2008 GFC",
    description: "Global financial crisis. SENSEX −58% Jan-Oct 2008.",
    iconKey: "gfc",
    date: "Sep 2008",
    duration: "6mo path",
    narrative:
      "Nifty −38%. Banking −47%. Your sector tilt amplifies. Recovery: 14mo.",
    sectorImpacts: {
      bank: -47,
      financial: -45,
      // Realty was folded into Financial Services until 2026-07-30, so a DLF
      // holding used to pick up the -45 here. Splitting the sector out silently
      // dropped it to `defaultImpact` (-32) — the modelled loss SHRANK because
      // of a taxonomy change the user never made. Indian realty fell ~50% in
      // 2008, harder than banks, so the number was moving the wrong way.
      realty: -50,
      "real estate": -50,
      nbfc: -50,
      energy: -35,
      auto: -38,
      metal: -42,
      // MONEY-1093: `commodities` is the CANONICAL sector name; `metal` is not.
      commodities: -42,
      it: -28,
      pharma: -20,
      // MONEY-1093: `healthcare` is the CANONICAL sector name; `pharma` is not.
      healthcare: -20,
      fmcg: -18,
      consumer: -22,
    },
    defaultImpact: -32,
    tone: "neg",
  },
  {
    id: "covid-2020",
    label: "COVID crash",
    description: "Pandemic-induced lockdown selloff Feb-Mar 2020.",
    iconKey: "covid",
    date: "Mar 2020",
    duration: "21 trading days",
    narrative:
      "Nifty −33% in 6 weeks. IT shielded, banking down 42%. 5mo recovery.",
    sectorImpacts: {
      bank: -42,
      financial: -40,
      // Same correction as gfc-2008: realty was inheriting the financial
      // number and would otherwise fall through to defaultImpact (-28).
      realty: -42,
      "real estate": -42,
      nbfc: -44,
      energy: -38,
      auto: -36,
      metal: -38,
      // MONEY-1093: `commodities` is the CANONICAL sector name; `metal` is not.
      commodities: -38,
      it: -16,
      pharma: -12,
      // MONEY-1093: `healthcare` is the CANONICAL sector name; `pharma` is not.
      healthcare: -12,
      fmcg: -14,
      consumer: -22,
    },
    defaultImpact: -28,
    tone: "neg",
  },
  {
    id: "election-2024",
    label: "2024 election",
    description: "Verdict-day selloff on coalition uncertainty.",
    iconKey: "election",
    date: "Jun 4",
    duration: "1-day shock",
    narrative:
      "Verdict-day sell-off. PSU −18%, banks −7%. Your defensives clipped it.",
    sectorImpacts: {
      bank: -7,
      psu: -18,
      energy: -10,
      it: -2,
      pharma: -1,
      // MONEY-1093: `healthcare` is the CANONICAL sector name; `pharma` is not.
      healthcare: -1,
      fmcg: -1,
      defensive: -1,
    },
    defaultImpact: -5,
    tone: "neg",
  },
  {
    id: "rate-hike-100",
    label: "Rate hike +100bp",
    description: "Hypothetical · RBI hawkish surprise.",
    iconKey: "rate",
    date: "Hypothetical",
    duration: "RBI",
    narrative: "Rate-sensitive financials drag. Your IT + FMCG buffer holds.",
    sectorImpacts: {
      bank: -8,
      financial: -10,
      nbfc: -12,
      realty: -14,
      "real estate": -14,
      auto: -6,
      consumer: -4,
      it: 2,
      pharma: 1,
      // MONEY-1093: `healthcare` is the CANONICAL sector name; `pharma` is not.
      healthcare: 1,
      fmcg: 1,
    },
    defaultImpact: -3,
    tone: "neg",
  },
  {
    id: "inr-depreciation-5",
    label: "INR −5%",
    description: "Hypothetical · USD/INR. Weak rupee benefits exporters.",
    iconKey: "fx",
    date: "Hypothetical",
    duration: "USD/INR",
    narrative: "Net export beneficiary. IT services and pharma re-rate up.",
    sectorImpacts: {
      it: 6,
      technology: 6,
      pharma: 4,
      // MONEY-1093: `healthcare` is the CANONICAL sector name; `pharma` is not.
      healthcare: 4,
      energy: -4,
      oil: -4.5,
      metal: 2,
      // MONEY-1093: `commodities` is the CANONICAL sector name; `metal` is not.
      commodities: 2,
      auto: -3,
    },
    defaultImpact: 0,
    tone: "pos",
  },
  {
    id: "it-shock-20",
    label: "IT sector −20%",
    description: "Sector-specific stress on technology cluster.",
    iconKey: "sector",
    date: "Sector-specific",
    duration: "stress",
    narrative:
      "Your IT weight takes the brunt. Banking + energy hedge partial.",
    sectorImpacts: {
      it: -20,
      technology: -20,
      software: -22,
    },
    defaultImpact: -2,
    tone: "neg",
  },
];

export interface StressScenarioResult {
  id: string;
  label: string;
  description: string;
  iconKey: ScenarioIconKey;
  date: string;
  duration: string;
  narrative: string;
  /** Absolute INR delta applied to the portfolio (positive or negative). */
  inrDelta: number;
  /** Same delta expressed as a fraction of total portfolio value. */
  pct: number;
  tone: "neg" | "pos";
}

export interface StressTestResult {
  scenarios: StressScenarioResult[];
  portfolioValue: number;
  computedAt: string;
}

interface HoldingForStress {
  symbol: string;
  value: number;
  sector: string;
}

/**
 * Match the holding's sector to the most specific scenario keyword.
 *
 * The rule now lives in `@usemoney/core/sector-key-match`, shared with the
 * research planner, the sector-rotation tool, the health-score grader and the
 * macro-analysis skill. It was fixed here and in the planner while THREE other
 * copies kept the bug, and the comment here claimed the sweep was complete — so
 * a local copy is exactly what must not exist.
 */

function impactForSector(sector: string, scenario: StressScenario): number {
  const s = sector.toLowerCase();
  // longest keyword wins (more specific)
  const keys = Object.keys(scenario.sectorImpacts).sort(
    (a, b) => b.length - a.length,
  );
  for (const k of keys) {
    if (sectorKeyMatches(s, k.toLowerCase())) {
      return scenario.sectorImpacts[k]!;
    }
  }
  return scenario.defaultImpact;
}

/**
 * Apply a named scenario to a portfolio: each holding's value × sector
 * impact, summed; pct = total impact / portfolio value.
 */
export function applyScenario(
  scenario: StressScenario,
  holdings: HoldingForStress[],
): StressScenarioResult {
  let inrDelta = 0;
  let totalValue = 0;
  for (const h of holdings) {
    totalValue += h.value;
    const impactPct = impactForSector(h.sector, scenario);
    inrDelta += (h.value * impactPct) / 100;
  }
  const pct = totalValue > 0 ? (inrDelta / totalValue) * 100 : 0;
  return {
    id: scenario.id,
    label: scenario.label,
    description: scenario.description,
    iconKey: scenario.iconKey,
    date: scenario.date,
    duration: scenario.duration,
    narrative: scenario.narrative,
    inrDelta,
    pct,
    tone: inrDelta >= 0 ? "pos" : "neg",
  };
}

/**
 * Run all built-in scenarios against the portfolio. Pure function - no
 * IO. Used by the Risk service to attach `stressTest` to
 * `PortfolioRiskResult`.
 */
export function runStressTest(holdings: HoldingForStress[]): StressTestResult {
  const portfolioValue = holdings.reduce((s, h) => s + h.value, 0);
  return {
    scenarios: SCENARIOS.map((sc) => applyScenario(sc, holdings)),
    portfolioValue,
    computedAt: new Date().toISOString(),
  };
}
