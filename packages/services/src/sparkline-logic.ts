/**
 * Sparkline pure-logic helpers (service layer).
 *
 * Side-effect-free normalization / min-max / scale-to-viewBox math for the
 * tiny SVG trend charts rendered in list views (watchlist, markets overview,
 * screener). `./sparkline.service.ts` returns a close-price array per symbol;
 * the renderer then maps those closes to `(x, y)` coordinates inside a fixed
 * `width × height` viewBox. That mapping is a DIVISION surface
 * (`(v - min) / (max - min)`) and a `Math.min(...closes)` / `Math.max(...closes)`
 * surface — both of which a single non-finite bar poisons.
 *
 * These helpers are isolated here (Prisma-free) so they can be unit-tested
 * without opening a DB/Redis handle at import time, and — critically — so the
 * LIVE sparkline path runs the SAME non-finite-guarded math the regression
 * tests assert (no shadow). `./sparkline.service.ts` now CALLS `sanitizeCloses`
 * so every series it hands out is already free of non-finite poison; the
 * renderer can additionally call `scaleSparklineToViewBox` to get guarded
 * coordinates.
 *
 * Behaviour here is identical, for FINITE inputs, to the inline scaling that
 * lives in `apps/web/components/charts/Sparkline.tsx`
 * (`max = Math.max(...data); min = Math.min(...data); range = max - min || 1;
 *   y = height - ((v - min) / range) * height`). The only intentional
 * behavioural differences are defensive:
 *
 *   - a single `NaN` bar no longer makes `Math.max(...data)` / `Math.min(...data)`
 *     `NaN` (which then makes EVERY y-coordinate `NaN` — the whole sparkline
 *     vanishes from one corrupt bar);
 *   - an `±Infinity` bar no longer makes `range` `Infinity` (collapsing the
 *     line to the baseline) — non-finite bars are dropped before scaling;
 *   - a flat series (`min === max`) renders as a centred horizontal line
 *     instead of pinned to the bottom (the legacy `range = 0 || 1 = 1` mapped
 *     every point to `y = height`, i.e. the very bottom);
 *   - empty / single-point / all-non-finite series return `[]` coordinates so
 *     the caller draws its muted placeholder instead of throwing.
 *
 * Mirrors the `finite()` precedent in `./dashboard-logic.ts`.
 */

// ---------------------------------------------------------------------------
// Non-finite guard
// ---------------------------------------------------------------------------

/**
 * Coerce a possibly-non-finite numeric to a safe finite number.
 *
 * `null`/`undefined`/`NaN`/`±Infinity` all collapse to `fallback` (default 0).
 * Mirrors `./dashboard-logic.ts#finite`.
 */
