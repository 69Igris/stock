/**
 * The ONE definition of "which existing row does a MANUAL holding merge into",
 * the validation of the numbers that merge carries, and the arithmetic of the
 * merge itself — MONEY-1236.
 *
 * ## Why this is shared rather than written twice
 *
 * Two independent code paths create manual holdings:
 *
 *   - `addManualHoldingAction` (`apps/web/lib/actions/holdings.ts`) — the web UI
 *   - `POST /api/holdings` (`apps/web/app/api/[[...path]]/route.ts`) — the
 *     mobile/API surface
 *
 * Both write a row with `brokerName: "manual"` and NO `broker` key. The server
 * action looked for an existing row with `{ broker: null }`, which on MongoDB
 * matches nothing when the key is ABSENT — so it never found its own output and
 * always fell through to `create`. The API route had no dedup lookup at all.
 *
 * Measured on prod 2026-08-21: 99 holdings, 16 with `broker` ABSENT, 0 explicit
 * null, and all 16 of the absent ones carry `brokerName: "manual"`. So 100% of
 * the manual-add path's own output was invisible to its own dedup.
 *
 * ## What users actually experienced — and it is NOT duplicate rows
 *
 * `Holding` carries `@@unique([userId, broker, brokerUserId, symbol, exchange])`
 * and that index is LIVE on prod (verified 2026-08-21:
 * `Holding_userId_broker_brokerUserId_symbol_exchange_key`). MongoDB indexes a
 * missing field as null, so two manual rows for the same
 * `(userId, symbol, exchange)` collide on identical index keys. Confirmed: there
 * are ZERO duplicate groups among the absent-`broker` rows.
 *
 * So the failed dedup did not produce duplicates — it produced a hard E11000 on
 * the `create`, surfaced with no P2002 handler as a generic "Failed to add
 * holding. Please try again." Every attempt to add more of a symbol the user
 * already held manually failed, with nothing in the message saying why.
 *
 * Sharing the decision matters more than the few lines it saves: a gate and a
 * writer that disagree about which rows exist is the defect class behind
 * MONEY-1050, 1205, 1234, 1235 and this ticket.
 *
 * ## The claim above is enforced, not asserted
 *
 * An earlier revision of this header claimed the where-clause and the
 * arithmetic were shared while `holdings.ts` still carried its own inline copy,
 * and it named a calling function that does not exist anywhere in the repo.
 * A comment that asserts a de-duplication nobody performed is worse than no
 * comment, because it stops the next reader from grepping for the second copy.
 * `apps/web/__tests__/actions/holdings-dedup-logic.test.ts` now asserts that
 * BOTH call sites import from here, so the claim cannot go stale silently.
 */

/**
 * A holding row, narrowed to the fields the merge reads.
 *
 * `currentPrice` is read (not just written) so an add that carries no fresh
 * mark can preserve the row's existing one — see {@link mergeManualHolding}.
 */
export interface MergeableHolding {
  quantity: number;
  investedValue: number;
  currentPrice: number;
}

/**
 * The `where` that finds the MANUAL holding a new manual add should merge into.
 *
 * Both null shapes are matched deliberately: `isSet: false` is what these two
 * writers actually produce, and `null` is the explicit null a different writer —
 * or a future backfill that stamps `broker: null` — can still produce.
 *
 * A row belonging to a REAL broker matches neither arm, and that is the point: a
 * manual add must never merge into a synced holding, whose quantity the next
 * broker sync would overwrite.
 *
 * `brokerName` is deliberately NOT part of the predicate. The API route lets a
 * caller supply `brokerName`, so a row created through it can carry e.g.
 * "zerodha" while still having no `broker` key; excluding those rows would send
 * the caller back to the E11000 this dedup exists to prevent, because the unique
 * index does not include `brokerName` either. The invariant that actually
 * protects synced rows is `broker`, which `persistHoldings` always sets.
 */
export function manualHoldingWhere(
  userId: string,
  symbol: string,
  exchange: string
): {
  userId: string;
  symbol: string;
  exchange: string;
  OR: Array<{ broker: null | { isSet: false } }>;
} {
  return {
    userId,
    symbol: symbol.toUpperCase(),
    exchange,
    OR: [{ broker: null }, { broker: { isSet: false } }],
  };
}

/**
 * A manual-holding add, after validation: every number is finite and in range,
 * and `symbol` is a non-empty uppercase string.
 *
 * `currentPrice` is `null` when the caller supplied no fresh mark. That is a
 * distinct value from "0" on purpose — see {@link mergeManualHolding}.
 */
export interface ManualHoldingInput {
  symbol: string;
  exchange: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
}

export type ManualHoldingInputResult =
  | { ok: true; value: ManualHoldingInput }
  | { ok: false; error: string };

