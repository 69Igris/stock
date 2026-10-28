/**
 * Pure pairing-input derivations extracted from `pairUserTrades` (service.ts).
 *
 * `service.ts` imports `@/lib/prisma` (a live DB client at module load), so the
 * two pure transforms it performs while mapping a DB `Trade` → the pairing
 * algorithm's `TradeInput` cannot be unit-tested without dragging Prisma in.
 * They are extracted here as EXPORTED, side-effect-free functions that the real
 * service CALLS — production path and tests run the same code (no shadow).
 *
 * @see apps/web/lib/pairing/service.ts (caller)
 * @see apps/web/__tests__/pairing/pairing-logic.test.ts (tests the real exports)
 */

/** The Trade fields these derivations read. A structural subset of Prisma's `Trade`. */
export interface PairingTradeFields {
  price: number | null;
  tradeValue: number | null;
  quantity: number | null;
  averagePrice: number | null;
  isin: string | null;
  segment: string | null;
  tradingSymbol: string | null;
}

/**
 * True when a string is a syntactically-valid ISIN-shaped identifier as Zerodha
 * stores it in a mutual-fund trade's `tradingSymbol` (e.g. `INF109K01Y80`):
 * exactly 12 chars, starts with `IN`, alphanumeric uppercase.
 *
 * Does NOT validate the ISIN check-digit — it only matches the shape the sync
 * layer relies on to recover an ISIN when the dedicated `isin` column is empty.
 */
export function looksLikeIsin(value: string | null | undefined): boolean {
  if (!value) return false;
  const ts = value.toUpperCase();
  return ts.length === 12 && ts.startsWith("IN") && /^[A-Z0-9]{12}$/.test(ts);
}

/**
 * Resolve the effective ISIN for a trade.
 *
 * Prefers the explicit `isin` column. For MF trades with no `isin`, Zerodha
 * packs the ISIN into `tradingSymbol`, so fall back to it when it is
 * ISIN-shaped (uppercased to the canonical form). Returns `null` otherwise.
 *
 * Pairing groups MF positions by ISIN so a fund that is renamed still nets off
 * correctly — getting this wrong silently splits one holding into two.
 */
export function deriveEffectiveIsin(trade: {
  isin: string | null;
  segment: string | null;
  tradingSymbol: string | null;
}): string | null {
  if (trade.isin) return trade.isin;
  if (trade.segment === "MF" && trade.tradingSymbol) {
    const ts = trade.tradingSymbol.toUpperCase();
    if (looksLikeIsin(ts)) return ts;
  }
  return null;
}

/**
 * Derive the per-unit `price` fed to the FIFO algorithm.
 *
 * Precedence: stored `price` → `tradeValue / quantity` (only when quantity is a
 * usable, strictly-positive number) → `averagePrice` → 0. The result is always
 * a finite number: a non-finite stored price (NaN/Infinity) or a non-finite
 * `tradeValue/quantity` ratio is treated as "missing" and falls through, and
 * the final `|| 0` (plus an explicit finite check) guarantees the algorithm
 * never receives NaN/Infinity — which would otherwise poison realized P&L.
 */