export function finite(value: number | null | undefined, fallback = 0): number {
  return value != null && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Sanitize a raw close-price series
// ---------------------------------------------------------------------------

/**
 * Drop every non-finite point from a close-price series, preserving order.
 *
 * The upstream `fetchSparkline` already filters `Number.isFinite(c)` on the
 * Yahoo bars, but cached/worker-precomputed series and any future direct
 * callers can still carry a `NaN`/`Infinity`/`null` (a corrupt cache write, a
 * hand-built fixture). Running closes through this before scaling guarantees
 * `Math.min(...)`/`Math.max(...)` can never see a `NaN` (which poisons BOTH and
 * blanks the whole chart). A non-array input yields `[]`.
 */
export function sanitizeCloses(
  closes: ReadonlyArray<number | null | undefined> | null | undefined,
): number[] {
  if (!Array.isArray(closes)) return [];
  return closes.filter((c): c is number => c != null && Number.isFinite(c));
}

// ---------------------------------------------------------------------------
// Min/max extent (NaN-safe)
// ---------------------------------------------------------------------------

/** The `{ min, max }` extent of a series, or `null` when it has no finite point. */
export interface SparklineExtent {
  min: number;
  max: number;
}

/**
 * Compute the `{ min, max }` extent over the FINITE points of a series.
 *
 * Unlike the inline `Math.min(...data)` / `Math.max(...data)` (where one `NaN`
 * makes both `NaN`, and an empty spread yields `Infinity`/`-Infinity`), this
 * ignores non-finite points and returns `null` when there is no finite point
 * at all (empty or all-garbage series) so the caller can short-circuit to a
 * placeholder rather than dividing by a non-finite range.
 */
export function sparklineExtent(
  closes: ReadonlyArray<number | null | undefined>,
): SparklineExtent | null {
  let min = Infinity;
  let max = -Infinity;
  let seen = false;
  for (const c of closes) {
    if (c == null || !Number.isFinite(c)) continue;
    seen = true;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  return seen ? { min, max } : null;
}

// ---------------------------------------------------------------------------
// Scale to viewBox coordinates
// ---------------------------------------------------------------------------

/** One scaled point inside the sparkline viewBox. */
export interface SparklinePoint {
  x: number;
  y: number;
}

export interface ScaleSparklineOptions {
  /** ViewBox width in px. Default 80 (matches `Sparkline.tsx`). */
  width?: number;
  /** ViewBox height in px. Default 24 (matches `Sparkline.tsx`). */
  height?: number;
}

/**
 * Map a close-price series to `(x, y)` coordinates inside a `width × height`
 * SVG viewBox, top-left origin, y INVERTED (SVG y grows downward, so the
 * highest close sits near `y = 0` and the lowest near `y = height`).
 *
 * Ports `Sparkline.tsx` exactly for finite inputs:
 *   `stepX = width / (n - 1)`, `x = i * stepX`,
 *   `y = height - ((v - min) / range) * height` where `range = max - min`.
 *
 * Hardening (the bug fixes — see file header):
 *   - non-finite points are dropped first (`sanitizeCloses`), so a single
 *     `NaN`/`Infinity` bar cannot blank the entire line;
 *   - `< 2` finite points → `[]` (a line needs two points; caller draws the
 *     dashed placeholder, exactly as the component's `data.length < 2` branch);
 *   - a FLAT finite series (`range === 0`) is centred at `y = height / 2`
 *     instead of pinned to the bottom — a flat line should read as flat, not
 *     bottomed-out;
 *   - every returned `x`/`y` is finite by construction (guarded width/height,
 *     finite range), so no `NaN`/`Infinity` ever reaches an SVG `points`
 *     attribute.
 *
 * Width/height are themselves `finite()`-guarded (a caller passing `NaN` width
 * can't smear `NaN` across every x).
 */
export function scaleSparklineToViewBox(
  closes: ReadonlyArray<number | null | undefined>,
  options: ScaleSparklineOptions = {},
): SparklinePoint[] {
  const width = finite(options.width, 80);
  const height = finite(options.height, 24);
  const data = sanitizeCloses(closes);
  if (data.length < 2) return [];

  const extent = sparklineExtent(data);
  // data has ≥ 2 finite points, so extent is non-null here, but guard anyway.
  if (!extent) return [];
  const { min, max } = extent;
  const range = max - min;

  const stepX = width / (data.length - 1);
  return data.map((v, i) => {
    const x = i * stepX;
    // Flat series: no spread to normalise against → centre the line.
    const y = range === 0 ? height / 2 : height - ((v - min) / range) * height;
    return { x: finite(x), y: finite(y) };
  });
}

/**
 * Render scaled points as an SVG `points` string (`"x,y x,y …"`), the exact
 * shape `<polyline points=…>` consumes. Returns `""` for an unrenderable
 * (`< 2`-point / empty / all-non-finite) series so the caller falls back to the
 * placeholder line. `dp` controls coordinate precision (default 2 — enough for
 * an 80×24 viewBox, keeps the string compact).
 */
export function sparklinePointsAttr(
  closes: ReadonlyArray<number | null | undefined>,
  options: ScaleSparklineOptions = {},
  dp = 2,
): string {
  const pts = scaleSparklineToViewBox(closes, options);
  if (pts.length < 2) return "";
  return pts.map((p) => `${p.x.toFixed(dp)},${p.y.toFixed(dp)}`).join(" ");
}
