/**
 * XIRR - Internal Rate of Return for irregular cashflows.
 *
 * Given a list of (date, amount) pairs (negative = outflow, positive =
 * inflow), solves for the annualised rate r such that:
 *
 *   Σ amount_i / (1 + r)^((date_i − date_0) / 365) = 0
 *
 * Uses Newton-Raphson with bisection fallback. ~30 LOC of math; the
 * standard implementation in Excel / Google Sheets.
 *
 * Convention: outflows (investments) are NEGATIVE, inflows (returns,
 * NAV-redemption) are POSITIVE. Mixing signs is REQUIRED - all-positive
 * or all-negative arrays return NaN since no rate satisfies the equation.
 */

export interface CashFlow {
  date: Date;
  amount: number;
}

const MAX_ITER = 100;
const TOL = 1e-7;
const MIN_RATE = -0.999;
const MAX_RATE = 100;

/** Compute XIRR. Returns NaN if no convergence or all-same-sign flows. */
export function calcXirr(flows: readonly CashFlow[], guess = 0.1): number {
  if (flows.length < 2) return NaN;
  const hasPos = flows.some((f) => f.amount > 0);
  const hasNeg = flows.some((f) => f.amount < 0);
  if (!hasPos || !hasNeg) return NaN;

  const t0 = flows[0]!.date.getTime();
  const days = flows.map(
    (f) => (f.date.getTime() - t0) / (1000 * 60 * 60 * 24),
  );
  const amts = flows.map((f) => f.amount);

  const npv = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < amts.length; i++) {
      total += amts[i]! / Math.pow(1 + rate, days[i]! / 365);
    }
    return total;
  };
  const dnpv = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < amts.length; i++) {
      const t = days[i]! / 365;
      total += -t * (amts[i]! / Math.pow(1 + rate, t + 1));
    }
    return total;
  };

  let rate = guess;
  for (let i = 0; i < MAX_ITER; i++) {
    const f = npv(rate);
    if (Math.abs(f) < TOL) return rate;
    const fp = dnpv(rate);
    if (fp === 0) break;
    const next = rate - f / fp;
    if (next < MIN_RATE || next > MAX_RATE || !Number.isFinite(next)) break;
    if (Math.abs(next - rate) < TOL) return next;
    rate = next;
  }

  // Newton failed - fall back to bisection on a wide range. Slow but
  // robust when the gradient near the guess is near-zero.
  let lo = MIN_RATE;
  let hi = MAX_RATE;
  let loF = npv(lo);
  let hiF = npv(hi);
  if (loF * hiF > 0) return NaN; // no root in range

  for (let i = 0; i < MAX_ITER; i++) {
    const mid = (lo + hi) / 2;
    const midF = npv(mid);
    if (Math.abs(midF) < TOL) return mid;
    if (midF * loF < 0) {
      hi = mid;
      hiF = midF;
    } else {
      lo = mid;
      loF = midF;
    }
  }

  return NaN;
}
