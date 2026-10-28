/**
 * Paper-trading pure-logic helpers (web DB layer).
 *
 * `lib/db/paper.ts` is the LIVE paper-trading data layer: `lib/actions/paper.ts`
 * (`getPaperPositionsAction` / `createPaperPositionAction` /
 * `updatePaperPriceAction` / `closePaperPositionAction` / `getPaperPerformanceAction`
 * / `placeOrderAction` / `getPaperDashboardStatsAction`, all reachable from the
 * four `app/paper-trading/*` pages) calls into it. It is a SEPARATE
 * implementation from the `@usemoney/services` paper path and historically kept
 * its OWN un-guarded inline P&L / benchmark / win-rate / averaging math — which
 * is what these helpers extract so the LIVE path runs the SAME
 * finite-guarded math the regression tests assert.
 *
 * The bugs this closes (all user-visible — the values render via
 * `winRate.toFixed(1)`, `pnlPercentage.toFixed(2)`, `formatINR(avgWin)` etc. in
 * `app/paper-trading/*`):
 *
 *   - PORTFOLIO/PERFORMANCE non-finite poison: `totalInvested`/`totalCurrent`/
 *     `totalRealizedPnL`/`benchmarkPnL` are SUM surfaces — one corrupt
 *     `investedValue`/`currentValue`/`realizedPnL`/`benchmarkPnL` row (a NaN from
 *     a bad upstream divide, a stored ±Infinity — Prisma `Float` accepts them)
 *     turns the whole total into `NaN`/`Infinity` ("₹NaN" header).
 *   - `pnlPercentage` Infinity leak: the old `investedValue > 0` /
 *     `totalInvested > 0` gate is TRUE for `Infinity`, so an Infinity invested
 *     divided → `Infinity %`; a finite positive invested with an Infinity P&L →
 *     `Infinity %`. Both reach a persisted `Float` and a `.toFixed()`.
 *   - benchmark/alpha non-finite: `niftyReturn = (currentNifty - niftyAtEntry) /
 *     niftyAtEntry` poisons `benchmarkPnL` (and the derived `alpha`) when
 *     `currentNifty` is non-finite, and the value is PERSISTED.
 *   - average-into-position divide-by-zero: `newAvgPrice = totalValue / totalQty`
 *     is `NaN`/`Infinity` when `existing.quantity + data.quantity === 0` (a SHORT
 *     that exactly nets a LONG, or two zero-qty fills) — persisted as
 *     `averagePrice`/`investedValue`.
 *   - win-rate / best-worst NaN: `Math.max(...allPnls)` / a `reduce` sum
 *     propagate a NaN/Infinity realizedPnL element.
 *
 * Behaviour here is identical, for FINITE inputs, to the math that previously
 * lived inline in `lib/db/paper.ts`; the only intentional change is the
 * defensive non-finite / divide-by-zero guards documented per-function.
 *
 * Pure & Prisma-free so the web tests can import it via `@/lib/db/paper-logic`
 * without opening a DB connection at module load. Mirrors the `finite()`-guard
 * precedent in `./dashboard-logic.ts` / `./positions-logic.ts` and the service
 * `packages/services/src/paper-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard (LOCAL — mirrors ./dashboard-logic.ts#finite, kept local so
// this module stays Prisma-free and self-contained).
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * `??`/`|| 0` do NOT catch `NaN` in every path and NEVER catch `±Infinity`;
 * `Math.abs(NaN)` / `Math.max(NaN, …)` stay `NaN`. So every value that enters a
 * sum, a product, a ratio, a persisted Prisma `Float`, or a downstream
 * `.toFixed()`/`.toLocaleString()` is funnelled through this guard first.
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// P&L percentage (the strict finite/positive-divisor guard).
// ---------------------------------------------------------------------------

/**
 * P&L percentage as a finite number, `0` when the cost basis is not a usable
 * positive FINITE number OR the P&L itself is non-finite.
 *
 * The old inline guard was only `investedValue > 0` — which leaks two ways:
 *   - `Infinity > 0` is `true`, so an `Infinity` invested would divide;
 *   - a finite positive invested with an `Infinity` P&L yields `Infinity` %.
 * Both reach a persisted `Float` / a `.toFixed()` as `Infinity`. We require BOTH
 * operands finite and the divisor strictly positive.
 *
 * Behaviour-preserving for finite inputs: identical to
 * `investedValue > 0 ? (pnl / investedValue) * 100 : 0`.
 */
