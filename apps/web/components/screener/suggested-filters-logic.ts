/**
 * Which filters the screener sidebar should SUGGEST, and which are already in
 * use (MONEY-1246 / MONEY-1247).
 *
 * Pure and shared on purpose. Both rules previously lived inline — the chip
 * list as a bare constant in the component, the "is this filter set" test
 * duplicated inside each FilterCard's `active` prop — which is precisely why
 * the two drifted: every one of the six suggestions named a filter the sidebar
 * was already rendering a card for, so SUGGESTED could never offer anything
 * new.
 *
 * Exported so the component and its tests execute the SAME code. A test that
 * re-implements these rules would pass while the shipped list stayed wrong.
 */

/** Ids match the FilterCard element ids, so a pick can scroll to its card. */
export const SUGGESTED_FILTERS = [
  { id: "pe", label: "P/E ratio" },
  { id: "roe", label: "ROE" },
  { id: "mcap", label: "Market cap" },
  { id: "rev", label: "Revenue YoY" },
  { id: "de", label: "D/E" },
  { id: "div", label: "Div yield" },
] as const;

export type SuggestedFilter = (typeof SUGGESTED_FILTERS)[number];

/**
 * The chips worth showing: everything the user has NOT already applied.
 * Returns a new array; empty means the section should not render at all,
 * since an empty "SUGGESTED" heading reads as a broken section.
 */
export function remainingSuggestions(
  activeIds: readonly string[] = []
): SuggestedFilter[] {
  return SUGGESTED_FILTERS.filter((s) => !activeIds.includes(s.id));
}

/** The subset of screen filters that decides whether a metric is in use. */
export interface SuggestableFilterState {
  marketCapBucket?: unknown;
  minMarketCap?: number | null;
  maxMarketCap?: number | null;
  minPe?: number | null;
  maxPe?: number | null;
  minRoe?: number | null;
  maxRoe?: number | null;
  minRevenueGrowth?: number | null;
  maxRevenueGrowth?: number | null;
  minDebtToEquity?: number | null;
  maxDebtToEquity?: number | null;
  minDividendYield?: number | null;
  maxDividendYield?: number | null;
}

/**
 * Ids whose filter currently has a value — mirrors each FilterCard's own
 * `active` expression, in one place rather than six.
 *
 * Uses `!= null`, never truthiness: a bound of 0 (min dividend yield 0,
 * max D/E 0) is a DELIBERATE filter, and treating it as unset would put the
 * metric back in the suggestions while the user is actively filtering on it.
 * ANY single bound counts — a min alone is still a filter.
 */
export function deriveActiveFilterIds(f: SuggestableFilterState): string[] {
  const ids: string[] = [];
  if (
    f.marketCapBucket != null ||
    f.minMarketCap != null ||
    f.maxMarketCap != null
  ) {
    ids.push("mcap");
  }
  if (f.minPe != null || f.maxPe != null) ids.push("pe");
  if (f.minRoe != null || f.maxRoe != null) ids.push("roe");
  if (f.minRevenueGrowth != null || f.maxRevenueGrowth != null) ids.push("rev");
  if (f.minDebtToEquity != null || f.maxDebtToEquity != null) ids.push("de");
  if (f.minDividendYield != null || f.maxDividendYield != null) ids.push("div");
  return ids;
}

// ── ETF (MONEY-1248) ───────────────────────────────────────────────────
//
// Stocks and ETFs screen on different things, so they get different metric
// sets — but they share `remainingSuggestions` above rather than each growing
// a private copy of the "hide what's already applied" rule. That duplication
// is exactly what let the stocks chips drift into suggesting six filters the
// sidebar already displayed.

/**
 * ETF metrics offered by the picker and the chips.
 *
 * Only filters whose UI is ACTUALLY RENDERED by FundFilterSidebar. `riskLevel`
 * and several sliders are commented out under TODO(MONEY-367) pending data
 * density, and suggesting one would send the user to a control that isn't
 * there — a dead end dressed as a shortcut, which is the very bug class
 * MONEY-1246 fixed.
 */
export const SUGGESTED_ETF_FILTERS = [
  { id: "amc", label: "Fund house" },
  { id: "category", label: "Category" },
  { id: "assetClass", label: "Asset class" },
  { id: "theme", label: "Theme" },
  { id: "exchange", label: "Exchange" },
] as const;

