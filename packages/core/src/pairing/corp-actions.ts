/**
 * Corporate-action cost-basis adjustment for the FIFO pairing engine (MONEY-840).
 *
 * When a SPLIT or BONUS occurs, the broker restates Holdings: a 1:5 split shows
 * 5× the quantity at ⅕ the price. The *historical* BUY trades, however, were
 * recorded at the PRE-split quantity/price. Left unadjusted, an open BUY lot
 * (e.g. 10 @ ₹1000) can never reconcile against the post-split Holding
 * (50 @ ₹200), and FIFO matches a post-split SELL (priced ~₹200) against a
 * pre-split BUY (~₹1000) and prints a nonsense −80 % "loss".
 *
 * The fix is a pure cost-basis transform applied to each open BUY lot BEFORE it
 * can be matched: for every qty-changing action whose ex-date falls strictly
 * after the lot's trade date (and on/before "now"), scale the lot by the action
 * `ratio` — quantity UP, per-unit price DOWN, total cost preserved:
 *
 *     adjustedQty   = qty   × ratio
 *     adjustedPrice = price ÷ ratio
 *     adjustedQty × adjustedPrice  ===  qty × price   (invariant)
 *
 * This module is PURE: corporate actions are passed in (never fetched here), so
 * the same code runs in the worker and in unit tests. The caller
 * (`pairTradesFIFO`) owns idempotency by applying each (lot, action) pair
 * exactly once per pass via the returned `appliedActionIds` set.
 *
 * @see packages/core/src/pairing/algorithm.ts (caller — applies on queue entry)
 * @see workers/src/processors/pairing.ts (fetches CorporateAction rows)
 */

/**
 * The corporate-action fields the cost-basis transform reads. A structural
 * subset of Prisma's `CorporateAction` so the worker can pass rows straight
 * through (and tests can build plain objects without importing Prisma).
 */
export interface CorporateActionInput {
  /** Stable id used to guarantee each action is absorbed by a lot at most once per pass. */
  id: string;
  symbol: string;
  isin: string | null;
  exchange: string;
  /** SPLIT | BONUS | BUYBACK | DEMERGER | MERGER | DIVIDEND (free-form, upper-cased here). */
  type: string;
  /** Ex-date — the action applies to lots bought strictly BEFORE this instant. */
  exDate: Date;
  /**
   * Post:pre share ratio for qty-changing actions (1:5 split → 5, 1:1 bonus → 2).
   * Null/absent for actions that don't change quantity (e.g. DIVIDEND).
   */
  ratio: number | null;
}

/**
 * A BUY lot as seen by the cost-basis transform — only the fields it needs.
 * (`pairTradesFIFO` passes its in-flight `TradeWithRemaining`, which is a
 * superset of this.)
 */
export interface CostBasisLot {
  isin: string | null;
  symbol: string;
  exchange: string;
  /** FIFO trade date already resolved to a guaranteed-valid Date by the caller. */
  tradeDate: Date;
}

/** Action families that change the share COUNT and therefore the cost basis. */
const QTY_CHANGING_TYPES = new Set(["SPLIT", "BONUS"]);

/**
 * Action families that MAY change the share count but are handled
 * conservatively: apply the ratio only when one is present, otherwise skip.
 *
 * BUYBACK reduces shares (a tender), DEMERGER/MERGER restructure them — none has
 * a clean, universally-correct cost-basis rule from a single `ratio`, so we
 * apply the supplied ratio when the data provider gives one and leave the lot
 * untouched (no false adjustment) when it doesn't. DIVIDEND never changes the
 * cost basis and is always skipped.
 */
const CONSERVATIVE_RATIO_TYPES = new Set(["BUYBACK", "DEMERGER", "MERGER"]);

/**
 * True when a quantity-changing corporate action with a usable ratio applies to
 * a BUY lot: same security (ISIN when both sides have one, else symbol) + same
 * exchange, with the action's ex-date strictly AFTER the lot's trade date and on
 * or before `now` (an announced-but-not-yet-effective action must NOT adjust a
 * lot the broker hasn't restated yet).
 *
 * "strictly after": a lot bought ON OR AFTER the ex-date already reflects the
 * post-action share structure, so re-applying the ratio would double-count.
 */
export function corpActionAppliesToLot(
  action: CorporateActionInput,
  lot: CostBasisLot,
  now: Date,
): boolean {
  const ratio = action.ratio;
  // Only a finite, >0, ≠1 ratio can change cost basis. (ratio === 1 is a no-op;
  // ≤0 / NaN / Infinity is bad data and must never poison qty/price.)
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0 || ratio === 1) {
    return false;
  }

  const type = (action.type || "").toUpperCase();
  // DIVIDEND (and any unknown non-qty type) never adjusts cost basis.
  if (!QTY_CHANGING_TYPES.has(type) && !CONSERVATIVE_RATIO_TYPES.has(type)) {
    return false;
  }

  // Time window: announced action applies only once it has gone ex AND is in the
  // past relative to now. exDate must be a real instant.
  const exTime = action.exDate?.getTime?.();
  if (exTime == null || Number.isNaN(exTime)) return false;
  if (exTime > now.getTime()) return false; // not yet effective

  const lotTime = lot.tradeDate.getTime();
  // Lot must predate the ex-date strictly (a lot bought on/after ex-date already
  // carries the post-action share structure).
  if (Number.isNaN(lotTime) || exTime <= lotTime) return false;

  // Security match: prefer ISIN when BOTH sides carry one (survives a symbol
  // rename); otherwise fall back to symbol. Exchange must always match.
  if (action.exchange !== lot.exchange) return false;
  if (action.isin && lot.isin) {
    return action.isin === lot.isin;
  }
  return action.symbol === lot.symbol;
}

/** A cost-basis scale factor for a BUY lot and the action ids that produced it. */
export interface CostBasisAdjustment {
  /** Product of every applicable ratio — multiply qty by this, divide price by this. */
  factor: number;
  /** Ids of the actions folded into `factor` (for once-per-pass idempotency). */
  appliedActionIds: string[];
}

/**
 * Compute the combined cost-basis scale factor for a single BUY lot.
 *
 * Multiple qty-changing actions compound (a 1:5 split THEN a 1:1 bonus →
 * ×5 × ×2 = ×10). Each action is counted at most once: an action already present
 * in `alreadyApplied` (absorbed earlier in the SAME pass) is skipped, so the
 * function is idempotent if the caller threads the returned ids back in.
 *
 * Order-independent: ratios are multiplied, and the per-lot `tradeDate` is fixed
 * for the pass, so the set of applicable actions never changes regardless of
 * evaluation order. Returns `factor === 1` (no-op) when nothing applies.
 */
export function computeCostBasisAdjustment(
  lot: CostBasisLot,
  actions: CorporateActionInput[],
  now: Date,
  alreadyApplied: ReadonlySet<string> = new Set(),
): CostBasisAdjustment {
  let factor = 1;
  const appliedActionIds: string[] = [];

  for (const action of actions) {
    if (alreadyApplied.has(action.id)) continue;
    if (!corpActionAppliesToLot(action, lot, now)) continue;
    factor *= action.ratio as number; // guarded finite/>0 by corpActionAppliesToLot
    appliedActionIds.push(action.id);
  }

  return { factor, appliedActionIds };
}
