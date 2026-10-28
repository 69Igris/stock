/**
 * Pure pairing-input derivations extracted from `processPairing` (pairing.ts).
 *
 * `pairing.ts` imports `@usemoney/database` (a live Prisma client at module
 * load), so the two pure transforms it performs while mapping a DB `Trade` →
 * the FIFO algorithm's `TradeInput` cannot be unit-tested without dragging
 * Prisma in. They are extracted here as EXPORTED, side-effect-free functions
 * that the real processor CALLS — production path and tests run the same code
 * (no shadow). This mirrors `apps/web/lib/pairing/pairing-logic.ts` but is
 * worker-local (the worker runs in a separate runtime and must not import from
 * apps/web).
 *
 * @see workers/src/processors/pairing.ts (caller)
 * @see apps/web/__tests__/workers/processor-pairing.test.ts (tests the real exports)
 * @see apps/web/__tests__/workers/pairing-edge-cases.test.ts (tests the real exports)
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
 * Corporate-action wiring (MONEY-840)
 *
 * `processPairing` fetches `CorporateAction` rows for the symbols/ISINs in the
 * trade set and passes them to `pairTradesFIFO`. These pure helpers build the
 * fetch filter and map a Prisma row → the algorithm's `CorporateActionInput`,
 * so the production path and the unit tests run the SAME code (no shadow) — the
 * processor itself can't be imported into a pure test (Prisma at module load).
 * ──────────────────────────────────────────────────────────────────────── */

/** Trade fields the corp-action filter reads (subset of Prisma `Trade`). */
export interface CorpActionFilterTrade {
  symbol: string;
  isin: string | null;
  segment: string | null;
  tradingSymbol: string | null;
}

/** The CorporateAction fields the mapping reads (subset of Prisma row). */
export interface CorpActionRow {
  id: string;
  symbol: string;
  isin: string | null;
  exchange: string;
  type: string;
  exDate: Date;
  ratio: number | null;
}

/**
 * The symbol + effective-ISIN universe to fetch corporate actions for: the
 * distinct symbols and effective ISINs (reusing `deriveEffectiveIsin` so MF
 * ISINs packed into `tradingSymbol` are included) across the trade set. The
 * worker queries `corporateAction` with `symbol IN symbols OR isin IN isins`.
 */
export function corpActionFilterFromTrades(trades: CorpActionFilterTrade[]): {
  symbols: string[];
  isins: string[];
} {
  const symbols = Array.from(new Set(trades.map((t) => t.symbol)));
  const isins = Array.from(
    new Set(trades.map((t) => deriveEffectiveIsin(t)).filter(Boolean)),
  ) as string[];
  return { symbols, isins };
}

/**
 * Map a Prisma `CorporateAction` row to the algorithm's `CorporateActionInput`.
 *
 * A passthrough of the cost-basis-relevant fields; `pairTradesFIFO` /
 * `computeCostBasisAdjustment` own the policy (which `type`s adjust, the ex-date
 * window, the ratio sanity checks). Kept separate so the worker never hand-rolls
 * the shape and the conversion is unit-tested.
 */
export function toCorporateActionInput(row: CorpActionRow): {
  id: string;
  symbol: string;
  isin: string | null;
  exchange: string;
  type: string;
  exDate: Date;
  ratio: number | null;
} {
  return {
    id: row.id,
    symbol: row.symbol,
    isin: row.isin,
    exchange: row.exchange,
    type: row.type,
    exDate: row.exDate,
    ratio: row.ratio,
  };
}