/**
 * DELIBERATELY ABSENT: `Max expense`, `Min 1Y return` and `Min AUM`.
 *
 * Those three sliders are commented out in FundFilterSidebar under
 * TODO(MONEY-367) — `MutualFundMaster.{returns1Y, expenseRatio, aum}` is too
 * sparsely populated for them to behave, so the UI was pulled while the
 * where-clause stayed wired. Offering them here would scroll the user to a
 * control that does not exist: a dead end wearing a shortcut's clothes, which
 * is the same defect MONEY-1246 fixed.
 *
 * When MONEY-367 revives those sliders, add the three ids back here AND to
 * `deriveActiveEtfFilterIds` — the derivation below already handles their
 * fields, so only this list gates them.
 */

export type SuggestedEtfFilter = (typeof SUGGESTED_ETF_FILTERS)[number];

/** ETF chips worth showing — same rule as stocks, different metric set. */
export function remainingEtfSuggestions(
  activeIds: readonly string[] = []
): SuggestedEtfFilter[] {
  return SUGGESTED_ETF_FILTERS.filter((s) => !activeIds.includes(s.id));
}

/** The ETF filter fields that decide whether a metric is in use. */
export interface SuggestableEtfFilterState {
  exchange?: string | null;
  assetClass?: string | null;
  theme?: string | null;
  amcName?: string | null;
  category?: string | null;
  minAum?: number | null;
  maxAum?: number | null;
  minReturns1Y?: number | null;
  maxReturns1Y?: number | null;
  minExpenseRatio?: number | null;
  maxExpenseRatio?: number | null;
}

/**
 * Ids whose ETF filter currently has a value.
 *
 * Numeric bounds use `!= null` so a deliberate 0 (min AUM 0, max expense 0)
 * counts as set. The string filters additionally reject the EMPTY STRING:
 * `theme` is a free-text input that writes `undefined` when cleared, but a
 * stray `""` from a controlled input would otherwise read as an active filter
 * and hide a chip the user can still use.
 */
export function deriveActiveEtfFilterIds(
  f: SuggestableEtfFilterState
): string[] {
  const hasText = (v: string | null | undefined) => v != null && v !== "";
  const ids: string[] = [];
  if (f.minExpenseRatio != null || f.maxExpenseRatio != null)
    ids.push("expense");
  if (f.minReturns1Y != null || f.maxReturns1Y != null) ids.push("returns1y");
  if (f.minAum != null || f.maxAum != null) ids.push("aum");
  if (hasText(f.amcName)) ids.push("amc");
  if (hasText(f.category)) ids.push("category");
  if (hasText(f.assetClass)) ids.push("assetClass");
  if (hasText(f.theme)) ids.push("theme");
  if (hasText(f.exchange)) ids.push("exchange");
  return ids;
}

// ── Active-filter chips (MONEY-1251) ───────────────────────────────────
//
// The sidebar renders a FIXED set of controls while Ask Screener writes to the
// whole filter type — 17 MF fields against 3 controls, 11 ETF fields against 5.
// A chat-applied `minReturns5Y` or `plan` therefore narrowed results while
// being completely unrepresented: the user could see that something was
// filtering, but not what, and could only undo it with "Reset all".
//
// These derive the chip list from the filter STATE rather than from which
// controls happen to exist, so anything reachable by the chat is visible and
// individually removable — including the fields whose sliders MONEY-367
// deliberately pulled for sparse data. Showing one of those is not a revival
// of the slider; it is being honest that the filter is on.

/** One active filter, ready to render as a removable chip. */
export interface ActiveFilterChip {
  /** Filter field(s) this chip clears when removed. */
  keys: string[];
  /** Human label, e.g. "5Y return ≥ 12%". */
  label: string;
}

const pctText = (v: number) => `${v}%`;
/** AUM is stored in rupees; show crore, which is how funds are discussed. */
const crText = (v: number) =>
  `₹${Math.round(v / 10_000_000).toLocaleString("en-IN")} Cr`;

/**
 * Build chips for a min/max pair so a two-sided range reads as ONE chip
 * ("1Y return 10–30%") rather than two that can be removed independently and
 * leave a half-range behind.
 */