export function derivePairingPrice(
  trade: Pick<
    PairingTradeFields,
    "price" | "tradeValue" | "quantity" | "averagePrice"
  >
): number {
  let price = trade.price;

  // Treat a missing OR non-finite OR zero stored price as "needs deriving".
  if (price == null || !Number.isFinite(price) || price === 0) {
    if (
      trade.tradeValue != null &&
      Number.isFinite(trade.tradeValue) &&
      trade.quantity != null &&
      Number.isFinite(trade.quantity) &&
      trade.quantity > 0
    ) {
      price = trade.tradeValue / trade.quantity;
    } else if (
      trade.averagePrice != null &&
      Number.isFinite(trade.averagePrice)
    ) {
      price = trade.averagePrice;
    }
  }

  // Final guard: never hand a non-finite price to the pairing algorithm.
  return price != null && Number.isFinite(price) ? price : 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Holdings ↔ pairing reconciliation (MONEY-840)
 *
 * The open PairedTradeView lots are the trade-history view of what's still held;
 * Holdings are the broker's current-state view. After corporate-action
 * cost-basis adjustment they should agree on quantity per security. This pure
 * helper sums open lot quantities and compares them against
 * `Holding.quantity + Holding.t1Quantity` (T1 = settling delivery still part of
 * the position) per security, flagging drift. It NEVER blocks — it returns a
 * report the caller logs.
 *
 * Extracted here (pure) so `service.ts` (which imports Prisma) can call it and
 * the unit tests assert the SAME code — no shadow copy.
 *
 * @see apps/web/lib/pairing/service.ts (caller)
 * ──────────────────────────────────────────────────────────────────────── */

/** Epsilon for quantity comparison — mirrors core's QUANTITY_EPSILON (1e-6). */
export const RECON_QUANTITY_EPSILON = 1e-6;

/** An open paired lot as the reconciler sees it (subset of PairedTradeView). */
export interface ReconOpenLot {
  symbol: string;
  isin: string | null;
  exchange?: string | null;
  broker?: string | null;
  brokerUserId?: string | null;
  /** Open quantity remaining on the lot (post corp-action adjustment). */
  quantity: number;
}

/** A current-state holding as the reconciler sees it (subset of Holding). */
export interface ReconHolding {
  symbol: string;
  isin: string | null;
  exchange?: string | null;
  broker?: string | null;
  brokerUserId?: string | null;
  quantity: number;
  /** T1 (settling) delivery quantity — still part of the position. */
  t1Quantity?: number | null;
}

/** Per-security reconciliation outcome. */
export interface ReconEntry {
  key: string;
  symbol: string;
  isin: string | null;
  /** Σ open paired-lot quantity for this security. */
  pairedOpenQuantity: number;
  /** Holding.quantity + Holding.t1Quantity for this security (0 when no holding). */
  holdingQuantity: number;
  /** pairedOpenQuantity − holdingQuantity (signed). */
  drift: number;
}

/** Summary of a reconciliation pass. */
export interface ReconReport {
  /** Securities whose |drift| exceeds the epsilon. */
  drifted: ReconEntry[];
  /** Total count of securities compared (intersection-aware, see below). */
  comparedCount: number;
  /** True when no security drifted. */
  ok: boolean;
}

/**
 * The reconciliation grouping key for a security + account. Mirrors the pairing
 * group key's identity rule: ISIN when present (survives symbol renames), else
 * symbol; scoped by exchange + broker + brokerUserId so two accounts holding the
 * same stock don't net off against each other.
 */
function reconKey(row: {
  symbol: string;
  isin: string | null;
  exchange?: string | null;
  broker?: string | null;
  brokerUserId?: string | null;
}): string {
  const security = row.isin || row.symbol;
  return `${security}|${row.exchange || ""}|${row.broker || ""}|${row.brokerUserId || ""}`;
}

/**
 * Reconcile open paired lots against current-state holdings.
 *
 * Invariant (per security + account): Σ open PairedTradeView lot quantity ===
 * Holding.quantity + Holding.t1Quantity (within `RECON_QUANTITY_EPSILON`).
 *
 * Drift handling, deliberately tolerant:
 *  - A security with open lots but NO holding (e.g. an F&O position, a pre-
 *    platform / no-trade-history holding, or a fully-exited name whose holding
 *    row was removed) is IGNORED, not flagged — only securities present on BOTH
 *    sides are compared. This avoids false alarms for positions tracked via the
 *    Position/MF tables rather than Holdings, and for holdings imported without
 *    any trade history.
 *  - Corporate actions now adjust the open lots, so a 1:5 split (Holding shows
 *    5× qty) no longer false-alarms — the lots are in the same post-split units.
 *
 * Returns a report; the caller logs it and never blocks on drift.
 */
export function reconcileOpenLotsVsHoldings(
  openLots: ReconOpenLot[],
  holdings: ReconHolding[]
): ReconReport {
  // Σ open paired-lot quantity per security+account.
  const pairedByKey = new Map<string, { entry: ReconEntry }>();
  for (const lot of openLots) {
    const key = reconKey(lot);
    let bucket = pairedByKey.get(key);
    if (!bucket) {
      bucket = {
        entry: {
          key,
          symbol: lot.symbol,
          isin: lot.isin,
          pairedOpenQuantity: 0,
          holdingQuantity: 0,
          drift: 0,
        },
      };
      pairedByKey.set(key, bucket);
    }
    if (Number.isFinite(lot.quantity)) {
      bucket.entry.pairedOpenQuantity += lot.quantity;
    }
  }

  // Holding.quantity + t1Quantity per security+account.
  const holdingByKey = new Map<string, number>();
  for (const h of holdings) {
    const key = reconKey(h);
    const qty =
      (Number.isFinite(h.quantity) ? h.quantity : 0) +
      (h.t1Quantity != null && Number.isFinite(h.t1Quantity)
        ? h.t1Quantity
        : 0);
    holdingByKey.set(key, (holdingByKey.get(key) || 0) + qty);
  }

  const drifted: ReconEntry[] = [];
  let comparedCount = 0;

  for (const [key, { entry }] of pairedByKey) {
    // Only compare securities present on BOTH sides (intersection) — see docstring.
    if (!holdingByKey.has(key)) continue;
    comparedCount++;
    entry.holdingQuantity = holdingByKey.get(key)!;
    entry.drift = entry.pairedOpenQuantity - entry.holdingQuantity;
    if (Math.abs(entry.drift) > RECON_QUANTITY_EPSILON) {
      drifted.push(entry);
    }
  }

  return { drifted, comparedCount, ok: drifted.length === 0 };
}