/**
 * Validate an untrusted manual-holding payload — MONEY-1236.
 *
 * ## Why this has to exist, and why it has to run BEFORE the lookup
 *
 * `POST /api/holdings` builds its numbers with `parseInt(body.quantity)` /
 * `parseFloat(body.averagePrice)` over a body that comes from
 * `request.json().catch(() => ({}))` with no schema at all. Both return `NaN`
 * for a missing or non-numeric field.
 *
 * While the dedup lookup was broken that only ever reached `create`, and a bad
 * row was a bad NEW row. Repairing the lookup opened the MERGE branch, where the
 * same `NaN` folds into a row that already exists:
 *
 *     quantity      = existing.quantity + NaN      -> NaN
 *     investedValue = existing.investedValue + NaN -> NaN
 *     averagePrice  = quantity > 0 ? ... : 0       -> NaN > 0 is FALSE -> 0
 *
 * One `POST /api/holdings {"symbol":"TATAMOTORS"}` therefore destroyed that
 * holding's quantity, cost basis and P&L. Note the last line especially: the
 * zero-denominator guard did not save it, it made it WORSE. A `NaN` renders as
 * "—" and is visibly broken; a `0` average price renders as a real position
 * acquired for free. The guard converted a loud corruption into a silent one.
 *
 * `symbol` is validated for the same reason. `String(body.symbol)` yields the
 * literal `"UNDEFINED"` for a missing field, and because {@link
 * manualHoldingWhere} then matches on that string, every subsequent malformed
 * request merged into the same junk row and compounded it.
 *
 * ## The bounds
 *
 * - `quantity` finite and `> 0` — this endpoint only ADDS. Zero would be a
 *   no-op that still rewrote the row; negative belongs to a sell path.
 * - `averagePrice` finite and `>= 0` — zero is legitimate (bonus or gifted
 *   shares), so it is allowed, and every downstream division already guards a
 *   zero denominator.
 * - `currentPrice` optional; finite and `>= 0` when present, else `null`.
 */
export function parseManualHoldingInput(raw: {
  symbol?: unknown;
  exchange?: unknown;
  quantity?: unknown;
  averagePrice?: unknown;
  currentPrice?: unknown;
}): ManualHoldingInputResult {
  const symbol =
    typeof raw.symbol === "string" ? raw.symbol.trim().toUpperCase() : "";
  if (symbol.length === 0) {
    return { ok: false, error: "symbol is required" };
  }

  const exchange =
    typeof raw.exchange === "string" && raw.exchange.trim().length > 0
      ? raw.exchange.trim().toUpperCase()
      : "NSE";

  const quantity = toFiniteNumber(raw.quantity);
  if (quantity === null || quantity <= 0) {
    return { ok: false, error: "quantity must be a number greater than 0" };
  }

  const averagePrice = toFiniteNumber(raw.averagePrice);
  if (averagePrice === null || averagePrice < 0) {
    return { ok: false, error: "averagePrice must be a number of 0 or more" };
  }

  let currentPrice: number | null = null;
  if (
    raw.currentPrice !== undefined &&
    raw.currentPrice !== null &&
    raw.currentPrice !== ""
  ) {
    const parsed = toFiniteNumber(raw.currentPrice);
    if (parsed === null || parsed < 0) {
      return { ok: false, error: "currentPrice must be a number of 0 or more" };
    }
    currentPrice = parsed;
  }

  return {
    ok: true,
    value: { symbol, exchange, quantity, averagePrice, currentPrice },
  };
}

/**
 * Coerce an untrusted value to a FINITE number, or null.
 *
 * `Number("")` is 0 and `Number(null)` is 0, both of which would sail through a
 * `Number.isFinite` check as a real zero — so the empty/null cases are rejected
 * before coercion rather than after.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export interface MergedHoldingValues {
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
}

/**
 * Fold an incoming manual add into an existing manual holding.
 *
 * `averagePrice` is recomputed from the COMBINED invested value over the
 * COMBINED quantity — a weighted average, not the mean of two averages, which
 * would be wrong whenever the two lots differ in size.
 *
 * ## `currentPrice: null` means KEEP, not zero — MONEY-1236
 *
 * This used to take a plain `number` that the API route built as
 * `parseFloat(body.currentPrice || body.averagePrice)`, and wrote it
 * unconditionally. So an add that carried no fresh mark stamped the LOT'S COST
 * over the row's live price: adding 5 shares at cost 120 to a holding marked at
 * 200 reset it to 120, and the dashboard showed a fabricated loss until the next
 * price refresh. A cost price is not a mark, and this endpoint has no business
 * revaluing a position. `null` therefore means "no fresh mark — keep what the
 * row already has".
 *
 * Every quotient guards its denominator, and every input is expected to be
 * finite — {@link parseManualHoldingInput} is what makes that true at both call
 * sites. The guards here are the second line of defence, not the first: a `NaN`
 * reaching them falls to the else-branch and writes a plausible-looking `0`,
 * which is harder to notice than the `NaN` would have been.
 */
export function mergeManualHolding(
  existing: MergeableHolding,
  addQuantity: number,
  addInvestedValue: number,
  currentPrice: number | null
): MergedHoldingValues {
  const mark = currentPrice ?? existing.currentPrice;
  const quantity = existing.quantity + addQuantity;
  const investedValue = existing.investedValue + addInvestedValue;
  const currentValue = quantity * mark;
  const unrealizedPnL = currentValue - investedValue;
  return {
    quantity,
    averagePrice: quantity > 0 ? investedValue / quantity : 0,
    currentPrice: mark,
    investedValue,
    currentValue,
    unrealizedPnL,
    pnlPercentage:
      investedValue > 0 ? (unrealizedPnL / investedValue) * 100 : 0,
  };
}

/**
 * The values a BRAND NEW manual holding is created with.
 *
 * Shared with the merge for the same reason the merge is shared: the create and
 * the update must agree about how a position is valued, and the API route's
 * inline version divided by `averagePrice` with no guard — `pnlPercentage` was
 * `NaN` for any bonus/gifted lot entered at cost 0.
 */
export function newManualHoldingValues(
  input: ManualHoldingInput
): MergedHoldingValues {
  const mark = input.currentPrice ?? input.averagePrice;
  const investedValue = input.quantity * input.averagePrice;
  const currentValue = input.quantity * mark;
  const unrealizedPnL = currentValue - investedValue;
  return {
    quantity: input.quantity,
    averagePrice: input.averagePrice,
    currentPrice: mark,
    investedValue,
    currentValue,
    unrealizedPnL,
    pnlPercentage:
      investedValue > 0 ? (unrealizedPnL / investedValue) * 100 : 0,
  };
}