export function pnlPercentage(pnl: number, investedValue: number): number {
  if (!Number.isFinite(investedValue) || investedValue <= 0) return 0;
  if (!Number.isFinite(pnl)) return 0;
  return (pnl / investedValue) * 100;
}

// ---------------------------------------------------------------------------
// Default segment / side derivation (the "default-segment" branching the
// create paths inline). Pure string mapping; no math, but the source of subtle
// edge bugs (wrong segment for an option, missing side fallback).
// ---------------------------------------------------------------------------

export type PaperAssetType = "STOCK" | "FNO_FUTURES" | "FNO_OPTIONS" | "MF";

/**
 * Default trading `segment` for an asset type when the caller did not supply one.
 * Mirrors `createPaperPosition`'s inline:
 *   FNO_OPTIONS → "OPTIONS", FNO_FUTURES → "FUTURES", else → "EQUITY".
 */
export function defaultSegmentForAssetType(assetType: string): string {
  if (assetType === "FNO_OPTIONS") return "OPTIONS";
  if (assetType === "FNO_FUTURES") return "FUTURES";
  return "EQUITY";
}

/**
 * Resolve the persisted `segment`: an explicit value wins, else the asset-type
 * default. Mirrors `data.segment || (assetType === ... ? ... : "EQUITY")`.
 */
export function resolveSegment(
  segment: string | null | undefined,
  assetType: string
): string {
  return segment || defaultSegmentForAssetType(assetType);
}

/**
 * Resolve the persisted `side`: explicit side wins, else positionType, else
 * "LONG". Mirrors `data.side || data.positionType || "LONG"`.
 */
export function resolveSide(
  side: string | null | undefined,
  positionType: string | null | undefined
): string {
  return side || positionType || "LONG";
}

/**
 * Map an order `instrumentType` to the stored `assetType`. Mirrors the
 * `updateOrAveragePosition` ladder: OPTIONS → FNO_OPTIONS, FUTURES →
 * FNO_FUTURES, MF → MF, else → STOCK.
 */
export function assetTypeForInstrumentType(
  instrumentType: string
): PaperAssetType {
  if (instrumentType === "OPTIONS") return "FNO_OPTIONS";
  if (instrumentType === "FUTURES") return "FNO_FUTURES";
  if (instrumentType === "MF") return "MF";
  return "STOCK";
}

/** positionType for an order side: BUY → LONG, else SHORT. */
export function positionTypeForSide(side: string): "LONG" | "SHORT" {
  return side === "BUY" ? "LONG" : "SHORT";
}

// ---------------------------------------------------------------------------
// Per-position value / unrealized P&L (create + price-update paths).
// ---------------------------------------------------------------------------

/**
 * Invested value (cost basis) = `quantity * averagePrice`, finite-guarded so a
 * corrupt qty/price persists `0` rather than `NaN`/`Infinity`. Mirrors
 * `data.quantity * data.averagePrice`.
 */
export function investedValue(quantity: number, averagePrice: number): number {
  return finite(finite(quantity) * finite(averagePrice));
}

/**
 * Current (mark-to-market) value = `quantity * currentPrice`, finite-guarded.
 * Mirrors `position.quantity * currentPrice`.
 */
export function currentValue(quantity: number, currentPrice: number): number {
  return finite(finite(quantity) * finite(currentPrice));
}

/**
 * Unrealized P&L for an OPEN position from value endpoints.
 *   LONG : `currentValue - investedValue`
 *   SHORT (any non-LONG): `investedValue - currentValue`
 * Both addends finite-guarded. Mirrors `updatePaperPositionPrice`'s ternary.
 */
export function unrealizedPnL(
  positionType: string,
  currentVal: number,
  investedVal: number
): number {
  const c = finite(currentVal);
  const i = finite(investedVal);
  return positionType === "LONG" ? c - i : i - c;
}

/**
 * Realized P&L when CLOSING a position.
 *   LONG : `exitValue - investedValue`
 *   SHORT: `investedValue - exitValue`
 * where `exitValue = quantity * exitPrice`. Every operand finite-guarded and the
 * result re-guarded — so a corrupt exitPrice/qty (a non-web caller, a poisoned
 * row) can never PERSIST `NaN`/`Infinity` as `realizedPnL` nor leak into the
 * web action's `pnl.toLocaleString("en-IN")` success toast. Mirrors
 * `closePaperPosition`'s `exitValue ± investedValue`.
 */
