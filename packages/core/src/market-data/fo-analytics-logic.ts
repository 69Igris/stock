/**
 * PURE F&O chain analytics — MONEY-1100 (Data Engine P4.4).
 *
 * One underlying's `DerivativeEOD` rows for one trading day in, one
 * `DerivativeSummaryCalc` out. No Prisma, no fetch, no clock, no `Date.now()`:
 * every number here is a function of its arguments, so the definitions that
 * decide whether "PCR 1.4" or "max pain 24,000" is TRUE are unit-testable
 * against hand-computed chains instead of against a 154M-row table.
 *
 * The I/O half (paging `derivative_eod` per underlying/date and upserting
 * `DerivativeSummary`) is a later job. It owns the query; this owns the math.
 *
 * ## Sources for the two definitions that are genuinely ambiguous
 *
 * Max pain and rollover-% both have a folk definition that is subtly wrong, so
 * both were checked against published references rather than recalled:
 *
 *   - Max pain: Pain(P) = Σ_calls OI_ce(K)·max(0, P−K) + Σ_puts OI_pe(K)·max(0,
 *     K−P), minimised over the chain's own strikes.
 *     https://optioncharts.io/docs/max-pain · https://www.strike.money/options/max-pain-options
 *   - Rollover %: "open interest shifted to the next series ÷ total open
 *     interest × 100" — i.e. the share that has ROLLED FORWARD, not the share
 *     still sitting in the near contract.
 *     https://www.icicidirect.com/ilearn/futures-and-options/articles/demystifying-rollover-and-rollover-percentage
 *     https://www.angelone.in/knowledge-center/derivatives/what-is-rollover
 *
 * `rolloverPct` here is therefore the ROLLED-FORWARD share. The near-expiry
 * share (its complement) is also returned, as `nearExpiryOiPct`, because it is
 * the more natural read for "how much is still in the contract that is about to
 * die". Publishing the near share under the name `rolloverPct` would print 25%
 * where every Indian broker prints 75% for the same day — an inverted number
 * under an industry-standard label is worse than a missing one.
 *
 * ## null is a value here, 0 is never a stand-in for "unknown"
 *
 * Standing rule in this repo: "couldn't determine" must be its own value. Every
 * field below is `| null`, and each null has ONE documented meaning at its
 * definition. The distinction is not academic:
 *
 *   - `futOiChange = 0` means open interest genuinely did not move.
 *     `futOiChange = null` means we had no previous day to compare against.
 *     Collapsing the second into the first would paint every backfilled
 *     first-day-of-history row as a flat, uneventful session.
 *   - `pcrOi = 0` means puts carry no open interest against calls that do.
 *     `pcrOi = null` means the call side is 0, so the ratio does not exist —
 *     and `Infinity`, which is what the division actually yields, is the exact
 *     non-finite money poison the `fixing-bugs` skill exists to prevent.
 */

// ─── Shapes ──────────────────────────────────────────────────────────

/** OI-buildup quadrant from sign(Δprice) × sign(ΔOI) on the near future. */
export type OiBuildup = "LONG" | "SHORT" | "LONG_UNWIND" | "SHORT_COVER";

/**
 * The subset of a derivatives EOD bar this module actually reads.
 *
 * Deliberately a STRUCTURAL minimum rather than `LegacyDerivativeRow`, and
 * `exchange` is widened to `string`: `LegacyDerivativeRow.exchange` is the
 * literal `"NSE"` while a Prisma `DerivativeEOD.exchange` is `string`, and a
 * `string` is not assignable to `"NSE"`. Typing the input as the parser's row
 * would force the daily job — whose rows come from Prisma, not from a parser —
 * to cast, and a cast at that boundary is how a wrong-shaped row gets in. Both
 * producers satisfy this interface as-is.
 */
export interface DerivativeContractRow {
  symbol: string;
  exchange: string;
  /** FUTIDX | FUTSTK | OPTIDX | OPTSTK, plus the legacy FUT-/OPT-prefixed tail. */
  instrument: string;
  expiry: Date;
  /** 0 on futures (the `DerivativeEOD` sentinel), a real strike on options. */
  strike: number;
  /** CE | PE | XX (future). */
  optionType: string;
  date: Date;
  close: number;
  volume: number;
  openInt: number;
}

