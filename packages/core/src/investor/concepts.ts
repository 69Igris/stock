/**
 * Static investing-concept taxonomy + prerequisite DAG (MONEY-787, B2).
 *
 * Dependency-free. This is the curriculum the mastery model is keyed against:
 * each {@link Concept} has a stable slug `id` (e.g. "valuation.pe-ratio"), a
 * domain, a human-readable name, an `order` within its domain, and the list of
 * concept ids that must be understood first (`prerequisiteConceptIds`).
 *
 * The prerequisite edges form a Directed Acyclic Graph (a concept never,
 * directly or transitively, depends on itself). `concepts.test.ts` asserts
 * both the acyclicity and that every referenced prerequisite id exists.
 */

export type ConceptDomain =
  | "asset-classes"
  | "valuation"
  | "risk"
  | "derivatives"
  | "taxation"
  | "portfolio"
  | "macro";

export interface Concept {
  /** Stable taxonomy slug, e.g. "valuation.pe-ratio". */
  id: string;
  domain: ConceptDomain;
  /** Human-readable label. */
  name: string;
  /** Display order within the domain (lower = earlier / more foundational). */
  order: number;
  /** Concept ids that must be learned before this one. */
  prerequisiteConceptIds: string[];
}

/**
 * The full concept list. `<-` in the comments denotes "requires". Roots have
 * no prerequisites.
 */
const CONCEPTS: readonly Concept[] = [
  // ── Asset classes ──────────────────────────────────────────────
  {
    id: "asset.equity",
    domain: "asset-classes",
    name: "Equity / Stocks",
    order: 0,
    prerequisiteConceptIds: [],
  },
  {
    id: "asset.mutual-fund",
    domain: "asset-classes",
    name: "Mutual Funds",
    order: 1,
    prerequisiteConceptIds: ["asset.equity"],
  },
  {
    id: "asset.etf",
    domain: "asset-classes",
    name: "ETFs",
    order: 2,
    prerequisiteConceptIds: ["asset.mutual-fund"],
  },
  {
    id: "asset.bonds",
    domain: "asset-classes",
    name: "Bonds & Debt",
    order: 3,
    prerequisiteConceptIds: [],
  },
  {
    id: "asset.gold",
    domain: "asset-classes",
    name: "Gold",
    order: 4,
    prerequisiteConceptIds: [],
  },
  {
    id: "asset.fno",
    domain: "asset-classes",
    name: "Futures & Options",
    order: 5,
    prerequisiteConceptIds: ["asset.equity", "deriv.options-greeks"],
  },

  // ── Valuation ──────────────────────────────────────────────────
  {
    id: "valuation.pe-ratio",
    domain: "valuation",
    name: "P/E Ratio",
    order: 0,
    prerequisiteConceptIds: ["asset.equity"],
  },
  {
    id: "valuation.pb-ratio",
    domain: "valuation",
    name: "P/B Ratio",
    order: 1,
    prerequisiteConceptIds: ["asset.equity"],
  },
  {
    id: "valuation.dcf",
    domain: "valuation",
    name: "Discounted Cash Flow",
    order: 2,
    prerequisiteConceptIds: ["valuation.pe-ratio"],
  },

  // ── Risk ───────────────────────────────────────────────────────
  {
    id: "risk.volatility",
    domain: "risk",
    name: "Volatility",
    order: 0,
    prerequisiteConceptIds: ["asset.equity"],
  },
  {
    id: "risk.beta",
    domain: "risk",
    name: "Beta",
    order: 1,
    prerequisiteConceptIds: ["risk.volatility"],
  },
  {
    id: "risk.drawdown",
    domain: "risk",
    name: "Drawdown",
    order: 2,
    prerequisiteConceptIds: ["risk.volatility"],
  },
  {
    id: "risk.var",
    domain: "risk",
    name: "Value at Risk (VaR)",
    order: 3,
    prerequisiteConceptIds: ["risk.volatility", "risk.drawdown"],
  },
  {
    id: "risk.concentration",
    domain: "risk",
    name: "Concentration Risk",
    order: 4,
    prerequisiteConceptIds: ["asset.equity"],
  },

  // ── Derivatives ────────────────────────────────────────────────
  {
    id: "deriv.options-greeks",
    domain: "derivatives",
    name: "Option Greeks",
    order: 0,
    prerequisiteConceptIds: ["asset.equity", "risk.volatility"],
  },
  {
    id: "deriv.margins",
    domain: "derivatives",
    name: "Margins & Leverage",
    order: 1,
    prerequisiteConceptIds: ["asset.fno"],
  },
  {
    id: "deriv.expiry",
    domain: "derivatives",
    name: "Expiry & Settlement",
    order: 2,
    prerequisiteConceptIds: ["asset.fno"],
  },

  // ── Taxation ───────────────────────────────────────────────────
  {
    id: "tax.stcg",
    domain: "taxation",
    name: "Short-Term Capital Gains",
    order: 0,
    prerequisiteConceptIds: ["asset.equity"],
  },
  {
    id: "tax.ltcg",
    domain: "taxation",
    name: "Long-Term Capital Gains",
    order: 1,
    prerequisiteConceptIds: ["asset.equity"],
  },
  {
    id: "tax.harvesting",
    domain: "taxation",
    name: "Tax-Loss Harvesting",
    order: 2,
    prerequisiteConceptIds: ["tax.stcg", "tax.ltcg"],
  },

  // ── Portfolio ──────────────────────────────────────────────────
  {
    id: "portfolio.diversification",
    domain: "portfolio",
    name: "Diversification",
    order: 0,
    prerequisiteConceptIds: ["asset.equity", "risk.concentration"],
  },
  {
    id: "portfolio.asset-allocation",
    domain: "portfolio",
    name: "Asset Allocation",
    order: 1,
    prerequisiteConceptIds: [
      "portfolio.diversification",
      "asset.bonds",
      "asset.gold",
    ],
  },
  {
    id: "portfolio.rebalancing",
    domain: "portfolio",
    name: "Rebalancing",
    order: 2,
    prerequisiteConceptIds: ["portfolio.asset-allocation"],
  },

  // ── Macro ──────────────────────────────────────────────────────
  {
    id: "macro.interest-rates",
    domain: "macro",
    name: "Interest Rates",
    order: 0,
    prerequisiteConceptIds: ["asset.bonds"],
  },
  {
    id: "macro.inr-currency",
    domain: "macro",
    name: "INR & Currency",
    order: 1,
    prerequisiteConceptIds: [],
  },
  {
    id: "macro.sectors",
    domain: "macro",
    name: "Sectors & Cycles",
    order: 2,
    prerequisiteConceptIds: ["asset.equity"],
  },
];

const BY_ID: ReadonlyMap<string, Concept> = new Map(
  CONCEPTS.map((c) => [c.id, c]),
);

/** Look up a single concept by its slug. Returns `undefined` if not found. */
export function getConcept(id: string): Concept | undefined {
  return BY_ID.get(id);
}

/** All concepts in the taxonomy, in declaration order. */
export function allConcepts(): readonly Concept[] {
  return CONCEPTS;
}

/** All concepts in a given domain, sorted by their `order`. */
export function conceptsByDomain(domain: ConceptDomain): Concept[] {
  return CONCEPTS.filter((c) => c.domain === domain).sort(
    (a, b) => a.order - b.order,
  );
}