function rangeChip(
  label: string,
  minKey: string,
  maxKey: string,
  min: number | null | undefined,
  max: number | null | undefined,
  fmt: (v: number) => string
): ActiveFilterChip | null {
  const hasMin = min != null;
  const hasMax = max != null;
  if (!hasMin && !hasMax) return null;
  if (hasMin && hasMax) {
    return {
      keys: [minKey, maxKey],
      label: `${label} ${fmt(min)}–${fmt(max)}`,
    };
  }
  return hasMin
    ? { keys: [minKey], label: `${label} ≥ ${fmt(min as number)}` }
    : { keys: [maxKey], label: `${label} ≤ ${fmt(max as number)}` };
}

/** Non-empty string filter → one chip. */
function textChip(
  label: string,
  key: string,
  v: string | null | undefined
): ActiveFilterChip | null {
  // `!= null && !== ""`: a controlled input can leave "" behind, which is not
  // an active filter and must not render a chip the user cannot meaningfully
  // remove.
  if (v == null || v === "") return null;
  return { keys: [key], label: `${label}: ${v}` };
}

/** Every active MF filter, including ones with no sidebar control. */
export function deriveActiveMfChips(
  f: Record<string, unknown>
): ActiveFilterChip[] {
  const n = (k: string) => f[k] as number | null | undefined;
  const s = (k: string) => f[k] as string | null | undefined;
  const chips: (ActiveFilterChip | null)[] = [
    textChip("Category", "category", s("category")),
    textChip("AMC", "amcName", s("amcName")),
    textChip("Plan", "plan", s("plan")),
    textChip("Risk", "riskLevel", s("riskLevel")),
    textChip("Type", "fundType", s("fundType")),
    rangeChip("AUM", "minAum", "maxAum", n("minAum"), n("maxAum"), crText),
    rangeChip(
      "1Y return",
      "minReturns1Y",
      "maxReturns1Y",
      n("minReturns1Y"),
      n("maxReturns1Y"),
      pctText
    ),
    rangeChip(
      "3Y return",
      "minReturns3Y",
      "maxReturns3Y",
      n("minReturns3Y"),
      n("maxReturns3Y"),
      pctText
    ),
    rangeChip(
      "5Y return",
      "minReturns5Y",
      "maxReturns5Y",
      n("minReturns5Y"),
      n("maxReturns5Y"),
      pctText
    ),
    rangeChip(
      "Expense",
      "minExpenseRatio",
      "maxExpenseRatio",
      n("minExpenseRatio"),
      n("maxExpenseRatio"),
      pctText
    ),
  ];
  // `amcAny` is a multi-select the chat can also write; summarise rather than
  // rendering one chip per AMC.
  const amcAny = f.amcAny as readonly string[] | undefined;
  if (amcAny && amcAny.length > 0) {
    chips.push({
      keys: ["amcAny"],
      label: `AMC: ${amcAny.length === 1 ? amcAny[0] : `${amcAny.length} selected`}`,
    });
  }
  return chips.filter((c): c is ActiveFilterChip => c !== null);
}

/** Every active ETF filter, including ones with no sidebar control. */
export function deriveActiveEtfChips(
  f: Record<string, unknown>
): ActiveFilterChip[] {
  const n = (k: string) => f[k] as number | null | undefined;
  const s = (k: string) => f[k] as string | null | undefined;
  return [
    textChip("Exchange", "exchange", s("exchange")),
    textChip("Fund house", "amcName", s("amcName")),
    textChip("Category", "category", s("category")),
    textChip("Asset class", "assetClass", s("assetClass")),
    textChip("Theme", "theme", s("theme")),
    rangeChip("AUM", "minAum", "maxAum", n("minAum"), n("maxAum"), crText),
    rangeChip(
      "1Y return",
      "minReturns1Y",
      "maxReturns1Y",
      n("minReturns1Y"),
      n("maxReturns1Y"),
      pctText
    ),
    rangeChip(
      "Expense",
      "minExpenseRatio",
      "maxExpenseRatio",
      n("minExpenseRatio"),
      n("maxExpenseRatio"),
      pctText
    ),
  ].filter((c): c is ActiveFilterChip => c !== null);
}