export interface DerivativeSummaryInput {
  symbol: string;
  /** Trading day, UTC midnight of the IST day (the `DerivativeEOD` convention). */
  date: Date;
  /**
   * Optional exchange filter. When set, rows from any other exchange are
   * rejected and counted; when omitted the caller is asserting it already paged
   * a single exchange. NSE and BSE run SEPARATE F&O segments — summing a BSE
   * SENSEX chain into an NSE one would double-count OI and produce a PCR for a
   * book nobody holds.
   */
  exchange?: string;
  today: readonly DerivativeContractRow[];
  /**
   * The previous TRADING day's rows for the same underlying. Absent (or empty)
   * ⇒ every day-over-day field is null, never 0.
   */
  prevDay?: readonly DerivativeContractRow[];
  /** Cash close of the underlying. null/absent ⇒ `futBasisPct` is null. */
  underlyingClose?: number | null;
}

export interface DerivativeSummaryCalc {
  symbol: string;
  /** Echo of the `exchange` filter; null when the caller did not scope one. */
  exchange: string | null;
  date: Date;

  // ── Headline derivables ──

  /**
   * TOTAL futures open interest across every live expiry.
   *
   * Chosen over "nearest expiry only" because this field is the headline "how
   * much is committed to this underlying's futures", and the total is the only
   * definition that survives the monthly roll: on the session after expiry the
   * near contract's OI vanishes and a DIFFERENT contract becomes near, so a
   * near-only series prints a ~-90% cliff every month that no position actually
   * took. The near-only number is still available as `nearFutOi`.
   *
   * null ⇒ the input carried no futures rows at all. 0 ⇒ futures rows exist and
   * their open interest sums to zero (dead far-month contracts really do).
   */
  futOi: number | null;
  /**
   * `futOi` today − `futOi` on `prevDay`. Same basis on both sides.
   *
   * null ⇒ no previous day was supplied, or it carried no futures rows. NEVER 0
   * for "unknown".
   *
   * Deliberately NOT `Σ row.oiChange`, which is available same-day and needs no
   * previous day: the exchange's per-contract `ChngInOpnIntrst` is measured
   * against that CONTRACT's own prior session, so a contract that expired
   * yesterday contributes no row today and its entire open interest silently
   * leaves the sum. Σ oiChange and the true Δtotal agree on quiet days and
   * diverge precisely at the roll — the one day the number is interesting.
   */
  futOiChange: number | null;
  /**
   * (nearest-expiry future close − underlying close) ÷ underlying close × 100.
   *
   * null ⇒ no underlying close was supplied, it was non-finite or ≤ 0, or the
   * day carried no futures row to price the basis from.
   */
  futBasisPct: number | null;
  /**
   * Put/call open-interest ratio across ALL expiries: Σ PE OI ÷ Σ CE OI.
   *
   * All expiries, not just the near one, because for index names the weekly and
   * monthly books are one sentiment picture and a weekly-only PCR swings wildly
   * on expiry day.
   *
   * null ⇒ the call side is 0 (ratio undefined) or the day carried no options.
   * The division would otherwise yield Infinity or NaN.
   */
  pcrOi: number | null;
  /** Put/call VOLUME ratio, same basis and same null rule as `pcrOi`. */
  pcrVol: number | null;
  /**
   * The strike minimising total in-the-money payout over the NEAREST OPTION
   * expiry's chain. See `computeMaxPain` for the formula and the tie rule.
   *
   * null ⇒ no option rows, or the chain's total open interest is 0 (every
   * candidate payout is then 0 and "the minimum" is an artefact of iteration
   * order, not a market fact).
   */
  maxPain: number | null;
  /**
   * Share of total futures OI that has ROLLED FORWARD out of the near expiry:
   * (futOi − nearFutOi) ÷ futOi × 100. Market-standard orientation — see the
   * module doc; `nearExpiryOiPct` is the complement.
   *
   * Computed on EVERY day, not only in expiry week. Windowing belongs to the
   * consumer: the daily series is what makes "rollover started early this
   * month" visible, and a field that is null for three weeks out of four cannot
   * show that. Away from expiry it simply reads as the natural term-structure
   * split (a healthy NIFTY prints ~10-25% mid-cycle, ~70-85% on expiry day).
   *
   * null ⇒ no futures rows, or total futures OI is 0 (ratio undefined).
   */
  rolloverPct: number | null;
  /** 100 − `rolloverPct`: the share still sitting in the near contract. */
  nearExpiryOiPct: number | null;
  /**
   * Quadrant from sign(Δclose) × sign(ΔOI) on the nearest-expiry future,
   * matched to the SAME contract (same expiry) on `prevDay`:
   *
   *   price ↑ OI ↑ → LONG          (fresh longs)
   *   price ↓ OI ↑ → SHORT         (fresh shorts)
   *   price ↓ OI ↓ → LONG_UNWIND   (longs closing)
   *   price ↑ OI ↓ → SHORT_COVER   (shorts closing)
   *
   * null ⇒ no previous day, no row for the same expiry on it, or either delta
   * is exactly 0. A flat close or flat OI belongs to no quadrant; snapping it
   * into one would invent a directional signal out of a non-event.
   */
  oiBuildup: OiBuildup | null;

