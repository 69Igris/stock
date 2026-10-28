/**
 * Compute Macro Impact Tool
 *
 * Sensitivity analysis: given a sector and a macro scenario, estimate the
 * expected impact on stocks in that sector using a hardcoded historical
 * sensitivity matrix.
 *
 * Scenarios:
 *   - rate_cut: RBI cuts repo rate by 25-50bps
 *   - rate_hike: RBI raises repo rate by 25-50bps
 *   - rupee_depreciation: INR depreciates 3-5% vs USD
 *   - oil_spike: Brent crude spikes 15-25%
 *   - inflation_rise: CPI inflation rises above 6%
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// ─── Types ───────────────────────────────────────────────────

type Scenario =
  | "rate_cut"
  | "rate_hike"
  | "rupee_depreciation"
  | "oil_spike"
  | "inflation_rise";

interface SensitivityEntry {
  impact:
    | "very_positive"
    | "positive"
    | "neutral"
    | "negative"
    | "very_negative";
  magnitude: number; // -5 to +5 scale
  historicalBasis: string;
  affectedStocks: string[];
  interpretation: string;
}

const VALID_SCENARIOS: Scenario[] = [
  "rate_cut",
  "rate_hike",
  "rupee_depreciation",
  "oil_spike",
  "inflation_rise",
];

// ─── Sensitivity Matrix ──────────────────────────────────────
// (sector, scenario) → impact data
// Based on historical patterns from Indian markets

const SENSITIVITY_MATRIX: Record<string, Record<Scenario, SensitivityEntry>> = {
  banking: {
    rate_cut: {
      impact: "very_positive",
      magnitude: 4,
      historicalBasis:
        "Lower rates boost loan demand and treasury gains on bond portfolios. Banks saw 8-15% rallies post 2019-20 rate cuts.",
      affectedStocks: [
        "HDFCBANK.NS",
        "ICICIBANK.NS",
        "SBIN.NS",
        "KOTAKBANK.NS",
        "AXISBANK.NS",
      ],
      interpretation:
        "Rate cuts are strongly bullish for banks - NIM may compress slightly but credit growth and bond gains more than offset.",
    },
    rate_hike: {
      impact: "negative",
      magnitude: -3,
      historicalBasis:
        "Higher rates dampen loan demand and cause mark-to-market losses on bond holdings. Banks corrected 5-10% during 2022 rate hike cycle.",
      affectedStocks: [
        "HDFCBANK.NS",
        "ICICIBANK.NS",
        "SBIN.NS",
        "KOTAKBANK.NS",
        "AXISBANK.NS",
      ],
      interpretation:
        "Rate hikes hurt banks initially via treasury losses and slower credit growth, though NIMs expand over time.",
    },
    rupee_depreciation: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Weak rupee increases cost of hedging forex exposure and raises NPA risk for import-dependent borrowers.",
      affectedStocks: ["SBIN.NS", "ICICIBANK.NS", "AXISBANK.NS"],
      interpretation:
        "Banks with large corporate loan books face higher NPA risk from rupee depreciation; retail-focused banks less affected.",
    },
    oil_spike: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Oil spikes trigger inflation → rate hikes → indirect impact on banking sector via credit quality deterioration.",
      affectedStocks: ["SBIN.NS", "ICICIBANK.NS"],
      interpretation:
        "Oil spikes have a lagged negative impact on banks through the inflation → rate hike → NPA channel.",
    },
    inflation_rise: {
      impact: "neutral",
      magnitude: -1,
      historicalBasis:
        "Moderate inflation may help NIMs if rates rise, but high inflation hurts asset quality.",
      affectedStocks: ["HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS"],
      interpretation:
        "Impact depends on magnitude - moderate inflation is neutral to mildly positive, but elevated inflation triggers rate hikes.",
    },
  },

  it: {
    rate_cut: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "IT companies have low debt; rate changes have minimal direct impact.",
      affectedStocks: [
        "TCS.NS",
        "INFY.NS",
        "WIPRO.NS",
        "HCLTECH.NS",
        "TECHM.NS",
      ],
      interpretation:
        "IT sector is largely rate-agnostic; growth depends on global tech spending.",
    },
    rate_hike: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "Minimal debt on balance sheets means direct impact is negligible.",
      affectedStocks: [
        "TCS.NS",
        "INFY.NS",
        "WIPRO.NS",
        "HCLTECH.NS",
        "TECHM.NS",
      ],
      interpretation: "IT sector is insulated from domestic rate changes.",
    },
    rupee_depreciation: {
      impact: "very_positive",
      magnitude: 4,
      historicalBasis:
        "Every 1% INR depreciation adds ~40bps to operating margins. IT stocks rallied 10-20% during 2018 and 2022 rupee weakness.",
      affectedStocks: [
        "TCS.NS",
        "INFY.NS",
        "WIPRO.NS",
        "HCLTECH.NS",
        "TECHM.NS",
      ],
      interpretation:
        "Rupee depreciation is a direct tailwind - 60-75% of revenue is USD-denominated.",
    },
    oil_spike: {
      impact: "neutral",
      magnitude: -1,
      historicalBasis:
        "IT companies have low energy costs; indirect macro uncertainty is the main risk.",
      affectedStocks: ["TCS.NS", "INFY.NS"],
      interpretation:
        "Minimal direct impact; any effect comes through broader macro sentiment.",
    },
    inflation_rise: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Wage inflation in India (60-65% of costs) directly compresses margins.",
      affectedStocks: [
        "TCS.NS",
        "INFY.NS",
        "WIPRO.NS",
        "HCLTECH.NS",
        "TECHM.NS",
      ],
      interpretation:
        "Domestic inflation raises employee costs, the largest expense for IT firms.",
    },
  },

  "oil & gas": {
    rate_cut: {
      impact: "positive",
      magnitude: 1,
      historicalBasis:
        "Capital-intensive sector benefits from lower borrowing costs.",
      affectedStocks: [
        "RELIANCE.NS",
        "ONGC.NS",
        "IOC.NS",
        "BPCL.NS",
        "GAIL.NS",
      ],
      interpretation:
        "Moderate positive impact through lower financing costs for capex-heavy projects.",
    },
    rate_hike: {
      impact: "negative",
      magnitude: -1,
      historicalBasis:
        "Higher interest costs on large debt books compress profitability.",
      affectedStocks: ["RELIANCE.NS", "ONGC.NS", "IOC.NS", "BPCL.NS"],
      interpretation:
        "Debt-heavy O&G firms face higher financing costs during rate hike cycles.",
    },
    rupee_depreciation: {
      impact: "negative",
      magnitude: -3,
      historicalBasis:
        "India imports ~85% of crude oil. Weak rupee amplifies the import bill. OMCs saw 15-20% decline in 2018 when INR fell to 74.",
      affectedStocks: ["IOC.NS", "BPCL.NS", "HINDPETRO.NS"],
      interpretation:
        "OMCs (marketing companies) hit hardest; upstream producers (ONGC) partially benefit from higher realisations.",
    },
    oil_spike: {
      impact: "very_negative",
      magnitude: -4,
      historicalBasis:
        "OMCs face under-recovery losses. In 2022, BPCL/IOC corrected 20-25% as crude hit $120+.",
      affectedStocks: ["IOC.NS", "BPCL.NS", "HINDPETRO.NS"],
      interpretation:
        "Oil marketing companies suffer from under-recovery; upstream producers (ONGC) benefit from higher realizations. Mixed within the sector.",
    },
    inflation_rise: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "Oil & Gas companies have pass-through mechanisms for cost inflation.",
      affectedStocks: ["RELIANCE.NS", "ONGC.NS"],
      interpretation:
        "Neutral - energy is a pass-through sector with government-regulated pricing.",
    },
  },

  fmcg: {
    rate_cut: {
      impact: "neutral",
      magnitude: 1,
      historicalBasis:
        "FMCG companies are typically low-debt; minimal direct impact.",
      affectedStocks: [
        "HINDUNILVR.NS",
        "ITC.NS",
        "NESTLEIND.NS",
        "BRITANNIA.NS",
        "DABUR.NS",
      ],
      interpretation:
        "FMCG is a defensive sector - rate changes have limited direct effect.",
    },
    rate_hike: {
      impact: "neutral",
      magnitude: -1,
      historicalBasis:
        "Low leverage insulates from rate hikes; demand may soften marginally.",
      affectedStocks: [
        "HINDUNILVR.NS",
        "ITC.NS",
        "NESTLEIND.NS",
        "BRITANNIA.NS",
      ],
      interpretation:
        "Defensive sector with inelastic demand; minimal rate sensitivity.",
    },
    rupee_depreciation: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Raw material imports (palm oil, crude-derived packaging) become costlier.",
      affectedStocks: ["HINDUNILVR.NS", "BRITANNIA.NS", "DABUR.NS"],
      interpretation:
        "Input cost inflation from imports; partial offset via pricing power and domestic sourcing.",
    },
    oil_spike: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Packaging costs (crude derivatives) and distribution costs rise. FMCG margins compressed 100-200bps during 2022 oil spike.",
      affectedStocks: [
        "HINDUNILVR.NS",
        "BRITANNIA.NS",
        "DABUR.NS",
        "NESTLEIND.NS",
      ],
      interpretation:
        "Oil spikes raise packaging and distribution costs, but FMCG companies have strong pricing power to pass through over time.",
    },
    inflation_rise: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Input cost inflation compresses margins before companies can take price hikes. Volume growth slows as consumers downgrade.",
      affectedStocks: [
        "HINDUNILVR.NS",
        "ITC.NS",
        "NESTLEIND.NS",
        "BRITANNIA.NS",
        "DABUR.NS",
      ],
      interpretation:
        "High inflation leads to consumer downtrading and margin pressure before pricing power kicks in.",
    },
  },

  auto: {
    rate_cut: {
      impact: "very_positive",
      magnitude: 4,
      historicalBasis:
        "Lower EMIs boost vehicle demand. Auto stocks rallied 15-25% post rate cuts in 2019-20.",
      affectedStocks: [
        "MARUTI.NS",
        "TATAMOTORS.NS",
        "M&M.NS",
        "BAJAJ-AUTO.NS",
        "HEROMOTOCO.NS",
      ],
      interpretation:
        "Rate cuts are strongly bullish - auto financing becomes cheaper, boosting demand across segments.",
    },
    rate_hike: {
      impact: "very_negative",
      magnitude: -4,
      historicalBasis:
        "Higher EMIs dampen vehicle demand. Auto stocks corrected 10-20% during 2022 rate hike cycle.",
      affectedStocks: [
        "MARUTI.NS",
        "TATAMOTORS.NS",
        "M&M.NS",
        "BAJAJ-AUTO.NS",
        "HEROMOTOCO.NS",
      ],
      interpretation:
        "Rate hikes directly reduce auto affordability - one of the most rate-sensitive sectors.",
    },
    rupee_depreciation: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Higher raw material import costs (steel, precious metals, electronics). Some offset from export revenue.",
      affectedStocks: ["MARUTI.NS", "TATAMOTORS.NS"],
      interpretation:
        "Input costs rise (imported components), partially offset for exporters like Tata Motors (JLR).",
    },
    oil_spike: {
      impact: "very_negative",
      magnitude: -4,
      historicalBasis:
        "Higher fuel costs reduce vehicle usage and demand. ICE-heavy OEMs suffer most. Auto corrected 15% during 2018 oil spike.",
      affectedStocks: ["MARUTI.NS", "HEROMOTOCO.NS", "BAJAJ-AUTO.NS"],
      interpretation:
        "Oil spikes dampen vehicle demand, especially for ICE vehicles. EV makers less affected.",
    },
    inflation_rise: {
      impact: "negative",
      magnitude: -3,
      historicalBasis:
        "Raw material inflation (steel, aluminium, rubber) compresses margins. Consumer discretionary spending weakens.",
      affectedStocks: ["MARUTI.NS", "TATAMOTORS.NS", "M&M.NS", "BAJAJ-AUTO.NS"],
      interpretation:
        "Double whammy - input cost inflation and reduced consumer purchasing power.",
    },
  },

  pharma: {
    rate_cut: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "Pharma companies have moderate leverage; minimal rate sensitivity.",
      affectedStocks: [
        "SUNPHARMA.NS",
        "DRREDDY.NS",
        "CIPLA.NS",
        "DIVISLAB.NS",
        "APOLLOHOSP.NS",
      ],
      interpretation: "Defensive sector with limited rate sensitivity.",
    },
    rate_hike: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "Healthcare demand is inelastic; rate changes have negligible impact.",
      affectedStocks: ["SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS"],
      interpretation:
        "Pharma demand is non-discretionary - insulated from rate changes.",
    },
    rupee_depreciation: {
      impact: "positive",
      magnitude: 3,
      historicalBasis:
        "Export-oriented pharma benefits from INR weakness. 40-60% revenue from US/EU markets. Pharma rallied during 2018 and 2022 INR weakness.",
      affectedStocks: ["SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS", "DIVISLAB.NS"],
      interpretation:
        "Strong positive for export-oriented companies; domestic-focused (hospitals) see input cost rise.",
    },
    oil_spike: {
      impact: "neutral",
      magnitude: -1,
      historicalBasis:
        "Some raw materials are crude-derived (solvents, packaging), but impact is limited.",
      affectedStocks: ["SUNPHARMA.NS", "CIPLA.NS"],
      interpretation:
        "Minor negative via crude-derived API intermediates; overall defensive nature dominates.",
    },
    inflation_rise: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "Drug pricing is regulated; both costs and revenues are relatively sticky.",
      affectedStocks: ["SUNPHARMA.NS", "DRREDDY.NS", "CIPLA.NS"],
      interpretation:
        "Pharma is a classic defensive - inflation-resistant demand profile.",
    },
  },

  metals: {
    rate_cut: {
      impact: "positive",
      magnitude: 2,
      historicalBasis:
        "Capital-intensive sector benefits from lower financing costs. Also signals growth → commodity demand.",
      affectedStocks: [
        "TATASTEEL.NS",
        "HINDALCO.NS",
        "JSWSTEEL.NS",
        "COALINDIA.NS",
        "VEDL.NS",
      ],
      interpretation:
        "Rate cuts signal economic growth, which increases commodity demand.",
    },
    rate_hike: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Higher borrowing costs on heavy capex + rate hikes signal demand slowdown.",
      affectedStocks: ["TATASTEEL.NS", "HINDALCO.NS", "JSWSTEEL.NS"],
      interpretation:
        "Rate hikes increase financing costs and signal potential demand destruction.",
    },
    rupee_depreciation: {
      impact: "positive",
      magnitude: 2,
      historicalBasis:
        "Export realizations improve in INR terms. Domestic prices also get floor from higher import parity.",
      affectedStocks: ["TATASTEEL.NS", "HINDALCO.NS", "VEDL.NS"],
      interpretation:
        "Metal exporters benefit; domestic producers get higher import parity pricing.",
    },
    oil_spike: {
      impact: "negative",
      magnitude: -3,
      historicalBasis:
        "Energy is 20-30% of steel/aluminium production cost. Oil spike squeezes margins sharply.",
      affectedStocks: ["TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS"],
      interpretation:
        "Metals are highly energy-intensive - oil spikes directly compress operating margins.",
    },
    inflation_rise: {
      impact: "positive",
      magnitude: 2,
      historicalBasis:
        "Metals are themselves an inflation hedge - commodity prices typically rise with inflation.",
      affectedStocks: [
        "TATASTEEL.NS",
        "HINDALCO.NS",
        "COALINDIA.NS",
        "VEDL.NS",
      ],
      interpretation:
        "Metals act as an inflation hedge - rising commodity prices lift realisations.",
    },
  },

  realty: {
    rate_cut: {
      impact: "very_positive",
      magnitude: 5,
      historicalBasis:
        "Lower home loan rates boost demand. Realty stocks surged 20-40% after 2020 rate cuts.",
      affectedStocks: [
        "DLF.NS",
        "GODREJPROP.NS",
        "OBEROIRLTY.NS",
        "PRESTIGE.NS",
        "BRIGADE.NS",
      ],
      interpretation:
        "Most rate-sensitive sector - home loan EMI reduction directly drives buyer demand.",
    },
    rate_hike: {
      impact: "very_negative",
      magnitude: -5,
      historicalBasis:
        "Higher home loan rates kill demand. Realty was the worst-performing sector during 2022-23 rate hikes.",
      affectedStocks: [
        "DLF.NS",
        "GODREJPROP.NS",
        "OBEROIRLTY.NS",
        "PRESTIGE.NS",
        "BRIGADE.NS",
      ],
      interpretation:
        "Rate hikes are devastating for realty - both demand (higher EMIs) and supply (higher construction finance costs).",
    },
    rupee_depreciation: {
      impact: "neutral",
      magnitude: 0,
      historicalBasis:
        "Domestic demand-driven sector with minimal forex exposure.",
      affectedStocks: ["DLF.NS", "GODREJPROP.NS"],
      interpretation:
        "Neutral - realty is a domestic play. NRI remittances may increase slightly on weaker INR.",
    },
    oil_spike: {
      impact: "negative",
      magnitude: -2,
      historicalBasis:
        "Construction material costs (cement, steel, bitumen) rise with oil prices.",
      affectedStocks: ["DLF.NS", "GODREJPROP.NS", "OBEROIRLTY.NS"],
      interpretation:
        "Input cost inflation from crude-linked construction materials.",
    },
    inflation_rise: {
      impact: "negative",
      magnitude: -3,
      historicalBasis:
        "Construction costs rise + triggers rate hikes which compound the demand destruction.",
      affectedStocks: [
        "DLF.NS",
        "GODREJPROP.NS",
        "OBEROIRLTY.NS",
        "PRESTIGE.NS",
      ],
      interpretation:
        "Inflation triggers rate hikes, which are the biggest risk for realty. Double negative.",
    },
  },
};

// Sector name normalization map
const SECTOR_ALIASES: Record<string, string> = {
  bank: "banking",
  banks: "banking",
  finance: "banking",
  financial: "banking",
  nbfc: "banking",
  finserv: "banking",
  technology: "it",
  tech: "it",
  infotech: "it",
  software: "it",
  oil: "oil & gas",
  energy: "oil & gas",
  petroleum: "oil & gas",
  "oil and gas": "oil & gas",
  oilandgas: "oil & gas",
  consumer: "fmcg",
  "consumer staples": "fmcg",
  automobile: "auto",
  automotive: "auto",
  vehicles: "auto",
  healthcare: "pharma",
  health: "pharma",
  pharmaceutical: "pharma",
  steel: "metals",
  metal: "metals",
  mining: "metals",
  commodities: "metals",
  "real estate": "realty",
  realstate: "realty",
  property: "realty",
  housing: "realty",
  construction: "realty",
};

function normalizeSector(input: string): string {
  const lower = input.toLowerCase().trim();
  return SECTOR_ALIASES[lower] || lower;
}

// ─── Tool Definition ─────────────────────────────────────────

export const computeMacroImpactTool: ResearchToolDef = {
  name: "compute_macro_impact",
  description:
    "Compute expected sector-level impact of macroeconomic scenarios (rate cut/hike, rupee depreciation, oil spike, inflation rise) using historical sensitivity data",
  category: "computation",
  parameters: {
    sector: {
      type: "string",
      description:
        "Sector name (banking, it, oil & gas, fmcg, auto, pharma, metals, realty)",
      required: true,
    },
    scenario: {
      type: "string",
      description:
        "Macro scenario: rate_cut, rate_hike, rupee_depreciation, oil_spike, inflation_rise",
      required: true,
    },
  },
  cacheTTL: 86_400, // 24 hours - sensitivity matrix is static
  execute: async (params): Promise<ToolOutput> => {
    const rawSector = params.sector as string;
    const rawScenario = params.scenario as string;

    if (!rawSector) {
      return { success: false, error: "sector is required" };
    }
    if (!rawScenario) {
      return { success: false, error: "scenario is required" };
    }

    const sector = normalizeSector(rawSector);
    const scenario = rawScenario.toLowerCase().trim() as Scenario;

    if (!VALID_SCENARIOS.includes(scenario)) {
      return {
        success: false,
        error: `Invalid scenario "${rawScenario}". Valid values: ${VALID_SCENARIOS.join(", ")}`,
      };
    }

    const sectorData = SENSITIVITY_MATRIX[sector];
    if (!sectorData) {
      const availableSectors = Object.keys(SENSITIVITY_MATRIX).join(", ");
      return {
        success: false,
        error: `Sector "${rawSector}" (normalized: "${sector}") not found in sensitivity matrix. Available sectors: ${availableSectors}`,
      };
    }

    const entry = sectorData[scenario];

    try {
      const scenarioLabels: Record<Scenario, string> = {
        rate_cut: "RBI rate cut (25-50bps)",
        rate_hike: "RBI rate hike (25-50bps)",
        rupee_depreciation: "INR depreciation (3-5% vs USD)",
        oil_spike: "Crude oil spike (15-25%)",
        inflation_rise: "CPI inflation above 6%",
      };

      return {
        success: true,
        data: {
          sector: rawSector,
          normalizedSector: sector,
          scenario,
          scenarioDescription: scenarioLabels[scenario],
          expectedImpact: entry.impact,
          magnitude: entry.magnitude,
          magnitudeLabel: magnitudeLabel(entry.magnitude),
          historicalBasis: entry.historicalBasis,
          affectedStocks: entry.affectedStocks,
          interpretation: entry.interpretation,
        },
        metadata: {
          source: "Historical sensitivity analysis",
          availableScenarios: VALID_SCENARIOS,
          availableSectors: Object.keys(SENSITIVITY_MATRIX),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Macro impact computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function magnitudeLabel(mag: number): string {
  if (mag >= 4) return "Strong positive (+++)";
  if (mag >= 2) return "Moderate positive (++)";
  if (mag >= 1) return "Mild positive (+)";
  if (mag === 0) return "Neutral (=)";
  if (mag >= -1) return "Mild negative (-)";
  if (mag >= -3) return "Moderate negative (--)";
  return "Strong negative (---)";
}