export function realizedPnL(
  positionType: string,
  quantity: number,
  exitPrice: number,
  investedVal: number
): number {
  const exitValue = finite(finite(quantity) * finite(exitPrice));
  const invested = finite(investedVal);
  const pnl =
    positionType === "LONG" ? exitValue - invested : invested - exitValue;
  return finite(pnl);
}

// ---------------------------------------------------------------------------
// Benchmark (Nifty) comparison & alpha.
// ---------------------------------------------------------------------------

export interface BenchmarkResult {
  benchmarkPnL: number;
  alpha: number;
}

/**
 * Benchmark P&L (what the SAME capital would have returned tracking Nifty) and
 * alpha (position P&L over benchmark) for ONE position.
 *
 *   benchmarkPnL = investedValue * (currentNifty - niftyAtEntry) / niftyAtEntry
 *   alpha        = positionPnL - benchmarkPnL
 *
 * Returns `{ 0, 0 }` (the inline default when Nifty data is absent) unless BOTH
 * `niftyAtEntry` and `currentNifty` are FINITE and `niftyAtEntry` is non-zero —
 * the old `if (niftyAtEntry && currentNifty)` truthy gate let a non-finite
 * `currentNifty` through, poisoning the PERSISTED `benchmarkPnL`/`alpha`. Every
 * factor is finite-guarded. Mirrors the `updatePaperPositionPrice` /
 * `closePaperPosition` benchmark blocks.
 */
export function benchmarkAndAlpha(
  investedVal: number,
  positionPnL: number,
  niftyAtEntry: number | null | undefined,
  currentNifty: number | null | undefined
): BenchmarkResult {
  const entry = finite(niftyAtEntry);
  const current = finite(currentNifty);
  // Reproduce the truthy gate (no Nifty data ⇒ 0/0) but additionally require a
  // non-zero entry so the divide is real, and finite operands so nothing leaks.
  if (entry === 0 || current === 0) {
    return { benchmarkPnL: 0, alpha: 0 };
  }
  const niftyReturn = (current - entry) / entry;
  const benchmarkPnL = finite(finite(investedVal) * niftyReturn);
  const alpha = finite(finite(positionPnL) - benchmarkPnL);
  return { benchmarkPnL, alpha };
}

// ---------------------------------------------------------------------------
// Create-position normalization (guard the PERSISTED write).
// ---------------------------------------------------------------------------

export interface NormalizedCreateValues {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
}

/**
 * Normalize the raw create input into the finite-guarded numbers
 * `createPaperPosition` persists, so a NaN/Infinity (a non-web caller, a missing
 * Zod gate) cannot write a corrupt paper position. Mirrors the service defaults:
 * `currentPrice` defaults to `averagePrice`, `currentValue` to `investedValue`
 * (= quantity × averagePrice). All finite-guarded.
 */
export function normalizeCreateValues(input: {
  quantity: number;
  averagePrice: number;
}): NormalizedCreateValues {
  const quantity = finite(input.quantity);
  const averagePrice = finite(input.averagePrice);
  const invested = investedValue(quantity, averagePrice);
  return {
    quantity,
    averagePrice,
    investedValue: invested,
    currentPrice: averagePrice,
    currentValue: invested,
  };
}

// ---------------------------------------------------------------------------
// Average-into-position (order-based trading) — guards the divide-by-zero.
// ---------------------------------------------------------------------------

export interface AveragedPosition {
  quantity: number;
  averagePrice: number;
  investedValue: number;
  currentValue: number;
}

/**
 * Average a new fill into an existing OPEN position. Mirrors
 * `updateOrAveragePosition`:
 *   totalQty      = existing.quantity + fill.quantity
 *   totalValue    = existing.averagePrice * existing.quantity
 *                 + fill.price * fill.quantity
 *   newAvgPrice   = totalValue / totalQty          ← DIVIDE-BY-ZERO when totalQty=0
 *   investedValue = totalQty * newAvgPrice
 *   currentValue  = totalQty * existing.currentPrice
 *
 * The raw formula yields `NaN`/`Infinity` for `newAvgPrice` when the legs net to
 * zero quantity (a SHORT that exactly cancels a LONG, or two zero-qty fills) and
 * PERSISTS it. We guard: a zero (or non-finite) `totalQty` collapses the whole
 * position to a flat 0 (qty 0, avg 0, invested 0, current 0) — the only sane
 * finite representation of a netted-out position — instead of a poisoned row.
 * Behaviour-preserving for the normal `totalQty > 0` case.
 */
