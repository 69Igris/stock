/**
 * A mutual fund's NAV series as UDF bars. MONEY-1478.
 *
 * PURE. Shared so `apps/web` and `apps/market-data` synthesise a fund's series
 * identically — a chart that differs by which origin served it is the defect
 * the A3 parity harness exists to prevent, and funds were the one asset class
 * the market-data service had no path for at all.
 */

import type { TileBar } from "../tiles/tile-logic";

/** One AMFI NAV observation. `date` is `YYYY-MM-DD`. */
export interface NavObservation {
  date: string;
  nav: number;
}

/**
 * A NAV is ONE number per day, so the bar is FLAT: open = high = low = close.
 *
 * `volume: 0` means "this series HAS no volume", never "nothing traded" — the
 * same rule `TIINGO_RT` bars follow. A fund's symbol info sets `has_no_volume`
 * so the widget hides the pane rather than drawing a flat zero line.
 *
 * SORTED ASCENDING, because the reader may return newest-first and TradingView
 * requires ascending time: an out-of-order series renders as a chart that
 * folds back on itself, with no error.
 *
 * A non-finite or non-positive NAV is DROPPED rather than charted. AMFI
 * publishes the literal body `None` for a day with no NAV, and a 0 or NaN
 * plotted as a price is a cliff to zero that looks like a real crash.
 */
export function navPointsToBars(points: readonly NavObservation[]): TileBar[] {
  const out: TileBar[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.nav) || p.nav <= 0) continue;
    const t = Math.floor(new Date(`${p.date}T00:00:00.000Z`).getTime() / 1000);
    if (!Number.isFinite(t)) continue;
    out.push([t, p.nav, p.nav, p.nav, p.nav, 0]);
  }
  // ASCENDING. The reader may return newest-first and TradingView requires
  // ascending time: an out-of-order series renders as a chart folding back on
  // itself, with no error.
  return out.sort((a, b) => a[0] - b[0]);
}