  // ── Components: every headline above must be re-derivable from these ──

  /** Expiry the basis, rollover split and buildup were computed against. */
  nearFutExpiry: Date | null;
  nearFutOi: number | null;
  nearFutClose: number | null;
  /** Expiry whose chain produced `maxPain` — weeklies make this ≠ nearFutExpiry. */
  maxPainExpiry: Date | null;
  /** null ⇒ no rows of that option type at all; 0 ⇒ rows exist, they sum to 0. */
  callOi: number | null;
  putOi: number | null;
  callVol: number | null;
  putVol: number | null;

  // ── Counters: a rejected row is reported, never swallowed ──

  rowsUsed: number;
  rowsRejected: number;
  prevRowsUsed: number;
  prevRowsRejected: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * `YYYY-MM-DD` for a Date, or null for an Invalid Date.
 *
 * The `Number.isFinite` guard is load-bearing: `new Date("nope").toISOString()`
 * THROWS, so an unguarded key would turn one corrupt row into a summary-wide
 * failure. ISO day strings also compare lexicographically = chronologically,
 * which is what "nearest expiry" relies on.
 */
function dayKey(d: Date | null | undefined): string | null {
  if (!d) return null;
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/**
 * Futures vs options by PREFIX, not by an enumerated set of four codes.
 *
 * `FUTIDX/FUTSTK/OPTIDX/OPTSTK` are the whole vocabulary of the UDiFF era, but
 * the legacy files this engine backfills to 2000 also carry `FUTIVX` (India VIX
 * futures), `FUTIRC`/`FUTIRT` (interest-rate futures) and `OPTIRC`. An
 * enumerated match would classify those as neither and drop them — the
 * "precision without a catch-all shrinks coverage" trap. Anything matching
 * neither prefix is still counted as rejected, so a genuinely new code shows up
 * as a number rather than as quietly missing history.
 */
function isFuture(instrument: string): boolean {
  return instrument.startsWith("FUT");
}

function isOption(instrument: string): boolean {
  return instrument.startsWith("OPT");
}

interface Chain {
  futures: DerivativeContractRow[];
  calls: DerivativeContractRow[];
  puts: DerivativeContractRow[];
  used: number;
  rejected: number;
}

function emptyChain(): Chain {
  return { futures: [], calls: [], puts: [], used: 0, rejected: 0 };
}

/**
 * Split one day's rows into futures / calls / puts, rejecting anything that
 * does not belong to this (symbol, exchange, day).
 *
 * The identity filters are not paranoia about the parsers — they are a guard on
 * the JOB's query. A paging bug that lets a neighbouring underlying or the
 * wrong session's rows into the batch would otherwise produce a perfectly
 * plausible summary computed over two different books, with nothing anywhere
 * indicating it happened. Rejections are counted, so it surfaces as a number.
 *
 * `requireDay` pins today's rows to the summary's own date. `rejectDay` is the
 * mirror guard for the previous-day batch: previous-day rows that carry TODAY's
 * date mean the job passed the same page twice, which would make every
 * day-over-day delta exactly 0 — the most convincing wrong answer available.
 */
function collectChain(
  rows: readonly DerivativeContractRow[] | undefined,
  symbol: string,
  exchange: string | null,
  requireDay: string | null,
  rejectDay: string | null,
): Chain {
  const out = emptyChain();
  if (!rows) return out;

  for (const r of rows) {
    if (!r || r.symbol !== symbol) {
      out.rejected++;
      continue;
    }
    if (exchange !== null && r.exchange !== exchange) {
      out.rejected++;
      continue;
    }

    const rowDay = dayKey(r.date);
    if (rowDay === null) {
      out.rejected++;
      continue;
    }
    if (requireDay !== null && rowDay !== requireDay) {
      out.rejected++;
      continue;
    }
    if (rejectDay !== null && rowDay === rejectDay) {
      out.rejected++;
      continue;
    }

    // Non-finite numerics are dropped rather than summed. One NaN close or NaN
    // openInt propagates through every sum, ratio and argmin below and turns
    // the ENTIRE summary into NaN — the exact failure mode the non-finite money
    // hardening exists for. MongoDB can store a NaN double, so "the parser
    // guarantees finite" is not a guarantee at the read side.
    if (!finite(r.close) || !finite(r.openInt) || !finite(r.volume)) {
      out.rejected++;
      continue;
    }
    if (dayKey(r.expiry) === null) {
      out.rejected++;
      continue;
    }

    if (isFuture(r.instrument)) {
      out.futures.push(r);
      out.used++;
      continue;
    }

    if (isOption(r.instrument)) {
      const side = r.optionType.trim().toUpperCase();
      // A strike of 0 on an option row is the FUTURES sentinel leaking in via a
      // mis-mapped row. Left in, it becomes a candidate settlement price of 0
      // and drags max pain to the bottom of the chain, because a payout summed
      // at P=0 is always the smallest one available.
      if (!finite(r.strike) || r.strike <= 0) {
        out.rejected++;
        continue;
      }
      // CE/PE are European; CA/PA are AMERICAN — the style NSE used for STOCK
      // options from their 2001 launch until the January-2011 conversion to
      // European. Exercise style does not change what a call or a put IS:
      // open interest on a call is open interest on a call either way, and
      // both PCR and max pain only care about the side.
      //
      // Accepting CE/PE alone silently rejected EVERY pre-2011 stock option
      // row — 14,204 of them on 2009-07-31 alone (OPTSTK/CA 7,102 +
      // OPTSTK/PA 7,102) — which left pcrOi, pcrVol and maxPain null across a
      // DECADE of history with no error anywhere. Index options were European
      // from the start (OPTIDX/CE + OPTIDX/PE in the same file), which is why
      // the gap read as "stock underlyings just have no option data" instead
      // of as a bug.
      if (side === "CE" || side === "CA") {
        out.calls.push(r);
        out.used++;
        continue;
      }
      if (side === "PE" || side === "PA") {
        out.puts.push(r);
        out.used++;
        continue;
      }
    }

    out.rejected++;
  }

  return out;
}

/** Chronologically first expiry among rows, as an ISO day key. */
function nearestExpiryKey(
  rows: readonly DerivativeContractRow[],
): string | null {
  let best: string | null = null;
  for (const r of rows) {
    const k = dayKey(r.expiry);
    if (k === null) continue;
    if (best === null || k < best) best = k;
  }
  return best;
}

function atExpiry(
  rows: readonly DerivativeContractRow[],
  key: string,
): DerivativeContractRow[] {
  return rows.filter((r) => dayKey(r.expiry) === key);
}

function sumOi(rows: readonly DerivativeContractRow[]): number {
  let total = 0;
  for (const r of rows) total += r.openInt;
  return total;
}

function sumVol(rows: readonly DerivativeContractRow[]): number {
  let total = 0;
  for (const r of rows) total += r.volume;
  return total;
}

/**
 * The representative close for a set of rows that SHOULD be a single contract.
 *
 * One (symbol, exchange, expiry) yields exactly one futures row in a
 * well-formed bhavcopy; `DerivativeEOD`'s compound unique enforces it at write
 * time. If duplicates ever appear anyway, picking the deepest open interest is
 * both the most representative choice and — with the close as tie-break —
 * independent of the order the job happened to page the rows in, so the same
 * inputs always produce the same summary.
 */
function representativeClose(
  rows: readonly DerivativeContractRow[],
): number | null {
  let best: DerivativeContractRow | null = null;
  for (const r of rows) {
    if (
      best === null ||
      r.openInt > best.openInt ||
      (r.openInt === best.openInt && r.close < best.close)
    ) {
      best = r;
    }
  }
  return best === null ? null : best.close;
}

/** Ratio guarded against the 0-denominator that would yield Infinity/NaN. */
function ratio(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  const r = numerator / denominator;
  return Number.isFinite(r) ? r : null;
}

// ─── Max pain ────────────────────────────────────────────────────────

/**
 * Max pain over ONE expiry's chain.
 *
 *   Pain(P) = Σ_call strikes K  OI_ce(K) · max(0, P − K)
 *           + Σ_put  strikes K  OI_pe(K) · max(0, K − P)
 *
 * and max pain is the P minimising it, searched over the strikes the chain
 * itself lists (verified against optioncharts.io and strike.money — see the
 * module doc). Interpretation: the settlement price at which option BUYERS
 * collectively receive the least, i.e. writers pay out the least.
 *
 * ## Two things deliberately left out
 *
 * **Lot size.** The published formula multiplies by contracts-per-lot. It is a
 * single positive constant for a given underlying, so it scales every candidate
 * payout identically and cannot move the argmin. Including it would mean
 * carrying a lot-size table (which changes over the years, per symbol) purely
 * to not change the answer.
 *
 * **A finer price grid.** Candidates are the listed strikes only. Between two
 * adjacent strikes the payout is piecewise LINEAR in P, so its minimum over any
 * interval sits at an endpoint — a denser grid cannot find a lower point, only
 * a slower one.
 *
 * Ties resolve to the LOWEST strike (strict `<` while scanning ascending). Real
 * ties are rare but exactly reproducible chains must give exactly reproducible
 * answers; "whichever the Map iterated first" is not a rule.
 */
export function computeMaxPain(
  calls: readonly DerivativeContractRow[],
  puts: readonly DerivativeContractRow[],
): number | null {
  const ceOi = new Map<number, number>();
  const peOi = new Map<number, number>();
  const strikes = new Set<number>();
  let totalOi = 0;

  for (const r of calls) {
    ceOi.set(r.strike, (ceOi.get(r.strike) ?? 0) + r.openInt);
    strikes.add(r.strike);
    totalOi += r.openInt;
  }
  for (const r of puts) {
    peOi.set(r.strike, (peOi.get(r.strike) ?? 0) + r.openInt);
    strikes.add(r.strike);
    totalOi += r.openInt;
  }

  // No chain, or a chain nobody holds. With zero open interest every candidate
  // scores 0 and the "minimum" is just the first strike examined — a number
  // that looks like a market level and is not one. null says so.
  if (strikes.size === 0 || totalOi <= 0) return null;

  const ascending = [...strikes].sort((a, b) => a - b);
  let bestStrike: number | null = null;
  let bestPain = Number.POSITIVE_INFINITY;

  for (const p of ascending) {
    let pain = 0;
    for (const [k, oi] of ceOi) if (p > k) pain += (p - k) * oi;
    for (const [k, oi] of peOi) if (k > p) pain += (k - p) * oi;
    if (pain < bestPain) {
      bestPain = pain;
      bestStrike = p;
    }
  }

  return bestStrike;
}

// ─── OI buildup ──────────────────────────────────────────────────────

/**
 * The ΔOI × Δprice quadrant, or null when the day says nothing.
 *
 * Exported so the quadrant rule is testable on its own — it is four lines of
 * sign logic that every desk states slightly differently, and getting LONG and
 * SHORT_COVER the wrong way round is invisible in an aggregate.
 */
export function classifyOiBuildup(
  priceChange: number,
  oiChange: number,
): OiBuildup | null {
  if (!finite(priceChange) || !finite(oiChange)) return null;
  // Exactly flat on either axis is not a quadrant. Rounding it into one would
  // manufacture a directional call from a day where nothing directional
  // happened, and the caller cannot tell the invented ones apart afterwards.
  if (priceChange === 0 || oiChange === 0) return null;

  if (oiChange > 0) return priceChange > 0 ? "LONG" : "SHORT";
  return priceChange > 0 ? "SHORT_COVER" : "LONG_UNWIND";
}

// ─── The summary ─────────────────────────────────────────────────────

/**
 * Derive one underlying's `DerivativeSummary` for one trading day.
 *
 * Pure: same inputs ⇒ same output, no ambient state. Rows may arrive in any
 * order. Every returned field's null semantics are documented on
 * `DerivativeSummaryCalc` — read them there, they are the specification.
 */
export function computeDerivativeSummary(
  input: DerivativeSummaryInput,
): DerivativeSummaryCalc {
  const { symbol, date, today, prevDay, underlyingClose } = input;
  const exchange = input.exchange ?? null;
  const todayKey = dayKey(date);

  const cur = collectChain(today, symbol, exchange, todayKey, null);
  const prev = collectChain(prevDay, symbol, exchange, null, todayKey);

  // ── Futures: total OI is the basis (see `futOi`'s doc for why not near-only)
  const hasFutures = cur.futures.length > 0;
  const futOi = hasFutures ? sumOi(cur.futures) : null;

  const prevHasFutures = prev.futures.length > 0;
  const prevFutOi = prevHasFutures ? sumOi(prev.futures) : null;
  const futOiChange =
    futOi === null || prevFutOi === null ? null : futOi - prevFutOi;

  // ── Near futures contract: basis, rollover split, buildup all hang off it
  const nearFutKey = nearestExpiryKey(cur.futures);
  const nearFutRows =
    nearFutKey === null ? [] : atExpiry(cur.futures, nearFutKey);
  const nearFutExpiry = nearFutRows[0]?.expiry ?? null;
  const nearFutOi = nearFutKey === null ? null : sumOi(nearFutRows);
  const nearFutClose = representativeClose(nearFutRows);

  // Basis needs a positive underlying close: 0 is a division by zero and a
  // negative cash price is not a price, so both mean "cannot compute", not 0%.
  const basisBase =
    finite(underlyingClose) && underlyingClose > 0 ? underlyingClose : null;
  const futBasisPct =
    basisBase === null || nearFutClose === null
      ? null
      : ((nearFutClose - basisBase) / basisBase) * 100;

  // ── Rollover split
  const rolledRatio =
    futOi === null || nearFutOi === null
      ? null
      : ratio(futOi - nearFutOi, futOi);
  const rolloverPct = rolledRatio === null ? null : rolledRatio * 100;
  const nearExpiryOiPct = rolloverPct === null ? null : 100 - rolloverPct;

  // ── Options: PCR across every live expiry
  const callOi = cur.calls.length > 0 ? sumOi(cur.calls) : null;
  const putOi = cur.puts.length > 0 ? sumOi(cur.puts) : null;
  const callVol = cur.calls.length > 0 ? sumVol(cur.calls) : null;
  const putVol = cur.puts.length > 0 ? sumVol(cur.puts) : null;

  // A missing PUT side is a real 0 numerator (no puts open against calls that
  // are), but a missing CALL side makes the ratio undefined — hence `?? 0` on
  // the numerator and a null-propagating denominator.
  const pcrOi = callOi === null ? null : ratio(putOi ?? 0, callOi);
  const pcrVol = callVol === null ? null : ratio(putVol ?? 0, callVol);

  // ── Max pain: the nearest OPTION expiry, which is NOT the nearest futures
  // expiry for index names — NIFTY/BANKNIFTY options expire weekly while their
  // futures expire monthly, so pinning max pain to the futures expiry would
  // compute it over a chain that is up to four weeks from settling and nowhere
  // near where the writers actually are.
  const optionRows = [...cur.calls, ...cur.puts];
  const maxPainKey = nearestExpiryKey(optionRows);
  const maxPainRows =
    maxPainKey === null ? [] : atExpiry(optionRows, maxPainKey);
  const maxPainExpiry = maxPainRows[0]?.expiry ?? null;
  const maxPain =
    maxPainKey === null
      ? null
      : computeMaxPain(
          atExpiry(cur.calls, maxPainKey),
          atExpiry(cur.puts, maxPainKey),
        );

  // ── OI buildup on the SAME near contract, day over day.
  //
  // Matched by expiry, not by "whatever was near yesterday": on the session
  // after expiry today's near contract was yesterday's NEXT month, and
  // comparing near-slot to near-slot would difference two different contracts —
  // producing a violent fake buildup signal every single month.
  let oiBuildup: OiBuildup | null = null;
  if (nearFutKey !== null && prev.futures.length > 0) {
    const prevSame = atExpiry(prev.futures, nearFutKey);
    if (prevSame.length > 0) {
      const prevClose = representativeClose(prevSame);
      if (prevClose !== null && nearFutClose !== null) {
        oiBuildup = classifyOiBuildup(
          nearFutClose - prevClose,
          sumOi(nearFutRows) - sumOi(prevSame),
        );
      }
    }
  }

  return {
    symbol,
    exchange,
    date,

    futOi,
    futOiChange,
    futBasisPct,
    pcrOi,
    pcrVol,
    maxPain,
    rolloverPct,
    nearExpiryOiPct,
    oiBuildup,

    nearFutExpiry,
    nearFutOi,
    nearFutClose,
    maxPainExpiry,
    callOi,
    putOi,
    callVol,
    putVol,

    rowsUsed: cur.used,
    rowsRejected: cur.rejected,
    prevRowsUsed: prev.used,
    prevRowsRejected: prev.rejected,
  };
}