export function averageIntoPosition(
  existing: {
    quantity: number;
    averagePrice: number;
    currentPrice: number;
  },
  fill: { quantity: number; price: number }
): AveragedPosition {
  const exQty = finite(existing.quantity);
  const exAvg = finite(existing.averagePrice);
  const exCurrent = finite(existing.currentPrice);
  const fillQty = finite(fill.quantity);
  const fillPrice = finite(fill.price);

  const totalQty = exQty + fillQty;
  if (!Number.isFinite(totalQty) || totalQty === 0) {
    return { quantity: 0, averagePrice: 0, investedValue: 0, currentValue: 0 };
  }
  const totalValue = exAvg * exQty + fillPrice * fillQty;
  const newAvgPrice = finite(totalValue / totalQty);
  return {
    quantity: totalQty,
    averagePrice: newAvgPrice,
    investedValue: finite(totalQty * newAvgPrice),
    currentValue: finite(totalQty * exCurrent),
  };
}

// ---------------------------------------------------------------------------
// Portfolio summary aggregation (the `getPaperPositions` / dashboard summary).
// ---------------------------------------------------------------------------

/** Fields the portfolio summary reduce reads off a row. */
export interface PaperSummaryRow {
  status: string;
  assetType: string;
  investedValue: number;
  currentValue: number;
  benchmarkPnL?: number | null;
  dayPnl?: number | null;
}

export interface PaperPortfolioSummary {
  totalInvested: number;
  totalCurrent: number;
  totalPnL: number;
  pnlPercentage: number;
  totalPositions: number;
  stockPositions: number;
  fnoPositions: number;
  mfPositions: number;
  benchmarkPnL: number;
  alpha: number;
  dayPnl: number;
}

/**
 * Aggregate the OPEN-position portfolio summary. ONLY `status === "OPEN"` rows
 * contribute (matching the source); every addend is finite-guarded so ONE
 * corrupt OPEN row cannot turn `totalInvested`/`totalCurrent`/`benchmarkPnL`/
 * `dayPnl` into `NaN`/`Infinity` ("₹NaN" header). `totalPnL` derives from the
 * (already finite) totals (`totalCurrent - totalInvested`) so it can never be
 * `Infinity - Infinity = NaN`; `alpha = totalPnL - benchmarkPnL` likewise; and
 * `pnlPercentage` uses the strict finite/positive-divisor guard (never
 * `Infinity`).
 *
 * Behaviour-preserving for finite inputs: identical to the inline
 * `openPositions.reduce(...)` trio + `benchmarkPnL` reduce +
 * `totalInvested > 0 ? (totalPnL / totalInvested) * 100 : 0` +
 * `alpha = totalPnL - benchmarkPnL`.
 */
export function summarizePaperPortfolio(
  positions: PaperSummaryRow[]
): PaperPortfolioSummary {
  let totalInvested = 0;
  let totalCurrent = 0;
  let benchmarkPnL = 0;
  let dayPnl = 0;
  let openCount = 0;
  let stockCount = 0;
  let fnoCount = 0;
  let mfCount = 0;

  for (const p of positions) {
    if (p.status !== "OPEN") continue;
    totalInvested += finite(p.investedValue);
    totalCurrent += finite(p.currentValue);
    benchmarkPnL += finite(p.benchmarkPnL ?? 0);
    dayPnl += finite(p.dayPnl ?? 0);
    openCount += 1;
    if (p.assetType === "STOCK") stockCount += 1;
    else if (p.assetType === "FNO_FUTURES" || p.assetType === "FNO_OPTIONS")
      fnoCount += 1;
    else if (p.assetType === "MF") mfCount += 1;
  }

  const totalPnL = totalCurrent - totalInvested;
  return {
    totalInvested,
    totalCurrent,
    totalPnL,
    pnlPercentage: pnlPercentage(totalPnL, totalInvested),
    totalPositions: openCount,
    stockPositions: stockCount,
    fnoPositions: fnoCount,
    mfPositions: mfCount,
    benchmarkPnL,
    alpha: totalPnL - benchmarkPnL,
    dayPnl,
  };
}

// ---------------------------------------------------------------------------
// Performance summary (the `getPaperPerformance` / dashboard performance block).
// ---------------------------------------------------------------------------

/** Fields the performance reduce reads off a CLOSED row. */
export interface PaperPerformanceRow {
  symbol: string;
  realizedPnL?: number | null;
  benchmarkPnL?: number | null;
}

export interface PaperPerformance {
  totalTrades: number;
  closedTrades: number;
  winners: number;
  losers: number;
  /** Win rate as a PERCENTAGE (0–100); 0 when there are no closed trades. */
  winRate: number;
  totalRealizedPnL: number;
  totalBenchmarkPnL: number;
  totalAlpha: number;
  avgWin: number;
  avgLoss: number;
  bestTradePnL: number;
  worstTradePnL: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
}

/**
 * Win rate as a PERCENTAGE, `0` when there are no closed trades — the
 * div-by-zero guard for the "0 trades → NaN%" case (`winners/0 → NaN`,
 * `NaN.toFixed(1) === "NaN"`). Mirrors
 * `closed > 0 ? (winners / closed) * 100 : 0`.
 */
export function calculateWinRate(
  winners: number,
  closedTrades: number
): number {
  const w = finite(winners);
  const c = finite(closedTrades);
  if (c <= 0) return 0;
  return (w / c) * 100;
}

/** Mean of a list of P&L values, `0` for an empty list; finite-guarded sum. */
export function average(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + finite(b), 0);
  return finite(sum / values.length);
}

/**
 * Compute the full paper-trading performance block from the CLOSED + OPEN
 * position rows.
 *
 * `closedRows` MUST be pre-sorted by `realizedPnL` desc (the source orders the
 * Prisma query `orderBy: { realizedPnL: "desc" }`), so `[0]` is the best and the
 * last element is the worst trade by the DB's ordering — but to be robust to a
 * mis-sorted / NaN-containing input we derive best/worst from a finite scan
 * (`Math.max`/`Math.min` over finite-guarded values) rather than trusting the
 * endpoints blindly. Every sum/ratio is finite-guarded so a stored
 * NaN/Infinity `realizedPnL`/`benchmarkPnL` can't poison the totals, the
 * win-rate, the averages, or `Math.max(...)`/`Math.min(...)`.
 *
 * Behaviour-preserving for finite, properly-sorted inputs: identical to the
 * inline `getPaperPerformance` / `getPaperDashboardStats` aggregation.
 */
export function calculatePerformance(
  closedRows: ReadonlyArray<PaperPerformanceRow>,
  openCount: number
): PaperPerformance {
  const winners = closedRows.filter((p) => finite(p.realizedPnL) > 0);
  const losers = closedRows.filter((p) => finite(p.realizedPnL) < 0);

  const totalRealizedPnL = closedRows.reduce(
    (sum, p) => sum + finite(p.realizedPnL),
    0
  );
  const totalBenchmarkPnL = closedRows.reduce(
    (sum, p) => sum + finite(p.benchmarkPnL),
    0
  );

  const winPnls = winners.map((p) => finite(p.realizedPnL));
  const lossPnls = losers.map((p) => finite(p.realizedPnL));
  const allPnls = closedRows.map((p) => finite(p.realizedPnL));

  const bestTradePnL = allPnls.length > 0 ? Math.max(...allPnls) : 0;
  const worstTradePnL = allPnls.length > 0 ? Math.min(...allPnls) : 0;

  // Best/worst trade objects: pick the row whose finite realizedPnL equals the
  // best/worst scalar (robust even if the DB sort drifted). Falls back to null
  // on empty input.
  const bestRow =
    closedRows.find((p) => finite(p.realizedPnL) === bestTradePnL) ?? null;
  const worstRow =
    closedRows.find((p) => finite(p.realizedPnL) === worstTradePnL) ?? null;

  return {
    totalTrades: closedRows.length + finite(openCount),
    closedTrades: closedRows.length,
    winners: winners.length,
    losers: losers.length,
    winRate: calculateWinRate(winners.length, closedRows.length),
    totalRealizedPnL: finite(totalRealizedPnL),
    totalBenchmarkPnL: finite(totalBenchmarkPnL),
    totalAlpha: finite(finite(totalRealizedPnL) - finite(totalBenchmarkPnL)),
    avgWin: average(winPnls),
    avgLoss: average(lossPnls),
    bestTradePnL: finite(bestTradePnL),
    worstTradePnL: finite(worstTradePnL),
    bestTrade: bestRow
      ? { symbol: bestRow.symbol, pnl: finite(bestRow.realizedPnL) }
      : null,
    worstTrade: worstRow
      ? { symbol: worstRow.symbol, pnl: finite(worstRow.realizedPnL) }
      : null,
  };
}
